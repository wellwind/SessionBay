use sessionbay_lib::catalog::Catalog;
use sessionbay_lib::models::{AgentKind, HistorySource, SessionQuery};
use sessionbay_lib::os_trash::{Mover, PlanStore};
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

const CLAUDE: &str = include_str!("../../fixtures/claude/standard.jsonl");
const CLAUDE_ID: &str = "claude-synthetic-001";

/// Stands in for the OS trash by moving paths into a sibling folder.
struct FakeTrash {
    bin: PathBuf,
    moved: RefCell<Vec<PathBuf>>,
}
impl Mover for FakeTrash {
    fn move_to_trash(&self, path: &Path) -> Result<(), String> {
        let target = self.bin.join(self.moved.borrow().len().to_string());
        fs::rename(path, target).map_err(|e| e.to_string())?;
        self.moved.borrow_mut().push(path.to_owned());
        Ok(())
    }
}

struct Harness {
    _temp: tempfile::TempDir,
    catalog: Catalog,
    source: HistorySource,
    trash: FakeTrash,
}
impl Harness {
    fn new(kind: AgentKind) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("bin")).unwrap();
        Self {
            catalog: Catalog::open(&root.join("app/index.sqlite")).unwrap(),
            source: HistorySource {
                id: "synthetic".into(),
                kind,
                root: root.join("agent").to_string_lossy().into_owned(),
                enabled: true,
            },
            trash: FakeTrash {
                bin: root.join("bin"),
                moved: RefCell::default(),
            },
            _temp: temp,
        }
    }
    fn path(&self, relative: &str) -> PathBuf {
        Path::new(&self.source.root).join(relative)
    }
    fn write(&self, relative: &str, text: &str) {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fn index_and_trash(&self) -> String {
        self.catalog
            .sync(
                std::slice::from_ref(&self.source),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
        let session = self
            .catalog
            .query(&SessionQuery::default())
            .unwrap()
            .items
            .remove(0);
        self.catalog
            .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
            .unwrap()
    }
}

fn idle(_: &str, _: &str) -> bool {
    false
}

#[cfg(unix)]
#[test]
fn claude_session_and_its_sidecars_move_while_shared_history_stays() {
    let h = Harness::new(AgentKind::Claude);
    h.write(&format!("projects/p/{CLAUDE_ID}.jsonl"), CLAUDE);
    h.write(
        &format!("projects/p/{CLAUDE_ID}/tool-results/r.txt"),
        "synthetic",
    );
    h.write(&format!("session-env/{CLAUDE_ID}/env"), "synthetic");
    h.write(&format!("todos/{CLAUDE_ID}-agent-x.json"), "[]");
    h.write("todos/other-session-agent-x.json", "[]");
    h.write("history.jsonl", "{}\n");
    let trash_id = h.index_and_trash();
    let store = PlanStore::with_recent_write(Duration::ZERO);
    let plan = store.prepare(&h.catalog, &trash_id, &idle).unwrap();
    assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
    let items: Vec<_> = plan
        .items
        .iter()
        .map(|i| i.relative_path.as_str())
        .collect();
    assert_eq!(
        items,
        [
            format!("projects/p/{CLAUDE_ID}"),
            format!("projects/p/{CLAUDE_ID}.jsonl"),
            format!("session-env/{CLAUDE_ID}"),
            format!("todos/{CLAUDE_ID}-agent-x.json"),
        ]
    );
    assert!(plan.kept.iter().any(|k| k.starts_with("history.jsonl")));
    let result = store
        .execute(&h.catalog, &plan.plan_id, &idle, &h.trash)
        .unwrap();
    assert_eq!(result.moved.len(), 4);
    assert!(result.failed.is_empty());
    assert!(!h.path(&format!("projects/p/{CLAUDE_ID}.jsonl")).exists());
    assert!(h.path("history.jsonl").exists());
    assert!(h.path("todos/other-session-agent-x.json").exists());
    assert_eq!(h.catalog.trashed_sessions(0, 10).unwrap().total, 0);
    assert_eq!(h.catalog.query(&SessionQuery::default()).unwrap().total, 0);
    // The plan is single use.
    assert!(store
        .execute(&h.catalog, &plan.plan_id, &idle, &h.trash)
        .is_err());
}

#[test]
fn running_recent_or_changed_sessions_never_move() {
    let h = Harness::new(AgentKind::Codex);
    let rollout = "sessions/2026/01/01/rollout-synthetic-codex-1.jsonl";
    h.write(
        rollout,
        &format!(
            "{}\n",
            serde_json::json!({"type":"session_meta","payload":{"id":"synthetic-codex-1","cwd":"/synthetic"}})
        ),
    );
    let trash_id = h.index_and_trash();
    let recent = PlanStore::default();
    assert!(recent
        .prepare(&h.catalog, &trash_id, &idle)
        .unwrap()
        .blockers
        .iter()
        .any(|b| b.contains("最近")));
    let store = PlanStore::with_recent_write(Duration::ZERO);
    let running = |_: &str, external: &str| external == "synthetic-codex-1";
    let blocked = store.prepare(&h.catalog, &trash_id, &running).unwrap();
    assert!(blocked.plan_id.is_empty());
    assert!(blocked.blockers.iter().any(|b| b.contains("執行")));
    let plan = store.prepare(&h.catalog, &trash_id, &idle).unwrap();
    assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
    // A sidecar appearing after confirmation changes the plan.
    h.write(
        "browser/sessions/synthetic-codex-1.toml",
        "synthetic = true\n",
    );
    assert!(store
        .execute(&h.catalog, &plan.plan_id, &idle, &h.trash)
        .is_err());
    assert!(h.trash.moved.borrow().is_empty());
    assert!(h.path(rollout).exists());
    let again = store.prepare(&h.catalog, &trash_id, &idle).unwrap();
    assert_eq!(again.items.len(), 2);
    store
        .execute(&h.catalog, &again.plan_id, &idle, &h.trash)
        .unwrap();
    assert!(!h.path(rollout).exists());
}

#[test]
fn grok_moves_the_whole_session_directory_only() {
    let h = Harness::new(AgentKind::Grok);
    let dir = "sessions/%2Fsynthetic/grok-session";
    h.write(
        &format!("{dir}/summary.json"),
        &serde_json::json!({"info":{"id":"grok-session","cwd":"/synthetic"},"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}).to_string(),
    );
    h.write(
        &format!("{dir}/updates.jsonl"),
        &format!(
            "{}\n",
            serde_json::json!({"timestamp":1767312000,"method":"session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"synthetic"}}}})
        ),
    );
    h.write("sessions/%2Fsynthetic/prompt_history.jsonl", "{}\n");
    let trash_id = h.index_and_trash();
    let store = PlanStore::with_recent_write(Duration::ZERO);
    let plan = store.prepare(&h.catalog, &trash_id, &idle).unwrap();
    assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
    assert_eq!(plan.items.len(), 1);
    assert!(plan.items[0].directory);
    assert_eq!(Path::new(&plan.items[0].relative_path), Path::new(dir));
    store
        .execute(&h.catalog, &plan.plan_id, &idle, &h.trash)
        .unwrap();
    assert!(!h.path(dir).exists());
    assert!(h
        .path("sessions/%2Fsynthetic/prompt_history.jsonl")
        .exists());
}

#[test]
fn antigravity_presence_lock_blocks_and_conversation_files_move() {
    let h = Harness::new(AgentKind::Antigravity);
    let id = "f19c6f8b-a063-43af-b661-e60149d138dc";
    h.write(
        &format!("brain/{id}/.system_generated/logs/transcript.jsonl"),
        &format!(
            "{}\n",
            serde_json::json!({"step_index":1,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-01-02T00:00:00Z","content":"<USER_REQUEST>synthetic</USER_REQUEST>"})
        ),
    );
    h.write(&format!("conversations/{id}.db"), "synthetic");
    h.write(&format!("annotations/{id}.pbtxt"), "synthetic");
    h.write(&format!("presence/{id}.lock"), "");
    let trash_id = h.index_and_trash();
    let store = PlanStore::with_recent_write(Duration::ZERO);
    let locked = store.prepare(&h.catalog, &trash_id, &idle).unwrap();
    assert!(locked.blockers.iter().any(|b| b.contains("使用中")));
    fs::remove_file(h.path(&format!("presence/{id}.lock"))).unwrap();
    let plan = store.prepare(&h.catalog, &trash_id, &idle).unwrap();
    assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
    assert_eq!(plan.items.len(), 3);
    store
        .execute(&h.catalog, &plan.plan_id, &idle, &h.trash)
        .unwrap();
    assert!(!h.path(&format!("brain/{id}")).exists());
    assert!(!h.path(&format!("conversations/{id}.db")).exists());
}
