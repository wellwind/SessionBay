//! Synthetic Grok durable-storage fixtures only; never invoke a CLI or read user history.
use serde_json::{json, Value};
use sessionbay_lib::catalog::{session_identity, Catalog};
use sessionbay_lib::models::{AgentKind, HistorySource, IndexStatus, Session, SessionQuery};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use tempfile::TempDir;

struct Harness {
    _temp: TempDir,
    catalog: Catalog,
    source: HistorySource,
    session_dir: PathBuf,
}
impl Harness {
    fn new(encoded: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("grok");
        let session_dir = root.join("sessions").join(encoded).join("grok-session");
        fs::create_dir_all(&session_dir).unwrap();
        let catalog = Catalog::open(&temp.path().join("catalog.sqlite")).unwrap();
        Self {
            source: HistorySource {
                id: "grok-source".into(),
                kind: AgentKind::Grok,
                root: root.to_string_lossy().into(),
                enabled: true,
            },
            _temp: temp,
            catalog,
            session_dir,
        }
    }
    fn write_summary(&self, value: Value) {
        fs::write(
            self.session_dir.join("summary.json"),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }
    fn write_updates(&self, values: &[Value]) {
        fs::write(
            self.session_dir.join("updates.jsonl"),
            values.iter().map(|v| format!("{v}\n")).collect::<String>(),
        )
        .unwrap();
    }
    fn append(&self, value: Value) {
        append(
            &self.session_dir.join("updates.jsonl"),
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
        self.catalog.query(&SessionQuery::default()).unwrap().items
    }
    fn total(&self, text: &str) -> u64 {
        self.catalog
            .query(&SessionQuery {
                query: Some(text.into()),
                ..Default::default()
            })
            .unwrap()
            .total
    }
    fn texts(&self) -> Vec<String> {
        self.catalog
            .transcript(&self.sessions()[0].id, None, 200)
            .unwrap()
            .messages
            .into_iter()
            .map(|m| m.text)
            .collect()
    }
}
fn append(path: &Path, text: &str) {
    OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}
fn summary() -> Value {
    json!({"info":{"id":"grok-session","cwd":"/synthetic/project"},"session_summary":"Fallback summary","generated_title":"Grok generated title","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-03T00:00:00Z","last_active_at":"2026-01-02T00:00:00Z","num_messages":2,"current_model_id":"grok-code-test","parent_session_id":"parent"})
}
fn chunk(role: &str, text: &str) -> Value {
    json!({"timestamp":1767312000,"method":"session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":format!("{role}_message_chunk"),"content":{"type":"text","text":text}}}})
}
fn indexed_chunk(role: &str, text: &str, prompt: u64) -> Value {
    let mut value = chunk(role, text);
    value["params"]["update"]["_meta"] = json!({"promptIndex":prompt});
    value
}
fn rewind(target: u64) -> Value {
    json!({"method":"_x.ai/session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"rewind_marker","target_prompt_index":target}}})
}

#[test]
fn grok_summary_authoritative_updates_and_read_only_preview() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    h.write_updates(&[
        chunk("user", "修正 parse_request"),
        chunk("agent", "Synthetic answer"),
    ]);
    fs::write(
        h.session_dir.join("chat_history.jsonl"),
        format!("{}\n", chunk("user", "DERIVED_CACHE_NEVER_INDEXED")),
    )
    .unwrap();
    fs::write(
        h.session_dir.join("feedback.jsonl"),
        format!("{}\n", chunk("user", "FEEDBACK_NEVER_INDEXED")),
    )
    .unwrap();
    let before = [
        "summary.json",
        "updates.jsonl",
        "chat_history.jsonl",
        "feedback.jsonl",
    ]
    .map(|name| fs::read(h.session_dir.join(name)).unwrap());
    let status = h.sync();
    assert!(status.errors.is_empty(), "{:?}", status.errors);
    assert_eq!(status.sources[0].files, 1);
    let sessions = h.sessions();
    assert_eq!(sessions.len(), 1);
    let s = &sessions[0];
    assert_eq!(s.external_id, "grok-session");
    assert_eq!(s.title, "Grok generated title");
    assert_eq!(s.cwd.as_deref(), Some("/synthetic/project"));
    assert_eq!(s.updated_at, "2026-01-02T00:00:00.000Z");
    assert_eq!(
        s.parent_id.as_deref(),
        Some(session_identity(&h.source, "parent").as_str())
    );
    assert!(!s.partial);
    assert_eq!(h.total("修正"), 1);
    assert_eq!(h.total("Synthetic answer"), 1);
    assert_eq!(h.total("DERIVED_CACHE_NEVER_INDEXED"), 0);
    assert_eq!(h.total("FEEDBACK_NEVER_INDEXED"), 0);
    let page = h.catalog.transcript(&s.id, None, 100).unwrap();
    assert_eq!(page.messages.len(), 2);
    assert_eq!(
        page.messages[0].timestamp.as_deref(),
        Some("2026-01-02T00:00:00.000Z")
    );
    assert_eq!(
        [
            "summary.json",
            "updates.jsonl",
            "chat_history.jsonl",
            "feedback.jsonl"
        ]
        .map(|name| fs::read(h.session_dir.join(name)).unwrap()),
        before
    );
}

#[test]
fn grok_hashed_cwd_legacy_missing_summary_and_metadata_repair() {
    let h = Harness::new("project-1234567890abcdef");
    fs::write(
        h.session_dir.parent().unwrap().join(".cwd"),
        "/synthetic/project\n",
    )
    .unwrap();
    let legacy = chunk("user", "Legacy content")["params"].clone();
    h.write_updates(&[legacy]);
    h.sync();
    assert_eq!(h.sessions()[0].cwd.as_deref(), Some("/synthetic/project"));
    assert!(h.sessions()[0].partial);
    assert_eq!(h.total("Legacy content"), 1);
    h.write_summary(summary());
    h.sync();
    assert!(!h.sessions()[0].partial);
    assert_eq!(h.sessions()[0].title, "Grok generated title");
}

#[test]
fn grok_summary_only_sessions_and_later_stream_transition() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    h.sync();
    let s = h.sessions()[0].clone();
    assert!(s.partial);
    assert!(h.texts().is_empty());
    assert!(h.catalog.resume_source(&s.id).is_err());
    h.write_updates(&[chunk("user", "Now available")]);
    h.sync();
    assert_eq!(h.sessions()[0].id, s.id);
    assert!(!h.sessions()[0].partial);
    assert_eq!(h.texts(), vec!["Now available"]);
}

#[test]
fn grok_summary_changes_refresh_without_touching_updates() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    h.write_updates(&[chunk("user", "Searchable content")]);
    h.sync();
    let before = fs::metadata(h.session_dir.join("updates.jsonl"))
        .unwrap()
        .modified()
        .unwrap();
    let id = h.sessions()[0].id.clone();
    let mut changed = summary();
    changed["generated_title"] = json!("Updated title");
    changed["last_active_at"] = json!("2026-03-01T00:00:00Z");
    h.write_summary(changed);
    assert!(h.catalog.transcript(&id, None, 10).unwrap().stale);
    assert!(h
        .catalog
        .resume_source(&id)
        .unwrap_err()
        .contains("metadata changed"));
    h.sync();
    assert_eq!(h.sessions()[0].title, "Updated title");
    assert_eq!(h.sessions()[0].updated_at, "2026-03-01T00:00:00.000Z");
    assert_eq!(h.total("Searchable content"), 1);
    assert_eq!(
        fs::metadata(h.session_dir.join("updates.jsonl"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
}

#[test]
fn grok_incremental_rewind_removes_search_preview_and_title() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    let mut metadata = summary();
    metadata["generated_title"] = Value::Null;
    metadata["session_summary"] = json!("");
    h.write_summary(metadata);
    h.write_updates(&[
        chunk("user", "Keep this"),
        chunk("agent", "Keep answer"),
        chunk("user", "Discard old branch"),
        chunk("agent", "Discard old answer"),
    ]);
    h.sync();
    assert_eq!(h.total("Discard old"), 1);
    h.append(rewind(1));
    h.append(chunk("user", "Replacement"));
    h.sync();
    assert_eq!(h.total("Discard old"), 0);
    assert_eq!(h.texts(), vec!["Keep this", "Keep answer", "Replacement"]);
    h.append(rewind(0));
    h.append(chunk("user", "Fresh beginning"));
    h.sync();
    assert_eq!(h.sessions()[0].title, "Fresh beginning");
    assert_eq!(h.texts(), vec!["Fresh beginning"]);
    assert_eq!(h.total("Keep this"), 0);
    h.sync();
    assert_eq!(h.texts(), vec!["Fresh beginning"]);
}

#[test]
fn grok_prompt_index_chunks_and_phantom_runs_rewind_correctly() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    h.write_updates(&[
        indexed_chunk("user", "first part", 0),
        indexed_chunk("user", "second part", 0),
        chunk("agent", "kept answer"),
        chunk("user", "phantom context"),
        chunk("agent", "kept phantom response"),
        indexed_chunk("user", "removed turn", 1),
    ]);
    h.sync();
    h.append(rewind(1));
    h.append(indexed_chunk("user", "replacement turn", 1));
    h.sync();
    assert_eq!(h.total("removed turn"), 0);
    assert_eq!(h.total("phantom context"), 1);
    assert_eq!(h.texts().len(), 5);
    h.append(rewind(50));
    h.sync();
    assert_eq!(h.texts().len(), 5);
}

#[test]
fn grok_malformed_unknown_tool_reasoning_and_partial_line_safety() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    let mut tool = chunk("user", "TOOL_SECRET");
    tool["params"]["update"]["sessionUpdate"] = json!("tool_call_update");
    let mut thought = chunk("user", "REASONING_SECRET");
    thought["params"]["update"]["sessionUpdate"] = json!("agent_thought_chunk");
    let mut unknown = chunk("user", "UNKNOWN_SECRET");
    unknown["params"]["update"]["sessionUpdate"] = json!("future_update");
    h.write_updates(&[chunk("user", "Supported content"), tool, thought, unknown]);
    append(&h.session_dir.join("updates.jsonl"), "not json\n");
    let late = chunk("agent", "Appended content").to_string();
    append(&h.session_dir.join("updates.jsonl"), &late);
    h.sync();
    assert!(h.sessions()[0].partial);
    assert_eq!(h.total("SECRET"), 0);
    assert_eq!(h.total("Appended content"), 0);
    assert!(h.texts().iter().any(|s| s.contains("Malformed")));
    append(&h.session_dir.join("updates.jsonl"), "\n");
    h.sync();
    assert_eq!(h.total("Appended content"), 1);
    assert!(!h.texts().join(" ").contains("SECRET"));
}

#[test]
fn grok_identity_conflict_does_not_leak_foreign_prose_or_rewind() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    let mut foreign = chunk("user", "FOREIGN_SECRET");
    foreign["params"]["sessionId"] = json!("other-session");
    let mut foreign_rewind = rewind(0);
    foreign_rewind["params"]["sessionId"] = json!("other-session");
    h.write_updates(&[
        chunk("user", "Keep correct session"),
        foreign,
        foreign_rewind,
    ]);
    h.sync();
    assert_eq!(h.total("FOREIGN_SECRET"), 0);
    assert_eq!(h.total("Keep correct session"), 1);
    assert!(h.sessions()[0].partial);
    assert!(h
        .catalog
        .resume_source(&h.sessions()[0].id)
        .unwrap_err()
        .contains("conflicting session"));
    let mut bad = summary();
    bad["info"]["id"] = json!("wrong-summary-id");
    h.write_summary(bad);
    h.sync();
    assert_eq!(h.sessions()[0].external_id, "grok-session");
    assert_eq!(h.total("Keep correct session"), 0);
}

#[test]
fn grok_cwd_conflicts_never_reassign_or_resume() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    let mut bad = summary();
    bad["info"]["cwd"] = json!("/synthetic/unrelated");
    h.write_summary(bad);
    h.write_updates(&[chunk("user", "CONFLICT_CONTENT")]);
    h.sync();
    assert_eq!(h.sessions()[0].cwd, None);
    assert_eq!(h.total("CONFLICT_CONTENT"), 0);
    assert!(h.catalog.resume_source(&h.sessions()[0].id).is_err());
    h.write_summary(summary());
    h.sync();
    assert_eq!(h.sessions()[0].cwd.as_deref(), Some("/synthetic/project"));
    assert!(!h.sessions()[0].partial);
}

#[test]
fn antigravity_does_not_import_grok_history_as_cli_transcripts() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    h.write_updates(&[chunk("user", "No fake import")]);
    let mut source = h.source.clone();
    source.kind = AgentKind::Antigravity;
    let status = h
        .catalog
        .sync(&[source], &AtomicBool::new(false), |_| {})
        .unwrap();
    assert_eq!(status.sources[0].status, "empty");
    assert_eq!(status.sources[0].files, 0);
    assert!(h.sessions().is_empty());
}

#[test]
fn grok_rewrite_removes_old_index_and_malformed_summary_recovers() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    h.write_updates(&[
        chunk("user", "Removed by rewrite"),
        chunk("agent", "Old answer"),
    ]);
    h.sync();
    h.write_updates(&[chunk("user", "Rewritten content")]);
    fs::write(h.session_dir.join("summary.json"), "{broken").unwrap();
    h.sync();
    assert_eq!(h.total("Removed by rewrite"), 0);
    assert_eq!(h.total("Rewritten content"), 1);
    assert_eq!(h.sessions()[0].title, "Rewritten content");
    assert!(h.sessions()[0].partial);
    h.write_summary(summary());
    h.sync();
    assert!(!h.sessions()[0].partial);
    assert_eq!(h.sessions()[0].title, "Grok generated title");
}

#[test]
fn grok_hashed_marker_change_invalidates_cached_preview_and_resume() {
    let h = Harness::new("project-1234567890abcdef");
    let marker = h.session_dir.parent().unwrap().join(".cwd");
    fs::write(&marker, "/synthetic/project").unwrap();
    h.write_summary(summary());
    h.write_updates(&[chunk("user", "Marker content")]);
    h.sync();
    let id = h.sessions()[0].id.clone();
    fs::write(&marker, "/synthetic/conflicting-project").unwrap();
    assert!(h.catalog.transcript(&id, None, 10).unwrap().stale);
    assert!(h
        .catalog
        .resume_source(&id)
        .unwrap_err()
        .contains("metadata changed"));
    h.sync();
    assert_eq!(h.sessions()[0].cwd, None);
    assert_eq!(h.total("Marker content"), 0);
}

#[test]
fn grok_read_only_files_and_duplicate_session_ids_are_safe() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    h.write_updates(&[chunk("user", "Read only content")]);
    for name in ["summary.json", "updates.jsonl"] {
        let path = h.session_dir.join(name);
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
    }
    h.sync();
    assert_eq!(h.texts(), vec!["Read only content"]);
    let second = Path::new(&h.source.root).join("sessions/%2Fsynthetic%2Fother/grok-session");
    fs::create_dir_all(&second).unwrap();
    let mut metadata = summary();
    metadata["info"]["cwd"] = json!("/synthetic/other");
    fs::write(second.join("summary.json"), metadata.to_string()).unwrap();
    fs::write(
        second.join("updates.jsonl"),
        format!("{}\n", chunk("user", "Duplicate identity")),
    )
    .unwrap();
    h.sync();
    assert_eq!(h.sessions().len(), 1);
    assert!(h.sessions()[0].partial);
    assert!(h
        .catalog
        .resume_source(&h.sessions()[0].id)
        .unwrap_err()
        .contains("Multiple files"));
}

#[test]
fn grok_host_turn_does_not_consume_a_rewind_prompt_index() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    let mut host = chunk("user", "HOST_SECRET");
    host["params"]["update"]["_meta"] = json!({"hostTurn":true,"promptIndex":1});
    h.write_updates(&[
        indexed_chunk("user", "First prompt", 0),
        chunk("agent", "First answer"),
        host,
        indexed_chunk("user", "Removed next prompt", 1),
        chunk("agent", "Removed answer"),
        rewind(1),
    ]);
    h.sync();
    assert_eq!(h.total("Removed"), 0);
    assert_eq!(h.total("HOST_SECRET"), 0);
    assert_eq!(h.total("First prompt"), 1);
    assert_eq!(h.texts().len(), 3);
}

#[test]
fn grok_coalesces_text_chunks_for_search_preview_and_append() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    let mut metadata = summary();
    metadata["generated_title"] = Value::Null;
    metadata["session_summary"] = json!("");
    h.write_summary(metadata);
    h.write_updates(&[
        indexed_chunk("user", "Fix authenti", 0),
        indexed_chunk("user", "cation failure", 0),
        chunk("agent", "I will repair authenti"),
    ]);
    h.sync();
    assert_eq!(h.total("authentication failure"), 1);
    assert_eq!(h.sessions()[0].title, "Fix authentication failure");
    assert_eq!(
        h.texts(),
        vec!["Fix authentication failure", "I will repair authenti"]
    );
    h.append(chunk("agent", "cation failure now."));
    h.sync();
    assert_eq!(
        h.texts(),
        vec![
            "Fix authentication failure",
            "I will repair authentication failure now."
        ]
    );
    assert_eq!(h.total("repair authentication failure"), 1);
    h.sync();
    assert_eq!(h.texts().len(), 2);
    let page = h.catalog.transcript(&h.sessions()[0].id, None, 1).unwrap();
    assert_eq!(
        page.messages[0].text,
        "I will repair authentication failure now."
    );
    assert!(page.has_more);
    let earlier = h
        .catalog
        .transcript(&h.sessions()[0].id, page.before_line, 1)
        .unwrap();
    assert_eq!(earlier.messages[0].text, "Fix authentication failure");
}

#[test]
fn grok_coalesced_rewind_drops_old_search_and_starts_a_new_message() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    h.write_updates(&[
        indexed_chunk("user", "Keep", 0),
        chunk("agent", "Kept reply"),
        indexed_chunk("user", "discarded authenti", 1),
        indexed_chunk("user", "cation failure", 1),
        chunk("agent", "discarded res"),
        chunk("agent", "ponse"),
    ]);
    h.sync();
    assert_eq!(h.total("discarded authentication failure"), 1);
    h.append(rewind(1));
    h.append(indexed_chunk("user", "new authenti", 1));
    h.sync();
    h.append(indexed_chunk("user", "cation request", 1));
    h.sync();
    assert_eq!(h.total("discarded authentication failure"), 0);
    assert_eq!(h.total("discarded response"), 0);
    assert_eq!(h.total("new authentication request"), 1);
    assert_eq!(
        h.texts(),
        vec!["Keep", "Kept reply", "new authentication request"]
    );
}

#[test]
fn grok_coalescing_respects_prompt_and_omitted_event_boundaries() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    let mut thought = chunk("agent", "PRIVATE_THOUGHT");
    thought["params"]["update"]["sessionUpdate"] = json!("agent_thought_chunk");
    h.write_updates(&[
        indexed_chunk("user", "first prompt", 0),
        indexed_chunk("user", "second prompt", 1),
        chunk("agent", "before thought"),
        thought,
        chunk("agent", "after thought"),
    ]);
    h.sync();
    assert_eq!(
        h.texts(),
        vec![
            "first prompt",
            "second prompt",
            "before thought",
            "[Internal reasoning omitted]",
            "after thought"
        ]
    );
    assert_eq!(h.total("PRIVATE_THOUGHT"), 0);
    assert_eq!(h.total("first promptsecond prompt"), 0);
    assert_eq!(h.total("before thoughtafter thought"), 0);
}

#[test]
fn grok_empty_chunks_and_torn_append_preserve_logical_message_and_title() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    let mut metadata = summary();
    metadata["generated_title"] = json!("");
    metadata["session_summary"] = json!("");
    h.write_summary(metadata);
    h.write_updates(&[chunk("user", ""), chunk("user", "Authen")]);
    h.sync();
    assert_eq!(h.sessions()[0].title, "Authen");
    assert_eq!(h.texts(), vec!["Authen"]);
    h.append(chunk("user", ""));
    h.sync();
    assert_eq!(h.texts(), vec!["Authen"]);
    append(
        &h.session_dir.join("updates.jsonl"),
        &chunk("user", "tication failure").to_string(),
    );
    h.sync();
    assert_eq!(h.sessions()[0].title, "Authen");
    assert!(h.sessions()[0].partial);
    append(&h.session_dir.join("updates.jsonl"), "\n");
    h.sync();
    assert_eq!(h.sessions()[0].title, "Authentication failure");
    assert_eq!(h.texts(), vec!["Authentication failure"]);
    assert_eq!(h.total("Authentication failure"), 1);
    h.append(chunk("agent", "authen"));
    h.append(chunk("agent", ""));
    h.append(chunk("agent", "tication repaired"));
    h.sync();
    assert_eq!(
        h.texts(),
        vec!["Authentication failure", "authentication repaired"]
    );
    assert_eq!(h.total("authentication repaired"), 1);
}

#[test]
fn grok_many_streaming_chunks_remain_a_single_searchable_message() {
    let h = Harness::new("%2Fsynthetic%2Fproject");
    h.write_summary(summary());
    let mut chunks = vec![chunk("user", "Long answer please")];
    chunks.extend((0..5000).map(|index| chunk("agent", &format!("token{index} "))));
    h.write_updates(&chunks);
    let start = std::time::Instant::now();
    h.sync();
    eprintln!(
        "5,000 synthetic Grok chunks indexed in {:?}",
        start.elapsed()
    );
    assert_eq!(h.texts().len(), 2);
    assert_eq!(h.total("token2499 token2500"), 1);
}
