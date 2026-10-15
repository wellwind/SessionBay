#![cfg(any(target_os = "linux", target_os = "macos"))]

use sessionbay_lib::runtime::{
    LaunchSpec, RuntimeInfo, RuntimeManager, TerminalEvent, MAX_INPUT_BYTES, MAX_IN_FLIGHT_BYTES,
    MAX_IN_FLIGHT_CHUNKS,
};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

fn shell(cwd: &Path, script: &str) -> LaunchSpec {
    LaunchSpec {
        executable: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        cwd: cwd.into(),
        env: HashMap::new(),
        session_id: None,
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
            80,
            24,
            Arc::new(move |event| tx.send(event).map_err(|error| error.to_string())),
        )
        .unwrap();
    (info, rx)
}

fn collect(manager: &RuntimeManager, rx: &mpsc::Receiver<TerminalEvent>) -> (Vec<u8>, Option<i32>) {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    let mut previous = 0;
    loop {
        match rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("terminal event timeout")
        {
            TerminalEvent::Output {
                runtime_id,
                sequence,
                data,
            } => {
                assert_eq!(sequence, previous + 1, "output sequence must be contiguous");
                previous = sequence;
                output.extend(data);
                manager.ack(&runtime_id, sequence).unwrap();
            }
            TerminalEvent::Exit { exit_code, .. } => return (output, exit_code),
            TerminalEvent::Error { message, .. } => panic!("terminal error: {message}"),
        }
    }
}

fn until_text(
    manager: &RuntimeManager,
    rx: &mpsc::Receiver<TerminalEvent>,
    needle: &str,
) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut output = Vec::new();
    loop {
        match rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("terminal readiness timeout")
        {
            TerminalEvent::Output {
                runtime_id,
                sequence,
                data,
            } => {
                output.extend(data);
                manager.ack(&runtime_id, sequence).unwrap();
                let text = String::from_utf8_lossy(&output);
                if text.contains(needle) {
                    return text.into_owned();
                }
            }
            event => panic!("unexpected readiness event: {event:?}"),
        }
    }
}

fn wait_until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(Instant::now() < deadline, "condition did not become true");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn exec_args_cwd_and_env_remain_separate_and_exit_code_is_preserved() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("project with spaces;$(literal)");
    std::fs::create_dir(&cwd).unwrap();
    let manager = RuntimeManager::new();
    let mut spec = shell(
        &cwd,
        "printf '%s\\n' \"$PWD\" \"$SESSIONBAY_TEST_VALUE\" \"$1\"; exit 7",
    );
    spec.args
        .extend(["test".into(), "$(printf should-not-run); 中文".into()]);
    spec.env.insert(
        "SESSIONBAY_TEST_VALUE".into(),
        "value with ; $() \"quotes\"".into(),
    );
    let (info, rx) = launch(&manager, spec);
    let (output, code) = collect(&manager, &rx);
    let text = String::from_utf8(output).unwrap();
    assert!(text.contains(cwd.to_str().unwrap()));
    assert!(text.contains("value with ; $() \"quotes\""));
    assert!(text.contains("$(printf should-not-run); 中文"));
    assert_eq!(code, Some(7));
    wait_until(|| {
        manager
            .list()
            .iter()
            .any(|item| item.id == info.id && item.state == "exited" && item.exit_code == Some(7))
    });
}

#[test]
fn keyboard_input_and_resize_reach_the_child() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (info, rx) = launch(&manager, shell(cwd.path(), "stty -echo; printf 'READY\\n'; IFS= read -r line; stty size; printf 'INPUT:%s\\n' \"$line\""));
    until_text(&manager, &rx, "READY");
    manager.resize(&info.id, 113, 37).unwrap();
    manager.write(&info.id, "hello 中文\r").unwrap();
    let mut output = Vec::new();
    loop {
        match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
            TerminalEvent::Output {
                runtime_id,
                sequence,
                data,
            } => {
                output.extend(data);
                manager.ack(&runtime_id, sequence).unwrap();
            }
            TerminalEvent::Exit { exit_code, .. } => {
                assert_eq!(exit_code, Some(0));
                break;
            }
            event => panic!("unexpected event: {event:?}"),
        }
    }
    let text = String::from_utf8(output).unwrap();
    assert!(text.contains("37 113"), "{text:?}");
    assert!(text.contains("INPUT:hello 中文"), "{text:?}");
    assert!(manager.write(&info.id, "too late").is_err());
}

#[test]
fn raw_utf8_bytes_survive_split_writes_without_lossy_decoding() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (_, rx) = launch(&manager, shell(cwd.path(), "printf '\\344'; sleep 0.05; printf '\\270'; sleep 0.05; printf '\\255\\033[31mRED\\033[0m'"));
    let (output, code) = collect(&manager, &rx);
    assert_eq!(output, "中\x1b[31mRED\x1b[0m".as_bytes());
    assert_eq!(code, Some(0));
}

#[test]
fn two_ptys_have_independent_input_and_output() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (first, first_rx) = launch(
        &manager,
        shell(
            cwd.path(),
            "stty -echo; printf 'READY\\n'; read line; printf 'FIRST:%s' \"$line\"",
        ),
    );
    let (second, second_rx) = launch(
        &manager,
        shell(
            cwd.path(),
            "stty -echo; printf 'READY\\n'; read line; printf 'SECOND:%s' \"$line\"",
        ),
    );
    until_text(&manager, &first_rx, "READY");
    until_text(&manager, &second_rx, "READY");
    manager.write(&first.id, "one\r").unwrap();
    manager.write(&second.id, "two\r").unwrap();
    for (rx, expected, forbidden) in [
        (first_rx, "FIRST:one", "two"),
        (second_rx, "SECOND:two", "one"),
    ] {
        let mut bytes = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
                TerminalEvent::Output {
                    runtime_id,
                    sequence,
                    data,
                } => {
                    bytes.extend(data);
                    manager.ack(&runtime_id, sequence).unwrap();
                }
                TerminalEvent::Exit { .. } => break,
                event => panic!("unexpected event: {event:?}"),
            }
        }
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains(expected));
        assert!(!text.contains(forbidden));
    }
}

#[test]
fn output_stops_at_bounded_credit_and_resumes_without_data_loss() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (info, rx) = launch(
        &manager,
        shell(
            cwd.path(),
            "dd if=/dev/zero bs=16384 count=64 2>/dev/null; printf TAIL",
        ),
    );
    let mut output = Vec::new();
    let mut sequence = 0;
    let mut chunks = 0;
    loop {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(TerminalEvent::Output {
                sequence: next,
                data,
                ..
            }) => {
                assert_eq!(next, sequence + 1);
                sequence = next;
                chunks += 1;
                output.extend(data);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            event => panic!("unexpected backpressure event: {event:?}"),
        }
    }
    assert!(!output.is_empty());
    assert!(output.len() <= MAX_IN_FLIGHT_BYTES);
    assert!(chunks <= MAX_IN_FLIGHT_CHUNKS);
    assert!(output.len() == MAX_IN_FLIGHT_BYTES || chunks == MAX_IN_FLIGHT_CHUNKS);
    assert!(manager.ack(&info.id, sequence + 1).is_err());
    assert!(
        rx.recv_timeout(Duration::from_millis(150)).is_err(),
        "unacknowledged output must remain paused"
    );
    manager.ack(&info.id, sequence).unwrap();
    loop {
        match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
            TerminalEvent::Output {
                runtime_id,
                sequence: next,
                data,
            } => {
                assert_eq!(next, sequence + 1);
                sequence = next;
                output.extend(data);
                manager.ack(&runtime_id, sequence).unwrap();
            }
            TerminalEvent::Exit { exit_code, .. } => {
                assert_eq!(exit_code, Some(0));
                break;
            }
            event => panic!("unexpected event: {event:?}"),
        }
    }
    assert_eq!(output.len(), 1024 * 1024 + 4);
    assert!(output[..1024 * 1024].iter().all(|byte| *byte == 0));
    assert_eq!(&output[1024 * 1024..], b"TAIL");
}

#[test]
fn concurrent_duplicate_session_launches_return_one_runtime_and_original_pane() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = Arc::new(RuntimeManager::new());
    let barrier = Arc::new(Barrier::new(5));
    let mut workers = Vec::new();
    for index in 0..4 {
        let manager = Arc::clone(&manager);
        let barrier = Arc::clone(&barrier);
        let mut spec = shell(cwd.path(), "sleep 60");
        spec.session_id = Some("source:session".into());
        spec.pane_id = format!("pane-{index}");
        workers.push(thread::spawn(move || {
            barrier.wait();
            manager.launch(spec, 80, 24, Arc::new(|_| Ok(()))).unwrap()
        }));
    }
    barrier.wait();
    let infos: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert!(infos
        .iter()
        .all(|info| info.id == infos[0].id && info.pane_id == infos[0].pane_id));
    assert_eq!(manager.list().len(), 1);
    manager.stop(&infos[0].id).unwrap();
    let mut spec = shell(cwd.path(), "printf restarted");
    spec.session_id = Some("source:session".into());
    let (new_info, rx) = launch(&manager, spec);
    assert_ne!(new_info.id, infos[0].id);
    assert_eq!(collect(&manager, &rx).0, b"restarted");
}

fn child_pid(text: &str) -> i32 {
    text.lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("CHILD:")
                .and_then(|value| value.parse().ok())
        })
        .expect("child PID")
}

fn process_is_running(pid: i32) -> bool {
    // ps is only a test probe. Production uses native process/session APIs.
    let output = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    !state.trim().is_empty() && !state.trim_start().starts_with('Z')
}

struct ExternalChild(Child);
impl Drop for ExternalChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn stop_escalates_to_kill_for_owned_job_groups_and_leaves_external_processes_alone() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let mut external = ExternalChild(
        Command::new("/bin/sleep")
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let (info, rx) = launch(
        &manager,
        shell(
            cwd.path(),
            "set -m; trap '' HUP TERM; sleep 60 & printf 'CHILD:%s\\nREADY\\n' \"$!\"; wait",
        ),
    );
    let child = child_pid(&until_text(&manager, &rx, "READY"));
    assert!(process_is_running(child));
    let started = Instant::now();
    manager.stop(&info.id).unwrap();
    assert!(started.elapsed() < Duration::from_secs(3));
    wait_until(|| !process_is_running(child));
    assert!(external.0.try_wait().unwrap().is_none());
    manager.stop(&info.id).unwrap();
}

fn assert_backpressured_writer_stops(ignore_termination: bool, pause_output: bool) {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let script = format!(
        "stty ixon -ixany start '^Q' stop '^S'; {} printf 'LEADER:%s\\n' \"$$\"; while :; do printf '0123456789012345678901234567890123456789'; done",
        if ignore_termination { "trap '' HUP TERM;" } else { "" }
    );
    let (info, rx) = launch(&manager, shell(cwd.path(), &script));
    // Do not ACK any output. Wait for actual byte/frame credit exhaustion,
    // rather than assuming that an arbitrary sleep filled the PTY on this OS.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::new();
    let mut frames = 0;
    while bytes.len() < MAX_IN_FLIGHT_BYTES && frames < MAX_IN_FLIGHT_CHUNKS {
        match rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap()
        {
            TerminalEvent::Output { sequence, data, .. } => {
                frames += 1;
                assert_eq!(sequence, frames as u64);
                bytes.extend(data);
            }
            event => panic!("unexpected backpressure event: {event:?}"),
        }
    }
    let leader = String::from_utf8_lossy(&bytes)
        .split("LEADER:")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .parse::<i32>()
        .unwrap();
    assert!(bytes.len() <= MAX_IN_FLIGHT_BYTES);
    assert!(process_is_running(leader));
    if pause_output {
        // Exercise the tty driver's real IXON stop, not a stopped child process.
        // The supervisor must resume output on its own master during teardown.
        manager.write(&info.id, "\x13").unwrap();
    }
    // The child keeps writing while the frontend supplies no more credit.
    // Darwin ttywait must be able to drain this output during signal teardown.
    thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    let stopped = manager.stop(&info.id);
    let remaining: Vec<_> = rx.try_iter().collect();
    assert!(
        stopped.is_ok(),
        "stop failed: {stopped:?}; events: {remaining:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(manager.list()[0].state, "exited");
    assert!(manager.write(&info.id, "late input").is_err());
    assert!(!process_is_running(leader));
    assert_eq!(
        remaining.len(),
        1,
        "stopping must not emit or credit discarded bytes"
    );
    assert!(matches!(remaining[0], TerminalEvent::Exit { .. }));
}

#[test]
fn stopping_a_backpressured_runtime_does_not_wait_for_ack() {
    assert_backpressured_writer_stops(false, false);
}

#[test]
fn stopping_a_backpressured_signal_resistant_runtime_drains_while_escalating() {
    assert_backpressured_writer_stops(true, false);
}

#[test]
fn stopping_a_backpressured_xoff_paused_runtime_does_not_deadlock() {
    assert_backpressured_writer_stops(true, true);
}

#[test]
fn natural_leader_exit_cleans_up_surviving_background_jobs() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (_, rx) = launch(
        &manager,
        shell(
            cwd.path(),
            "trap '' HUP TERM; sleep 60 & printf 'CHILD:%s\\n' \"$!\"; exit 9",
        ),
    );
    let (output, code) = collect(&manager, &rx);
    let child = child_pid(&String::from_utf8_lossy(&output));
    assert_eq!(code, Some(9));
    wait_until(|| !process_is_running(child));
}

#[test]
fn channel_disconnect_stops_the_process_and_records_failure() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let info = manager
        .launch(
            shell(cwd.path(), "printf hello; sleep 60"),
            80,
            24,
            Arc::new(|_| Err("window closed".into())),
        )
        .unwrap();
    wait_until(|| {
        manager
            .list()
            .iter()
            .any(|runtime| runtime.id == info.id && runtime.state == "failed")
    });
    manager.stop(&info.id).unwrap();
}

#[test]
fn manager_drop_cleans_up_children_and_shutdown_rejects_new_launches() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (_, rx) = launch(
        &manager,
        shell(
            cwd.path(),
            "sleep 60 & printf 'CHILD:%s\\nREADY\\n' \"$!\"; wait",
        ),
    );
    let child = child_pid(&until_text(&manager, &rx, "READY"));
    drop(manager);
    wait_until(|| !process_is_running(child));
    let manager = RuntimeManager::new();
    manager.shutdown().unwrap();
    assert!(manager
        .launch(
            shell(cwd.path(), "printf nope"),
            80,
            24,
            Arc::new(|_| Ok(()))
        )
        .is_err());
}

#[test]
fn invalid_launches_do_not_register_or_spawn_and_input_has_a_limit() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let mut spec = shell(cwd.path(), "printf nope");
    spec.executable = "/definitely/not/a/sessionbay/executable".into();
    assert!(manager.launch(spec, 80, 24, Arc::new(|_| Ok(()))).is_err());
    let mut spec = shell(cwd.path(), "printf nope");
    spec.cwd = cwd.path().join("missing");
    assert!(manager.launch(spec, 80, 24, Arc::new(|_| Ok(()))).is_err());
    let mut spec = shell(cwd.path(), "printf nope");
    spec.env.insert("INVALID=NAME".into(), "value".into());
    assert!(manager.launch(spec, 80, 24, Arc::new(|_| Ok(()))).is_err());
    assert!(manager
        .launch(
            shell(cwd.path(), "printf nope"),
            0,
            24,
            Arc::new(|_| Ok(()))
        )
        .is_err());
    assert!(manager.list().is_empty());
    let (info, _rx) = launch(&manager, shell(cwd.path(), "sleep 60"));
    assert!(manager
        .write(&info.id, &"x".repeat(MAX_INPUT_BYTES + 1))
        .is_err());
    assert!(manager.resize(&info.id, 1001, 24).is_err());
    manager.stop(&info.id).unwrap();
}

#[test]
fn natural_exit_waits_until_the_final_xterm_write_is_acknowledged() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (info, rx) = launch(&manager, shell(cwd.path(), "printf final"));
    let sequence = match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
        TerminalEvent::Output { sequence, data, .. } => {
            assert_eq!(data, b"final");
            sequence
        }
        event => panic!("unexpected event: {event:?}"),
    };
    assert!(matches!(
        rx.recv_timeout(Duration::from_millis(150)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    manager.ack(&info.id, sequence).unwrap();
    assert!(matches!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        TerminalEvent::Exit {
            exit_code: Some(0),
            ..
        }
    ));
}

#[test]
fn abandoned_final_ack_times_out_instead_of_leaking_runtime_state() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (info, rx) = launch(&manager, shell(cwd.path(), "printf final"));
    assert!(matches!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        TerminalEvent::Output { .. }
    ));
    match rx.recv_timeout(Duration::from_secs(35)).unwrap() {
        TerminalEvent::Error { message, .. } => assert!(message.contains("did not acknowledge")),
        event => panic!("expected acknowledgement timeout, got {event:?}"),
    }
    assert!(matches!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        TerminalEvent::Exit {
            exit_code: Some(0),
            ..
        }
    ));
    wait_until(|| {
        manager
            .list()
            .iter()
            .any(|runtime| runtime.id == info.id && runtime.state == "failed")
    });
    manager.stop(&info.id).unwrap();
}

#[test]
fn large_paste_cannot_block_stop_when_the_child_is_not_reading() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (info, rx) = launch(
        &manager,
        shell(cwd.path(), "stty raw -echo; printf READY; sleep 60"),
    );
    until_text(&manager, &rx, "READY");
    manager
        .write(&info.id, &"x".repeat(MAX_INPUT_BYTES))
        .unwrap();
    thread::sleep(Duration::from_millis(50));
    let started = Instant::now();
    manager.stop(&info.id).unwrap();
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn rapidly_exiting_children_keep_their_output_and_status() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    for _ in 0..24 {
        let (info, rx) = launch(&manager, shell(cwd.path(), "printf quick; exit 23"));
        let (output, code) = collect(&manager, &rx);
        assert_eq!(output, b"quick");
        assert_eq!(code, Some(23));
        manager.stop(&info.id).unwrap();
    }
}

#[test]
fn exited_session_leader_still_cleans_up_separate_job_control_groups() {
    let cwd = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (_, rx) = launch(
        &manager,
        shell(
            cwd.path(),
            "set -m; trap '' HUP TERM; sleep 60 & printf 'CHILD:%s\\n' \"$!\"; exit 19",
        ),
    );
    let (output, code) = collect(&manager, &rx);
    assert_eq!(code, Some(19));
    let child = child_pid(&String::from_utf8_lossy(&output));
    wait_until(|| !process_is_running(child));
}
