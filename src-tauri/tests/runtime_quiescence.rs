#![cfg(any(target_os = "linux", target_os = "macos"))]

use sessionbay_lib::runtime::{LaunchSpec, RuntimeManager, RuntimeQuiescence, TerminalEvent};
use std::{
    collections::HashMap,
    path::Path,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

fn shell(cwd: &Path, script: &str) -> LaunchSpec {
    LaunchSpec {
        executable: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        cwd: cwd.into(),
        env: HashMap::from([("HOME".into(), cwd.to_string_lossy().into_owned())]),
        session_id: None,
        resume_key: None,
        pane_id: uuid::Uuid::new_v4().to_string(),
    }
}
fn wait_unverified(manager: &RuntimeManager) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while manager.quiescence() != RuntimeQuiescence::Unverified {
        assert!(
            Instant::now() < deadline,
            "completed work did not remain unverified: {:?}",
            manager.quiescence()
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn live_idle_prompt_blocks_seal_without_stopping_the_process() {
    let temp = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (tx, rx) = mpsc::channel();
    let info = manager
        .launch(
            shell(
                temp.path(),
                "printf READY; read value; printf 'received:%s' \"$value\"",
            ),
            80,
            24,
            Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
        )
        .unwrap();
    let mut output = Vec::new();
    let mut ready = false;
    loop {
        match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
            TerminalEvent::Output {
                runtime_id,
                sequence,
                data,
            } => {
                output.extend(data);
                manager.ack(&runtime_id, sequence).unwrap();
                if !ready && String::from_utf8_lossy(&output).contains("READY") {
                    assert_eq!(manager.quiescence(), RuntimeQuiescence::Active);
                    assert_eq!(
                        manager.try_close_if_quiescent(),
                        Err(RuntimeQuiescence::Active)
                    );
                    manager.write(&info.id, "proof\n").unwrap();
                    ready = true;
                }
            }
            TerminalEvent::Exit { .. } => break,
            TerminalEvent::Error { message, .. } => panic!("{message}"),
        }
    }
    assert!(String::from_utf8_lossy(&output).contains("received:proof"));
    wait_unverified(&manager);
    assert_eq!(
        manager.try_close_if_quiescent(),
        Err(RuntimeQuiescence::Unverified)
    );
}

#[test]
fn exited_label_during_exit_callback_is_not_supervisor_completion() {
    let temp = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let (events, rx) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let gate = Mutex::new(gate);
    manager
        .launch(
            shell(temp.path(), "printf synthetic-complete"),
            80,
            24,
            Arc::new(move |event| {
                let exiting = matches!(event, TerminalEvent::Exit { .. });
                events.send(event).map_err(|e| e.to_string())?;
                if exiting {
                    let _ = gate.lock().unwrap().recv_timeout(Duration::from_secs(5));
                }
                Ok(())
            }),
        )
        .unwrap();
    loop {
        match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
            TerminalEvent::Output {
                runtime_id,
                sequence,
                ..
            } => manager.ack(&runtime_id, sequence).unwrap(),
            TerminalEvent::Exit { .. } => break,
            TerminalEvent::Error { message, .. } => panic!("{message}"),
        }
    }
    assert_eq!(manager.list()[0].state, "exited");
    assert_eq!(
        manager.try_close_if_quiescent(),
        Err(RuntimeQuiescence::Active)
    );
    release.send(()).unwrap();
    // Reaping the leader, closing PTY I/O and finishing the supervisor do not
    // provide atomic containment evidence for a concurrently forking descendant.
    wait_unverified(&manager);
    assert_eq!(
        manager.try_close_if_quiescent(),
        Err(RuntimeQuiescence::Unverified)
    );
}

#[test]
fn unproved_spawn_rollback_blocks_seal_even_with_an_empty_list() {
    let temp = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    let mut spec = shell(temp.path(), "exit 0");
    spec.executable = temp
        .path()
        .join("missing-synthetic-agent")
        .to_string_lossy()
        .into_owned();
    assert!(manager.launch(spec, 80, 24, Arc::new(|_| Ok(()))).is_err());
    assert!(manager.list().is_empty());
    assert_eq!(manager.quiescence(), RuntimeQuiescence::Unverified);
    assert_eq!(
        manager.try_close_if_quiescent(),
        Err(RuntimeQuiescence::Unverified)
    );
    // A conservative idle-exit veto must not disable ordinary user launches.
    let info = manager
        .launch(
            shell(temp.path(), "read value"),
            80,
            24,
            Arc::new(|_| Ok(())),
        )
        .unwrap();
    manager.stop(&info.id).unwrap();
    assert_eq!(manager.quiescence(), RuntimeQuiescence::Unverified);
}

#[test]
fn only_a_never_used_empty_manager_can_currently_seal_without_job_containment_proof() {
    let temp = tempfile::tempdir().unwrap();
    let manager = RuntimeManager::new();
    assert_eq!(manager.quiescence(), RuntimeQuiescence::Proven);
    manager.try_close_if_quiescent().unwrap();
    assert!(manager
        .launch(
            shell(temp.path(), "exit 0"),
            80,
            24,
            Arc::new(|_| panic!("sealed admission must not spawn"))
        )
        .unwrap_err()
        .contains("shutting down"));
}
