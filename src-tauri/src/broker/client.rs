use super::{
    lock, transport, Request, Response, RuntimeInfo, RuntimeRecord, UiEmitter, UiEvent,
    HOME_DIRECTORY_CAPABILITY, PROTOCOL,
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
fn exchange(directory: &Path, request: &Request) -> Result<Response, String> {
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
        if transport::lock(&directory).is_ok() {
            return Ok(());
        }
        Self::existing(&directory)?.shutdown_broker()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if transport::lock(&directory).is_ok() {
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
        let available = transport::lock(&directory).is_ok();
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
            thread::spawn(move || {
                let _ = child.wait();
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
        Err(format!("Cannot connect to the runtime broker. Existing sessions were not restarted: {last_error}"))
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
                    subscriptions: Mutex::new(HashMap::new()),
                }),
            }),
            _ => Err("Incompatible runtime broker response".into()),
        }
    }
    fn generation(&self) -> String {
        self.inner.generation.clone()
    }
    fn request(&self, request: Request) -> Result<Response, String> {
        exchange(&self.inner.directory, &request)
    }
    pub fn compatibility_warning(&self) -> Option<&'static str> {
        (!self.inner.home_directory_supported).then_some("背景 Terminal 服務使用相容模式：臨時 Terminal 仍會從家目錄啟動，家目錄政策由已儲存的工作區保留。現有程序不會重啟；若工作區尚未儲存或遺失，舊服務只能提供原始啟動路徑。")
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
    pub fn launch(
        &self,
        spec: LaunchSpec,
        request: &LaunchRequest,
        lease: String,
        emit: UiEmitter,
    ) -> Result<RuntimeInfo, String> {
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
        let id = info.id.clone();
        thread::Builder::new()
            .name(format!("attach-{}", id.chars().take(8).collect::<String>()))
            .spawn(move || {
                let result = (|| {
                    let mut after = None;
                    while !subscription.cancelled.load(Ordering::Acquire) {
                        let response = exchange(&directory, &Request::Poll {
                            generation: generation.clone(), runtime_id: id.clone(), after,
                        })?;
                        let events = match response {
                            Response::Events { events } => events,
                            _ => return Err("Invalid terminal replay response".to_string()),
                        };
                        if events.is_empty() {
                            thread::sleep(Duration::from_millis(40));
                            continue;
                        }
                        for event in events {
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
