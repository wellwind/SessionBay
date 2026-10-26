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
/// Keep test mirrors out of the user's cache directory.
fn isolate_mirror() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::env::set_var(
            opencode::MIRROR_DIR_ENV,
            std::env::temp_dir().join("sessionbay-test-opencode-mirror"),
        )
    });
}
struct Harness {
    _temp: tempfile::TempDir,
    root: PathBuf,
    catalog: Catalog,
    source: HistorySource,
}
impl Harness {
    fn new() -> Self {
        Self::named("OpenCode history with spaces")
    }
    fn named(directory: &str) -> Self {
        isolate_mirror();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(directory);
        fs::create_dir_all(&root).unwrap();
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

fn large_root(sessions: usize, payload: usize) -> (tempfile::TempDir, PathBuf) {
    isolate_mirror();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("large");
    fs::create_dir(&root).unwrap();
    let db = Connection::open(root.join("opencode.db")).unwrap();
    db.execute_batch(include_str!("../../fixtures/opencode/schema.sql"))
        .unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; BEGIN;").unwrap();
    for s in 0..sessions {
        let id = format!("ses_large{s}");
        db.execute("INSERT INTO session VALUES(?1,'global','/synthetic/large','Large','1.19.2',1,1760000001000,NULL,NULL,NULL)", [&id]).unwrap();
        for m in 0..4 {
            let message = format!("msg_large{s}x{m}");
            db.execute(
                "INSERT INTO message VALUES(?1,?2,?3,1760000001000,?4)",
                params![message, id, m, json!({"role":"user"}).to_string()],
            )
            .unwrap();
            db.execute(
                "INSERT INTO part VALUES(?1,?2,?3,1,1760000001000,?4)",
                params![
                    format!("prt_large{s}x{m}a"),
                    id,
                    message,
                    json!({"type":"text","text":format!("needle {s} {m}")}).to_string()
                ],
            )
            .unwrap();
            db.execute(
                "INSERT INTO part VALUES(?1,?2,?3,1,1760000001000,?4)",
                params![
                    format!("prt_large{s}x{m}b"),
                    id,
                    message,
                    json!({"type":"tool","state":{"output":"z".repeat(payload)}}).to_string()
                ],
            )
            .unwrap();
        }
    }
    db.execute_batch("COMMIT; PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    (temp, root)
}

fn small_limits() -> opencode::Limits {
    opencode::Limits {
        file_bytes: 1 << 30,
        wal_bytes: 1 << 30,
        rows: 10_000,
        output_bytes: 4096,
        block_bytes: 4096,
        always_check_bytes: 0,
    }
}

fn read_all(
    root: &std::path::Path,
    known: &std::collections::HashMap<String, String>,
    limits: opencode::Limits,
) -> Result<
    (
        Vec<opencode::ConversationMetadata>,
        opencode::IndexSummary,
        opencode::MirrorStats,
    ),
    String,
> {
    let mut records = Vec::new();
    let (summary, stats) =
        opencode::read_with_limits(root, &AtomicBool::new(false), limits, known, &mut |r| {
            records.push(r);
            Ok(())
        })?;
    Ok((records, summary, stats))
}

#[test]
fn database_beyond_the_old_snapshot_limit_is_mirrored_incrementally() {
    // Scaled down 1024x: the old 768 MiB snapshot limit corresponds to 768 KiB
    // here, with 4 KiB mirror blocks standing in for 1 MiB blocks.
    let (_temp, root) = large_root(120, 3000);
    let size = fs::metadata(root.join("opencode.db")).unwrap().len();
    assert!(size > 768 * 1024, "{size}");
    let (records, summary, stats) = read_all(&root, &Default::default(), small_limits()).unwrap();
    assert_eq!(records.len(), 120);
    assert!(summary.warnings.is_empty(), "{:?}", summary.warnings);
    assert!(stats.database_refreshed && stats.integrity_checked);
    assert_eq!(stats.database_bytes_written, size);
    assert!(records.iter().all(|r| r.messages.len() == 4 && !r.partial));

    // Unchanged database: nothing is copied, every session is skipped.
    let known: std::collections::HashMap<_, _> = records
        .iter()
        .map(|r| (r.id.clone(), r.fingerprint.clone()))
        .collect();
    let (again, _, stats) = read_all(&root, &known, small_limits()).unwrap();
    assert!(!stats.database_refreshed);
    assert_eq!((stats.sessions_read, stats.sessions_skipped), (0, 120));
    assert!(again.iter().all(|r| r.unchanged && r.messages.is_empty()));

    // One appended message, then a checkpoint into the main database: only the
    // changed blocks are written and only that session is re-read.
    let db = Connection::open(root.join("opencode.db")).unwrap();
    db.execute(
        "INSERT INTO message VALUES('msg_new','ses_large7',9,1760000002000,?1)",
        [json!({"role":"user"}).to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO part VALUES('prt_new','ses_large7','msg_new',9,1760000002000,?1)",
        [json!({"type":"text","text":"fresh needle"}).to_string()],
    )
    .unwrap();
    db.execute(
        "UPDATE session SET time_updated=1760000002000 WHERE id='ses_large7'",
        [],
    )
    .unwrap();
    let (records, _, stats) = read_all(&root, &known, small_limits()).unwrap();
    assert_eq!((stats.sessions_read, stats.sessions_skipped), (1, 119));
    let changed = records.iter().find(|r| r.id == "ses_large7").unwrap();
    assert_eq!(changed.messages.last().unwrap().text, "fresh needle");
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    let (_, _, stats) = read_all(&root, &known, small_limits()).unwrap();
    assert!(stats.database_refreshed);
    assert_eq!(
        stats.database_bytes_read,
        fs::metadata(root.join("opencode.db")).unwrap().len()
    );
    assert!(
        stats.database_bytes_written * 10 < size,
        "{} of {size}",
        stats.database_bytes_written
    );
}

#[test]
fn per_session_budget_marks_only_the_oversized_session_partial() {
    let (_temp, root) = large_root(3, 10);
    let db = Connection::open(root.join("opencode.db")).unwrap();
    db.execute(
        "INSERT INTO message VALUES('msg_big','ses_large1',99,1760000001000,?1)",
        [json!({"role":"user"}).to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO part VALUES('prt_big','ses_large1','msg_big',1,1760000001000,?1)",
        [json!({"type":"text","text":"y".repeat(8192)}).to_string()],
    )
    .unwrap();
    let (records, summary, _) = read_all(&root, &Default::default(), small_limits()).unwrap();
    assert_eq!(records.len(), 3);
    for record in records {
        assert_eq!(record.partial, record.id == "ses_large1", "{}", record.id);
        assert_eq!(record.messages.len(), 4);
    }
    assert!(summary
        .warnings
        .iter()
        .any(|w| w.contains("per-session read budget")));
}

#[test]
fn concurrent_writer_is_never_blocked_and_reads_are_consistent_or_retryable() {
    let (_temp, root) = large_root(20, 2000);
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let writer = {
        let (root, stop) = (root.clone(), stop.clone());
        std::thread::spawn(move || {
            let db = Connection::open(root.join("opencode.db")).unwrap();
            // A tiny autocheckpoint forces checkpoints into the main database
            // while the reader is mirroring it.
            db.execute_batch("PRAGMA wal_autocheckpoint=4;").unwrap();
            let mut n = 0;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) && n < 2000 {
                let message = format!("msg_live{n}");
                // Never SQLITE_BUSY: the reader holds no lock on the source.
                db.execute_batch("BEGIN IMMEDIATE").unwrap();
                db.execute(
                    "INSERT INTO message VALUES(?1,'ses_large3',?2,1760000003000,?3)",
                    params![message, 100 + n, json!({"role":"user"}).to_string()],
                )
                .unwrap();
                db.execute(
                    "INSERT INTO part VALUES(?1,'ses_large3',?2,1,1760000003000,?3)",
                    params![
                        format!("prt_live{n}"),
                        message,
                        json!({"type":"text","text":format!("live {n}")}).to_string(),
                    ],
                )
                .unwrap();
                db.execute_batch("COMMIT").unwrap();
                n += 1;
            }
            n
        })
    };
    let mut ok = 0;
    let mut last = 0;
    for _ in 0..40 {
        match read_all(
            &root,
            &Default::default(),
            opencode::Limits {
                output_bytes: 1 << 20,
                ..small_limits()
            },
        ) {
            Ok((records, _, _)) => {
                ok += 1;
                let live = records.iter().find(|r| r.id == "ses_large3").unwrap();
                // Each committed write adds exactly one message: a consistent
                // view never has a message without its text part.
                let count = live.messages.len();
                assert!(live.messages[4..]
                    .iter()
                    .enumerate()
                    .all(|(i, m)| m.text == format!("live {i}")));
                assert!(count >= last, "went backwards: {count} < {last}");
                last = count;
            }
            Err(error) => assert!(
                error.contains("changed") || error.contains("grew") || error.contains("WAL"),
                "{error}"
            ),
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let written = writer.join().unwrap();
    let (records, _, _) = read_all(
        &root,
        &Default::default(),
        opencode::Limits {
            output_bytes: 1 << 20,
            ..small_limits()
        },
    )
    .unwrap();
    let live = records.iter().find(|r| r.id == "ses_large3").unwrap();
    assert_eq!(live.messages.len(), 4 + written);
    let _ = ok;
}

#[test]
fn catalog_refresh_reindexes_only_changed_sessions_and_keeps_other_previews_fresh() {
    let h = Harness::new();
    let db = h.db();
    db.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    db.execute("INSERT INTO session VALUES('ses_otherBeta','global','/synthetic/b','Other','1.19.2',1,1760000001000,NULL,NULL,NULL)", []).unwrap();
    h.v2(0, "user", json!({"text":"alpha first"}));
    db.execute(
        "INSERT INTO session_message VALUES('msg_b0','ses_otherBeta','user',0,1,1,?1)",
        [json!({"text":"beta only"}).to_string()],
    )
    .unwrap();
    h.sync();
    let beta = h
        .catalog
        .query(&SessionQuery {
            query: Some("beta".into()),
            ..Default::default()
        })
        .unwrap()
        .items
        .remove(0);
    h.v2(1, "user", json!({"text":"alpha appended"}));
    db.execute(
        "UPDATE session SET time_updated=1760000009000 WHERE id=?1",
        [ID],
    )
    .unwrap();
    // The other session's preview stays valid across an unrelated write.
    let page = h.catalog.transcript(&beta.id, None, 20).unwrap();
    assert!(!page.stale);
    assert_eq!(page.messages[0].text, "beta only");
    h.sync();
    assert_eq!(h.search("appended"), 1);
    assert!(!h.catalog.transcript(&beta.id, None, 20).unwrap().stale);
}

/// Stands in for the official CLI: export prints the Session, delete and
/// import edit the synthetic database like `opencode session delete`/`import`.
struct FakeCli {
    db: PathBuf,
    calls: std::cell::RefCell<Vec<String>>,
}
impl sessionbay_lib::os_trash::OpenCodeCli for FakeCli {
    fn export(
        &self,
        _: &std::path::Path,
        id: &str,
        target: &std::path::Path,
    ) -> Result<(), String> {
        self.calls.borrow_mut().push(format!("export {id}"));
        fs::write(
            target,
            json!({"info": {"id": id}, "messages": []}).to_string(),
        )
        .map_err(|e| e.to_string())
    }
    fn delete(&self, _: &std::path::Path, id: &str) -> Result<(), String> {
        self.calls.borrow_mut().push(format!("delete {id}"));
        Connection::open(&self.db)
            .unwrap()
            .execute("DELETE FROM session WHERE id=?1", [id])
            .unwrap();
        Ok(())
    }
    fn import(
        &self,
        _: &std::path::Path,
        file: &std::path::Path,
        cwd: &std::path::Path,
    ) -> Result<(), String> {
        let export: Value = serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
        let id = export["info"]["id"].as_str().unwrap();
        self.calls.borrow_mut().push(format!("import {id}"));
        Connection::open(&self.db).unwrap().execute(
            "INSERT INTO session VALUES(?1,'global',?2,'Native OpenCode title','1.19.2',1760000000000,1760000001000,NULL,NULL,NULL)",
            params![id, cwd.to_string_lossy()],
        ).unwrap();
        Ok(())
    }
}
struct FakeTrash(PathBuf);
impl sessionbay_lib::os_trash::Mover for FakeTrash {
    fn move_to_trash(&self, path: &std::path::Path) -> Result<Option<PathBuf>, String> {
        let target = self.0.join(path.file_name().unwrap());
        fs::rename(path, &target).map_err(|e| e.to_string())?;
        Ok(Some(target))
    }
    fn in_trash(&self, item: &sessionbay_lib::os_trash::MovedItem, _: i64) -> Result<bool, String> {
        Ok(item
            .trashed
            .as_deref()
            .is_some_and(|p| std::path::Path::new(p).exists()))
    }
    fn restore(&self, item: &sessionbay_lib::os_trash::MovedItem, _: i64) -> Result<(), String> {
        sessionbay_lib::os_trash::restore_by_rename(
            std::path::Path::new(item.trashed.as_deref().unwrap()),
            std::path::Path::new(&item.original),
        )
    }
}

#[test]
fn opencode_session_exports_to_trash_deletes_via_cli_and_imports_back() {
    use sessionbay_lib::os_trash::{list_moved, restore_moved, PlanStore};
    let h = Harness::named("xdg/opencode");
    let work = h._temp.path().join("work");
    let bin = h._temp.path().join("bin");
    fs::create_dir_all(&work).unwrap();
    fs::create_dir_all(&bin).unwrap();
    h.db()
        .execute("UPDATE session SET directory=?1", [work.to_string_lossy()])
        .unwrap();
    h.sync();
    let session = h.session();
    let trash_id = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    let cli = FakeCli {
        db: h.root.join("opencode.db"),
        calls: Default::default(),
    };
    let trash = FakeTrash(bin.clone());
    let idle = |_: &str, _: &str| false;
    let store = PlanStore::default().with_staging(h._temp.path().join("staging"));
    // Without the CLI nothing can be deleted.
    let blocked = store.prepare(&h.catalog, &trash_id, &idle, None).unwrap();
    assert!(blocked.plan_id.is_empty());
    assert!(blocked
        .blockers
        .iter()
        .any(|b| b.contains("OpenCode 執行檔")));
    let plan = store
        .prepare(&h.catalog, &trash_id, &idle, Some(&cli))
        .unwrap();
    assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
    assert!(plan.kept.iter().any(|k| k.starts_with("opencode.db")));
    store
        .execute(&h.catalog, &plan.plan_id, &idle, &trash, Some(&cli))
        .unwrap();
    assert_eq!(
        *cli.calls.borrow(),
        [format!("export {ID}"), format!("delete {ID}")]
    );
    assert!(bin.join(format!("opencode-session-{ID}.json")).exists());
    let count = |db: Connection| {
        db.query_row("SELECT count(*) FROM session", [], |r| r.get::<_, i64>(0))
            .unwrap()
    };
    assert_eq!(count(h.db()), 0);
    let records = list_moved(&h.catalog, &trash).unwrap();
    assert!(records[0].items[0].in_trash);
    let restored = restore_moved(&h.catalog, &records[0].id, &trash, Some(&cli)).unwrap();
    assert!(restored.failed.is_empty(), "{:?}", restored.failed);
    assert_eq!(count(h.db()), 1);
    assert!(list_moved(&h.catalog, &trash).unwrap().is_empty());
    h.sync();
    assert_eq!(h.session().external_id, ID);
}

#[test]
fn opencode_never_deletes_when_the_export_is_wrong() {
    use sessionbay_lib::os_trash::PlanStore;
    struct BadExport(FakeCli);
    impl sessionbay_lib::os_trash::OpenCodeCli for BadExport {
        fn export(
            &self,
            _: &std::path::Path,
            _: &str,
            target: &std::path::Path,
        ) -> Result<(), String> {
            fs::write(
                target,
                json!({"info": {"id": "ses_other"}, "messages": []}).to_string(),
            )
            .map_err(|e| e.to_string())
        }
        fn delete(&self, root: &std::path::Path, id: &str) -> Result<(), String> {
            self.0.delete(root, id)
        }
        fn import(
            &self,
            root: &std::path::Path,
            file: &std::path::Path,
            cwd: &std::path::Path,
        ) -> Result<(), String> {
            self.0.import(root, file, cwd)
        }
    }
    let h = Harness::named("xdg/opencode");
    h.sync();
    let session = h.session();
    let trash_id = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    let cli = BadExport(FakeCli {
        db: h.root.join("opencode.db"),
        calls: Default::default(),
    });
    let staging = h._temp.path().join("staging");
    let store = PlanStore::default().with_staging(staging.clone());
    let idle = |_: &str, _: &str| false;
    let plan = store
        .prepare(&h.catalog, &trash_id, &idle, Some(&cli))
        .unwrap();
    let error = store
        .execute(
            &h.catalog,
            &plan.plan_id,
            &idle,
            &FakeTrash(staging.clone()),
            Some(&cli),
        )
        .unwrap_err();
    assert!(error.contains("與預期不同"));
    assert!(cli.0.calls.borrow().is_empty());
    assert_eq!(
        h.db()
            .query_row("SELECT count(*) FROM session", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
}
