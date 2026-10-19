//! All data is synthetic and generated from the pinned official subset in fixtures/opencode.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sessionbay_lib::{
    catalog::Catalog,
    models::{AgentKind, HistorySource, SessionQuery},
    opencode,
};
use std::{fs, path::PathBuf, sync::atomic::AtomicBool};
const ID: &str = "ses_syntheticAlpha";
struct Harness {
    _temp: tempfile::TempDir,
    root: PathBuf,
    catalog: Catalog,
    source: HistorySource,
}
impl Harness {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("OpenCode history with spaces");
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        let root = root.canonicalize().unwrap();
        let catalog = Catalog::open(&temp.path().join("catalog.db")).unwrap();
        let source = HistorySource {
            id: "opencode-test".into(),
            kind: AgentKind::OpenCode,
            root: root.to_string_lossy().into_owned(),
            enabled: true,
        };
        let h = Self {
            _temp: temp,
            root,
            catalog,
            source,
        };
        let db = h.db();
        db.execute_batch(include_str!("../../fixtures/opencode/schema.sql"))
            .unwrap();
        db.execute("INSERT INTO session VALUES(?1,'global','/synthetic/專案 alpha','Native OpenCode title','1.19.2',1760000000000,1760000001000,NULL,NULL,NULL)",[ID]).unwrap();
        h
    }
    fn db(&self) -> Connection {
        Connection::open(self.root.join("opencode.db")).unwrap()
    }
    fn v2(&self, seq: i64, kind: &str, value: Value) {
        self.db()
            .execute(
                "INSERT INTO session_message VALUES(?1,?2,?3,?4,1760000000000,1760000000000,?5)",
                params![
                    format!("msg_synthetic{seq}"),
                    ID,
                    kind,
                    seq,
                    value.to_string()
                ],
            )
            .unwrap();
    }
    fn sync(&self) {
        let status = self
            .catalog
            .sync(
                std::slice::from_ref(&self.source),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
        assert!(status.errors.is_empty(), "{:?}", status.errors);
    }
    fn session(&self) -> sessionbay_lib::models::Session {
        self.catalog
            .query(&SessionQuery::default())
            .unwrap()
            .items
            .remove(0)
    }
    fn texts(&self) -> Vec<String> {
        self.catalog
            .transcript(&self.session().id, None, 200)
            .unwrap()
            .messages
            .into_iter()
            .map(|m| m.text)
            .collect()
    }
    fn search(&self, text: &str) -> u64 {
        self.catalog
            .query(&SessionQuery {
                query: Some(text.into()),
                ..Default::default()
            })
            .unwrap()
            .total
    }
}
#[test]
fn reads_both_official_projections_and_excludes_tools_reasoning_compaction() {
    let h = Harness::new();
    let db = h.db();
    let v2_schema: String = db
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name='session_message'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute_batch("DROP TABLE session_message").unwrap();
    db.execute(
        "INSERT INTO message VALUES('msg_old',?1,1760000000000,1760000000000,?2)",
        params![
            ID,
            json!({"role":"user","time":{"created":1760000000000_i64}}).to_string()
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO part VALUES('prt_old',?1,'msg_old',1760000000000,1760000000000,?2)",
        params![
            ID,
            json!({"type":"text","text":"Legacy question"}).to_string()
        ],
    )
    .unwrap();
    drop(db);
    h.sync();
    assert_eq!(h.texts(), ["Legacy question"]);
    assert_eq!(h.session().title, "Native OpenCode title");
    h.db().execute_batch(&v2_schema).unwrap();
    h.v2(0,"user",json!({"text":"New native question","time":{"created":1760000000000_i64},"files":[],"agents":[]}));
    h.v2(1,"assistant",json!({"content":[{"type":"text","id":"a","text":"Visible answer"},{"type":"reasoning","id":"r","text":"PRIVATE_REASONING"},{"type":"tool","id":"t","name":"bash","state":{"output":"PRIVATE_TOOL"}}]}));
    h.v2(
        2,
        "compaction",
        json!({"reason":"auto","summary":"PRIVATE_COMPACTION","recent":"x"}),
    );
    h.sync();
    assert_eq!(h.texts(), ["New native question", "Visible answer"]);
    assert_eq!(h.search("Visible"), 1);
    for hidden in [
        "Legacy question",
        "PRIVATE_REASONING",
        "PRIVATE_TOOL",
        "PRIVATE_COMPACTION",
    ] {
        assert_eq!(h.search(hidden), 0);
    }
    assert!(!h.session().partial);
    assert_eq!(h.session().cwd.as_deref(), Some("/synthetic/專案 alpha"));
}
#[test]
fn v1_ignored_synthetic_and_summary_text_is_never_searchable() {
    let h = Harness::new();
    let db = h.db();
    db.execute_batch("DROP TABLE session_message").unwrap();
    for (id, role, summary) in [
        ("msg_a", "user", false),
        ("msg_b", "assistant", false),
        ("msg_c", "assistant", true),
    ] {
        db.execute(
            "INSERT INTO message VALUES(?1,?2,1,1,?3)",
            params![id, ID, json!({"role":role,"summary":summary}).to_string()],
        )
        .unwrap();
        for (suffix, extra) in [
            ("a", json!({"text":"Visible","type":"text"})),
            (
                "b",
                json!({"text":"HIDDEN_SYNTHETIC","type":"text","synthetic":true}),
            ),
            (
                "c",
                json!({"text":"HIDDEN_IGNORED","type":"text","ignored":true}),
            ),
        ] {
            db.execute(
                "INSERT INTO part VALUES(?1,?2,?3,1,1,?4)",
                params![format!("prt_{id}{suffix}"), ID, id, extra.to_string()],
            )
            .unwrap();
        }
    }
    drop(db);
    h.sync();
    assert_eq!(h.texts(), ["Visible", "Visible"]);
    assert_eq!(h.search("HIDDEN"), 0);
}
#[test]
fn unknown_versions_corrupt_json_and_reverts_fail_closed_and_reconcile() {
    let h = Harness::new();
    h.v2(0, "user", json!({"text":"Original retained text"}));
    h.sync();
    let id = h.session().id;
    h.db()
        .execute("UPDATE session SET version='2.0.0'", [])
        .unwrap();
    assert!(h.catalog.transcript(&id, None, 20).unwrap().stale);
    assert!(h.catalog.resume_source(&id).is_err());
    h.sync();
    assert!(h.session().partial);
    assert!(h.session().resume_disabled_reason.is_some());
    assert!(h.texts().is_empty());
    assert_eq!(h.search("Original"), 0);
    h.db()
        .execute_batch("UPDATE session SET version='1.19.2'; UPDATE session_message SET data='{'")
        .unwrap();
    h.sync();
    assert!(h.session().partial);
    assert!(h.texts().is_empty());
    h.db()
        .execute(
            "UPDATE session SET revert=?1",
            [json!({"messageID":"msg_synthetic0"}).to_string()],
        )
        .unwrap();
    h.sync();
    assert!(h.texts().is_empty());
    h.db()
        .execute_batch("DELETE FROM session_message; DELETE FROM session")
        .unwrap();
    h.sync();
    assert_eq!(h.catalog.query(&SessionQuery::default()).unwrap().total, 0);
}
#[test]
fn wal_snapshot_is_read_only_and_rejects_corruption_or_replacement() {
    let h = Harness::new();
    let db = h.db();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    db.execute(
        "INSERT INTO session_message VALUES('msg_wal',?1,'user',0,1,1,?2)",
        params![ID, json!({"text":"Committed in WAL"}).to_string()],
    )
    .unwrap();
    let before: Vec<_> = ["opencode.db", "opencode.db-wal", "opencode.db-shm"]
        .iter()
        .map(|name| fs::read(h.root.join(name)).unwrap())
        .collect();
    h.sync();
    assert_eq!(h.texts(), ["Committed in WAL"]);
    let after: Vec<_> = ["opencode.db", "opencode.db-wal", "opencode.db-shm"]
        .iter()
        .map(|name| fs::read(h.root.join(name)).unwrap())
        .collect();
    assert_eq!(before, after);
    drop(db);
    h.sync();
    let id = h.session().id;
    let bytes = fs::read(h.root.join("opencode.db")).unwrap();
    let copy = h.root.join("replacement.db");
    fs::write(&copy, &bytes).unwrap();
    fs::rename(&copy, h.root.join("opencode.db")).unwrap();
    assert!(h.catalog.transcript(&id, None, 20).unwrap().stale);
    assert!(h.catalog.resume_source(&id).is_err());
    fs::write(h.root.join("opencode.db-wal"), b"truncated").unwrap();
    assert!(opencode::read_metadata(&h.root, &AtomicBool::new(false)).is_err());
}
#[test]
fn legacy_json_missing_database_unknown_schema_and_cancel_are_explicit() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("storage/session/global")).unwrap();
    let result = opencode::read_metadata(temp.path(), &AtomicBool::new(false)).unwrap();
    assert!(result.records.is_empty());
    assert!(result.warnings.join(" ").contains("Legacy"));
    assert!(!temp.path().join("opencode.db").exists());
    assert!(opencode::read_metadata(temp.path(), &AtomicBool::new(true)).is_err());
    fs::write(temp.path().join("opencode.db"), b"corrupt").unwrap();
    assert!(opencode::read_metadata(temp.path(), &AtomicBool::new(false)).is_err());
    let h = Harness::new();
    h.db()
        .execute_batch("ALTER TABLE session RENAME COLUMN title TO unknown_title")
        .unwrap();
    assert!(opencode::read_metadata(&h.root, &AtomicBool::new(false)).is_err());
}
#[test]
fn source_identity_duplicate_ids_pagination_and_compaction_refresh() {
    let h = Harness::new();
    for i in 0..5 {
        h.v2(i, "user", json!({"text":format!("Question {i}")}));
    }
    h.sync();
    let id = h.session().id;
    let page = h.catalog.transcript(&id, None, 2).unwrap();
    assert_eq!(page.messages.len(), 2);
    assert!(page.has_more);
    let older = h.catalog.transcript(&id, page.before_line, 2).unwrap();
    assert_eq!(older.messages[0].text, "Question 1");
    let second = HistorySource {
        id: "other-source".into(),
        ..h.source.clone()
    };
    h.catalog
        .sync(&[h.source.clone(), second], &AtomicBool::new(false), |_| {})
        .unwrap();
    assert!(h
        .catalog
        .resume_source(&id)
        .unwrap_err()
        .contains("multiple history sources"));
    h.db()
        .execute_batch("DELETE FROM session_message WHERE seq<3; VACUUM;")
        .unwrap();
    h.sync();
    assert_eq!(h.texts(), ["Question 3", "Question 4"]);
    assert_eq!(h.search("Question 0"), 0);
}
#[cfg(unix)]
#[test]
fn source_symlinks_are_rejected() {
    use std::os::unix::fs::symlink;
    let h = Harness::new();
    let file = h.root.join("opencode.db");
    fs::rename(&file, h.root.join("real.db")).unwrap();
    symlink(h.root.join("real.db"), file).unwrap();
    assert!(opencode::read_metadata(&h.root, &AtomicBool::new(false)).is_err());
}

#[test]
fn deleting_all_v2_rows_never_restores_ambiguous_legacy_text() {
    let h = Harness::new();
    let db = h.db();
    db.execute(
        "INSERT INTO message VALUES('msg_old',?1,1,1,?2)",
        params![ID, json!({"role":"user"}).to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO part VALUES('prt_old',?1,'msg_old',1,1,?2)",
        params![
            ID,
            json!({"type":"text","text":"Legacy deleted question"}).to_string()
        ],
    )
    .unwrap();
    drop(db);
    h.v2(
        0,
        "user",
        json!({"text":"Current projection","time":{"created":1},"files":[],"agents":[]}),
    );
    h.sync();
    assert_eq!(h.texts(), ["Current projection"]);
    assert_eq!(h.search("Legacy"), 0);
    h.db()
        .execute("DELETE FROM session_message WHERE session_id=?1", [ID])
        .unwrap();
    h.sync();
    assert!(
        h.texts().is_empty(),
        "Legacy text resurrected: {:?}",
        h.texts()
    );
    assert_eq!(h.search("Legacy"), 0);
    assert!(h.session().partial);
    assert!(h.session().resume_disabled_reason.is_some());
    assert!(h.catalog.resume_source(&h.session().id).is_err());
}

#[test]
fn removal_inspection_marks_database_shared_without_exposing_virtual_file_keys() {
    let h = Harness::new();
    h.sync();
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    let id = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    let before: i64 = h
        .db()
        .query_row("SELECT count(*) FROM session", [], |r| r.get(0))
        .unwrap();
    let inspection = h.catalog.inspect_removal(&id).unwrap();
    assert_eq!(inspection.indexed_artifacts.len(), 1);
    assert_eq!(inspection.indexed_artifacts[0].status, "sharedStore");
    assert!(inspection.indexed_artifacts[0]
        .relative_path
        .starts_with("opencode.db"));
    assert_eq!(inspection.indexed_artifacts[0].indexed_bytes, None);
    assert!(inspection.blockers[0].contains("禁止刪除整個資料庫"));
    assert_eq!(
        h.db()
            .query_row("SELECT count(*) FROM session", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        before
    );
}

/// Real 1.19.2/1.19.3 `opencode run` writes only v1 rows while the v2 table exists.
#[test]
fn real_cli_v1_only_databases_for_1_19_2_and_1_19_3_are_fully_indexed() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("cli source");
    fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    let root = root.canonicalize().unwrap();
    Connection::open(root.join("opencode.db"))
        .unwrap()
        .execute_batch(include_str!(
            "../../fixtures/opencode/cli-1.19.x-v1-only.sql"
        ))
        .unwrap();
    let catalog = Catalog::open(&temp.path().join("catalog.db")).unwrap();
    let source = HistorySource {
        id: "opencode-cli".into(),
        kind: AgentKind::OpenCode,
        root: root.to_string_lossy().into_owned(),
        enabled: true,
    };
    let status = catalog
        .sync(
            std::slice::from_ref(&source),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    assert!(status.errors.is_empty(), "{:?}", status.errors);
    let sessions = catalog.query(&SessionQuery::default()).unwrap().items;
    assert_eq!(sessions.len(), 2);
    for version in ["1.19.2", "1.19.3"] {
        let session = sessions
            .iter()
            .find(|s| s.title.contains(version))
            .unwrap_or_else(|| panic!("missing {version}"));
        assert!(!session.partial, "{version} marked partial");
        assert!(session.resume_disabled_reason.is_none());
        assert!(catalog.resume_source(&session.id).is_ok());
        let page = catalog.transcript(&session.id, None, 200).unwrap();
        assert!(page.warning.is_none(), "{:?}", page.warning);
        let texts: Vec<_> = page.messages.into_iter().map(|m| m.text).collect();
        assert_eq!(
            texts,
            [
                format!("Synthetic CLI question {version}"),
                format!("Synthetic CLI answer {version}")
            ]
        );
    }
    // Rows written by an older reader for the same unchanged database must be
    // re-read after an upgrade instead of being reused by fingerprint.
    Connection::open(temp.path().join("catalog.db"))
        .unwrap()
        .execute_batch("UPDATE files SET parser_version=4; DELETE FROM messages;")
        .unwrap();
    let status = catalog
        .sync(
            std::slice::from_ref(&source),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    assert!(status.errors.is_empty(), "{:?}", status.errors);
    for (needle, hits) in [
        ("Synthetic CLI answer 1.19.3", 1),
        ("hidden reasoning", 0),
        ("tool output", 0),
    ] {
        let found = catalog
            .query(&SessionQuery {
                query: Some(needle.into()),
                ..Default::default()
            })
            .unwrap()
            .total;
        assert_eq!(found, hits, "{needle}");
    }
}

#[test]
fn fresh_v1_rows_after_v2_deletion_still_require_matching_session_time() {
    let h = Harness::new();
    // Legacy rows that are as fresh as session.time_updated are the current projection.
    h.db()
        .execute_batch(&format!(
            "INSERT INTO message VALUES('msg_fresh','{ID}',1760000000500,1760000000900,'{{\"role\":\"user\"}}');
             INSERT INTO part VALUES('prt_fresh','{ID}','msg_fresh',1760000000500,1760000000900,'{{\"type\":\"text\",\"text\":\"Fresh legacy question\"}}');"
        ))
        .unwrap();
    h.sync();
    assert_eq!(h.texts(), ["Fresh legacy question"]);
    assert!(!h.session().partial);
    // A later session update without matching v1 rows is ambiguous again.
    h.db()
        .execute("UPDATE session SET time_updated=1760009999000", [])
        .unwrap();
    h.sync();
    assert!(h.texts().is_empty());
    assert!(h.session().partial);
    assert_eq!(h.search("Fresh"), 0);
}
