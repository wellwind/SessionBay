use super::*;
use crate::{models::AgentKind, terminal_status::Status};
use std::{
    os::unix::fs::PermissionsExt,
    path::Path,
    time::{Duration, Instant},
};

fn poll(host: &Arc<Host>, id: &str, enabled: bool) -> Vec<UiEvent> {
    let Response::Events { events } = host
        .handle(Request::Poll {
            generation: host.generation.clone(),
            runtime_id: id.into(),
            after: None,
            agent_activity: true,
            terminal_status: enabled,
            activity_after: None,
        })
        .unwrap()
    else {
        panic!("missing events");
    };
    events
}
fn wait_status(host: &Arc<Host>, id: &str, expected: Option<Status>) {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if poll(host, id, true).iter().any(
            |event| matches!(event, UiEvent::TerminalStatus { status, .. } if *status == expected),
        ) {
            return;
        }
        assert!(
            Instant::now() < until,
            "missing expected terminal status {expected:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn launch(host: &Arc<Host>, root: &Path, kind: AgentKind) -> RuntimeInfo {
    let path = root.join("synthetic-cli");
    let version = match kind {
        AgentKind::Codex => "codex-cli 0.163.0",
        AgentKind::Grok => "grok 1.0.62",
        _ => "1.4.2",
    };
    fs::write(&path, format!("#!/bin/sh\nif [ \"$1\" = --version ]; then printf '{version}\\n'; exit; fi\nprintf '\\033]7501;state=working:app=synthetic\\007'\nread -r value\nprintf '\\033]7501;state=done:app=synthetic\\033\\\\'\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let Response::Runtime { info: Some(info) } = host
        .handle(Request::Launch {
            generation: host.generation.clone(),
            spec: Box::new(LaunchSpec {
                executable: path.to_string_lossy().into_owned(),
                args: vec!["resume".into(), "native-id".into()],
                cwd: root.into(),
                env: HashMap::from([(crate::provider_hooks::OPT_IN.into(), "live".into())]),
                session_id: None,
                resume_key: None,
                pane_id: "terminal-pane".into(),
            }),
            kind: kind.as_str().into(),
            project_id: None,
            profile_id: None,
            resume_id: Some("native-id".into()),
            home_directory: false,
            cols: 80,
            rows: 24,
        })
        .unwrap()
    else {
        panic!("missing runtime");
    };
    info
}
#[test]
fn native_status_reaches_broker_poll_and_completed_exit_survives_reconnect() {
    for kind in [AgentKind::Codex, AgentKind::Grok, AgentKind::Antigravity] {
        let root = tempfile::tempdir().unwrap();
        let host = Host::open(root.path().into()).unwrap();
        let info = launch(&host, root.path(), kind);
        wait_status(&host, &info.id, Some(Status::Working));
        assert!(!poll(&host, &info.id, false)
            .iter()
            .any(|event| matches!(event, UiEvent::TerminalStatus { .. })));
        host.runtime.write(&info.id, "finish\n").unwrap();
        wait_status(&host, &info.id, Some(Status::Done));
        let until = Instant::now() + Duration::from_secs(5);
        while host
            .runtime
            .list()
            .iter()
            .any(|r| r.id == info.id && r.state == "running")
        {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(10));
        }
        wait_status(&host, &info.id, Some(Status::Done));
        host.revoke_provider_hooks(kind);
        wait_status(&host, &info.id, None);
        host.runtime.shutdown().unwrap();
    }
}
#[test]
fn revoke_clears_terminal_state_and_late_bytes_cannot_rebind() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::open(root.path().into()).unwrap();
    let info = launch(&host, root.path(), AgentKind::Grok);
    wait_status(&host, &info.id, Some(Status::Working));
    host.revoke_provider_hooks(AgentKind::Grok);
    wait_status(&host, &info.id, None);
    host.runtime.write(&info.id, "finish\n").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    wait_status(&host, &info.id, None);
    host.runtime.shutdown().unwrap();
}

/// Run only with the explicitly staged official binary and a cleared runner
/// environment. This exercises real startup, not a prompt or model turn.
#[test]
#[ignore = "requires an explicitly staged official agy binary and empty runner environment"]
fn actual_antigravity_auth_state_reaches_production_broker() {
    let binary = std::env::var("SESSIONBAY_AGY_TEST_BINARY").expect("explicit official binary");
    assert!(Path::new(&binary).is_absolute());
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("provider");
    fs::create_dir(&home).unwrap();
    fs::create_dir(root.path().join("broker")).unwrap();
    let host = Host::open(root.path().join("broker")).unwrap();
    let mut env = HashMap::from([
        (crate::provider_hooks::OPT_IN.into(), "live".into()),
        ("AGY_CLI_DISABLE_AUTO_UPDATE".into(), "true".into()),
        ("BROWSER".into(), "/bin/false".into()),
    ]);
    for name in [
        "HOME",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "TMPDIR",
    ] {
        env.insert(name.into(), home.to_string_lossy().into_owned());
    }
    let Response::Runtime { info: Some(info) } = host
        .handle(Request::Launch {
            generation: host.generation.clone(),
            spec: Box::new(LaunchSpec {
                executable: binary,
                args: vec![],
                cwd: home,
                env,
                session_id: None,
                resume_key: None,
                pane_id: "official-agy".into(),
            }),
            kind: "antigravity".into(),
            project_id: None,
            profile_id: None,
            resume_id: None,
            home_directory: false,
            cols: 80,
            rows: 24,
        })
        .unwrap()
    else {
        panic!("missing official runtime");
    };
    wait_status(&host, &info.id, Some(Status::Authentication));
    host.revoke_provider_hooks(AgentKind::Antigravity);
    wait_status(&host, &info.id, None);
    assert!(host
        .runtime
        .list()
        .iter()
        .any(|r| r.id == info.id && r.state == "running"));
    host.runtime.stop(&info.id).unwrap();
    host.runtime.shutdown().unwrap();
}
