//! ConPTY has synchronous pipes: reads, writes, supervision and console closure
//! must be independent. In particular ClosePseudoConsole can wait for output to
//! drain on Windows 10. The reader keeps draining during Stop, without ACKs.
//!
//! Ownership is the original child HANDLE plus the ConPTY session. Closing the
//! latter cleans up attached console descendants. Deliberately detached/new-
//! console processes, like Unix processes escaping with setsid, are not owned.
//! We never discover, reopen, or terminate processes by a reusable PID.
use super::*;
use portable_pty::{native_pty_system, Child, SlavePty};
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, RawHandle};
use std::sync::OnceLock;
use std::thread::JoinHandle;
use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_OPERATION_ABORTED, WAIT_FAILED, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::System::LibraryLoader::{
    SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_APPLICATION_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, TerminateProcess, WaitForSingleObject,
};
use windows_sys::Win32::System::IO::CancelSynchronousIo;

const KILL_AFTER: Duration = Duration::from_millis(600);
const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";

fn ensure_safe_dll_search() -> Result<(), String> {
    static POLICY: OnceLock<Result<(), String>> = OnceLock::new();
    POLICY
        .get_or_init(|| {
            // portable-pty 0.9 loads bare "conpty.dll" via LoadLibraryW before
            // falling back to kernel32. Never search an untrusted CWD or PATH.
            // Keep the installed application directory for packaged dependencies.
            // This policy is local to Session Bay's process, not a system setting.
            // https://learn.microsoft.com/windows/win32/api/libloaderapi/nf-libloaderapi-setdefaultdlldirectories
            apply_dll_search_policy(|flags| {
                if unsafe { SetDefaultDllDirectories(flags) } == 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            })
        })
        .clone()
}

fn apply_dll_search_policy(set_default: impl FnOnce(u32) -> io::Result<()>) -> Result<(), String> {
    set_default(LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)
        .map_err(|error| format!("Cannot secure ConPTY DLL loading: {error}"))
}

#[derive(Default)]
struct PipeState {
    output: VecDeque<Vec<u8>>,
    output_bytes: usize,
    discard: bool,
    close_requested: bool,
    close_done: bool,
    reader_done: bool,
    writer_done: bool,
    cursor_reply_pending: bool,
    cursor_reply_active: bool,
    cursor_ready: bool,
    read_error: Option<String>,
    write_error: Option<String>,
}

#[derive(Default)]
struct Pipes {
    state: Mutex<PipeState>,
    changed: Condvar,
}

impl Pipes {
    fn request_close(&self, discard: bool) {
        let mut state = lock(&self.state);
        state.close_requested = true;
        state.discard |= discard;
        if state.discard {
            state.output.clear();
            state.output_bytes = 0;
        }
        self.changed.notify_all();
    }
}

struct OwnedChild {
    // portable-pty retains the original CreateProcessW handle for this object's
    // full lifetime. Borrow only while this owner is alive; never OpenProcess.
    child: Box<dyn Child + Send + Sync>,
    collected: bool,
    termination_requested: bool,
}

impl OwnedChild {
    fn handle(&self) -> io::Result<RawHandle> {
        self.child
            .as_raw_handle()
            .filter(|handle| !handle.is_null())
            .ok_or_else(|| io::Error::other("the child has no process handle"))
    }

    fn poll(&mut self) -> io::Result<Option<i32>> {
        let handle = self.handle()?;
        // portable-pty 0.9's WinChild::try_wait confuses exit code 259 with
        // STILL_ACTIVE and hides API failures. Check the process object first.
        match unsafe { WaitForSingleObject(handle, 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(handle, &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                self.collected = true;
                // Preserve all 32 exit-status bits, including NTSTATUS values.
                Ok(Some(code as i32))
            }
            WAIT_FAILED => Err(io::Error::last_os_error()),
            _ => Err(io::Error::other("unexpected process wait result")),
        }
    }

    fn terminate(&mut self) -> io::Result<()> {
        if self.collected || self.termination_requested || self.poll()?.is_some() {
            return Ok(());
        }
        // Do not use portable-pty 0.9's kill(), which swallows API failures.
        if unsafe { TerminateProcess(self.handle()?, 1) } == 0 {
            let error = io::Error::last_os_error();
            // A process may have exited between the poll and TerminateProcess.
            if self.poll()?.is_none() {
                return Err(error);
            }
        } else {
            // Termination is asynchronous. Repeating it before the process
            // handle signals can return ACCESS_DENIED for an already dying
            // process and incorrectly report a successful Stop as failed.
            self.termination_requested = true;
        }
        Ok(())
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !self.collected {
            let _ = self.terminate();
        }
        // Windows does not need a POSIX reap. The handle remains owned until
        // after termination was requested and closes with the portable child.
    }
}

pub(super) struct Spawned {
    runtime: Arc<Runtime>,
    pipes: Arc<Pipes>,
    child: Option<OwnedChild>,
    slave: Option<Box<dyn SlavePty + Send>>,
    reader: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<()>>,
    closer: Option<JoinHandle<()>>,
    completed: bool,
}

pub(super) fn spawn(
    runtime: Arc<Runtime>,
    command: CommandBuilder,
    size: PtySize,
) -> Result<Spawned, String> {
    // No shell fallback: CreateProcess receives a separately quoted argv. Batch
    // shims require cmd.exe's different quoting rules and are rejected upstream
    // and here for direct RuntimeManager callers.
    let executable = command
        .get_argv()
        .first()
        .ok_or("A valid executable is required")?;
    let executable = std::path::Path::new(executable);
    if executable.extension().is_some() && !crate::config::is_windows_native_executable(executable)
    {
        return Err("Windows script shims (.cmd/.bat/.ps1) cannot be launched safely; select the native .exe executable".into());
    }
    let executable_path = if executable.is_absolute() {
        executable.to_path_buf()
    } else {
        std::path::Path::new(command.get_cwd().ok_or("A working directory is required")?)
            .join(executable)
    };
    if !crate::windows_fs::valid_filesystem_path(&executable_path) {
        return Err("The Windows executable path contains a device, alternate data stream, or ambiguous name".into());
    }
    ensure_safe_dll_search()?;
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| format!("Cannot create ConPTY terminal: {error}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Cannot read terminal: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Cannot write terminal: {error}"))?;
    *lock(&runtime.master) = Some(pair.master);
    let pipes = Arc::new(Pipes::default());
    let mut spawned = Spawned {
        runtime: Arc::clone(&runtime),
        pipes: Arc::clone(&pipes),
        child: None,
        slave: Some(pair.slave),
        reader: None,
        writer: None,
        closer: None,
        completed: false,
    };
    // Create all fallible thread resources BEFORE spawning the process. The
    // rollback guard always enables discard/drain before console destruction.
    let reader_runtime = Arc::clone(&runtime);
    let reader_pipes = Arc::clone(&pipes);
    spawned.reader = Some(
        thread::Builder::new()
            .name("conpty-read".into())
            .spawn(move || read_pipe(reader_runtime, reader_pipes, reader))
            .map_err(|error| format!("Cannot start terminal reader: {error}"))?,
    );
    let writer_runtime = Arc::clone(&runtime);
    let writer_pipes = Arc::clone(&pipes);
    spawned.writer = Some(
        thread::Builder::new()
            .name("conpty-write".into())
            .spawn(move || write_pipe(writer_runtime, writer_pipes, writer))
            .map_err(|error| format!("Cannot start terminal writer: {error}"))?,
    );
    let closer_runtime = Arc::clone(&runtime);
    let closer_pipes = Arc::clone(&pipes);
    spawned.closer = Some(
        thread::Builder::new()
            .name("conpty-close".into())
            .spawn(move || {
                let mut state = lock(&closer_pipes.state);
                while !state.close_requested {
                    state = closer_pipes
                        .changed
                        .wait(state)
                        .unwrap_or_else(|poison| poison.into_inner());
                }
                drop(state);
                // Never hold either shared state lock during ClosePseudoConsole.
                // The reader must continue, and the writer may need to answer
                // portable-pty's initial INHERIT_CURSOR query during shutdown.
                let master = lock(&closer_runtime.master).take();
                drop(master);
                lock(&closer_pipes.state).close_done = true;
                closer_pipes.changed.notify_all();
                closer_runtime.changed.notify_all();
            })
            .map_err(|error| format!("Cannot start terminal closer: {error}"))?,
    );
    let child = spawned
        .slave
        .as_ref()
        .expect("slave is held through spawn")
        .spawn_command(command)
        .map_err(|error| format!("Cannot start terminal process: {error}"))?;
    spawned.child = Some(OwnedChild {
        child,
        collected: false,
        termination_requested: false,
    });
    // The slave shares ConPTY ownership with the master. It must be dropped
    // before requesting closure, otherwise dropping the master cannot close it.
    spawned.slave.take();
    spawned
        .child
        .as_ref()
        .expect("just spawned")
        .handle()
        .map_err(|error| format!("Cannot own terminal process: {error}"))?;
    Ok(spawned)
}

impl Drop for Spawned {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        // Release the slave first on every failure path. Otherwise the close
        // worker could drop the master without actually closing the console.
        self.slave.take();
        self.runtime.request_stop();
        self.pipes.request_close(true);
        if let Some(child) = self.child.as_mut() {
            let _ = child.terminate();
        }
        if let Some(writer) = &self.writer {
            cancel_io(writer);
        }
        if self.closer.is_none() {
            // Only possible during setup, before any process was spawned.
            let master = lock(&self.runtime.master).take();
            drop(master);
            lock(&self.pipes.state).close_done = true;
            self.runtime.changed.notify_all();
        }
        // The already-started pumps/closer own their handles and finish teardown
        // independently. Never join a potentially blocking I/O call in Drop.
    }
}

fn cancel_io(thread: &JoinHandle<()>) {
    // Cancellation only targets this runtime's owned I/O thread. ERROR_NOT_FOUND
    // is normal when its write is between calls; supervision retries each tick.
    unsafe { CancelSynchronousIo(thread.as_raw_handle()) };
}

fn read_pipe(runtime: Arc<Runtime>, pipes: Arc<Pipes>, mut reader: Box<dyn Read + Send>) {
    // Leave room for an incomplete DSR prefix from the preceding read.
    let mut buffer = [0; OUTPUT_CHUNK_BYTES - 4];
    let mut cursor = super::cursor::InitialCursorQuery::default();
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if matches!(error.raw_os_error(), Some(code) if code == ERROR_BROKEN_PIPE as i32 || code == ERROR_NO_DATA as i32) =>
            {
                break;
            }
            Err(error) => {
                lock(&pipes.state).read_error = Some(error.to_string());
                break;
            }
        };
        // portable-pty 0.9 always enables PSEUDOCONSOLE_INHERIT_CURSOR. Answer
        // its initial DSR ourselves, even when the frontend is not yet attached
        // or Stop is racing startup. The parser spans arbitrary read boundaries.
        let (data, reply) = cursor.filter(&buffer[..count]);
        if reply {
            lock(&pipes.state).cursor_reply_pending = true;
            runtime.changed.notify_all();
        }
        if data.is_empty() {
            continue;
        }
        queue_output(&runtime, &pipes, data);
    }
    let tail = cursor.finish();
    if !tail.is_empty() {
        queue_output(&runtime, &pipes, tail);
    }
    lock(&pipes.state).reader_done = true;
    runtime.changed.notify_all();
}

fn queue_output(runtime: &Runtime, pipes: &Pipes, data: Vec<u8>) {
    let count = data.len();
    let mut state = lock(&pipes.state);
    while !state.discard
        && (state.output_bytes + count > MAX_IN_FLIGHT_BYTES
            || state.output.len() >= MAX_IN_FLIGHT_CHUNKS)
    {
        state = pipes
            .changed
            .wait(state)
            .unwrap_or_else(|poison| poison.into_inner());
    }
    if !state.discard {
        state.output.push_back(data);
        state.output_bytes += count;
    }
    drop(state);
    runtime.changed.notify_all();
}

fn write_pipe(runtime: Arc<Runtime>, pipes: Arc<Pipes>, mut writer: Box<dyn Write + Send>) {
    loop {
        let (reply, ready, closed) = {
            let mut state = lock(&pipes.state);
            let reply = std::mem::take(&mut state.cursor_reply_pending);
            state.cursor_reply_active = reply;
            (
                reply,
                state.cursor_ready,
                state.close_done && (state.cursor_ready || state.reader_done),
            )
        };
        if closed {
            // After ClosePseudoConsole returns, finish the initial handshake
            // (unless output has already ended), then close the input pipe.
            // Waiting for output EOF unconditionally can keep attached clients
            // alive on 24H2. The independent reader still drains final output.
            break;
        }
        let input: Vec<u8> = if reply {
            CURSOR_REPLY.to_vec()
        } else {
            let control = lock(&runtime.control);
            // A large paste before the inherited-cursor handshake can fill
            // hInput and block the only writer before it can send the reply.
            // portable-pty 0.9 always requests this handshake on client attachment.
            if control.input_closed || !ready {
                Vec::new()
            } else {
                control
                    .input
                    .iter()
                    .take(OUTPUT_CHUNK_BYTES)
                    .copied()
                    .collect()
            }
        };
        if input.is_empty() {
            let control = lock(&runtime.control);
            let _ = runtime
                .changed
                .wait_timeout(control, TICK)
                .unwrap_or_else(|poison| poison.into_inner());
            continue;
        }
        match writer.write_all(&input) {
            Ok(()) => {
                if reply {
                    let mut state = lock(&pipes.state);
                    state.cursor_reply_active = false;
                    state.cursor_ready = true;
                }
                if !reply {
                    let mut control = lock(&runtime.control);
                    let remove = input.len().min(control.input.len());
                    control.input.drain(..remove);
                }
            }
            Err(error) => {
                lock(&pipes.state).cursor_reply_active = false;
                let stopping = lock(&runtime.control).input_closed;
                if !stopping {
                    lock(&pipes.state).write_error = Some(error.to_string());
                }
                if stopping && error.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32) {
                    // Stop can cancel a normal paste before the initial query
                    // arrives. Remain available for that later protocol reply.
                    // A cancelled handshake itself also needs a fresh attempt.
                    if reply {
                        lock(&pipes.state).cursor_reply_pending = true;
                    }
                    continue;
                }
                break;
            }
        }
    }
    lock(&pipes.state).writer_done = true;
    runtime.changed.notify_all();
}

impl Spawned {
    pub(super) fn run(mut self, emit: Emitter) {
        let id = lock(&self.runtime.control).info.id.clone();
        let mut exit_code = None;
        let mut exited = false;
        let mut failed = false;
        let mut closing_since = None;
        let mut blocked_since = None;
        let mut reported_wait_error = false;
        loop {
            if !exited {
                match self.child.as_mut().expect("spawned child").poll() {
                    Ok(Some(code)) => {
                        exit_code = Some(code);
                        exited = true;
                        let mut control = lock(&self.runtime.control);
                        control.input_closed = true;
                        control.input.clear();
                    }
                    Ok(None) => {}
                    Err(error) => {
                        if !reported_wait_error {
                            report_error(
                                &emit,
                                &id,
                                &format!("Cannot observe child exit: {error}"),
                            );
                            reported_wait_error = true;
                        }
                        failed = true;
                        self.runtime.request_stop();
                    }
                }
            }
            let stopping = lock(&self.runtime.control).stop_requested;
            if stopping || exited {
                self.pipes.request_close(stopping);
                let started = closing_since.get_or_insert_with(Instant::now);
                // A blocked paste must never block stop or child-exit polling.
                if let Some(writer) = &self.writer {
                    // Let the startup cursor handshake finish before cancelling
                    // the writer. ConPTY cannot close until it has that reply.
                    let state = lock(&self.pipes.state);
                    if !state.cursor_reply_pending && !state.cursor_reply_active {
                        cancel_io(writer);
                    }
                }
                if !exited && started.elapsed() >= KILL_AFTER {
                    if let Err(error) = self.child.as_mut().expect("spawned child").terminate() {
                        failed = true;
                        let message = format!("Cannot terminate owned terminal process: {error}");
                        let mut control = lock(&self.runtime.control);
                        if control.cleanup_error.as_ref() != Some(&message) {
                            control.cleanup_error = Some(message.clone());
                            drop(control);
                            report_error(&emit, &id, &message);
                        }
                    }
                }
            }
            let errors = {
                let mut state = lock(&self.pipes.state);
                (state.read_error.take(), state.write_error.take())
            };
            for (kind, error) in [
                ("read terminal output", errors.0),
                ("write terminal input", errors.1),
            ] {
                if let Some(error) = error {
                    failed = true;
                    report_error(&emit, &id, &format!("Cannot {kind}: {error}"));
                    self.runtime.request_stop();
                }
            }
            let event = {
                let mut control = lock(&self.runtime.control);
                let capacity = control.flow.capacity();
                let mut state = lock(&self.pipes.state);
                if !control.stop_requested && capacity > 0 {
                    state.output.pop_front().map(|mut data| {
                        if data.len() > capacity {
                            let remaining = data.split_off(capacity);
                            state.output.push_front(remaining);
                        }
                        state.output_bytes -= data.len();
                        let sequence = control.flow.reserve(data.len());
                        TerminalEvent::Output {
                            runtime_id: id.clone(),
                            sequence,
                            data,
                        }
                    })
                } else {
                    None
                }
            };
            let progressed = event.is_some();
            if let Some(event) = event {
                self.pipes.changed.notify_all();
                if let Err(error) = send(&emit, event) {
                    failed = true;
                    report_error(
                        &emit,
                        &id,
                        &format!("Terminal output channel disconnected: {error}"),
                    );
                    self.runtime.request_stop();
                }
            }
            let control = lock(&self.runtime.control);
            let state = lock(&self.pipes.state);
            let output_done = state.reader_done && state.output.is_empty();
            let io_done = output_done && state.writer_done && state.close_done;
            if exited && io_done && (control.stop_requested || control.flow.pending.is_empty()) {
                break;
            }
            let awaiting_ack = !control.stop_requested
                && !control.flow.pending.is_empty()
                && (control.flow.capacity() == 0 || output_done);
            drop(state);
            if awaiting_ack {
                let started = blocked_since.get_or_insert_with(Instant::now);
                if started.elapsed() >= ACK_TIMEOUT {
                    drop(control);
                    failed = true;
                    report_error(&emit, &id, "Terminal rendering stopped acknowledging output; the process was stopped to keep memory bounded");
                    self.runtime.request_stop();
                    continue;
                }
            } else {
                blocked_since = None;
            }
            if !progressed {
                let _ = self
                    .runtime
                    .changed
                    .wait_timeout(control, TICK)
                    .unwrap_or_else(|poison| poison.into_inner());
            }
        }
        // I/O has completed, so these joins cannot wait on child I/O or ACKs.
        for worker in [&mut self.reader, &mut self.writer, &mut self.closer] {
            if let Some(worker) = worker.take() {
                if worker.join().is_err() {
                    failed = true;
                }
            }
        }
        {
            let mut control = lock(&self.runtime.control);
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
        lock(&self.runtime.control).done = true;
        self.runtime.changed.notify_all();
        self.completed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dll_policy_excludes_cwd_path_and_user_directories_and_fails_closed() {
        apply_dll_search_policy(|flags| {
            assert_eq!(
                flags,
                LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32
            );
            Ok(())
        })
        .unwrap();
        let error = apply_dll_search_policy(|_| Err(io::Error::other("test refusal"))).unwrap_err();
        assert!(error.contains("Cannot secure ConPTY DLL loading"));
    }
}
