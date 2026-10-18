//! Isolated-HOME native-resume tests. Only an owned synthetic shell stub is run;
//! no Antigravity installation, credentials, or user history is ever accessed.
#![cfg(unix)]

use rusqlite::{params, Connection};
use serde_json::json;
use sessionbay_lib::{
    models::{AgentKind, HistorySource, SessionQuery},
    runtime::TerminalEvent,
    service::{LaunchRequest, Service},
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
    sync::{atomic::AtomicBool, mpsc, Arc},
    time::{Duration, Instant},
};

const ID: &str = "07eb4413-e2d7-4d1d-9e39-85ad75ecff49";
const CHILD_FLAG: &str = "SESSIONBAY_SYNTHETIC_ANTIGRAVITY_HOME";

#[test]
fn antigravity_native_resume_and_runtime_dedup_use_isolated_home() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("synthetic-home");
    fs::create_dir(&home).unwrap();
    // Change HOME only in this dedicated subprocess; never race other tests by
    // mutating the current process environment or inspect the actual user's HOME.
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "antigravity_native_resume_child_helper",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("HOME", &home)
        .env(CHILD_FLAG, &home)
        .env_remove("AGY_HOME")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "isolated native-resume helper failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
#[ignore = "invoked only by the parent test with an isolated synthetic HOME"]
fn antigravity_native_resume_child_helper() {
    let home = PathBuf::from(
        std::env::var_os(CHILD_FLAG).expect("synthetic-home helper requires its explicit marker"),
    );
    assert_eq!(dirs::home_dir().as_deref(), Some(home.as_path()));
    assert!(home.is_dir());
    assert!(home.read_dir().unwrap().next().is_none());
    let root = home.join(".gemini/antigravity-cli");
    let logs = root.join("brain").join(ID).join(".system_generated/logs");
    let project = home.join("synthetic-project");
    fs::create_dir_all(&logs).unwrap();
    fs::create_dir(&project).unwrap();
    let transcript = logs.join("transcript.jsonl");
    fs::write(
        &transcript,
        format!(
            "{}\n",
            json!({
                "step_index":0,
                "source":"USER_EXPLICIT",
                "type":"USER_INPUT",
                "status":"DONE",
                "created_at":"2026-01-02T00:00:00Z",
                "content":"Synthetic native resume request"
            })
        ),
    )
    .unwrap();
    let db_path = root.join("conversation_summaries.db");
    let db = Connection::open(&db_path).unwrap();
    db.execute_batch(
        "CREATE TABLE conversation_summaries (
            conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT,
            last_modified_time TEXT, workspace_uris TEXT, parent_conversation_id TEXT
        );",
    )
    .unwrap();
    db.execute(
        "INSERT INTO conversation_summaries VALUES (?1,'Synthetic native title','','2026-01-02T00:00:00Z',?2,'')",
        params![ID, json!([format!("file://{}", project.display())]).to_string()],
    )
    .unwrap();
    drop(db);
    let source_bytes = (fs::read(&db_path).unwrap(), fs::read(&transcript).unwrap());
    let stub = home.join("synthetic agent stub");
    fs::write(
        &stub,
        "#!/bin/sh\nprintf 'SYNTHETIC_READY\\n'\nIFS= read -r ignored\nexit 0\n",
    )
    .unwrap();
    fs::set_permissions(&stub, fs::Permissions::from_mode(0o700)).unwrap();

    let backup = home.join("read-only-backup");
    let backup_logs = backup.join("brain").join(ID).join(".system_generated/logs");
    fs::create_dir_all(&backup_logs).unwrap();
    fs::copy(&db_path, backup.join("conversation_summaries.db")).unwrap();
    fs::copy(&transcript, backup_logs.join("transcript.jsonl")).unwrap();
    for manual_first in [false, true] {
        let service = Service::open(home.join(format!("app-{manual_first}"))).unwrap();
        let mut settings = service.settings().unwrap();
        // Owned synthetic stubs use the direct runtime, without a hook broker.
        for kind in AgentKind::ALL {
            settings.agent_hooks.insert(kind.as_str().into(), false);
        }
        settings.sources = vec![HistorySource {
            id: "synthetic-native-antigravity".into(),
            kind: AgentKind::Antigravity,
            root: root.to_string_lossy().into_owned(),
            enabled: true,
        }];
        settings.sources.push(HistorySource {
            id: "synthetic-backup-antigravity".into(),
            kind: AgentKind::Antigravity,
            root: backup.to_string_lossy().into_owned(),
            enabled: true,
        });
        settings.executables.antigravity = stub.to_string_lossy().into_owned();
        service.save_settings(settings.clone()).unwrap();
        let status = service
            .catalog
            .sync(&settings.sources, &AtomicBool::new(false), |_| {})
            .unwrap();
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        let sessions = service.catalog.query(&SessionQuery::default()).unwrap();
        assert_eq!(sessions.items.len(), 2);
        let session = sessions
            .items
            .iter()
            .find(|session| session.source_id == "synthetic-native-antigravity")
            .unwrap();
        let backup_session = sessions
            .items
            .iter()
            .find(|session| session.source_id == "synthetic-backup-antigravity")
            .unwrap();
        assert!(backup_session.resume_disabled_reason.is_some());
        assert_eq!(session.external_id, ID);
        assert_eq!(session.resume_disabled_reason, None);
        let indexed = LaunchRequest {
            pane_id: "indexed-native".into(),
            kind: "antigravity".into(),
            project_id: Some(session.project_id.clone()),
            session_id: Some(session.id.clone()),
            resume_id: None,
            cwd: None,
            profile_id: None,
            cols: 80,
            rows: 24,
        };
        let manual = LaunchRequest {
            pane_id: "manual-native".into(),
            session_id: None,
            resume_id: Some(ID.into()),
            ..indexed.clone()
        };
        let backup_request = LaunchRequest {
            session_id: Some(backup_session.id.clone()),
            ..indexed.clone()
        };
        assert!(service.plan_launch(&backup_request).is_err());
        let indexed_plan = service.plan_launch(&indexed).unwrap();
        let manual_plan = service.plan_launch(&manual).unwrap();
        assert_eq!(indexed_plan.executable, stub.to_string_lossy());
        assert_eq!(indexed_plan.args, vec!["--conversation", ID]);
        assert_eq!(indexed_plan.cwd, project);
        assert!(indexed_plan.resume_key.is_some());
        assert_eq!(indexed_plan.resume_key, manual_plan.resume_key);
        assert_eq!(indexed_plan.args, manual_plan.args);
        for plan in [&indexed_plan, &manual_plan] {
            assert!(!plan.env.contains_key("HOME"));
            assert!(!plan.env.contains_key("AGY_HOME"));
        }
        let preview = service.preview_launch(&indexed).unwrap();
        assert_eq!(preview.args, vec!["--conversation", ID]);
        assert_eq!(preview.cwd, project.to_string_lossy());
        let (first, second) = if manual_first {
            (&manual, &indexed)
        } else {
            (&indexed, &manual)
        };
        let (tx, rx) = mpsc::channel();
        let running = service
            .launch(
                first,
                Arc::new(move |event| tx.send(event).map_err(|error| error.to_string())),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        loop {
            match rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("synthetic stub readiness timed out")
            {
                TerminalEvent::Output {
                    runtime_id,
                    sequence,
                    data,
                } => {
                    output.extend(data);
                    service.runtime.ack(&runtime_id, sequence).unwrap();
                    if String::from_utf8_lossy(&output).contains("SYNTHETIC_READY") {
                        break;
                    }
                }
                event => panic!("unexpected synthetic stub event: {event:?}"),
            }
        }
        let same = service.launch(second, Arc::new(|_| Ok(()))).unwrap();
        assert_eq!(same.id, running.id);
        assert_eq!(
            service
                .runtime
                .list()
                .iter()
                .filter(|runtime| runtime.state == "running")
                .count(),
            1
        );
        service.shutdown().unwrap();
    }
    assert_eq!(
        (fs::read(db_path).unwrap(), fs::read(transcript).unwrap()),
        source_bytes
    );
}
