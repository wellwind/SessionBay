mod common;

use sessionbay_lib::{
    models::{AgentKind, HistorySource, IndexStatus, SessionQuery},
    service::{LaunchRequest, Service},
};
use std::{
    fs,
    path::Path,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

fn request(kind: AgentKind, cwd: &Path) -> LaunchRequest {
    LaunchRequest {
        pane_id: "synthetic-agent-pane".into(),
        kind: kind.as_str().into(),
        project_id: None,
        session_id: None,
        resume_id: None,
        cwd: Some(cwd.to_string_lossy().into_owned()),
        profile_id: None,
        cols: 80,
        rows: 24,
    }
}

fn index(service: &Arc<Service>, rebuild: bool) -> IndexStatus {
    service.start_index(rebuild).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let status = service.index_status().unwrap();
        if !status.running {
            assert!(status.errors.is_empty(), "{:?}", status.errors);
            return status;
        }
        assert!(Instant::now() < deadline, "index did not finish");
        thread::sleep(Duration::from_millis(5));
    }
}

fn history(root: &Path, project: &Path, id: &str, text: &str) {
    fs::create_dir_all(root.join("sessions")).unwrap();
    fs::write(root.join("sessions").join(format!("{id}.jsonl")), format!("{}\n{}\n",
        serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":project}}),
        serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}}),
    )).unwrap();
}

fn count(service: &Service, query: &str) -> u64 {
    service
        .catalog
        .query(&SessionQuery {
            query: Some(query.into()),
            ..Default::default()
        })
        .unwrap()
        .total
}

#[test]
fn every_disabled_provider_rejects_new_launch_and_resume_without_affecting_shell() {
    let temp = tempfile::tempdir().unwrap();
    let service = Service::open(temp.path().join("app")).unwrap();
    let executable = common::noop_executable(temp.path());
    let mut settings = service.settings().unwrap();
    settings.executables.codex = executable.clone();
    settings.executables.claude = executable.clone();
    settings.executables.grok = executable.clone();
    settings.executables.antigravity = executable.clone();
    settings.executables.opencode = executable.clone();
    settings.profiles[0].executable = executable;
    settings.profiles[0].args.clear();
    service.save_settings(settings.clone()).unwrap();
    for kind in AgentKind::ALL {
        assert!(
            service.plan_launch(&request(kind, temp.path())).is_ok(),
            "{kind:?}"
        );
        settings.agent_enabled.insert(kind.as_str().into(), false);
    }
    service.save_settings(settings.clone()).unwrap();
    for kind in AgentKind::ALL {
        let mut launch = request(kind, temp.path());
        for (session, resume) in [
            (None, None),
            (Some("synthetic-indexed"), None),
            (None, Some("ses_synthetic")),
        ] {
            launch.session_id = session.map(str::to_owned);
            launch.resume_id = resume.map(str::to_owned);
            assert!(
                service
                    .plan_launch(&launch)
                    .unwrap_err()
                    .contains("is disabled"),
                "{kind:?}"
            );
            assert!(
                service
                    .preview_launch(&launch)
                    .unwrap_err()
                    .contains("is disabled"),
                "{kind:?}"
            );
            assert!(
                service
                    .launch(&launch, Arc::new(|_| Ok(())))
                    .unwrap_err()
                    .contains("is disabled"),
                "{kind:?}"
            );
        }
    }
    let mut shell = request(AgentKind::Codex, temp.path());
    shell.kind = "shell".into();
    assert!(service.plan_launch(&shell).is_ok());
    for kind in AgentKind::ALL {
        settings.agent_enabled.insert(kind.as_str().into(), true);
    }
    service.save_settings(settings).unwrap();
    for kind in AgentKind::ALL {
        assert!(service.plan_launch(&request(kind, temp.path())).is_ok());
    }
}

#[test]
fn service_pause_preserves_history_and_settings_then_enable_resumes_indexing() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("codex");
    history(&root, temp.path(), "old-session", "cachedneedle");
    let service = Service::open(temp.path().join("app")).unwrap();
    let mut settings = service.settings().unwrap();
    settings.sources = vec![HistorySource {
        id: "synthetic-codex".into(),
        kind: AgentKind::Codex,
        root: root.to_string_lossy().into_owned(),
        enabled: true,
    }];
    settings.executables.codex = common::noop_executable(temp.path());
    settings.agent_options.codex.extra_args = vec!["--model".into(), "synthetic-model".into()];
    service.save_settings(settings.clone()).unwrap();
    index(&service, false);
    assert_eq!(count(&service, "cachedneedle"), 1);
    settings.agent_enabled.insert("codex".into(), false);
    service.save_settings(settings.clone()).unwrap();
    fs::remove_file(root.join("sessions/old-session.jsonl")).unwrap();
    history(&root, temp.path(), "new-session", "newneedle");
    let status = index(&service, false);
    assert_eq!(status.processed, 0);
    assert_eq!(status.sources[0].status, "paused");
    assert_eq!(count(&service, "cachedneedle"), 1);
    assert_eq!(count(&service, "newneedle"), 0);
    let saved = service.settings().unwrap();
    assert_eq!(
        serde_json::to_value(saved.sources).unwrap(),
        serde_json::to_value(&settings.sources).unwrap()
    );
    assert_eq!(saved.executables.codex, settings.executables.codex);
    assert_eq!(
        saved.agent_options.codex.extra_args,
        settings.agent_options.codex.extra_args
    );
    settings.agent_enabled.insert("codex".into(), true);
    service.save_settings(settings.clone()).unwrap();
    index(&service, false);
    assert_eq!(count(&service, "cachedneedle"), 0);
    assert_eq!(count(&service, "newneedle"), 1);
    settings.agent_enabled.insert("codex".into(), false);
    service.save_settings(settings).unwrap();
    index(&service, true);
    assert_eq!(
        count(&service, "newneedle"),
        0,
        "an explicit rebuild still clears the cache"
    );
}

#[cfg(unix)]
#[test]
fn disabling_preserves_live_indexed_focus_but_blocks_new_resume() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("codex");
    history(&root, temp.path(), "live-session", "live synthetic history");
    let service = Service::open(temp.path().join("app")).unwrap();
    let executable = temp.path().join("synthetic sleeper");
    fs::write(&executable, "#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut settings = service.settings().unwrap();
    // Owned synthetic stubs use the direct runtime, without a hook broker.
    for kind in AgentKind::ALL {
        settings.agent_hooks.insert(kind.as_str().into(), false);
    }
    settings.executables.codex = executable.to_string_lossy().into_owned();
    settings.sources = vec![HistorySource {
        id: "synthetic-codex".into(),
        kind: AgentKind::Codex,
        root: root.to_string_lossy().into_owned(),
        enabled: true,
    }];
    service.save_settings(settings.clone()).unwrap();
    index(&service, false);
    let session = service
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    let mut launch = request(AgentKind::Codex, temp.path());
    launch.session_id = Some(session.id);
    let first = service.launch(&launch, Arc::new(|_| Ok(()))).unwrap();
    settings.agent_enabled.insert("codex".into(), false);
    service.save_settings(settings.clone()).unwrap();
    assert_eq!(
        service
            .runtime
            .list()
            .iter()
            .find(|runtime| runtime.id == first.id)
            .unwrap()
            .state,
        "running"
    );
    launch.pane_id = "other-pane".into();
    assert_eq!(
        service.launch(&launch, Arc::new(|_| Ok(()))).unwrap().id,
        first.id
    );
    launch.session_id = Some("different-session".into());
    assert!(service
        .launch(&launch, Arc::new(|_| Ok(())))
        .unwrap_err()
        .contains("is disabled"));
    service.runtime.stop(&first.id).unwrap();
    launch.session_id = first.session_id.clone();
    assert!(service
        .launch(&launch, Arc::new(|_| Ok(())))
        .unwrap_err()
        .contains("is disabled"));
    settings.agent_enabled.insert("codex".into(), true);
    service.save_settings(settings).unwrap();
    let restarted = service.launch(&launch, Arc::new(|_| Ok(()))).unwrap();
    assert_ne!(restarted.id, first.id);
    service.shutdown().unwrap();
}
