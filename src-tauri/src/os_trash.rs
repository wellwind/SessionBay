//! Move a Session from Session Bay's recycle bin to the OS trash.
//!
//! The user confirms an exact plan; execution rebuilds it and only proceeds
//! when the same files still carry the same stamps. Shared provider stores are
//! never touched, and moving to the OS trash keeps the operation reversible.
use crate::catalog::Catalog;
use crate::models::AgentKind;
use crate::tr;
use serde::{Deserialize, Serialize};
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

/// One moved path, recorded so the user can find or restore it later.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MovedItem {
    pub original: String,
    /// Location inside the trash when the platform reports it (macOS).
    pub trashed: Option<String>,
    /// OpenCode exports are restored with `opencode import` run from here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_cwd: Option<String>,
}

/// Official OpenCode CLI operations against the database under `root`.
pub trait OpenCodeCli {
    fn export(&self, root: &Path, id: &str, target: &Path) -> Result<(), String>;
    fn delete(&self, root: &Path, id: &str) -> Result<(), String>;
    fn import(&self, root: &Path, file: &Path, cwd: &Path) -> Result<(), String>;
}

/// Runs the configured `opencode` executable with arguments passed separately.
pub struct OpenCodeProcess {
    pub executable: PathBuf,
}

const CLI_TIMEOUT: Duration = Duration::from_secs(120);

impl OpenCodeProcess {
    fn run(
        &self,
        root: &Path,
        args: &[&std::ffi::OsStr],
        cwd: &Path,
        stdout: Option<&Path>,
    ) -> Result<(), String> {
        use std::process::{Command, Stdio};
        let data_home = opencode_data_home(root).ok_or(tr!(
            "The OpenCode data location cannot be mapped to the CLI."
        ))?;
        let log = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        let mut command = Command::new(&self.executable);
        command
            .args(args)
            .current_dir(cwd)
            // Point the CLI at the indexed database rather than whatever its default is.
            .env("XDG_DATA_HOME", data_home)
            .stdin(Stdio::null())
            .stderr(log.reopen().map_err(|e| e.to_string())?);
        match stdout {
            Some(path) => command.stdout(fs::File::create(path).map_err(|e| e.to_string())?),
            None => command.stdout(Stdio::null()),
        };
        let mut child = command
            .spawn()
            .map_err(|e| tr!("Cannot start OpenCode: {{e}}", e = e))?;
        let deadline = Instant::now() + CLI_TIMEOUT;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(tr!("The OpenCode command timed out."));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        if status.success() {
            return Ok(());
        }
        let detail = fs::read_to_string(log.path()).unwrap_or_default();
        let tail: String = detail
            .trim()
            .chars()
            .rev()
            .take(300)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        Err(tr!(
            "The OpenCode command failed ({{status}}): {{tail}}",
            status = status,
            tail = tail
        ))
    }
}

impl OpenCodeCli for OpenCodeProcess {
    fn export(&self, root: &Path, id: &str, target: &Path) -> Result<(), String> {
        self.run(
            root,
            &["export".as_ref(), id.as_ref()],
            &neutral_cwd(),
            Some(target),
        )
    }
    fn delete(&self, root: &Path, id: &str) -> Result<(), String> {
        self.run(
            root,
            &["session".as_ref(), "delete".as_ref(), id.as_ref()],
            &neutral_cwd(),
            None,
        )
    }
    fn import(&self, root: &Path, file: &Path, cwd: &Path) -> Result<(), String> {
        self.run(root, &["import".as_ref(), file.as_os_str()], cwd, None)
    }
}

fn neutral_cwd() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir)
}

/// OpenCode keeps its database at `$XDG_DATA_HOME/opencode`.
fn opencode_data_home(root: &Path) -> Option<&Path> {
    (root.file_name()? == "opencode")
        .then(|| root.parent())
        .flatten()
}

#[derive(serde::Deserialize)]
struct ExportCheck {
    info: ExportInfo,
    messages: Vec<serde::de::IgnoredAny>,
}
#[derive(serde::Deserialize)]
struct ExportInfo {
    id: String,
}

/// The export must name this Session before the original may be deleted.
fn verify_export(file: &Path, id: &str) -> Result<usize, String> {
    let reader = std::io::BufReader::new(fs::File::open(file).map_err(|e| e.to_string())?);
    let export: ExportCheck = serde_json::from_reader(reader)
        .map_err(|e| tr!("Cannot parse the OpenCode export: {{e}}", e = e))?;
    if export.info.id != id {
        return Err(tr!(
            "The session exported by OpenCode is not the expected one."
        ));
    }
    Ok(export.messages.len())
}

/// OS trash access; tests inject a fake.
pub trait Mover {
    /// Returns the item's new location when the platform reports it.
    fn move_to_trash(&self, path: &Path) -> Result<Option<PathBuf>, String>;
    /// Whether the item still sits in the trash.
    fn in_trash(&self, item: &MovedItem, moved_at: i64) -> Result<bool, String>;
    fn restore(&self, item: &MovedItem, moved_at: i64) -> Result<(), String>;
}

pub struct SystemTrash;

#[cfg(target_os = "macos")]
impl Mover for SystemTrash {
    fn move_to_trash(&self, path: &Path) -> Result<Option<PathBuf>, String> {
        use objc2_foundation::{NSFileManager, NSString, NSURL};
        // NSFileManager needs no Finder automation permission and reports the
        // trashed URL, which Finder's "Put Back" cannot be relied on to keep.
        let text = path.to_str().ok_or(tr!(
            "The path is not UTF-8, so it cannot be moved to the trash."
        ))?;
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        let mut resulting = None;
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
            .map_err(|e| e.localizedDescription().to_string())?;
        Ok(resulting
            .and_then(|url| url.path())
            .map(|path| PathBuf::from(path.to_string())))
    }
    fn in_trash(&self, item: &MovedItem, _: i64) -> Result<bool, String> {
        // ~/.Trash cannot be listed without Full Disk Access, but a known path can be checked.
        Ok(item
            .trashed
            .as_deref()
            .is_some_and(|path| fs::symlink_metadata(path).is_ok()))
    }
    fn restore(&self, item: &MovedItem, _: i64) -> Result<(), String> {
        let trashed = item
            .trashed
            .as_deref()
            .ok_or(tr!("There is no record of the trash location."))?;
        restore_by_rename(Path::new(trashed), Path::new(&item.original))
    }
}

#[cfg(not(target_os = "macos"))]
impl Mover for SystemTrash {
    fn move_to_trash(&self, path: &Path) -> Result<Option<PathBuf>, String> {
        trash::delete(path).map_err(|e| e.to_string())?;
        Ok(None)
    }
    fn in_trash(&self, item: &MovedItem, moved_at: i64) -> Result<bool, String> {
        Ok(find_listed(item, moved_at)?.is_some())
    }
    fn restore(&self, item: &MovedItem, moved_at: i64) -> Result<(), String> {
        if Path::new(&item.original).exists() {
            return Err(
                tr!("An item with the same name already exists at the original location.").into(),
            );
        }
        let found =
            find_listed(item, moved_at)?.ok_or(tr!("This item is no longer in the trash."))?;
        trash::os_limited::restore_all([found]).map_err(|e| e.to_string())
    }
}

/// Newest trash entry for this original path deleted no earlier than the move.
#[cfg(not(target_os = "macos"))]
fn find_listed(item: &MovedItem, moved_at: i64) -> Result<Option<trash::TrashItem>, String> {
    Ok(trash::os_limited::list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|t| {
            t.original_path() == Path::new(&item.original) && t.time_deleted >= moved_at - 60
        })
        .max_by_key(|t| t.time_deleted))
}

/// Move a trashed path back without replacing anything at the original spot.
pub fn restore_by_rename(trashed: &Path, original: &Path) -> Result<(), String> {
    if fs::symlink_metadata(original).is_ok() {
        return Err(tr!(
            "An item with the same name already exists at the original location."
        ));
    }
    fs::symlink_metadata(trashed)
        .map_err(|_| tr!("This item is no longer in the trash.").to_owned())?;
    if let Some(parent) = original.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(trashed, original).map_err(|e| e.to_string())
}

pub struct OsTrashRecord {
    pub id: String,
    pub title: String,
    pub kind: AgentKind,
    pub external_id: String,
    pub source_root: String,
    pub moved_at: i64,
    pub items: Vec<MovedItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsTrashedItemState {
    pub relative_path: String,
    pub in_trash: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsTrashedSession {
    pub id: String,
    pub title: String,
    pub kind: AgentKind,
    pub external_id: String,
    pub source_root: String,
    pub moved_at: i64,
    pub items: Vec<OsTrashedItemState>,
}

/// Records with each item's current trash presence.
pub fn list_moved(catalog: &Catalog, mover: &dyn Mover) -> Result<Vec<OsTrashedSession>, String> {
    catalog
        .os_trash_records()?
        .into_iter()
        .map(|record| {
            let items = record
                .items
                .iter()
                .map(|item| {
                    Ok(OsTrashedItemState {
                        relative_path: relative_label(&record.source_root, &item.original),
                        in_trash: available(mover, item, record.moved_at)?,
                    })
                })
                .collect::<Result<_, String>>()?;
            Ok(OsTrashedSession {
                id: record.id,
                title: record.title,
                kind: record.kind,
                external_id: record.external_id,
                source_root: record.source_root,
                moved_at: record.moved_at,
                items,
            })
        })
        .collect()
}

fn relative_label(root: &str, original: &str) -> String {
    Path::new(original).strip_prefix(root).map_or_else(
        |_| original.to_owned(),
        |p| p.to_string_lossy().into_owned(),
    )
}

/// Put every still-trashed item back; the record goes once nothing is left in the trash.
pub fn restore_moved(
    catalog: &Catalog,
    id: &str,
    mover: &dyn Mover,
    opencode: Option<&dyn OpenCodeCli>,
) -> Result<OsTrashResult, String> {
    let record = catalog
        .os_trash_records()?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or(tr!("The record changed; refresh."))?;
    let mut result = OsTrashResult {
        moved: Vec::new(),
        failed: Vec::new(),
    };
    for item in &record.items {
        let label = relative_label(&record.source_root, &item.original);
        if !available(mover, item, record.moved_at)? {
            result.failed.push(tr!(
                "{{label}}: no longer in the trash; it may have been deleted permanently.",
                label = label
            ));
            continue;
        }
        let restored = match &item.import_cwd {
            None => mover.restore(item, record.moved_at),
            Some(cwd) => restore_opencode(
                mover,
                item,
                record.moved_at,
                &record.source_root,
                cwd,
                opencode,
            ),
        };
        match restored {
            Ok(()) => result.moved.push(label),
            Err(e) => result
                .failed
                .push(tr!("{{label}}: {{e}}", label = label, e = e)),
        }
    }
    if record
        .items
        .iter()
        .all(|item| !available(mover, item, record.moved_at).unwrap_or(true))
    {
        catalog.forget_os_trash(id)?;
    }
    Ok(result)
}

/// An OpenCode export that never reached the trash stays restorable from staging.
fn available(mover: &dyn Mover, item: &MovedItem, moved_at: i64) -> Result<bool, String> {
    Ok(mover.in_trash(item, moved_at)?
        || (item.import_cwd.is_some() && Path::new(&item.original).is_file()))
}

fn restore_opencode(
    mover: &dyn Mover,
    item: &MovedItem,
    moved_at: i64,
    root: &str,
    cwd: &str,
    opencode: Option<&dyn OpenCodeCli>,
) -> Result<(), String> {
    let cli = opencode.ok_or(tr!(
        "OpenCode executable not found; set it in Settings, then restore."
    ))?;
    let file = Path::new(&item.original);
    if mover.in_trash(item, moved_at)? {
        mover.restore(item, moved_at)?;
    }
    let cwd = Path::new(cwd);
    if !cwd.is_dir() {
        return Err(tr!(
            "The original working directory {{v1}} no longer exists; the export is kept at {{v2}}.",
            v1 = cwd.display(),
            v2 = file.display()
        ));
    }
    cli.import(Path::new(root), file, cwd).map_err(|e| {
        tr!(
            "{{e}}; the export is kept at {{v1}}.",
            e = e,
            v1 = file.display()
        )
    })?;
    let _ = fs::remove_file(file);
    Ok(())
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
    /// Where OpenCode exports wait before going to the OS trash.
    staging: PathBuf,
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
            staging: std::env::temp_dir().join("sessionbay-opencode-export"),
        }
    }

    pub fn with_staging(mut self, staging: PathBuf) -> Self {
        self.staging = staging;
        self
    }

    pub fn prepare(
        &self,
        catalog: &Catalog,
        trash_id: &str,
        running: RunningCheck,
        opencode: Option<&dyn OpenCodeCli>,
    ) -> Result<OsTrashPlan, String> {
        let (mut plan, stamps) = build(catalog, trash_id, running, self.recent_write, opencode)?;
        let mut plans = self
            .plans
            .lock()
            .map_err(|_| tr!("Could not lock the trash plans"))?;
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
        opencode: Option<&dyn OpenCodeCli>,
    ) -> Result<OsTrashResult, String> {
        let prepared = self
            .plans
            .lock()
            .map_err(|_| tr!("Could not lock the trash plans"))?
            .remove(plan_id)
            .filter(|p| p.created.elapsed() < PLAN_LIFETIME)
            .ok_or(tr!(
                "The confirmation expired; check again before moving to the trash."
            ))?;
        let (plan, stamps) = build(
            catalog,
            &prepared.trash_id,
            running,
            self.recent_write,
            opencode,
        )?;
        if let Some(blocker) = plan.blockers.first() {
            return Err(blocker.clone());
        }
        if plan.session_id != prepared.session_id || stamps != prepared.stamps {
            return Err(tr!(
                "Source files changed after you confirmed, so nothing was moved; check again."
            ));
        }
        if plan.kind == AgentKind::OpenCode {
            let cli = opencode.ok_or(tr!("OpenCode executable not found."))?;
            return self.execute_opencode(catalog, &plan, mover, cli);
        }
        let root = PathBuf::from(&plan.source_root);
        let mut result = OsTrashResult {
            moved: Vec::new(),
            failed: Vec::new(),
        };
        let moved_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64);
        let mut moved = Vec::new();
        for item in &plan.items {
            let path = root.join(&item.relative_path);
            match mover.move_to_trash(&path) {
                Ok(trashed) => {
                    result.moved.push(item.relative_path.clone());
                    moved.push(MovedItem {
                        original: path.to_string_lossy().into_owned(),
                        trashed: trashed.map(|p| p.to_string_lossy().into_owned()),
                        import_cwd: None,
                    });
                }
                Err(e) => result
                    .failed
                    .push(tr!("{{v1}}: {{e}}", v1 = item.relative_path, e = e)),
            }
        }
        // Once anything left, the indexed Session is no longer whole; drop it so
        // the next scan reflects disk, and keep a record for finding or restoring it.
        if !moved.is_empty() {
            catalog.purge_trashed(&plan.trash_id, &plan.session_id, moved_at, &moved)?;
        } else if !result.failed.is_empty() {
            return Err(result.failed.join("\n"));
        }
        Ok(result)
    }
}

impl PlanStore {
    /// Export, delete through the official CLI, then trash the export. The
    /// original is only deleted once a parseable export names this Session.
    fn execute_opencode(
        &self,
        catalog: &Catalog,
        plan: &OsTrashPlan,
        mover: &dyn Mover,
        cli: &dyn OpenCodeCli,
    ) -> Result<OsTrashResult, String> {
        let session = catalog.trashed_snapshot(&plan.trash_id)?;
        let id = &session.external_id;
        let root = Path::new(&plan.source_root);
        fs::create_dir_all(&self.staging).map_err(|e| e.to_string())?;
        let file = self.staging.join(format!("opencode-session-{id}.json"));
        let fail = |message: String| {
            let _ = fs::remove_file(&file);
            Err(message)
        };
        if let Err(e) = cli.export(root, id, &file) {
            return fail(e);
        }
        if let Err(e) = verify_export(&file, id) {
            return fail(e);
        }
        if let Err(e) = cli.delete(root, id) {
            return fail(e);
        }
        let moved_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64);
        let label = plan.items[0].relative_path.clone();
        let mut result = OsTrashResult {
            moved: Vec::new(),
            failed: Vec::new(),
        };
        // The Session is gone from OpenCode either way; a failed trash move
        // keeps the export in staging, which restore also accepts.
        let trashed = match mover.move_to_trash(&file) {
            Ok(trashed) => {
                result.moved.push(label);
                trashed
            }
            Err(e) => {
                result.failed.push(tr!(
                    "{{label}}: {{e}} (the export is kept at {{v1}})",
                    label = label,
                    e = e,
                    v1 = file.display()
                ));
                None
            }
        };
        let item = MovedItem {
            original: file.to_string_lossy().into_owned(),
            trashed: trashed.map(|p| p.to_string_lossy().into_owned()),
            import_cwd: Some(
                session
                    .cwd
                    .clone()
                    .unwrap_or_else(|| neutral_cwd().to_string_lossy().into_owned()),
            ),
        };
        catalog.purge_trashed(&plan.trash_id, &plan.session_id, moved_at, &[item])?;
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
            "state_*.sqlite (shared state index)",
            "thread_history_*.sqlite (shared)",
            "history.jsonl (shared input history)",
            "session_index.jsonl (shared name index)",
        ],
        AgentKind::Claude => &["history.jsonl (shared input history)"],
        AgentKind::Grok => &[
            "sessions/<working directory>/prompt_history.jsonl (shared)",
            "session_search.sqlite (shared search index)",
            "active_sessions.json (shared)",
        ],
        AgentKind::Antigravity => &["conversation_summaries.db (shared metadata)"],
        AgentKind::OpenCode => &["opencode.db (shared database)"],
    };
    names.iter().map(|n| crate::i18n::tr(n)).collect()
}

fn build(
    catalog: &Catalog,
    trash_id: &str,
    running: RunningCheck,
    recent_write: Duration,
    opencode: Option<&dyn OpenCodeCli>,
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
    if !valid_external_id(&id) {
        plan.blockers.push(tr!(
            "The session ID has characters that cannot be mapped safely to a file name."
        ));
        return Ok((plan, Vec::new()));
    }
    if running(&plan.session_id, &id) {
        plan.blockers.push(tr!(
            "This session is still running in Session Bay; end it first."
        ));
    }
    if plan.kind == AgentKind::OpenCode {
        let session = catalog.trashed_snapshot(&plan.trash_id)?;
        if opencode.is_none() {
            plan.blockers.push(tr!(
                "OpenCode executable not found; set it in Settings, then try again."
            ));
        }
        if opencode_data_home(Path::new(&plan.source_root)).is_none() {
            plan.blockers.push(
                tr!("This OpenCode source is not a standard opencode folder, so the official CLI cannot handle it."),
            );
        }
        let recent = chrono::DateTime::parse_from_rfc3339(&session.updated_at)
            .ok()
            .and_then(|t| {
                (chrono::Utc::now() - t.with_timezone(&chrono::Utc))
                    .to_std()
                    .ok()
            })
            .is_none_or(|age| age < recent_write);
        if recent {
            plan.blockers.push(tr!(
                "It was updated in the last 2 minutes; OpenCode may still be using this session."
            ));
        }
        let item = OsTrashItem {
            relative_path: tr!("opencode-session-{{id}}.json (exported with the official CLI first, then the session is deleted from the database)", id = id),
            directory: false,
            bytes: 0,
            entries: 0,
        };
        plan.items = vec![item.clone()];
        // The export is taken at execution time, so it captures the latest state.
        let stamps = vec![Stamp { item, newest: 0 }];
        return Ok((plan, stamps));
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
        plan.blockers.push(tr!(
            "Some files changed, are missing or contain links; rescan and check again."
        ));
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
                    .push(tr!("The Grok session files are not in a single session folder, so they cannot be moved safely.")),
            }
        }
        AgentKind::Antigravity => {
            if presence_locked(&root.join(format!("presence/{id}.lock"))) {
                plan.blockers.push(tr!(
                    "Antigravity shows this conversation is still in use; end it first."
                ));
            }
            if indexed.iter().any(|p| {
                let p = parts(p);
                p.len() < 3 || p[0] != "brain" || p[1] != id
            }) {
                plan.blockers
                    .push(tr!("The Antigravity index files are not in the conversation folder, so they cannot be moved safely."));
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
        plan.blockers
            .push(tr!("No session files to move were found."));
    }
    let recent = SystemTime::now()
        .checked_sub(recent_write)
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    if stamps.iter().any(|s| s.newest > recent) {
        plan.blockers.push(tr!(
            "It was written in the last 2 minutes; the agent may still be using this session."
        ));
    }
    plan.items = stamps.iter().map(|s| s.item.clone()).collect();
    Ok((plan, stamps))
}

/// Antigravity leaves presence files behind after exit and holds a file lock
/// while running, so only a lock we cannot share means the chat is in use.
fn presence_locked(path: &Path) -> bool {
    match fs::File::open(path) {
        Ok(file) => match file.try_lock_shared() {
            Ok(()) => {
                let _ = file.unlock();
                false
            }
            Err(fs::TryLockError::WouldBlock) => true,
            // Unknown lock state is treated as in use.
            Err(fs::TryLockError::Error(_)) => true,
        },
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
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
        return Err(tr!(
            "{{label}}: the path is outside the source.",
            label = label
        ));
    }
    // Every ancestor below the root must be a real directory, not a link.
    let mut current = root.to_path_buf();
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(tr!("{{label}}: {{e}}", label = label, e = e)),
        };
        if metadata.file_type().is_symlink() {
            return Err(tr!(
                "{{label}}: the path contains a link and will not be moved.",
                label = label
            ));
        }
        if index + 1 < components.len() && !metadata.is_dir() {
            return Ok(None);
        }
    }
    let metadata = fs::symlink_metadata(&current)
        .map_err(|e| tr!("{{label}}: {{e}}", label = label, e = e))?;
    if metadata.is_dir() != directory || !(metadata.is_dir() || metadata.is_file()) {
        return Err(tr!(
            "{{label}}: the file type is not what was expected.",
            label = label
        ));
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
            for entry in
                fs::read_dir(&dir).map_err(|e| tr!("{{label}}: {{e}}", label = label, e = e))?
            {
                let entry = entry.map_err(|e| tr!("{{label}}: {{e}}", label = label, e = e))?;
                let metadata = entry
                    .path()
                    .symlink_metadata()
                    .map_err(|e| tr!("{{label}}: {{e}}", label = label, e = e))?;
                item.entries += 1;
                if item.entries > MAX_ENTRIES {
                    return Err(tr!(
                        "{{label}}: the folder has too many items to check completely.",
                        label = label
                    ));
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

    #[cfg(unix)]
    #[test]
    fn opencode_process_passes_args_separately_and_targets_the_source_root() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("synthetic opencode");
        fs::write(
            &script,
            "#!/bin/sh\nif [ \"$1\" = fail ]; then echo 'synthetic failure' >&2; exit 3; fi\nprintf '%s|' \"$@\" \"$XDG_DATA_HOME\"\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let cli = OpenCodeProcess { executable: script };
        let root = temp.path().join("xdg").join("opencode");
        let out = temp.path().join("export.json");
        cli.export(&root, "ses_a b;$(x)", &out).unwrap();
        assert_eq!(
            fs::read_to_string(&out).unwrap(),
            format!("export|ses_a b;$(x)|{}|", temp.path().join("xdg").display())
        );
        let error = cli
            .run(&root, &["fail".as_ref()], temp.path(), None)
            .unwrap_err();
        assert!(error.contains("synthetic failure"), "{error}");
        assert!(cli.delete(&temp.path().join("custom"), "ses_a").is_err());
    }

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
