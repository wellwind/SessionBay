//! Synthetic launch planning and owned shell-stub tests. Never runs OpenCode.
mod common;
use rusqlite::{params, Connection};
use sessionbay_lib::{
    config::AgentLaunchOptions,
    history_sources::{
        discover_history_sources, HistorySourceCandidateStatus, HistorySourceDiscoveryInputs,
    },
    launch_options,
    models::{AgentKind, HistorySource, SessionQuery},
    providers,
    service::{LaunchRequest, Service},
};
use std::{fs, sync::atomic::AtomicBool};
const ID: &str = "ses_syntheticResume";
#[test]
fn xdg_paths_and_fixed_data_store_are_explicit() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(
        providers::opencode_data_root(tmp.path(), None),
        tmp.path().join(".local/share/opencode")
    );
    assert_eq!(
        providers::opencode_data_root(tmp.path(), Some(std::ffi::OsStr::new("relative"))),
        tmp.path().join(".local/share/opencode")
    );
    assert_eq!(
        providers::opencode_data_root(tmp.path(), Some(tmp.path().as_os_str())),
        tmp.path().join("opencode")
    );
    let root = tmp.path().join("opencode");
    fs::create_dir(&root).unwrap();
    let result = discover_history_sources(
        AgentKind::OpenCode,
        &HistorySourceDiscoveryInputs {
            home: Some(tmp.path().into()),
            source_env: Some(root.clone()),
        },
        &[],
    );
    assert_eq!(result.candidates.len(), 2);
    // Discovery deliberately resolves filesystem aliases (including macOS /var
    // -> /private/var and Windows extended-length canonical paths).
    assert_eq!(
        result.candidates[0].root,
        fs::canonicalize(&root).unwrap().to_string_lossy()
    );
    assert_eq!(
        result.candidates[0].status,
        HistorySourceCandidateStatus::Found
    );
}
#[cfg(unix)]
#[test]
fn opencode_discovery_preserves_canonical_identity_through_a_directory_alias() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join(".local/share/opencode");
    let alias = tmp.path().join("store-alias");
    fs::create_dir_all(&root).unwrap();
    std::os::unix::fs::symlink(&root, &alias).unwrap();
    let source = HistorySource {
        id: "configured-opencode".into(),
        kind: AgentKind::OpenCode,
        root: root.to_string_lossy().into_owned(),
        enabled: true,
    };
    let result = discover_history_sources(
        AgentKind::OpenCode,
        &HistorySourceDiscoveryInputs {
            home: Some(tmp.path().into()),
            source_env: Some(alias.clone()),
        },
        &[source],
    );
    assert_eq!(result.candidates.len(), 1);
    let candidate = &result.candidates[0];
    assert_eq!(
        candidate.root,
        fs::canonicalize(&root).unwrap().to_string_lossy()
    );
    assert_ne!(candidate.root, alias.to_string_lossy());
    assert_eq!(candidate.status, HistorySourceCandidateStatus::Found);
    assert!(candidate.configured);
    assert_eq!(candidate.configured_source_ids, ["configured-opencode"]);
    assert!(fs::symlink_metadata(&alias)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
}

#[test]
fn safe_flags_and_identity_cannot_be_overridden() {
    let options = |args: Vec<&str>, bypass| AgentLaunchOptions {
        extra_args: args.into_iter().map(String::from).collect(),
        bypass_permissions: bypass,
    };
    assert!(
        launch_options::arguments(AgentKind::OpenCode, &options(vec![], false))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        launch_options::arguments(AgentKind::OpenCode, &options(vec![], true)).unwrap(),
        ["--auto"]
    );
    assert_eq!(
        launch_options::arguments(
            AgentKind::OpenCode,
            &options(
                vec![
                    "--model",
                    "provider/model;$(literal)",
                    "--agent",
                    "custom agent",
                    "--pure"
                ],
                false
            )
        )
        .unwrap()
        .len(),
        5
    );
    assert!(
        launch_options::validate(AgentKind::OpenCode, &options(vec!["--auto"], false)).is_err()
    );
    assert_eq!(
        launch_options::arguments(AgentKind::OpenCode, &options(vec!["--auto"], true)).unwrap(),
        ["--auto"]
    );
    for flag in [
        "--session",
        "-s",
        "--continue",
        "-c",
        "--fork",
        "--dir",
        "--config",
        "--hostname",
        "--port",
        "--cors",
        "--prompt",
        "--yolo",
        "--dangerously-skip-permissions",
        "run",
        "serve",
        "--auto=true",
    ] {
        assert!(
            launch_options::validate(AgentKind::OpenCode, &options(vec![flag], true)).is_err(),
            "{flag}"
        );
    }
}
fn setup() -> (
    tempfile::TempDir,
    std::sync::Arc<Service>,
    HistorySource,
    LaunchRequest,
) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("store ; literal");
    fs::create_dir(&root).unwrap();
    let cwd = tmp.path().join("project '中文' ; literal");
    fs::create_dir(&cwd).unwrap();
    let db = Connection::open(root.join("opencode.db")).unwrap();
    db.execute_batch(include_str!("../../fixtures/opencode/schema.sql"))
        .unwrap();
    db.execute(
        "INSERT INTO session VALUES(?1,'global',?2,'Synthetic title','1.19.2',1,1,NULL,NULL,NULL)",
        params![ID, cwd.to_string_lossy()],
    )
    .unwrap();
    drop(db);
    let service = Service::open(tmp.path().join("app")).unwrap();
    let source = HistorySource {
        id: "native-store".into(),
        kind: AgentKind::OpenCode,
        root: root.to_string_lossy().into_owned(),
        enabled: true,
    };
    let mut settings = service.settings().unwrap();
    // Owned synthetic stubs use the direct runtime, without a hook broker.
    for kind in AgentKind::ALL {
        settings.agent_hooks.insert(kind.as_str().into(), false);
    }
    settings.sources = vec![source.clone()];
    settings.executables.opencode = common::noop_executable(tmp.path());
    service.save_settings(settings).unwrap();
    service
        .catalog
        .sync(
            std::slice::from_ref(&source),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    let session = service
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    let request = LaunchRequest {
        pane_id: "indexed".into(),
        kind: "opencode".into(),
        project_id: Some(session.project_id),
        session_id: Some(session.id),
        resume_id: None,
        cwd: None,
        profile_id: None,
        cols: 80,
        rows: 24,
    };
    (tmp, service, source, request)
}
#[test]
fn indexed_and_manual_resume_share_exact_args_cwd_environment_and_identity() {
    let (_tmp, service, source, indexed) = setup();
    let manual = LaunchRequest {
        session_id: None,
        resume_id: Some(ID.into()),
        pane_id: "manual".into(),
        ..indexed.clone()
    };
    let plan = service.plan_launch(&indexed).unwrap();
    let manual_plan = service.plan_launch(&manual).unwrap();
    assert_eq!(plan.args, ["--session", ID]);
    assert_eq!(plan.resume_key, manual_plan.resume_key);
    assert_eq!(
        plan.env["OPENCODE_DB"],
        std::path::Path::new(&source.root)
            .join("opencode.db")
            .to_string_lossy()
    );
    assert!(!plan.env.contains_key("HOME"));
    assert!(!plan.env.contains_key("XDG_DATA_HOME"));
    assert_eq!(service.preview_launch(&indexed).unwrap().args, plan.args);
    let new = LaunchRequest {
        session_id: None,
        ..indexed.clone()
    };
    assert!(service.plan_launch(&new).unwrap().args.is_empty());
    let bad = LaunchRequest {
        resume_id: Some("--fork".into()),
        ..manual.clone()
    };
    assert!(service.plan_launch(&bad).is_err());
    let mut settings = service.settings().unwrap();
    settings.sources.push(HistorySource {
        id: "other".into(),
        root: format!("{}/other", source.root),
        ..source
    });
    service.save_settings(settings).unwrap();
    assert!(service
        .plan_launch(&manual)
        .unwrap_err()
        .contains("ambiguous"));
}
#[cfg(unix)]
#[test]
fn repeated_indexed_and_manual_resume_focus_live_runtime_even_after_database_growth() {
    use sessionbay_lib::runtime::TerminalEvent;
    use std::{
        os::unix::fs::PermissionsExt,
        sync::{mpsc, Arc},
        time::Duration,
    };
    for manual_first in [false, true] {
        let (tmp, service, source, indexed) = setup();
        let stub = tmp.path().join("owned OpenCode stand-in");
        fs::write(&stub, "#!/bin/sh\nprintf 'SYNTHETIC_READY\\n'\nexec cat\n").unwrap();
        fs::set_permissions(&stub, fs::Permissions::from_mode(0o700)).unwrap();
        let mut settings = service.settings().unwrap();
        settings.executables.opencode = stub.to_string_lossy().into_owned();
        service.save_settings(settings).unwrap();
        let manual = LaunchRequest {
            session_id: None,
            resume_id: Some(ID.into()),
            pane_id: "manual".into(),
            ..indexed.clone()
        };
        let first = if manual_first { &manual } else { &indexed };
        let second = if manual_first { &indexed } else { &manual };
        let (tx, rx) = mpsc::channel();
        let running = service
            .launch(
                first,
                Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
            )
            .unwrap();
        loop {
            if let TerminalEvent::Output {
                runtime_id,
                sequence,
                data,
            } = rx.recv_timeout(Duration::from_secs(5)).unwrap()
            {
                service.runtime.ack(&runtime_id, sequence).unwrap();
                if String::from_utf8_lossy(&data).contains("SYNTHETIC_READY") {
                    break;
                }
            }
        }
        let db = Connection::open(std::path::Path::new(&source.root).join("opencode.db")).unwrap();
        db.execute("UPDATE session SET time_updated=2", []).unwrap();
        drop(db);
        let same = service.launch(second, Arc::new(|_| Ok(()))).unwrap();
        assert_eq!(same.id, running.id);
        assert_eq!(same.pane_id, running.pane_id);
        service.shutdown().unwrap();
    }
}

#[cfg(unix)]
#[test]
fn replaced_reindexed_database_does_not_focus_old_runtime() {
    use sessionbay_lib::runtime::TerminalEvent;
    use std::{
        os::unix::fs::{MetadataExt, PermissionsExt},
        sync::{mpsc, Arc},
        time::Duration,
    };
    let (tmp, service, source, indexed) = setup();
    let stub = tmp.path().join("owned-review-stub");
    fs::write(&stub, "#!/bin/sh\nprintf 'SYNTHETIC_READY\\n'\nexec cat\n").unwrap();
    fs::set_permissions(&stub, fs::Permissions::from_mode(0o700)).unwrap();
    let mut settings = service.settings().unwrap();
    settings.executables.opencode = stub.to_string_lossy().into_owned();
    service.save_settings(settings).unwrap();
    let (tx, rx) = mpsc::channel();
    let running = service
        .launch(
            &indexed,
            Arc::new(move |e| tx.send(e).map_err(|e| e.to_string())),
        )
        .unwrap();
    loop {
        if let TerminalEvent::Output {
            runtime_id,
            sequence,
            data,
        } = rx.recv_timeout(Duration::from_secs(5)).unwrap()
        {
            service.runtime.ack(&runtime_id, sequence).unwrap();
            if String::from_utf8_lossy(&data).contains("SYNTHETIC_READY") {
                break;
            }
        }
    }
    let dbpath = std::path::Path::new(&source.root).join("opencode.db");
    let old_inode = fs::metadata(&dbpath).unwrap().ino();
    let replacement = std::path::Path::new(&source.root).join("replacement.db");
    fs::copy(&dbpath, &replacement).unwrap();
    let db = Connection::open(&replacement).unwrap();
    db.execute(
        "UPDATE session SET title='DIFFERENT_CONVERSATION',time_updated=7",
        [],
    )
    .unwrap();
    drop(db);
    fs::rename(&replacement, &dbpath).unwrap();
    assert_ne!(old_inode, fs::metadata(&dbpath).unwrap().ino());
    let result = service
        .catalog
        .sync(
            std::slice::from_ref(&source),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    assert_eq!(
        service
            .catalog
            .query(&SessionQuery::default())
            .unwrap()
            .items[0]
            .title,
        "DIFFERENT_CONVERSATION"
    );
    // Same pane is occupied by the old DB; it must not silently focus that
    // unrelated runtime after the catalog has been refreshed.
    assert!(service
        .launch(&indexed, Arc::new(|_| Ok(())))
        .unwrap_err()
        .contains("active terminal"));
    let replacement_request = LaunchRequest {
        pane_id: "replacement".into(),
        ..indexed.clone()
    };
    let manual = LaunchRequest {
        pane_id: "manual-replacement".into(),
        session_id: None,
        resume_id: Some(ID.into()),
        ..indexed.clone()
    };
    assert_eq!(
        service
            .plan_launch(&replacement_request)
            .unwrap()
            .resume_key,
        service.plan_launch(&manual).unwrap().resume_key
    );
    let second = service
        .launch(&replacement_request, Arc::new(|_| Ok(())))
        .unwrap();
    let manual_focus = service.launch(&manual, Arc::new(|_| Ok(()))).unwrap();
    assert_eq!(manual_focus.id, second.id);
    service.shutdown().unwrap();
    assert_ne!(
        running.id, second.id,
        "Replacement DB incorrectly reused previous DB runtime"
    );
}

#[test]
fn live_state_opt_in_preserves_indexed_and_manual_source_launch_plans() {
    let (_tmp, service, _source, indexed) = setup();
    let ordinary = service.plan_launch(&indexed).unwrap();
    assert!(!ordinary
        .env
        .contains_key(sessionbay_lib::provider_hooks::OPT_IN));
    let mut settings = service.settings().unwrap();
    settings.agent_hooks.insert("opencode".into(), true);
    service.save_settings(settings.clone()).unwrap();
    for request in [
        indexed.clone(),
        LaunchRequest {
            session_id: None,
            resume_id: Some(ID.into()),
            pane_id: "manual-live".into(),
            ..indexed.clone()
        },
    ] {
        let live = service.plan_launch(&request).unwrap();
        assert_eq!(live.env[sessionbay_lib::provider_hooks::OPT_IN], "live");
        assert_eq!(live.args, ordinary.args);
        assert_eq!(live.executable, ordinary.executable);
        assert_eq!(live.cwd, ordinary.cwd);
        assert_eq!(live.resume_key, ordinary.resume_key);
        assert_eq!(live.env["OPENCODE_DB"], ordinary.env["OPENCODE_DB"]);
    }
    settings.agent_hooks.insert("opencode".into(), false);
    service.save_settings(settings).unwrap();
    assert!(!service
        .plan_launch(&indexed)
        .unwrap()
        .env
        .contains_key(sessionbay_lib::provider_hooks::OPT_IN));
}
