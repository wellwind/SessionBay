#![cfg(windows)]
//! Native Windows acceptance tests. Cross-compilation only checks their build;
//! it does not execute the named-pipe ACL or detached ConPTY assertions.
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
fn connect(path: &Path) -> BrokerClient {
    BrokerClient::connect(path, Path::new(env!("CARGO_BIN_EXE_sessionbay-broker"))).unwrap()
}
fn read_marker(client: &BrokerClient, lease: &str, events: &mpsc::Receiver<UiEvent>, marker: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut output = Vec::new();
    loop {
        match events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap()
        {
            UiEvent::Snapshot {
                runtime_id,
                sequence,
                data,
                ..
            }
            | UiEvent::Output {
                runtime_id,
                sequence,
                data,
            } => {
                output.extend(data);
                client.ack(&runtime_id, sequence, lease).unwrap();
                if String::from_utf8_lossy(&output).contains(marker) {
                    return;
                }
            }
            UiEvent::Error { message, .. } | UiEvent::Disconnected { message, .. } => {
                panic!("{message}")
            }
            UiEvent::AgentActivity { .. } | UiEvent::TerminalStatus { .. } => {}
            UiEvent::Exit { .. } => panic!("terminal exited before marker"),
        }
    }
}
#[test]
fn detached_conpty_reopens_the_same_runtime_and_replays_background_output() {
    let temp = tempfile::tempdir().unwrap();
    let client = connect(temp.path());
    let lease = uuid::Uuid::new_v4().to_string();
    let (tx, events) = mpsc::channel();
    let executable = Path::new(&std::env::var("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let spec=LaunchSpec{executable:executable.to_string_lossy().into(),args:vec!["-NoLogo".into(),"-NoProfile".into(),"-Command".into(),"Write-Output \"original:$PID\"; Start-Sleep -Milliseconds 1000; Write-Output 'while-ui-closed'; $line=Read-Host; Write-Output \"received:$line\"; Start-Sleep -Seconds 60".into()],cwd:temp.path().into(),env:HashMap::new(),session_id:None,resume_key:None,pane_id:"windows-pane".into()};
    let request = LaunchRequest {
        pane_id: "windows-pane".into(),
        kind: "shell".into(),
        project_id: Some("windows-project".into()),
        session_id: None,
        resume_id: None,
        cwd: Some(temp.path().to_string_lossy().into()),
        profile_id: None,
        cols: 80,
        rows: 24,
    };
    let info = client
        .launch(
            spec,
            &request,
            lease.clone(),
            Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
        )
        .unwrap();
    read_marker(&client, &lease, &events, "original:");
    drop(client);
    drop(events);
    thread::sleep(Duration::from_millis(1500));
    let reopened = connect(temp.path());
    let records = reopened.list().unwrap();
    assert_eq!(records[0].info.id, info.id);
    assert_eq!(records[0].info.state, "running");
    let lease = uuid::Uuid::new_v4().to_string();
    let (tx, events) = mpsc::channel();
    reopened
        .attach(
            &info.id,
            lease.clone(),
            Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
        )
        .unwrap();
    read_marker(&reopened, &lease, &events, "while-ui-closed");
    reopened.write(&info.id, "hello-after-reopen\r").unwrap();
    read_marker(&reopened, &lease, &events, "received:hello-after-reopen");
    reopened.stop(&info.id).unwrap();
    reopened.forget(&info.id).unwrap();
    reopened.shutdown_broker().unwrap();
}
#[test]
fn private_named_pipe_rejects_an_inherited_shared_directory() {
    let temp = tempfile::tempdir().unwrap();
    // Temp inherits Windows user/System/Administrators ACLs. Only the specially
    // created owner-only broker directory is accepted, never silently tightened.
    std::fs::create_dir(temp.path().join("runtime-broker-v1")).unwrap();
    assert!(BrokerClient::connect(
        temp.path(),
        Path::new(env!("CARGO_BIN_EXE_sessionbay-broker"))
    )
    .is_err());
}
