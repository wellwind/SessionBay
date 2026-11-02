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
        db.execute("INSERT INTO session_v2 VALUES(?1,'global','/synthetic/專案 alpha','Native OpenCode title','2.2.3',1760000000000,1760000001000,NULL,NULL,NULL)",[ID]).unwrap();
        h
    }
    fn migrated() -> Self {
        let h = Self::new();
        fs::remove_file(h.root.join("opencode.db")).unwrap();
        h.db()
            .execute_batch(include_str!(
                "../../fixtures/opencode/cli-2.2.3-migrated-from-1.19.5.sql"
            ))
            .unwrap();
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
fn reads_cli_two_content_and_excludes_tools_reasoning_compaction() {
    let h = Harness::new();
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
    for hidden in ["PRIVATE_REASONING", "PRIVATE_TOOL", "PRIVATE_COMPACTION"] {
        assert_eq!(h.search(hidden), 0);
    }
    assert!(!h.session().partial);
    assert_eq!(h.session().cwd.as_deref(), Some("/synthetic/專案 alpha"));
}

#[test]
fn unknown_versions_corrupt_json_and_reverts_fail_closed_and_reconcile() {
    let h = Harness::new();
    h.v2(0, "user", json!({"text":"Original retained text"}));
    h.sync();
    let id = h.session().id;
    h.db()
        .execute("UPDATE session_v2 SET version='2.0.0'", [])
        .unwrap();
    assert!(h.catalog.transcript(&id, None, 20).unwrap().stale);
    assert!(h.catalog.resume_source(&id).is_err());
    h.sync();
    assert!(h.session().partial);
    assert!(h.session().resume_disabled_reason.is_some());
    assert!(h.texts().is_empty());
    assert_eq!(h.search("Original"), 0);
    h.db()
        .execute_batch("UPDATE session_v2 SET version='2.2.3'; UPDATE session_message SET data='{'")
        .unwrap();
    h.sync();
    assert!(h.session().partial);
    assert!(h.texts().is_empty());
    h.db()
        .execute(
            "UPDATE session_v2 SET revert=?1",
            [json!({"messageID":"msg_synthetic0"}).to_string()],
        )
        .unwrap();
    h.sync();
    assert!(h.texts().is_empty());
    h.db()
        .execute_batch("DELETE FROM session_message; DELETE FROM session_v2")
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
        .execute_batch("ALTER TABLE session_v2 RENAME COLUMN title TO unknown_title")
        .unwrap();
    assert!(opencode::read_metadata(&h.root, &AtomicBool::new(false)).is_err());
}
#[test]
fn pre_two_database_shows_a_non_fatal_migration_message_without_source_writes() {
    let h = Harness::new();
    h.v2(0, "user", json!({"text":"Old cached transcript"}));
    h.sync();
    h.db()
        .execute_batch("ALTER TABLE session_v2 RENAME TO session")
        .unwrap();
    let database = h.root.join("opencode.db");
    let before = fs::read(&database).unwrap();
    let status = h
        .catalog
        .sync(
            std::slice::from_ref(&h.source),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    assert!(status.errors.is_empty(), "{:?}", status.errors);
    let health = &status.sources[0];
    assert_eq!(health.status, "partial");
    assert!(health
        .message
        .as_ref()
        .unwrap()
        .contains("Open this database once with OpenCode 2.x"));
    assert_eq!(h.catalog.query(&SessionQuery::default()).unwrap().total, 0);
    assert_eq!(fs::read(database).unwrap(), before);
    assert!(!h.root.join("opencode.db-shm").exists());
    assert!(!h.root.join("opencode.db-journal").exists());
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
        .query_row("SELECT count(*) FROM session_v2", [], |r| r.get(0))
        .unwrap();
    let inspection = h.catalog.inspect_removal(&id).unwrap();
    assert_eq!(inspection.indexed_artifacts.len(), 1);
    assert_eq!(inspection.indexed_artifacts[0].status, "sharedStore");
    assert!(inspection.indexed_artifacts[0]
        .relative_path
        .starts_with("opencode.db"));
    assert_eq!(inspection.indexed_artifacts[0].indexed_bytes, None);
    assert!(inspection.blockers[0].contains("deleting the whole database is not allowed"));
    assert_eq!(
        h.db()
            .query_row("SELECT count(*) FROM session_v2", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
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
        db.execute("INSERT INTO session_v2 VALUES(?1,'global','/synthetic/large','Large','2.2.3',1,1760000001000,NULL,NULL,NULL)", [&id]).unwrap();
        for m in 0..4 {
            let message = format!("msg_large{s}x{m}");
            db.execute(
                "INSERT INTO session_message VALUES(?1,?2,'assistant',?3,1760000001000,1760000001000,?4)",
                params![message, id, m, json!({"content":[{"type":"text","text":format!("needle {s} {m}")},{"type":"tool","state":{"output":"z".repeat(payload)}}]}).to_string()],
            ).unwrap();
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
        "INSERT INTO session_message VALUES('msg_new','ses_large7','user',9,1760000002000,1760000002000,?1)",
        [json!({"text":"fresh needle"}).to_string()],
    ).unwrap();
    db.execute(
        "UPDATE session_v2 SET time_updated=1760000002000 WHERE id='ses_large7'",
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
        "INSERT INTO session_message VALUES('msg_big','ses_large1','user',99,1760000001000,1760000001000,?1)",
        [json!({"text":"y".repeat(8192)}).to_string()],
    ).unwrap();
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
                    "INSERT INTO session_message VALUES(?1,'ses_large3','user',?2,1760000003000,1760000003000,?3)",
                    params![message, 100+n, json!({"text":format!("live {n}")}).to_string()],
                ).unwrap();
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
    db.execute("INSERT INTO session_v2 VALUES('ses_otherBeta','global','/synthetic/b','Other','2.2.3',1,1760000001000,NULL,NULL,NULL)", []).unwrap();
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
        "UPDATE session_v2 SET time_updated=1760000009000 WHERE id=?1",
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

const MIGRATED_ID: &str = "ses_cliSynthetic1193";

#[test]
fn cli_2_migration_lists_ids_once_and_uses_current_v2_transcripts() {
    let h = Harness::migrated();
    let db = h.db();
    db.execute_batch("UPDATE session SET title='Stale v1 title';
        INSERT INTO session_message VALUES('msg_afterMigration','ses_cliSynthetic1193','user',4,1792000020000,1792000020000,'{\"text\":\"After migration question\"}');").unwrap();
    let source_bytes = fs::read(h.root.join("opencode.db")).unwrap();
    let index = opencode::read_metadata(&h.root, &AtomicBool::new(false)).unwrap();
    assert_eq!(index.records.len(), 2);
    assert!(index.warnings.is_empty(), "{:?}", index.warnings);
    let record = &index.records[MIGRATED_ID];
    assert_eq!(record.title.as_deref(), Some("Synthetic CLI title 1.19.5"));
    assert_eq!(
        record
            .messages
            .iter()
            .map(|m| m.text.as_str())
            .collect::<Vec<_>>(),
        [
            "Synthetic CLI question 1.19.5",
            "Synthetic CLI answer 1.19.5",
            "After migration question",
        ]
    );
    assert!(!record.partial);
    h.sync();
    assert_eq!(h.catalog.query(&SessionQuery::default()).unwrap().total, 2);
    assert_eq!(h.search("After migration question"), 1);
    for hidden in [
        "available tools",
        "hidden reasoning",
        "tool output",
        "Stale v1 title",
    ] {
        assert_eq!(h.search(hidden), 0, "{hidden}");
    }
    assert_eq!(fs::read(h.root.join("opencode.db")).unwrap(), source_bytes);
    assert!(!h.root.join("opencode.db-shm").exists());
    // A NULL title uses the existing catalog fallback, without reading the v1 title.
    db.execute(
        "UPDATE session_v2 SET title=NULL WHERE id=?1",
        [MIGRATED_ID],
    )
    .unwrap();
    h.sync();
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .into_iter()
        .find(|s| s.external_id == MIGRATED_ID)
        .unwrap();
    assert_eq!(session.title, "opencode ses_cliSynth");
    assert!(!session.partial);
    // An empty v2 projection must never resurrect retained v1 content.
    db.execute(
        "DELETE FROM session_message WHERE session_id=?1",
        [MIGRATED_ID],
    )
    .unwrap();
    h.sync();
    assert_eq!(h.search("Synthetic CLI question 1.19.5"), 0);
    assert_eq!(h.catalog.query(&SessionQuery::default()).unwrap().total, 2);
}

#[test]
fn cli_2_mixed_database_ignores_v1_only_sessions_and_enforces_limit() {
    let h = Harness::migrated();
    // Retain one session only in v1, including its real CLI-shaped message/part rows.
    h.db()
        .execute_batch(
            "DELETE FROM session_v2 WHERE id='ses_cliSynthetic1192';
        DELETE FROM session_message WHERE session_id='ses_cliSynthetic1192';",
        )
        .unwrap();
    let index = opencode::read_metadata(&h.root, &AtomicBool::new(false)).unwrap();
    assert_eq!(index.records.len(), 1);
    assert!(!index.records.contains_key("ses_cliSynthetic1192"));
    assert!(read_all(
        &h.root,
        &Default::default(),
        opencode::Limits {
            rows: 0,
            ..opencode::Limits::default()
        }
    )
    .unwrap_err()
    .contains("session count"));
}

#[test]
fn cli_2_version_gate_and_reverts_do_not_fall_back_to_v1() {
    let h = Harness::migrated();
    for (version, reviewed) in [
        ("1.19.5", true),
        ("2.2.0", true),
        ("2.2.1", true),
        ("2.2.2", true),
        ("2.2.3", true),
        ("1.19.6", false),
        ("2.2.4", true),
        ("2.2.5", true),
        ("2.2.6", false),
        ("2.3.0", false),
        ("2.1.9", false),
        ("2.2.3-beta", false),
        ("3.0.0", false),
    ] {
        h.db()
            .execute("UPDATE session_v2 SET version=?1", [version])
            .unwrap();
        let index = opencode::read_metadata(&h.root, &AtomicBool::new(false)).unwrap();
        for record in index.records.values() {
            assert_eq!(record.partial, !reviewed, "{version}");
            assert_eq!(
                record.messages.len(),
                if reviewed { 2 } else { 0 },
                "{version}"
            );
        }
    }
    h.db()
        .execute_batch("UPDATE session_v2 SET version='2.2.3',revert='{}';")
        .unwrap();
    let index = opencode::read_metadata(&h.root, &AtomicBool::new(false)).unwrap();
    assert!(index
        .records
        .values()
        .all(|r| r.partial && r.messages.is_empty()));
}

fn native_parts_fixture(h: &Harness) {
    // Source-shaped synthetic rows, not a native 2.x model-run capture.
    h.db().execute_batch(r#"
        INSERT INTO session_v2(id,project_id,slug,directory,title,version,time_created,time_updated)
        VALUES('ses_nativeTwo','global','native-two','/synthetic/native',NULL,'2.2.3',1792000000000,1792000010000);
        INSERT INTO session_message VALUES('msg_nativeUser','ses_nativeTwo','user',0,1792000000000,1792000000000,'{"text":"Native question"}');
        INSERT INTO session_message VALUES('msg_nativeParts','ses_nativeTwo','assistant',1,1792000001000,1792000001000,'{"content":[{"type":"text","text":"STALE_INLINE"}]}');
        INSERT INTO session_message VALUES('msg_nativeInline','ses_nativeTwo','assistant',2,1792000002000,1792000002000,'{"content":[{"type":"text","text":"Inline fallback"}]}');
        INSERT INTO session_message VALUES('msg_nativeNotice','ses_nativeTwo','system',3,1792000003000,1792000003000,'not JSON');
        INSERT INTO session_part VALUES('msg_nativeParts','ses_nativeTwo',7,'text',NULL,1792000001000,1792000001000,'{"type":"text","text":"Second part"}');
        INSERT INTO session_part VALUES('msg_nativeParts','ses_nativeTwo',2,'text',NULL,1792000001000,1792000001000,'{"type":"text","text":"First part"}');
        INSERT INTO session_part VALUES('msg_nativeParts','ses_nativeTwo',4,'reasoning',NULL,1792000001000,1792000001000,'{"type":"reasoning","text":"HIDDEN_REASONING"}');
        INSERT INTO session_part VALUES('msg_nativeParts','ses_nativeTwo',5,'tool','call_synthetic',1792000001000,1792000001000,'{"type":"tool","id":"call_synthetic","name":"bash","state":{"output":"HIDDEN_TOOL"}}');
    "#).unwrap();
}

#[test]
fn cli_2_parts_replace_inline_content_in_ordinal_order_and_refresh_on_updates() {
    let h = Harness::migrated();
    native_parts_fixture(&h);
    let (records, summary, _) = read_all(&h.root, &Default::default(), small_limits()).unwrap();
    assert_eq!(records.len(), 3);
    assert!(summary.warnings.is_empty(), "{:?}", summary.warnings);
    let native = records.iter().find(|r| r.id == "ses_nativeTwo").unwrap();
    assert!(!native.partial);
    assert_eq!(
        native
            .messages
            .iter()
            .map(|m| m.text.as_str())
            .collect::<Vec<_>>(),
        [
            "Native question",
            "First part\n\nSecond part",
            "Inline fallback",
        ]
    );
    let known = records
        .iter()
        .map(|r| (r.id.clone(), r.fingerprint.clone()))
        .collect();
    assert_eq!(
        opencode::session_fingerprint(&h.root, "ses_nativeTwo")
            .unwrap()
            .as_ref(),
        Some(&native.fingerprint)
    );
    let (_, _, stats) = read_all(&h.root, &known, small_limits()).unwrap();
    assert_eq!(stats.sessions_skipped, 3);
    h.sync();
    h.db().execute_batch(r#"UPDATE session_part SET data='{"type":"text","text":"Changed part"}',time_updated=1792000020000 WHERE message_id='msg_nativeParts' AND ordinal=7;"#).unwrap();
    let (records, _, stats) = read_all(&h.root, &known, small_limits()).unwrap();
    assert_eq!((stats.sessions_read, stats.sessions_skipped), (1, 2));
    assert!(
        !records
            .iter()
            .find(|r| r.id == "ses_nativeTwo")
            .unwrap()
            .unchanged
    );
    h.sync();
    assert_eq!(h.search("Changed part"), 1);
    for hidden in ["STALE_INLINE", "HIDDEN_TOOL", "HIDDEN_REASONING"] {
        assert_eq!(h.search(hidden), 0);
    }
    // Updating an inline message without changing seq/count also invalidates the fingerprint.
    h.db().execute_batch(r#"UPDATE session_message SET data='{"content":[{"type":"text","text":"Changed inline"}]}',time_updated=1792000030000 WHERE id='msg_nativeInline';"#).unwrap();
    h.sync();
    assert_eq!(h.search("Changed inline"), 1);
    assert_eq!(h.search("Inline fallback"), 0);
    // A 2.x-only schema does not require the retained v1 tables.
    h.db()
        .execute_batch("DROP TABLE session; DROP TABLE message; DROP TABLE part;")
        .unwrap();
    let index = opencode::read_metadata(&h.root, &AtomicBool::new(false)).unwrap();
    assert_eq!(index.records.len(), 3);
    assert!(!index.records["ses_nativeTwo"].partial);
}

#[test]
fn cli_2_parts_keep_budgets_and_malformed_content_partial_without_inline_leakage() {
    let h = Harness::migrated();
    native_parts_fixture(&h);
    h.db()
        .execute(
            "UPDATE session_part SET data=?1 WHERE ordinal=7",
            [json!({"type":"text","text":"z".repeat(8192)}).to_string()],
        )
        .unwrap();
    let (records, summary, _) = read_all(&h.root, &Default::default(), small_limits()).unwrap();
    let native = records.iter().find(|r| r.id == "ses_nativeTwo").unwrap();
    assert!(native.partial);
    assert_eq!(native.messages.len(), 1);
    assert!(summary
        .warnings
        .iter()
        .any(|w| w.contains("per-session read budget")));
    for invalid in [
        "not JSON",
        r#"{"type":"future","text":"UNKNOWN"}"#,
        r#"{"type":"text","text":false}"#,
    ] {
        h.db()
            .execute("UPDATE session_part SET data=?1 WHERE ordinal=7", [invalid])
            .unwrap();
        let index = opencode::read_metadata(&h.root, &AtomicBool::new(false)).unwrap();
        let native = &index.records["ses_nativeTwo"];
        assert!(native.partial);
        assert_eq!(native.messages[1].text, "First part");
        assert!(!native
            .messages
            .iter()
            .any(|m| m.text.contains("STALE_INLINE")));
    }
    h.db().execute_batch(r#"DELETE FROM session_part WHERE message_id='msg_nativeParts';
        WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<10000)
        INSERT INTO session_part SELECT 'msg_nativeParts','ses_nativeTwo',i,'reasoning',NULL,1,1,'{"type":"reasoning","text":"hidden"}' FROM n;"#).unwrap();
    let index = opencode::read_metadata(&h.root, &AtomicBool::new(false)).unwrap();
    let native = &index.records["ses_nativeTwo"];
    assert!(native.partial);
    assert_eq!(native.messages.len(), 1);
}

/// Synthetic 2.x CLI with controllable failures and changes during export.
struct V2Cli {
    db: PathBuf,
    major: std::cell::Cell<u32>,
    calls: std::cell::RefCell<Vec<String>>,
    fail_export: Option<&'static str>,
    mutate_export: bool,
    wrong_export: bool,
    fail_delete: bool,
}
impl sessionbay_lib::os_trash::OpenCodeCli for V2Cli {
    fn major(&self) -> Result<u32, String> {
        Ok(self.major.get())
    }
    fn export(
        &self,
        _: &std::path::Path,
        id: &str,
        target: &std::path::Path,
    ) -> Result<(), String> {
        self.calls.borrow_mut().push(format!("export {id}"));
        if self.fail_export == Some(id) {
            return Err("synthetic descendant export failure".into());
        }
        if self.mutate_export {
            Connection::open(&self.db)
                .unwrap()
                .execute(
                    "UPDATE session_v2 SET title='changed during export' WHERE id='ses_grandchild'",
                    [],
                )
                .unwrap();
        }
        let exported_id = if self.wrong_export && id == "ses_grandchild" {
            "ses_wrong"
        } else {
            id
        };
        fs::write(
            target,
            json!({"info":{"id":exported_id},"messages":[]}).to_string(),
        )
        .map_err(|e| e.to_string())
    }
    fn delete(&self, _: &std::path::Path, id: &str) -> Result<(), String> {
        self.calls.borrow_mut().push(format!("delete {id}"));
        if self.fail_delete {
            return Err("synthetic recursive delete failure".into());
        }
        Connection::open(&self.db).unwrap().execute(
            "WITH RECURSIVE subtree(id) AS (SELECT ?1 UNION ALL SELECT s.id FROM session_v2 s JOIN subtree t ON s.parent_id=t.id) DELETE FROM session_v2 WHERE id IN subtree", [id],
        ).unwrap();
        Ok(())
    }
    fn import(
        &self,
        _: &std::path::Path,
        file: &std::path::Path,
        cwd: &std::path::Path,
    ) -> Result<(), String> {
        let value: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        self.calls.borrow_mut().push(format!(
            "import {} {}",
            value["info"]["id"].as_str().unwrap(),
            cwd.display()
        ));
        Ok(())
    }
}
fn v2_removal_harness() -> (Harness, String, V2Cli, FakeTrash) {
    let h = Harness::named("xdg/opencode");
    fs::remove_file(h.root.join("opencode.db")).unwrap();
    let db = h.db();
    db.execute_batch(include_str!(
        "../../fixtures/opencode/cli-2.2.3-migrated-from-1.19.5.sql"
    ))
    .unwrap();
    db.execute_batch("DELETE FROM session_v2; DELETE FROM session;")
        .unwrap();
    let work = h._temp.path().join("original project");
    fs::create_dir(&work).unwrap();
    for (id, parent, archived) in [
        (ID, None, None),
        ("ses_child", Some(ID), None),
        ("ses_grandchild", Some("ses_child"), Some(1760000000000i64)),
    ] {
        db.execute("INSERT INTO session_v2(id,project_id,slug,directory,title,version,time_created,time_updated,parent_id,time_archived) VALUES(?1,'global',?1,?2,?1,'2.2.3',1760000000000,1760000001000,?3,?4)", params![id, work.to_string_lossy(), parent, archived]).unwrap();
    }
    h.sync();
    let root = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .into_iter()
        .find(|s| s.external_id == ID)
        .unwrap();
    let trash_id = h
        .catalog
        .trash_session(&root.id, root.trash_identity.as_deref().unwrap())
        .unwrap();
    let cli = V2Cli {
        db: h.root.join("opencode.db"),
        major: std::cell::Cell::new(2),
        calls: Default::default(),
        fail_export: None,
        mutate_export: false,
        wrong_export: false,
        fail_delete: false,
    };
    let bin = h._temp.path().join("trash");
    fs::create_dir(&bin).unwrap();
    (h, trash_id, cli, FakeTrash(bin))
}

#[test]
fn v2_review_exports_all_descendants_including_archived_then_deletes_once() {
    use sessionbay_lib::os_trash::{list_moved, restore_moved, PlanStore};
    let (h, trash_id, cli, trash) = v2_removal_harness();
    let store = PlanStore::default().with_staging(h._temp.path().join("staging"));
    let idle = |_: &str, _: &str| false;
    let plan = store
        .prepare(&h.catalog, &trash_id, &idle, Some(&cli))
        .unwrap();
    assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
    assert_eq!(plan.items.len(), 3);
    for id in [ID, "ses_child", "ses_grandchild"] {
        assert!(plan
            .items
            .iter()
            .any(|item| item.relative_path.contains(id)));
    }
    store
        .execute(&h.catalog, &plan.plan_id, &idle, &trash, Some(&cli))
        .unwrap();
    assert_eq!(
        *cli.calls.borrow(),
        [
            format!("export {ID}"),
            "export ses_child".into(),
            "export ses_grandchild".into(),
            format!("delete {ID}")
        ]
    );
    let records = h.catalog.os_trash_records().unwrap();
    assert_eq!(records[0].items.len(), 3);
    assert!(records[0]
        .items
        .iter()
        .all(|item| item.opencode_major == Some(2)));
    let bytes = records[0]
        .items
        .iter()
        .map(|item| fs::read(item.trashed.as_ref().unwrap()).unwrap())
        .collect::<Vec<_>>();
    cli.major.set(1);
    let result = restore_moved(&h.catalog, &records[0].id, &trash, Some(&cli)).unwrap();
    assert!(result.moved.is_empty());
    assert!(result
        .failed
        .iter()
        .all(|reason| reason.contains("OpenCode 2.x")));
    for (item, bytes) in records[0].items.iter().zip(bytes) {
        assert_eq!(fs::read(item.trashed.as_ref().unwrap()).unwrap(), bytes);
        assert!(!std::path::Path::new(&item.original).exists());
    }
    cli.major.set(2);
    assert!(
        restore_moved(&h.catalog, &records[0].id, &trash, Some(&cli))
            .unwrap()
            .failed
            .is_empty()
    );
    assert!(list_moved(&h.catalog, &trash).unwrap().is_empty());
    assert_eq!(
        cli.calls
            .borrow()
            .iter()
            .filter(|call| call.starts_with("import "))
            .count(),
        3
    );
    assert!(cli
        .calls
        .borrow()
        .iter()
        .filter(|call| call.starts_with("import "))
        .all(|call| call.ends_with("original project")));
}

#[test]
fn v2_blocks_unavailable_ancestry_running_recent_and_changed_descendants() {
    use sessionbay_lib::os_trash::PlanStore;
    for case in 0..6 {
        let (h, trash_id, cli, trash) = v2_removal_harness();
        let store = PlanStore::default().with_staging(h._temp.path().join("staging"));
        let idle = |_: &str, _: &str| false;
        let plan = store
            .prepare(&h.catalog, &trash_id, &idle, Some(&cli))
            .unwrap();
        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        match case {
            0 => {
                h.db().execute_batch("DROP TABLE session_v2").unwrap();
            }
            1 => {
                h.db()
                    .execute(
                        "UPDATE session_v2 SET time_updated=?1 WHERE id='ses_grandchild'",
                        [chrono::Utc::now().timestamp_millis()],
                    )
                    .unwrap();
            }
            2 => {
                h.db()
                    .execute_batch(
                        "UPDATE session_v2 SET title='changed' WHERE id='ses_grandchild'",
                    )
                    .unwrap();
            }
            3 => {
                h.db()
                    .execute_batch(
                        "UPDATE session_v2 SET parent_id='ses_grandchild' WHERE id='ses_child'",
                    )
                    .unwrap();
            }
            4 => {
                cli.major.set(1);
            }
            _ => {}
        }
        let running = |_: &str, external: &str| case == 5 && external == "ses_grandchild";
        assert!(
            store
                .execute(&h.catalog, &plan.plan_id, &running, &trash, Some(&cli))
                .is_err(),
            "case {case}"
        );
        assert!(cli.calls.borrow().is_empty());
        let blocked = store
            .prepare(&h.catalog, &trash_id, &running, Some(&cli))
            .unwrap();
        if matches!(case, 0 | 1 | 5) {
            assert!(blocked.plan_id.is_empty(), "case {case}");
        }
    }
}

#[test]
fn v2_descendant_export_failure_or_change_during_export_never_deletes() {
    use sessionbay_lib::os_trash::PlanStore;
    for case in 0..3 {
        let (h, trash_id, mut cli, trash) = v2_removal_harness();
        cli.fail_export = (case == 0).then_some("ses_grandchild");
        cli.mutate_export = case == 1;
        cli.wrong_export = case == 2;
        let store = PlanStore::default().with_staging(h._temp.path().join("staging"));
        let idle = |_: &str, _: &str| false;
        let plan = store
            .prepare(&h.catalog, &trash_id, &idle, Some(&cli))
            .unwrap();
        assert!(store
            .execute(&h.catalog, &plan.plan_id, &idle, &trash, Some(&cli))
            .is_err());
        assert!(!cli
            .calls
            .borrow()
            .iter()
            .any(|call| call.starts_with("delete ")));
        assert_eq!(
            h.db()
                .query_row("SELECT count(*) FROM session_v2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert!(h.catalog.os_trash_records().unwrap().is_empty());
    }
}

#[test]
fn legacy_exports_remain_listed_and_untouched_with_or_without_a_cli() {
    use sessionbay_lib::os_trash::{list_moved, restore_moved, PlanStore};
    for major in [Some(1), None] {
        for location in ["trash", "staging", "missing"] {
            let (h, trash_id, cli, trash) = v2_removal_harness();
            let store = PlanStore::default().with_staging(h._temp.path().join("staging"));
            let idle = |_: &str, _: &str| false;
            let plan = store
                .prepare(&h.catalog, &trash_id, &idle, Some(&cli))
                .unwrap();
            store
                .execute(&h.catalog, &plan.plan_id, &idle, &trash, Some(&cli))
                .unwrap();
            let mut record = h.catalog.os_trash_records().unwrap().remove(0);
            for item in &mut record.items {
                item.opencode_major = major;
                if location == "staging" {
                    fs::rename(item.trashed.as_ref().unwrap(), &item.original).unwrap();
                    item.trashed = None;
                } else if location == "missing" {
                    fs::remove_file(item.trashed.as_ref().unwrap()).unwrap();
                }
            }
            Connection::open(h._temp.path().join("catalog.db"))
                .unwrap()
                .execute(
                    "UPDATE session_os_trash SET items=?1 WHERE id=?2",
                    params![serde_json::to_string(&record.items).unwrap(), record.id],
                )
                .unwrap();
            let paths: Vec<_> = record
                .items
                .iter()
                .map(|item| item.trashed.as_ref().unwrap_or(&item.original))
                .collect();
            let bytes: Vec<_> = paths.iter().map(|path| fs::read(path).ok()).collect();
            cli.calls.borrow_mut().clear();
            for provider in [
                None,
                Some(&cli as &dyn sessionbay_lib::os_trash::OpenCodeCli),
            ] {
                let result = restore_moved(&h.catalog, &record.id, &trash, provider).unwrap();
                assert!(result.moved.is_empty());
                assert_eq!(result.failed.len(), record.items.len());
                assert!(result
                    .failed
                    .iter()
                    .all(|message| message.contains("OpenCode 1.x is no longer supported")));
                assert!(cli.calls.borrow().is_empty());
                for (path, expected) in paths.iter().zip(&bytes) {
                    assert_eq!(&fs::read(path).ok(), expected);
                }
                assert_eq!(list_moved(&h.catalog, &trash).unwrap().len(), 1);
                assert_eq!(
                    serde_json::to_value(&h.catalog.os_trash_records().unwrap()[0].items).unwrap(),
                    serde_json::to_value(&record.items).unwrap()
                );
            }
        }
    }
}

#[test]
fn v2_failed_recursive_delete_retains_every_verified_export_for_restore() {
    use sessionbay_lib::os_trash::{restore_moved, PlanStore};
    let (h, trash_id, mut cli, trash) = v2_removal_harness();
    cli.fail_delete = true;
    let store = PlanStore::default().with_staging(h._temp.path().join("staging"));
    let idle = |_: &str, _: &str| false;
    let plan = store
        .prepare(&h.catalog, &trash_id, &idle, Some(&cli))
        .unwrap();
    let result = store
        .execute(&h.catalog, &plan.plan_id, &idle, &trash, Some(&cli))
        .unwrap();
    assert!(result.failed[0].contains("All verified exports are retained"));
    let record = h.catalog.os_trash_records().unwrap().remove(0);
    assert_eq!(record.items.len(), 3);
    assert!(record
        .items
        .iter()
        .all(|item| std::path::Path::new(item.trashed.as_ref().unwrap()).is_file()));
    assert!(restore_moved(&h.catalog, &record.id, &trash, Some(&cli))
        .unwrap()
        .failed
        .is_empty());
}

#[test]
fn v2_review_blocks_cycles_missing_roots_and_missing_descendant_directories() {
    use sessionbay_lib::os_trash::PlanStore;
    for case in 0..3 {
        let (h, trash_id, cli, _) = v2_removal_harness();
        match case {
            0 => {
                h.db()
                    .execute(
                        "UPDATE session_v2 SET parent_id='ses_grandchild' WHERE id=?1",
                        [ID],
                    )
                    .unwrap();
            }
            1 => {
                h.db()
                    .execute("DELETE FROM session_v2 WHERE id=?1", [ID])
                    .unwrap();
            }
            _ => {
                h.db()
                    .execute_batch("UPDATE session_v2 SET directory='' WHERE id='ses_grandchild'")
                    .unwrap();
            }
        }
        let plan = PlanStore::default()
            .prepare(&h.catalog, &trash_id, &|_, _| false, Some(&cli))
            .unwrap();
        assert!(plan.plan_id.is_empty());
        assert!(plan
            .blockers
            .iter()
            .any(|reason| reason.contains("Cannot enumerate every OpenCode descendant")));
        assert!(cli.calls.borrow().is_empty());
    }
}
