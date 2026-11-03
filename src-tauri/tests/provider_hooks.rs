#![cfg(any(target_os = "linux", target_os = "macos"))]
//! Synthetic provider → production identity callback → authenticated broker IPC.
use sessionbay_lib::{
    broker::{BrokerClient, UiEvent},
    models::AgentKind,
    provider_hooks::OPT_IN,
    runtime::LaunchSpec,
    service::LaunchRequest,
    terminal_status::Status,
};
use std::{
    collections::HashMap,
    path::Path,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

#[test]
fn claude_identity_hook_and_terminal_status_have_independent_sources() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("synthetic_provider.py");
    std::fs::write(&script, r#"
import sys,json,subprocess,os
hooks=json.loads(sys.argv[sys.argv.index('--settings')+1])['hooks']
assert set(hooks)=={'SessionStart'}
assert '--plugin-dir' not in sys.argv
payload={'hook_event_name':'SessionStart','session_id':'synthetic-session','source':'startup','prompt':'SYNTHETIC_PRIVATE_PROMPT'}
command=hooks['SessionStart'][0]['hooks'][0]['command']
result=subprocess.run(command,shell=True,input=json.dumps(payload),text=True,capture_output=True,timeout=4)
assert result.returncode==0 and result.stdout.strip()=='{}'
print('\x1b]7501;state=working\x07',end='',flush=True)
for line in sys.stdin:
    if line.strip()=='idle': print('\x1b]7501;state=idle\x07',end='',flush=True)
    if line.strip()=='exit': break
"#).unwrap();
    let executable = root.path().join("synthetic-claude");
    std::fs::write(&executable, format!("#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.316 (Claude Code)'; exit; fi\nexec /usr/bin/python3 '{}' \"$@\"\n", script.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let client = BrokerClient::connect(
        root.path(),
        Path::new(env!("CARGO_BIN_EXE_sessionbay-broker")),
    )
    .unwrap();
    struct Cleanup(BrokerClient);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.shutdown_broker();
        }
    }
    let _cleanup = Cleanup(client.clone());
    let request = LaunchRequest {
        kanban_card_id: None,
        pane_id: "synthetic-pane".into(),
        kind: "claude".into(),
        project_id: None,
        session_id: None,
        resume_id: None,
        cwd: Some(root.path().to_string_lossy().into_owned()),
        profile_id: None,
        cols: 80,
        rows: 24,
    };
    let lease = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    let info = client
        .launch(
            LaunchSpec {
                executable: executable.to_string_lossy().into_owned(),
                args: vec![],
                cwd: root.path().into(),
                env: HashMap::from([(OPT_IN.into(), "live".into())]),
                session_id: None,
                resume_key: None,
                pane_id: request.pane_id.clone(),
            },
            &request,
            lease.clone(),
            Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
        )
        .unwrap();
    let wait = |expected| {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            match rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("terminal status deadline")
            {
                UiEvent::TerminalStatus { status, .. } if status == expected => return,
                UiEvent::AgentActivity {
                    observation: Some(observation),
                    ..
                } => panic!("identity hook published status: {observation:?}"),
                UiEvent::Output {
                    runtime_id,
                    sequence,
                    ..
                }
                | UiEvent::Snapshot {
                    runtime_id,
                    sequence,
                    ..
                } => client.ack(&runtime_id, sequence, &lease).unwrap(),
                _ => (),
            }
        }
    };
    wait(Some(Status::Working));
    assert_eq!(
        client.list().unwrap()[0].provider_session_id.as_deref(),
        Some("synthetic-session")
    );
    client.write(&info.id, "idle\n").unwrap();
    wait(Some(Status::Idle));
    client.revoke_provider_hooks(AgentKind::Claude).unwrap();
    wait(None);
    assert_eq!(client.list().unwrap()[0].info.state, "running");
    let metadata =
        std::fs::read_to_string(root.path().join("runtime-broker-v1/sessions.json")).unwrap();
    assert!(
        !metadata.contains("SYNTHETIC_PRIVATE_PROMPT") && !metadata.contains("SESSIONBAY_HOOK")
    );
}
