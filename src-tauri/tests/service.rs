#![cfg(unix)]
use sessionbay_lib::{
    models::{AgentKind, HistorySource, SessionQuery},
    runtime::TerminalEvent,
    service::{LaunchRequest, Service},
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::{atomic::AtomicBool, mpsc, Arc},
    time::{Duration, Instant},
};

#[test]
fn cross_agent_search_preview_resume_and_second_terminal() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project with spaces;$(literal)");
    fs::create_dir(&project).unwrap();
    let codex = temp.path().join("codex source");
    let claude = temp.path().join("claude source");
    fs::create_dir_all(codex.join("sessions")).unwrap();
    fs::create_dir_all(claude.join("projects/p")).unwrap();
    let codex_id = "11111111-1111-4111-8111-111111111111";
    let claude_id = "22222222-2222-4222-8222-222222222222";
    let codex_history = format!(
        "{}\n{}\n",
        serde_json::json!({"type":"session_meta","timestamp":"2026-10-15T01:00:00Z","payload":{"id":codex_id,"cwd":project}}),
        serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"修復登入 auth_flow"}]}})
    );
    let claude_history = format!(
        "{}\n",
        serde_json::json!({"type":"user","sessionId":claude_id,"cwd":project,"timestamp":"2026-10-15T02:00:00Z","message":{"content":"繼續修復登入 auth_flow"}})
    );
    let codex_file = codex.join("sessions/one.jsonl");
    let claude_file = claude.join("projects/p/two.jsonl");
    fs::write(&codex_file, &codex_history).unwrap();
    fs::write(&claude_file, &claude_history).unwrap();
    let cli = temp.path().join("fake agent");
    fs::write(&cli,"#!/bin/sh\nprintf 'CWD:%s\\n' \"$PWD\"\nprintf 'CODEX_HOME:%s\\nCLAUDE_CONFIG_DIR:%s\\n' \"$CODEX_HOME\" \"$CLAUDE_CONFIG_DIR\"\nfor arg in \"$@\"; do printf 'ARG:%s\\n' \"$arg\"; done\n").unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
    let service = Service::open(temp.path().join("app")).unwrap();
    let mut settings = service.settings().unwrap();
    settings.sources = vec![
        HistorySource {
            id: "codex-test".into(),
            kind: AgentKind::Codex,
            root: codex.to_string_lossy().into(),
            enabled: true,
        },
        HistorySource {
            id: "claude-test".into(),
            kind: AgentKind::Claude,
            root: claude.to_string_lossy().into(),
            enabled: true,
        },
    ];
    settings.executables.codex = cli.to_string_lossy().into();
    settings.executables.claude = cli.to_string_lossy().into();
    service.save_settings(settings.clone()).unwrap();
    service
        .catalog
        .sync(&settings.sources, &AtomicBool::new(false), |_| {})
        .unwrap();
    let projects = service.catalog.projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].session_count, 2);
    let sessions = service
        .catalog
        .query(&SessionQuery {
            query: Some("登入".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(sessions.total, 2);
    for session in sessions.items {
        let preview = service.catalog.transcript(&session.id, None, 40).unwrap();
        assert!(preview.messages[0].text.contains("auth_flow"));
        assert!(!preview.stale);
        let request = LaunchRequest {
            pane_id: format!("pane-{}", session.kind.as_str()),
            kind: session.kind.as_str().into(),
            project_id: Some(projects[0].id.clone()),
            session_id: Some(session.id.clone()),
            cwd: None,
            profile_id: None,
            cols: 80,
            rows: 24,
        };
        let (tx, rx) = mpsc::channel();
        service
            .launch(
                &request,
                Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
            )
            .unwrap();
        let mut output = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap()
            {
                TerminalEvent::Output {
                    runtime_id,
                    sequence,
                    data,
                } => {
                    output.extend(data);
                    service.runtime.ack(&runtime_id, sequence).unwrap();
                }
                TerminalEvent::Exit { exit_code, .. } => {
                    assert_eq!(exit_code, Some(0));
                    break;
                }
                TerminalEvent::Error { message, .. } => panic!("{message}"),
            }
        }
        let output = String::from_utf8(output).unwrap();
        assert!(output.contains(&format!("CWD:{}", project.display())));
        assert!(output.contains(&format!("ARG:{}", session.external_id)));
        match session.kind {
            AgentKind::Codex => {
                assert!(output.contains("ARG:resume"));
                assert!(output.contains("ARG:--cd"));
                assert!(output.contains(&format!("CODEX_HOME:{}", codex.display())));
            }
            AgentKind::Claude => {
                assert!(output.contains("ARG:--resume"));
                assert!(output.contains(&format!("CLAUDE_CONFIG_DIR:{}", claude.display())));
            }
        }
    }
    let mut request = LaunchRequest {
        pane_id: "ordinary-shell".into(),
        kind: "shell".into(),
        project_id: Some(projects[0].id.clone()),
        session_id: None,
        cwd: None,
        profile_id: None,
        cols: 80,
        rows: 24,
    };
    let mut settings = service.settings().unwrap();
    settings.profiles[0].executable = "/bin/sh".into();
    settings.profiles[0].args = vec!["-c".into(), "printf second-terminal".into()];
    service.save_settings(settings).unwrap();
    let (tx, rx) = mpsc::channel();
    let info = service
        .launch(
            &request,
            Arc::new(move |e| tx.send(e).map_err(|e| e.to_string())),
        )
        .unwrap();
    assert!(info.session_id.is_none());
    loop {
        match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
            TerminalEvent::Output {
                runtime_id,
                sequence,
                ..
            } => service.runtime.ack(&runtime_id, sequence).unwrap(),
            TerminalEvent::Exit { exit_code, .. } => {
                assert_eq!(exit_code, Some(0));
                break;
            }
            TerminalEvent::Error { message, .. } => panic!("{message}"),
        }
    }
    request.cols = 0;
    assert!(service.plan_launch(&request).is_err());
    service.shutdown().unwrap();
    assert_eq!(fs::read_to_string(codex_file).unwrap(), codex_history);
    assert_eq!(fs::read_to_string(claude_file).unwrap(), claude_history);
}
