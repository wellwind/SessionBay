#![cfg(windows)]

//! Native ConPTY acceptance tests. Cross-compilation checks their types, but
//! these must run on Windows 10 1809+ (including a pre-24H2 shutdown run).
#[path = "common/terminal_events.rs"]
mod terminal_events;
use terminal_events::TerminalEvents;

use sessionbay_lib::runtime::{
    LaunchSpec, RuntimeInfo, RuntimeManager, TerminalEvent, MAX_INPUT_BYTES, MAX_IN_FLIGHT_BYTES,
    MAX_IN_FLIGHT_CHUNKS,
};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows_sys::Win32::System::Console::{
    GetConsoleScreenBufferInfo, GetStdHandle, CONSOLE_SCREEN_BUFFER_INFO, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
};

const FIXTURE_MODE: &str = "SESSIONBAY_CONPTY_TEST_MODE";

fn spec(cwd: &Path, mode: &str) -> LaunchSpec {
    LaunchSpec {
        executable: std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        args: vec![
            "--ignored".into(),
            "--exact".into(),
            "fixture_entry".into(),
            "--nocapture".into(),
        ],
        cwd: cwd.into(),
        env: HashMap::from([(FIXTURE_MODE.into(), mode.into())]),
        session_id: None,
        resume_key: None,
        pane_id: uuid::Uuid::new_v4().to_string(),
    }
}

fn launch(
    manager: &RuntimeManager,
    spec: LaunchSpec,
) -> (RuntimeInfo, mpsc::Receiver<TerminalEvent>) {
    let (tx, rx) = mpsc::channel();
    let info = manager
        .launch(
            spec,
            240,
            24,
            Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
        )
        .unwrap();
    (info, rx)
}

fn events<'a>(
    manager: &'a RuntimeManager,
    receiver: &'a mpsc::Receiver<TerminalEvent>,
) -> TerminalEvents<'a, impl FnMut(&str, u64) + 'a> {
    TerminalEvents::new(receiver, |id, sequence| manager.ack(id, sequence).unwrap())
}

fn wait_until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !predicate() {
        assert!(Instant::now() < deadline, "condition did not become true");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn executable_arguments_cwd_environment_and_unicode_are_preserved() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("project & literal 中文");
    std::fs::create_dir(&cwd).unwrap();
    let manager = RuntimeManager::new();
    let mut launch_spec = spec(&cwd, "report");
    let literal = "a space;$(literal)&中文\"quoted\"";
    launch_spec.args.extend(["--skip".into(), literal.into()]);
    launch_spec
        .env
        .insert("SESSIONBAY_TEST_VALUE".into(), "value & ; $() 中文".into());
    let (_, rx) = launch(&manager, launch_spec);
    let (output, code) = events(&manager, &rx).collect();
    assert!(output.contains("project & literal 中文"));
    assert!(output.contains("value & ; $() 中文"));
    assert!(output.contains(literal));
    assert_eq!(code, Some(7));
}

#[test]
fn exit_code_259_is_an_exit_not_still_active() {
    let root = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (_, rx) = launch(&manager, spec(root.path(), "exit259"));
    assert_eq!(events(&manager, &rx).collect().1, Some(259));
}

#[test]
fn natural_exit_waits_for_the_final_ack() {
    let root = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (_, rx) = launch(&manager, spec(root.path(), "exit259"));
    // Even an immediate exit produces the test harness's initial output.
    let first = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let TerminalEvent::Output {
        runtime_id,
        mut sequence,
        ..
    } = first
    else {
        panic!("expected output before exit: {first:?}");
    };
    thread::sleep(Duration::from_millis(250));
    for event in rx.try_iter() {
        match event {
            TerminalEvent::Output { sequence: next, .. } => sequence = next,
            event => panic!("exit must wait for the final ACK: {event:?}"),
        }
    }
    manager.ack(&runtime_id, sequence).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap()
        {
            TerminalEvent::Output {
                runtime_id,
                sequence,
                ..
            } => manager.ack(&runtime_id, sequence).unwrap(),
            TerminalEvent::Exit { exit_code, .. } => {
                assert_eq!(exit_code, Some(259));
                break;
            }
            event => panic!("unexpected terminal event: {event:?}"),
        }
    }
}

#[test]
fn interactive_input_and_resize_reach_the_console() {
    let root = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (info, rx) = launch(&manager, spec(root.path(), "resize"));
    let mut events = events(&manager, &rx);
    events.until_text("ready-for-input");
    manager.resize(&info.id, 111, 37).unwrap();
    manager.write(&info.id, "hello 中文\r").unwrap();
    let (output, code) = events.collect();
    assert!(output.contains("received:hello 中文"));
    assert!(output.contains("size:111x37"), "{output}");
    assert_eq!(code, Some(0));
}

#[test]
fn stop_drains_backpressure_without_ack_and_cancels_blocked_paste() {
    let root = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (info, rx) = launch(&manager, spec(root.path(), "flood"));
    // Leave all output unacknowledged, then fill the independent input queue.
    thread::sleep(Duration::from_millis(500));
    let mut bytes = 0;
    let mut chunks = 0;
    for event in rx.try_iter() {
        match event {
            TerminalEvent::Output { data, .. } => {
                bytes += data.len();
                chunks += 1;
            }
            event => panic!("unexpected flooding event: {event:?}"),
        }
    }
    assert!(bytes > 0 && bytes <= MAX_IN_FLIGHT_BYTES);
    assert!(chunks <= MAX_IN_FLIGHT_CHUNKS);
    manager
        .write(&info.id, &"x".repeat(MAX_INPUT_BYTES))
        .unwrap();
    let started = Instant::now();
    let stopped = manager.stop(&info.id);
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "Stop exceeded its public bound"
    );
    if let Err(error) = stopped {
        assert!(error.contains("supervision is still active"), "{error}");
    }
    wait_until(|| manager.list()[0].state == "exited");
    assert!(manager.write(&info.id, "late").is_err());
    assert!(manager.resize(&info.id, 80, 24).is_err());
}

#[test]
fn startup_stop_and_missing_executable_do_not_deadlock_console_closure() {
    let root = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    for attempt in 0..8 {
        let (info, _rx) = launch(&manager, spec(root.path(), "sleep"));
        if attempt % 2 == 0 {
            // The paste must not occupy the writer ahead of the initial DSR.
            manager
                .write(&info.id, &"x".repeat(MAX_INPUT_BYTES))
                .unwrap();
        }
        let _ = manager.stop(&info.id);
        wait_until(|| {
            manager
                .list()
                .iter()
                .find(|item| item.id == info.id)
                .unwrap()
                .state
                == "exited"
        });
    }
    let mut missing = spec(root.path(), "sleep");
    missing.executable = root
        .path()
        .join("nonexistent.exe")
        .to_string_lossy()
        .into_owned();
    assert!(manager
        .launch(missing, 80, 24, Arc::new(|_| Ok(())))
        .is_err());
    manager.shutdown().unwrap();
}

struct CleanupProcess(std::process::Child);
impl Drop for CleanupProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn closing_console_terminates_attached_descendant_and_preserves_unrelated_process() {
    let root = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let mut unrelated = CleanupProcess(
        Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "fixture_entry", "--nocapture"])
            .env(FIXTURE_MODE, "sleep")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let marker = root.path().join("child.pid");
    let mut launch_spec = spec(root.path(), "descendant");
    launch_spec.env.insert(
        "SESSIONBAY_CHILD_PID_FILE".into(),
        marker.to_string_lossy().into_owned(),
    );
    let (info, rx) = launch(&manager, launch_spec);
    events(&manager, &rx).until_text("descendant-ready");
    let pid: u32 = std::fs::read_to_string(&marker).unwrap().parse().unwrap();
    // Test-only observation: open the live fixture descendant now and retain
    // its exact handle across shutdown, rather than checking a reused PID later.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(!handle.is_null());
    let _ = manager.stop(&info.id);
    wait_until(|| unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0);
    unsafe { CloseHandle(handle) };
    assert!(unrelated.0.try_wait().unwrap().is_none());
}

#[test]
fn disconnected_output_stops_and_shutdown_handles_multiple_panes() {
    let root = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let info = manager
        .launch(
            spec(root.path(), "flood"),
            80,
            24,
            Arc::new(|_| Err("detached frontend".into())),
        )
        .unwrap();
    wait_until(|| {
        manager
            .list()
            .iter()
            .find(|item| item.id == info.id)
            .unwrap()
            .state
            == "failed"
    });
    for _ in 0..4 {
        launch(&manager, spec(root.path(), "sleep"));
    }
    let _ = manager.shutdown();
    wait_until(|| {
        manager
            .list()
            .iter()
            .all(|item| matches!(item.state.as_str(), "exited" | "failed"))
    });
    assert!(manager
        .launch(spec(root.path(), "sleep"), 80, 24, Arc::new(|_| Ok(())))
        .is_err());
}

#[test]
fn untrusted_cwd_and_path_cannot_supply_the_conpty_dll() {
    let root = tempfile::tempdir().unwrap();
    let shadow = root.path().join("untrusted");
    let clean = root.path().join("clean");
    std::fs::create_dir(&shadow).unwrap();
    std::fs::create_dir(&clean).unwrap();
    let source = root.path().join("conpty_fixture.rs");
    std::fs::write(&source, r#"
        #[repr(C)] pub struct Coord { x: i16, y: i16 }
        #[no_mangle] pub extern "system" fn CreatePseudoConsole(
            _: Coord, _: *mut core::ffi::c_void, _: *mut core::ffi::c_void,
            _: u32, _: *mut *mut core::ffi::c_void,
        ) -> i32 {
            std::fs::write(std::env::var("SESSIONBAY_DLL_MARKER").unwrap(), b"loaded").unwrap();
            -2147467259
        }
        #[no_mangle] pub extern "system" fn ResizePseudoConsole(_: *mut core::ffi::c_void, _: Coord) -> i32 { -2147467259 }
        #[no_mangle] pub extern "system" fn ClosePseudoConsole(_: *mut core::ffi::c_void) {}
    "#).unwrap();
    // The native Rust test runner already requires this toolchain. The fixture
    // is benign and compiled from the source above, never downloaded.
    let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let compilation = Command::new(compiler)
        .args([
            "--crate-type",
            "cdylib",
            "--edition",
            "2021",
            "--crate-name",
            "conpty_fixture",
        ])
        .arg(&source)
        .arg("-o")
        .arg(shadow.join("conpty.dll"))
        .output()
        .expect("native ConPTY DLL regression requires the installed rustc");
    assert!(
        compilation.status.success(),
        "{}",
        String::from_utf8_lossy(&compilation.stderr)
    );
    for from_path in [false, true] {
        let marker = root.path().join(if from_path {
            "path-loaded"
        } else {
            "cwd-loaded"
        });
        let mut process = Command::new(std::env::current_exe().unwrap());
        process
            .args(["--ignored", "--exact", "fixture_entry", "--nocapture"])
            .env(FIXTURE_MODE, "dll-search")
            .env("SESSIONBAY_DLL_MARKER", &marker)
            .current_dir(if from_path { &clean } else { &shadow });
        if from_path {
            let path = std::env::var_os("PATH").unwrap_or_default();
            process.env(
                "PATH",
                std::env::join_paths(
                    std::iter::once(shadow.clone()).chain(std::env::split_paths(&path)),
                )
                .unwrap(),
            );
        }
        let result = process.output().unwrap();
        assert!(
            result.status.success(),
            "stdout: {}\nstderr: {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(!marker.exists(), "untrusted conpty.dll was called");
    }
}

#[test]
fn device_working_directories_are_rejected_before_filesystem_access() {
    let manager = RuntimeManager::new();
    for cwd in [
        r"\\.\pipe\sessionbay-test",
        r"C:\CON",
        r"C:\workspace:stream",
    ] {
        let error = manager
            .launch(spec(Path::new(cwd), "sleep"), 80, 24, Arc::new(|_| Ok(())))
            .unwrap_err();
        assert!(error.contains("working directory"));
    }
    assert!(manager.list().is_empty());
}

#[test]
fn duplicate_environment_aliases_fail_before_spawn() {
    let root = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let mut launch_spec = spec(root.path(), "sleep");
    launch_spec.env.insert("PATH".into(), "first".into());
    launch_spec.env.insert("Path".into(), "second".into());
    let error = manager
        .launch(launch_spec, 80, 24, Arc::new(|_| Ok(())))
        .unwrap_err();
    assert!(error.contains("ignoring case"));
    assert!(manager.list().is_empty());
}

#[test]
fn batch_shims_are_rejected_without_shell_interpretation() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("agent.CmD");
    std::fs::write(&path, "@echo must-not-run").unwrap();
    let manager = RuntimeManager::new();
    let mut launch_spec = spec(root.path(), "sleep");
    launch_spec.executable = path.to_string_lossy().into_owned();
    let error = manager
        .launch(launch_spec, 80, 24, Arc::new(|_| Ok(())))
        .unwrap_err();
    assert!(error.contains("native .exe"));
}

#[test]
#[ignore = "subprocess fixture; invoked explicitly by native ConPTY tests"]
fn fixture_entry() {
    let mode = std::env::var(FIXTURE_MODE).expect("fixture requires an explicit mode");
    match mode.as_str() {
        "dll-search" => {
            let manager = RuntimeManager::new();
            let (_, rx) = launch(&manager, spec(&std::env::current_dir().unwrap(), "exit259"));
            assert_eq!(events(&manager, &rx).collect().1, Some(259));
            assert!(!Path::new(&std::env::var("SESSIONBAY_DLL_MARKER").unwrap()).exists());
        }
        "report" => {
            println!("cwd:{}", std::env::current_dir().unwrap().display());
            println!("env:{}", std::env::var("SESSIONBAY_TEST_VALUE").unwrap());
            for arg in std::env::args() {
                println!("arg:{arg}");
            }
            std::process::exit(7);
        }
        "exit259" => {
            println!("exit259-ready");
            std::io::stdout().flush().unwrap();
            std::process::exit(259);
        }
        "resize" => {
            println!("ready-for-input");
            std::io::stdout().flush().unwrap();
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            println!("received:{}", line.trim());
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
            assert_ne!(
                unsafe { GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &mut info) },
                0
            );
            println!(
                "size:{}x{}",
                info.srWindow.Right - info.srWindow.Left + 1,
                info.srWindow.Bottom - info.srWindow.Top + 1
            );
            std::process::exit(0);
        }
        "flood" => {
            let mut output = std::io::stdout().lock();
            let bytes = vec![b'x'; 16 * 1024];
            loop {
                output.write_all(&bytes).unwrap();
                output.flush().unwrap();
            }
        }
        "descendant" => {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", "fixture_entry", "--nocapture"])
                .env(FIXTURE_MODE, "sleep")
                .spawn()
                .unwrap();
            std::fs::write(
                std::env::var("SESSIONBAY_CHILD_PID_FILE").unwrap(),
                child.id().to_string(),
            )
            .unwrap();
            println!("descendant-ready");
            std::io::stdout().flush().unwrap();
            child.wait().unwrap();
        }
        "sleep" => {
            println!("ready");
            std::io::stdout().flush().unwrap();
            loop {
                thread::sleep(Duration::from_secs(60));
            }
        }
        _ => panic!("unknown fixture mode"),
    }
}
