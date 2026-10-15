//! Owned PTY runtimes for macOS and Linux.
//!
//! Only the worker owns/reaps the child. `waitid(WNOWAIT)` keeps its PID reserved
//! until cleanup is finished. Session authority is tied to that owned, waitable
//! child, not to getsid(leader), which cannot find zombies on Darwin.
//! All job-control groups in the new PTY session are cleaned up; processes that
//! deliberately daemonize into another session are outside this ownership scope.
//! Output stays as bytes and is sent by one worker, never through application UI
//! state. The frontend must ACK only after xterm's write callback has completed.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const MAX_IN_FLIGHT_BYTES: usize = 256 * 1024;
pub const MAX_IN_FLIGHT_CHUNKS: usize = 64;
pub const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
pub const MAX_INPUT_BYTES: usize = 256 * 1024;
const MAX_ACTIVE_RUNTIMES: usize = 32;
const MAX_RETAINED_RUNTIMES: usize = 256;
const TICK: Duration = Duration::from_millis(20);
const TERM_AFTER: Duration = Duration::from_millis(200);
const KILL_AFTER: Duration = Duration::from_millis(600);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
const ACK_TIMEOUT: Duration = Duration::from_secs(30);
const SESSION_VERIFY_RETRIES: usize = 50;
const SESSION_VERIFY_RETRY_DELAY: Duration = Duration::from_millis(2);

type Emitter = Arc<dyn Fn(TerminalEvent) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Debug)]
pub struct LaunchSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub session_id: Option<String>,
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
    flow: FlowControl,
    input: VecDeque<u8>,
    stop_requested: bool,
    input_closed: bool,
    cleanup_error: Option<String>,
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
}

#[derive(Default)]
pub struct RuntimeManager {
    registry: Mutex<Registry>,
}

impl RuntimeManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn launch(
        &self,
        mut spec: LaunchSpec,
        cols: u16,
        rows: u16,
        emit: Emitter,
    ) -> Result<RuntimeInfo, String> {
        // Hold this lock through registration to make duplicate-session launches
        // atomic, including concurrent double clicks and shutdown races.
        let mut registry = lock(&self.registry);
        if registry.shutting_down {
            return Err("The application is shutting down".into());
        }
        if let Some(session_id) = spec.session_id.as_ref() {
            for runtime in registry.runtimes.values() {
                let control = lock(&runtime.control);
                if !control.done && control.info.session_id.as_ref() == Some(session_id) {
                    return Ok(control.info.clone());
                }
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
        if !cfg!(any(target_os = "linux", target_os = "macos")) {
            return Err("PTY lifecycle management currently supports macOS and Linux".into());
        }
        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|error| format!("Cannot create terminal: {error}"))?;
        let fd = pair
            .master
            .as_raw_fd()
            .ok_or("The terminal does not expose a Unix PTY")?;
        make_nonblocking(fd).map_err(|error| format!("Cannot configure terminal: {error}"))?;
        // Create fallible I/O handles before spawning any process.
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Cannot read terminal: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Cannot write terminal: {error}"))?;
        let mut command = CommandBuilder::new(&spec.executable);
        command.args(&spec.args);
        command.cwd(&spec.cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Cannot start {}: {error}", spec.executable))?;
        drop(pair.slave);
        let mut owned = OwnedChild::new(child)?;
        // This constructor is reached only after portable-pty's successful
        // setsid-before-exec spawn. A fast command may already be a zombie here.
        owned.verify_pty_session().map_err(|error| {
            format!("The child did not establish its own terminal session: {error}")
        })?;
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
                flow: FlowControl::default(),
                input: VecDeque::new(),
                stop_requested: false,
                input_closed: false,
                cleanup_error: None,
                done: false,
            }),
            changed: Condvar::new(),
            master: Mutex::new(Some(pair.master)),
        });
        if registry.runtimes.len() >= MAX_RETAINED_RUNTIMES {
            registry
                .runtimes
                .retain(|_, runtime| !lock(&runtime.control).done);
        }
        registry
            .runtimes
            .insert(info.id.clone(), Arc::clone(&runtime));
        let worker_runtime = Arc::clone(&runtime);
        let worker_name = format!("pty-{}", &info.id[..8]);
        if let Err(error) = thread::Builder::new().name(worker_name).spawn(move || {
            run_worker(worker_runtime, owned, reader, writer, fd, emit);
        }) {
            // Dropping the unstarted closure drops OwnedChild, killing/reaping it.
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

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn make_nonblocking(fd: libc::c_int) -> io::Result<()> {
    // All duplicated PTY handles share the nonblocking open-file description.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

struct OwnedChild {
    child: Box<dyn Child + Send + Sync>,
    pid: libc::pid_t,
    isolated: bool,
    reaped: bool,
}

impl OwnedChild {
    // Only call after a successful portable-pty Unix spawn, whose pre_exec
    // fails the spawn if setsid fails. No arbitrary external PID enters here.
    // https://docs.rs/portable-pty/0.9.0/src/portable_pty/unix.rs.html#229-298
    fn verify_pty_session(&mut self) -> io::Result<()> {
        verify_spawned_session_with_retry(
            self.pid,
            || (session_id(self.pid), child_has_exited(self.pid)),
            || thread::sleep(SESSION_VERIFY_RETRY_DELAY),
        )?;
        self.isolated = true;
        Ok(())
    }

    fn verified_session(&self) -> io::Result<libc::pid_t> {
        if !self.isolated || self.reaped || self.pid <= 1 {
            return Err(io::Error::other(
                "terminal session ownership is no longer held",
            ));
        }
        // WNOWAIT succeeds for both a live owned child and its unreaped zombie.
        // ECHILD means ownership was lost: fail closed, never signal that PID.
        child_has_exited(self.pid)?;
        Ok(self.pid)
    }

    fn new(mut child: Box<dyn Child + Send + Sync>) -> Result<Self, String> {
        match child
            .process_id()
            .and_then(|pid| i32::try_from(pid).ok())
            .filter(|pid| *pid > 1)
        {
            Some(pid) => Ok(Self {
                child,
                pid,
                isolated: false,
                reaped: false,
            }),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                Err("The child process did not provide a valid process ID".into())
            }
        }
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !self.reaped && child_has_exited(self.pid).is_ok() {
            if self.isolated {
                let _ = signal_owned_session(self, libc::SIGKILL);
            }
            // waitid just confirmed this exact child is still ours/unreaped.
            let _ = unsafe { libc::kill(self.pid, libc::SIGKILL) };
            let _ = self.child.wait();
        }
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

fn run_worker(
    runtime: Arc<Runtime>,
    mut owned: OwnedChild,
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
    fd: libc::c_int,
    emit: Emitter,
) {
    let id = lock(&runtime.control).info.id.clone();
    let mut buffer = [0_u8; OUTPUT_CHUNK_BYTES];
    let mut eof = false;
    let mut exited = false;
    let mut exit_code = None;
    let mut cleanup: Option<(Instant, u8)> = None;
    let mut blocked_since = None;
    let mut failed = false;
    let mut wait_failed = false;
    loop {
        let stopping = lock(&runtime.control).stop_requested;
        if !exited && !wait_failed {
            match child_has_exited(owned.pid) {
                Ok(true) => {
                    exited = true;
                    let mut control = lock(&runtime.control);
                    control.input_closed = true;
                    control.input.clear();
                }
                Ok(false) => {}
                Err(error) => {
                    failed = true;
                    if error.raw_os_error() == Some(libc::ECHILD) {
                        // Another component reaped this child. Never signal a
                        // PID whose ownership we can no longer establish.
                        owned.reaped = true;
                        lock(&runtime.control).cleanup_error =
                            Some("Child ownership was lost; cleanup could not be verified".into());
                        report_error(
                            &emit,
                            &id,
                            "Child ownership was lost before its exit could be collected",
                        );
                        break;
                    }
                    wait_failed = true;
                    report_error(&emit, &id, &format!("Cannot observe child exit: {error}"));
                    runtime.request_stop();
                }
            }
        }
        if (stopping || exited || wait_failed) && cleanup.is_none() {
            if let Err(error) = signal_owned_session(&owned, libc::SIGHUP) {
                report_error(
                    &emit,
                    &id,
                    &format!("Could not signal all terminal jobs: {error}"),
                );
                failed = true;
                lock(&runtime.control).cleanup_error =
                    Some(format!("Could not signal all terminal jobs: {error}"));
            }
            let _ = signal_owned_session(&owned, libc::SIGCONT);
            cleanup = Some((Instant::now(), 0));
        }
        if let Some((started, stage)) = cleanup.as_mut() {
            if !owned.reaped && started.elapsed() >= TERM_AFTER && *stage == 0 {
                if let Err(error) = signal_owned_session(&owned, libc::SIGTERM) {
                    lock(&runtime.control).cleanup_error =
                        Some(format!("Could not terminate all terminal jobs: {error}"));
                    failed = true;
                }
                *stage = 1;
            }
            if !owned.reaped && started.elapsed() >= KILL_AFTER && *stage >= 1 {
                if let Err(error) = signal_owned_session(&owned, libc::SIGKILL) {
                    lock(&runtime.control).cleanup_error =
                        Some(format!("Could not kill all terminal jobs: {error}"));
                    failed = true;
                }
                *stage = 2;
            }
            // Keep the leader unreaped until the final group signal. In the
            // usual no-descendant case there is no reason to wait the grace.
            let no_descendants = !owned.reaped
                && exited
                && owned_session_has_live_descendants(&owned).is_ok_and(|alive| !alive);
            if !owned.reaped && ((exited && no_descendants) || wait_failed) {
                if wait_failed {
                    let _ = signal_owned_session(&owned, libc::SIGKILL);
                }
                match owned.child.wait() {
                    Ok(status) => {
                        exit_code = if status.signal().is_some() {
                            None
                        } else {
                            i32::try_from(status.exit_code()).ok()
                        };
                    }
                    Err(error) => {
                        failed = true;
                        report_error(
                            &emit,
                            &id,
                            &format!("Cannot collect child exit status: {error}"),
                        );
                    }
                }
                owned.reaped = true;
                exited = true;
                let mut control = lock(&runtime.control);
                control.info.exit_code = exit_code;
                control.input.clear();
            }
            if owned.reaped && stopping {
                break;
            }
        }

        let capacity = lock(&runtime.control).flow.capacity();
        let mut progressed = false;
        if !eof && !stopping && capacity > 0 {
            blocked_since = None;
            match reader.read(&mut buffer[..capacity]) {
                Ok(0) => eof = true,
                Ok(count) => {
                    let sequence = lock(&runtime.control).flow.reserve(count);
                    if let Err(error) = send(
                        &emit,
                        TerminalEvent::Output {
                            runtime_id: id.clone(),
                            sequence,
                            data: buffer[..count].to_vec(),
                        },
                    ) {
                        failed = true;
                        report_error(
                            &emit,
                            &id,
                            &format!("Terminal output channel disconnected: {error}"),
                        );
                        runtime.request_stop();
                    }
                    progressed = true;
                }
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.raw_os_error() == Some(libc::EIO) => eof = true,
                Err(error) => {
                    failed = true;
                    report_error(&emit, &id, &format!("Cannot read terminal output: {error}"));
                    runtime.request_stop();
                }
            }
        } else if !stopping && capacity == 0 {
            let started = blocked_since.get_or_insert_with(Instant::now);
            if started.elapsed() >= ACK_TIMEOUT {
                failed = true;
                report_error(&emit, &id, "Terminal rendering stopped acknowledging output; the process was stopped to keep memory bounded");
                runtime.request_stop();
            }
        }
        if owned.reaped && eof {
            let control = lock(&runtime.control);
            if control.flow.pending.is_empty() || control.stop_requested {
                break;
            }
            // Natural exits wait for xterm to consume the last accepted bytes.
            // A detached/unresponsive frontend must not hold this state forever.
            let started = blocked_since.get_or_insert_with(Instant::now);
            if started.elapsed() >= ACK_TIMEOUT {
                drop(control);
                failed = true;
                report_error(&emit, &id, "The process exited, but terminal rendering did not acknowledge its final output");
                runtime.request_stop();
            } else {
                let _ = runtime
                    .changed
                    .wait_timeout(control, TICK)
                    .unwrap_or_else(|poison| poison.into_inner());
            }
            continue;
        }
        if !exited && !stopping {
            let input: Vec<u8> = lock(&runtime.control)
                .input
                .iter()
                .take(OUTPUT_CHUNK_BYTES)
                .copied()
                .collect();
            if !input.is_empty() {
                match writer.write(&input) {
                    Ok(0) => {
                        failed = true;
                        report_error(&emit, &id, "Terminal input stream closed");
                        runtime.request_stop();
                    }
                    Ok(count) => {
                        let mut control = lock(&runtime.control);
                        // request_stop may have cleared the queue while write ran.
                        let remove = count.min(control.input.len());
                        control.input.drain(..remove);
                        progressed = true;
                    }
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            || error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) => {
                        failed = true;
                        report_error(&emit, &id, &format!("Cannot write terminal input: {error}"));
                        runtime.request_stop();
                    }
                }
            }
        }
        if !progressed {
            // Timed waits also observe child exit without a blocking wait thread.
            // Never poll readable bytes while output is backpressured.
            let control = lock(&runtime.control);
            let events = if !eof && control.flow.capacity() > 0 && !control.stop_requested {
                libc::POLLIN
            } else {
                0
            } | if !control.input.is_empty() && !exited && !control.stop_requested {
                libc::POLLOUT
            } else {
                0
            };
            if events == 0 {
                let _ = runtime
                    .changed
                    .wait_timeout(control, TICK)
                    .unwrap_or_else(|poison| poison.into_inner());
            } else {
                drop(control);
                let mut pollfd = libc::pollfd {
                    fd,
                    events,
                    revents: 0,
                };
                unsafe {
                    libc::poll(&mut pollfd, 1, TICK.as_millis() as i32);
                }
            }
        }
    }
    // One ordered producer: all accepted Output events precede Exit.
    drop(reader);
    drop(writer);
    lock(&runtime.master).take();
    {
        let mut control = lock(&runtime.control);
        control.info.state = if failed { "failed" } else { "exited" }.into();
        control.info.exit_code = exit_code;
        control.input_closed = true;
        control.input.clear();
    }
    let _ = send(
        &emit,
        TerminalEvent::Exit {
            runtime_id: id,
            exit_code,
        },
    );
    lock(&runtime.control).done = true;
    runtime.changed.notify_all();
}

fn child_has_exited(pid: libc::pid_t) -> io::Result<bool> {
    // WNOWAIT deliberately does not release the child PID before group cleanup.
    // EINTR is not ownership evidence; retry instead of treating it as alive.
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        #[cfg(target_os = "linux")]
        let observed = unsafe { info.si_pid() };
        #[cfg(target_os = "macos")]
        let observed = info.si_pid;
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let observed = 0;
        return Ok(observed == pid);
    }
}

fn session_id(pid: libc::pid_t) -> io::Result<libc::pid_t> {
    let session = unsafe { libc::getsid(pid) };
    if session < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(session)
    }
}

fn verify_spawned_session_with_retry(
    pid: libc::pid_t,
    mut observe: impl FnMut() -> (io::Result<libc::pid_t>, io::Result<bool>),
    mut retry_delay: impl FnMut(),
) -> io::Result<()> {
    for attempt in 0..=SESSION_VERIFY_RETRIES {
        let (session, exited) = observe();
        // XNU proc_refdrain removes a dying process from getsid's proc_find
        // before exit marks it SZOMB for waitid. The child is still ours, but
        // cannot yet authorize the zombie fallback. Retry only that transient
        // pair, for at most 100 ms of scheduled delay; never infer isolation
        // from a timeout, lost ownership, mismatched SID, or another error.
        let transitioning = session
            .as_ref()
            .is_err_and(|error| error.raw_os_error() == Some(libc::ESRCH))
            && matches!(exited, Ok(false));
        if transitioning && attempt < SESSION_VERIFY_RETRIES {
            retry_delay();
            continue;
        }
        return verify_spawned_session(pid, session, exited);
    }
    unreachable!("the final verification attempt always returns")
}

fn verify_spawned_session(
    pid: libc::pid_t,
    observed_session: io::Result<libc::pid_t>,
    owned_child_exited: io::Result<bool>,
) -> io::Result<()> {
    if pid <= 1 {
        return Err(io::Error::other("invalid child process ID"));
    }
    let exited = owned_child_exited?;
    match observed_session {
        Ok(session) if session == pid => Ok(()),
        // A successful portable-pty spawn already proved setsid succeeded.
        // Accept missing metadata only for our confirmed unreaped zombie,
        // never a live unverified process or an arbitrary missing PID.
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) && exited => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(io::Error::other("child is not its terminal session leader")),
    }
}

fn owned_session_members(session: libc::pid_t) -> io::Result<Vec<libc::pid_t>> {
    let mut members = Vec::new();
    for pid in process_ids()?.into_iter().filter(|pid| *pid > 1) {
        match session_id(pid) {
            Ok(observed) if observed == session => members.push(pid),
            Ok(_) => {}
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(members)
}

fn process_group_id(pid: libc::pid_t) -> io::Result<libc::pid_t> {
    let group = unsafe { libc::getpgid(pid) };
    if group < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(group)
    }
}

fn owned_group_has_live_members(owned: &OwnedChild, group: libc::pid_t) -> io::Result<bool> {
    let session = owned.verified_session()?;
    for pid in owned_session_members(session)? {
        let membership = || -> io::Result<bool> {
            // Recheck identity after the process status lookup: the observed
            // member may have exited, changed groups, or detached its session.
            Ok(process_group_id(pid)? == group
                && process_is_live(pid)?
                && session_id(pid)? == session
                && process_group_id(pid)? == group)
        };
        match membership() {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(false)
}

fn signal_group_if_live(
    mut has_live_members: impl FnMut() -> io::Result<bool>,
    signal: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    if !has_live_members()? {
        return Ok(());
    }
    match signal() {
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(()),
        // Darwin killpg1 excludes SZOMB, then returns POSIX EPERM if no
        // eligible member remains (XNU bsd/kern/kern_sig.c). Close the race
        // where the last live member exits after our check. Never hide a
        // genuine permission failure: a fresh, complete scan must prove no
        // live owned member remains; lookup/ownership errors also propagate.
        Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
            if has_live_members()? {
                Err(error)
            } else {
                Ok(())
            }
        }
        result => result,
    }
}

fn owned_session_has_live_descendants(owned: &OwnedChild) -> io::Result<bool> {
    let session = owned.verified_session()?;
    for pid in owned_session_members(session)? {
        if pid != session && process_is_live(pid)? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn process_is_live(pid: libc::pid_t) -> io::Result<bool> {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => {
            // The comm field can itself contain spaces and parentheses.
            let state = stat
                .rsplit_once(')')
                .and_then(|(_, tail)| tail.split_whitespace().next());
            match state {
                Some("Z" | "X") => Ok(false),
                Some(_) => Ok(true),
                None => Err(io::Error::other("invalid owned process status")),
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "macos")]
fn process_is_live(pid: libc::pid_t) -> io::Result<bool> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let result = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if result == size {
        // SZOMB from Darwin's sys/proc.h. Zombies consume no execution resources
        // and only their actual parent (or launchd) can collect their status.
        Ok(info.pbi_status != 5)
    } else {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(false)
        } else {
            Err(error)
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_is_live(_pid: libc::pid_t) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Unsupported operating system",
    ))
}

fn signal_owned_session(owned: &OwnedChild, signal: libc::c_int) -> io::Result<()> {
    // Darwin getsid uses proc_find and returns ESRCH for an unreaped zombie.
    // XNU: bsd/kern/kern_prot.c getsid; kern_proc.c proc_find_ident_validated;
    // kern_exit.c waitid retains the child when WNOWAIT is specified.
    // The reservation established by the owned child is the authority here;
    // descendants still need a live getsid/getpgid membership check below.
    let session = owned.verified_session()?;
    let own_group = unsafe { libc::getpgrp() };
    let members = owned_session_members(session);
    let mut groups = HashSet::from([session]);
    let mut first_error = None;
    if let Ok(members) = &members {
        for pid in members {
            match process_group_id(*pid) {
                Ok(group) if group > 1 && group != own_group => {
                    groups.insert(group);
                }
                Ok(_) => {}
                Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
    }
    for group in groups {
        if group <= 1 || group == own_group {
            continue;
        }
        let result = signal_group_if_live(
            || owned_group_has_live_members(owned, group),
            || {
                if unsafe { libc::kill(-group, signal) } < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            },
        );
        if let Err(error) = result {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    match first_error.or_else(|| members.err()) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(target_os = "linux")]
fn process_ids() -> io::Result<Vec<libc::pid_t>> {
    let mut pids = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        // An incomplete process table cannot prove that a group is empty.
        let name = entry?.file_name();
        if let Some(pid) = name.to_str().and_then(|name| name.parse().ok()) {
            pids.push(pid);
        }
    }
    Ok(pids)
}

#[cfg(target_os = "macos")]
fn process_ids() -> io::Result<Vec<libc::pid_t>> {
    let estimate = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if estimate <= 0 {
        return Err(io::Error::last_os_error());
    }
    let mut capacity = (estimate as usize + 64).max(256);
    loop {
        let mut pids = vec![0 as libc::pid_t; capacity];
        let bytes = capacity
            .checked_mul(std::mem::size_of::<libc::pid_t>())
            .and_then(|bytes| i32::try_from(bytes).ok())
            .ok_or_else(|| io::Error::other("process table is too large"))?;
        let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if count <= 0 {
            return Err(io::Error::last_os_error());
        }
        if (count as usize) < capacity {
            pids.truncate(count as usize);
            return Ok(pids);
        }
        capacity *= 2;
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_ids() -> io::Result<Vec<libc::pid_t>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Unsupported operating system",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_session_metadata_requires_a_confirmed_owned_zombie() {
        let missing = || Err(io::Error::from_raw_os_error(libc::ESRCH));
        let no_child = || Err(io::Error::from_raw_os_error(libc::ECHILD));
        assert!(verify_spawned_session(42, missing(), Ok(true)).is_ok());
        assert!(verify_spawned_session(42, missing(), Ok(false)).is_err());
        assert!(verify_spawned_session(42, missing(), no_child()).is_err());
        assert!(verify_spawned_session(42, Ok(42), no_child()).is_err());
        assert!(verify_spawned_session(42, Ok(43), Ok(false)).is_err());
        assert!(verify_spawned_session(42, Ok(43), Ok(true)).is_err());
        assert!(verify_spawned_session(
            42,
            Err(io::Error::from_raw_os_error(libc::EPERM)),
            Ok(true)
        )
        .is_err());
        assert!(verify_spawned_session(1, Ok(1), Ok(true)).is_err());
        assert!(verify_spawned_session(42, Ok(42), Ok(false)).is_ok());
    }

    #[test]
    fn session_verification_retries_until_identity_is_confirmed() {
        let missing = || Err(io::Error::from_raw_os_error(libc::ESRCH));
        for terminal in [(missing(), Ok(true)), (Ok(42), Ok(false))] {
            let mut terminal = Some(terminal);
            let mut observations = 0;
            let mut pauses = 0;
            verify_spawned_session_with_retry(
                42,
                || {
                    observations += 1;
                    if observations < 3 {
                        (missing(), Ok(false))
                    } else {
                        terminal
                            .take()
                            .expect("must finish after identity is confirmed")
                    }
                },
                || pauses += 1,
            )
            .unwrap();
            assert_eq!(observations, 3);
            assert_eq!(pauses, 2);
        }
    }

    #[test]
    fn session_verification_retry_exhaustion_fails_closed() {
        let mut observations = 0;
        let mut pauses = 0;
        let error = verify_spawned_session_with_retry(
            42,
            || {
                observations += 1;
                (Err(io::Error::from_raw_os_error(libc::ESRCH)), Ok(false))
            },
            || pauses += 1,
        )
        .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ESRCH));
        assert_eq!(observations, SESSION_VERIFY_RETRIES + 1);
        assert_eq!(pauses, SESSION_VERIFY_RETRIES);
    }

    #[test]
    fn session_verification_retry_stops_on_ownership_loss_or_invalid_identity() {
        let missing = || Err(io::Error::from_raw_os_error(libc::ESRCH));
        let no_child = || Err(io::Error::from_raw_os_error(libc::ECHILD));
        for terminal in [
            (missing(), no_child()),
            (Ok(42), no_child()),
            (Ok(43), Ok(false)),
            (Ok(43), Ok(true)),
            (Err(io::Error::from_raw_os_error(libc::EPERM)), Ok(false)),
            (Err(io::Error::from_raw_os_error(libc::EPERM)), Ok(true)),
        ] {
            let mut terminal = Some(terminal);
            let mut observations = 0;
            let mut pauses = 0;
            assert!(verify_spawned_session_with_retry(
                42,
                || {
                    observations += 1;
                    if observations == 1 {
                        (missing(), Ok(false))
                    } else {
                        terminal.take().expect("must not retry a terminal error")
                    }
                },
                || pauses += 1,
            )
            .is_err());
            assert_eq!(observations, 2);
            assert_eq!(pauses, 1);
        }
    }

    #[test]
    fn empty_or_zombie_only_group_is_not_signalled() {
        signal_group_if_live(|| Ok(false), || panic!("must not signal an empty group")).unwrap();
    }

    #[test]
    fn group_signal_permission_error_requires_fresh_proof_of_no_live_members() {
        for still_live in [false, true] {
            let mut checks = 0;
            let result = signal_group_if_live(
                || {
                    checks += 1;
                    Ok(checks == 1 || still_live)
                },
                || Err(io::Error::from_raw_os_error(libc::EPERM)),
            );
            assert_eq!(checks, 2);
            if still_live {
                assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EPERM));
            } else {
                result.unwrap();
            }
        }
    }

    #[test]
    fn group_signal_never_treats_unknown_membership_as_empty() {
        for errno in [libc::EPERM, libc::EIO, libc::ECHILD] {
            let error = signal_group_if_live(
                || Err(io::Error::from_raw_os_error(errno)),
                || panic!("must not signal without a live owned member"),
            )
            .unwrap_err();
            assert_eq!(error.raw_os_error(), Some(errno));
            let mut checks = 0;
            let error = signal_group_if_live(
                || {
                    checks += 1;
                    if checks == 1 {
                        Ok(true)
                    } else {
                        Err(io::Error::from_raw_os_error(errno))
                    }
                },
                || Err(io::Error::from_raw_os_error(libc::EPERM)),
            )
            .unwrap_err();
            assert_eq!(checks, 2);
            assert_eq!(error.raw_os_error(), Some(errno));
        }
    }

    #[test]
    fn group_signal_only_normalizes_disappearance_or_proven_empty_eperm() {
        signal_group_if_live(
            || Ok(true),
            || Err(io::Error::from_raw_os_error(libc::ESRCH)),
        )
        .unwrap();
        let mut checks = 0;
        let error = signal_group_if_live(
            || {
                checks += 1;
                Ok(true)
            },
            || Err(io::Error::from_raw_os_error(libc::EIO)),
        )
        .unwrap_err();
        assert_eq!(checks, 1);
        assert_eq!(error.raw_os_error(), Some(libc::EIO));
    }

    fn exited_pty_child() -> (OwnedChild, Box<dyn MasterPty + Send>) {
        let pair = native_pty_system().openpty(pty_size(80, 24)).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "exit 17"]);
        let owned = OwnedChild::new(pair.slave.spawn_command(command).unwrap()).unwrap();
        drop(pair.slave);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !child_has_exited(owned.pid).unwrap() {
            assert!(Instant::now() < deadline, "child did not exit");
            thread::sleep(Duration::from_millis(1));
        }
        (owned, pair.master)
    }

    #[test]
    fn zombie_leader_retains_session_authority_only_until_reaped() {
        // Deliberately defer the first identity check until the leader is a
        // zombie. On Darwin getsid now returns ESRCH, but WNOWAIT still proves
        // ownership and reserves its original session/group number.
        let (mut owned, _master) = exited_pty_child();
        owned.verify_pty_session().unwrap();
        assert_eq!(owned.verified_session().unwrap(), owned.pid);
        signal_owned_session(&owned, libc::SIGHUP).unwrap();
        assert!(!owned_session_has_live_descendants(&owned).unwrap());
        assert_eq!(owned.child.wait().unwrap().exit_code(), 17);
        owned.reaped = true;
        assert!(owned.verified_session().is_err());
        assert!(signal_owned_session(&owned, libc::SIGTERM).is_err());
    }

    #[test]
    fn unexpectedly_reaped_child_cannot_authorize_any_group_signal() {
        let (mut owned, _master) = exited_pty_child();
        owned.verify_pty_session().unwrap();
        // Simulate another component collecting the child without updating the
        // runtime flag. The fresh WNOWAIT guard must reject its stale identity.
        owned.child.wait().unwrap();
        assert!(!owned.reaped);
        let error = signal_owned_session(&owned, libc::SIGTERM).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ECHILD));
        // Drop must also skip all signals once waitid no longer proves ownership.
    }

    #[test]
    fn live_nonisolated_child_cannot_authorize_group_cleanup() {
        let child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let mut owned = OwnedChild::new(Box::new(child)).unwrap();
        assert!(owned.verify_pty_session().is_err());
        assert!(signal_owned_session(&owned, libc::SIGTERM).is_err());
        assert!(owned.child.try_wait().unwrap().is_none());
        // Drop can terminate this exact owned child, but never our process group.
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
