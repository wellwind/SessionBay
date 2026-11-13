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
        AgentKind::Claude => "2.1.316 (Claude Code)",
        AgentKind::OpenCode => "opencode v2.2.3",
        _ => "1.4.2",
    };
    let record = if kind == AgentKind::OpenCode {
        "printf '\\033]7501;state=working:id=ses_fromPTY\\007'"
    } else {
        ""
    };
    fs::write(&path, format!("#!/bin/sh\nif [ \"$1\" = --version ]; then printf '{version}\\n'; exit; fi\nprintf '\\033]7501;state=working:app=synthetic\\007'\n{record}\nread -r value\nprintf '\\033]7501;state=done:app=synthetic\\033\\\\'\n")).unwrap();
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
    for kind in [
        AgentKind::Codex,
        AgentKind::Grok,
        AgentKind::Antigravity,
        AgentKind::Claude,
        AgentKind::OpenCode,
    ] {
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

#[test]
fn claude_and_opencode_launches_enable_the_same_capability_reply() {
    for kind in [AgentKind::Claude, AgentKind::OpenCode] {
        let root = tempfile::tempdir().unwrap();
        let host = Host::open(root.path().into()).unwrap();
        let info = launch(&host, root.path(), kind);
        wait_status(&host, &info.id, Some(Status::Working));
        let entries = lock(&host.entries);
        let mut screen = lock(entries[&info.id].screen.as_ref().unwrap());
        screen.event(TerminalEvent::Output {
            runtime_id: info.id.clone(),
            sequence: 100,
            data: b"\x1b]7501;?\x07".into(),
        });
        assert_eq!(screen.replies(), b"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\");
        drop(screen);
        drop(entries);
        host.runtime.shutdown().unwrap();
    }
}

#[test]
fn claude_session_start_binds_identity_without_replacing_terminal_status() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::open(root.path().into()).unwrap();
    let info = launch(&host, root.path(), AgentKind::Claude);
    wait_status(&host, &info.id, Some(Status::Working));
    let before = poll(&host, &info.id, true)
        .into_iter()
        .find_map(|event| match event {
            UiEvent::TerminalStatus { generation, .. } => Some(generation),
            _ => None,
        })
        .unwrap();
    let launch = lock(&host.provider_hooks).keys().next().unwrap().clone();
    let callback = crate::provider_hooks::Callback::parse(
        "SessionStart",
        br#"{"hook_event_name":"SessionStart","session_id":"native-id","source":"startup"}"#,
    )
    .unwrap()
    .unwrap();
    host.receive_provider_hook(&launch, callback.clone())
        .unwrap();
    host.receive_provider_hook(&launch, callback.clone())
        .unwrap();
    assert_eq!(
        host.records()[0].provider_session_id.as_deref(),
        Some("native-id")
    );
    assert!(poll(&host, &info.id, true).iter().any(|event| matches!(event,
        UiEvent::TerminalStatus { generation, status: Some(Status::Working), .. } if generation == &before)));
    host.fail_provider_hook(&launch);
    wait_status(&host, &info.id, Some(Status::Working));
    let mut wrong = callback.clone();
    wrong.session = "wrong-session".into();
    assert!(host.receive_provider_hook(&launch, wrong).is_err());
    for event in ["Notification", "PermissionRequest", "Stop"] {
        let mut status_hook = callback.clone();
        status_hook.event = event.into();
        assert!(host.receive_provider_hook(&launch, status_hook).is_err());
    }
    host.runtime.shutdown().unwrap();
    assert!(host.receive_provider_hook(&launch, callback).is_err());
}

#[test]
fn opencode_ids_are_bounded_hints_and_never_broker_identity() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::open(root.path().into()).unwrap();
    let info = launch(&host, root.path(), AgentKind::OpenCode);
    wait_status(&host, &info.id, Some(Status::Working));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !host.records()[0]
        .terminal_session_hint
        .as_ref()
        .unwrap()
        .ids
        .iter()
        .any(|id| id == "ses_fromPTY")
    {
        assert!(Instant::now() < deadline, "missing decoded terminal hint");
        std::thread::sleep(Duration::from_millis(10));
    }
    let launch = lock(&host.provider_hooks).keys().next().unwrap().clone();
    host.receive_terminal_session_hint("wrong-launch", &info.id, "ses_wrongLaunch");
    host.receive_terminal_session_hint(&launch, "other-runtime", "ses_wrongRuntime");
    host.receive_terminal_session_hint(&launch, &info.id, "not-a-session");
    host.receive_terminal_session_hint(&launch, &info.id, "ses_hint");
    host.receive_terminal_session_hint(&launch, &info.id, "ses_hint");
    assert!(host
        .receive_provider_state(
            &launch,
            crate::provider_hooks::StateReport {
                session: "ses_fromPTY".into(),
                turn: None,
                sequence: 1,
                observation: crate::agent_activity::Observation::Busy,
            }
        )
        .is_err());
    let record = host.records().remove(0);
    assert!(record.provider_session_id.is_none());
    assert_eq!(
        record.terminal_session_hint.unwrap().ids,
        ["ses_fromPTY", "ses_hint"]
    );
    host.revoke_provider_hooks(AgentKind::OpenCode);
    host.receive_terminal_session_hint(&launch, &info.id, "ses_late");
    assert_eq!(
        host.records()[0]
            .terminal_session_hint
            .as_ref()
            .unwrap()
            .ids,
        ["ses_fromPTY", "ses_hint"]
    );
    host.runtime.shutdown().unwrap();
}

#[test]
fn below_minimum_and_opted_out_launches_only_show_process_state() {
    for (kind, version, opt_in, notice) in [
        (AgentKind::Claude, "2.1.294", true, true),
        (AgentKind::OpenCode, "2.1.9", true, true),
        (AgentKind::Claude, "2.1.316", false, false),
        (AgentKind::OpenCode, "2.2.3", false, false),
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic-cli");
        fs::write(&path, format!("#!/bin/sh\nif [ \"$1\" = --version ]; then printf '{version}\\n'; exit; fi\nexec sleep 60\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let host = Host::open(root.path().into()).unwrap();
        let Response::Runtime { info: Some(info) } = host
            .handle(Request::Launch {
                generation: host.generation.clone(),
                spec: Box::new(LaunchSpec {
                    executable: path.to_string_lossy().into_owned(),
                    args: vec![],
                    cwd: root.path().into(),
                    env: if opt_in {
                        HashMap::from([(crate::provider_hooks::OPT_IN.into(), "live".into())])
                    } else {
                        HashMap::new()
                    },
                    session_id: None,
                    resume_key: None,
                    pane_id: "no-status".into(),
                }),
                kind: kind.as_str().into(),
                project_id: None,
                profile_id: None,
                resume_id: None,
                home_directory: false,
                cols: 80,
                rows: 24,
            })
            .unwrap()
        else {
            panic!("missing runtime");
        };
        assert_eq!(info.state, "running");
        assert!(!poll(&host, &info.id, true)
            .iter()
            .any(|event| matches!(event, UiEvent::TerminalStatus { .. })));
        let entries = lock(&host.entries);
        let mut screen = lock(entries[&info.id].screen.as_ref().unwrap());
        screen.event(TerminalEvent::Output {
            runtime_id: info.id.clone(),
            sequence: 1,
            data: b"\x1b]7501;?\x07".into(),
        });
        assert!(screen.replies().is_empty());
        assert_eq!(screen.poll(&info.id, None).unwrap().iter().any(|event| matches!(event, UiEvent::Snapshot { data, .. } if String::from_utf8_lossy(data).contains("[Session Bay]"))), notice);
        drop(screen);
        drop(entries);
        host.runtime.shutdown().unwrap();
    }
}

fn launch_shell(host: &Arc<Host>, root: &Path, script: &str) -> RuntimeInfo {
    let path = root.join("synthetic-shell-tool");
    fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let Response::Runtime { info: Some(info) } = host
        .handle(Request::Launch {
            generation: host.generation.clone(),
            spec: Box::new(LaunchSpec {
                executable: path.to_string_lossy().into_owned(),
                args: vec![],
                cwd: root.into(),
                env: HashMap::new(),
                session_id: None,
                resume_key: None,
                pane_id: "shell-pane".into(),
            }),
            kind: "shell".into(),
            project_id: None,
            profile_id: None,
            resume_id: None,
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
fn wait_exit(host: &Arc<Host>, id: &str) {
    let until = Instant::now() + Duration::from_secs(5);
    while host
        .runtime
        .list()
        .iter()
        .any(|r| r.id == id && r.state == "running")
    {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn shell_programs_report_status_that_never_binds_identity() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::open(root.path().into()).unwrap();
    let info = launch_shell(
        &host,
        root.path(),
        "printf '\\033]7501;state=working:id=ses_fromShell:app=synthetic\\033\\\\'\nread -r value\nprintf '\\033]7501;state=done\\007'",
    );
    wait_status(&host, &info.id, Some(Status::Working));
    // Clients without terminal status support never receive shell status.
    assert!(!poll(&host, &info.id, false)
        .iter()
        .any(|event| matches!(event, UiEvent::TerminalStatus { .. })));
    host.runtime.write(&info.id, "finish\n").unwrap();
    wait_status(&host, &info.id, Some(Status::Done));
    wait_exit(&host, &info.id);
    wait_status(&host, &info.id, Some(Status::Done));
    let record = host
        .records()
        .into_iter()
        .find(|record| record.info.id == info.id)
        .unwrap();
    assert!(record.provider_session_id.is_none());
    assert!(record.terminal_session_hint.is_none());
    host.runtime.shutdown().unwrap();
}
#[test]
fn shell_exit_drops_transient_status_and_quiet_shells_stay_silent() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::open(root.path().into()).unwrap();
    let working = launch_shell(
        &host,
        root.path(),
        "printf '\\033]7501;state=blocked:kind=question\\007'\nread -r value",
    );
    wait_status(&host, &working.id, Some(Status::Question));
    host.runtime.write(&working.id, "answer\n").unwrap();
    wait_exit(&host, &working.id);
    wait_status(&host, &working.id, None);
    host.runtime.shutdown().unwrap();

    let root = tempfile::tempdir().unwrap();
    let host = Host::open(root.path().into()).unwrap();
    let quiet = launch_shell(
        &host,
        root.path(),
        "printf 'plain output\\n'\nread -r value",
    );
    std::thread::sleep(Duration::from_millis(200));
    assert!(!poll(&host, &quiet.id, true)
        .iter()
        .any(|event| matches!(event, UiEvent::TerminalStatus { .. })));
    host.runtime.shutdown().unwrap();
}
