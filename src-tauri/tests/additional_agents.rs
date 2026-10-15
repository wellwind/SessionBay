#![cfg(unix)]
mod common;

use sessionbay_lib::{
    config::{AgentLaunchOptions, ConfigStore, Settings},
    models::{AgentKind, HistorySource},
    service::{LaunchRequest, Service},
};
use std::fs;

fn request(kind: &str, cwd: &std::path::Path) -> LaunchRequest {
    LaunchRequest {
        pane_id: "additional-agent-test".into(),
        kind: kind.into(),
        project_id: None,
        session_id: None,
        resume_id: None,
        cwd: Some(cwd.to_string_lossy().into_owned()),
        profile_id: None,
        cols: 80,
        rows: 24,
    }
}

#[test]
fn old_settings_migrate_missing_agent_fields_without_resetting_preferences() {
    let temp = tempfile::tempdir().unwrap();
    let store = ConfigStore::open(temp.path().join("app")).unwrap();
    let mut value = serde_json::to_value(Settings::default()).unwrap();
    value.as_object_mut().unwrap().remove("agentOptions");
    let executable = value["executables"].as_object_mut().unwrap();
    executable.remove("grok");
    executable.remove("antigravity");
    executable.insert("codex".into(), "/synthetic/custom-codex".into());
    value["theme"] = "light".into();
    value["fontSize"] = 19.into();
    value["onboardingComplete"] = true.into();
    let before = serde_json::to_vec(&value).unwrap();
    fs::write(store.directory.join("settings.json"), &before).unwrap();
    let (settings, warnings) = store.load_settings();
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(settings.executables.codex, "/synthetic/custom-codex");
    assert_eq!(settings.executables.grok, "grok");
    assert_eq!(settings.executables.antigravity, "agy");
    assert_eq!(settings.theme, "light");
    assert_eq!(settings.font_size, 19);
    assert!(settings.onboarding_complete);
    for kind in [
        AgentKind::Codex,
        AgentKind::Claude,
        AgentKind::Grok,
        AgentKind::Antigravity,
    ] {
        let options = settings.agent_options.for_kind(kind);
        assert!(options.extra_args.is_empty());
        assert!(!options.bypass_permissions);
    }
    assert_eq!(
        fs::read(store.directory.join("settings.json")).unwrap(),
        before
    );
    // Partial objects receive defaults too; an invalid supplied value is not silently reset.
    value["agentOptions"] = serde_json::json!({"grok":{"extraArgs":["--model","custom model"]}});
    let settings: Settings = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(
        settings.agent_options.grok.extra_args,
        vec!["--model", "custom model"]
    );
    assert!(!settings.agent_options.grok.bypass_permissions);
    value["agentOptions"]["grok"]["bypassPermissions"] = "yes".into();
    assert!(serde_json::from_value::<Settings>(value).is_err());
}

#[test]
fn all_agent_plans_and_previews_use_exact_arguments_without_starting_processes() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().join("project with 'quotes';$(never)");
    fs::create_dir(&cwd).unwrap();
    let service = Service::open(temp.path().join("app")).unwrap();
    let mut settings = service.settings().unwrap();
    let executable = common::noop_executable(temp.path());
    settings.executables.codex = executable.clone();
    settings.executables.claude = executable.clone();
    settings.executables.grok = executable.clone();
    settings.executables.antigravity = executable;
    settings.sources = vec![HistorySource {
        id: "grok-test".into(),
        kind: AgentKind::Grok,
        root: temp.path().join("grok home").to_string_lossy().into_owned(),
        enabled: true,
    }];
    let option = AgentLaunchOptions {
        extra_args: vec!["--model".into(), "quoted model;$(literal)".into()],
        bypass_permissions: false,
    };
    settings.agent_options.codex = option.clone();
    settings.agent_options.claude = option.clone();
    settings.agent_options.grok = option.clone();
    settings.agent_options.antigravity = option;
    service.save_settings(settings.clone()).unwrap();
    for kind in ["codex", "claude", "grok", "antigravity"] {
        let request = request(kind, &cwd);
        let plan = service.plan_launch(&request).unwrap();
        let preview = service.preview_launch(&request).unwrap();
        assert_eq!(preview.executable, plan.executable);
        assert_eq!(preview.args, plan.args);
        assert_eq!(preview.cwd, plan.cwd.to_string_lossy());
        assert_eq!(plan.cwd, cwd);
        assert_eq!(&plan.args[..2], &["--model", "quoted model;$(literal)"]);
        if kind == "codex" {
            assert_eq!(plan.args[2], "--cd");
            assert_eq!(plan.args[3], cwd.to_string_lossy());
        } else {
            assert_eq!(plan.args.len(), 2);
        }
        assert!(plan.session_id.is_none());
    }
    for (kind, flag) in [("grok", "--resume"), ("antigravity", "--conversation")] {
        let mut request = request(kind, &cwd);
        request.resume_id = Some("synthetic-id.123".into());
        let plan = service.plan_launch(&request).unwrap();
        assert_eq!(&plan.args[..2], &[flag, "synthetic-id.123"]);
        assert!(
            plan.session_id.is_none(),
            "manual IDs must not masquerade as indexed session IDs"
        );
        if kind == "grok" {
            assert_eq!(plan.env.get("GROK_HOME"), Some(&settings.sources[0].root));
        } else {
            assert!(!plan.env.contains_key("GROK_HOME"));
        }
        assert!(!plan.args.iter().any(|a| a == "--session-id"));
    }
    assert!(
        service.runtime.list().is_empty(),
        "preview must not launch an agent"
    );
}

#[test]
fn manual_resume_rejects_unsafe_ids_wrong_agents_and_ambiguous_sources() {
    let temp = tempfile::tempdir().unwrap();
    let service = Service::open(temp.path().join("app")).unwrap();
    let mut settings = service.settings().unwrap();
    let executable = common::noop_executable(temp.path());
    settings.executables.grok = executable.clone();
    settings.executables.antigravity = executable;
    settings.sources.clear();
    service.save_settings(settings.clone()).unwrap();
    for kind in ["grok", "antigravity"] {
        for id in [
            "", "--help", "one two", "x;sh", "x\n", "../x", "x/child", "x\0z",
        ] {
            let mut request = request(kind, temp.path());
            request.resume_id = Some(id.into());
            assert!(service.plan_launch(&request).is_err(), "{kind}: {id:?}");
        }
        let mut request = request(kind, temp.path());
        request.resume_id = Some("ok-id".into());
        request.session_id = Some("catalog-id".into());
        assert!(service.plan_launch(&request).is_err());
    }
    for kind in ["shell", "codex", "claude"] {
        let mut request = request(kind, temp.path());
        request.resume_id = Some("ok-id".into());
        assert!(service
            .plan_launch(&request)
            .unwrap_err()
            .contains("Manual resume"));
    }
    settings.sources = (0..2)
        .map(|i| HistorySource {
            id: format!("source-{i}"),
            kind: AgentKind::Grok,
            root: temp
                .path()
                .join(format!("grok-{i}"))
                .to_string_lossy()
                .into_owned(),
            enabled: true,
        })
        .collect();
    service.save_settings(settings).unwrap();
    let mut request = request("grok", temp.path());
    request.resume_id = Some("ok-id".into());
    assert!(service
        .plan_launch(&request)
        .unwrap_err()
        .contains("ambiguous"));
}

#[test]
fn detecting_installation_paths_ignores_dangerous_launch_options() {
    let temp = tempfile::tempdir().unwrap();
    let executable = common::noop_executable(temp.path());
    let mut settings = Settings::default();
    settings.executables.grok = executable.clone();
    settings.executables.antigravity = executable;
    settings.agent_options.grok.bypass_permissions = true;
    let installations = sessionbay_lib::config::detect_paths(&settings);
    assert_eq!(installations.len(), 4);
    assert!(installations
        .iter()
        .any(|i| i.kind == AgentKind::Grok && i.available));
    assert!(installations
        .iter()
        .any(|i| i.kind == AgentKind::Antigravity && i.available));
}

#[test]
fn version_probe_uses_only_documented_version_argument_never_launch_flags() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("synthetic version probe");
    fs::write(&executable, "#!/bin/sh\n[ \"$#\" = 1 ] || exit 9\ncase \"$1\" in --version|version) printf 'synthetic-%s\\n' \"$1\";; *) exit 8;; esac\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut settings = Settings::default();
    let path = executable.to_string_lossy().into_owned();
    settings.executables.codex = path.clone();
    settings.executables.claude = path.clone();
    settings.executables.grok = path.clone();
    settings.executables.antigravity = path;
    settings.agent_options.codex.bypass_permissions = true;
    settings.agent_options.claude.bypass_permissions = true;
    settings.agent_options.grok.bypass_permissions = true;
    settings.agent_options.antigravity.bypass_permissions = true;
    for installation in sessionbay_lib::config::detect(&settings) {
        assert!(installation.available);
        assert!(installation.error.is_none(), "{:?}", installation.error);
        let expected = if installation.kind == AgentKind::Grok {
            "synthetic-version"
        } else {
            "synthetic---version"
        };
        assert_eq!(installation.version.as_deref(), Some(expected));
    }
}

#[test]
fn manual_and_indexed_resume_share_atomic_provider_identity_without_fake_catalog_ids() {
    use sessionbay_lib::models::SessionQuery;
    use std::{
        os::unix::fs::{symlink, PermissionsExt},
        sync::{atomic::AtomicBool, Arc},
    };
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let grok_root = temp.path().join("grok");
    let session = grok_root.join("sessions/test/synthetic-conversation");
    fs::create_dir_all(&session).unwrap();
    let summary = serde_json::json!({"info":{"id":"synthetic-conversation","cwd":project},"generated_title":"Synthetic conversation","last_active_at":"2026-01-01T00:00:00Z"});
    fs::write(
        session.join("summary.json"),
        serde_json::to_vec(&summary).unwrap(),
    )
    .unwrap();
    fs::write(session.join("updates.jsonl"), format!("{}\n", serde_json::json!({"method":"session/update","params":{"sessionId":"synthetic-conversation","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Synthetic only"}}}}))).unwrap();
    let executable = temp.path().join("synthetic sleeper");
    fs::write(&executable, "#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let service = Service::open(temp.path().join("app")).unwrap();
    let mut settings = service.settings().unwrap();
    settings.executables.grok = executable.to_string_lossy().into_owned();
    settings.executables.antigravity = settings.executables.grok.clone();
    settings.sources = vec![HistorySource {
        id: "grok".into(),
        kind: AgentKind::Grok,
        root: grok_root.to_string_lossy().into_owned(),
        enabled: true,
    }];
    service.save_settings(settings.clone()).unwrap();
    service
        .catalog
        .sync(&settings.sources, &AtomicBool::new(false), |_| {})
        .unwrap();
    let indexed = service
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    let mut manual = request("grok", &project);
    manual.resume_id = Some(indexed.external_id.clone());
    let mut catalog = manual.clone();
    catalog.resume_id = None;
    catalog.session_id = Some(indexed.id.clone());
    catalog.pane_id = "indexed-pane".into();
    assert_eq!(
        service.plan_launch(&manual).unwrap().resume_key,
        service.plan_launch(&catalog).unwrap().resume_key
    );
    let first = service.launch(&manual, Arc::new(|_| Ok(()))).unwrap();
    assert!(first.session_id.is_none());
    manual.pane_id = "second-manual-pane".into();
    assert_eq!(
        service.launch(&manual, Arc::new(|_| Ok(()))).unwrap().id,
        first.id
    );
    assert_eq!(
        service.launch(&catalog, Arc::new(|_| Ok(()))).unwrap().id,
        first.id
    );
    let alias = temp.path().join("grok alias");
    symlink(&grok_root, &alias).unwrap();
    settings.sources[0].root = alias.to_string_lossy().into_owned();
    service.save_settings(settings.clone()).unwrap();
    assert_eq!(
        service.launch(&manual, Arc::new(|_| Ok(()))).unwrap().id,
        first.id,
        "canonical root aliases deduplicate"
    );
    let mut agy = manual.clone();
    agy.kind = "antigravity".into();
    agy.pane_id = "agy-first".into();
    let agy_first = service.launch(&agy, Arc::new(|_| Ok(()))).unwrap();
    assert_ne!(
        agy_first.id, first.id,
        "provider identity must remain distinct"
    );
    agy.pane_id = "agy-second".into();
    assert_eq!(
        service.launch(&agy, Arc::new(|_| Ok(()))).unwrap().id,
        agy_first.id
    );
    assert_eq!(
        service
            .runtime
            .list()
            .iter()
            .filter(|r| r.state == "running")
            .count(),
        2
    );
    service.runtime.stop(&first.id).unwrap();
    settings.sources[0].root = grok_root.to_string_lossy().into_owned();
    service.save_settings(settings.clone()).unwrap();
    // Reverse order is also deduplicated; the public indexed ID belongs to the first pane.
    let first_indexed = service.launch(&catalog, Arc::new(|_| Ok(()))).unwrap();
    assert_eq!(
        first_indexed.session_id.as_deref(),
        Some(indexed.id.as_str())
    );
    assert_eq!(
        service.launch(&manual, Arc::new(|_| Ok(()))).unwrap().id,
        first_indexed.id
    );
    // Repointing the same configured source ID may reuse the catalog hash, but
    // must never silently focus the writer for its previous source directory.
    let second_root = temp.path().join("other grok");
    let second_session = second_root.join("sessions/test/synthetic-conversation");
    fs::create_dir_all(&second_session).unwrap();
    for name in ["summary.json", "updates.jsonl"] {
        fs::copy(session.join(name), second_session.join(name)).unwrap();
    }
    settings.sources[0].root = second_root.to_string_lossy().into_owned();
    service.save_settings(settings.clone()).unwrap();
    let mut unindexed_b = manual.clone();
    unindexed_b.pane_id = "manual-before-reindex-b".into();
    let running_b = service.launch(&unindexed_b, Arc::new(|_| Ok(()))).unwrap();
    catalog.pane_id = "stale-indexed-a-pane".into();
    assert!(
        service.launch(&catalog, Arc::new(|_| Ok(()))).is_err(),
        "stale root-A catalog metadata must not focus root-B runtime before reindex"
    );
    service.runtime.stop(&running_b.id).unwrap();
    service
        .catalog
        .sync(&settings.sources, &AtomicBool::new(false), |_| {})
        .unwrap();
    catalog.pane_id = "repointed-source-pane".into();
    let repointed = service.launch(&catalog, Arc::new(|_| Ok(()))).unwrap();
    assert_ne!(repointed.id, first_indexed.id);
    assert_eq!(repointed.session_id, first_indexed.session_id);
    // A root symlink can be repointed without changing either stored root
    // string. Cached transcript inode provenance still prevents wrong focus.
    settings.sources[0].root = alias.to_string_lossy().into_owned();
    service.save_settings(settings.clone()).unwrap();
    service
        .catalog
        .sync(&settings.sources, &AtomicBool::new(false), |_| {})
        .unwrap();
    fs::remove_file(&alias).unwrap();
    symlink(&second_root, &alias).unwrap();
    catalog.pane_id = "repointed-symlink-stale-pane".into();
    assert!(
        service.launch(&catalog, Arc::new(|_| Ok(()))).is_err(),
        "same root string with changed symlink target must not focus another source's runtime"
    );
    service.shutdown().unwrap();
}
