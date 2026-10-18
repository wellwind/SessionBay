use super::LaunchPreflightError;
use super::{
    lock, transport, Request, Response, RuntimeInfo, RuntimeRecord, UiEmitter, UiEvent,
    ACTIVITY_CAPABILITY, HOME_DIRECTORY_CAPABILITY, PROTOCOL, TERMINAL_STATUS_CAPABILITY,
};
use crate::{runtime::LaunchSpec, service::LaunchRequest};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

struct Subscription {
    lease: String,
    cancelled: AtomicBool,
    flow: Mutex<(Option<u64>, Option<u64>)>, // (sent, acknowledged), including snapshot sequence zero
    changed: Condvar,
}
impl Subscription {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.changed.notify_all();
    }
}
struct Inner {
    directory: PathBuf,
    generation: String,
    home_directory_supported: bool,
    activity_supported: bool,
    terminal_status_supported: bool,
    provider_hooks_supported: bool,
    subscriptions: Mutex<HashMap<String, Arc<Subscription>>>,
}
/// Dropping this handle disconnects UI rendering only. It never stops the broker.
#[derive(Clone)]
pub struct BrokerClient {
    inner: Arc<Inner>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for subscription in lock(&self.subscriptions).values() {
            subscription.cancel();
        }
    }
}
pub(super) fn exchange(directory: &Path, request: &Request) -> Result<Response, String> {
    let bytes = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    thread_local! {
        static IPC: Result<tokio::runtime::Runtime, String> = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string());
    }
    let bytes = IPC.with(|runtime| {
        runtime
            .as_ref()
            .map_err(Clone::clone)?
            .block_on(transport::request(directory, &bytes))
            .map_err(|e| e.to_string())
    })?;
    let response = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Invalid runtime broker response: {e}"))?;
    match response {
        Response::Error { message } => Err(message),
        response => Ok(response),
    }
}
impl BrokerClient {
    /// Explicit cleanup for a known, isolated application-data directory. This
    /// never creates a broker and never signals an unverified process ID.
    pub fn stop_existing(parent: &Path) -> Result<(), String> {
        let directory = transport::private_directory(parent).map_err(|e| e.to_string())?;
        if transport::ownership_available(&directory)
            .map_err(|error| format!("Cannot verify runtime broker ownership lock: {error}"))?
        {
            return Ok(());
        }
        Self::existing(&directory)?.shutdown_broker()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if transport::ownership_available(&directory)
                .map_err(|error| format!("Cannot verify runtime broker ownership lock: {error}"))?
            {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(25));
        }
        Err("Runtime broker has not released its ownership lock after explicit stop".into())
    }
    pub fn connect(parent: &Path, executable: &Path) -> Result<Self, String> {
        let directory = transport::private_directory(parent).map_err(|e| e.to_string())?;
        if let Ok(client) = Self::existing(&directory) {
            return Ok(client);
        }
        // A held lock is evidence of a possibly unhealthy live broker. Never
        // displace it, kill a PID, or silently launch a second runtime owner.
        let available = transport::ownership_available(&directory)
            .map_err(|error| format!("Cannot verify runtime broker ownership lock: {error}"))?;
        let child_exit = Arc::new(Mutex::new(None));
        if available {
            let mut command = Command::new(executable);
            command
                .arg("--sessionbay-runtime-broker")
                .arg(parent)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                // SAFETY: only async-signal-safe setsid is called between fork/exec.
                unsafe {
                    command.pre_exec(|| {
                        if libc::setsid() == -1 {
                            Err(std::io::Error::last_os_error())
                        } else {
                            Ok(())
                        }
                    });
                }
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                use windows_sys::Win32::System::Threading::{
                    CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
                };
                command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
            }
            let mut child = command
                .spawn()
                .map_err(|e| format!("Cannot start detached runtime broker: {e}"))?;
            // Reap if it exits while this UI remains open. Do not wait on or
            // retain ownership that kills the detached child when the UI closes.
            let child_exit = Arc::clone(&child_exit);
            thread::spawn(move || {
                // Store only bounded exit status, never inherited environment,
                // terminal content, metadata, or potentially sensitive stderr.
                *lock(&child_exit) = Some(child.wait().map(|status| status.code()));
            });
        }
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut last_error = String::new();
        while Instant::now() < deadline {
            match Self::existing(&directory) {
                Ok(client) => return Ok(client),
                Err(error) => last_error = error,
            }
            thread::sleep(Duration::from_millis(50));
        }
        let startup = match lock(&child_exit).as_ref() {
            Some(Ok(Some(code))) => format!(" Spawned broker exited with code {code}."),
            Some(Ok(None)) => " Spawned broker exited without an exit code.".into(),
            Some(Err(_)) => " Could not observe the spawned broker's exit status.".into(),
            None => String::new(),
        };
        Err(format!("Cannot connect to the runtime broker. Existing sessions were not restarted: {last_error}.{startup}"))
    }
    fn existing(directory: &Path) -> Result<Self, String> {
        Self::from_hello(
            directory,
            exchange(directory, &Request::Hello { protocol: PROTOCOL })?,
        )
    }
    fn from_hello(directory: &Path, response: Response) -> Result<Self, String> {
        match response {
            Response::Hello {
                protocol: PROTOCOL,
                generation,
                capabilities,
            } => Ok(Self {
                inner: Arc::new(Inner {
                    directory: directory.into(),
                    generation,
                    home_directory_supported: capabilities
                        .iter()
                        .any(|value| value == HOME_DIRECTORY_CAPABILITY),
                    activity_supported: capabilities
                        .iter()
                        .any(|value| value == ACTIVITY_CAPABILITY),
                    terminal_status_supported: capabilities
                        .iter()
                        .any(|value| value == TERMINAL_STATUS_CAPABILITY),
                    provider_hooks_supported: capabilities
                        .iter()
                        .any(|value| value == crate::provider_hooks::CAPABILITY),
                    subscriptions: Mutex::new(HashMap::new()),
                }),
            }),
            _ => Err("Incompatible runtime broker response".into()),
        }
    }
    #[cfg(test)]
    pub(crate) fn existing_for_test(parent: &Path) -> Result<Self, String> {
        let directory = transport::private_directory(parent).map_err(|error| error.to_string())?;
        Self::existing(&directory)
    }
    pub(crate) fn generation(&self) -> String {
        self.inner.generation.clone()
    }
    fn request(&self, request: Request) -> Result<Response, String> {
        exchange(&self.inner.directory, &request)
    }
    pub fn revoke_provider_hooks(&self, provider: crate::models::AgentKind) -> Result<(), String> {
        if !self.inner.provider_hooks_supported {
            return Ok(());
        }
        match self.request(Request::RevokeProviderHooks {
            generation: self.generation(),
            provider,
        })? {
            Response::Ok => Ok(()),
            _ => Err("Invalid hook revoke response".into()),
        }
    }
    pub(crate) fn check_provider_hooks(
        &self,
        spec: &LaunchSpec,
    ) -> Result<(), LaunchPreflightError> {
        if spec.env.contains_key(crate::provider_hooks::OPT_IN)
            && !self.inner.provider_hooks_supported
        {
            return Err(LaunchPreflightError::MissingProviderHooks);
        }
        Ok(())
    }
    /// The caller must already guarantee causal ordering upstream. This does
    /// not install, configure or enable real provider hooks.
    pub fn open_ordered_activity_publisher(
        &self,
        runtime_id: &str,
        provider: crate::models::AgentKind,
        provider_session_id: &str,
    ) -> Result<OrderedActivityPublisher, String> {
        if !self.inner.activity_supported {
            return Err("The runtime broker does not support ordered activity publishers".into());
        }
        OrderedActivityPublisher::open(self, runtime_id, provider, provider_session_id)
    }
    pub fn list(&self) -> Result<Vec<RuntimeRecord>, String> {
        match self.request(Request::List {
            generation: self.generation(),
        })? {
            Response::Records { mut records } => {
                if !self.inner.home_directory_supported {
                    for record in &mut records {
                        // Pre-capability hosts cannot know the policy omitted by this client.
                        // Keep a positive flag from intermediate hosts, but expose false as unknown.
                        if record.home_directory != Some(true) {
                            record.home_directory = None;
                        }
                    }
                }
                Ok(records)
            }
            _ => Err("Invalid runtime list response".into()),
        }
    }
    pub fn find_running_resume(&self, key: &str) -> Result<Option<RuntimeInfo>, String> {
        match self.request(Request::FindResume {
            generation: self.generation(),
            key: key.into(),
        })? {
            Response::Runtime { info } => Ok(info),
            _ => Err("Invalid runtime identity response".into()),
        }
    }
    /// Launch without a UI subscription; a fresh pane attaches after adopting its broker identity.
    pub(crate) fn launch_unattached(
        &self,
        spec: LaunchSpec,
        request: &LaunchRequest,
    ) -> Result<RuntimeInfo, String> {
        self.check_provider_hooks(&spec)
            .map_err(|error| error.to_string())?;
        match self.request(self.launch_request(spec, request))? {
            Response::Runtime { info: Some(info) } => Ok(info),
            _ => Err("Invalid runtime launch response".into()),
        }
    }
    pub fn launch(
        &self,
        spec: LaunchSpec,
        request: &LaunchRequest,
        lease: String,
        emit: UiEmitter,
    ) -> Result<RuntimeInfo, String> {
        self.check_provider_hooks(&spec)
            .map_err(|error| error.to_string())?;
        let requested_pane = spec.pane_id.clone();
        let response = self.request(self.launch_request(spec, request))?;
        let info = match response {
            Response::Runtime { info: Some(info) } => info,
            _ => return Err("Invalid runtime launch response".into()),
        };
        if info.pane_id == requested_pane {
            self.attach_info(&info, lease, emit)?;
        }
        Ok(info)
    }
    fn launch_request(&self, spec: LaunchSpec, request: &LaunchRequest) -> Request {
        Request::Launch {
            generation: self.generation(),
            spec: Box::new(spec),
            kind: request.kind.clone(),
            project_id: request.project_id.clone(),
            profile_id: request.profile_id.clone(),
            resume_id: request.resume_id.clone(),
            // The desktop service already resolved/validated cwd. Older v1 hosts
            // reject unknown fields, so omit only this metadata extension.
            home_directory: request.uses_home_directory() && self.inner.home_directory_supported,
            cols: request.cols,
            rows: request.rows,
        }
    }
    pub fn attach(&self, id: &str, lease: String, emit: UiEmitter) -> Result<RuntimeInfo, String> {
        let info = self
            .list()?
            .into_iter()
            .find(|record| record.info.id == id)
            .ok_or("Terminal not found")?
            .info;
        self.attach_info(&info, lease, emit)?;
        Ok(info)
    }
    fn attach_info(
        &self,
        info: &RuntimeInfo,
        lease: String,
        emit: UiEmitter,
    ) -> Result<(), String> {
        if uuid::Uuid::parse_str(&lease).is_err() {
            return Err("Invalid terminal attachment ID".into());
        }
        let subscription = Arc::new(Subscription {
            lease,
            cancelled: AtomicBool::new(false),
            flow: Mutex::new((None, None)),
            changed: Condvar::new(),
        });
        let mut subscriptions = lock(&self.inner.subscriptions);
        // Prune ended readers before enforcing a fixed upper bound.
        subscriptions.retain(|_, subscription| !subscription.cancelled.load(Ordering::Acquire));
        if subscriptions.len() >= 128 && !subscriptions.contains_key(&info.id) {
            return Err("Too many terminal render attachments".into());
        }
        if let Some(previous) = subscriptions.insert(info.id.clone(), Arc::clone(&subscription)) {
            previous.cancel();
        }
        drop(subscriptions);
        let directory = self.inner.directory.clone();
        let generation = self.generation();
        let activity_supported = self.inner.activity_supported;
        let terminal_status_supported = self.inner.terminal_status_supported;
        let id = info.id.clone();
        thread::Builder::new()
            .name(format!("attach-{}", id.chars().take(8).collect::<String>()))
            .spawn(move || {
                let result = (|| {
                    let mut after = None;
                    let mut activity_after = None;
                    while !subscription.cancelled.load(Ordering::Acquire) {
                        let response = exchange(&directory, &Request::Poll {
                            generation: generation.clone(), runtime_id: id.clone(), after,
                            agent_activity: activity_supported, terminal_status: terminal_status_supported, activity_after: activity_after.clone(),
                        })?;
                        let events = match response {
                            Response::Events { events } => events,
                            _ => return Err("Invalid terminal replay response".to_string()),
                        };
                        if events.is_empty() {
                            thread::sleep(Duration::from_millis(40));
                            continue;
                        }
                        // One acknowledged write for adjacent output already in this response.
                        // Keep the existing per-event lease/cancellation and ACK wait below.
                        for event in super::output_batch::batch_output(events) {
                            if subscription.cancelled.load(Ordering::Acquire) { return Ok(()); }
                            if let Some(sequence) = event.sequence() {
                                lock(&subscription.flow).0 = Some(sequence);
                                emit(event)?;
                                let deadline = Instant::now() + Duration::from_secs(30);
                                let mut flow = lock(&subscription.flow);
                                while flow.1 != Some(sequence) && !subscription.cancelled.load(Ordering::Acquire) {
                                    let remaining = deadline.saturating_duration_since(Instant::now());
                                    if remaining.is_zero() {
                                        return Err("Terminal rendering stopped responding. The process continues in the background; reconnect this pane.".into());
                                    }
                                    flow = subscription.changed.wait_timeout(flow, remaining).unwrap_or_else(|error| error.into_inner()).0;
                                }
                                after = Some(sequence);
                            } else {
                                if let UiEvent::AgentActivity { generation, revision, .. } | UiEvent::TerminalStatus { generation, revision, .. } = &event {
                                    activity_after = Some(super::activity::Cursor { generation: generation.clone(), revision: *revision });
                                }
                                let done = matches!(event, UiEvent::Exit { .. } | UiEvent::Disconnected { .. });
                                emit(event)?;
                                if done { return Ok(()); }
                            }
                        }
                    }
                    Ok(())
                })();
                if let Err(message) = result {
                    if !subscription.cancelled.load(Ordering::Acquire) {
                        let _ = emit(UiEvent::Disconnected { runtime_id: id, message });
                    }
                }
                subscription.cancel();
            })
            .map_err(|error| format!("Cannot attach terminal renderer: {error}"))?;
        Ok(())
    }
    pub fn ack(&self, id: &str, sequence: u64, lease: &str) -> Result<(), String> {
        let subscriptions = lock(&self.inner.subscriptions);
        if let Some(subscription) = subscriptions
            .get(id)
            .filter(|subscription| subscription.lease == lease)
        {
            let mut flow = lock(&subscription.flow);
            if flow.0.is_none_or(|sent| sequence > sent) {
                return Err("Cannot acknowledge terminal output that was not sent".into());
            }
            if flow.1.is_none_or(|ack| sequence >= ack) {
                flow.1 = Some(sequence);
                subscription.changed.notify_all();
            }
        }
        Ok(())
    }
    pub fn detach(&self, id: &str, lease: &str) {
        let mut subscriptions = lock(&self.inner.subscriptions);
        if subscriptions
            .get(id)
            .is_some_and(|subscription| subscription.lease == lease)
        {
            if let Some(subscription) = subscriptions.remove(id) {
                subscription.cancel();
            }
        }
    }
    pub fn detach_all(&self) {
        for (_, subscription) in lock(&self.inner.subscriptions).drain() {
            subscription.cancel();
        }
    }
    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        self.ok(Request::Write {
            generation: self.generation(),
            runtime_id: id.into(),
            data: data.into(),
        })
    }
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.ok(Request::Resize {
            generation: self.generation(),
            runtime_id: id.into(),
            cols,
            rows,
        })
    }
    pub fn stop(&self, id: &str) -> Result<(), String> {
        self.ok(Request::Stop {
            generation: self.generation(),
            runtime_id: id.into(),
        })
    }
    pub fn forget(&self, id: &str) -> Result<(), String> {
        self.ok(Request::Forget {
            generation: self.generation(),
            runtime_id: id.into(),
        })
    }
    /// Explicit user process-management action. Never called from UI shutdown.
    pub fn shutdown_broker(&self) -> Result<(), String> {
        self.ok(Request::Shutdown {
            generation: self.generation(),
        })
    }
    fn ok(&self, request: Request) -> Result<(), String> {
        match self.request(request)? {
            Response::Ok => Ok(()),
            _ => Err("Invalid runtime acknowledgement".into()),
        }
    }
}

#[cfg(test)]
#[path = "legacy_v1_tests.rs"]
mod legacy_v1_tests;

/// Non-clone, in-memory lease for an explicitly ordered upstream bridge. `&mut`
/// serializes calls; it does not establish causality for concurrent CLI hooks.
/// Credentials are never exposed by this handle or its debug formatting.
pub struct OrderedActivityPublisher {
    ipc: Option<tokio::runtime::Runtime>,
    stream: Option<transport::ActivityStream>,
    broker_generation: String,
    runtime_id: String,
    activity_generation: String,
    capability: super::activity::Capability,
    sequence: u64,
}
impl OrderedActivityPublisher {
    fn open(
        client: &BrokerClient,
        runtime_id: &str,
        provider: crate::models::AgentKind,
        session_id: &str,
    ) -> Result<Self, String> {
        let ipc = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        let request = Request::OpenOrderedActivity {
            generation: client.generation(),
            runtime_id: runtime_id.into(),
            provider,
            session_id: session_id.into(),
        };
        let opened = ipc.block_on(async {
            tokio::time::timeout(transport::REQUEST_TIMEOUT, async {
                let mut stream = transport::connect(&client.inner.directory)
                    .await
                    .map_err(|error| error.to_string())?;
                let response = match Self::exchange(&mut stream, &request).await {
                    Ok(response) => response,
                    Err(error) => {
                        transport::discard_activity_stream(stream);
                        return Err(error);
                    }
                };
                Ok::<_, String>((stream, response))
            })
            .await
            .map_err(|_| "Activity publisher open timed out".to_owned())?
        });
        let (stream, response) = match opened {
            Ok(opened) => opened,
            Err(error) => {
                ipc.shutdown_background();
                return Err(error);
            }
        };
        match response {
            Response::ActivityOpened {
                activity_generation,
                capability,
            } => Ok(Self {
                ipc: Some(ipc),
                stream: Some(stream),
                broker_generation: client.generation(),
                runtime_id: runtime_id.into(),
                activity_generation,
                capability,
                sequence: 0,
            }),
            _ => {
                transport::discard_activity_stream(stream);
                ipc.shutdown_background();
                Err("Invalid activity publisher response".into())
            }
        }
    }
    async fn exchange(
        stream: &mut interprocess::local_socket::tokio::Stream,
        request: &Request,
    ) -> Result<Response, String> {
        let bytes = serde_json::to_vec(request).map_err(|_| "Cannot encode activity request")?;
        transport::write_frame(stream, &bytes)
            .await
            .map_err(|error| error.to_string())?;
        let bytes = transport::read_frame(stream, 4096)
            .await
            .map_err(|error| error.to_string())?;
        match serde_json::from_slice(&bytes).map_err(|_| "Invalid activity response")? {
            Response::Error { message } => Err(message),
            response => Ok(response),
        }
    }
    fn discard(&mut self) {
        if let Some(stream) = self.stream.take() {
            transport::discard_activity_stream(stream);
        }
    }
    fn send(&mut self, request: Request) -> Result<(), String> {
        let stream = self.stream.as_mut().ok_or("Activity publisher is closed")?;
        let result = self
            .ipc
            .as_ref()
            .ok_or("Activity publisher is closed")?
            .block_on(async {
                tokio::time::timeout(transport::REQUEST_TIMEOUT, Self::exchange(stream, &request))
                    .await
                    .map_err(|_| {
                        "Activity publish timed out; reopen the ordered bridge".to_owned()
                    })?
            })
            .and_then(|response| match response {
                Response::Ok => Ok(()),
                _ => Err("Invalid activity acknowledgement".into()),
            });
        // Never retry uncertain results or leave them lingering on Windows pipes.
        if result.is_err() {
            self.discard();
        }
        result
    }
    pub fn publish(&mut self, registered_event: &str, payload: &[u8]) -> Result<(), String> {
        if payload.len() > crate::agent_activity::MAX_PAYLOAD_BYTES
            || registered_event.is_empty()
            || registered_event.len() > 512
            || registered_event.chars().any(char::is_control)
        {
            self.discard();
            return Err("Invalid activity event or payload size".into());
        }
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("Activity sequence exhausted")?;
        self.send(Request::PublishActivity {
            generation: self.broker_generation.clone(),
            runtime_id: self.runtime_id.clone(),
            activity_generation: self.activity_generation.clone(),
            capability: self.capability.clone(),
            sequence: self.sequence,
            registered_event: registered_event.into(),
            payload: payload.into(),
        })
    }
    /// Explicit close waits for invalidation; dropping closes the stream without blocking.
    pub fn close(mut self) -> Result<(), String> {
        let result = self.send(Request::CloseActivity {
            generation: self.broker_generation.clone(),
            runtime_id: self.runtime_id.clone(),
            activity_generation: self.activity_generation.clone(),
            capability: self.capability.clone(),
        });
        self.discard();
        result
    }
}
impl Drop for OrderedActivityPublisher {
    fn drop(&mut self) {
        self.discard();
        // Windows pipe connects may use blocking tasks; cancellation must never
        // make dropping an owned runtime wait indefinitely for those tasks.
        if let Some(ipc) = self.ipc.take() {
            ipc.shutdown_background();
        }
    }
}
