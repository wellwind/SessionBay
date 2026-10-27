//! Detached runtime host. The desktop is a disposable client; only this process
//! owns PTYs. Restoring metadata never grants authority over an old process ID.
mod activity;
mod client;
mod output_batch;
mod preflight;
pub(crate) use preflight::LaunchPreflightError;
mod provider_hooks;
pub use provider_hooks::{send_provider_callback, send_provider_state};
mod retirement;
mod screen;
mod storage;
mod transport;
mod ui_lease;
mod ui_owner;
use crate::runtime::{LaunchSpec, RuntimeInfo, RuntimeManager, TerminalEvent};
pub use client::{BrokerClient, OrderedActivityPublisher};
use interprocess::local_socket::tokio::{prelude::*, Stream};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
pub(crate) use ui_owner::NativeUiLease;
use uuid::Uuid;

pub const PROTOCOL: u32 = 1;
const ACTIVITY_CAPABILITY: &str = "orderedAgentActivity";
const TERMINAL_STATUS_CAPABILITY: &str = "nativeTerminalStatusV1";
const HOME_DIRECTORY_CAPABILITY: &str = "homeDirectory";
fn is_false(value: &bool) -> bool {
    !*value
}
const MAX_RECORDS: usize = 128;
const MAX_CLIENTS: usize = 64;
const MAX_ACTIVITY_PUBLISHERS: usize = 32;
pub type UiEmitter = Arc<dyn Fn(UiEvent) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRecord {
    #[serde(flatten)]
    pub info: RuntimeInfo,
    pub kind: String,
    pub project_id: Option<String>,
    pub profile_id: Option<String>,
    pub resume_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_directory: Option<bool>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub image_input: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_input: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UiEvent {
    TerminalStatus {
        runtime_id: String,
        generation: String,
        revision: u64,
        status: Option<crate::terminal_status::Status>,
    },
    AgentActivity {
        runtime_id: String,
        generation: String,
        revision: u64,
        observation: Option<crate::agent_activity::Observation>,
        valid_for_ms: u64,
    },
    Snapshot {
        runtime_id: String,
        sequence: u64,
        data: Vec<u8>,
        cols: u16,
        rows: u16,
        truncated: bool,
    },
    Output {
        runtime_id: String,
        sequence: u64,
        data: Vec<u8>,
    },
    Exit {
        runtime_id: String,
        exit_code: Option<i32>,
    },
    Error {
        runtime_id: String,
        message: String,
    },
    Disconnected {
        runtime_id: String,
        message: String,
    },
}
impl UiEvent {
    fn sequence(&self) -> Option<u64> {
        match self {
            Self::Snapshot { sequence, .. } | Self::Output { sequence, .. } => Some(*sequence),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "command",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Hello {
        protocol: u32,
    },
    AcquireUiLease {
        generation: String,
        offer: String,
    },
    RenewUiLease {
        generation: String,
        lease: String,
        sequence: u64,
    },
    ReleaseUiLease {
        generation: String,
        lease: String,
    },
    List {
        generation: String,
    },
    Launch {
        generation: String,
        spec: Box<LaunchSpec>,
        kind: String,
        project_id: Option<String>,
        profile_id: Option<String>,
        resume_id: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        home_directory: bool,
        cols: u16,
        rows: u16,
    },
    FindResume {
        generation: String,
        key: String,
    },
    Poll {
        generation: String,
        runtime_id: String,
        after: Option<u64>,
        #[serde(default, skip_serializing_if = "is_false")]
        agent_activity: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        terminal_status: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        activity_after: Option<activity::Cursor>,
    },
    ProviderState {
        generation: String,
        launch: String,
        report: crate::provider_hooks::StateReport,
    },
    ProviderHook {
        generation: String,
        launch: String,
        callback: crate::provider_hooks::Callback,
    },
    ProviderHookFailed {
        generation: String,
        launch: String,
    },
    RevokeProviderHooks {
        generation: String,
        provider: crate::models::AgentKind,
    },
    OpenOrderedActivity {
        generation: String,
        runtime_id: String,
        provider: crate::models::AgentKind,
        session_id: String,
    },
    PublishActivity {
        generation: String,
        runtime_id: String,
        activity_generation: String,
        capability: activity::Capability,
        sequence: u64,
        registered_event: String,
        payload: Vec<u8>,
    },
    CloseActivity {
        generation: String,
        runtime_id: String,
        activity_generation: String,
        capability: activity::Capability,
    },
    Write {
        generation: String,
        runtime_id: String,
        data: String,
    },
    Resize {
        generation: String,
        runtime_id: String,
        cols: u16,
        rows: u16,
    },
    Stop {
        generation: String,
        runtime_id: String,
    },
    Forget {
        generation: String,
        runtime_id: String,
    },
    /// Explicit process-management action, never used by desktop close/drop.
    Shutdown {
        generation: String,
    },
}
impl Request {
    fn generation(&self) -> Option<&str> {
        match self {
            Self::Hello { .. } => None,
            Self::AcquireUiLease { generation, .. }
            | Self::RenewUiLease { generation, .. }
            | Self::ReleaseUiLease { generation, .. }
            | Self::List { generation }
            | Self::Launch { generation, .. }
            | Self::FindResume { generation, .. }
            | Self::Poll { generation, .. }
            | Self::ProviderState { generation, .. }
            | Self::ProviderHook { generation, .. }
            | Self::ProviderHookFailed { generation, .. }
            | Self::RevokeProviderHooks { generation, .. }
            | Self::OpenOrderedActivity { generation, .. }
            | Self::PublishActivity { generation, .. }
            | Self::CloseActivity { generation, .. }
            | Self::Write { generation, .. }
            | Self::Resize { generation, .. }
            | Self::Stop { generation, .. }
            | Self::Forget { generation, .. }
            | Self::Shutdown { generation } => Some(generation),
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "result",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Response {
    ActivityOpened {
        activity_generation: String,
        capability: activity::Capability,
    },
    Hello {
        protocol: u32,
        generation: String,
        #[serde(default)]
        capabilities: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ui_lease_offer: Option<String>,
    },
    UiLease {
        lease: String,
        sequence: u64,
        valid_for_ms: u64,
    },
    Records {
        records: Vec<RuntimeRecord>,
    },
    Runtime {
        info: Option<RuntimeInfo>,
    },
    Events {
        events: Vec<UiEvent>,
    },
    Ok,
    Error {
        message: String,
    },
}
struct Entry {
    record: RuntimeRecord,
    screen: Option<Arc<Mutex<screen::TerminalScreen>>>,
}
struct Host {
    generation: String,
    directory: PathBuf,
    runtime: Arc<RuntimeManager>,
    entries: Mutex<HashMap<String, Entry>>,
    activity: Mutex<HashMap<String, activity::State>>,
    provider_hooks: Mutex<HashMap<String, provider_hooks::Lease>>,
    activity_permits: Arc<tokio::sync::Semaphore>,
    shutdown: std::sync::atomic::AtomicBool,
    shutdown_reply_complete: tokio::sync::Notify,
    persisted: Mutex<Vec<u8>>,
    ui_leases: Mutex<ui_lease::Registry>,
    storage_kind: storage::Kind,
    retirement: Mutex<retirement::Gate>,
    retirement_policy: retirement::Policy,
}
fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|error| error.into_inner())
}

impl Host {
    #[cfg(test)]
    fn open(directory: PathBuf) -> Result<Arc<Self>, String> {
        Self::open_with_policy(directory, retirement::Policy::default())
    }
    fn open_with_policy(
        directory: PathBuf,
        retirement_policy: retirement::Policy,
    ) -> Result<Arc<Self>, String> {
        let mut entries = HashMap::new();
        // Missing metadata is historical uncertainty, never pristine evidence.
        let mut storage_kind = storage::Kind::Legacy;
        let mut work_attempted = true;
        let path = directory.join("sessions.json");
        if path.exists() {
            let mut bytes = Vec::new();
            File::open(&path)
                .map_err(|e| e.to_string())?
                .take(1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 1024 * 1024 {
                return Err(
                    "Runtime metadata exceeds its size limit; original file preserved".into(),
                );
            }
            let (kind, attempted, records) = storage::decode(&bytes).map_err(|e| {
                format!("Cannot restore runtime metadata; original file preserved: {e}")
            })?;
            storage_kind = kind;
            work_attempted = attempted;
            if records.len() > MAX_RECORDS {
                return Err("Too many saved runtime records".into());
            }
            for mut record in records {
                // A modern host treats historical manifests as explicit-cwd policy.
                record.home_directory.get_or_insert(false);
                if !matches!(
                    record.info.state.as_str(),
                    "exited" | "failed" | "interrupted"
                ) {
                    record.info.state = "interrupted".into();
                    record.info.exit_code = None;
                }
                entries.insert(
                    record.info.id.clone(),
                    Entry {
                        record,
                        screen: None,
                    },
                );
            }
        }
        let host = Arc::new(Self {
            generation: Uuid::new_v4().to_string(),
            directory,
            runtime: Arc::new(RuntimeManager::new()),
            entries: Mutex::new(entries),
            activity: Mutex::new(HashMap::new()),
            provider_hooks: Mutex::new(HashMap::new()),
            activity_permits: Arc::new(tokio::sync::Semaphore::new(MAX_ACTIVITY_PUBLISHERS)),
            shutdown: std::sync::atomic::AtomicBool::new(false),
            shutdown_reply_complete: tokio::sync::Notify::new(),
            persisted: Mutex::new(Vec::new()),
            ui_leases: Mutex::new(ui_lease::Registry::default()),
            storage_kind,
            retirement: Mutex::new(retirement::Gate::new(work_attempted)),
            retirement_policy,
        });
        host.persist()?;
        Ok(host)
    }
    fn records(&self) -> Vec<RuntimeRecord> {
        let active: HashMap<_, _> = self
            .runtime
            .list()
            .into_iter()
            .map(|info| (info.id.clone(), info))
            .collect();
        let mut entries = lock(&self.entries);
        for (id, entry) in entries.iter_mut() {
            if let Some(info) = active.get(id) {
                entry.record.info = info.clone();
            }
        }
        let mut records: Vec<_> = entries.values().map(|entry| entry.record.clone()).collect();
        records.sort_by(|a, b| a.info.id.cmp(&b.info.id));
        records
    }
    fn persist(&self) -> Result<(), String> {
        // Only identity / project / status. Never executable arguments, environment,
        // input, output, PID, or authentication material.
        // Serialize snapshots inside the writer fence: a delayed writer must not
        // overwrite the durable work-attempt bit with an older pristine snapshot.
        let mut persisted = self
            .persisted
            .lock()
            .map_err(|_| "Runtime writer integrity unavailable")?;
        let attempted = self
            .retirement
            .lock()
            .map_err(|_| "Broker admission integrity unavailable")?
            .work_attempted;
        let bytes = storage::encode(self.storage_kind, attempted, self.records())?;
        if bytes.len() > 1024 * 1024 {
            return Err("Runtime metadata exceeds its size limit".into());
        }
        if *persisted == bytes {
            return Ok(());
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let temporary = self
            .directory
            .join(format!(".sessions-{}.tmp", Uuid::new_v4()));
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, self.directory.join("sessions.json"))?;
            storage::sync_directory(&self.directory)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(|e| format!("Cannot save runtime metadata: {e}"))?;
        *persisted = bytes;
        Ok(())
    }
    fn handle(self: &Arc<Self>, request: Request) -> Result<Response, String> {
        let _admission = self.admit()?;
        if self.shutdown.load(std::sync::atomic::Ordering::Acquire) {
            return Err("The runtime broker is shutting down".into());
        }
        if request
            .generation()
            .is_some_and(|generation| generation != self.generation)
        {
            return Err("The runtime broker restarted. Refresh its authoritative status before taking another action.".into());
        }
        // Hello leaves an offer for legacy clients. Requests without any live
        // lease cannot establish that all clients have departed, even if another
        // client previously released its own lease.
        if !matches!(
            &request,
            Request::Hello { .. }
                | Request::AcquireUiLease { .. }
                | Request::RenewUiLease { .. }
                | Request::ReleaseUiLease { .. }
        ) {
            match self.ui_leases() {
                Ok(mut leases) => {
                    if !leases.has_live(self.now()) {
                        leases.pin_unknown();
                    }
                }
                // Uncertain lease evidence prevents retirement, not existing
                // terminal interaction or the explicit stop path.
                Err(_) => self.mark_fault(),
            }
        }
        match request {
            Request::Hello { protocol } => {
                if protocol != PROTOCOL {
                    return Err("A different runtime broker version is active. Stop its sessions explicitly before upgrading.".into());
                }
                Ok(Response::Hello {
                    protocol: PROTOCOL,
                    generation: self.generation.clone(),
                    capabilities: vec![
                        ui_lease::CAPABILITY.into(),
                        HOME_DIRECTORY_CAPABILITY.into(),
                        ACTIVITY_CAPABILITY.into(),
                        TERMINAL_STATUS_CAPABILITY.into(),
                        crate::provider_hooks::CAPABILITY.into(),
                    ],
                    ui_lease_offer: self.ui_leases()?.offer(self.now()),
                })
            }
            Request::AcquireUiLease { offer, .. } => self.ui_leases()?.acquire(&offer, self.now()),
            Request::RenewUiLease {
                lease, sequence, ..
            } => self.ui_leases()?.renew(&lease, sequence, self.now()),
            Request::ReleaseUiLease { lease, .. } => self.ui_leases()?.release(&lease, self.now()),
            Request::List { .. } => Ok(Response::Records {
                records: self.records(),
            }),
            Request::FindResume { key, .. } => Ok(Response::Runtime {
                info: self.runtime.find_running_resume(&key),
            }),
            Request::Launch {
                mut spec,
                kind,
                project_id,
                profile_id,
                resume_id,
                home_directory,
                cols,
                rows,
                ..
            } => {
                // Durable before preflight, hook preparation, or any spawn attempt.
                self.mark_work_attempt()?;
                if home_directory
                    && (kind != "shell"
                        || project_id.is_some()
                        || resume_id.is_some()
                        || spec.session_id.is_some()
                        || spec.resume_key.is_some())
                {
                    return Err("Home directory policy requires an unscoped shell".into());
                }
                screen::validate_size(cols, rows)?;
                if kind != "shell" && crate::models::AgentKind::parse(&kind).is_err() {
                    return Err("Unknown runtime kind".into());
                }
                if [&project_id, &profile_id, &resume_id].iter().any(|id| {
                    id.as_ref()
                        .is_some_and(|id| id.len() > 1024 || id.contains('\0'))
                }) {
                    return Err("Invalid runtime metadata".into());
                }
                // Pane identity is idempotent, even after a lost launch response.
                if let Some(existing) = self.records().into_iter().find(|record| {
                    record.info.pane_id == spec.pane_id
                        && matches!(
                            record.info.state.as_str(),
                            "running" | "stopping" | "unknown"
                        )
                }) {
                    return Ok(Response::Runtime {
                        info: Some(existing.info),
                    });
                }
                if lock(&self.entries).len() >= MAX_RECORDS {
                    return Err("Close completed panes before opening more terminals (128 retained panes maximum)".into());
                }
                // Reserve before spawn: SessionStart may run before launch returns.
                // This lock blocks callback admission only until identity is installed.
                // Preserve native image-input provenance before an app-owned
                // observer wraps the executable; never trust arbitrary wrappers.
                let image_input = crate::image_input::supports_launch(&kind, &spec);
                let hook_mode = spec.env.remove(crate::provider_hooks::OPT_IN);
                let mut hook_expected_session = resume_id.clone();
                let mut terminal_status_enabled = false;
                let hook_launch = if matches!(hook_mode.as_deref(), Some("1" | "live")) {
                    let provider = crate::models::AgentKind::parse(&kind)?;
                    let helper = std::env::current_exe().map_err(|e| e.to_string())?;
                    let launch = Uuid::new_v4().to_string();
                    spec.env.insert(
                        crate::provider_hooks::DIRECTORY.into(),
                        self.directory.to_string_lossy().into_owned(),
                    );
                    spec.env.insert(
                        crate::provider_hooks::GENERATION.into(),
                        self.generation.clone(),
                    );
                    spec.env
                        .insert(crate::provider_hooks::LAUNCH.into(), launch.clone());
                    if hook_mode.as_deref() == Some("live") {
                        match provider {
                            crate::models::AgentKind::Codex => {
                                terminal_status_enabled =
                                    crate::terminal_status_launch::prepare(provider, &mut spec)?;
                                if !terminal_status_enabled {
                                    crate::codex_state::prepare(&mut spec, &helper)?;
                                }
                            }
                            crate::models::AgentKind::Grok
                            | crate::models::AgentKind::Antigravity => {
                                terminal_status_enabled =
                                    crate::terminal_status_launch::prepare(provider, &mut spec)?;
                                if !terminal_status_enabled {
                                    return Err("This provider version does not support reviewed native terminal status".into());
                                }
                            }
                            crate::models::AgentKind::Claude => {
                                crate::claude_state::prepare(&mut spec, &helper)?
                            }
                            crate::models::AgentKind::OpenCode => {
                                let native = crate::opencode_state::expected_session(&spec)?;
                                if resume_id
                                    .as_ref()
                                    .is_some_and(|id| native.as_ref() != Some(id))
                                {
                                    return Err("OpenCode resume metadata differs from native launch identity".into());
                                }
                                hook_expected_session = native;
                                crate::opencode_state::prepare(&mut spec, &helper)?
                            }
                        }
                    } else {
                        crate::provider_hooks::configure(&mut spec, provider, &helper)?;
                    }
                    Some((launch, provider))
                } else {
                    None
                };
                let mut hook_guard = hook_launch.as_ref().map(|_| lock(&self.provider_hooks));
                let screen = Arc::new(Mutex::new(screen::TerminalScreen::new(cols, rows)));
                if terminal_status_enabled {
                    lock(&screen).enable_terminal_status();
                }
                let terminal_status = Arc::new(Mutex::new((
                    crate::terminal_status::Decoder::default(),
                    crate::terminal_status::Records::default(),
                )));
                let status_launch = hook_launch
                    .as_ref()
                    .filter(|_| terminal_status_enabled)
                    .map(|(launch, _)| launch.clone());
                let output = Arc::clone(&screen);
                let manager = Arc::clone(&self.runtime);
                let host = Arc::downgrade(self);
                let info = self
                    .runtime
                    .launch(
                        *spec,
                        cols,
                        rows,
                        Arc::new(move |event| {
                            if let TerminalEvent::Exit { runtime_id, .. } = &event {
                                if let Some(host) = host.upgrade() {
                                    if let Some(launch) = &status_launch {
                                        let mut state = lock(&terminal_status);
                                        state.1.process_exit();
                                        host.receive_terminal_status(
                                            launch,
                                            runtime_id,
                                            state.1.status(),
                                        );
                                    }
                                    host.finish_runtime_hooks(runtime_id);
                                }
                            }
                            if let (
                                Some(launch),
                                TerminalEvent::Output {
                                    runtime_id, data, ..
                                },
                            ) = (&status_launch, &event)
                            {
                                let mut state = lock(&terminal_status);
                                let changes = state.0.feed(data);
                                if !changes.is_empty() {
                                    for change in changes {
                                        state.1.apply(change);
                                    }
                                    if let Some(host) = host.upgrade() {
                                        host.receive_terminal_status(
                                            launch,
                                            runtime_id,
                                            state.1.status(),
                                        );
                                    }
                                }
                            }
                            let ack = match &event {
                                TerminalEvent::Output {
                                    runtime_id,
                                    sequence,
                                    ..
                                } => Some((runtime_id.clone(), *sequence)),
                                _ => None,
                            };
                            let replies = {
                                let mut output = lock(&output);
                                output.event(event);
                                output.replies()
                            };
                            if !replies.is_empty() {
                                if let Some((id, _)) = &ack {
                                    let _ = manager.write(id, &String::from_utf8_lossy(&replies));
                                }
                            }
                            // The broker, not the WebView, consumes the PTY stream. UI
                            // detach / slow rendering must never trigger runtime ACK timeout.
                            if let Some((id, sequence)) = ack {
                                manager.ack(&id, sequence)?;
                            }
                            Ok(())
                        }),
                    )
                    .inspect_err(|_| {
                        if let Some((launch, _)) = &hook_launch {
                            crate::claude_state::cleanup(launch);
                            crate::opencode_state::cleanup(launch);
                        }
                    })?;
                let mut entries = lock(&self.entries);
                if entries.contains_key(&info.id) {
                    // Runtime reuse did not spawn the newly prepared source.
                    if let Some((launch, _)) = &hook_launch {
                        crate::claude_state::cleanup(launch);
                        crate::opencode_state::cleanup(launch);
                    }
                    return Ok(Response::Runtime { info: Some(info) });
                }
                // An explicit restart replaces the older record for this pane.
                let mut retired_activity = Vec::new();
                entries.retain(|id, entry| {
                    let keep = entry.record.info.pane_id != info.pane_id;
                    if !keep {
                        retired_activity.push(id.clone());
                    }
                    keep
                });
                if let (Some((launch, provider)), Some(leases)) = (&hook_launch, &mut hook_guard) {
                    leases.insert(
                        launch.clone(),
                        provider_hooks::Lease {
                            launch: launch.clone(),
                            runtime_id: info.id.clone(),
                            provider: *provider,
                            expected_session: hook_expected_session,
                            session: None,
                            activity_generation: None,
                            ended: false,
                            source_sequence: 0,
                            live: hook_mode.as_deref() == Some("live"),
                            terminal: terminal_status_enabled,
                            retired_sessions: Default::default(),
                        },
                    );
                }
                entries.insert(
                    info.id.clone(),
                    Entry {
                        record: RuntimeRecord {
                            info: info.clone(),
                            kind,
                            project_id,
                            profile_id,
                            resume_id,
                            home_directory: Some(home_directory),
                            image_input,
                            file_input: Some(image_input),
                        },
                        screen: Some(screen),
                    },
                );
                drop(entries);
                drop(hook_guard);
                for id in retired_activity {
                    lock(&self.activity).remove(&id);
                }
                if let Err(error) = self.persist() {
                    // Launch must not claim durability when saving identity failed.
                    // Revoke staging even if stopping the process itself fails.
                    self.revoke_runtime_hooks(&info.id);
                    let _ = self.runtime.stop(&info.id);
                    return Err(error);
                }
                Ok(Response::Runtime { info: Some(info) })
            }
            Request::Poll {
                runtime_id,
                after,
                agent_activity,
                terminal_status,
                activity_after,
                ..
            } => {
                let entries = lock(&self.entries);
                let entry = entries.get(&runtime_id).ok_or("Terminal not found")?;
                let mut events = if let Some(screen) = &entry.screen {
                    lock(screen).poll(&runtime_id, after)?
                } else {
                    let message = if entry.record.info.state == "interrupted" {
                        "The previous runtime broker or computer stopped. This process cannot be reattached; restart it explicitly."
                    } else {
                        "This completed terminal's output was held in memory and is no longer available after the runtime broker restarted."
                    };
                    vec![UiEvent::Disconnected {
                        runtime_id: runtime_id.clone(),
                        message: message.into(),
                    }]
                };
                drop(entries);
                if agent_activity {
                    if let Some(event) =
                        self.poll_activity(&runtime_id, activity_after.as_ref(), Instant::now())
                    {
                        // Invalidation precedes the exit that ends the subscription.
                        if terminal_status || !matches!(event, UiEvent::TerminalStatus { .. }) {
                            events.insert(0, event);
                        }
                    }
                }
                Ok(Response::Events { events })
            }
            Request::ProviderState { launch, report, .. } => {
                self.receive_provider_state(&launch, report)
            }
            Request::ProviderHook {
                launch, callback, ..
            } => self.receive_provider_hook(&launch, callback),
            Request::ProviderHookFailed { launch, .. } => {
                self.fail_provider_hook(&launch);
                Ok(Response::Ok)
            }
            Request::RevokeProviderHooks { provider, .. } => {
                self.revoke_provider_hooks(provider);
                Ok(Response::Ok)
            }
            Request::OpenOrderedActivity { .. }
            | Request::PublishActivity { .. }
            | Request::CloseActivity { .. } => {
                Err("Activity publishers require their dedicated authenticated stream".into())
            }
            Request::Write {
                runtime_id, data, ..
            } => {
                self.runtime.write(&runtime_id, &data)?;
                Ok(Response::Ok)
            }
            Request::Resize {
                runtime_id,
                cols,
                rows,
                ..
            } => {
                screen::validate_size(cols, rows)?;
                self.runtime.resize(&runtime_id, cols, rows)?;
                if let Some(screen) = lock(&self.entries)
                    .get(&runtime_id)
                    .and_then(|entry| entry.screen.as_ref())
                {
                    lock(screen).resize(cols, rows);
                }
                Ok(Response::Ok)
            }
            Request::Stop { runtime_id, .. } => {
                self.runtime.stop(&runtime_id)?;
                self.persist()?;
                Ok(Response::Ok)
            }
            Request::Forget { runtime_id, .. } => {
                let records = self.records();
                if records.iter().any(|record| {
                    record.info.id == runtime_id
                        && matches!(
                            record.info.state.as_str(),
                            "running" | "stopping" | "unknown"
                        )
                }) {
                    return Err("Stop this terminal before closing its record".into());
                }
                lock(&self.entries).remove(&runtime_id);
                lock(&self.activity).remove(&runtime_id);
                self.persist()?;
                Ok(Response::Ok)
            }
            Request::Shutdown { .. } => {
                self.runtime.shutdown()?;
                self.persist()?;
                self.shutdown
                    .store(true, std::sync::atomic::Ordering::Release);
                Ok(Response::Ok)
            }
        }
    }
}

/// The same installed executable enters this mode before creating any WebView.
/// No autostart service is installed; broker lifetime is independent of UI clients.
pub fn run(directory: PathBuf) -> Result<(), String> {
    run_with_policy(directory, retirement::Policy::default())
}
fn run_with_policy(directory: PathBuf, policy: retirement::Policy) -> Result<(), String> {
    let directory = transport::private_directory(&directory).map_err(|e| e.to_string())?;
    // A concurrent directory creator can briefly hold this same owner lock
    // while synchronizing the initial envelope. Never displace a live owner.
    let ownership_deadline = Instant::now() + Duration::from_secs(1);
    let _ownership = loop {
        match transport::lock(&directory) {
            Ok(owner) => break owner,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    && Instant::now() < ownership_deadline =>
            {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                return Err(format!(
                    "Runtime broker already active or lock unavailable: {error}"
                ))
            }
        }
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let result = runtime.block_on(async move {
        let host = Host::open_with_policy(directory.clone(), policy)?;
        let listener = transport::listener(&directory).map_err(|e| e.to_string())?;
        let permits = Arc::new(tokio::sync::Semaphore::new(MAX_CLIENTS));
        let mut last_persist = Instant::now();
        while !host.shutdown.load(std::sync::atomic::Ordering::Acquire) {
            // Timeout gives idle maintenance an opportunity without creating an
            // unbounded connection queue or thread for a slow/malicious peer.
            match tokio::time::timeout(Duration::from_millis(250), listener.accept()).await {
                Ok(Ok(stream)) => {
                    // Admission covers accepted-but-unread requests, not only handle().
                    let Ok(admission) = host.admit() else {
                        // A concurrent explicit Shutdown still owns its reply.
                        // Drop this late stream and let the normal exit path wait.
                        continue;
                    };
                    if let Ok(permit) = Arc::clone(&permits).try_acquire_owned() {
                        let host = Arc::clone(&host);
                        tokio::spawn(async move {
                            let _permit = permit;
                            let _admission = admission;
                            if serve(stream, host.clone()).await.is_err() {
                                host.pin_unknown_client();
                            }
                        });
                    } else {
                        host.pin_unknown_client();
                    }
                }
                Ok(Err(error)) => return Err(format!("Runtime IPC listener failed: {error}")),
                Err(_) => (),
            }
            if last_persist.elapsed() >= Duration::from_secs(2) {
                // Exit metadata is best effort here; the previous running record
                // safely becomes interrupted after a crash, never falsely live.
                if host.persist().is_err() {
                    host.mark_fault();
                }
                last_persist = Instant::now();
            }
            if host.try_idle_exit() {
                // No Shutdown request exists whose reply could notify us.
                host.shutdown_reply_complete.notify_one();
            }
        }
        drop(listener);
        // Do not cancel the shutdown response just because its handler stopped
        // the runtimes. The response task also signals on error or timeout.
        host.shutdown_reply_complete.notified().await;
        Ok(())
    });
    // Windows pipe flush uses a blocking task. A peer that never reads must not
    // keep broker process shutdown waiting forever after REQUEST_TIMEOUT.
    runtime.shutdown_timeout(Duration::from_millis(250));
    result
}

struct ShutdownReply<'a>(&'a Host);
impl Drop for ShutdownReply<'_> {
    fn drop(&mut self) {
        self.0.shutdown_reply_complete.notify_one();
    }
}
async fn serve(mut stream: Stream, host: Arc<Host>) -> Result<(), String> {
    let _admission = host.admit()?;
    transport::authenticate(&stream).map_err(|e| e.to_string())?;
    let bytes = tokio::time::timeout(
        transport::REQUEST_TIMEOUT,
        transport::read_frame(&mut stream, 1024 * 1024),
    )
    .await
    .map_err(|_| "Runtime request timed out")?
    .map_err(|e| e.to_string())?;
    // Launch/paste limits are stricter than a bounded screen response.
    let mut shutting_down = false;
    let response = if bytes.len() > 1024 * 1024 {
        Response::Error {
            message: "Runtime request exceeds 1 MiB".into(),
        }
    } else {
        match serde_json::from_slice::<Request>(&bytes) {
            Ok(request @ Request::OpenOrderedActivity { .. }) => {
                return activity::serve_publisher(stream, host, request).await;
            }
            Ok(request) => {
                let shutdown = matches!(request, Request::Shutdown { .. });
                match host.handle(request) {
                    Ok(response) => {
                        shutting_down = shutdown;
                        response
                    }
                    Err(message) => Response::Error { message },
                }
            }
            Err(_) => {
                host.pin_unknown_client();
                Response::Error {
                    message: "Invalid runtime request".into(),
                }
            }
        }
    };
    // Keep the completion guard alive across write/flush. Cancellation by the
    // enclosing request timeout must release the main loop as well.
    let _completion = shutting_down.then(|| ShutdownReply(&host));
    let bytes = serde_json::to_vec(&response).map_err(|e| e.to_string())?;
    tokio::time::timeout(transport::REQUEST_TIMEOUT, async {
        transport::write_frame(&mut stream, &bytes).await?;
        if shutting_down {
            transport::flush_shutdown_reply(&mut stream).await?;
        }
        Ok::<_, std::io::Error>(())
    })
    .await
    .map_err(|_| "Runtime response timed out")?
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn stop_arguments() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--sessionbay-runtime-broker-stop")) {
        return None;
    }
    args.next()
        .map(PathBuf::from)
        .filter(|_| args.next().is_none())
}

pub fn broker_arguments() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--sessionbay-runtime-broker")) {
        return None;
    }
    args.next()
        .map(PathBuf::from)
        .filter(|_| args.next().is_none())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_capability_is_additive_and_defaults_closed_for_old_records() {
        let value = serde_json::json!({"id":"runtime", "paneId":"pane", "sessionId":null,
            "state":"running", "cwd":"/synthetic", "exitCode":null, "kind":"codex",
            "projectId":null, "profileId":null, "resumeId":null});
        let mut record: RuntimeRecord = serde_json::from_value(value).unwrap();
        assert!(!record.image_input);
        assert!(serde_json::to_value(&record)
            .unwrap()
            .get("imageInput")
            .is_none());
        record.image_input = true;
        let restored: RuntimeRecord =
            serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(restored.image_input);
    }
    #[test]
    fn file_capability_distinguishes_missing_denied_and_legacy_evidence() {
        let value = serde_json::json!({"id":"runtime", "paneId":"pane", "sessionId":null,
            "state":"running", "cwd":"/synthetic", "exitCode":null, "kind":"codex",
            "projectId":null, "profileId":null, "resumeId":null});
        let mut record: RuntimeRecord = serde_json::from_value(value).unwrap();
        assert_eq!(record.file_input, None);
        assert!(crate::file_input::check_runtime(&record)
            .unwrap_err()
            .contains("no verifiable"));
        record.image_input = true;
        assert!(crate::file_input::check_runtime(&record).is_ok());
        record.file_input = Some(false);
        let restored: RuntimeRecord =
            serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(restored.file_input, Some(false));
        assert!(crate::file_input::check_runtime(&record)
            .unwrap_err()
            .contains("was not launched"));
        record.file_input = Some(true);
        assert!(crate::file_input::check_runtime(&record).is_ok());
        record.info.state = "stopped".into();
        assert!(crate::file_input::check_runtime(&record)
            .unwrap_err()
            .contains("has stopped"));
        record.info.state = "running".into();
        record.kind = "shell".into();
        assert!(crate::file_input::check_runtime(&record).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn host_consumes_output_without_any_ui_and_replay_survives_new_readers() {
        let temp = tempfile::tempdir().unwrap();
        let host = Host::open(temp.path().into()).unwrap();
        let spec = LaunchSpec { executable: "/bin/sh".into(), args: vec!["-c".into(), "i=0; while [ $i -lt 10000 ]; do printf 'background-output\\r\\n'; i=$((i+1)); done; printf 'background-complete'; read value; printf '\\r\\nreceived:%s' \"$value\"; sleep 60".into()], cwd: temp.path().into(), env: HashMap::new(), session_id: None, resume_key: None, pane_id: "pane-test".into() };
        let response = host
            .handle(Request::Launch {
                generation: host.generation.clone(),
                spec: Box::new(spec),
                kind: "shell".into(),
                project_id: Some("project-test".into()),
                profile_id: None,
                resume_id: None,
                home_directory: false,
                cols: 80,
                rows: 24,
            })
            .unwrap();
        let Response::Runtime { info: Some(info) } = response else {
            panic!("missing runtime")
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let response = host
                .handle(Request::Poll {
                    generation: host.generation.clone(),
                    runtime_id: info.id.clone(),
                    after: None,
                    agent_activity: false,
                    terminal_status: false,
                    activity_after: None,
                })
                .unwrap();
            let Response::Events { events } = response else {
                panic!("missing output")
            };
            if events.iter().any(|event| match event {
                UiEvent::Snapshot { data, .. } => {
                    String::from_utf8_lossy(data).contains("background-complete")
                }
                _ => false,
            }) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "background output stalled without UI ACK"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(host.records()[0].info.state, "running");
        assert!(host
            .handle(Request::Write {
                generation: "stale-generation".into(),
                runtime_id: info.id.clone(),
                data: "must-not-run".into()
            })
            .is_err());
        host.handle(Request::Write {
            generation: host.generation.clone(),
            runtime_id: info.id.clone(),
            data: "after-attach\n".into(),
        })
        .unwrap();
        host.handle(Request::Stop {
            generation: host.generation.clone(),
            runtime_id: info.id.clone(),
        })
        .unwrap();
        assert_eq!(host.records()[0].info.id, info.id);
        let metadata = fs::read_to_string(temp.path().join("sessions.json")).unwrap();
        assert!(!metadata.contains("background-output"));
        assert!(!metadata.contains("executable"));
        assert!(!metadata.contains("pid"));
        host.handle(Request::Forget {
            generation: host.generation.clone(),
            runtime_id: info.id,
        })
        .unwrap();
        assert!(host.records().is_empty());
    }
    #[test]
    fn old_manifest_defaults_to_explicit_cwd_and_home_policy_round_trips() {
        let base = serde_json::json!({"id":"synthetic", "paneId":"pane", "sessionId":null,
            "state":"interrupted", "cwd":"/synthetic/explicit", "exitCode":null,
            "kind":"shell", "projectId":null, "profileId":null, "resumeId":null});
        let old: RuntimeRecord = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(old.home_directory, None);
        assert_eq!(old.info.cwd, "/synthetic/explicit");
        let mut home = base;
        home["homeDirectory"] = true.into();
        let record: RuntimeRecord = serde_json::from_value(home).unwrap();
        assert_eq!(record.home_directory, Some(true));
        let restored: RuntimeRecord =
            serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(restored.home_directory, Some(true));
        assert!(restored.project_id.is_none());
    }
    #[test]
    fn metadata_only_recovery_marks_previous_live_records_interrupted() {
        let temp = tempfile::tempdir().unwrap();
        let record = RuntimeRecord {
            info: RuntimeInfo {
                id: "synthetic-id".into(),
                pane_id: "pane".into(),
                session_id: None,
                state: "running".into(),
                cwd: "/synthetic".into(),
                exit_code: None,
            },
            kind: "shell".into(),
            project_id: None,
            profile_id: None,
            resume_id: None,
            home_directory: Some(false),
            image_input: false,
            file_input: Some(false),
        };
        fs::write(
            temp.path().join("sessions.json"),
            serde_json::to_vec(&vec![record]).unwrap(),
        )
        .unwrap();
        // An older manifest has no home policy; its explicit cwd must remain authoritative.
        let path = temp.path().join("sessions.json");
        let mut records: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        records[0].as_object_mut().unwrap().remove("homeDirectory");
        fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();
        let host = Host::open(temp.path().into()).unwrap();
        assert_eq!(host.records()[0].home_directory, Some(false));
        assert_eq!(host.records()[0].info.cwd, "/synthetic");
        assert_eq!(host.records()[0].info.state, "interrupted");
        assert!(host.runtime.list().is_empty());
        assert!(host.runtime.stop("synthetic-id").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn detached_host_answers_background_color_query_through_the_pty() {
        let temp = tempfile::tempdir().unwrap();
        let host = Host::open(temp.path().into()).unwrap();
        let spec = LaunchSpec {executable: "/bin/sh".into(), args: vec!["-c".into(), "stty raw -echo; printf '\\033]11;?\\007'; answer=$(dd bs=1 count=25 2>/dev/null); printf '\\r\\ncolor-query-completed'; sleep 60".into()], cwd: temp.path().into(), env: HashMap::new(), session_id: None, resume_key: None, pane_id: "query-pane".into()};
        let response = host
            .handle(Request::Launch {
                generation: host.generation.clone(),
                spec: Box::new(spec),
                kind: "shell".into(),
                project_id: None,
                profile_id: None,
                resume_id: None,
                home_directory: false,
                cols: 80,
                rows: 24,
            })
            .unwrap();
        let Response::Runtime { info: Some(info) } = response else {
            panic!("no runtime")
        };
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let entry = lock(&host.entries)
                .get(&info.id)
                .unwrap()
                .screen
                .clone()
                .unwrap();
            let events = lock(&entry).poll(&info.id, None).unwrap();
            if events.iter().any(|event|matches!(event,UiEvent::Snapshot{data,..} if String::from_utf8_lossy(data).contains("color-query-completed"))){break;}
            if Instant::now() > deadline {
                host.runtime.shutdown().unwrap();
                panic!("color query waited for absent UI");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        host.runtime.shutdown().unwrap();
    }
}

#[cfg(all(test, unix))]
mod terminal_status_tests;

#[cfg(all(test, unix))]
mod lifecycle_foundation_tests;
