//! Owned PTY runtimes for macOS, Linux, and Windows (ConPTY).
//!
//! On Unix only the worker owns/reaps the child. `waitid(WNOWAIT)` keeps its PID reserved
//! until cleanup is finished. Session authority is tied to that owned, waitable
//! child, not to getsid(leader), which cannot find zombies on Darwin.
//! All job-control groups in the new PTY session are cleaned up; processes that
//! deliberately daemonize into another session are outside this ownership scope.
//! Windows holds the original process handle and ConPTY session; deliberately
//! detached console processes are outside its ownership scope.
//! Output stays as bytes and is sent by one worker, never through application UI
//! state. The frontend must ACK only after xterm's write callback has completed.

use portable_pty::{CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

mod lifecycle;
pub use lifecycle::RuntimeQuiescence;

pub const MAX_IN_FLIGHT_BYTES: usize = 256 * 1024;
pub const MAX_IN_FLIGHT_CHUNKS: usize = 64;
pub const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
pub const MAX_INPUT_BYTES: usize = 256 * 1024;
const MAX_ACTIVE_RUNTIMES: usize = 32;
const MAX_RETAINED_RUNTIMES: usize = 256;
const TICK: Duration = Duration::from_millis(20);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
const ACK_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(any(windows, test))]
#[path = "runtime/cursor.rs"]
mod cursor;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "runtime/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "runtime/windows.rs"]
mod platform;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
compile_error!("Session Bay supports macOS, Linux, and Windows");

type Emitter = Arc<dyn Fn(TerminalEvent) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub session_id: Option<String>,
    /// Internal provider/source identity, separate from an indexed catalog ID.
    pub resume_key: Option<String>,
    pub pane_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub id: String,
    pub pane_id: String,
    pub session_id: Option<String>,
    pub state: String,
    pub cwd: String,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
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
}

#[derive(Default)]
struct FlowControl {
    sent: u64,
    acknowledged: u64,
    bytes: usize,
    pending: VecDeque<(u64, usize)>,
}

impl FlowControl {
    fn capacity(&self) -> usize {
        if self.pending.len() >= MAX_IN_FLIGHT_CHUNKS {
            0
        } else {
            OUTPUT_CHUNK_BYTES.min(MAX_IN_FLIGHT_BYTES - self.bytes)
        }
    }

    fn reserve(&mut self, bytes: usize) -> u64 {
        debug_assert!(bytes > 0 && bytes <= self.capacity());
        self.sent += 1;
        self.bytes += bytes;
        self.pending.push_back((self.sent, bytes));
        self.sent
    }

    // Cumulative ACKs are safe because this is one ordered channel and xterm's
    // write callbacks acknowledge consumption in that same order.
    fn acknowledge(&mut self, sequence: u64) -> Result<(), String> {
        if sequence > self.sent {
            return Err("Cannot acknowledge terminal output that was never sent".into());
        }
        if sequence <= self.acknowledged {
            return Ok(());
        }
        while self
            .pending
            .front()
            .is_some_and(|(seq, _)| *seq <= sequence)
        {
            let (_, bytes) = self.pending.pop_front().expect("front exists");
            self.bytes -= bytes;
        }
        self.acknowledged = sequence;
        Ok(())
    }
}

struct Control {
    info: RuntimeInfo,
    resume_key: Option<String>,
    flow: FlowControl,
    input: VecDeque<u8>,
    stop_requested: bool,
    input_closed: bool,
    cleanup_error: Option<String>,
    // Reserved for positive job-containment proof. A process-list scan, a reaped
    // leader, or closed PTY is insufficient; current platform workers leave false.
    cleanup_verified: bool,
    done: bool,
}

struct Runtime {
    control: Mutex<Control>,
    changed: Condvar,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
}

impl Runtime {
    fn request_stop(&self) {
        let mut control = lock(&self.control);
        if !control.done {
            control.stop_requested = true;
            control.input_closed = true;
            control.info.state = "stopping".into();
            control.input.clear();
        }
        self.changed.notify_all();
    }

    fn wait_stopped(&self, deadline: Instant) -> Result<(), String> {
        let mut control = lock(&self.control);
        while !control.done {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                control.info.state = "unknown".into();
                return Err(
                    "The process has not exited after termination; supervision is still active"
                        .into(),
                );
            }
            control = self
                .changed
                .wait_timeout(control, remaining)
                .unwrap_or_else(|poison| poison.into_inner())
                .0;
        }
        match &control.cleanup_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
}

#[derive(Default)]
struct Registry {
    runtimes: HashMap<String, Arc<Runtime>>,
    shutting_down: bool,
    // Unknown rollback/evicted cleanup evidence must survive record pruning.
    cleanup_uncertain: bool,
}

#[derive(Default)]
pub struct RuntimeManager {
    registry: Mutex<Registry>,
}

impl RuntimeManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn find_running_resume(&self, resume_key: &str) -> Option<RuntimeInfo> {
        lock(&self.registry).runtimes.values().find_map(|runtime| {
            let control = lock(&runtime.control);
            (!control.done && control.resume_key.as_deref() == Some(resume_key))
                .then(|| control.info.clone())
        })
    }

    pub fn launch(
        &self,
        spec: LaunchSpec,
        cols: u16,
        rows: u16,
        emit: Emitter,
    ) -> Result<RuntimeInfo, String> {
        self.launch_environment(spec, cols, rows, emit, false)
    }
    /// App-owned probes only. Ordinary agent launches retain their environment.
    #[cfg(unix)]
    pub(crate) fn launch_isolated(
        &self,
        spec: LaunchSpec,
        cols: u16,
        rows: u16,
        emit: Emitter,
    ) -> Result<RuntimeInfo, String> {
        self.launch_environment(spec, cols, rows, emit, true)
    }
    fn launch_environment(
        &self,
        mut spec: LaunchSpec,
        cols: u16,
        rows: u16,
        emit: Emitter,
        isolated: bool,
    ) -> Result<RuntimeInfo, String> {
        // Hold this lock through registration to make duplicate-session launches
        // atomic, including concurrent double clicks and shutdown races.
        let mut registry = lock(&self.registry);
        if registry.shutting_down {
            return Err("The application is shutting down".into());
        }
        for runtime in registry.runtimes.values() {
            let control = lock(&runtime.control);
            let same_catalog = spec
                .session_id
                .as_ref()
                .is_some_and(|id| control.info.session_id.as_ref() == Some(id));
            let same_provider = spec
                .resume_key
                .as_ref()
                .is_some_and(|id| control.resume_key.as_ref() == Some(id));
            // A reused catalog ID must never hide a changed source root. New
            // plans carry provider provenance; catalog-only callers retain the
            // legacy guard when neither side has that stronger identity.
            let legacy_catalog =
                same_catalog && spec.resume_key.is_none() && control.resume_key.is_none();
            if !control.done && (legacy_catalog || same_provider) {
                return Ok(control.info.clone());
            }
        }
        let active = registry
            .runtimes
            .values()
            .filter(|runtime| !lock(&runtime.control).done)
            .count();
        if active >= MAX_ACTIVE_RUNTIMES {
            return Err(format!(
                "At most {MAX_ACTIVE_RUNTIMES} terminals can run at once"
            ));
        }
        if registry.runtimes.values().any(|runtime| {
            let control = lock(&runtime.control);
            !control.done && control.info.pane_id == spec.pane_id
        }) {
            return Err("This pane already has an active terminal".into());
        }
        validate_size(cols, rows)?;
        validate_spec(&spec)?;
        spec.cwd = spec
            .cwd
            .canonicalize()
            .map_err(|error| format!("Cannot open working directory: {error}"))?;
        if !spec.cwd.is_dir() {
            return Err("The working directory is not a directory".into());
        }
        let mut command = CommandBuilder::new(&spec.executable);
        if isolated {
            command.env_clear();
        } else {
            crate::host_environment::pty(&mut command)?;
        }
        command.args(&spec.args);
        command.cwd(&spec.cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        let info = RuntimeInfo {
            id: Uuid::new_v4().to_string(),
            pane_id: spec.pane_id,
            session_id: spec.session_id,
            state: "running".into(),
            cwd: spec.cwd.to_string_lossy().into_owned(),
            exit_code: None,
        };
        let runtime = Arc::new(Runtime {
            control: Mutex::new(Control {
                info: info.clone(),
                resume_key: spec.resume_key,
                flow: FlowControl::default(),
                input: VecDeque::new(),
                stop_requested: false,
                input_closed: false,
                cleanup_error: None,
                cleanup_verified: false,
                done: false,
            }),
            changed: Condvar::new(),
            master: Mutex::new(None),
        });
        let spawned = match platform::spawn(Arc::clone(&runtime), command, pty_size(cols, rows)) {
            Ok(spawned) => spawned,
            Err(error) => {
                // Platform rollback is best effort and does not return positive cleanup proof.
                registry.cleanup_uncertain = true;
                return Err(error);
            }
        };
        if registry.runtimes.len() >= MAX_RETAINED_RUNTIMES {
            registry.prune_completed();
        }
        registry
            .runtimes
            .insert(info.id.clone(), Arc::clone(&runtime));
        let worker_name = format!("pty-{}", &info.id[..8]);
        if let Err(error) = thread::Builder::new().name(worker_name).spawn(move || {
            spawned.run(emit);
        }) {
            // The unstarted backend owns rollback of the child and I/O handles.
            registry.cleanup_uncertain = true;
            registry.runtimes.remove(&info.id);
            return Err(format!("Cannot start terminal supervisor: {error}"));
        }
        Ok(info)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let runtime = self.runtime(id)?;
        let mut control = lock(&runtime.control);
        if control.done || control.stop_requested || control.input_closed {
            return Err("The terminal is no longer accepting input".into());
        }
        if data.len() > MAX_INPUT_BYTES || control.input.len() + data.len() > MAX_INPUT_BYTES {
            return Err("Terminal input is busy; wait before pasting more text".into());
        }
        control.input.extend(data.as_bytes());
        runtime.changed.notify_all();
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        validate_size(cols, rows)?;
        let runtime = self.runtime(id)?;
        let master = lock(&runtime.master);
        let master = master.as_ref().ok_or("The terminal has exited")?;
        master
            .resize(pty_size(cols, rows))
            .map_err(|error| format!("Cannot resize terminal: {error}"))
    }

    pub fn ack(&self, id: &str, sequence: u64) -> Result<(), String> {
        let runtime = self.runtime(id)?;
        lock(&runtime.control).flow.acknowledge(sequence)?;
        runtime.changed.notify_all();
        Ok(())
    }

    pub fn stop(&self, id: &str) -> Result<(), String> {
        let runtime = self.runtime(id)?;
        runtime.request_stop();
        runtime.wait_stopped(Instant::now() + STOP_TIMEOUT)
    }

    pub fn list(&self) -> Vec<RuntimeInfo> {
        let mut infos: Vec<_> = lock(&self.registry)
            .runtimes
            .values()
            .map(|runtime| lock(&runtime.control).info.clone())
            .collect();
        infos.sort_by(|left, right| left.id.cmp(&right.id));
        infos
    }

    pub fn shutdown(&self) -> Result<(), String> {
        let runtimes: Vec<_> = {
            let mut registry = lock(&self.registry);
            registry.shutting_down = true;
            registry.runtimes.values().cloned().collect()
        };
        // Signal every worker first; shutdown is bounded once, not per pane.
        for runtime in &runtimes {
            runtime.request_stop();
        }
        let deadline = Instant::now() + STOP_TIMEOUT;
        let mut errors = Vec::new();
        for runtime in runtimes {
            if let Err(error) = runtime.wait_stopped(deadline) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    fn runtime(&self, id: &str) -> Result<Arc<Runtime>, String> {
        lock(&self.registry)
            .runtimes
            .get(id)
            .cloned()
            .ok_or_else(|| "Terminal not found".into())
    }
}

impl Drop for RuntimeManager {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        Err("Terminal dimensions must be between 1 and 1000".into())
    } else {
        Ok(())
    }
}

fn validate_spec(spec: &LaunchSpec) -> Result<(), String> {
    if spec.executable.is_empty() || spec.executable.contains('\0') {
        return Err("A valid executable is required".into());
    }
    #[cfg(windows)]
    if !crate::windows_fs::valid_filesystem_path(&spec.cwd) {
        return Err(
            "The Windows working directory must be an absolute, unambiguous filesystem path".into(),
        );
    }
    if spec.pane_id.is_empty() || spec.pane_id.len() > 256 {
        return Err("A valid pane ID is required".into());
    }
    if spec
        .session_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 1024)
    {
        return Err("Invalid session ID".into());
    }
    if spec
        .resume_key
        .as_ref()
        .is_some_and(|key| key.is_empty() || key.len() > 1024 || key.contains('\0'))
    {
        return Err("Invalid provider resume identity".into());
    }
    if spec.args.len() > 1024 || spec.args.iter().any(|arg| arg.contains('\0')) {
        return Err("Invalid executable arguments".into());
    }
    if spec.env.len() > 256
        || spec
            .env
            .iter()
            .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'))
    {
        return Err("Invalid environment variable".into());
    }
    #[cfg(windows)]
    validate_windows_environment(&spec.env)?;
    let bytes = spec.executable.len()
        + spec.args.iter().map(String::len).sum::<usize>()
        + spec
            .env
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>();
    if bytes > 1024 * 1024 {
        return Err("Launch configuration is too large".into());
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn validate_windows_environment(env: &HashMap<String, String>) -> Result<(), String> {
    let mut keys = std::collections::HashSet::new();
    // Match portable-pty 0.9 EnvEntry::map_key, including Unicode lowercase.
    // Otherwise HashMap iteration would choose a different override each run.
    if env.keys().any(|key| !keys.insert(key.to_lowercase())) {
        Err("Windows environment variable names must be unique ignoring case".into())
    } else {
        Ok(())
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn send(emit: &Emitter, event: TerminalEvent) -> Result<(), String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emit(event)))
        .unwrap_or_else(|_| Err("Terminal channel panicked".into()))
}

fn report_error(emit: &Emitter, id: &str, message: &str) {
    let _ = send(
        emit,
        TerminalEvent::Error {
            runtime_id: id.into(),
            message: message.into(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_environment_rejects_case_aliases_deterministically() {
        for (first, second) in [("PATH", "Path"), ("Ä_VAR", "ä_var")] {
            let env = HashMap::from([
                (first.to_string(), "first".into()),
                (second.to_string(), "second".into()),
            ]);
            assert!(validate_windows_environment(&env).is_err());
        }
        assert!(validate_windows_environment(&HashMap::from([
            ("PATH".into(), "one".into()),
            ("OTHER".into(), "two".into()),
        ]))
        .is_ok());
    }

    #[test]
    fn manager_and_handles_are_send_and_sync() {
        fn check<T: Send + Sync>() {}
        check::<RuntimeManager>();
        check::<Runtime>();
    }

    #[test]
    fn flow_control_is_byte_and_frame_bounded() {
        let mut flow = FlowControl::default();
        for _ in 0..MAX_IN_FLIGHT_BYTES / OUTPUT_CHUNK_BYTES {
            flow.reserve(OUTPUT_CHUNK_BYTES);
        }
        assert_eq!(flow.capacity(), 0);
        assert!(flow.acknowledge(flow.sent + 1).is_err());
        flow.acknowledge(1).unwrap();
        assert_eq!(flow.capacity(), OUTPUT_CHUNK_BYTES);
        flow.acknowledge(1).unwrap();
        assert_eq!(flow.capacity(), OUTPUT_CHUNK_BYTES);
        flow.acknowledge(flow.sent).unwrap();
        for _ in 0..MAX_IN_FLIGHT_CHUNKS {
            flow.reserve(1);
        }
        assert_eq!(flow.capacity(), 0);
        assert_eq!(flow.bytes, MAX_IN_FLIGHT_CHUNKS);
    }

    #[test]
    fn terminal_event_matches_ipc_case_and_raw_bytes() {
        let event = TerminalEvent::Output {
            runtime_id: "r1".into(),
            sequence: 1,
            data: vec![0xe4, 0xb8],
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"type":"output","runtimeId":"r1","sequence":1,"data":[228,184]})
        );
        assert_eq!(
            serde_json::from_value::<TerminalEvent>(value).unwrap(),
            event
        );
        let event = TerminalEvent::Exit {
            runtime_id: "r1".into(),
            exit_code: Some(7),
        };
        assert_eq!(serde_json::to_value(event).unwrap()["exitCode"], 7);
    }

    #[test]
    fn invalid_sizes_and_unknown_ids_are_errors() {
        let manager = RuntimeManager::new();
        assert!(validate_size(0, 24).is_err());
        assert!(validate_size(80, 1001).is_err());
        assert!(manager.write("missing", "hello").is_err());
        assert!(manager.resize("missing", 80, 24).is_err());
        assert!(manager.ack("missing", 1).is_err());
        assert!(manager.stop("missing").is_err());
    }
}
