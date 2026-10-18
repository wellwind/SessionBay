#![cfg(any(target_os = "linux", target_os = "macos"))]
use sessionbay_lib::{
    broker::{BrokerClient, UiEvent},
    runtime::LaunchSpec,
    service::LaunchRequest,
};
use std::{
    collections::HashMap,
    path::Path,
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant},
};
fn client(path: &Path) -> BrokerClient {
    BrokerClient::connect(path, Path::new(env!("CARGO_BIN_EXE_sessionbay-broker"))).unwrap()
}
fn launch(
    client: &BrokerClient,
    path: &Path,
    pane: &str,
    script: &str,
) -> (String, String, mpsc::Receiver<UiEvent>) {
    let lease = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    let request = LaunchRequest {
        pane_id: pane.into(),
        kind: "shell".into(),
        project_id: Some("synthetic-project".into()),
        session_id: None,
        resume_id: None,
        cwd: Some(path.to_string_lossy().into()),
        profile_id: None,
        cols: 80,
        rows: 24,
    };
    let spec = LaunchSpec {
        executable: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        cwd: path.into(),
        env: HashMap::new(),
        session_id: None,
        resume_key: None,
        pane_id: pane.into(),
    };
    let info = client
        .launch(
            spec,
            &request,
            lease.clone(),
            Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
        )
        .unwrap();
    (info.id, lease, rx)
}
fn until_text(
    client: &BrokerClient,
    lease: &str,
    rx: &mpsc::Receiver<UiEvent>,
    needle: &str,
) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        match event {
            UiEvent::Output {
                runtime_id,
                sequence,
                data,
            }
            | UiEvent::Snapshot {
                runtime_id,
                sequence,
                data,
                ..
            } => {
                output.extend(data);
                client.ack(&runtime_id, sequence, lease).unwrap();
                if String::from_utf8_lossy(&output).contains(needle) {
                    return String::from_utf8_lossy(&output).into();
                }
            }
            UiEvent::Error { message, .. } | UiEvent::Disconnected { message, .. } => {
                panic!("{message}")
            }
            UiEvent::AgentActivity { .. } => {}
            UiEvent::Exit { .. } => panic!("process ended before marker"),
        }
    }
}
#[test]
fn detached_process_keeps_identity_output_and_interactive_input_after_ui_client_drops() {
    let temp = tempfile::tempdir().unwrap();
    let c = client(temp.path());
    let(id,lease,rx)=launch(&c,temp.path(),"pane-one","printf 'original:%s\\n' $$; sleep 1; printf 'while-ui-closed\\n'; read line; printf 'received:%s\\n' \"$line\"; sleep 30");
    let original = until_text(&c, &lease, &rx, "original:");
    assert!(original.contains("original:"));
    drop(c);
    drop(rx);
    thread::sleep(Duration::from_millis(1300));
    let reopened = client(temp.path());
    let records = reopened.list().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].info.id, id);
    assert_eq!(records[0].info.state, "running");
    assert_eq!(records[0].project_id.as_deref(), Some("synthetic-project"));
    let lease = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    reopened
        .attach(
            &id,
            lease.clone(),
            Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
        )
        .unwrap();
    let snapshot = until_text(&reopened, &lease, &rx, "while-ui-closed");
    assert!(snapshot.contains("original:"));
    reopened.write(&id, "hello-after-reopen\n").unwrap();
    until_text(&reopened, &lease, &rx, "received:hello-after-reopen");
    reopened.stop(&id).unwrap();
    assert!(matches!(
        reopened.list().unwrap()[0].info.state.as_str(),
        "exited" | "failed"
    ));
    reopened.forget(&id).unwrap();
    assert!(reopened.list().unwrap().is_empty());
    reopened.shutdown_broker().unwrap();
}
#[test]
fn stale_detach_lease_cannot_cancel_replacement_attachment() {
    let temp = tempfile::tempdir().unwrap();
    let c = client(temp.path());
    let (id, old, rx) = launch(
        &c,
        temp.path(),
        "pane",
        "printf ready; read line; printf 'continued:%s' \"$line\"; sleep 30",
    );
    until_text(&c, &old, &rx, "ready");
    let new = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    c.attach(
        &id,
        new.clone(),
        Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
    )
    .unwrap();
    c.detach(&id, &old);
    until_text(&c, &new, &rx, "ready");
    c.write(&id, "yes\n").unwrap();
    until_text(&c, &new, &rx, "continued:yes");
    c.shutdown_broker().unwrap();
}
#[test]
fn completed_output_survives_ui_reopen_and_metadata_never_reexecutes_after_broker_restart() {
    let temp = tempfile::tempdir().unwrap();
    let c = client(temp.path());
    let (id, lease, rx) = launch(&c, temp.path(), "done", "printf completed; exit 7");
    until_text(&c, &lease, &rx, "completed");
    let deadline = Instant::now() + Duration::from_secs(5);
    while c.list().unwrap()[0].info.state == "running" {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    drop(c);
    let reopened = client(temp.path());
    assert_eq!(reopened.list().unwrap()[0].info.exit_code, Some(7));
    let lease = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    reopened
        .attach(
            &id,
            lease.clone(),
            Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
        )
        .unwrap();
    until_text(&reopened, &lease, &rx, "completed");
    reopened.shutdown_broker().unwrap();
    drop(reopened);
    thread::sleep(Duration::from_millis(400));
    let restarted = client(temp.path());
    assert_eq!(restarted.list().unwrap()[0].info.id, id);
    assert_eq!(restarted.list().unwrap()[0].info.state, "exited");
    assert!(restarted.write(&id, "never-execute").is_err());
    restarted.shutdown_broker().unwrap();
}
#[test]
fn restored_running_metadata_is_interrupted_without_adopting_saved_pid() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("runtime-broker-v1");
    std::fs::create_dir(&dir).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(dir.join("sessions.json"),r#"[{"id":"中中中","paneId":"old-pane","sessionId":null,"state":"running","cwd":"/synthetic","exitCode":null,"kind":"shell","projectId":null,"profileId":null,"resumeId":null}]"#).unwrap();
    let c = client(temp.path());
    let records = c.list().unwrap();
    assert_eq!(records[0].info.state, "interrupted");
    assert_eq!(records[0].info.exit_code, None);
    assert!(c.stop("中中中").is_err());
    let (tx, rx) = mpsc::channel();
    c.attach(
        "中中中",
        uuid::Uuid::new_v4().to_string(),
        Arc::new(move |event| tx.send(event).map_err(|error| error.to_string())),
    )
    .unwrap();
    assert!(matches!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        UiEvent::Disconnected { .. }
    ));
    c.forget("中中中").unwrap();
    c.shutdown_broker().unwrap();
}
#[test]
fn unsafe_runtime_directory_and_symlink_are_rejected_without_fixing_permissions() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("runtime-broker-v1");
    std::fs::create_dir(&dir).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(BrokerClient::connect(
        temp.path(),
        Path::new(env!("CARGO_BIN_EXE_sessionbay-broker"))
    )
    .is_err());
    assert_eq!(
        std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o755
    );
    std::fs::remove_dir(&dir).unwrap();
    std::os::unix::fs::symlink(temp.path(), &dir).unwrap();
    assert!(BrokerClient::connect(
        temp.path(),
        Path::new(env!("CARGO_BIN_EXE_sessionbay-broker"))
    )
    .is_err());
}

#[test]
#[ignore = "subprocess-only fixture, invoked by closing_the_entire_ui_process_preserves_the_broker"]
fn subprocess_ui_fixture() {
    let directory = std::env::var_os("SESSIONBAY_PERSISTENCE_TEST_DIR")
        .expect("test parent supplies isolated directory");
    let path = Path::new(&directory);
    let c = client(path);
    let (_, lease, rx) = launch(&c, path, "closed-process-pane", "printf 'ui-ready'; sleep 1; printf '\\r\\nafter-ui-process-exit'; read line; printf '\\r\\ninput:%s' \"$line\"; sleep 60");
    until_text(&c, &lease, &rx, "ui-ready");
    // The entire test subprocess exits now, including every UI attachment and
    // the thread waiting on its originally spawned broker child.
}

#[test]
fn closing_the_entire_ui_process_preserves_the_broker() {
    let temp = tempfile::tempdir().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "subprocess_ui_fixture", "--ignored"])
        .env("SESSIONBAY_PERSISTENCE_TEST_DIR", temp.path())
        .status()
        .unwrap();
    assert!(status.success());
    thread::sleep(Duration::from_millis(1200));
    let c = client(temp.path());
    let records = c.list().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].info.pane_id, "closed-process-pane");
    assert_eq!(records[0].info.state, "running");
    let id = records[0].info.id.clone();
    let lease = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    c.attach(
        &id,
        lease.clone(),
        Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
    )
    .unwrap();
    until_text(&c, &lease, &rx, "after-ui-process-exit");
    c.write(&id, "still-same-shell\n").unwrap();
    until_text(&c, &lease, &rx, "input:still-same-shell");
    c.shutdown_broker().unwrap();
}

#[test]
fn broker_process_crash_leaves_interrupted_records_and_never_adopts_a_pid() {
    let temp = tempfile::tempdir().unwrap();
    let mut broker = std::process::Command::new(env!("CARGO_BIN_EXE_sessionbay-broker"))
        .arg("--sessionbay-runtime-broker")
        .arg(temp.path())
        .spawn()
        .unwrap();
    // File existence alone does not prove ownership: wait for its OS lock so
    // the client cannot race this manually owned fixture by spawning a broker.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(temp.path().join("runtime-broker-v1/broker.lock"))
        {
            if matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)) {
                break;
            }
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    let c = client(temp.path());
    let (id, lease, events) = launch(
        &c,
        temp.path(),
        "crash-pane",
        "printf 'running-before-crash'; sleep 60",
    );
    until_text(&c, &lease, &events, "running-before-crash");
    broker.kill().unwrap();
    broker.wait().unwrap();
    assert!(c.list().is_err());
    drop(c);
    let restarted = client(temp.path());
    let records = restarted.list().unwrap();
    assert_eq!(records[0].info.id, id);
    assert_eq!(records[0].info.state, "interrupted");
    assert!(restarted.write(&id, "must-not-run").is_err());
    assert!(restarted.stop(&id).is_err());
    restarted.shutdown_broker().unwrap();
}
