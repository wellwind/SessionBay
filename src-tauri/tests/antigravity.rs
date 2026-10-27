//! Synthetic observed-format Antigravity persistence fixtures only.
//! These tests do not run Antigravity or access real CLI, App, or IDE history.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sessionbay_lib::catalog::Catalog;
use sessionbay_lib::models::{
    AgentKind, HistorySource, IndexStatus, Session, SessionQuery, TranscriptPage,
};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use tempfile::TempDir;

const ID: &str = "f19c6f8b-a063-43af-b661-e60149d138dc";
const OTHER_ID: &str = "28a693b8-b14c-42d3-8bec-00cf83d00b6f";
#[cfg(not(windows))]
const CWD: &str = "/synthetic/project alpha/中文";
#[cfg(windows)]
const CWD: &str = "C:/synthetic/project alpha/中文";
#[cfg(not(windows))]
const WORKSPACE_URI: &str = "file:///synthetic/project%20alpha/%E4%B8%AD%E6%96%87";
#[cfg(windows)]
const WORKSPACE_URI: &str = "file:///C:/synthetic/project%20alpha/%E4%B8%AD%E6%96%87";

struct Harness {
    _temp: TempDir,
    catalog: Catalog,
    source: HistorySource,
    root: PathBuf,
}

impl Harness {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        // Intentionally not a native CLI root: readable backups must not be resumable.
        let root = temp.path().join("antigravity-backup");
        fs::create_dir_all(&root).unwrap();
        #[cfg(unix)]
        let root = root.canonicalize().unwrap();
        let catalog = Catalog::open(&temp.path().join("catalog.sqlite")).unwrap();
        Self {
            source: HistorySource {
                id: "antigravity-source".into(),
                kind: AgentKind::Antigravity,
                root: root.to_string_lossy().into_owned(),
                enabled: true,
            },
            _temp: temp,
            catalog,
            root,
        }
    }

    fn db_path(&self) -> PathBuf {
        self.root.join("conversation_summaries.db")
    }

    fn metadata(&self, id: &str, title: &str, modified: &str, workspaces: &str) {
        let db = Connection::open(self.db_path()).unwrap();
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS conversation_summaries (
                conversation_id TEXT PRIMARY KEY,
                title TEXT,
                preview TEXT,
                last_modified_time TEXT,
                workspace_uris TEXT,
                parent_conversation_id TEXT
            );",
        )
        .unwrap();
        db.execute(
            "INSERT OR REPLACE INTO conversation_summaries
             (conversation_id,title,preview,last_modified_time,workspace_uris,parent_conversation_id)
             VALUES (?1,?2,?3,?4,?5,'')",
            params![id, title, "Untrusted cached summary", modified, workspaces],
        )
        .unwrap();
    }

    fn standard_metadata(&self) {
        self.metadata(
            ID,
            "Native conversation title",
            "2026-01-03T12:30:00Z",
            &json!([WORKSPACE_URI]).to_string(),
        );
    }

    fn logs(&self, id: &str) -> PathBuf {
        self.root
            .join("brain")
            .join(id)
            .join(".system_generated/logs")
    }

    fn write_named(&self, id: &str, name: &str, values: &[Value]) -> PathBuf {
        let path = self.logs(id).join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            values.iter().map(|v| format!("{v}\n")).collect::<String>(),
        )
        .unwrap();
        path
    }

    fn write(&self, values: &[Value]) -> PathBuf {
        self.write_named(ID, "transcript.jsonl", values)
    }

    fn append(&self, value: Value) {
        append(
            &self.logs(ID).join("transcript.jsonl"),
            &format!("{value}\n"),
        );
    }

    fn sync(&self) -> IndexStatus {
        self.catalog
            .sync(
                std::slice::from_ref(&self.source),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap()
    }

    fn sessions(&self) -> Vec<Session> {
        self.catalog
            .query(&SessionQuery {
                include_children: Some(true),
                ..Default::default()
            })
            .unwrap()
            .items
    }

    fn session(&self) -> Session {
        let sessions = self.sessions();
        assert_eq!(sessions.len(), 1, "{sessions:?}");
        sessions.into_iter().next().unwrap()
    }

    fn page(&self) -> TranscriptPage {
        self.catalog
            .transcript(&self.session().id, None, 200)
            .unwrap()
    }

    fn texts(&self) -> Vec<String> {
        self.page()
            .messages
            .into_iter()
            .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
            .map(|message| message.text)
            .collect()
    }

    fn total(&self, text: &str) -> u64 {
        self.catalog
            .query(&SessionQuery {
                query: Some(text.into()),
                include_children: Some(true),
                ..Default::default()
            })
            .unwrap()
            .total
    }

    fn assert_partial_warning(&self) {
        assert!(self.session().partial);
        assert!(self.page().warning.is_some());
    }
}

fn step(index: u64, source: &str, kind: &str, content: &str) -> Value {
    json!({
        "step_index":index,
        "source":source,
        "type":kind,
        "status":"DONE",
        "created_at":"2026-01-02T00:00:00Z",
        "content":content
    })
}

fn user(index: u64, text: &str) -> Value {
    step(
        index,
        "USER_EXPLICIT",
        "USER_INPUT",
        &format!("<USER_REQUEST>{text}</USER_REQUEST>\n<ADDITIONAL_METADATA>METADATA_PRIVATE</ADDITIONAL_METADATA>"),
    )
}

fn assistant(index: u64, text: &str) -> Value {
    step(index, "MODEL", "PLANNER_RESPONSE", text)
}

fn assert_same_instant(actual: &str, expected: &str) {
    assert_eq!(
        chrono::DateTime::parse_from_rfc3339(actual).unwrap(),
        chrono::DateTime::parse_from_rfc3339(expected).unwrap()
    );
}

fn append(path: &Path, text: &str) {
    OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

fn source_snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, dir: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, files);
            } else {
                files.insert(
                    path.strip_prefix(root).unwrap().into(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut files = BTreeMap::new();
    visit(root, root, &mut files);
    files
}

#[test]
fn antigravity_metadata_text_search_order_and_read_only_backup() {
    let h = Harness::new();
    h.standard_metadata();
    h.write(&[
        assistant(30, "Synthetic answer 修正"),
        user(10, "First question parse_request"),
        user(20, "Second question 中文"),
    ]);
    let before = source_snapshot(&h.root);
    for path in before.keys() {
        let path = h.root.join(path);
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions).unwrap();
    }
    h.sync();
    let session = h.session();
    assert_eq!(session.kind, AgentKind::Antigravity);
    assert_eq!(session.external_id, ID);
    assert_eq!(session.title, "Native conversation title");
    assert_eq!(session.cwd.as_deref(), Some(CWD));
    assert_same_instant(&session.updated_at, "2026-01-03T12:30:00Z");
    assert!(session.resume_disabled_reason.is_some());
    assert_eq!(h.total("parse_request"), 1);
    assert_eq!(h.total("中文"), 1);
    assert_eq!(h.total("Synthetic answer"), 1);
    assert_eq!(h.total("METADATA_PRIVATE"), 0);
    assert_eq!(
        h.texts(),
        vec![
            "First question parse_request",
            "Second question 中文",
            "Synthetic answer 修正"
        ]
    );
    let page = h.page();
    assert_eq!(page.messages[0].role, "user");
    assert_eq!(
        page.messages[0].timestamp.as_deref(),
        Some("2026-01-02T00:00:00.000Z")
    );
    assert_eq!(source_snapshot(&h.root), before);
}

#[test]
fn antigravity_tool_thinking_system_and_metadata_content_stays_private() {
    let h = Harness::new();
    h.standard_metadata();
    let mut response = assistant(3, "Public response");
    response["thinking"] = json!("THINKING_PRIVATE");
    response["tool_calls"] = json!([{"name":"run_command","args":{"command":"TOOL_ARGS_PRIVATE"}}]);
    h.write(&[
        user(1, "Public question"),
        step(2, "MODEL", "RUN_COMMAND", "TOOL_RESULT_PRIVATE"),
        response,
        step(4, "SYSTEM", "SYSTEM_MESSAGE", "SYSTEM_PRIVATE"),
        step(5, "MODEL", "VIEW_FILE", "FILE_PRIVATE"),
    ]);
    h.sync();
    assert_eq!(h.total("PRIVATE"), 0);
    assert!(!h.page().messages.iter().any(|m| m.text.contains("PRIVATE")));
    assert!(h.texts().contains(&"Public question".into()));
    assert!(h.texts().contains(&"Public response".into()));
}

#[test]
fn antigravity_append_rewrite_and_truncate_replace_search_and_preview() {
    let h = Harness::new();
    h.standard_metadata();
    let path = h.write(&[user(10, "ORIGINAL_TOKEN"), assistant(20, "ORIGINAL_ANSWER")]);
    h.sync();
    h.append(user(30, "APPENDED_TOKEN"));
    assert!(h.page().stale);
    h.sync();
    assert_eq!(h.total("APPENDED_TOKEN"), 1);
    assert_eq!(h.texts().len(), 3);
    h.write(&[user(5, "REWRITTEN_TOKEN"), assistant(6, "REWRITTEN_ANSWER")]);
    h.sync();
    assert_eq!(h.total("ORIGINAL_TOKEN"), 0);
    assert_eq!(h.total("ORIGINAL_ANSWER"), 0);
    assert_eq!(h.total("APPENDED_TOKEN"), 0);
    assert_eq!(h.texts(), vec!["REWRITTEN_TOKEN", "REWRITTEN_ANSWER"]);
    h.write(&[user(5, "TRUNCATED_TOKEN")]);
    h.sync();
    assert_eq!(h.total("REWRITTEN_TOKEN"), 0);
    assert_eq!(h.total("REWRITTEN_ANSWER"), 0);
    assert_eq!(h.texts(), vec!["TRUNCATED_TOKEN"]);
    fs::write(path, "").unwrap();
    h.sync();
    assert_eq!(h.total("TRUNCATED_TOKEN"), 0);
    assert!(h.texts().is_empty());
    assert!(h.page().warning.is_some());
}

#[test]
fn antigravity_exact_duplicate_steps_are_deduplicated() {
    let h = Harness::new();
    h.standard_metadata();
    let first = user(10, "One request");
    let second = assistant(20, "One response");
    h.write(&[second.clone(), first.clone(), second, first]);
    h.sync();
    assert_eq!(h.texts(), vec!["One request", "One response"]);
    h.sync();
    assert_eq!(h.texts(), vec!["One request", "One response"]);
}

#[test]
fn antigravity_conflicting_duplicate_steps_are_quarantined_even_after_append() {
    let h = Harness::new();
    h.standard_metadata();
    h.write(&[
        user(1, "Kept content"),
        assistant(2, "CONFLICT_OLD_PRIVATE"),
    ]);
    h.sync();
    assert_eq!(h.total("CONFLICT_OLD_PRIVATE"), 1);
    h.append(assistant(2, "CONFLICT_NEW_PRIVATE"));
    h.sync();
    assert_eq!(h.total("CONFLICT_OLD_PRIVATE"), 0);
    assert_eq!(h.total("CONFLICT_NEW_PRIVATE"), 0);
    assert_eq!(h.total("Kept content"), 1);
    assert!(!h.page().messages.iter().any(|m| m.text.contains("PRIVATE")));
    h.assert_partial_warning();
}

#[test]
fn antigravity_cleared_rows_do_not_resurrect_content_from_any_file_or_cache() {
    let h = Harness::new();
    h.standard_metadata();
    let old = user(1, "CLEARED_PRIVATE");
    h.write(&[old.clone(), assistant(2, "Kept answer")]);
    h.write_named(ID, "transcript_full.jsonl", std::slice::from_ref(&old));
    h.sync();
    assert_eq!(h.total("CLEARED_PRIVATE"), 1);
    // A tombstone can omit the timestamp and content. Duplicates have no
    // validated last-write-wins semantics, so old prose must stay quarantined.
    let cleared =
        json!({"step_index":1,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"CLEARED"});
    h.append(cleared.clone());
    h.sync();
    assert_eq!(h.total("CLEARED_PRIVATE"), 0);
    assert!(!h
        .page()
        .messages
        .iter()
        .any(|m| m.text.contains("CLEARED_PRIVATE")));
    h.assert_partial_warning();
    h.write(&[cleared.clone(), old]);
    h.sync();
    assert_eq!(h.total("CLEARED_PRIVATE"), 0);
    h.write(&[cleared]);
    h.sync();
    assert_eq!(h.total("CLEARED_PRIVATE"), 0);
    assert!(h.texts().iter().all(|text| !text.contains("PRIVATE")));
}

#[test]
fn antigravity_unknown_rows_and_malformed_lines_have_visible_partial_warning() {
    let h = Harness::new();
    h.standard_metadata();
    let path = h.write(&[
        user(1, "Supported request"),
        step(2, "MODEL", "FUTURE_EVENT", "UNKNOWN_PRIVATE"),
        json!({"role":"user","content":"GUESSED_PRIVATE"}),
        assistant(3, "Supported answer"),
    ]);
    append(&path, "{malformed\n");
    h.sync();
    assert_eq!(h.total("Supported request"), 1);
    assert_eq!(h.total("Supported answer"), 1);
    assert_eq!(h.total("PRIVATE"), 0);
    assert!(!h.page().messages.iter().any(|m| m.text.contains("PRIVATE")));
    h.assert_partial_warning();
}

#[test]
fn antigravity_unknown_only_transcript_is_not_silently_presented_as_complete() {
    let h = Harness::new();
    h.standard_metadata();
    h.write(&[json!({"role":"assistant","content":"UNKNOWN_ONLY_PRIVATE"})]);
    let status = h.sync();
    assert_eq!(h.total("UNKNOWN_ONLY_PRIVATE"), 0);
    if h.sessions().is_empty() {
        assert!(
            !status.errors.is_empty()
                || status.sources.iter().any(|source| source.message.is_some()),
            "An unsupported schema must report why no session was imported"
        );
    } else {
        h.assert_partial_warning();
    }
}

#[test]
fn antigravity_metadata_only_session_lists_and_later_transcript_keeps_identity() {
    let h = Harness::new();
    h.standard_metadata();
    h.sync();
    let session = h.session();
    assert_eq!(session.title, "Native conversation title");
    assert_eq!(session.cwd.as_deref(), Some(CWD));
    assert!(session.partial);
    assert!(session.resume_disabled_reason.is_some());
    let page = h.page();
    assert!(page.messages.is_empty());
    assert!(page.warning.is_some());
    assert!(h.catalog.resume_source(&session.id).is_err());
    let trash_id = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    assert_eq!(h.total(""), 0);
    assert!(h.catalog.trashed_sessions(0, 40).unwrap().items[0]
        .unavailable_reason
        .is_none());
    h.catalog.restore_session(&trash_id).unwrap();
    assert_eq!(h.session().id, session.id);
    assert!(h.catalog.resume_source(&session.id).is_err());
    h.write(&[user(1, "Transcript now available")]);
    h.sync();
    assert_eq!(h.session().id, session.id);
    assert_eq!(h.texts(), vec!["Transcript now available"]);
}

#[test]
fn antigravity_missing_database_allows_partial_unknown_project_transcript() {
    let h = Harness::new();
    h.write(&[user(1, "Synthetic orphan transcript")]);
    h.sync();
    assert_eq!(h.session().external_id, ID);
    assert_eq!(h.session().cwd, None);
    assert_eq!(h.total("Synthetic orphan transcript"), 1);
    h.assert_partial_warning();
    h.standard_metadata();
    h.sync();
    assert_eq!(h.session().title, "Native conversation title");
    assert_eq!(h.session().cwd.as_deref(), Some(CWD));
    assert_eq!(h.total("Synthetic orphan transcript"), 1);
}

#[test]
fn antigravity_full_transcript_is_never_used_as_authoritative_content() {
    let h = Harness::new();
    h.standard_metadata();
    h.write_named(ID, "transcript_full.jsonl", &[user(1, "FULL_ONLY_TOKEN")]);
    h.sync();
    assert_eq!(h.total("FULL_ONLY_TOKEN"), 0);
    assert!(h.texts().is_empty());
    assert!(h
        .page()
        .warning
        .as_deref()
        .unwrap()
        .contains("transcript_full.jsonl"));
    h.assert_partial_warning();
    let id = h.session().id;
    h.write(&[user(2, "COMPACT_ONLY_TOKEN")]);
    h.sync();
    assert_eq!(h.session().id, id);
    assert_eq!(h.total("FULL_ONLY_TOKEN"), 0);
    assert_eq!(h.total("COMPACT_ONLY_TOKEN"), 1);
    assert_eq!(h.texts(), vec!["COMPACT_ONLY_TOKEN"]);
    // An existing but empty or malformed compact log must never cause stale
    // full-file content to be used as a replacement.
    h.write(&[]);
    h.sync();
    assert_eq!(h.total("FULL_ONLY_TOKEN"), 0);
    assert_eq!(h.total("COMPACT_ONLY_TOKEN"), 0);
    fs::write(h.logs(ID).join("transcript.jsonl"), "{broken\n").unwrap();
    h.sync();
    assert_eq!(h.total("FULL_ONLY_TOKEN"), 0);
    h.assert_partial_warning();
}

#[test]
fn antigravity_metadata_refresh_does_not_require_transcript_changes() {
    let h = Harness::new();
    h.standard_metadata();
    let path = h.write(&[user(1, "Persistent searchable request")]);
    h.sync();
    let id = h.session().id;
    let original_bytes = fs::read(&path).unwrap();
    let original_modified = fs::metadata(&path).unwrap().modified().unwrap();
    h.metadata(
        ID,
        "Renamed native title",
        "2026-03-04 05:06:07.12345+00:00",
        if cfg!(windows) {
            r#"["file:///C:/synthetic/renamed%20project"]"#
        } else {
            r#"["file:///synthetic/renamed%20project"]"#
        },
    );
    assert!(h.page().stale);
    h.sync();
    let session = h.session();
    assert_eq!(session.id, id);
    assert_eq!(session.title, "Renamed native title");
    assert_eq!(
        session.cwd.as_deref(),
        Some(if cfg!(windows) {
            "C:/synthetic/renamed project"
        } else {
            "/synthetic/renamed project"
        })
    );
    assert_same_instant(&session.updated_at, "2026-03-04T05:06:07.123Z");
    assert_eq!(h.total("Persistent searchable request"), 1);
    assert_eq!(fs::read(&path).unwrap(), original_bytes);
    assert_eq!(
        fs::metadata(path).unwrap().modified().unwrap(),
        original_modified
    );
}

#[test]
fn antigravity_does_not_scan_files_outside_the_exact_brain_layout() {
    let h = Harness::new();
    h.standard_metadata();
    h.write(&[user(1, "Correct layout content")]);
    let decoy = format!("{}\n", user(1, "WRONG_LAYOUT_PRIVATE"));
    for relative in [
        "transcript.jsonl".to_owned(),
        format!("brain/{OTHER_ID}/transcript.jsonl"),
        format!("brain/{OTHER_ID}/logs/transcript.jsonl"),
        format!("brain/{OTHER_ID}/.system_generated/logs/other.jsonl"),
        format!("brain/nested/{OTHER_ID}/.system_generated/logs/transcript.jsonl"),
        "brain/not-a-uuid/.system_generated/logs/transcript.jsonl".to_owned(),
        format!("sessions/{OTHER_ID}/.system_generated/logs/transcript.jsonl"),
    ] {
        let path = h.root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, &decoy).unwrap();
    }
    h.sync();
    assert_eq!(h.sessions().len(), 1);
    assert_eq!(h.total("Correct layout content"), 1);
    assert_eq!(h.total("WRONG_LAYOUT_PRIVATE"), 0);
}

#[test]
fn antigravity_unknown_metadata_schema_reports_an_error_without_guessing_project() {
    let h = Harness::new();
    let db = Connection::open(h.db_path()).unwrap();
    db.execute_batch("CREATE TABLE conversation_summaries (id TEXT, name TEXT); INSERT INTO conversation_summaries VALUES ('unknown', 'WRONG_SCHEMA_PRIVATE');")
        .unwrap();
    drop(db);
    h.write(&[user(1, "Readable fallback")]);
    let status = h.sync();
    assert_eq!(h.total("WRONG_SCHEMA_PRIVATE"), 0);
    assert!(
        !status.errors.is_empty()
            || status.sources.iter().any(|source| source.message.is_some())
            || h.sessions().iter().any(|session| session.partial),
        "Unknown metadata schema must be visible"
    );
    if !h.sessions().is_empty() {
        assert_eq!(h.session().cwd, None);
        h.assert_partial_warning();
    }
}

#[test]
fn antigravity_malformed_cleared_and_unknown_duplicates_quarantine_all_copies() {
    for invalid_first in [false, true] {
        let h = Harness::new();
        h.standard_metadata();
        let mut unknown_status = assistant(3, "UNKNOWN_STATUS_PRIVATE");
        unknown_status["status"] = json!("FUTURE_STATUS");
        let malformed_cleared = json!({
            "step_index":2,
            "source":"USER_EXPLICIT",
            "type":"USER_INPUT",
            "status":"CLEARED",
            "content":{"unsupported":"MALFORMED_CLEARED_PRIVATE"},
            "created_at":false
        });
        let valid = [
            user(2, "VALID_BUT_CLEARED_PRIVATE"),
            assistant(3, "VALID_BUT_CONFLICTING_PRIVATE"),
        ];
        let invalid = [malformed_cleared, unknown_status];
        let mut rows = vec![user(1, "Safe request")];
        if invalid_first {
            rows.extend(invalid);
            rows.extend(valid);
        } else {
            rows.extend(valid);
            rows.extend(invalid);
        }
        h.write(&rows);
        h.sync();
        assert_eq!(h.total("PRIVATE"), 0);
        assert_eq!(h.total("Safe request"), 1);
        assert!(!h.page().messages.iter().any(|m| m.text.contains("PRIVATE")));
        h.assert_partial_warning();
    }
}

#[test]
fn antigravity_step_order_pagination_includes_the_largest_supported_index() {
    let h = Harness::new();
    h.standard_metadata();
    h.write(&[
        assistant(i64::MAX as u64 - 1, "Last supported index"),
        user(0, "First index"),
        assistant(100, "Middle index"),
    ]);
    h.sync();
    assert_eq!(
        h.texts(),
        vec!["First index", "Middle index", "Last supported index"]
    );
    let id = h.session().id;
    let last = h.catalog.transcript(&id, None, 1).unwrap();
    assert_eq!(last.messages[0].text, "Last supported index");
    assert!(last.has_more);
    let middle = h.catalog.transcript(&id, last.before_line, 1).unwrap();
    assert_eq!(middle.messages[0].text, "Middle index");
    assert!(middle.has_more);
    let first = h.catalog.transcript(&id, middle.before_line, 1).unwrap();
    assert_eq!(first.messages[0].text, "First index");
    assert!(!first.has_more);
    assert_eq!(h.total("Last supported index"), 1);
}

#[test]
fn antigravity_removing_authoritative_compact_does_not_resurrect_full_history() {
    let h = Harness::new();
    h.standard_metadata();
    h.write_named(
        ID,
        "transcript_full.jsonl",
        &[user(1, "STALE_FULL_PRIVATE")],
    );
    let compact = h.write(&[user(1, "STALE_FULL_PRIVATE")]);
    h.sync();
    assert_eq!(h.total("STALE_FULL_PRIVATE"), 1);
    h.write(&[json!({
        "step_index":1,
        "source":"USER_EXPLICIT",
        "type":"USER_INPUT",
        "status":"CLEARED"
    })]);
    h.sync();
    assert_eq!(h.total("STALE_FULL_PRIVATE"), 0);
    fs::remove_file(compact).unwrap();
    h.sync();
    assert_eq!(h.total("STALE_FULL_PRIVATE"), 0);
    assert!(!h.page().messages.iter().any(|m| m.text.contains("PRIVATE")));
    h.assert_partial_warning();
    // The provenance decision must survive a new catalog handle, not only a
    // process-local remembered set.
    let reopened = Catalog::open(&h._temp.path().join("catalog.sqlite")).unwrap();
    reopened
        .sync(
            std::slice::from_ref(&h.source),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    assert_eq!(h.total("STALE_FULL_PRIVATE"), 0);
    // With no remaining source records, the cached session can be removed.
    // A later old full file must still never restore prose, even after cache clearing.
    fs::remove_file(h.db_path()).unwrap();
    fs::remove_file(h.logs(ID).join("transcript_full.jsonl")).unwrap();
    h.sync();
    assert!(h.sessions().is_empty());
    h.catalog.clear().unwrap();
    h.write_named(
        ID,
        "transcript_full.jsonl",
        &[user(1, "STALE_FULL_PRIVATE")],
    );
    let reopened = Catalog::open(&h._temp.path().join("catalog.sqlite")).unwrap();
    reopened
        .sync(
            std::slice::from_ref(&h.source),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    assert_eq!(h.total("STALE_FULL_PRIVATE"), 0);
    h.assert_partial_warning();
}

#[cfg(unix)]
#[test]
fn antigravity_symlink_at_exact_transcript_path_does_not_read_its_target() {
    use std::os::unix::fs::symlink;

    let h = Harness::new();
    h.standard_metadata();
    let target = h._temp.path().join("outside-source.jsonl");
    fs::write(&target, format!("{}\n", user(1, "SYMLINK_TARGET_PRIVATE"))).unwrap();
    let original = fs::read(&target).unwrap();
    fs::create_dir_all(h.logs(ID)).unwrap();
    symlink(&target, h.logs(ID).join("transcript.jsonl")).unwrap();
    let status = h.sync();
    assert_eq!(h.total("SYMLINK_TARGET_PRIVATE"), 0);
    assert_eq!(fs::read(target).unwrap(), original);
    assert_rejected_or_metadata_only(&h, &status);
}

#[cfg(unix)]
#[test]
fn antigravity_fifo_at_exact_transcript_path_is_not_opened_as_history() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let h = Harness::new();
    h.standard_metadata();
    fs::create_dir_all(h.logs(ID)).unwrap();
    let path = h.logs(ID).join("transcript.jsonl");
    let path_bytes = CString::new(path.as_os_str().as_bytes()).unwrap();
    // This FIFO has no writer. A blocking read would hang instead of importing
    // the safe metadata-only entry, so this also guards the file-type check.
    assert_eq!(unsafe { libc::mkfifo(path_bytes.as_ptr(), 0o600) }, 0);
    let status = h.sync();
    assert_rejected_or_metadata_only(&h, &status);
}

#[cfg(unix)]
fn assert_rejected_or_metadata_only(h: &Harness, status: &IndexStatus) {
    if h.sessions().is_empty() {
        assert!(
            !status.errors.is_empty()
                || status.sources.iter().any(|source| source.message.is_some()),
            "Non-regular transcript rejection must be visible"
        );
    } else {
        h.assert_partial_warning();
        assert!(h.page().messages.is_empty());
    }
}

#[test]
fn antigravity_equal_size_and_mtime_partial_tail_completion_is_reparsed() {
    let h = Harness::new();
    h.standard_metadata();
    let path = h.write(&[user(1, "First complete request")]);
    let last = assistant(2, "Previously torn answer").to_string();
    append(&path, &format!("{last} "));
    h.sync();
    assert_eq!(h.total("Previously torn answer"), 0);
    h.assert_partial_warning();
    let original = fs::metadata(&path).unwrap();
    let mut complete = fs::read(&path).unwrap();
    *complete.last_mut().unwrap() = b'\n';
    fs::write(&path, complete).unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(original.modified().unwrap())
        .unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), original.len());
    assert_eq!(
        fs::metadata(&path).unwrap().modified().unwrap(),
        original.modified().unwrap()
    );
    h.sync();
    assert_eq!(h.total("Previously torn answer"), 1);
    assert_eq!(
        h.texts(),
        vec!["First complete request", "Previously torn answer"]
    );
}

#[test]
fn antigravity_snapshot_covers_early_pages_and_stays_stable_without_visible_changes() {
    let h = Harness::new();
    h.standard_metadata();
    h.write(&[
        user(0, "EARLY original"),
        assistant(1, "middle"),
        assistant(2, "Unchanged newest"),
    ]);
    h.sync();
    let id = h.session().id;
    let newest = h.catalog.transcript(&id, None, 1).unwrap();
    let older = h.catalog.transcript(&id, newest.before_line, 1).unwrap();
    assert!(newest.snapshot_id.is_some());
    assert_eq!(newest.snapshot_id, older.snapshot_id);
    let token = newest.snapshot_id.clone().unwrap();
    assert!(!token.contains("EARLY"));
    assert!(!token.contains(h.root.to_str().unwrap()));
    h.sync();
    assert_eq!(
        h.catalog.transcript(&id, None, 1).unwrap().snapshot_id,
        newest.snapshot_id
    );
    h.write(&[
        user(0, "EARLY rewritten"),
        assistant(1, "middle"),
        assistant(2, "Unchanged newest"),
    ]);
    let stale = h.catalog.transcript(&id, None, 1).unwrap();
    assert!(stale.stale);
    assert!(stale.snapshot_id.is_none());
    h.sync();
    let revised = h.catalog.transcript(&id, None, 1).unwrap();
    assert_eq!(revised.messages[0].text, newest.messages[0].text);
    assert_ne!(revised.snapshot_id, newest.snapshot_id);
    assert_eq!(
        revised.snapshot_id,
        h.catalog
            .transcript(&id, revised.before_line, 1)
            .unwrap()
            .snapshot_id
    );
}

#[test]
fn antigravity_native_metadata_time_is_normalized_and_authoritative() {
    let h = Harness::new();
    h.metadata(
        ID,
        "Timestamp fixture",
        "2026-01-03 12:30:00.28859+00:00",
        &json!([WORKSPACE_URI]).to_string(),
    );
    let mut value = user(0, "A record with a later timestamp");
    value["created_at"] = json!("2027-01-01T00:00:00Z");
    h.write(&[value]);
    h.sync();
    assert_eq!(h.session().updated_at, "2026-01-03T12:30:00.288Z");
    assert_eq!(h.session().time_source, "event");
}

#[test]
fn antigravity_empty_root_and_unknown_layout_keep_distinct_source_health() {
    let h = Harness::new();
    let empty = h.sync();
    assert_eq!(empty.sources[0].status, "empty");
    assert!(empty.errors.is_empty());
    assert!(h.sessions().is_empty());
    let unknown = h
        .root
        .join("brain/not-a-uuid/.system_generated/logs/transcript.jsonl");
    fs::create_dir_all(unknown.parent().unwrap()).unwrap();
    fs::write(
        &unknown,
        format!("{}\n", user(1, "UNSUPPORTED_LAYOUT_PRIVATE")),
    )
    .unwrap();
    let unsupported = h.sync();
    assert_eq!(unsupported.sources[0].status, "error");
    assert!(!unsupported.errors.is_empty());
    assert_eq!(h.total("UNSUPPORTED_LAYOUT_PRIVATE"), 0);
    fs::remove_dir_all(&h.root).unwrap();
    assert_eq!(h.sync().sources[0].status, "missing");
}

#[test]
fn removal_inspection_keeps_metadata_only_records_explicitly_shared() {
    let h = Harness::new();
    h.standard_metadata();
    h.sync();
    let session = h.sessions().remove(0);
    let id = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    let before = fs::read(h.db_path()).unwrap();
    let inspection = h.catalog.inspect_removal(&id).unwrap();
    assert_eq!(inspection.indexed_artifacts.len(), 1);
    assert_eq!(inspection.indexed_artifacts[0].status, "sharedStore");
    assert!(inspection.indexed_artifacts[0]
        .relative_path
        .starts_with("conversation_summaries.db"));
    assert!(inspection.blockers[0].contains("deleting the whole database is not allowed"));
    assert_eq!(fs::read(h.db_path()).unwrap(), before);
}
