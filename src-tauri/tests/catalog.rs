#[path = "support/revision_schema.rs"]
mod revision_schema;
use revision_schema::remove_revision_schema;
use serde_json::json;
use sessionbay_lib::catalog::Catalog;
use sessionbay_lib::models::{AgentKind, HistorySource, SessionQuery};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tempfile::TempDir;

#[cfg(unix)]
const SHARED_CWD: &str = "/synthetic/shared";
#[cfg(windows)]
const SHARED_CWD: &str = "C:/synthetic/shared";

const CODEX: &str = include_str!("../../fixtures/codex/standard.jsonl");
const CLAUDE: &str = include_str!("../../fixtures/claude/standard.jsonl");
const CHILD: &str = include_str!("../../fixtures/claude/subagent.jsonl");

struct Harness {
    _temp: TempDir,
    catalog: Catalog,
    root: PathBuf,
}
impl Harness {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        #[cfg(unix)]
        let root = root.canonicalize().unwrap();
        let catalog = Catalog::open(&root.join("app/index.sqlite")).unwrap();
        Self {
            _temp: temp,
            catalog,
            root,
        }
    }
    fn source(&self, id: &str, kind: AgentKind) -> HistorySource {
        HistorySource {
            id: id.into(),
            kind,
            root: self.root.join(id).to_string_lossy().into_owned(),
            enabled: true,
        }
    }
    fn write(&self, source: &HistorySource, relative: &str, text: &str) -> PathBuf {
        let path = Path::new(&source.root).join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            text.replace("\"/synthetic/shared\"", &format!("\"{SHARED_CWD}\"")),
        )
        .unwrap();
        path
    }
    fn sync(&self, sources: &[HistorySource]) {
        let status = self
            .catalog
            .sync(sources, &AtomicBool::new(false), |_| {})
            .unwrap();
        assert!(!status.running);
    }
    fn total(&self, query: &str) -> u64 {
        self.catalog
            .query(&SessionQuery {
                query: Some(query.into()),
                ..Default::default()
            })
            .unwrap()
            .total
    }
}
fn codex(id: &str, text: &str) -> String {
    format!(
        "{}\n{}\n",
        json!({"type":"session_meta","payload":{"id":id,"cwd":SHARED_CWD}}),
        json!({"timestamp":"2026-01-01T00:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})
    )
}

#[test]
fn session_batches_preserve_ties_and_support_both_time_orders() {
    let h = Harness::new();
    let source = h.source("lazy-synthetic", AgentKind::Codex);
    for i in 0..85 {
        let body = codex(&format!("batch-{i:03}"), "Synthetic bounded list");
        let body = if i >= 40 {
            body.replace("2026-01-01", "2026-02-01")
        } else {
            body
        };
        h.write(&source, &format!("sessions/row-{i}.jsonl"), &body);
    }
    h.sync(&[source]);
    for oldest_first in [false, true] {
        let mut items = Vec::new();
        for offset in [0, 40, 80] {
            let page = h
                .catalog
                .query(&SessionQuery {
                    oldest_first: Some(oldest_first),
                    offset: Some(offset),
                    limit: Some(40),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(page.total, 85);
            assert!(page.items.len() <= 40);
            items.extend(page.items);
        }
        assert_eq!(items.len(), 85);
        for pair in items.windows(2) {
            if pair[0].updated_at == pair[1].updated_at {
                assert!(pair[0].id < pair[1].id);
            } else if oldest_first {
                assert!(pair[0].updated_at < pair[1].updated_at);
            } else {
                assert!(pair[0].updated_at > pair[1].updated_at);
            }
        }
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
fn user(text: &str) -> String {
    format!(
        "{}\n",
        json!({"type":"response_item","timestamp":"2026-02-01T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})
    )
}

#[test]
fn cross_agent_grouping_literal_unicode_search_and_safe_tool_omission() {
    let h = Harness::new();
    let a = h.source("codex", AgentKind::Codex);
    let b = h.source("claude", AgentKind::Claude);
    let p = h.write(&a, "sessions/a.jsonl", CODEX);
    let q = h.write(&b, "projects/test/b.jsonl", CLAUDE);
    let before = (fs::read(&p).unwrap(), fs::read(&q).unwrap());
    h.sync(&[a, b]);
    let projects = h.catalog.projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].path.as_deref(), Some(SHARED_CWD));
    assert_eq!(projects[0].session_count, 2);
    assert_eq!(projects[0].agents.len(), 2);
    assert_eq!(h.total("中文"), 1);
    assert_eq!(h.total("登入"), 1);
    assert_eq!(h.total("parse_request"), 2);
    assert_eq!(h.total("100%_literal"), 1);
    assert_eq!(h.total("BUILD_LOG_NEVER_INDEXED"), 0);
    assert_eq!(h.total("%' OR 1=1 --"), 0);
    let page = h.catalog.query(&SessionQuery::default()).unwrap();
    let codex = page
        .items
        .iter()
        .find(|s| s.kind == AgentKind::Codex)
        .unwrap();
    let transcript = h.catalog.transcript(&codex.id, None, 100).unwrap();
    assert_eq!(
        transcript
            .messages
            .iter()
            .filter(|m| m.role == "user")
            .count(),
        1
    );
    assert_eq!((fs::read(&p).unwrap(), fs::read(&q).unwrap()), before);
}

#[test]
fn append_partial_line_checkpoint_and_idempotence() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let path = h.write(&source, "sessions/a.jsonl", &codex("s", "original"));
    h.sync(std::slice::from_ref(&source));
    let next = user("新增中文");
    append(&path, next.trim_end_matches('\n'));
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total("新增中文"), 0);
    assert!(h.catalog.query(&SessionQuery::default()).unwrap().items[0].partial);
    append(&path, "\n");
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total("新增中文"), 1);
    let s = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    assert!(!s.partial);
    h.sync(&[source]);
    assert_eq!(
        h.catalog
            .transcript(&s.id, None, 100)
            .unwrap()
            .messages
            .len(),
        2
    );
}

#[test]
fn codex_names_refresh_without_transcript_changes_and_stay_source_scoped() {
    let h = Harness::new();
    let a = h.source("first", AgentKind::Codex);
    let b = h.source("second", AgentKind::Codex);
    let transcript = codex("shared-id", "Actual task prompt");
    let path = h.write(&a, "sessions/a.jsonl", &transcript);
    h.write(&b, "sessions/b.jsonl", &transcript);
    let name_index = h.write(
        &a,
        "session_index.jsonl",
        "{\"id\":\"shared-id\",\"thread_name\":\"登入功能修正\"}\n",
    );
    h.write(
        &b,
        "session_index.jsonl",
        "{\"id\":\"shared-id\",\"thread_name\":\"付款流程驗證\"}\n",
    );
    h.sync(&[a.clone(), b.clone()]);
    assert_eq!(h.total("登入功能修正"), 1);
    assert_eq!(h.total("付款流程驗證"), 1);
    let original = h
        .catalog
        .query(&SessionQuery {
            query: Some("登入功能修正".into()),
            ..Default::default()
        })
        .unwrap()
        .items
        .remove(0);
    fs::write(
        &name_index,
        "{\"id\":\"shared-id\",\"thread_name\":\"登入回歸測試\"}\n",
    )
    .unwrap();
    h.sync(&[a.clone(), b.clone()]);
    let renamed = h.catalog.session(&original.id).unwrap();
    assert_eq!(renamed.title, "登入回歸測試");
    assert_eq!(renamed.updated_at, original.updated_at);
    assert_eq!(h.total("登入功能修正"), 0);
    assert_eq!(h.total("登入回歸測試"), 1);
    assert_eq!(h.total("付款流程驗證"), 1);
    assert_eq!(fs::read_to_string(&path).unwrap(), transcript);
    assert_eq!(
        fs::read_to_string(&name_index).unwrap(),
        "{\"id\":\"shared-id\",\"thread_name\":\"登入回歸測試\"}\n"
    );
    fs::remove_file(name_index).unwrap();
    h.sync(&[a, b]);
    assert_eq!(
        h.catalog.session(&original.id).unwrap().title,
        "Actual task prompt"
    );
    assert_eq!(h.total("登入回歸測試"), 0);
    assert_eq!(h.total("付款流程驗證"), 1);
}

#[test]
fn meaningful_task_title_replaces_old_parser_context_titles_on_refresh() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let context =
        "# AGENTS.md instructions for /synthetic\n<INSTRUCTIONS>Follow tests.</INSTRUCTIONS>";
    let transcript = format!(
        "{}{}{}",
        codex("s", context),
        user("<environment_context>settings</environment_context>"),
        user("修正資料來源設定視窗")
    );
    let path = h.write(&source, "sessions/a.jsonl", &transcript);
    h.sync(std::slice::from_ref(&source));
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    assert_eq!(session.title, "修正資料來源設定視窗");
    assert_eq!(h.total("AGENTS.md"), 1);
    let db = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    db.execute("UPDATE files SET parser_version=1,state=json_set(state,'$.first_user','old boilerplate title')", []).unwrap();
    db.execute("UPDATE sessions SET title='old boilerplate title'", [])
        .unwrap();
    drop(db);
    h.sync(&[source]);
    assert_eq!(
        h.catalog.session(&session.id).unwrap().title,
        "修正資料來源設定視窗"
    );
    assert_eq!(h.total("old boilerplate title"), 0);
    assert_eq!(fs::read_to_string(path).unwrap(), transcript);
}

#[test]
fn claude_name_remains_authoritative_after_summary_and_append() {
    let h = Harness::new();
    let source = h.source("claude", AgentKind::Claude);
    let path = h.write(&source, "projects/test/s.jsonl", &format!("{CLAUDE}{}\n{}\n",
        json!({"type":"custom-title","sessionId":"claude-synthetic-001","customTitle":"中文搜尋修正"}),
        json!({"type":"summary","summary":"Compaction summary"})
    ));
    h.sync(std::slice::from_ref(&source));
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    assert_eq!(session.title, "中文搜尋修正");
    append(
        &path,
        &format!(
            "{}\n{}\n",
            json!({"type":"custom-title","sessionId":"claude-synthetic-001","customTitle":"中文搜尋驗收"}),
            json!({"type":"summary","summary":"New compaction summary"})
        ),
    );
    h.sync(&[source]);
    assert_eq!(
        h.catalog.session(&session.id).unwrap().title,
        "中文搜尋驗收"
    );
    assert_eq!(h.total("中文搜尋驗收"), 1);
    assert_eq!(h.total("中文搜尋修正"), 0);
}

#[test]
fn truncation_replaces_old_identity_and_search_content() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let path = h.write(
        &source,
        "sessions/a.jsonl",
        &codex("old-id", "old-secret-value"),
    );
    h.sync(std::slice::from_ref(&source));
    fs::write(path, codex("new-id", "new-content")).unwrap();
    h.sync(&[source]);
    assert_eq!(h.total("old-secret-value"), 0);
    assert_eq!(h.total("new-content"), 1);
    assert_eq!(
        h.catalog.query(&SessionQuery::default()).unwrap().items[0].external_id,
        "new-id"
    );
}

#[test]
fn inode_replacement_and_in_place_prefix_rewrite_are_detected() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let path = h.write(&source, "sessions/a.jsonl", &codex("s", "AAAA"));
    h.sync(std::slice::from_ref(&source));
    let replacement = h.write(&source, "replacement.tmp", &codex("s", "BBBB"));
    fs::rename(replacement, &path).unwrap();
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total("AAAA"), 0);
    assert_eq!(h.total("BBBB"), 1);
    // Same inode, a same-length rewritten prefix, followed by new records.
    fs::write(&path, format!("{}{}", codex("s", "CCCC"), user("DDDD"))).unwrap();
    h.sync(&[source]);
    assert_eq!(h.total("BBBB"), 0);
    assert_eq!(h.total("CCCC"), 1);
    assert_eq!(h.total("DDDD"), 1);
}

#[test]
fn archive_move_preserves_identity_then_deletion_purges_search() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let path = h.write(&source, "sessions/a.jsonl", &codex("s", "archive me"));
    h.sync(std::slice::from_ref(&source));
    let id = h.catalog.query(&SessionQuery::default()).unwrap().items[0]
        .id
        .clone();
    let target = Path::new(&source.root).join("archived_sessions/a.jsonl");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::rename(path, &target).unwrap();
    h.sync(std::slice::from_ref(&source));
    let s = h.catalog.session(&id).unwrap();
    assert!(s.archived);
    assert_eq!(h.total("archive me"), 1);
    assert!(h.catalog.resume_source(&id).is_ok());
    fs::remove_file(target).unwrap();
    h.sync(&[source]);
    assert_eq!(h.total("archive me"), 0);
}

#[test]
fn cancelled_scan_has_consistent_checkpoint_and_can_resume() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    for i in 0..4 {
        h.write(
            &source,
            &format!("sessions/{i}.jsonl"),
            &codex(&format!("s{i}"), "searchable"),
        );
    }
    let cancel = AtomicBool::new(false);
    let status = h
        .catalog
        .sync(std::slice::from_ref(&source), &cancel, |status| {
            if status.processed == 1 {
                cancel.store(true, Ordering::Relaxed);
            }
        })
        .unwrap();
    assert!(status.cancelled);
    assert_eq!(status.processed, 1);
    assert_eq!(h.total("searchable"), 1);
    h.sync(&[source]);
    assert_eq!(h.total("searchable"), 4);
}

#[test]
fn missing_empty_and_invalid_sources_have_distinct_health_without_blocking_good_one() {
    let h = Harness::new();
    let missing = h.source("missing", AgentKind::Codex);
    let empty = h.source("empty", AgentKind::Codex);
    let bad = h.source("bad", AgentKind::Claude);
    let good = h.source("good", AgentKind::Codex);
    fs::create_dir(&empty.root).unwrap();
    fs::write(&bad.root, "not a directory").unwrap();
    let contents = codex("s", "available");
    let path = h.write(&good, "sessions/a.jsonl", &contents);
    let status = h
        .catalog
        .sync(
            &[missing.clone(), empty.clone(), bad.clone(), good],
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    assert_eq!(status.sources[0].status, "missing");
    assert_eq!(status.sources[0].files, 0);
    assert_eq!(status.sources[1].status, "empty");
    assert_eq!(status.sources[1].files, 0);
    assert_ne!(status.sources[0].message, status.sources[1].message);
    assert_eq!(status.sources[2].status, "error");
    assert_eq!(status.sources[3].status, "ready");
    assert_eq!(status.sources[3].files, 1);
    assert_eq!(h.total("available"), 1);
    assert_eq!(status.errors.len(), 1);
    assert!(status.errors[0].starts_with("bad:"));
    assert!(!Path::new(&missing.root).exists());
    assert_eq!(fs::read_dir(&empty.root).unwrap().count(), 0);
    assert_eq!(fs::read_to_string(&bad.root).unwrap(), "not a directory");
    assert_eq!(fs::read_to_string(path).unwrap(), contents);
}

#[test]
fn source_health_tracks_missing_empty_and_ready_transitions_and_prunes_removed_history() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let health = || {
        let status = h
            .catalog
            .sync(
                std::slice::from_ref(&source),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
        assert!(status.errors.is_empty());
        assert!(!status.cancelled);
        status.sources.into_iter().next().unwrap()
    };

    assert_eq!(health().status, "missing");
    assert!(!Path::new(&source.root).exists());
    fs::create_dir(&source.root).unwrap();
    assert_eq!(health().status, "empty");
    assert_eq!(fs::read_dir(&source.root).unwrap().count(), 0);

    let contents = codex("s", "available");
    let path = h.write(&source, "sessions/a.jsonl", &contents);
    let ready = health();
    assert_eq!(ready.status, "ready");
    assert_eq!(ready.files, 1);
    assert_eq!(h.total("available"), 1);
    assert_eq!(fs::read_to_string(&path).unwrap(), contents);

    fs::remove_file(path).unwrap();
    let empty = health();
    assert_eq!(empty.status, "empty");
    assert_eq!(empty.files, 0);
    assert_eq!(h.total("available"), 0);

    h.write(&source, "sessions/a.jsonl", &contents);
    assert_eq!(health().status, "ready");
    assert_eq!(h.total("available"), 1);
    fs::remove_dir_all(&source.root).unwrap();
    let missing = health();
    assert_eq!(missing.status, "missing");
    assert_eq!(missing.files, 0);
    assert_eq!(h.total("available"), 0);
    assert!(!Path::new(&source.root).exists());
}

#[test]
fn disabled_and_antigravity_sources_keep_distinct_health_when_roots_are_missing() {
    let h = Harness::new();
    let mut disabled = h.source("disabled", AgentKind::Codex);
    disabled.enabled = false;
    let unsupported = h.source("unsupported", AgentKind::Antigravity);
    let mut disabled_unsupported = h.source("disabled-unsupported", AgentKind::Antigravity);
    disabled_unsupported.enabled = false;
    let sources = [disabled, unsupported, disabled_unsupported];
    let status = h
        .catalog
        .sync(&sources, &AtomicBool::new(false), |_| {})
        .unwrap();

    assert_eq!(status.sources[0].status, "disabled");
    assert_eq!(status.sources[1].status, "missing");
    assert_eq!(status.sources[2].status, "disabled");
    assert!(status.sources.iter().all(|source| source.files == 0));
    assert!(status.errors.is_empty());
    assert!(sources
        .iter()
        .all(|source| !Path::new(&source.root).exists()));
}

#[test]
fn removed_root_disabled_source_and_removed_configuration_purge_content() {
    let h = Harness::new();
    let mut source = h.source("a", AgentKind::Codex);
    h.write(&source, "sessions/a.jsonl", &codex("s", "remove"));
    h.sync(std::slice::from_ref(&source));
    fs::remove_dir_all(&source.root).unwrap();
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total("remove"), 0);
    h.write(&source, "sessions/a.jsonl", &codex("s", "disable"));
    h.sync(std::slice::from_ref(&source));
    source.enabled = false;
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total("disable"), 0);
    source.enabled = true;
    h.sync(&[source]);
    assert_eq!(h.total("disable"), 1);
    h.sync(&[]);
    assert_eq!(h.total("disable"), 0);
}

#[test]
fn children_keep_source_relationship_and_are_hidden_by_default() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Claude);
    h.write(&source, "projects/test/a.jsonl", CLAUDE);
    h.write(
        &source,
        "projects/test/claude-synthetic-001/subagents/agent-synthetic-child.jsonl",
        CHILD,
    );
    h.sync(&[source]);
    let main = h.catalog.query(&SessionQuery::default()).unwrap();
    assert_eq!(main.total, 1);
    let all = h
        .catalog
        .query(&SessionQuery {
            include_children: Some(true),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(all.total, 2);
    let child = all
        .items
        .iter()
        .find(|s| s.external_id == "agent-synthetic-child")
        .unwrap();
    assert_eq!(child.parent_id.as_deref(), Some(main.items[0].id.as_str()));
    assert!(h.catalog.resume_source(&child.id).is_err());
}

#[test]
fn duplicate_sources_are_distinct_and_resume_never_guesses() {
    let h = Harness::new();
    let a = h.source("a", AgentKind::Codex);
    let mut b = h.source("b", AgentKind::Codex);
    h.write(&a, "sessions/a.jsonl", &codex("same", "source a"));
    h.write(&b, "sessions/b.jsonl", &codex("same", "source b"));
    h.sync(&[a.clone(), b.clone()]);
    let page = h.catalog.query(&SessionQuery::default()).unwrap();
    assert_eq!(page.total, 2);
    assert_ne!(page.items[0].id, page.items[1].id);
    let id = page
        .items
        .iter()
        .find(|s| s.source_id == "a")
        .unwrap()
        .id
        .clone();
    assert!(h
        .catalog
        .resume_source(&id)
        .unwrap_err()
        .contains("multiple history sources"));
    b.enabled = false;
    h.sync(&[a, b]);
    assert!(h.catalog.resume_source(&id).is_ok());
}

#[test]
fn duplicate_files_show_warning_and_block_resume() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(&source, "sessions/a.jsonl", &codex("same", "first"));
    h.write(&source, "sessions/b.jsonl", &codex("same", "second"));
    h.sync(&[source]);
    let page = h.catalog.query(&SessionQuery::default()).unwrap();
    assert_eq!(page.total, 1);
    assert!(page.items[0].partial);
    assert!(h
        .catalog
        .transcript(&page.items[0].id, None, 50)
        .unwrap()
        .warning
        .unwrap()
        .contains("Multiple"));
    assert!(h.catalog.resume_source(&page.items[0].id).is_err());
}

#[test]
fn lazy_transcript_pages_are_chronological_and_detect_stale_source() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let mut contents = codex("s", "first");
    for i in 0..8 {
        contents.push_str(&user(&format!("message {i}")));
    }
    let path = h.write(&source, "sessions/a.jsonl", &contents);
    h.sync(&[source]);
    let id = h.catalog.query(&SessionQuery::default()).unwrap().items[0]
        .id
        .clone();
    let last = h.catalog.transcript(&id, None, 3).unwrap();
    assert!(last.has_more);
    assert_eq!(last.messages[0].text, "message 5");
    assert_eq!(last.messages[2].text, "message 7");
    let earlier = h.catalog.transcript(&id, last.before_line, 3).unwrap();
    assert_eq!(earlier.messages[0].text, "message 2");
    assert_eq!(earlier.messages[2].text, "message 4");
    append(&path, &user("changed"));
    let stale = h.catalog.transcript(&id, None, 3).unwrap();
    assert!(stale.stale);
    assert!(stale.messages.is_empty());
    assert!(h.catalog.resume_source(&id).is_err());
}

#[test]
fn project_overrides_and_clear_never_modify_original_history() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let path = h.write(&source, "sessions/a.jsonl", &codex("s", "original"));
    h.sync(&[source]);
    let raw = fs::read(&path).unwrap();
    let project = h.catalog.projects().unwrap().remove(0);
    let relocated = h.root.join("relocated");
    fs::create_dir(&relocated).unwrap();
    let updated = h
        .catalog
        .update_project(
            &project.id,
            Some(true),
            Some(relocated.to_str().unwrap()),
            None,
            None,
        )
        .unwrap();
    assert!(updated.exists);
    assert_eq!(updated.path.as_deref(), Some(SHARED_CWD));
    let manual = h
        .catalog
        .add_project(h.root.to_str().unwrap(), None)
        .unwrap();
    assert_eq!(manual.session_count, 0);
    h.catalog.clear().unwrap();
    assert_eq!(h.total("original"), 0);
    let projects = h.catalog.projects().unwrap();
    assert_eq!(projects.len(), 2);
    assert!(projects.iter().any(|p| p.id == project.id && p.pinned));
    assert_eq!(raw, fs::read(path).unwrap());
}

#[test]
fn malformed_unknown_and_incomplete_records_are_tolerated() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let contents = format!(
        "{}not json\n{{\"type\":\"future_type\"}}\n{}{{\"unfinished\":",
        codex("s", "before"),
        user("after")
    );
    h.write(&source, "sessions/a.jsonl", &contents);
    let status = h
        .catalog
        .sync(&[source], &AtomicBool::new(false), |_| {})
        .unwrap();
    assert_eq!(status.sources[0].status, "partial");
    assert_eq!(h.total("after"), 1);
    let s = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    assert!(s.partial);
    let t = h.catalog.transcript(&s.id, None, 100).unwrap();
    assert!(t.messages.iter().any(|m| m.text.contains("Malformed")));
    assert!(t.messages.iter().any(|m| m.text.contains("Unsupported")));
}

#[test]
fn stable_pagination_and_date_filter_use_event_time() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    for i in 0..5 {
        h.write(
            &source,
            &format!("sessions/{i}.jsonl"),
            &codex(&format!("s{i}"), "same time"),
        );
    }
    h.sync(&[source]);
    let first = h
        .catalog
        .query(&SessionQuery {
            limit: Some(2),
            ..Default::default()
        })
        .unwrap();
    let second = h
        .catalog
        .query(&SessionQuery {
            limit: Some(2),
            offset: Some(2),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(first.total, 5);
    assert!(first
        .items
        .iter()
        .all(|a| second.items.iter().all(|b| a.id != b.id)));
    assert!(first.items.iter().all(|s| s.time_source == "event"));
    assert_eq!(
        h.catalog
            .query(&SessionQuery {
                before: Some("2026-01-01T00:00:00Z".into()),
                ..Default::default()
            })
            .unwrap()
            .total,
        0
    );
    assert!(h
        .catalog
        .query(&SessionQuery {
            after: Some("invalid".into()),
            ..Default::default()
        })
        .is_err());
}

#[test]
fn missing_cwd_stays_unclassified_and_mtime_fallback_is_explicit() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"missing-cwd\"}}\n",
    );
    h.sync(&[source]);
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    assert_eq!(session.project_id, "project-unclassified");
    assert!(session.cwd.is_none());
    assert_eq!(session.time_source, "mtime");
}

#[cfg(unix)]
#[test]
fn existing_symlink_paths_merge_without_losing_original_cwd() {
    use std::os::unix::fs::symlink;
    let h = Harness::new();
    let real = h.root.join("real");
    let alias = h.root.join("alias");
    fs::create_dir(&real).unwrap();
    symlink(&real, &alias).unwrap();
    let source = h.source("a", AgentKind::Codex);
    for (id, path) in [("one", real), ("two", alias)] {
        let content = codex(id, "same project").replace(SHARED_CWD, path.to_str().unwrap());
        h.write(&source, &format!("sessions/{id}.jsonl"), &content);
    }
    h.sync(&[source]);
    assert_eq!(h.catalog.projects().unwrap().len(), 1);
    let sessions = h.catalog.query(&SessionQuery::default()).unwrap();
    assert_ne!(sessions.items[0].cwd, sessions.items[1].cwd);
}

#[test]
fn future_schema_is_rejected_and_catalog_reopens_persisted_index() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(&source, "sessions/a.jsonl", &codex("s", "persistent"));
    h.sync(&[source]);
    let db = h.root.join("app/index.sqlite");
    assert_eq!(
        Catalog::open(&db)
            .unwrap()
            .query(&SessionQuery::default())
            .unwrap()
            .total,
        1
    );
    rusqlite::Connection::open(&db)
        .unwrap()
        .pragma_update(None, "user_version", 999)
        .unwrap();
    assert!(Catalog::open(&db).is_err());
}

#[test]
fn oversized_record_is_bounded_and_following_valid_record_is_indexed() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let mut contents = codex("s", "before huge record");
    contents.push_str(&"x".repeat(8 * 1024 * 1024 + 100));
    contents.push('\n');
    contents.push_str(&user("after huge record"));
    h.write(&source, "sessions/a.jsonl", &contents);
    h.sync(&[source]);
    assert_eq!(h.total("after huge record"), 1);
    let s = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    assert!(s.partial);
    let preview = h.catalog.transcript(&s.id, None, 100).unwrap();
    assert!(preview
        .messages
        .iter()
        .any(|m| m.text.contains("Oversized")));
}

#[cfg(unix)]
#[test]
fn permission_denied_source_is_not_reported_as_empty_or_purged() {
    use std::os::unix::fs::PermissionsExt;
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(&source, "sessions/a.jsonl", &codex("s", "cached"));
    h.sync(std::slice::from_ref(&source));
    fs::set_permissions(&source.root, fs::Permissions::from_mode(0o000)).unwrap();
    // Privileged CI can bypass Unix mode bits; skip the inaccessible assertion then.
    if fs::read_dir(&source.root).is_err() {
        let status = h
            .catalog
            .sync(
                std::slice::from_ref(&source),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
        assert_eq!(status.sources[0].status, "error");
        assert_eq!(h.total("cached"), 1);
    }
    fs::set_permissions(&source.root, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn cancellation_before_scan_preserves_existing_catalog() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(&source, "sessions/a.jsonl", &codex("s", "existing"));
    h.sync(&[source]);
    let status = h.catalog.sync(&[], &AtomicBool::new(true), |_| {}).unwrap();
    assert!(status.cancelled);
    assert_eq!(h.total("existing"), 1);
}

#[test]
fn queries_remain_available_during_background_indexing() {
    use std::sync::Arc;
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    for i in 0..100 {
        h.write(
            &source,
            &format!("sessions/{i}.jsonl"),
            &codex(&format!("s{i}"), "parallel 中文"),
        );
    }
    let catalog = h.catalog.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let worker_finished = finished.clone();
    let worker = std::thread::spawn(move || {
        catalog
            .sync(&[source], &AtomicBool::new(false), |_| {})
            .unwrap();
        worker_finished.store(true, Ordering::Release);
    });
    while !finished.load(Ordering::Acquire) {
        h.catalog
            .query(&SessionQuery {
                query: Some("中文".into()),
                ..Default::default()
            })
            .unwrap();
        std::thread::yield_now();
    }
    worker.join().unwrap();
    assert_eq!(h.total("parallel"), 100);
}

#[test]
fn source_root_reconfiguration_removes_previous_identity() {
    let h = Harness::new();
    let original = h.source("a", AgentKind::Codex);
    let replacement = h.source("b", AgentKind::Codex);
    h.write(
        &original,
        "sessions/a.jsonl",
        &codex("old", "previous root"),
    );
    h.write(
        &replacement,
        "sessions/b.jsonl",
        &codex("new", "replacement root"),
    );
    h.sync(std::slice::from_ref(&original));
    let updated = HistorySource {
        root: replacement.root,
        ..original
    };
    h.sync(&[updated]);
    assert_eq!(h.total("previous root"), 0);
    assert_eq!(h.total("replacement root"), 1);
}

#[test]
fn conflicting_session_metadata_does_not_reassign_or_resume_the_wrong_session() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        &format!(
            "{}{}",
            codex("first", "correct context"),
            codex("other", "unrelated context")
        ),
    );
    h.sync(&[source]);
    assert_eq!(h.total("correct context"), 1);
    assert_eq!(h.total("unrelated context"), 0);
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    assert_eq!(session.external_id, "first");
    assert!(session.partial);
    assert!(h
        .catalog
        .resume_source(&session.id)
        .unwrap_err()
        .contains("conflicting"));
}

#[test]
fn transcript_preview_has_unicode_safe_message_and_page_byte_budgets() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let text = format!("{}FULL_TEXT_STILL_SEARCHABLE", "中文".repeat(12_000));
    let mut content = codex("s", "first");
    for _ in 0..20 {
        content.push_str(&user(&text));
    }
    h.write(&source, "sessions/a.jsonl", &content);
    h.sync(&[source]);
    assert_eq!(h.total("FULL_TEXT_STILL_SEARCHABLE"), 1);
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    let page = h.catalog.transcript(&session.id, None, 200).unwrap();
    assert!(page.has_more);
    assert!(page.warning.unwrap().contains("shortened"));
    assert!(page.messages.iter().all(|m| m.text.len() <= 64 * 1024));
    assert!(page.messages.iter().map(|m| m.text.len()).sum::<usize>() <= 1024 * 1024);
    let earlier = h
        .catalog
        .transcript(&session.id, page.before_line, 200)
        .unwrap();
    assert!(!earlier.has_more);
    assert_eq!(earlier.messages.first().unwrap().text, "first");
}

#[test]
fn failed_initial_migration_rolls_back_new_tables() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("index.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE projects(existing_column TEXT);")
        .unwrap();
    drop(conn);
    assert!(Catalog::open(&path).is_err());
    let conn = rusqlite::Connection::open(&path).unwrap();
    let sources: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sources'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sources, 0);
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 0);
}

fn fts_integrity(path: &Path) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute(
        "INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)",
        [],
    )
    .unwrap();
}

#[test]
fn trigram_candidates_preserve_literal_punctuation_unicode_and_title_matching() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        &codex(
            "s",
            "[foo] 100%_literal \"quoted\" 中文搜尋 École test---case café",
        ),
    );
    h.sync(&[source]);
    let conn = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    conn.execute("UPDATE sessions SET title='Title-only-needle'", [])
        .unwrap();
    drop(conn);
    assert_eq!(h.total("Title-only-needle"), 1);
    for query in [
        "[foo]",
        "100%_literal",
        "\"quoted\"",
        "中文搜尋",
        "test---case",
        "café",
        "École",
    ] {
        assert_eq!(h.total(query), 1, "{query}");
    }
    for query in ["%literal", "' OR 1=1 --", "ecole", "cafe", "école"] {
        assert_eq!(h.total(query), 0, "{query}");
    }
    // SQLite lower() is ASCII-only. FTS Unicode folding must not widen results.
    assert_eq!(h.total("FOO"), 1);
    assert_eq!(h.total("中文"), 1);
    fts_integrity(&h.root.join("app/index.sqlite"));
}

#[test]
fn version_one_migration_rebuilds_fts_without_losing_projects_or_content() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        &codex("s", "migration_unique_word"),
    );
    h.sync(&[source]);
    let project = h.catalog.projects().unwrap().remove(0);
    h.catalog
        .update_project(&project.id, Some(true), None, None, None)
        .unwrap();
    let path = h.root.join("app/index.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    remove_revision_schema(&conn);
    conn.execute_batch("UPDATE sessions SET title='Neutral title'; DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_delete; DROP TRIGGER messages_fts_update; DROP TABLE messages_fts; DROP TABLE project_directories; DROP TABLE session_trash; ALTER TABLE sources DROP COLUMN storage_root; PRAGMA user_version=1;").unwrap();
    drop(conn);
    let migrated = Catalog::open(&path).unwrap();
    assert_eq!(
        migrated
            .query(&SessionQuery {
                query: Some("migration_unique_word".into()),
                ..Default::default()
            })
            .unwrap()
            .total,
        1
    );
    assert!(migrated.projects().unwrap()[0].pinned);
    let conn = rusqlite::Connection::open(&path).unwrap();
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 5);
    drop(conn);
    fts_integrity(&path);
}

#[test]
fn fts_tracks_updates_rollbacks_cascade_deletions_clear_and_rebuild() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let file = h.write(&source, "sessions/a.jsonl", &codex("s", "old_fts_token"));
    h.sync(std::slice::from_ref(&source));
    let path = h.root.join("app/index.sqlite");
    fts_integrity(&path);
    // Update-trigger correctness and rollback of index/content together.
    let mut conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("UPDATE sessions SET title='Neutral title'", [])
        .unwrap();
    let tx = conn.transaction().unwrap();
    tx.execute(
        "UPDATE messages SET search_text='rolled_back_fts_token' WHERE search_text<>''",
        [],
    )
    .unwrap();
    tx.rollback().unwrap();
    drop(conn);
    assert_eq!(h.total("old_fts_token"), 1);
    assert_eq!(h.total("rolled_back_fts_token"), 0);
    fts_integrity(&path);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "UPDATE messages SET search_text='updated_fts_token' WHERE search_text<>''",
        [],
    )
    .unwrap();
    drop(conn);
    assert_eq!(h.total("updated_fts_token"), 1);
    fts_integrity(&path);
    fs::write(&file, codex("s", "replaced_fts_token")).unwrap();
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total("updated_fts_token"), 0);
    assert_eq!(h.total("replaced_fts_token"), 1);
    fts_integrity(&path);
    fs::remove_file(&file).unwrap();
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total("replaced_fts_token"), 0);
    fts_integrity(&path);
    h.write(
        &source,
        "sessions/a.jsonl",
        &codex("s", "rebuilt_fts_token"),
    );
    h.sync(std::slice::from_ref(&source));
    h.catalog.clear().unwrap();
    assert_eq!(h.total("rebuilt_fts_token"), 0);
    fts_integrity(&path);
    h.sync(&[source]);
    assert_eq!(h.total("rebuilt_fts_token"), 1);
    fts_integrity(&path);
}

#[test]
fn sampled_trigrams_keep_long_unicode_queries_and_reject_disconnected_matches() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let query="長查詢跨過三十二個字元_sample_identifier_0123456789_含有\"引號\"與%底線_最後的中文測試內容";
    let chars: Vec<char> = query.chars().collect();
    let disconnected = chars
        .windows(3)
        .map(|part| part.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join(" | ");
    h.write(
        &source,
        "sessions/exact.jsonl",
        &codex("exact", &format!("before {query} after")),
    );
    h.write(
        &source,
        "sessions/disconnected.jsonl",
        &codex("disconnected", &disconnected),
    );
    h.sync(&[source]);
    let conn = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    conn.execute("UPDATE sessions SET title='Neutral'", [])
        .unwrap();
    drop(conn);
    let page = h
        .catalog
        .query(&SessionQuery {
            query: Some(query.into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].external_id, "exact");
    fts_integrity(&h.root.join("app/index.sqlite"));
}

#[test]
fn relative_cwd_is_preserved_but_never_resolved_against_application_directory() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        &codex("s", "relative cwd").replace(SHARED_CWD, "."),
    );
    h.sync(&[source]);
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    assert_eq!(session.cwd.as_deref(), Some("."));
    assert_eq!(session.project_id, "project-unclassified");
    let project = h.catalog.projects().unwrap().remove(0);
    assert!(project.path.is_none());
    assert!(!project.exists);
}

#[test]
fn exact_case_short_circuit_matches_original_ascii_fold_semantics() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let texts = [
        "parse_request and foo🤖 中文 123_%",
        "PARSE_REQUEST and FOO🤖 漢字標點",
        "Parse_Request mixed x X code-X",
        "É é ÄÖÜ 中文 a漢字 一A二",
        "École école 一a二 quoted \"FoO\"",
        "🙂🤖🚀 123_% 結尾 中文",
    ];
    for (index, text) in texts.iter().enumerate() {
        h.write(
            &source,
            &format!("sessions/{index}.jsonl"),
            &codex(&format!("s{index}"), text),
        );
    }
    h.sync(&[source]);
    let conn = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    conn.execute("UPDATE sessions SET title='Neutral'", [])
        .unwrap();
    conn.execute(
        "UPDATE sessions SET title='Title_MiXeD' WHERE external_id='s0'",
        [],
    )
    .unwrap();
    for query in [
        "parse_request",
        "PARSE_REQUEST",
        "Parse_Request",
        "x",
        "X",
        "中文",
        "漢字標點",
        "123_%",
        "É",
        "é",
        "ÄÖÜ",
        "一A二",
        "一a二",
        "code-X",
        "\"FoO\"",
        "🙂🤖🚀",
        "foo🤖",
        "title_mixed",
        "TITLE_MIXED",
    ] {
        let mut stmt=conn.prepare("SELECT s.id FROM sessions s WHERE instr(lower(s.title),lower(?1))>0 OR EXISTS(SELECT 1 FROM files f JOIN messages m ON m.file_id=f.id WHERE f.session_id=s.id AND m.hidden=0 AND instr(lower(m.search_text),lower(?1))>0) ORDER BY s.id").unwrap();
        let expected = stmt
            .query_map([query], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let result = h
            .catalog
            .query(&SessionQuery {
                query: Some(query.into()),
                ..Default::default()
            })
            .unwrap();
        let mut actual = result.items.into_iter().map(|s| s.id).collect::<Vec<_>>();
        actual.sort();
        assert_eq!(actual, expected, "query: {query}");
        assert_eq!(result.total, expected.len() as u64);
    }
}

#[test]
fn numbered_search_parameters_preserve_filters_and_unicode_snippet_positions() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let body = format!(
        "{} \"mixed_PARse_Request\" 中文標記",
        "前置資料".repeat(200)
    );
    h.write(&source, "sessions/a.jsonl", &codex("s", &body));
    h.sync(&[source]);
    let project = h.catalog.projects().unwrap().remove(0);
    for query in ["parse_request", "中文標記"] {
        let page = h
            .catalog
            .query(&SessionQuery {
                project_id: Some(project.id.clone()),
                kind: Some(AgentKind::Codex),
                archived: Some(false),
                after: Some("2025-12-31T00:00:00Z".into()),
                before: Some("2026-01-02T00:00:00Z".into()),
                query: Some(query.into()),
                limit: Some(1),
                offset: Some(0),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, 1);
        let snippet = page.items[0].snippet.as_ref().unwrap();
        assert!(snippet.to_ascii_lowercase().contains(query));
        assert!(snippet.chars().count() <= 222);
    }
}

#[test]
fn escaped_like_fallback_preserves_wildcards_backslashes_and_embedded_nul() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let texts = [
        "a_ a% a\\ path\\name literal_100% ",
        "axb axpercent axslash pathXname literalX100suffix",
        "École école ÄBC äbc",
        "prefix\0tailafterNULL and a_ a% a\\",
        "quoted \"foo\" and line\nbreak",
    ];
    for (index, text) in texts.iter().enumerate() {
        h.write(
            &source,
            &format!("sessions/{index}.jsonl"),
            &codex(&format!("s{index}"), text),
        );
    }
    h.sync(&[source]);
    let conn = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    let default_like: i64 = conn
        .query_row("SELECT 'a' LIKE 'A'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(default_like, 1);
    conn.execute("UPDATE sessions SET title='Neutral'", [])
        .unwrap();
    // case_sensitive_like is connection-local. A different connection cannot
    // change the fresh default used by any Catalog query.
    conn.execute_batch("PRAGMA case_sensitive_like=ON;")
        .unwrap();
    let other_like: i64 = conn
        .query_row("SELECT 'a' LIKE 'A'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(other_like, 0);
    for query in [
        "A_",
        "A%",
        "A\\",
        "PATH\\NAME",
        "LITERAL_100%",
        "ÉCOLE",
        "éCOLE",
        "ÄBC",
        "äBC",
        "TA",
        "TAILAFTERNULL",
        "\"FOO\"",
        "LINE\nBREAK",
    ] {
        let mut stmt=conn.prepare("SELECT s.id FROM sessions s WHERE instr(lower(s.title),lower(?1))>0 OR EXISTS(SELECT 1 FROM files f JOIN messages m ON m.file_id=f.id WHERE f.session_id=s.id AND m.hidden=0 AND instr(lower(m.search_text),lower(?1))>0) ORDER BY s.id").unwrap();
        let expected = stmt
            .query_map([query], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let page = h
            .catalog
            .query(&SessionQuery {
                query: Some(query.into()),
                ..Default::default()
            })
            .unwrap();
        let mut actual = page
            .items
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        actual.sort();
        assert_eq!(actual, expected, "query: {query}");
        assert_eq!(page.total, expected.len() as u64);
    }
}

#[test]
fn transcript_snapshot_is_stable_and_covers_older_codex_and_claude_pages() {
    for kind in [AgentKind::Codex, AgentKind::Claude] {
        let h = Harness::new();
        let source = h.source("snapshot-source", kind);
        let records = |middle: &str| {
            if kind == AgentKind::Codex {
                format!(
                    "{}{}{}",
                    codex("snapshot-id", "Fixed first title"),
                    user(middle),
                    user("Fixed newest page")
                )
            } else {
                ["Fixed first title", middle, "Fixed newest page"].into_iter().map(|text| format!("{}\n", json!({"type":"user","sessionId":"snapshot-id","cwd":SHARED_CWD,"timestamp":"2026-02-01T00:00:00Z","message":{"role":"user","content":text}}))).collect::<String>()
            }
        };
        let relative = if kind == AgentKind::Codex {
            "sessions/snapshot.jsonl"
        } else {
            "projects/synthetic/snapshot.jsonl"
        };
        let path = h.write(&source, relative, &records("Early original"));
        h.sync(std::slice::from_ref(&source));
        let id = h.catalog.query(&SessionQuery::default()).unwrap().items[0]
            .id
            .clone();
        let original = h.catalog.transcript(&id, None, 1).unwrap();
        assert_eq!(original.messages[0].text, "Fixed newest page");
        assert!(original.snapshot_id.is_some());
        assert_eq!(
            original.snapshot_id,
            h.catalog
                .transcript(&id, original.before_line, 1)
                .unwrap()
                .snapshot_id
        );
        h.sync(std::slice::from_ref(&source));
        assert_eq!(
            original.snapshot_id,
            h.catalog.transcript(&id, None, 1).unwrap().snapshot_id
        );
        fs::write(path, records("Early rewritten")).unwrap();
        let stale = h.catalog.transcript(&id, None, 1).unwrap();
        assert!(stale.stale);
        assert!(stale.snapshot_id.is_none());
        h.sync(std::slice::from_ref(&source));
        let revised = h.catalog.transcript(&id, None, 1).unwrap();
        assert_eq!(revised.messages[0].text, original.messages[0].text);
        assert_ne!(revised.snapshot_id, original.snapshot_id);
    }
}

fn fallback(role: &str, text: &str) -> String {
    format!(
        "{}\n",
        json!({"type":"event_msg","payload":{"type": if role == "user" { "user_message" } else { "agent_message" },"message":text}})
    )
}

#[test]
fn many_fallback_copies_preserve_exact_text_roles_append_and_rewrite() {
    let h = Harness::new();
    let source = h.source("duplicates", AgentKind::Codex);
    let header = format!(
        "{}\n",
        json!({"type":"session_meta","payload":{"id":"duplicates","cwd":SHARED_CWD}})
    );
    let mut text = header.clone();
    for i in 0..256 {
        let prose = format!("去重保留 Unicode {i} {}", "bounded message ".repeat(30));
        text.push_str(&fallback("user", &prose));
        text.push_str(&user(&prose));
    }
    text.push_str(&fallback("assistant", "same text different role"));
    text.push_str(&user("same text different role"));
    text.push_str(&fallback("user", "UNMATCHED_APPEND_TOKEN"));
    text.push_str(&fallback("user", "Case_Sensitive_É"));
    text.push_str(&user("case_sensitive_É"));
    let path = h.write(&source, "sessions/duplicates.jsonl", &text);
    // Keep the byte-for-byte baseline platform-correct before catalog sync.
    assert_eq!(fs::read_to_string(&path).unwrap(), text);
    h.sync(std::slice::from_ref(&source));
    assert_eq!(fs::read_to_string(&path).unwrap(), text);
    let db = h.root.join("app/index.sqlite");
    let count = |predicate: &str| -> i64 {
        rusqlite::Connection::open(&db)
            .unwrap()
            .query_row(
                &format!("SELECT COUNT(*) FROM messages WHERE {predicate}"),
                [],
                |row| row.get(0),
            )
            .unwrap()
    };
    assert_eq!(count("hidden=1"), 256);
    assert_eq!(count("hidden=0 AND role='assistant'"), 1);
    assert_eq!(count("hidden=0 AND search_text='Case_Sensitive_É'"), 1);
    assert_eq!(h.total("UNMATCHED_APPEND_TOKEN"), 1);
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    let before = h.catalog.transcript(&session.id, None, 200).unwrap();
    append(&path, &user("UNMATCHED_APPEND_TOKEN"));
    h.sync(std::slice::from_ref(&source));
    assert_eq!(count("hidden=1"), 257);
    assert_eq!(h.total("UNMATCHED_APPEND_TOKEN"), 1);
    let after = h.catalog.transcript(&session.id, None, 200).unwrap();
    assert_ne!(before.snapshot_id, after.snapshot_id);
    assert_eq!(
        after
            .messages
            .iter()
            .filter(|message| message.text == "UNMATCHED_APPEND_TOKEN")
            .count(),
        1
    );
    // Rewriting away canonical rows restores the surviving fallback visibility.
    let rewritten = format!("{header}{}", fallback("user", "UNMATCHED_APPEND_TOKEN"));
    fs::write(&path, &rewritten).unwrap();
    h.sync(std::slice::from_ref(&source));
    assert_eq!(count("hidden=1"), 0);
    assert_eq!(count("hidden=0"), 1);
    assert_eq!(h.total("去重保留 Unicode"), 0);
    assert_eq!(h.total("UNMATCHED_APPEND_TOKEN"), 1);
    assert_eq!(fs::read_to_string(path).unwrap(), rewritten);
    fts_integrity(&db);
    // Scratch hashes never become part of the persistent catalog schema.
    let conn = rusqlite::Connection::open(db).unwrap();
    let persisted: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'message_dedup%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(persisted, 0);
}

#[test]
fn fallback_digest_work_does_not_cross_source_or_file_boundaries() {
    let h = Harness::new();
    let first = h.source("first", AgentKind::Codex);
    let second = h.source("second", AgentKind::Codex);
    h.write(
        &first,
        "sessions/one.jsonl",
        &format!(
            "{}{}",
            codex("one", "canonical only"),
            fallback("user", "shared fallback")
        ),
    );
    h.write(
        &first,
        "sessions/two.jsonl",
        &format!(
            "{}{}",
            codex("two", "shared fallback"),
            fallback("user", "shared fallback")
        ),
    );
    h.write(
        &second,
        "sessions/three.jsonl",
        &format!(
            "{}{}",
            codex("three", "other text"),
            fallback("user", "shared fallback")
        ),
    );
    h.sync(&[first, second]);
    assert_eq!(h.total("shared fallback"), 3);
    let conn = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    let hidden: i64 = conn
        .query_row("SELECT COUNT(*) FROM messages WHERE hidden=1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(hidden, 1);
}

#[test]
fn recycle_bin_hides_search_counts_and_pagination_without_changing_originals() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let original = codex("trash-one", "recycle_unique_body");
    let path = h.write(&source, "sessions/a.jsonl", &original);
    let original_bytes = fs::read(&path).unwrap();
    h.write(
        &source,
        "sessions/b.jsonl",
        &codex("keep-two", "keep_unique_body"),
    );
    h.sync(std::slice::from_ref(&source));
    let session = h
        .catalog
        .query(&SessionQuery {
            query: Some("recycle_unique_body".into()),
            ..Default::default()
        })
        .unwrap()
        .items
        .remove(0);
    let trash_id = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    assert_eq!(
        h.catalog
            .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
            .unwrap(),
        trash_id
    );
    assert_eq!(h.total("recycle_unique_body"), 0);
    assert_eq!(h.total(""), 1);
    assert_eq!(h.catalog.projects().unwrap()[0].session_count, 1);
    let page = h
        .catalog
        .query(&SessionQuery {
            offset: Some(1),
            limit: Some(1),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page.total, 1);
    assert!(page.items.is_empty());
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total("recycle_unique_body"), 0);
    let trash = h.catalog.trashed_sessions(0, 40).unwrap();
    assert_eq!(trash.total, 1);
    assert!(trash.items[0].unavailable_reason.is_none());
    assert!(trash.items[0].session.snippet.is_none());
    // Runtime lookup retains real source/session metadata, independent of UI hiding.
    assert_eq!(
        h.catalog.session(&session.id).unwrap().external_id,
        session.external_id
    );
    h.catalog.restore_session(&trash_id).unwrap();
    h.catalog.restore_session(&trash_id).unwrap();
    assert_eq!(h.total("recycle_unique_body"), 1);
    assert_eq!(h.catalog.projects().unwrap()[0].session_count, 2);
    assert_eq!(fs::read(&path).unwrap(), original_bytes);
}

#[test]
fn recycle_bin_survives_clear_restart_source_disable_and_rebuild() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        &codex("s", "retained tombstone"),
    );
    h.sync(std::slice::from_ref(&source));
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
    h.catalog.clear().unwrap();
    let reopened = Catalog::open(&h.root.join("app/index.sqlite")).unwrap();
    assert_eq!(reopened.trashed_sessions(0, 40).unwrap().total, 1);
    assert!(reopened.trashed_sessions(0, 40).unwrap().items[0]
        .unavailable_reason
        .is_some());
    assert!(reopened.restore_session(&id).is_err());
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total(""), 0);
    let mut disabled = source.clone();
    disabled.enabled = false;
    h.sync(&[disabled]);
    assert!(h.catalog.restore_session(&id).is_err());
    assert_eq!(h.catalog.trashed_sessions(0, 40).unwrap().total, 1);
    h.sync(std::slice::from_ref(&source));
    h.catalog.restore_session(&id).unwrap();
    assert_eq!(h.total(""), 1);
}

#[test]
fn recycled_identity_does_not_hide_reused_source_id_at_another_root() {
    let h = Harness::new();
    let original = h.source("original", AgentKind::Codex);
    let mut replacement = h.source("replacement", AgentKind::Codex);
    h.write(&original, "sessions/a.jsonl", &codex("same-id", "original"));
    h.write(
        &replacement,
        "sessions/a.jsonl",
        &codex("same-id", "replacement"),
    );
    replacement.id = original.id.clone();
    h.sync(std::slice::from_ref(&original));
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    let old_trash = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    h.sync(std::slice::from_ref(&replacement));
    assert_eq!(h.total("replacement"), 1);
    assert!(h.catalog.restore_session(&old_trash).is_err());
    let replacement_session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    let new_trash = h
        .catalog
        .trash_session(
            &replacement_session.id,
            replacement_session.trash_identity.as_deref().unwrap(),
        )
        .unwrap();
    assert_ne!(new_trash, old_trash);
    assert_eq!(h.catalog.trashed_sessions(0, 1).unwrap().items.len(), 1);
    assert_eq!(h.catalog.trashed_sessions(1, 1).unwrap().total, 2);
    h.catalog.restore_session(&new_trash).unwrap();
    h.sync(std::slice::from_ref(&original));
    assert_eq!(h.total(""), 0);
    h.catalog.restore_session(&old_trash).unwrap();
    assert_eq!(h.total("original"), 1);
}

#[test]
fn recycle_bin_missing_original_is_unavailable_and_does_not_modify_it() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    let path = h.write(&source, "sessions/a.jsonl", &codex("s", "missing"));
    h.sync(std::slice::from_ref(&source));
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
    let moved = path.with_extension("backup");
    fs::rename(&path, &moved).unwrap();
    assert!(h.catalog.restore_session(&id).is_err());
    assert_eq!(h.catalog.trashed_sessions(0, 40).unwrap().total, 1);
    fs::rename(&moved, &path).unwrap();
    h.catalog.restore_session(&id).unwrap();
    assert_eq!(h.total(""), 1);
}

#[test]
fn version_three_migration_keeps_sessions_and_adds_empty_recycle_bin() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(&source, "sessions/a.jsonl", &codex("s", "migration"));
    h.sync(std::slice::from_ref(&source));
    let path = h.root.join("app/index.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    remove_revision_schema(&conn);
    conn.execute_batch("DROP TABLE session_trash; ALTER TABLE sources DROP COLUMN storage_root; PRAGMA user_version=3;").unwrap();
    drop(conn);
    let migrated = Catalog::open(&path).unwrap();
    assert_eq!(migrated.trashed_sessions(0, 40).unwrap().total, 0);
    let session = migrated
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    let id = migrated
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    assert_eq!(migrated.query(&SessionQuery::default()).unwrap().total, 0);
    migrated.restore_session(&id).unwrap();
    assert_eq!(migrated.query(&SessionQuery::default()).unwrap().total, 1);
}

#[cfg(unix)]
#[test]
fn recycle_bin_canonical_source_survives_alias_and_missing_mount_scan() {
    let h = Harness::new();
    let actual = h.source("real", AgentKind::Codex);
    h.write(&actual, "sessions/a.jsonl", &codex("s", "alias source"));
    let link = h.root.join("alias");
    std::os::unix::fs::symlink(&actual.root, &link).unwrap();
    let mut source = actual.clone();
    source.root = link.to_string_lossy().into_owned();
    h.sync(std::slice::from_ref(&source));
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
    fs::remove_file(&link).unwrap();
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total(""), 0);
    assert!(h.catalog.restore_session(&id).is_err());
    std::os::unix::fs::symlink(&actual.root, &link).unwrap();
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total(""), 0);
    // Changing source spelling to the same canonical root preserves the choice.
    source.root = actual.root;
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total(""), 0);
    h.catalog.restore_session(&id).unwrap();
    assert_eq!(h.total(""), 1);
}

#[test]
fn stale_undo_cannot_restore_a_later_trash_operation() {
    let h = Harness::new();
    let source = h.source("a", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        &codex("s", "same conversation"),
    );
    h.sync(&[source]);
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    let first = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    h.catalog.restore_session(&first).unwrap();
    let second = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    assert_ne!(first, second);
    h.catalog.restore_session(&first).unwrap();
    assert_eq!(h.total(""), 0);
    assert_eq!(
        h.catalog.trashed_sessions(0, 40).unwrap().items[0].id,
        second
    );
}

#[test]
fn review_stale_confirmation_must_not_hide_replacement_source() {
    let h = Harness::new();
    let original = h.source("original", AgentKind::Codex);
    let mut replacement = h.source("replacement", AgentKind::Codex);
    h.write(
        &original,
        "sessions/a.jsonl",
        &codex("same-id", "original reviewed title"),
    );
    h.write(
        &replacement,
        "sessions/a.jsonl",
        &codex("same-id", "replacement never confirmed"),
    );
    replacement.id = original.id.clone();
    h.sync(std::slice::from_ref(&original));
    // The UI keeps this Session in trashTarget while the confirmation is open.
    let selected = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    // A background scan finishes after the dialog opened.
    h.sync(std::slice::from_ref(&replacement));
    assert!(h
        .catalog
        .trash_session(&selected.id, selected.trash_identity.as_deref().unwrap())
        .is_err());
    assert_eq!(
        h.total("replacement never confirmed"),
        1,
        "confirming the old source must not hide the newly indexed source"
    );
}

#[cfg(unix)]
#[test]
fn review_cancelled_repoint_scan_must_not_resurrect_trashed_history() {
    use std::os::unix::fs::symlink;
    let h = Harness::new();
    let original = h.source("original", AgentKind::Codex);
    let replacement = h.source("replacement", AgentKind::Codex);
    h.write(
        &original,
        "sessions/a.jsonl",
        &codex("same-id", "hidden original"),
    );
    fs::create_dir_all(&replacement.root).unwrap();
    let alias = h.root.join("alias");
    symlink(&original.root, &alias).unwrap();
    let source = HistorySource {
        root: alias.to_string_lossy().into_owned(),
        ..original
    };
    h.sync(std::slice::from_ref(&source));
    let session = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    h.catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    fs::remove_file(&alias).unwrap();
    symlink(&replacement.root, &alias).unwrap();
    let cancel = AtomicBool::new(false);
    let status = h
        .catalog
        .sync(std::slice::from_ref(&source), &cancel, |_| {
            cancel.store(true, Ordering::Relaxed);
        })
        .unwrap();
    assert!(status.cancelled);
    assert_eq!(h.total("hidden original"), 0, "old tombstone must not be bypassed by updating the source root before reconciling its rows");
}

#[test]
fn provider_pause_retains_cached_history_and_resumes_discovery_and_reconciliation() {
    let h = Harness::new();
    let codex_source = h.source("paused-codex", AgentKind::Codex);
    let claude_source = h.source("active-claude", AgentKind::Claude);
    let old = h.write(
        &codex_source,
        "sessions/old.jsonl",
        &codex("paused-old", "cachedneedle"),
    );
    let active = h.write(&claude_source, "projects/test/active.jsonl", CLAUDE);
    let sources = vec![codex_source.clone(), claude_source];
    h.sync(&sources);
    assert_eq!(h.total("cachedneedle"), 1);
    assert_eq!(h.total("中文"), 1);
    let cached = h
        .catalog
        .query(&SessionQuery {
            query: Some("cachedneedle".into()),
            ..Default::default()
        })
        .unwrap()
        .items
        .remove(0);
    let conn = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    let cached_message_count = || {
        conn.query_row(
            "SELECT COUNT(*) FROM messages JOIN files ON files.id=messages.file_id WHERE files.session_id=?1",
            [&cached.id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
    };
    let original_messages = cached_message_count();
    assert_eq!(original_messages, 1);
    fs::remove_file(old).unwrap();
    fs::remove_file(active).unwrap();
    h.write(
        &codex_source,
        "sessions/new.jsonl",
        &codex("paused-new", "newneedle"),
    );
    let paused = std::collections::HashSet::from([AgentKind::Codex]);
    let status = h
        .catalog
        .sync_with_paused_providers(&sources, &paused, &AtomicBool::new(false), |_| {})
        .unwrap();
    assert!(status.errors.is_empty());
    assert_eq!(
        status
            .sources
            .iter()
            .find(|health| health.source_id == codex_source.id)
            .unwrap()
            .status,
        "paused"
    );
    assert_eq!(
        h.total("cachedneedle"),
        1,
        "paused history is not reconciled away"
    );
    assert_eq!(h.total("newneedle"), 0, "paused history is not discovered");
    assert_eq!(h.total("中文"), 0, "other providers still reconcile");
    assert!(h.catalog.history_source(&codex_source.id).unwrap().enabled);
    assert_eq!(cached_message_count(), original_messages);
    // Raw transcript preview still reports missing source files, even when its
    // searchable cache is intentionally retained by a provider pause.
    assert!(h.catalog.transcript(&cached.id, None, 100).unwrap().stale);
    h.sync(&sources);
    assert_eq!(h.total("cachedneedle"), 0);
    assert_eq!(h.total("newneedle"), 1);
}

#[test]
fn paused_source_configuration_changes_do_not_delete_cache_until_reenabled() {
    let h = Harness::new();
    let mut source = h.source("paused-codex", AgentKind::Codex);
    h.write(
        &source,
        "sessions/old.jsonl",
        &codex("paused-old", "cachedneedle"),
    );
    h.sync(&[source.clone()]);
    let original_root = source.root.clone();
    source.root = h
        .root
        .join("replacement-root")
        .to_string_lossy()
        .into_owned();
    source.enabled = false;
    h.catalog
        .sync_with_paused_providers(
            &[source.clone()],
            &std::collections::HashSet::from([AgentKind::Codex]),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    assert_eq!(h.total("cachedneedle"), 1);
    let cached_source = h.catalog.history_source(&source.id).unwrap();
    assert_eq!(cached_source.root, original_root);
    assert!(cached_source.enabled);
    h.sync(&[source]);
    assert_eq!(h.total("cachedneedle"), 0);
}

#[cfg(unix)]
#[test]
fn paused_provider_preserves_trash_provenance_until_reenabled() {
    use std::os::unix::fs::symlink;
    let h = Harness::new();
    let original = h.source("original", AgentKind::Codex);
    let replacement = h.source("replacement", AgentKind::Codex);
    h.write(
        &original,
        "sessions/a.jsonl",
        &codex("same-id", "hidden original"),
    );
    h.write(
        &replacement,
        "sessions/a.jsonl",
        &codex("same-id", "visible replacement"),
    );
    let alias = h.root.join("paused-alias");
    symlink(&original.root, &alias).unwrap();
    let source = HistorySource {
        root: alias.to_string_lossy().into_owned(),
        ..original.clone()
    };
    h.sync(std::slice::from_ref(&source));
    let selected = h
        .catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    h.catalog
        .trash_session(&selected.id, selected.trash_identity.as_deref().unwrap())
        .unwrap();
    fs::remove_file(&alias).unwrap();
    symlink(&replacement.root, &alias).unwrap();
    h.catalog
        .sync_with_paused_providers(
            std::slice::from_ref(&source),
            &std::collections::HashSet::from([AgentKind::Codex]),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    let conn = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    let stored: String = conn
        .query_row(
            "SELECT storage_root FROM sources WHERE id=?1",
            [&source.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        stored,
        fs::canonicalize(&original.root).unwrap().to_string_lossy()
    );
    assert_eq!(h.total("hidden original"), 0);
    assert_eq!(h.total("visible replacement"), 0);
    assert_eq!(h.catalog.trashed_sessions(0, 40).unwrap().total, 1);
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total("visible replacement"), 1);
    fs::remove_file(&alias).unwrap();
    symlink(&original.root, &alias).unwrap();
    h.sync(std::slice::from_ref(&source));
    assert_eq!(h.total("hidden original"), 0);
    assert_eq!(h.catalog.trashed_sessions(0, 40).unwrap().total, 1);
}

#[test]
fn search_pages_match_literal_oracle_across_filters_and_offsets() {
    let h = Harness::new();
    let codex_source = h.source("search-codex", AgentKind::Codex);
    let claude_source = h.source("search-claude", AgentKind::Claude);
    let mut paths = Vec::new();
    for index in 0..240 {
        let body = format!("shared_identifier 中文搜尋 100%_literal\\path \"quoted\" unique_{index}. École abc bcd cde prefix\0tailAFTERnull");
        let mut text = codex(&format!("search-{index}"), &body);
        // Repeated hits must still count one session. The final hit supplies the snippet.
        for _ in 0..12 {
            text.push_str(&user(&format!("latest {body}")));
        }
        if index % 2 == 0 {
            text = text.replace(SHARED_CWD, &format!("{SHARED_CWD}/other"));
        }
        paths.push(h.write(&codex_source, &format!("sessions/{index}.jsonl"), &text));
    }
    paths.push(h.write(&claude_source, "projects/test/a.jsonl", CLAUDE));
    let originals = paths
        .iter()
        .map(|p| fs::read(p).unwrap())
        .collect::<Vec<_>>();
    h.sync(&[codex_source, claude_source]);
    let conn = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    // Metadata-only variations exercise every independent filter without changing source text.
    conn.execute("UPDATE sessions SET title='Neutral title'", [])
        .unwrap();
    conn.execute(
        "UPDATE sessions SET title='title_only_identifier' WHERE external_id='search-0'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE sessions SET archived=1 WHERE external_id LIKE '%2'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE sessions SET child=1 WHERE external_id LIKE '%3'",
        [],
    )
    .unwrap();
    conn.execute("UPDATE messages SET hidden=1 WHERE file_id IN (SELECT f.id FROM files f JOIN sessions s ON s.id=f.session_id WHERE s.external_id='search-89')", []).unwrap();
    // Integration with schema-4 Trash: exercise title, dense-body, and sparse-body
    // hits while keeping their FTS postings present. The independent literal oracle
    // must exclude tombstones before count and pagination on both strategies.
    for external_id in ["search-0", "search-1", "search-87"] {
        let id: String = conn
            .query_row(
                "SELECT id FROM sessions WHERE external_id=?1",
                [external_id],
                |row| row.get(0),
            )
            .unwrap();
        let session = h.catalog.session(&id).unwrap();
        h.catalog
            .trash_session(&id, session.trash_identity.as_deref().unwrap())
            .unwrap();
    }
    let project = h.catalog.projects().unwrap().remove(0).id;
    for query in [
        "shared_identifier",
        "SHARED_IDENTIFIER",
        "中文",
        "中文搜尋",
        "100%_literal\\path",
        "\"quoted\"",
        "unique_19.",
        "unique_87.",
        "missing_token",
        "title_only_identifier",
        "École",
        "école",
        "tailafternull",
        "abcde",
        "   ",
    ] {
        for mode in 0..7 {
            let mut request = SessionQuery {
                query: Some(query.into()),
                ..Default::default()
            };
            match mode {
                1 => request.kind = Some(AgentKind::Codex),
                2 => request.kind = Some(AgentKind::Claude),
                3 => request.project_id = Some(project.clone()),
                4 => request.project_id = Some("absent-project".into()),
                5 => {
                    request.archived = Some(true);
                    request.include_children = Some(true);
                }
                6 => {
                    request.after = Some("2026-01-01T00:00:00Z".into());
                    request.before = Some("2026-03-01T00:00:00Z".into());
                }
                _ => (),
            }
            let expected = conn.prepare("SELECT s.id FROM sessions s WHERE NOT EXISTS(SELECT 1 FROM session_trash t WHERE t.session_id=s.id AND t.source_root=(SELECT storage_root FROM sources WHERE id=s.source_id)) AND (?2 IS NULL OR s.kind=?2) AND (?3 IS NULL OR s.project_id=?3) AND (?4 IS NULL OR s.archived=?4) AND (?5 OR s.child=0) AND (?6 IS NULL OR s.updated_at>=?6) AND (?7 IS NULL OR s.updated_at<?7) AND (?1='' OR instr(lower(s.title),lower(?1))>0 OR EXISTS(SELECT 1 FROM files f JOIN messages m ON m.file_id=f.id WHERE f.session_id=s.id AND m.hidden=0 AND instr(lower(m.search_text),lower(?1))>0)) ORDER BY s.updated_at DESC,s.id ASC").unwrap().query_map(rusqlite::params![query.trim(),request.kind.map(|k| k.as_str()),request.project_id,request.archived,request.include_children.unwrap_or(false),request.after.as_deref(),request.before.as_deref()], |row| row.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
            for (offset, limit) in [
                (0, 7),
                (0, 0),
                (0, 999),
                (7, 11),
                (77, 200),
                (200, 0),
                (usize::MAX, 999),
            ] {
                request.offset = Some(offset);
                request.limit = Some(limit);
                let page = h.catalog.query(&request).unwrap();
                assert_eq!(
                    page.total,
                    expected.len() as u64,
                    "query={query:?} mode={mode}"
                );
                let actual = page.items.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
                let expected_page = expected
                    .iter()
                    .skip(offset)
                    .take(limit.clamp(1, 200))
                    .cloned()
                    .collect::<Vec<_>>();
                assert_eq!(
                    actual, expected_page,
                    "query={query:?} mode={mode} offset={offset}"
                );
                if query == "shared_identifier" {
                    assert!(page.items.iter().all(|s| s
                        .snippet
                        .as_deref()
                        .unwrap()
                        .contains("latest shared_identifier")));
                }
            }
        }
    }
    for (path, original) in paths.iter().zip(&originals) {
        assert_eq!(&fs::read(path).unwrap(), original);
    }
    let session = h
        .catalog
        .query(&SessionQuery {
            query: Some("unique_19.".into()),
            ..Default::default()
        })
        .unwrap()
        .items
        .remove(0);
    let path = paths.get(19).unwrap();
    fs::write(path, "source changed after indexing\n").unwrap();
    // Search remains a cached catalog operation, exactly as before; opening its transcript
    // must still reject the stale source rather than returning cached prose as provenance.
    assert_eq!(h.total("unique_19."), 1);
    let stale = h.catalog.transcript(&session.id, None, 50).unwrap();
    assert!(stale.stale);
    assert!(stale.messages.is_empty());
}

#[test]
fn dense_search_probe_boundary_keeps_identical_results() {
    let h = Harness::new();
    let source = h.source("boundary", AgentKind::Codex);
    let mut text = codex("boundary-session", "boundary_token");
    for _ in 0..1023 {
        text.push_str(&user("boundary_token"));
    }
    let path = h.write(&source, "sessions/boundary.jsonl", &text);
    h.sync(std::slice::from_ref(&source));
    let request = SessionQuery {
        query: Some("boundary_token".into()),
        ..Default::default()
    };
    let before = h.catalog.query(&request).unwrap();
    assert_eq!(before.total, 1);
    append(&path, &user("boundary_token"));
    let expected_source = fs::read(&path).unwrap();
    h.sync(&[source]);
    let after = h.catalog.query(&request).unwrap();
    assert_ne!(before.catalog_revision, after.catalog_revision);
    assert_eq!(before.total, after.total);
    assert_eq!(
        serde_json::to_value(before.items).unwrap(),
        serde_json::to_value(after.items).unwrap()
    );
    assert_eq!(fs::read(path).unwrap(), expected_source);
}

#[test]
fn scan_commits_change_the_revision_while_progress_is_still_running() {
    let h = Harness::new();
    let source = h.source("revision-scan", AgentKind::Codex);
    for i in 0..4 {
        h.write(
            &source,
            &format!("sessions/{i}.jsonl"),
            &codex(&format!("revision-{i}"), "Synthetic revision scan"),
        );
    }
    let revisions = std::sync::Mutex::new(std::collections::HashSet::new());
    h.catalog
        .sync(&[source], &AtomicBool::new(false), |progress| {
            if progress.running {
                revisions.lock().unwrap().insert(
                    h.catalog
                        .query(&SessionQuery::default())
                        .unwrap()
                        .catalog_revision,
                );
            }
        })
        .unwrap();
    assert!(
        revisions.lock().unwrap().len() > 1,
        "committed versions must change before scan completion"
    );
}

#[test]
fn version_four_migration_preserves_rows_and_versions_subsequent_writes() {
    let h = Harness::new();
    let source = h.source("revision-migration", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        &codex("s", "Synthetic migration"),
    );
    h.sync(&[source]);
    let path = h.root.join("app/index.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    remove_revision_schema(&conn);
    conn.pragma_update(None, "user_version", 4).unwrap();
    let migrated = Catalog::open(&path).unwrap();
    let before = migrated.query(&SessionQuery::default()).unwrap();
    assert_eq!(before.total, 1);
    conn.execute("UPDATE sessions SET title='changed'", [])
        .unwrap();
    let after = migrated.query(&SessionQuery::default()).unwrap();
    assert_ne!(after.catalog_revision, before.catalog_revision);
    assert_eq!(after.items[0].title, "changed");
}

#[test]
fn removal_inspection_is_read_only_bound_to_trash_and_detects_append() {
    let h = Harness::new();
    let source = h.source("removal", AgentKind::Codex);
    let path = h.write(
        &source,
        "sessions/a.jsonl",
        &codex("inspect", "synthetic inspection"),
    );
    h.sync(std::slice::from_ref(&source));
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
    let original = fs::read(&path).unwrap();
    let inspection = h.catalog.inspect_removal(&id).unwrap();
    assert_eq!(inspection.session_id, session.id);
    assert_eq!(inspection.indexed_artifacts.len(), 1);
    assert_eq!(
        Path::new(&inspection.indexed_artifacts[0].relative_path),
        Path::new("sessions/a.jsonl")
    );
    #[cfg(unix)]
    assert_eq!(
        inspection.indexed_artifacts[0].status,
        "metadataMatchesIndex"
    );
    assert!(!inspection.blockers.is_empty());
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(h.catalog.inspect_removal(path.to_str().unwrap()).is_err());
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert_eq!(
        h.catalog.inspect_removal(&id).unwrap().indexed_artifacts[0].status,
        "changedOrUnavailable"
    );
    h.catalog.restore_session(&id).unwrap();
    assert!(h.catalog.inspect_removal(&id).is_err());
}

#[test]
fn removal_inspection_rejects_disabled_or_repointed_sources() {
    let h = Harness::new();
    let mut source = h.source("removal", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        &codex("inspect", "synthetic inspection"),
    );
    h.sync(std::slice::from_ref(&source));
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
    source.enabled = false;
    h.sync(std::slice::from_ref(&source));
    assert!(h.catalog.inspect_removal(&id).is_err());
    source.enabled = true;
    source.root = h.root.join("other").to_string_lossy().into_owned();
    fs::create_dir_all(&source.root).unwrap();
    h.sync(&[source]);
    assert!(h.catalog.inspect_removal(&id).is_err());
}

#[cfg(unix)]
#[test]
fn removal_inspection_marks_symlinks_hardlinks_and_missing_files_uncertain() {
    let h = Harness::new();
    let source = h.source("removal", AgentKind::Codex);
    let path = h.write(
        &source,
        "sessions/a.jsonl",
        &codex("inspect", "synthetic inspection"),
    );
    h.sync(&[source]);
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
    let linked = h.root.join("synthetic-link.jsonl");
    fs::hard_link(&path, &linked).unwrap();
    assert_eq!(
        h.catalog.inspect_removal(&id).unwrap().indexed_artifacts[0].status,
        "changedOrUnavailable"
    );
    fs::remove_file(&path).unwrap();
    assert_eq!(
        h.catalog.inspect_removal(&id).unwrap().indexed_artifacts[0].status,
        "changedOrUnavailable"
    );
    std::os::unix::fs::symlink(&linked, &path).unwrap();
    assert_eq!(
        h.catalog.inspect_removal(&id).unwrap().indexed_artifacts[0].status,
        "changedOrUnavailable"
    );
    assert!(linked.is_file());
}

#[test]
fn removal_inspection_rejects_indexed_path_outside_original_source() {
    let h = Harness::new();
    let source = h.source("removal", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        &codex("inspect", "synthetic inspection"),
    );
    h.sync(&[source]);
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
    let outside = h.root.join("outside-synthetic.jsonl");
    fs::write(&outside, b"synthetic sentinel").unwrap();
    let conn = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    conn.execute(
        "UPDATE files SET path=?1 WHERE session_id=?2",
        rusqlite::params![outside.to_str().unwrap(), session.id],
    )
    .unwrap();
    assert!(h
        .catalog
        .inspect_removal(&id)
        .unwrap_err()
        .contains("範圍外"));
    assert_eq!(fs::read(outside).unwrap(), b"synthetic sentinel");
}

#[cfg(unix)]
#[test]
fn removal_inspection_rejects_configured_root_symlink() {
    let h = Harness::new();
    let source = h.source("removal", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        &codex("inspect", "synthetic inspection"),
    );
    h.sync(std::slice::from_ref(&source));
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
    let linked = h.root.join("linked-source");
    std::os::unix::fs::symlink(&source.root, &linked).unwrap();
    let conn = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    conn.execute(
        "UPDATE sources SET root=?1 WHERE id=?2",
        rusqlite::params![linked.to_str().unwrap(), source.id],
    )
    .unwrap();
    assert!(h.catalog.inspect_removal(&id).unwrap_err().contains("連結"));
}

#[test]
fn removal_inspection_discloses_that_rescanned_files_are_not_a_trash_time_snapshot() {
    let h = Harness::new();
    let source = h.source("removal", AgentKind::Codex);
    let path = h.write(
        &source,
        "sessions/a.jsonl",
        &codex("inspect", "synthetic inspection"),
    );
    h.sync(std::slice::from_ref(&source));
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
    let replacement = h.root.join("replacement.jsonl");
    fs::write(&replacement, codex("inspect", "synthetic replacement")).unwrap();
    fs::remove_file(&path).unwrap();
    fs::rename(&replacement, &path).unwrap();
    h.sync(&[source]);
    let inspection = h.catalog.inspect_removal(&id).unwrap();
    assert!(inspection
        .blockers
        .iter()
        .any(|b| b.contains("不能證明與移入時內容相同")));
}

#[test]
fn removal_inspection_refuses_truncated_artifact_inventory() {
    let h = Harness::new();
    let source = h.source("removal", AgentKind::Codex);
    h.write(
        &source,
        "sessions/a.jsonl",
        &codex("inspect", "synthetic inspection"),
    );
    h.sync(&[source]);
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
    let conn = rusqlite::Connection::open(h.root.join("app/index.sqlite")).unwrap();
    for i in 0..200 {
        conn.execute("INSERT INTO files(source_id,path,session_id,identity,size,modified,offset,lines,prefix_hash,parser_version,state,archived) SELECT source_id,path || ?1,session_id,identity,size,modified,offset,lines,prefix_hash,parser_version,state,archived FROM files WHERE session_id=?2 ORDER BY id LIMIT 1", rusqlite::params![format!(".synthetic-{i}"), session.id]).unwrap();
    }
    assert!(h.catalog.inspect_removal(&id).unwrap_err().contains("過多"));
}

#[test]
fn removal_inspection_accepts_verified_configured_root_spelling() {
    let h = Harness::new();
    let mut source = h.source("removal-spelling", AgentKind::Codex);
    let alias = h.root.join("alias");
    fs::create_dir_all(&alias).unwrap();
    source.root = alias
        .join("..")
        .join("removal-spelling")
        .to_string_lossy()
        .into_owned();
    let path = h.write(
        &source,
        "sessions/a.jsonl",
        &codex("inspect-spelling", "synthetic inspection"),
    );
    assert_ne!(
        Path::new(&source.root),
        fs::canonicalize(&source.root).unwrap()
    );
    h.sync(std::slice::from_ref(&source));
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
    let original = fs::read(&path).unwrap();
    let inspection = h.catalog.inspect_removal(&id).unwrap();
    assert_eq!(inspection.indexed_artifacts.len(), 1);
    assert_eq!(
        Path::new(&inspection.indexed_artifacts[0].relative_path),
        Path::new("sessions/a.jsonl")
    );
    assert_eq!(fs::read(&path).unwrap(), original);
}
