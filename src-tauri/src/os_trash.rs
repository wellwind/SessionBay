//! Move a Session from Session Bay's recycle bin to the OS trash.
//!
//! The user confirms an exact plan; execution rebuilds it and only proceeds
//! when the same files still carry the same stamps. Shared provider stores are
//! never touched, and moving to the OS trash keeps the operation reversible.
use crate::catalog::Catalog;
use crate::models::AgentKind;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PLAN_LIFETIME: Duration = Duration::from_secs(600);
const RECENT_WRITE: Duration = Duration::from_secs(120);
const MAX_ENTRIES: u64 = 20_000;
const MAX_TODOS: usize = 5_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OsTrashItem {
    pub relative_path: String,
    pub directory: bool,
    pub bytes: u64,
    pub entries: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsTrashPlan {
    pub plan_id: String,
    pub trash_id: String,
    pub session_id: String,
    pub kind: AgentKind,
    pub source_root: String,
    pub items: Vec<OsTrashItem>,
    pub kept: Vec<String>,
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsTrashResult {
    pub moved: Vec<String>,
    pub failed: Vec<String>,
}

/// Moves absolute paths to the OS trash; tests inject a fake.
pub trait Mover {
    fn move_to_trash(&self, path: &Path) -> Result<(), String>;
}

pub struct SystemTrash;

impl Mover for SystemTrash {
    fn move_to_trash(&self, path: &Path) -> Result<(), String> {
        #[allow(unused_mut)]
        let mut context = trash::TrashContext::default();
        // Finder requires Apple Events permission and plays a sound per call.
        #[cfg(target_os = "macos")]
        {
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            context.set_delete_method(DeleteMethod::NsFileManager);
        }
        context.delete(path).map_err(|e| e.to_string())
    }
}

/// Whether a Session Bay runtime still uses this Session (id, external id).
pub type RunningCheck<'a> = &'a dyn Fn(&str, &str) -> bool;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp {
    item: OsTrashItem,
    newest: u128,
}

struct Prepared {
    created: Instant,
    trash_id: String,
    session_id: String,
    stamps: Vec<Stamp>,
}

pub struct PlanStore {
    plans: Mutex<HashMap<String, Prepared>>,
    recent_write: Duration,
}

impl Default for PlanStore {
    fn default() -> Self {
        Self::with_recent_write(RECENT_WRITE)
    }
}

impl PlanStore {
    /// Files written within `recent_write` block the plan; tests shorten it.
    pub fn with_recent_write(recent_write: Duration) -> Self {
        Self {
            plans: Mutex::default(),
            recent_write,
        }
    }

    pub fn prepare(
        &self,
        catalog: &Catalog,
        trash_id: &str,
        running: RunningCheck,
    ) -> Result<OsTrashPlan, String> {
        let (mut plan, stamps) = build(catalog, trash_id, running, self.recent_write)?;
        let mut plans = self.plans.lock().map_err(|_| "垃圾桶計畫鎖定失敗")?;
        plans.retain(|_, p| p.created.elapsed() < PLAN_LIFETIME);
        if plan.blockers.is_empty() {
            plan.plan_id = uuid::Uuid::new_v4().to_string();
            plans.insert(
                plan.plan_id.clone(),
                Prepared {
                    created: Instant::now(),
                    trash_id: plan.trash_id.clone(),
                    session_id: plan.session_id.clone(),
                    stamps,
                },
            );
        }
        Ok(plan)
    }

    pub fn execute(
        &self,
        catalog: &Catalog,
        plan_id: &str,
        running: RunningCheck,
        mover: &dyn Mover,
    ) -> Result<OsTrashResult, String> {
        let prepared = self
            .plans
            .lock()
            .map_err(|_| "垃圾桶計畫鎖定失敗")?
            .remove(plan_id)
            .filter(|p| p.created.elapsed() < PLAN_LIFETIME)
            .ok_or("確認已過期，請重新檢查後再移到垃圾桶。")?;
        let (plan, stamps) = build(catalog, &prepared.trash_id, running, self.recent_write)?;
        if let Some(blocker) = plan.blockers.first() {
            return Err(blocker.clone());
        }
        if plan.session_id != prepared.session_id || stamps != prepared.stamps {
            return Err("確認後來源檔案已變更，未移動任何檔案；請重新檢查。".into());
        }
        let root = PathBuf::from(&plan.source_root);
        let mut result = OsTrashResult {
            moved: Vec::new(),
            failed: Vec::new(),
        };
        for item in &plan.items {
            match mover.move_to_trash(&root.join(&item.relative_path)) {
                Ok(()) => result.moved.push(item.relative_path.clone()),
                Err(e) => result.failed.push(format!("{}：{e}", item.relative_path)),
            }
        }
        // Once anything left, the indexed Session is no longer whole; drop it so
        // the next scan reflects disk. Restoring from the OS trash re-indexes it.
        if !result.moved.is_empty() {
            catalog.purge_trashed(&plan.trash_id, &plan.session_id)?;
        } else if !result.failed.is_empty() {
            return Err(result.failed.join("\n"));
        }
        Ok(result)
    }
}

fn valid_external_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn kept_stores(kind: AgentKind) -> Vec<String> {
    let names: &[&str] = match kind {
        AgentKind::Codex => &[
            "state_*.sqlite（共享狀態索引）",
            "thread_history_*.sqlite（共享）",
            "history.jsonl（共享輸入歷史）",
            "session_index.jsonl（共享名稱索引）",
        ],
        AgentKind::Claude => &["history.jsonl（共享輸入歷史）"],
        AgentKind::Grok => &[
            "sessions/<工作目錄>/prompt_history.jsonl（共享）",
            "session_search.sqlite（共享搜尋索引）",
            "active_sessions.json（共享）",
        ],
        AgentKind::Antigravity => &["conversation_summaries.db（共享 metadata）"],
        AgentKind::OpenCode => &["opencode.db（共享資料庫）"],
    };
    names.iter().map(|n| (*n).to_owned()).collect()
}

fn build(
    catalog: &Catalog,
    trash_id: &str,
    running: RunningCheck,
    recent_write: Duration,
) -> Result<(OsTrashPlan, Vec<Stamp>), String> {
    let inspection = catalog.inspect_removal(trash_id)?;
    let mut plan = OsTrashPlan {
        plan_id: String::new(),
        trash_id: inspection.trash_id,
        session_id: inspection.session_id,
        kind: inspection.kind,
        source_root: inspection.source_root,
        items: Vec::new(),
        kept: kept_stores(inspection.kind),
        blockers: Vec::new(),
    };
    let id = inspection.external_id;
    if plan.kind == AgentKind::OpenCode {
        plan.blockers
            .push("OpenCode 的 Session 存在共用資料庫中，尚未支援移到系統垃圾桶。".into());
        return Ok((plan, Vec::new()));
    }
    if !valid_external_id(&id) {
        plan.blockers
            .push("Session ID 含有無法安全對應檔名的字元。".into());
        return Ok((plan, Vec::new()));
    }
    if running(&plan.session_id, &id) {
        plan.blockers
            .push("這個 Session 仍在 Session Bay 中執行；請先結束它。".into());
    }
    let indexed: Vec<&str> = inspection
        .indexed_artifacts
        .iter()
        .filter(|a| a.status != "sharedStore")
        .map(|a| a.relative_path.as_str())
        .collect();
    if inspection
        .indexed_artifacts
        .iter()
        .any(|a| a.status == "changedOrUnavailable")
    {
        plan.blockers
            .push("有檔案已變更、遺失或包含連結；請重新掃描後再次檢查。".into());
    }
    let root = Path::new(&plan.source_root);
    let mut candidates = Vec::<(PathBuf, bool)>::new();
    let parts = |path: &str| -> Vec<String> {
        Path::new(path)
            .components()
            .filter_map(|c| match c {
                Component::Normal(v) => Some(v.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect()
    };
    match plan.kind {
        AgentKind::Codex => {
            candidates.extend(indexed.iter().map(|p| (PathBuf::from(p), false)));
            candidates.push((PathBuf::from(format!("browser/sessions/{id}.toml")), false));
            candidates.push((
                PathBuf::from(format!("tui-thread-reference-capabilities/{id}")),
                false,
            ));
        }
        AgentKind::Claude => {
            let mut has_main = false;
            for path in &indexed {
                let p = parts(path);
                let main = p.len() == 3 && p[0] == "projects" && p[2] == format!("{id}.jsonl");
                has_main |= main;
                if main {
                    candidates.push((PathBuf::from(path), false));
                    candidates.push((PathBuf::from(format!("projects/{}/{id}", p[1])), true));
                } else {
                    candidates.push((PathBuf::from(path), false));
                }
            }
            if has_main {
                for dir in ["session-env", "file-history"] {
                    candidates.push((PathBuf::from(format!("{dir}/{id}")), true));
                }
                candidates.push((PathBuf::from(format!("debug/{id}.txt")), false));
                if let Ok(entries) = fs::read_dir(root.join("todos")) {
                    let prefix = format!("{id}-");
                    for name in entries
                        .take(MAX_TODOS)
                        .flatten()
                        .filter_map(|e| e.file_name().into_string().ok())
                        .filter(|n| n.starts_with(&prefix) && n.ends_with(".json"))
                    {
                        candidates.push((PathBuf::from("todos").join(name), false));
                    }
                }
            }
        }
        AgentKind::Grok => {
            let dirs: Vec<Vec<String>> = indexed.iter().map(|p| parts(p)).collect();
            match dirs.first() {
                Some(first)
                    if first.len() > 3
                        && first[0] == "sessions"
                        && first[2] == id
                        && dirs.iter().all(|d| d.len() > 3 && d[..3] == first[..3]) =>
                {
                    candidates.push((PathBuf::from(first[..3].join("/")), true));
                }
                _ => plan
                    .blockers
                    .push("Grok Session 檔案不在單一 Session 目錄中，無法安全移動。".into()),
            }
        }
        AgentKind::Antigravity => {
            if root.join(format!("presence/{id}.lock")).exists() {
                plan.blockers
                    .push("Antigravity 顯示這個對話仍在使用中；請先結束它。".into());
            }
            if indexed.iter().any(|p| {
                let p = parts(p);
                p.len() < 3 || p[0] != "brain" || p[1] != id
            }) {
                plan.blockers
                    .push("Antigravity 索引檔案不在對話目錄中，無法安全移動。".into());
            }
            candidates.push((PathBuf::from(format!("brain/{id}")), true));
            for suffix in [".db", ".db-shm", ".db-wal"] {
                candidates.push((PathBuf::from(format!("conversations/{id}{suffix}")), false));
            }
            candidates.push((PathBuf::from(format!("annotations/{id}.pbtxt")), false));
        }
        AgentKind::OpenCode => unreachable!(),
    }
    // A directory item already covers indexed files beneath it.
    let directories: Vec<PathBuf> = candidates
        .iter()
        .filter(|(p, d)| *d && root.join(p).is_dir())
        .map(|(p, _)| p.clone())
        .collect();
    candidates.retain(|(p, d)| *d || !directories.iter().any(|dir| p.starts_with(dir)));
    candidates.sort();
    candidates.dedup();
    let mut stamps = Vec::new();
    for (relative, directory) in candidates {
        match stamp(root, &relative, directory) {
            Ok(Some(stamp)) => stamps.push(stamp),
            Ok(None) => {}
            Err(e) => plan.blockers.push(e),
        }
    }
    if stamps.is_empty() {
        plan.blockers.push("找不到可移動的 Session 檔案。".into());
    }
    let recent = SystemTime::now()
        .checked_sub(recent_write)
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    if stamps.iter().any(|s| s.newest > recent) {
        plan.blockers
            .push("最近 2 分鐘內仍有寫入，Agent 可能仍在使用這個 Session。".into());
    }
    plan.items = stamps.iter().map(|s| s.item.clone()).collect();
    Ok((plan, stamps))
}

fn nanos(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos())
}

/// Stamp one candidate; missing optional sidecars yield `None`.
fn stamp(root: &Path, relative: &Path, directory: bool) -> Result<Option<Stamp>, String> {
    let label = relative.to_string_lossy().into_owned();
    if relative.as_os_str().is_empty()
        || !relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(format!("{label}：路徑不在來源範圍內。"));
    }
    // Every ancestor below the root must be a real directory, not a link.
    let mut current = root.to_path_buf();
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("{label}：{e}")),
        };
        if metadata.file_type().is_symlink() {
            return Err(format!("{label}：路徑包含連結，不會移動。"));
        }
        if index + 1 < components.len() && !metadata.is_dir() {
            return Ok(None);
        }
    }
    let metadata = fs::symlink_metadata(&current).map_err(|e| format!("{label}：{e}"))?;
    if metadata.is_dir() != directory || !(metadata.is_dir() || metadata.is_file()) {
        return Err(format!("{label}：檔案類型與預期不同。"));
    }
    let mut item = OsTrashItem {
        relative_path: label.clone(),
        directory,
        bytes: if directory { 0 } else { metadata.len() },
        entries: 0,
    };
    let mut newest = nanos(&metadata);
    if directory {
        let mut pending = vec![current];
        while let Some(dir) = pending.pop() {
            for entry in fs::read_dir(&dir).map_err(|e| format!("{label}：{e}"))? {
                let entry = entry.map_err(|e| format!("{label}：{e}"))?;
                let metadata = entry
                    .path()
                    .symlink_metadata()
                    .map_err(|e| format!("{label}：{e}"))?;
                item.entries += 1;
                if item.entries > MAX_ENTRIES {
                    return Err(format!("{label}：目錄項目過多，無法完整檢查。"));
                }
                newest = newest.max(nanos(&metadata));
                if metadata.is_dir() {
                    pending.push(entry.path());
                } else {
                    item.bytes += metadata.len();
                }
            }
        }
    }
    Ok(Some(Stamp { item, newest }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_ids_must_be_plain_file_names() {
        assert!(valid_external_id("0198a-synthetic_id.1"));
        for bad in ["", ".", "..", "a/b", "a\\b", "a b", &"x".repeat(129)] {
            assert!(!valid_external_id(bad), "{bad}");
        }
    }

    #[test]
    fn stamps_skip_missing_sidecars_and_reject_links() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("dir/sub")).unwrap();
        fs::write(root.join("dir/sub/a.txt"), "abc").unwrap();
        assert!(stamp(root, Path::new("missing/x"), false)
            .unwrap()
            .is_none());
        let dir = stamp(root, Path::new("dir"), true).unwrap().unwrap();
        assert_eq!((dir.item.entries, dir.item.bytes), (2, 3));
        assert!(stamp(root, Path::new("dir"), false).is_err());
        assert!(stamp(root, Path::new("../dir"), true).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("dir"), root.join("link")).unwrap();
            assert!(stamp(root, Path::new("link/sub/a.txt"), false).is_err());
        }
    }
}
