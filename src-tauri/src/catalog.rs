//! SQLite catalog and cancellable, read-only JSONL reconciliation.
//! Connections are operation-local; WAL readers never share a scan's connection.
use crate::adapters::{self, ParsedState, MAX_LINE_BYTES, PARSER_VERSION};
use crate::antigravity_metadata::{self, MetadataIndex};
use crate::models::*;
use crate::providers::{self, ParserId};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row,
    TransactionBehavior,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};
use walkdir::WalkDir;

const SCHEMA_VERSION: i64 = 6;
const SESSION_COLUMNS: &str = "s.id,s.source_id,s.kind,s.external_id,s.project_id,s.title,s.cwd,s.updated_at,s.time_source,s.archived,s.parent_id,s.partial,(SELECT root FROM sources WHERE id=s.source_id),(SELECT identity FROM files WHERE session_id=s.id LIMIT 1),(SELECT storage_root FROM sources WHERE id=s.source_id)";
const MAX_ERRORS: usize = 100;
const MAX_PREVIEW_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_PREVIEW_PAGE_BYTES: usize = 1024 * 1024;
type CheckpointRow = (
    i64,
    Option<String>,
    String,
    i64,
    String,
    i64,
    i64,
    String,
    i64,
    String,
);

/// Search diagnostics, in milliseconds; available only to explicitly enabled benchmarks.
#[cfg(feature = "search-profile")]
pub type SearchPhaseTimings = Vec<(&'static str, f64)>;

#[derive(Debug, Clone)]
pub struct Catalog {
    path: PathBuf,
}

#[derive(Debug, Clone)]
struct FileRecord {
    id: i64,
    session_id: Option<String>,
    identity: String,
    size: u64,
    modified: String,
    offset: u64,
    lines: u64,
    prefix_hash: String,
    parser_version: i64,
    state: ParsedState,
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn hash_id(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

pub fn session_identity(source: &HistorySource, external_id: &str) -> String {
    format!(
        "session-{}",
        hash_id(&[source.kind.as_str(), &source.id, external_id])
    )
}

fn directory_key(raw: &str) -> String {
    let path = Path::new(raw);
    if path.is_absolute() {
        if let Ok(canonical) = fs::canonicalize(path) {
            return canonical.to_string_lossy().into_owned();
        }
    }
    // Lexical cleanup only. Never lowercase paths or infer a missing cwd.
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if clean.file_name().is_some_and(|part| part != "..") {
                    clean.pop();
                } else if !clean.has_root() {
                    clean.push("..");
                }
            }
            _ => clean.push(component.as_os_str()),
        }
    }
    clean.to_string_lossy().into_owned()
}

fn project_identity(path: Option<&str>) -> String {
    match path {
        Some(path) => format!("project-{}", hash_id(&[&directory_key(path)])),
        None => "project-unclassified".into(),
    }
}

fn project_name(path: Option<&str>) -> String {
    match path {
        Some(path) => Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(path)
            .to_owned(),
        None => "未分類".into(),
    }
}

// Keep historical project IDs stable even if a formerly missing cwd later becomes
// a real directory or symlink. Aliases are catalog metadata, never history edits.
fn remember_directory(conn: &Connection, path: &str, id: &str) -> Result<(), String> {
    for key in [path.to_owned(), directory_key(path)] {
        conn.execute(
            "INSERT INTO project_directories(path,project_id) VALUES(?1,?2) ON CONFLICT(path) DO NOTHING",
            params![key, id],
        )
        .map_err(error)?;
    }
    Ok(())
}

fn ensure_project(conn: &Connection, cwd: Option<&str>, manual: bool) -> Result<String, String> {
    let mut id = project_identity(cwd);
    if let Some(path) = cwd {
        let key = directory_key(path);
        let known: Option<String> = conn.query_row(
            "SELECT project_id FROM project_directories WHERE path=?1 OR path=?2 ORDER BY path=?1 DESC LIMIT 1",
            params![path, key], |row| row.get(0),
        ).optional().map_err(error)?;
        if let Some(known) = known {
            id = known;
        } else if manual {
            // Explicit addition may use the canonical spelling of a historical
            // alias that was missing during indexing. Only this uncommon user
            // action scans old paths; ordinary indexing uses the alias index.
            let mut stmt = conn
                .prepare("SELECT id,path FROM projects WHERE path IS NOT NULL ORDER BY id")
                .map_err(error)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(error)?;
            for row in rows {
                let (existing_id, existing_path) = row.map_err(error)?;
                if directory_key(&existing_path) == key {
                    id = existing_id;
                    break;
                }
            }
        }
    }
    conn.execute(
        "INSERT INTO projects(id,name,path,pinned,manual) VALUES(?1,?2,?3,0,?4)
        ON CONFLICT(id) DO UPDATE SET manual=MAX(projects.manual,excluded.manual)",
        params![id, project_name(cwd), cwd, manual],
    )
    .map_err(error)?;
    if let Some(path) = cwd {
        remember_directory(conn, path, &id)?;
    }
    Ok(id)
}

fn validate_project_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control) {
        return Err(
            "Project names must contain 1–200 characters and no control characters.".into(),
        );
    }
    Ok(())
}

fn validate_folder_name(name: &str) -> Result<(), String> {
    validate_project_name(name)?;
    if name.len() > 255 || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(
            "Choose a single folder name without path separators; . and .. are not allowed.".into(),
        );
    }
    Ok(())
}

fn validate_absolute_directory(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.contains('\0') || !Path::new(path).is_absolute() {
        return Err("Choose an absolute project directory.".into());
    }
    if !Path::new(path).is_dir() {
        return Err("The selected project directory does not exist or is not a directory.".into());
    }
    Ok(())
}

impl Catalog {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(error)?;
        }
        let catalog = Self {
            path: path.to_path_buf(),
        };
        let mut conn = catalog.connect()?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(error)?;
        if version > SCHEMA_VERSION {
            return Err("The index was created by a newer Session Bay version. Use that version or rebuild a separate index.".into());
        }
        if version == 0 {
            let tx = conn.transaction().map_err(error)?;
            tx.execute_batch("CREATE TABLE sources(
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, root TEXT NOT NULL, enabled INTEGER NOT NULL);
                CREATE TABLE projects(
                id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT, launch_path TEXT,
                pinned INTEGER NOT NULL DEFAULT 0, manual INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE sessions(
                id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
                kind TEXT NOT NULL, external_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
                title TEXT NOT NULL, cwd TEXT, updated_at TEXT NOT NULL, time_source TEXT NOT NULL,
                archived INTEGER NOT NULL, parent_id TEXT, child INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL,
                UNIQUE(source_id,kind,external_id));
                CREATE TABLE files(
                id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
                path TEXT NOT NULL, session_id TEXT, identity TEXT NOT NULL, size INTEGER NOT NULL,
                modified TEXT NOT NULL, offset INTEGER NOT NULL, lines INTEGER NOT NULL,
                prefix_hash TEXT NOT NULL, parser_version INTEGER NOT NULL, state TEXT NOT NULL,
                archived INTEGER NOT NULL, trailing_partial INTEGER NOT NULL DEFAULT 0,
                UNIQUE(source_id,path));
                CREATE TABLE messages(
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                line INTEGER NOT NULL, byte_offset INTEGER NOT NULL, byte_len INTEGER NOT NULL,
                role TEXT NOT NULL, timestamp TEXT, search_text TEXT NOT NULL,
                fallback INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
                placeholder TEXT, PRIMARY KEY(file_id,line));
                CREATE INDEX sessions_recent ON sessions(updated_at DESC,id);
                CREATE INDEX sessions_project ON sessions(project_id,updated_at DESC,id);
                CREATE INDEX sessions_external ON sessions(kind,external_id);
                CREATE INDEX files_session ON files(session_id);
                CREATE INDEX messages_file ON messages(file_id,line DESC);
                PRAGMA user_version=1;").map_err(error)?;
            tx.commit().map_err(error)?;
        }
        if version < 2 {
            let tx = conn.transaction().map_err(error)?;
            // External content avoids copying conversation text into the FTS table.
            // Triggers and content changes commit or roll back together, including
            // cascaded source/file deletions. Rebuild indexes pre-migration rows.
            tx.execute_batch("CREATE VIRTUAL TABLE messages_fts USING fts5(search_text, content='messages', content_rowid='rowid', tokenize='trigram', detail=none, columnsize=0);
                CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
                    INSERT INTO messages_fts(rowid,search_text) VALUES(new.rowid,new.search_text);
                END;
                CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
                END;
                CREATE TRIGGER messages_fts_update AFTER UPDATE OF search_text ON messages WHEN new.search_text<>old.search_text BEGIN
                    INSERT INTO messages_fts(messages_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
                    INSERT INTO messages_fts(rowid,search_text) VALUES(new.rowid,new.search_text);
                END;
                INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
                PRAGMA user_version=2;").map_err(error)?;
            tx.commit().map_err(error)?;
        }
        if version < 3 {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(error)?;
            // manual is now explicit Projects membership. Existing manual or
            // pinned choices remain selected; automatic discovery stays unselected.
            tx.execute_batch(
                "UPDATE projects SET manual=1 WHERE pinned=1;
                UPDATE projects SET manual=0,pinned=0 WHERE path IS NULL AND launch_path IS NULL;
                CREATE TABLE project_directories(
                    path TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id));
                CREATE INDEX project_directories_project ON project_directories(project_id);
                PRAGMA user_version=3;",
            )
            .map_err(error)?;
            let existing = tx
                .prepare("SELECT id,path FROM projects WHERE path IS NOT NULL ORDER BY id")
                .map_err(error)?
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(error)?;
            // Raw paths win over canonical aliases if an older catalog already
            // has multiple historical identities for the same current directory.
            for (id, path) in &existing {
                tx.execute("INSERT INTO project_directories(path,project_id) VALUES(?1,?2) ON CONFLICT(path) DO NOTHING", params![path,id]).map_err(error)?;
            }
            for (id, path) in existing {
                remember_directory(&tx, &path, &id)?;
            }
            tx.commit().map_err(error)?;
        }
        if version < 4 {
            // User choices survive catalog rebuilds and source cascade deletion.
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(error)?;
            tx.execute_batch(
                "ALTER TABLE sources ADD COLUMN storage_root TEXT NOT NULL DEFAULT '';
                CREATE TABLE session_trash(
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL, snapshot TEXT NOT NULL,
                source_root TEXT NOT NULL, deleted_at TEXT NOT NULL,
                UNIQUE(session_id,source_root));
                CREATE INDEX session_trash_lookup ON session_trash(session_id,source_root);
                PRAGMA user_version=4;",
            )
            .map_err(error)?;
            let roots = tx
                .prepare("SELECT id,root FROM sources")
                .map_err(error)?
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(error)?;
            for (id, root) in roots {
                tx.execute(
                    "UPDATE sources SET storage_root=?1 WHERE id=?2",
                    params![directory_key(&root), id],
                )
                .map_err(error)?;
            }
            tx.commit().map_err(error)?;
        }
        if version < 5 {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(error)?;
            // The revision commits atomically with every catalog mutation. Readers
            // capture it in their own short WAL snapshot; no transaction spans IPC.
            tx.execute_batch("CREATE TABLE catalog_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
                INSERT INTO catalog_revision VALUES(1,0);
                CREATE INDEX sessions_oldest ON sessions(updated_at ASC,id ASC);
                CREATE INDEX sessions_project_oldest ON sessions(project_id,updated_at ASC,id ASC);
                PRAGMA user_version=5;").map_err(error)?;
            for table in [
                "sources",
                "projects",
                "project_directories",
                "sessions",
                "files",
                "messages",
                "session_trash",
            ] {
                let changed = tx
                    .prepare(&format!("PRAGMA table_info({table})"))
                    .map_err(error)?
                    .query_map([], |row| row.get::<_, String>(1))
                    .map_err(error)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(error)?
                    .into_iter()
                    .map(|column| format!("old.\"{column}\" IS NOT new.\"{column}\""))
                    .collect::<Vec<_>>()
                    .join(" OR ");
                for operation in ["INSERT", "UPDATE", "DELETE"] {
                    let condition = if operation == "UPDATE" {
                        format!("WHEN {changed}")
                    } else {
                        String::new()
                    };
                    tx.execute_batch(&format!("CREATE TRIGGER revision_{table}_{operation} AFTER {operation} ON {table} {condition} BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;")).map_err(error)?;
                }
            }
            tx.commit().map_err(error)?;
        }
        if version < 6 {
            // Survives rebuilds: the only pointer from a moved Session to its trashed files.
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS session_os_trash(
                id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL,
                external_id TEXT NOT NULL, source_root TEXT NOT NULL,
                moved_at INTEGER NOT NULL, items TEXT NOT NULL);
                PRAGMA user_version=6;",
            )
            .map_err(error)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(error)?;
        }
        Ok(catalog)
    }

    pub fn revision(&self) -> Result<u64, String> {
        read_revision(&self.connect()?)
    }

    /// Serialize confirmation admission with catalog writers, including background scans.
    /// Read-only Launch planning may use other connections while this reservation is held.
    pub(crate) fn with_launch_revision<T>(
        &self,
        action: impl FnOnce(u64) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(error)?;
        action(read_revision(&tx)?)
    }

    fn connect(&self) -> Result<Connection, String> {
        let conn = Connection::open(&self.path).map_err(error)?;
        conn.busy_timeout(Duration::from_secs(5)).map_err(error)?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON;").map_err(error)?;
        Ok(conn)
    }

    /// All catalog groups, including uncurated history, are returned so session
    /// queries and resume can continue resolving their original metadata.
    pub fn projects(&self) -> Result<Vec<Project>, String> {
        let conn = self.connect()?;
        let tx = conn.unchecked_transaction().map_err(error)?;
        load_projects(&tx, None)
    }

    /// Resolve preview authorization from catalog identity, never from a UI root
    /// or launch override. A launch override can deliberately point elsewhere.
    pub(crate) fn workspace_root(&self, project_id: &str) -> Result<PathBuf, String> {
        let conn = self.connect()?;
        let path: Option<Option<String>> = conn
            .query_row(
                "SELECT path FROM projects WHERE id=?1",
                [project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        let path = path
            .ok_or("找不到專案，無法預覽檔案")?
            .ok_or("此專案沒有本機目錄；暫存終端無法預覽檔案")?;
        Ok(PathBuf::from(path))
    }

    pub fn add_project(&self, path: &str, name: Option<&str>) -> Result<Project, String> {
        validate_absolute_directory(path)?;
        if let Some(name) = name {
            validate_project_name(name)?;
        }
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let id = ensure_project(&tx, Some(path), true)?;
        if let Some(name) = name {
            tx.execute("UPDATE projects SET name=?1 WHERE id=?2", params![name, id])
                .map_err(error)?;
        }
        let mut project = load_project(&tx, &id)?;
        if !project.exists {
            // A remembered canonical alias may outlive its original path. The
            // explicitly chosen existing folder must remain usable, without
            // replacing historical identity/cwd or a still-valid override.
            tx.execute(
                "UPDATE projects SET launch_path=?1 WHERE id=?2",
                params![path, id],
            )
            .map_err(error)?;
            project = load_project(&tx, &id)?;
        }
        tx.commit().map_err(error)?;
        Ok(project)
    }

    pub fn create_project(&self, parent_path: &str, name: &str) -> Result<Project, String> {
        validate_absolute_directory(parent_path)?;
        validate_folder_name(name)?;
        // Resolve the existing parent before appending exactly one component.
        // create_dir is exclusive: no overwrite, ancestor creation or shell use.
        let parent = fs::canonicalize(parent_path).map_err(error)?;
        let path = parent.join(name);
        #[cfg(windows)]
        if !crate::windows_fs::valid_filesystem_path(&path) {
            return Err("Choose a Windows folder name without reserved device names, alternate streams, or ambiguous trailing dots/spaces.".into());
        }
        let path_string = path.to_str().ok_or("Project paths must be valid UTF-8.")?;
        fs::create_dir(&path).map_err(|e| format!("Could not create the project folder: {e}"))?;
        self.add_project(path_string, Some(name)).map_err(|e| {
            format!("The folder was created at {}, but could not be added to Projects: {e}. Add the existing folder to retry.", path.display())
        })
    }

    pub fn update_project(
        &self,
        id: &str,
        pinned: Option<bool>,
        launch_path: Option<&str>,
        curated: Option<bool>,
        name: Option<&str>,
    ) -> Result<Project, String> {
        if let Some(path) = launch_path.filter(|p| !p.is_empty()) {
            validate_absolute_directory(path)?;
        }
        if let Some(name) = name {
            validate_project_name(name)?;
        }
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let mut project = load_project(&tx, id)?;
        if let Some(path) = launch_path {
            project.launch_path = (!path.is_empty()).then(|| path.to_owned());
        }
        if let Some(name) = name {
            project.name = name.to_owned();
        }
        if let Some(pinned) = pinned {
            project.pinned = pinned;
            if pinned {
                project.curated = true;
            }
        }
        if let Some(curated) = curated {
            project.curated = curated;
            if !curated {
                project.pinned = false;
            }
        }
        // An unclassified bucket has no directory identity. It can only be
        // selected after the user supplies a real launch directory.
        if project.curated && project.path.is_none() {
            let path = project.launch_path.as_deref().ok_or(
                "Relocate this unclassified history to a project directory before adding it to Projects.",
            )?;
            if curated == Some(true) || pinned == Some(true) || launch_path.is_some() {
                validate_absolute_directory(path)?;
            }
        }
        tx.execute(
            "UPDATE projects SET name=?1,launch_path=?2,pinned=?3,manual=?4 WHERE id=?5",
            params![
                project.name,
                project.launch_path,
                project.pinned,
                project.curated,
                id
            ],
        )
        .map_err(error)?;
        let project = load_project(&tx, id)?;
        tx.commit().map_err(error)?;
        Ok(project)
    }

    /// Read cached source provenance without touching a growing transcript.
    pub fn history_source(&self, id: &str) -> Result<HistorySource, String> {
        let conn = self.connect()?;
        let source: Option<(String, String, String, bool)> = conn
            .query_row(
                "SELECT id,kind,root,enabled FROM sources WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(error)?;
        let (id, kind, root, enabled) = source.ok_or("The history source was removed.")?;
        Ok(HistorySource {
            id,
            kind: AgentKind::parse(&kind)?,
            root,
            enabled,
        })
    }

    /// An append is compatible with focusing a live runtime; a replaced file or
    /// repointed source symlink is not proof of the indexed conversation.
    pub fn indexed_files_still_match(&self, session_id: &str) -> Result<bool, String> {
        let session = self.session(session_id)?;
        if session.kind == AgentKind::OpenCode {
            let conn = self.connect()?;
            let (root, expected): (String, String) = conn.query_row("SELECT sources.root,files.identity FROM files JOIN sources ON sources.id=files.source_id WHERE files.session_id=?1", [session_id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(error)?;
            return Ok(crate::opencode::database_identity(Path::new(&root))
                .is_ok_and(|identity| identity == expected));
        }
        let conn = self.connect()?;
        let paths = conn
            .prepare("SELECT path,identity FROM files WHERE session_id=?1")
            .map_err(error)?
            .query_map([session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        Ok(!paths.is_empty()
            && paths.iter().all(|(path, identity)| {
                fs::metadata(path).is_ok_and(|metadata| {
                    metadata.is_file()
                        && path_identity(Path::new(path), &metadata)
                            .is_ok_and(|value| value == *identity)
                })
            }))
    }

    pub fn session(&self, id: &str) -> Result<Session, String> {
        let conn = self.connect()?;
        conn.query_row(
            &format!("SELECT {SESSION_COLUMNS} FROM sessions s WHERE s.id=?1"),
            [id],
            session_row,
        )
        .optional()
        .map_err(error)?
        .ok_or_else(|| "Session not found. Refresh the history index.".into())
    }

    /// This changes only catalog visibility. It never touches a runtime or transcript file.
    pub fn trash_session(&self, id: &str, expected_identity: &str) -> Result<String, String> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let session = tx
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions s WHERE s.id=?1"),
                [id],
                session_row,
            )
            .optional()
            .map_err(error)?
            .ok_or("Session not found. Refresh the history index.")?;
        if session.trash_identity.as_deref() != Some(expected_identity) {
            return Err("這筆 Session 的來源已變更。請重新整理歷史並再次確認。".into());
        }
        let root: String = tx
            .query_row(
                "SELECT storage_root FROM sources WHERE id=?1",
                [&session.source_id],
                |r| r.get(0),
            )
            .map_err(error)?;
        tx.execute("INSERT INTO session_trash(id,session_id,snapshot,source_root,deleted_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(session_id,source_root) DO NOTHING",
            params![uuid::Uuid::new_v4().to_string(), id, serde_json::to_string(&session).map_err(error)?, root, Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)]).map_err(error)?;
        let trash_id = tx
            .query_row(
                "SELECT id FROM session_trash WHERE session_id=?1 AND source_root=?2",
                params![id, root],
                |r| r.get(0),
            )
            .map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(trash_id)
    }

    fn restore_unavailable_reason(
        &self,
        session: &Session,
        root: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.connect()?;
        let matched: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sessions s JOIN sources src ON src.id=s.source_id WHERE s.id=?1 AND s.source_id=?2 AND s.kind=?3 AND s.external_id=?4 AND src.storage_root=?5 AND src.enabled=1)",
            params![session.id, session.source_id, session.kind.as_str(), session.external_id, root], |r| r.get(0)).map_err(error)?;
        let current_source = self.history_source(&session.source_id).ok();
        let same_root = current_source.as_ref().is_some_and(|source| {
            fs::canonicalize(&source.root).is_ok_and(|path| path.to_string_lossy() == root)
        });
        // Metadata-only Antigravity entries have no transcript file by design.
        // Restoring visibility does not grant resume capability or invent text.
        let metadata_only: bool = session.kind == AgentKind::Antigravity
            && conn.query_row("SELECT EXISTS(SELECT 1 FROM files WHERE session_id=?1 AND identity='antigravity-metadata-only')", [&session.id], |r| r.get(0)).map_err(error)?;
        let storage_available = if metadata_only {
            Path::new(root).join("conversation_summaries.db").is_file()
        } else {
            self.indexed_files_still_match(&session.id).unwrap_or(false)
        };
        if !matched || !same_root || !storage_available {
            return Ok(Some(
                "原始來源目前無法確認。請重新連接原來源並更新索引後再還原。".into(),
            ));
        }
        Ok(None)
    }

    pub fn trashed_sessions(&self, offset: usize, limit: usize) -> Result<TrashPage, String> {
        let conn = self.connect()?;
        let tx = conn.unchecked_transaction().map_err(error)?;
        let catalog_revision = read_revision(&tx)?.to_string();
        let total: u64 = tx
            .query_row("SELECT COUNT(*) FROM session_trash", [], |r| r.get(0))
            .map_err(error)?;
        let mut stmt = tx.prepare("SELECT id,snapshot,source_root,deleted_at FROM session_trash ORDER BY deleted_at DESC,id LIMIT ?1 OFFSET ?2").map_err(error)?;
        let rows = stmt
            .query_map(
                params![
                    limit.clamp(1, 200) as i64,
                    offset.min(i64::MAX as usize) as i64
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                },
            )
            .map_err(error)?;
        let mut items = Vec::new();
        for row in rows {
            let (id, snapshot, source_root, deleted_at) = row.map_err(error)?;
            let session: Session = serde_json::from_str(&snapshot).map_err(error)?;
            let unavailable_reason = self.restore_unavailable_reason(&session, &source_root)?;
            items.push(TrashedSession {
                id,
                session,
                source_root,
                deleted_at,
                unavailable_reason,
            });
        }
        Ok(TrashPage {
            items,
            total,
            catalog_revision,
        })
    }

    /// Inspect only a catalog-owned tombstone ID. Caller-supplied paths are never accepted.
    /// This is not a complete deletion plan or a proof of idle provider state.
    pub fn inspect_removal(&self, trash_id: &str) -> Result<RemovalInspection, String> {
        let conn = self.connect()?;
        let tx = conn.unchecked_transaction().map_err(error)?;
        let (snapshot, root): (String, String) = tx
            .query_row(
                "SELECT snapshot,source_root FROM session_trash WHERE id=?1",
                [trash_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(error)?
            .ok_or("回收筒項目已變更，請重新整理。")?;
        let session: Session = serde_json::from_str(&snapshot).map_err(error)?;
        let source: Option<(String, bool)> = tx
            .query_row(
                "SELECT root,enabled FROM sources WHERE id=?1 AND kind=?2 AND storage_root=?3",
                params![session.source_id, session.kind.as_str(), root],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        let Some((configured_root, true)) = source else {
            return Err("原始來源已移除、停用或變更，請重新連接並更新索引。".into());
        };
        let root_path = Path::new(&root);
        if fs::canonicalize(&configured_root).ok().as_deref() != Some(root_path)
            || !inspection_path_is_plain(root_path)
            || !inspection_path_is_plain(Path::new(&configured_root))
        {
            return Err("來源路徑已變更或包含連結，無法可靠檢查。".into());
        }
        let current = tx
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions s WHERE s.id=?1"),
                [&session.id],
                session_row,
            )
            .optional()
            .map_err(error)?;
        if !current.is_some_and(|current| {
            current.source_id == session.source_id
                && current.kind == session.kind
                && current.external_id == session.external_id
                && session.trash_identity.is_some()
                && current.trash_identity == session.trash_identity
        }) {
            return Err("索引中的 Session 來源已變更，請重新整理。".into());
        }
        let mut statement = tx.prepare(
            "SELECT path,identity,size,modified FROM files WHERE session_id=?1 AND source_id=?2 ORDER BY path LIMIT 201"
        ).map_err(error)?;
        let files = statement
            .query_map(params![session.id, session.source_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        if files.len() > 200 {
            return Err("來源項目過多，無法提供完整的索引檢查。".into());
        }
        let mut artifacts = Vec::new();
        // Shared stores use virtual file keys, not deletable transcript paths.
        if session.kind == AgentKind::OpenCode {
            artifacts.push(RemovalArtifact {
                relative_path: "opencode.db（含 WAL／journal 等共享狀態）".into(),
                status: "sharedStore".into(),
                indexed_bytes: None,
            });
        } else {
            for (path, identity, size, modified) in files {
                if identity == "antigravity-metadata-only" {
                    continue;
                }
                let path = Path::new(&path);
                // Indexed paths retain the configured spelling (including ordinary Windows
                // prefixes); both roots were verified to identify the same plain directory.
                let relative = path
                    .strip_prefix(Path::new(&configured_root))
                    .or_else(|_| path.strip_prefix(root_path))
                    .ok()
                    .filter(|p| {
                        !p.as_os_str().is_empty()
                            && p.components().all(|c| matches!(c, Component::Normal(_)))
                    })
                    .ok_or("索引包含來源範圍外的路徑，已停止檢查。")?;
                let matches = inspection_path_is_plain(path)
                    && fs::symlink_metadata(path).is_ok_and(|metadata| {
                        metadata.is_file()
                            && metadata.len() == size
                            && modification(&metadata) == modified
                            && path_identity(path, &metadata).is_ok_and(|value| value == identity)
                            && inspection_single_link(&metadata)
                    });
                artifacts.push(RemovalArtifact {
                    relative_path: relative.to_string_lossy().into_owned(),
                    status: if matches {
                        "metadataMatchesIndex"
                    } else {
                        "changedOrUnavailable"
                    }
                    .into(),
                    indexed_bytes: Some(size),
                });
            }
        }
        if session.kind == AgentKind::Antigravity {
            artifacts.push(RemovalArtifact {
                relative_path: "conversation_summaries.db（共享 metadata）".into(),
                status: "sharedStore".into(),
                indexed_bytes: None,
            });
        }
        let mut blockers = crate::removal::blockers(session.kind);
        if artifacts.is_empty() {
            blockers.push("目前沒有可確認的索引來源檔案。".into());
        }
        if artifacts.iter().any(|a| a.status == "changedOrUnavailable") {
            blockers.push("有檔案已變更、遺失或包含連結；請重新掃描後再次檢查。".into());
        }
        Ok(RemovalInspection {
            trash_id: trash_id.into(),
            session_id: session.id,
            external_id: session.external_id,
            kind: session.kind,
            source_root: root,
            catalog_revision: read_revision(&tx)?.to_string(),
            indexed_artifacts: artifacts,
            blockers,
        })
    }

    /// Drop a trashed Session from the index after its source files left for
    /// the OS trash. Restoring them from the OS trash re-indexes on next scan.
    pub fn purge_trashed(
        &self,
        trash_id: &str,
        session_id: &str,
        moved_at: i64,
        moved: &[crate::os_trash::MovedItem],
    ) -> Result<(), String> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let row: Option<(String, String, String)> = tx
            .query_row(
                "SELECT session_id,snapshot,source_root FROM session_trash WHERE id=?1",
                [trash_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(error)?;
        let Some((owner, snapshot, root)) = row.filter(|r| r.0 == session_id) else {
            return Err("回收筒項目已變更，請重新整理。".into());
        };
        let session: Session = serde_json::from_str(&snapshot).map_err(error)?;
        tx.execute(
            "DELETE FROM messages WHERE file_id IN (SELECT id FROM files WHERE session_id=?1)",
            [&owner],
        )
        .map_err(error)?;
        tx.execute("DELETE FROM files WHERE session_id=?1", [&owner])
            .map_err(error)?;
        tx.execute("DELETE FROM sessions WHERE id=?1", [&owner])
            .map_err(error)?;
        tx.execute("DELETE FROM session_trash WHERE id=?1", [trash_id])
            .map_err(error)?;
        tx.execute(
            "INSERT OR REPLACE INTO session_os_trash(id,title,kind,external_id,source_root,moved_at,items) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                trash_id,
                session.title,
                session.kind.as_str(),
                session.external_id,
                root,
                moved_at,
                serde_json::to_string(moved).map_err(error)?
            ],
        )
        .map_err(error)?;
        tx.commit().map_err(error)
    }

    pub fn os_trash_records(&self) -> Result<Vec<crate::os_trash::OsTrashRecord>, String> {
        let conn = self.connect()?;
        let mut statement = conn
            .prepare("SELECT id,title,kind,external_id,source_root,moved_at,items FROM session_os_trash ORDER BY moved_at DESC,id LIMIT 500")
            .map_err(error)?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, String>(6)?,
                ))
            })
            .map_err(error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        rows.into_iter()
            .map(
                |(id, title, kind, external_id, source_root, moved_at, items)| {
                    Ok(crate::os_trash::OsTrashRecord {
                        id,
                        title,
                        kind: AgentKind::parse(&kind)?,
                        external_id,
                        source_root,
                        moved_at,
                        items: serde_json::from_str(&items).map_err(error)?,
                    })
                },
            )
            .collect()
    }

    pub fn forget_os_trash(&self, id: &str) -> Result<(), String> {
        self.connect()?
            .execute("DELETE FROM session_os_trash WHERE id=?1", [id])
            .map(|_| ())
            .map_err(error)
    }

    pub fn restore_session(&self, id: &str) -> Result<(), String> {
        let mut conn = self.connect()?;
        // Serialize with scanners/source edits so the checked provenance cannot
        // be replaced between validation and removal of the tombstone.
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT snapshot,source_root FROM session_trash WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        let Some((snapshot, root)) = row else {
            return Ok(());
        };
        let session: Session = serde_json::from_str(&snapshot).map_err(error)?;
        if let Some(reason) = self.restore_unavailable_reason(&session, &root)? {
            return Err(reason);
        }
        tx.execute("DELETE FROM session_trash WHERE id=?1", [id])
            .map_err(error)?;
        tx.commit().map_err(error)
    }

    pub fn query(&self, query: &SessionQuery) -> Result<SessionPage, String> {
        self.query_observed(query, |_| {})
    }

    /// Benchmark-only phase timings. Normal queries have no clock or logging overhead.
    #[cfg(feature = "search-profile")]
    pub fn query_profiled(
        &self,
        query: &SessionQuery,
    ) -> Result<(SessionPage, SearchPhaseTimings), String> {
        let mut phases = Vec::new();
        let mut start = std::time::Instant::now();
        let page = self.query_observed(query, |phase| {
            phases.push((phase, start.elapsed().as_secs_f64() * 1000.));
            start = std::time::Instant::now();
        })?;
        Ok((page, phases))
    }

    fn query_observed(
        &self,
        query: &SessionQuery,
        mut observe: impl FnMut(&'static str),
    ) -> Result<SessionPage, String> {
        let conn = self.connect()?;
        let conn = conn.unchecked_transaction().map_err(error)?;
        let catalog_revision = read_revision(&conn)?.to_string();
        observe("connect");
        // Probe tombstones first; an empty recycle bin needs no per-row source lookup.
        let mut clauses = vec!["NOT EXISTS(SELECT 1 FROM session_trash t CROSS JOIN sources src ON src.id=s.source_id WHERE t.session_id=s.id AND t.source_root=src.storage_root)".to_owned()];
        let mut values: Vec<SqlValue> = Vec::new();
        if let Some(ref id) = query.project_id {
            clauses.push("s.project_id=?".into());
            values.push(id.clone().into());
        }
        if let Some(kind) = query.kind {
            clauses.push("s.kind=?".into());
            values.push(kind.as_str().to_owned().into());
        }
        if let Some(archived) = query.archived {
            clauses.push("s.archived=?".into());
            values.push((archived as i64).into());
        }
        if !query.include_children.unwrap_or(false) {
            clauses.push("s.child=0".into());
        }
        if let Some(ref after) = query.after {
            let time = adapters::normalized_time(after).ok_or("The start date must be RFC3339.")?;
            clauses.push("s.updated_at>=?".into());
            values.push(time.into());
        }
        if let Some(ref before) = query.before {
            let time = adapters::normalized_time(before).ok_or("The end date must be RFC3339.")?;
            clauses.push("s.updated_at<?".into());
            values.push(time.into());
        }
        let search = query.query.as_deref().unwrap_or("").trim();
        if search.chars().count() > 1000 {
            return Err("Search text is limited to 1,000 characters.".into());
        }
        if search.contains('\0') {
            return Err("Search text cannot contain a NUL character.".into());
        }
        let fold_ascii = search.bytes().any(|byte| byte.is_ascii_alphabetic());
        let folded_search =
            fold_ascii.then(|| (search.to_ascii_lowercase(), literal_like_pattern(search)));
        if !search.is_empty() {
            let literal_parameter = values.len() + 1;
            values.push(search.to_owned().into());
            let folded_parameters = folded_search.as_ref().map(|(folded, pattern)| {
                values.push(folded.clone().into());
                let folded_parameter = values.len();
                values.push(pattern.clone().into());
                (folded_parameter, values.len())
            });
            let title_match = literal_match_sql("s.title", literal_parameter, folded_parameters);
            let body_match =
                literal_match_sql("m.search_text", literal_parameter, folded_parameters);
            if search.chars().count() >= 3 {
                // FTS is only a candidate set. Exact matching preserves literal punctuation,
                // ASCII-only case folding, Chinese, and all original matching semantics.
                let candidates = trigram_candidates(search);
                // Stop the probe after 1,025 matching FTS rowids, without reading
                // message bodies (posting-list intersection work is not bounded
                // by that limit). A broad posting list should not force us
                // to validate every message after its session already matched.
                let dense = conn.query_row(
                    "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?1 LIMIT 1 OFFSET 1024",
                    [&candidates], |row| row.get::<_, i64>(0),
                ).optional().map_err(error)?.is_some();
                values.push(candidates.into());
                let candidate_parameter = values.len();
                if dense {
                    // The uncorrelated IN set is built once per statement. Visit
                    // each session's files/messages and stop on its first exact
                    // hit. Pin the file-first indexed traversal so the planner
                    // cannot rescan the entire posting list for every session.
                    clauses.push(format!("({title_match} OR EXISTS(SELECT 1 FROM files f CROSS JOIN messages m INDEXED BY messages_file ON m.file_id=f.id WHERE f.session_id=s.id AND m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?{candidate_parameter}) AND m.hidden=0 AND {body_match}))"));
                } else {
                    // Selective queries keep the candidate-first path; enumerating
                    // every session's messages would penalize rare and absent hits.
                    clauses.push(format!("({title_match} OR s.id IN (SELECT f.session_id FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid JOIN files f ON f.id=m.file_id WHERE messages_fts MATCH ?{candidate_parameter} AND m.hidden=0 AND {body_match}))"));
                }
            } else {
                clauses.push(format!("({title_match} OR EXISTS(SELECT 1 FROM files f JOIN messages m ON m.file_id=f.id WHERE f.session_id=s.id AND m.hidden=0 AND {body_match}))"));
            }
        }
        let filter = clauses.join(" AND ");
        observe("plan");
        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM sessions s WHERE {filter}"),
                params_from_iter(values.iter()),
                |r| r.get(0),
            )
            .map_err(error)?;
        observe("count");
        let limit = query.limit.unwrap_or(50).clamp(1, 200);
        let offset = query.offset.unwrap_or(0).min(i64::MAX as usize);
        values.push((limit as i64).into());
        values.push((offset as i64).into());
        let direction = if query.oldest_first.unwrap_or(false) {
            "ASC"
        } else {
            "DESC"
        };
        let mut stmt = conn.prepare(&format!("SELECT {SESSION_COLUMNS} FROM sessions s WHERE {filter} ORDER BY s.updated_at {direction},s.id ASC LIMIT ? OFFSET ?")).map_err(error)?;
        let rows = stmt
            .query_map(params_from_iter(values.iter()), session_row)
            .map_err(error)?;
        let mut items = rows.collect::<Result<Vec<_>, _>>().map_err(error)?;
        observe("page");
        for session in &mut items {
            let text: Option<String> = if search.is_empty() {
                conn.query_row("SELECT substr(m.search_text,1,220) FROM messages m JOIN files f ON f.id=m.file_id WHERE f.session_id=?1 AND m.hidden=0 AND m.search_text<>'' ORDER BY m.line DESC LIMIT 1", [&session.id], |r| r.get(0)).optional().map_err(error)?
            } else {
                let folded_parameter = folded_search.as_ref().map(|_| 3);
                let position = literal_position_sql("m.search_text", 2, folded_parameter);
                let body_match =
                    literal_match_sql("m.search_text", 2, folded_search.as_ref().map(|_| (3, 4)));
                let sql = format!("SELECT substr(m.search_text,max(1,({position})-50),220) FROM messages m JOIN files f ON f.id=m.file_id WHERE f.session_id=?1 AND m.hidden=0 AND {body_match} ORDER BY m.line DESC LIMIT 1");
                let mut params: Vec<SqlValue> =
                    vec![session.id.clone().into(), search.to_owned().into()];
                if let Some((folded, pattern)) = &folded_search {
                    params.push(folded.clone().into());
                    params.push(pattern.clone().into());
                }
                conn.query_row(&sql, params_from_iter(params.iter()), |r| r.get(0))
                    .optional()
                    .map_err(error)?
            };
            session.snippet = text.map(|text| snippet(&text, search));
        }
        observe("snippets");
        Ok(SessionPage {
            catalog_revision,
            items,
            total: total as u64,
        })
    }

    pub fn transcript(
        &self,
        id: &str,
        before_line: Option<u64>,
        limit: usize,
    ) -> Result<TranscriptPage, String> {
        let conn = self.connect()?;
        let conn = conn.unchecked_transaction().map_err(error)?;
        let session = conn
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions s WHERE s.id=?1"),
                [id],
                session_row,
            )
            .optional()
            .map_err(error)?
            .ok_or("Session not found. Refresh the history index.")?;
        let file: Option<(i64,String,String,u64,String,u64)> = conn.query_row(
            "SELECT id,path,identity,size,modified,offset FROM files WHERE session_id=?1 ORDER BY archived ASC,modified DESC,path LIMIT 1", [id],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get::<_,i64>(3)? as u64,r.get(4)?,r.get::<_,i64>(5)? as u64))).optional().map_err(error)?;
        let Some((file_id, path, identity, size, modified, _offset)) = file else {
            return Ok(stale_page(
                "The source transcript is no longer indexed. Refresh the index.",
            ));
        };
        let (state_json, prefix_hash, parser_version): (String, String, i64) = conn
            .query_row(
                "SELECT state,prefix_hash,parser_version FROM files WHERE id=?1",
                [file_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(error)?;
        let duplicate_files: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM files WHERE session_id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(error)?;
        // Opaque stable token for the entire indexed transcript, not just this page.
        // No filesystem spelling or transcript prose is returned to the frontend.
        let snapshot_id = Some(format!(
            "snapshot-{}",
            hash_id(&[
                id,
                &identity,
                &prefix_hash,
                &parser_version.to_string(),
                &state_json,
                &duplicate_files.to_string(),
                &session.partial.to_string()
            ])
        ));
        if session.kind == AgentKind::OpenCode {
            return opencode_transcript(
                &conn,
                &session,
                file_id,
                &prefix_hash,
                before_line,
                limit,
                snapshot_id,
            );
        }
        let ag_checkpoint = if session.kind == AgentKind::Antigravity {
            let state: ParsedState = serde_json::from_str(&state_json).map_err(error)?;
            let root: String = conn
                .query_row(
                    "SELECT root FROM sources WHERE id=?1",
                    [&session.source_id],
                    |row| row.get(0),
                )
                .map_err(error)?;
            match antigravity_metadata::read_metadata(Path::new(&root), &AtomicBool::new(false)) {
                Ok(current) if Some(&current.fingerprint) == state.antigravity_metadata_hash.as_ref() => {},
                _ => return Ok(stale_page("Antigravity metadata changed or could not be verified. Refresh the index before loading the transcript.")),
            }
            Some(prefix_hash)
        } else {
            None
        };
        if identity == "antigravity-metadata-only" {
            return Ok(TranscriptPage { messages: vec![], has_more: false, before_line: None, stale: false, snapshot_id, warning: Some("Only conversation metadata or its directory identity is available. The official Antigravity CLI transcript.jsonl is missing; content cannot be previewed or searched. transcript_full.jsonl is never used to restore possibly cleared content.".into()) });
        }
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                return Ok(stale_page(
                    "The source transcript was removed or cannot be read. Refresh the index.",
                ))
            }
        };
        // A changed file can invalidate byte locators. Do not display cached text as current.
        if !path_identity(Path::new(&path), &metadata).is_ok_and(|value| value == identity)
            || metadata.len() != size
            || modification(&metadata) != modified
        {
            return Ok(stale_page("The source transcript changed after indexing. Refresh the index before loading it."));
        }
        let mut grok_metadata_hash = None;
        if session.kind == AgentKind::Grok {
            let state_json: String = conn
                .query_row("SELECT state FROM files WHERE id=?1", [file_id], |row| {
                    row.get(0)
                })
                .map_err(error)?;
            let state: ParsedState = serde_json::from_str(&state_json).map_err(error)?;
            if grok_metadata(Path::new(&path))
                .map(|metadata| metadata.grok_metadata_hash != state.grok_metadata_hash)
                .unwrap_or(true)
            {
                return Ok(stale_page(
                    "Grok metadata changed after indexing. Refresh the index before loading it.",
                ));
            }
            grok_metadata_hash = state.grok_metadata_hash;
        }
        let mut handle = open_transcript(Path::new(&path), session.kind)
            .map_err(|_| "The transcript is not readable. Check source permissions.".to_owned())?;
        let opened = handle.metadata().map_err(error)?;
        if handle_identity(&handle, &opened).map_err(error)? != identity
            || opened.len() != size
            || modification(&opened) != modified
        {
            return Ok(stale_page(
                "The transcript changed while opening it. Refresh the index.",
            ));
        }
        if ag_checkpoint.as_ref().is_some_and(|expected| {
            prefix_digest(&mut handle, _offset, &AtomicBool::new(false)).as_ref() != Ok(expected)
        }) {
            return Ok(stale_page(
                "Antigravity transcript contents changed after indexing. Refresh the index.",
            ));
        }
        let limit = limit.clamp(1, 200);
        let before = before_line.map(|line| line.min(i64::MAX as u64) as i64);
        let mut stmt = conn.prepare("SELECT line,byte_offset,byte_len,role,timestamp,placeholder FROM messages WHERE file_id=?1 AND (?2 IS NULL OR line<?2) AND hidden=0 ORDER BY line DESC LIMIT ?3").map_err(error)?;
        let locators = stmt
            .query_map(params![file_id, before, (limit + 1) as i64], |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get::<_, i64>(1)? as u64,
                    r.get::<_, i64>(2)? as usize,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        let locator_count = locators.len();
        let mut messages = Vec::new();
        let mut page_bytes = 0usize;
        let mut shortened = false;
        for (line, offset, len, role, timestamp, placeholder) in locators.into_iter().take(limit) {
            let text =
                if let Some(placeholder) = placeholder {
                    placeholder
                } else {
                    if len > MAX_LINE_BYTES {
                        "[Oversized record omitted]".into()
                    } else {
                        handle.seek(SeekFrom::Start(offset)).map_err(error)?;
                        let mut bytes = vec![0; len];
                        if handle.read_exact(&mut bytes).is_err() {
                            return Ok(stale_page(
                            "The transcript changed while it was being read. Refresh the index.",
                        ));
                        }
                        if session.kind == AgentKind::Grok {
                            // One logical message can span adjacent ACP JSONL chunks.
                            // The indexed span is bounded and each chunk is parsed with
                            // the same omissions as indexing, with no invented spaces.
                            let mut text = String::new();
                            for line in bytes
                                .split(|byte| *byte == b'\n')
                                .filter(|line| !line.is_empty())
                            {
                                match serde_json::from_slice::<serde_json::Value>(line) {
                                    Ok(value) => {
                                        if let Some(message) = adapters::parse_value(
                                            AgentKind::Grok,
                                            &value,
                                            &mut ParsedState::default(),
                                            Path::new(&path),
                                        ) {
                                            if message.searchable {
                                                text.push_str(&message.text);
                                            }
                                        }
                                    }
                                    Err(_) => return Ok(stale_page(
                                        "The Grok message span is malformed. Refresh the index.",
                                    )),
                                }
                            }
                            text
                        } else {
                            match serde_json::from_slice::<serde_json::Value>(&bytes) {
                                Ok(value) => adapters::parse_value(
                                    session.kind,
                                    &value,
                                    &mut ParsedState::default(),
                                    Path::new(&path),
                                )
                                .map(|message| message.text)
                                .unwrap_or_else(|| "[Unsupported event]".into()),
                                Err(_) => "[Malformed JSON record]".into(),
                            }
                        }
                    }
                };
            let (text, clipped) = bounded_preview(text);
            // Byte budget complements pagination, keeping desktop IPC bounded.
            if !messages.is_empty() && page_bytes + text.len() > MAX_PREVIEW_PAGE_BYTES {
                break;
            }
            shortened |= clipped;
            page_bytes += text.len();
            messages.push(TranscriptMessage {
                role,
                text,
                timestamp,
                line,
            });
        }
        let has_more = locator_count > messages.len();
        messages.reverse();
        let before_line = messages.first().map(|m| m.line).filter(|_| has_more);
        let after_read = handle.metadata().map_err(error)?;
        let path_still_matches = fs::metadata(&path)
            .map(|m| {
                path_identity(Path::new(&path), &m).is_ok_and(|value| value == identity)
                    && m.len() == size
                    && modification(&m) == modified
            })
            .unwrap_or(false);
        if !path_still_matches
            || handle_identity(&handle, &after_read).map_err(error)? != identity
            || after_read.len() != size
            || modification(&after_read) != modified
        {
            return Ok(stale_page(
                "The transcript changed while it was being read. Refresh the index.",
            ));
        }
        if session.kind == AgentKind::Grok
            && grok_metadata(Path::new(&path))
                .map(|metadata| metadata.grok_metadata_hash != grok_metadata_hash)
                .unwrap_or(true)
        {
            return Ok(stale_page(
                "Grok metadata changed while reading the transcript. Refresh the index.",
            ));
        }
        if ag_checkpoint.as_ref().is_some_and(|expected| {
            prefix_digest(&mut handle, _offset, &AtomicBool::new(false)).as_ref() != Ok(expected)
        }) {
            return Ok(stale_page(
                "Antigravity transcript contents changed while loading. Refresh the index.",
            ));
        }
        let mut warning = if duplicate_files > 1 {
            Some("Multiple transcript files have this source/session identity. Showing one file; resume is blocked until the ambiguity is resolved.".into())
        } else if session.partial && session.kind == AgentKind::Antigravity {
            Some("This Antigravity transcript or its metadata is incomplete. Unsupported, cleared, truncated, or conflicting records may be omitted; available messages are not guaranteed to be the complete conversation.".into())
        } else if session.partial {
            Some("This transcript is incomplete or contains unsupported records. Placeholders indicate omitted content.".into())
        } else {
            None
        };
        if session.kind == AgentKind::Antigravity {
            let state_json: String = conn
                .query_row("SELECT state FROM files WHERE id=?1", [file_id], |row| {
                    row.get(0)
                })
                .map_err(error)?;
            let state: ParsedState = serde_json::from_str(&state_json).map_err(error)?;
            if let Some(note) = state.history_warning {
                warning = Some(
                    warning.map_or_else(|| note.clone(), |existing| format!("{existing} {note}")),
                );
            }
        }
        if shortened {
            let note = "Some messages were shortened to 64 KiB for preview; complete text within supported records remains searchable.";
            warning = Some(
                warning.map_or_else(|| note.to_owned(), |existing| format!("{existing} {note}")),
            );
        }
        Ok(TranscriptPage {
            messages,
            has_more,
            before_line,
            stale: false,
            warning,
            snapshot_id,
        })
    }

    pub fn resume_source(&self, session_id: &str) -> Result<(Session, HistorySource), String> {
        let session = self.session(session_id)?;
        if let Some(reason) = &session.resume_disabled_reason {
            return Err(reason.clone());
        }
        let conn = self.connect()?;
        let conn = conn.unchecked_transaction().map_err(error)?;
        let source = conn
            .query_row(
                "SELECT id,kind,root,enabled FROM sources WHERE id=?1",
                [&session.source_id],
                |r| {
                    Ok(HistorySource {
                        id: r.get(0)?,
                        kind: session.kind,
                        root: r.get(2)?,
                        enabled: r.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(error)?
            .ok_or("The history source was removed.")?;
        if !source.enabled {
            return Err(
                "This history source is disabled. Enable and refresh it before resuming.".into(),
            );
        }
        if !Path::new(&source.root).is_dir() {
            return Err("The history source directory is missing or unreadable.".into());
        }
        let copies: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE kind=?1 AND external_id=?2",
                params![session.kind.as_str(), session.external_id],
                |r| r.get(0),
            )
            .map_err(error)?;
        if copies != 1 && session.kind != AgentKind::Antigravity {
            return Err("This session ID exists in multiple history sources. Disable the other source and refresh before resuming; Session Bay will not guess.".into());
        }
        if session.kind == AgentKind::OpenCode {
            let expected: String = conn
                .query_row(
                    "SELECT prefix_hash FROM files WHERE session_id=?1",
                    [session_id],
                    |row| row.get(0),
                )
                .map_err(error)?;
            let current = crate::opencode::session_fingerprint(
                Path::new(&source.root),
                &session.external_id,
            )?;
            if current.as_deref() != Some(expected.as_str()) {
                return Err(
                    "OpenCode history changed after indexing. Refresh before resuming.".into(),
                );
            }
            return Ok((session, source));
        }
        let mut stmt = conn
            .prepare("SELECT path,identity,size,modified FROM files WHERE session_id=?1")
            .map_err(error)?;
        let paths = stmt
            .query_map([session_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as u64,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        if paths.len() != 1 {
            return Err("Multiple files claim this session ID. Resolve the duplicate transcripts before resuming.".into());
        }
        let parser_state: String = conn
            .query_row(
                "SELECT state FROM files WHERE session_id=?1 LIMIT 1",
                [session_id],
                |row| row.get(0),
            )
            .map_err(error)?;
        let parsed_state = serde_json::from_str::<ParsedState>(&parser_state).map_err(error)?;
        if parsed_state.identity_conflict {
            return Err("This file contains conflicting session identities. Resume is blocked until the source is corrected.".into());
        }
        let (path, identity, size, modified) = &paths[0];
        if source.kind == AgentKind::Antigravity {
            if let Some(reason) =
                antigravity_resume_disabled_reason(&source.root, &session.external_id)
            {
                return Err(reason);
            }
            let current = antigravity_metadata::read_metadata(
                Path::new(&source.root),
                &AtomicBool::new(false),
            )?;
            if Some(current.fingerprint) != parsed_state.antigravity_metadata_hash {
                return Err("Antigravity metadata changed after indexing. Refresh the index before resuming.".into());
            }
        }
        if source.kind == AgentKind::Grok {
            if grok_metadata(Path::new(path))?.grok_metadata_hash != parsed_state.grok_metadata_hash
            {
                return Err(
                    "Grok metadata changed after indexing. Refresh the index before resuming."
                        .into(),
                );
            }
            if Path::new(path)
                .file_name()
                .is_none_or(|name| name != "updates.jsonl")
            {
                return Err(
                    "The Grok update stream is missing; this summary cannot be resumed.".into(),
                );
            }
        }
        let mut file = open_transcript(Path::new(path), session.kind).map_err(|_| {
            "The source transcript is missing or unreadable. Refresh the index.".to_owned()
        })?;
        let metadata = file.metadata().map_err(error)?;
        if handle_identity(&file, &metadata).map_err(error)? != *identity
            || metadata.len() != *size
            || modification(&metadata) != *modified
        {
            return Err(
                "The transcript changed after indexing. Refresh the index before resuming.".into(),
            );
        }
        if source.kind == AgentKind::Antigravity {
            let (offset, expected): (i64, String) = conn
                .query_row(
                    "SELECT offset,prefix_hash FROM files WHERE session_id=?1 LIMIT 1",
                    [session_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(error)?;
            if !antigravity_path_is_safe(Path::new(&source.root), Path::new(path))
                || prefix_digest(&mut file, offset as u64, &AtomicBool::new(false))? != expected
            {
                return Err("Antigravity transcript contents or path changed. Refresh the index before resuming.".into());
            }
        }
        if session.external_id.trim().is_empty()
            || session.external_id.starts_with('-')
            || session.external_id.contains(['\0', '\n', '\r'])
        {
            return Err("This transcript has an unsafe or unsupported session identifier.".into());
        }
        if session.parent_id.is_some() && session.external_id.starts_with("agent-") {
            return Err("Direct resume of a Claude subagent transcript is unsupported. Open its parent session.".into());
        }
        Ok((session, source))
    }

    pub fn clear(&self) -> Result<(), String> {
        let mut conn = self.connect()?;
        let tx = conn.transaction().map_err(error)?;
        tx.execute_batch(
            "DELETE FROM messages; DELETE FROM files; DELETE FROM sessions; DELETE FROM sources; INSERT INTO messages_fts(messages_fts) VALUES('delete-all');",
        )
        .map_err(error)?;
        tx.commit().map_err(error)?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(error)?;
        Ok(())
    }

    pub fn sync(
        &self,
        sources: &[HistorySource],
        cancel: &AtomicBool,
        progress: impl Fn(IndexStatus),
    ) -> Result<IndexStatus, String> {
        self.sync_with_paused_providers(sources, &HashSet::new(), cancel, progress)
    }

    /// Pausing a provider does not disable/remove its sources or invalidate cached history.
    /// Keep the full configured source list so unrelated scans cannot delete paused rows.
    pub fn sync_with_paused_providers(
        &self,
        sources: &[HistorySource],
        paused_providers: &HashSet<AgentKind>,
        cancel: &AtomicBool,
        progress: impl Fn(IndexStatus),
    ) -> Result<IndexStatus, String> {
        let mut conn = self.connect()?;
        // Deduplication work contains only digests and row identities, never a
        // second transcript copy. Set a page-cache target and allow disk spill.
        conn.execute_batch("PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-2048;")
            .map_err(error)?;
        let mut status = IndexStatus {
            running: true,
            ..IndexStatus::default()
        };
        if cancel.load(Ordering::Relaxed) {
            status.running = false;
            status.cancelled = true;
            progress(status.clone());
            return Ok(status);
        }
        let mut ids = HashSet::new();
        for source in sources {
            if source.id.trim().is_empty() || !ids.insert(source.id.clone()) {
                return Err("Each history source must have a unique, nonempty ID.".into());
            }
            if !Path::new(&source.root).is_absolute() {
                return Err("History source roots must be absolute directories.".into());
            }
        }
        let existing = conn
            .prepare("SELECT id FROM sources")
            .map_err(error)?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        for id in existing {
            if !ids.contains(&id) {
                conn.execute("DELETE FROM sources WHERE id=?1", [&id])
                    .map_err(error)?;
            }
        }
        let mut discoveries = Vec::new();
        for source in sources {
            if paused_providers.contains(&source.kind) {
                status.sources.push(SourceHealth {
                    source_id: source.id.clone(),
                    status: "paused".into(),
                    message: Some("Agent disabled; cached history is retained.".into()),
                    files: 0,
                });
                continue;
            }
            // Publish new source provenance only with invalidation of old rows.
            // Readers see either the previous identity or the new empty source.
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(error)?;
            let old: Option<(String, String, String)> = tx
                .query_row(
                    "SELECT kind,root,storage_root FROM sources WHERE id=?1",
                    [&source.id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(error)?;
            // A temporarily unavailable symlink/mount must not replace its
            // remembered canonical identity with the unresolved spelling.
            let storage_root = fs::canonicalize(&source.root)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| {
                    old.as_ref()
                        .filter(|(kind, root, _)| {
                            kind == source.kind.as_str() && root == &source.root
                        })
                        .map(|(_, _, storage)| storage.clone())
                        .unwrap_or_else(|| directory_key(&source.root))
                });
            if old.is_some_and(|(kind, root, storage)| {
                kind != source.kind.as_str() || root != source.root || storage != storage_root
            }) || !source.enabled
            {
                tx.execute("DELETE FROM sources WHERE id=?1", [&source.id])
                    .map_err(error)?;
            }
            tx.execute("INSERT INTO sources(id,kind,root,enabled,storage_root) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,root=excluded.root,enabled=excluded.enabled,storage_root=excluded.storage_root",params![source.id,source.kind.as_str(),source.root,source.enabled,storage_root]).map_err(error)?;
            tx.commit().map_err(error)?;
            let (files, health, complete) = discover(source, cancel);
            status.total += files.len();
            status.sources.push(health);
            discoveries.push((source, files, complete));
        }
        progress(status.clone());
        for (source, mut files, complete) in discoveries {
            if cancel.load(Ordering::Relaxed) {
                status.cancelled = true;
                break;
            }
            if !source.enabled {
                continue;
            }
            if source.kind == AgentKind::OpenCode {
                match index_opencode(&mut conn, source, cancel) {
                    Ok(health) => {
                        status.processed += 1;
                        if let Some(existing) =
                            status.sources.iter_mut().find(|h| h.source_id == source.id)
                        {
                            *existing = health;
                        }
                    }
                    Err(message) => {
                        if cancel.load(Ordering::Relaxed) {
                            status.cancelled = true;
                            break;
                        }
                        if status.errors.len() < MAX_ERRORS {
                            status.errors.push(format!("{}: {message}", source.id));
                        }
                        if let Some(health) =
                            status.sources.iter_mut().find(|h| h.source_id == source.id)
                        {
                            health.status = "error".into();
                            health.message = Some(message);
                        }
                    }
                }
                progress(status.clone());
                continue;
            }
            let ag_metadata = if source.kind == AgentKind::Antigravity
                && Path::new(&source.root).is_dir()
            {
                match antigravity_metadata::read_metadata(Path::new(&source.root), cancel) {
                    Ok(metadata) => {
                        // Full logs can retain content cleared from the official log.
                        // Their existence identifies a conversation, never authoritative prose.
                        for path in &mut files {
                            if path
                                .file_name()
                                .is_some_and(|name| name == "transcript_full.jsonl")
                            {
                                *path = path.with_file_name("transcript.jsonl");
                            }
                        }
                        let present: HashSet<_> = files
                            .iter()
                            .filter_map(|path| {
                                antigravity_transcript_id(Path::new(&source.root), path)
                            })
                            .collect();
                        for id in metadata.records.keys() {
                            if !present.contains(id) {
                                files
                                    .push(antigravity_transcript_path(Path::new(&source.root), id));
                                status.total += 1;
                            }
                        }
                        if let Some(health) = status
                            .sources
                            .iter_mut()
                            .find(|health| health.source_id == source.id)
                        {
                            health.files = files.len();
                            if !files.is_empty() && health.status == "empty" {
                                health.status = "ready".into();
                                health.message = None;
                            }
                        }
                        if !metadata.warnings.is_empty() && !files.is_empty() {
                            if let Some(health) = status.sources.iter_mut().find(|health| {
                                health.source_id == source.id && health.status != "error"
                            }) {
                                health.status = "partial".into();
                                health.message = Some(metadata.warnings.join(" "));
                            }
                        }
                        Some(metadata)
                    }
                    Err(message) => {
                        if cancel.load(Ordering::Relaxed) {
                            status.cancelled = true;
                            break;
                        }
                        if status.errors.len() < MAX_ERRORS {
                            status.errors.push(format!("{}: {message}", source.id));
                        }
                        if let Some(health) = status
                            .sources
                            .iter_mut()
                            .find(|health| health.source_id == source.id)
                        {
                            health.status = "error".into();
                            health.message = Some(format!("Antigravity metadata could not be verified; cached entries are retained. {message}"));
                        }
                        progress(status.clone());
                        continue;
                    }
                }
            } else {
                None
            };
            let mut seen = HashSet::new();
            let mut partial = 0usize;
            let mut failed = false;
            for path in files {
                if cancel.load(Ordering::Relaxed) {
                    status.cancelled = true;
                    break;
                }
                seen.insert(path.to_string_lossy().into_owned());
                match index_file(&mut conn, source, &path, cancel, ag_metadata.as_ref()) {
                    Ok(is_partial) => {
                        if is_partial {
                            partial += 1;
                        }
                    }
                    Err(message) if cancel.load(Ordering::Relaxed) => {
                        let _ = message;
                        status.cancelled = true;
                        break;
                    }
                    Err(message) => {
                        failed = true;
                        if status.errors.len() < MAX_ERRORS {
                            status.errors.push(format!("{}: {message}", source.id));
                        }
                    }
                }
                status.processed += 1;
                progress(status.clone());
            }
            if !status.cancelled && complete {
                // Acquire the writer before reading reconciliation state. A
                // concurrent project edit must not invalidate a WAL snapshot
                // between this read and the deletion/rebuild writes.
                let tx = conn
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(error)?;
                let old = tx
                    .prepare("SELECT id,path,session_id FROM files WHERE source_id=?1")
                    .map_err(error)?
                    .query_map([&source.id], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, Option<String>>(2)?,
                        ))
                    })
                    .map_err(error)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(error)?;
                let mut affected = HashSet::new();
                for (id, path, session) in old {
                    if !seen.contains(&path) {
                        tx.execute("DELETE FROM files WHERE id=?1", [id])
                            .map_err(error)?;
                        if let Some(session) = session {
                            affected.insert(session);
                        }
                    }
                }
                for id in affected {
                    rebuild_session(&tx, source, &id)?;
                }
                tx.commit().map_err(error)?;
            }
            if !status.cancelled {
                if let Err(message) = refresh_source_titles(&mut conn, source, cancel) {
                    if cancel.load(Ordering::Relaxed) {
                        status.cancelled = true;
                    } else {
                        failed = true;
                        if status.errors.len() < MAX_ERRORS {
                            status.errors.push(format!("{}: {message}", source.id));
                        }
                    }
                }
            }
            if let Some(health) = status.sources.iter_mut().find(|h| h.source_id == source.id) {
                if status.cancelled {
                    health.status = "cancelled".into();
                    health.message =
                        Some("Indexing cancelled; committed files remain available.".into());
                } else if failed {
                    health.status = "error".into();
                    health.message = Some(
                        "Some transcripts could not be read; readable files were indexed.".into(),
                    );
                } else if partial > 0 && health.status != "error" {
                    health.status = "partial".into();
                    health.message = Some(format!(
                        "{partial} transcript(s) contain incomplete or unsupported records."
                    ));
                }
            }
            progress(status.clone());
            if status.cancelled {
                break;
            }
        }
        status.cancelled |= cancel.load(Ordering::Relaxed);
        status.running = false;
        for health in &status.sources {
            if health.status == "error" && status.errors.len() < MAX_ERRORS {
                let message = format!(
                    "{}: {}",
                    health.source_id,
                    health.message.as_deref().unwrap_or("Source scan failed.")
                );
                if !status.errors.contains(&message) {
                    status.errors.push(message);
                }
            }
        }
        progress(status.clone());
        Ok(status)
    }
}

fn load_project(conn: &Connection, id: &str) -> Result<Project, String> {
    load_projects(conn, Some(id))?
        .into_iter()
        .next()
        .ok_or_else(|| "Project not found.".into())
}

fn load_projects(conn: &Connection, id: Option<&str>) -> Result<Vec<Project>, String> {
    let mut stmt = conn.prepare("SELECT p.id,p.name,p.path,p.launch_path,p.pinned,p.manual,COUNT(s.id),MAX(s.updated_at)
        FROM projects p LEFT JOIN sessions s ON s.project_id=p.id AND NOT EXISTS(SELECT 1 FROM session_trash t WHERE t.session_id=s.id AND t.source_root=(SELECT storage_root FROM sources WHERE id=s.source_id))
        WHERE (?1 IS NULL OR p.id=?1)
        GROUP BY p.id ORDER BY p.pinned DESC,MAX(s.updated_at) DESC,p.name,p.id").map_err(error)?;
    let rows = stmt
        .query_map([id], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                launch_path: row.get(3)?,
                pinned: row.get(4)?,
                curated: row.get(5)?,
                session_count: row.get::<_, i64>(6)? as u64,
                updated_at: row.get(7)?,
                exists: false,
                agents: vec![],
            })
        })
        .map_err(error)?;
    let mut projects = rows.collect::<Result<Vec<_>, _>>().map_err(error)?;
    for project in &mut projects {
        project.exists = project
            .launch_path
            .as_ref()
            .or(project.path.as_ref())
            .is_some_and(|path| Path::new(path).is_absolute() && Path::new(path).is_dir());
        let mut agents = conn
            .prepare("SELECT DISTINCT kind FROM sessions s WHERE project_id=?1 AND NOT EXISTS(SELECT 1 FROM session_trash t WHERE t.session_id=s.id AND t.source_root=(SELECT storage_root FROM sources WHERE id=s.source_id)) ORDER BY kind")
            .map_err(error)?;
        let values = agents
            .query_map([&project.id], |r| r.get::<_, String>(0))
            .map_err(error)?;
        project.agents = values
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?
            .iter()
            .map(|kind| AgentKind::parse(kind))
            .collect::<Result<_, _>>()?;
    }
    Ok(projects)
}

fn session_row(row: &Row<'_>) -> rusqlite::Result<Session> {
    let kind: String = row.get(2)?;
    let kind = AgentKind::parse(&kind).map_err(|message| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    })?;
    let external_id: String = row.get(3)?;
    let resume_disabled_reason = if kind == AgentKind::OpenCode && row.get::<_, bool>(11)? {
        Some("OpenCode history is partial, unsupported, or reverted. Refresh after resolving it before indexed resume.".into())
    } else if kind == AgentKind::Antigravity {
        let root: String = row.get(12)?;
        let identity: Option<String> = row.get(13)?;
        if row.get::<_, Option<String>>(10)?.is_some() {
            Some("Indexed resume of Antigravity subagent conversations is not verified. Open the parent conversation.".into())
        } else if identity.as_deref() == Some("antigravity-metadata-only") {
            Some("The persisted transcript is missing. Only metadata is available; use an explicit CLI conversation ID to resume.".into())
        } else {
            antigravity_resume_disabled_reason(&root, &external_id)
        }
    } else {
        None
    };
    Ok(Session {
        id: row.get(0)?,
        source_id: row.get(1)?,
        kind,
        external_id: row.get(3)?,
        project_id: row.get(4)?,
        title: row.get(5)?,
        cwd: row.get(6)?,
        updated_at: row.get(7)?,
        time_source: row.get(8)?,
        archived: row.get(9)?,
        parent_id: row.get(10)?,
        partial: row.get(11)?,
        snippet: None,
        trash_identity: Some(hash_id(&[
            &row.get::<_, String>(0)?,
            &row.get::<_, String>(14)?,
        ])),
        resume_disabled_reason,
    })
}

// SQLite's default LIKE folds ASCII only, just like lower()+instr. Each
// connection is newly opened and never changes case_sensitive_like. Escaping
// every LIKE metacharacter makes this a literal substring predicate. Trying LIKE
// first avoids scanning the whole record for an absent original-case match and
// avoids whole-record lower() allocation. LIKE stops at embedded NUL, unlike
// instr, so that uncommon false result explicitly falls back to the original
// expression instead of losing recall.
fn literal_match_sql(column: &str, literal: usize, folded: Option<(usize, usize)>) -> String {
    match folded {
        Some((folded, pattern)) => format!("(CASE WHEN {column} LIKE ?{pattern} ESCAPE '\\' THEN 1 WHEN instr({column},char(0))>0 THEN instr(lower({column}),?{folded})>0 ELSE 0 END)"),
        None => format!("instr({column},?{literal})>0"),
    }
}

fn literal_like_pattern(search: &str) -> String {
    let mut pattern = String::with_capacity(search.len() + 2);
    pattern.push('%');
    for character in search.chars() {
        if matches!(character, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

fn literal_position_sql(column: &str, literal: usize, folded: Option<usize>) -> String {
    match folded {
        Some(folded) => format!("CASE WHEN instr({column},?{literal})>0 THEN instr({column},?{literal}) ELSE instr(lower({column}),?{folded}) END"),
        None => format!("instr({column},?{literal})"),
    }
}

// detail=none stores one posting per document/term, avoiding positional growth
// for repetitive logs. Every sampled three-codepoint window is necessary for a
// true substring match; exact instr then removes disconnected-window matches.
fn trigram_candidates(search: &str) -> String {
    let chars: Vec<char> = search.chars().collect();
    let windows = chars.len() - 2;
    let count = windows.min(32);
    let mut seen = HashSet::new();
    let mut terms = Vec::new();
    for step in 0..count {
        let position = if count == 1 {
            0
        } else {
            step * (windows - 1) / (count - 1)
        };
        let gram: String = chars[position..position + 3].iter().collect();
        if seen.insert(gram.clone()) {
            terms.push(format!("\"{}\"", gram.replace('"', "\"\"")));
        }
    }
    terms.join(" AND ")
}

fn snippet(text: &str, query: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let lowered = text.to_ascii_lowercase();
    let index = if query.is_empty() {
        0
    } else {
        lowered
            .find(&query.to_ascii_lowercase())
            .map(|byte| text[..byte].chars().count())
            .unwrap_or(0)
    };
    let start = index.saturating_sub(50);
    let end = (start + 220).min(chars.len());
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        chars[start..end].iter().collect::<String>(),
        if end < chars.len() { "…" } else { "" }
    )
}

fn bounded_preview(mut text: String) -> (String, bool) {
    if text.len() <= MAX_PREVIEW_MESSAGE_BYTES {
        return (text, false);
    }
    let marker =
        "\n\n[Preview shortened at 64 KiB; open the original transcript for the full message.]";
    let mut end = MAX_PREVIEW_MESSAGE_BYTES - marker.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str(marker);
    (text, true)
}

fn stale_page(message: &str) -> TranscriptPage {
    TranscriptPage {
        messages: vec![],
        has_more: false,
        before_line: None,
        stale: true,
        warning: Some(message.into()),
        snapshot_id: None,
    }
}

#[cfg(not(windows))]
fn file_identity(metadata: &Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        metadata
            .created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos().to_string())
            .unwrap_or_default()
    }
}
// Windows Metadata timestamps are not a file identity. Compare the open handle's
// volume/file ID to the freshly opened path before trusting cached byte locators.
fn handle_identity(file: &File, metadata: &Metadata) -> std::io::Result<String> {
    #[cfg(windows)]
    {
        let _ = metadata;
        crate::windows_fs::identity_from_file(file)
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Ok(file_identity(metadata))
    }
}

fn path_identity(path: &Path, metadata: &Metadata) -> std::io::Result<String> {
    #[cfg(windows)]
    {
        let _ = metadata;
        let file = crate::windows_fs::open_regular_readonly_nofollow(path)?;
        crate::windows_fs::identity_from_file(&file)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(file_identity(metadata))
    }
}

fn modification(metadata: &Metadata) -> String {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_default()
}
fn mtime_rfc3339(metadata: &Metadata) -> String {
    metadata
        .modified()
        .map(|time| DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".into())
}

/// Only the native CLI store has a documented `agy --conversation` launch path.
/// A configured backup is still useful for read-only history, but must never
/// redirect HOME (which also changes credentials/configuration).
pub fn antigravity_resume_disabled_reason(root: &str, id: &str) -> Option<String> {
    if !valid_antigravity_id(id) {
        return Some("The Antigravity conversation ID is not a supported UUID.".into());
    }
    let native = dirs::home_dir()
        .map(|home| providers::definition(AgentKind::Antigravity).state_root(&home));
    let matches = native
        .and_then(|path| fs::canonicalize(path).ok())
        .zip(fs::canonicalize(root).ok())
        .is_some_and(|(native, source)| native == source);
    (!matches).then(|| "This Antigravity source is a read-only backup. Indexed resume requires the current HOME's native ~/.gemini/antigravity-cli store.".into())
}

fn valid_antigravity_id(id: &str) -> bool {
    id.len() == 36
        && uuid::Uuid::parse_str(id)
            .is_ok_and(|value| value.hyphenated().to_string().eq_ignore_ascii_case(id))
}

fn open_transcript(path: &Path, kind: AgentKind) -> std::io::Result<File> {
    #[cfg(windows)]
    {
        let _ = kind;
        crate::windows_fs::open_regular_readonly_nofollow(path)
    }
    #[cfg(not(windows))]
    let mut options = fs::OpenOptions::new();
    #[cfg(not(windows))]
    options.read(true);
    #[cfg(unix)]
    if kind == AgentKind::Antigravity {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = kind;
    #[cfg(not(windows))]
    options.open(path)
}

fn antigravity_path_is_safe(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .zip(fs::canonicalize(root).ok())
        .is_some_and(|(relative, canonical_root)| {
            fs::canonicalize(path).is_ok_and(|canonical| canonical == canonical_root.join(relative))
                && fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
        })
}

fn antigravity_transcript_path(root: &Path, id: &str) -> PathBuf {
    root.join("brain")
        .join(id)
        .join(".system_generated/logs/transcript.jsonl")
}

fn antigravity_transcript_id(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let parts = relative
        .iter()
        .map(|part| part.to_str())
        .collect::<Option<Vec<_>>>()?;
    if parts.len() != 5
        || parts[0] != "brain"
        || !valid_antigravity_id(parts[1])
        || parts[2] != ".system_generated"
        || parts[3] != "logs"
        || !matches!(parts[4], "transcript.jsonl" | "transcript_full.jsonl")
    {
        return None;
    }
    Some(parts[1].to_owned())
}

fn antigravity_seed(
    source: &HistorySource,
    path: &Path,
    metadata: &MetadataIndex,
) -> Result<ParsedState, String> {
    let id = antigravity_transcript_id(Path::new(&source.root), path)
        .ok_or("Unsupported Antigravity transcript path or conversation identity.")?;
    let record = metadata.records.get(&id);
    let mut state = ParsedState {
        external_id: Some(id),
        recognized: true,
        antigravity_metadata_hash: Some(metadata.fingerprint.clone()),
        ..ParsedState::default()
    };
    if let Some(record) = record {
        state.title = record.title.clone();
        state.cwd = record.cwd.clone();
        state.authoritative_cwd = state.cwd.is_some();
        state.antigravity_updated_at = record
            .updated_at
            .as_deref()
            .and_then(adapters::normalized_time);
        state.parent_external = record.parent_id.clone();
        state.child = state.parent_external.is_some();
    } else {
        state.unknown_events += 1;
        state.history_warning = Some("Conversation metadata is unavailable; the directory is unknown and the title may be inferred from visible user text.".into());
    }
    if !metadata.warnings.is_empty() {
        state.unknown_events += 1;
    }
    Ok(state)
}

fn index_antigravity_metadata_only(
    conn: &mut Connection,
    source: &HistorySource,
    path: &str,
    mut state: ParsedState,
    cancel: &AtomicBool,
) -> Result<bool, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("Indexing cancelled.".into());
    }
    state.unknown_events += 1;
    state.history_warning =
        Some("Only metadata is available; the persisted CLI transcript is missing.".into());
    let session_id = session_identity(
        source,
        state
            .external_id
            .as_deref()
            .ok_or("Missing conversation ID.")?,
    );
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let old = load_record(&tx, source, path)?;
    if let Some(old) = &old {
        tx.execute("DELETE FROM messages WHERE file_id=?1", [old.id])
            .map_err(error)?;
    }
    tx.execute("INSERT INTO files(source_id,path,session_id,identity,size,modified,offset,lines,prefix_hash,parser_version,state,archived,trailing_partial) VALUES(?1,?2,?3,'antigravity-metadata-only',0,'',0,0,'',?4,?5,0,1) ON CONFLICT(source_id,path) DO UPDATE SET session_id=excluded.session_id,identity=excluded.identity,size=0,modified='',offset=0,lines=0,prefix_hash='',parser_version=excluded.parser_version,state=excluded.state,archived=0,trailing_partial=1", params![source.id,path,session_id,PARSER_VERSION,serde_json::to_string(&state).map_err(error)?]).map_err(error)?;
    tx.execute(
        "DELETE FROM files WHERE source_id=?1 AND session_id=?2 AND path<>?3",
        params![source.id, session_id, path],
    )
    .map_err(error)?;
    rebuild_session(&tx, source, &session_id)?;
    if let Some(previous) = old
        .and_then(|old| old.session_id)
        .filter(|id| id != &session_id)
    {
        rebuild_session(&tx, source, &previous)?;
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("Indexing cancelled.".into());
    }
    tx.commit().map_err(error)?;
    Ok(true)
}

fn discover(source: &HistorySource, cancel: &AtomicBool) -> (Vec<PathBuf>, SourceHealth, bool) {
    let mut health = SourceHealth {
        source_id: source.id.clone(),
        status: if source.enabled { "ready" } else { "disabled" }.into(),
        message: None,
        files: 0,
    };
    if !source.enabled {
        return (vec![], health, true);
    }
    let provider = providers::definition(source.kind);
    if !provider.history.supported {
        health.status = "unsupported".into();
        health.message = Some(provider.history.description.clone());
        return (vec![], health, true);
    }
    let root = Path::new(&source.root);
    match fs::metadata(root) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            health.status = "missing".into();
            health.message =
                Some("No history directory yet; new sessions can still be started.".into());
            return (vec![], health, true);
        }
        Err(_) => {
            health.status = "error".into();
            health.message = Some(
                "The history directory is not readable. Check its path and permissions.".into(),
            );
            return (vec![], health, false);
        }
        Ok(metadata) if !metadata.is_dir() => {
            health.status = "error".into();
            health.message = Some("The history source root is not a directory.".into());
            return (vec![], health, false);
        }
        _ => {}
    }
    if fs::read_dir(root).is_err() {
        health.status = "error".into();
        health.message = Some("The history directory cannot be listed.".into());
        return (vec![], health, false);
    }
    if source.kind == AgentKind::OpenCode {
        return (vec![root.join("opencode.db")], health, true);
    }
    let directories = match provider.history.parser_id {
        Some(ParserId::Codex) => vec!["sessions", "archived_sessions"],
        Some(ParserId::Claude) => vec!["projects"],
        Some(ParserId::Grok) => vec!["sessions"],
        Some(ParserId::Antigravity) => vec!["brain"],
        Some(ParserId::OpenCode) | None => vec![],
    };
    let mut files = Vec::new();
    let mut complete = true;
    for directory in directories {
        let base = root.join(directory);
        match fs::metadata(&base) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                complete = false;
                continue;
            }
            Ok(metadata) if !metadata.is_dir() => {
                complete = false;
                continue;
            }
            _ => {}
        }
        let max_depth = if provider.history.parser_id == Some(ParserId::Antigravity) {
            4
        } else if provider.history.parser_id == Some(ParserId::Grok) {
            3
        } else {
            usize::MAX
        };
        for (entry_number, entry) in WalkDir::new(&base)
            .follow_links(false)
            .max_open(16)
            .max_depth(max_depth)
            .into_iter()
            .enumerate()
        {
            if source.kind == AgentKind::Antigravity && entry_number >= 100_000 {
                complete = false;
                break;
            }
            if cancel.load(Ordering::Relaxed) {
                complete = false;
                break;
            }
            match entry {
                Ok(entry)
                    if entry.file_type().is_file()
                        && if provider.history.parser_id == Some(ParserId::Grok) {
                            entry.depth() == 3
                                && (entry.file_name() == "updates.jsonl"
                                    || (entry.file_name() == "summary.json"
                                        && !entry.path().with_file_name("updates.jsonl").exists()))
                        } else if provider.history.parser_id == Some(ParserId::Antigravity) {
                            antigravity_transcript_id(root, entry.path()).is_some()
                                && (entry.file_name() == "transcript.jsonl"
                                    || (entry.file_name() == "transcript_full.jsonl"
                                        && !entry
                                            .path()
                                            .with_file_name("transcript.jsonl")
                                            .exists()))
                        } else {
                            entry.path().extension().and_then(|s| s.to_str()) == Some("jsonl")
                        } =>
                {
                    files.push(entry.into_path())
                }
                Ok(entry)
                    if source.kind == AgentKind::Antigravity
                        && matches!(
                            entry.file_name().to_str(),
                            Some("transcript.jsonl" | "transcript_full.jsonl")
                        )
                        && antigravity_transcript_id(root, entry.path()).is_none() =>
                {
                    // A transcript-looking file in an unknown layout is not
                    // evidence of an empty supported history source.
                    complete = false;
                }
                Ok(_) => {}
                Err(_) => complete = false,
            }
        }
    }
    files.sort();
    health.files = files.len();
    if cancel.load(Ordering::Relaxed) {
        health.status = "cancelled".into();
        health.message = Some("Indexing cancelled during source discovery.".into());
    } else if !complete {
        health.status = "error".into();
        health.message=Some("Part of this history source could not be scanned. Cached entries are retained until a complete scan.".into());
    } else if files.is_empty() {
        health.status = "empty".into();
        health.message = Some("No supported JSONL transcripts found.".into());
    }
    (files, health, complete)
}

fn prefix_digest(file: &mut File, len: u64, cancel: &AtomicBool) -> Result<String, String> {
    file.seek(SeekFrom::Start(0)).map_err(error)?;
    let mut hasher = Sha256::new();
    let mut left = len;
    let mut buffer = [0u8; 64 * 1024];
    while left > 0 {
        if cancel.load(Ordering::Relaxed) {
            return Err("Indexing cancelled.".into());
        }
        let want = (left as usize).min(buffer.len());
        let size = file.read(&mut buffer[..want]).map_err(error)?;
        if size == 0 {
            return Err("Transcript changed while verifying its checkpoint.".into());
        }
        hasher.update(&buffer[..size]);
        left -= size as u64;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

// Read a complete physical line with a strict memory cap, even for malformed logs.
fn bounded_line<R: Read>(
    reader: &mut BufReader<R>,
    buffer: &mut Vec<u8>,
    cancel: &AtomicBool,
) -> Result<(u64, bool, bool), String> {
    buffer.clear();
    let mut total = 0u64;
    let mut oversized = false;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Indexing cancelled.".into());
        }
        let chunk = reader.fill_buf().map_err(error)?;
        if chunk.is_empty() {
            return Ok((total, false, oversized));
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(chunk.len(), |position| position + 1);
        total += take as u64;
        if buffer.len() + take <= MAX_LINE_BYTES {
            buffer.extend_from_slice(&chunk[..take]);
        } else {
            oversized = true;
        }
        reader.consume(take);
        if newline.is_some() {
            return Ok((total, true, oversized));
        }
    }
}

fn load_record(
    conn: &Connection,
    source: &HistorySource,
    path: &str,
) -> Result<Option<FileRecord>, String> {
    let row:Option<CheckpointRow>=conn.prepare_cached(
        "SELECT id,session_id,identity,size,modified,offset,lines,prefix_hash,parser_version,state FROM files WHERE source_id=?1 AND path=?2")
        .map_err(error)?.query_row(params![source.id,path],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?))).optional().map_err(error)?;
    row.map(
        |(
            id,
            session_id,
            identity,
            size,
            modified,
            offset,
            lines,
            prefix_hash,
            parser_version,
            state,
        )| {
            Ok(FileRecord {
                id,
                session_id,
                identity,
                size: size as u64,
                modified,
                offset: offset as u64,
                lines: lines as u64,
                prefix_hash,
                parser_version,
                state: serde_json::from_str(&state).map_err(error)?,
            })
        },
    )
    .transpose()
}

// Grok's summary and hashed-cwd marker are independent of updates.jsonl. Hash
// their bounded contents so title/cwd-only edits invalidate the checkpoint too.
fn read_grok_sidecar(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(format!("Cannot read Grok metadata {}.", path.display())),
        Ok(metadata) if !metadata.is_file() => {
            return Err("Grok metadata must be a regular, non-symlink file.".into())
        }
        _ => {}
    }
    let mut file = open_transcript(path, AgentKind::Grok).map_err(error)?;
    let before = file.metadata().map_err(error)?;
    let identity = handle_identity(&file, &before).map_err(error)?;
    if before.len() > MAX_LINE_BYTES as u64 {
        return Err("Grok metadata exceeds the supported size limit.".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_LINE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    let after = file.metadata().map_err(error)?;
    if bytes.len() > MAX_LINE_BYTES
        || before.len() != after.len()
        || modification(&before) != modification(&after)
        || fs::symlink_metadata(path)
            .map(|m| {
                !m.is_file()
                    || !path_identity(path, &m).is_ok_and(|value| value == identity)
                    || modification(&m) != modification(&before)
            })
            .unwrap_or(true)
    {
        return Err("Grok metadata changed during indexing; refresh to retry.".into());
    }
    Ok(Some(bytes))
}

fn decode_grok_cwd(name: &str) -> Option<String> {
    let mut decoded = Vec::with_capacity(name.len());
    let mut input = name.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = char::from(input.next()?).to_digit(16)?;
            let low = char::from(input.next()?).to_digit(16)?;
            decoded.push((high * 16 + low) as u8);
        } else {
            decoded.push(byte);
        }
    }
    String::from_utf8(decoded)
        .ok()
        .filter(|cwd| Path::new(cwd).is_absolute() && !cwd.contains('\0'))
}

fn grok_metadata(path: &Path) -> Result<ParsedState, String> {
    let session_dir = path.parent().ok_or("Invalid Grok session directory.")?;
    let cwd_dir = session_dir
        .parent()
        .ok_or("Invalid Grok workspace directory.")?;
    let summary_bytes = read_grok_sidecar(&session_dir.join("summary.json"))?;
    let cwd_bytes = read_grok_sidecar(&cwd_dir.join(".cwd"))?;
    let mut digest = Sha256::new();
    for bytes in [&summary_bytes, &cwd_bytes] {
        digest.update([u8::from(bytes.is_some())]);
        if let Some(bytes) = bytes {
            digest.update((bytes.len() as u64).to_le_bytes());
            digest.update(bytes);
        }
    }
    let cwd = cwd_dir
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(decode_grok_cwd)
        .or_else(|| {
            cwd_bytes
                .as_ref()
                .and_then(|bytes| std::str::from_utf8(bytes).ok())
                .map(str::trim)
                .filter(|cwd| Path::new(cwd).is_absolute() && !cwd.contains('\0'))
                .map(str::to_owned)
        });
    let mut state = ParsedState {
        external_id: Some(adapters::fallback_id(path, AgentKind::Grok)),
        cwd: cwd.clone(),
        recognized: true,
        grok_metadata_hash: Some(format!("{:x}", digest.finalize())),
        ..ParsedState::default()
    };
    match summary_bytes
        .as_ref()
        .and_then(|bytes| serde_json::from_slice(bytes).ok())
    {
        Some(summary) => adapters::apply_grok_summary(&mut state, &summary, cwd),
        None => state.bad_lines += 1,
    }
    if path.file_name().is_some_and(|name| name == "summary.json")
        && state.grok_num_messages.unwrap_or(0) > 0
    {
        state.bad_lines += 1; // The summary advertises messages, but the durable stream is absent.
    }
    Ok(state)
}

struct GrokAppend {
    line: u64,
    byte_offset: u64,
    byte_len: u64,
    text: String,
}

// Updating the external-content FTS trigger once per token is quadratic. Buffer
// only the current bounded logical span, then update its row once per scan/run.
fn flush_grok_append(
    conn: &Connection,
    file_id: i64,
    pending: &mut Option<GrokAppend>,
) -> Result<(), String> {
    if let Some(append) = pending.take() {
        conn.execute("UPDATE messages SET byte_len=?1,search_text=search_text||?2 WHERE file_id=?3 AND line=?4", params![append.byte_len as i64,append.text,file_id,append.line as i64]).map_err(error)?;
    }
    Ok(())
}

fn index_file(
    conn: &mut Connection,
    source: &HistorySource,
    path: &Path,
    cancel: &AtomicBool,
    ag_metadata: Option<&MetadataIndex>,
) -> Result<bool, String> {
    let path_string = path
        .to_str()
        .ok_or("Transcript paths must be valid UTF-8.")?;
    let ag_seed = if source.kind == AgentKind::Antigravity {
        Some(antigravity_seed(
            source,
            path,
            ag_metadata.ok_or("Antigravity metadata was not checked.")?,
        )?)
    } else {
        None
    };
    let old = load_record(conn, source, path_string)?;
    let mut file = match open_transcript(path, source.kind) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound && ag_seed.is_some() => {
            return index_antigravity_metadata_only(
                conn,
                source,
                path_string,
                ag_seed.unwrap(),
                cancel,
            );
        }
        Err(_) => return Err(format!("Cannot read transcript {}.", path.display())),
    };
    let metadata = file.metadata().map_err(error)?;
    if !metadata.is_file() {
        return Err("Transcript is not a regular file.".into());
    }
    if source.kind == AgentKind::Antigravity
        && !antigravity_path_is_safe(Path::new(&source.root), path)
    {
        return Err(
            "Antigravity transcript must remain in its exact non-symlink brain layout.".into(),
        );
    }
    let identity = handle_identity(&file, &metadata).map_err(error)?;
    let modified = modification(&metadata);
    let size = metadata.len();
    if source.kind == AgentKind::Antigravity && size > 128 * 1024 * 1024 {
        return Err("Antigravity transcript exceeds the 128 MiB read limit.".into());
    }
    let grok = if source.kind == AgentKind::Grok {
        Some(grok_metadata(path)?)
    } else {
        None
    };
    let metadata_matches = old.as_ref().is_none_or(|old| {
        old.state.antigravity_metadata_hash
            == ag_seed
                .as_ref()
                .and_then(|state| state.antigravity_metadata_hash.clone())
            && old.state.grok_metadata_hash
                == grok
                    .as_ref()
                    .and_then(|state| state.grok_metadata_hash.clone())
    });
    let summary_only = source.kind == AgentKind::Grok
        && path.file_name().is_some_and(|name| name == "summary.json");
    if let Some(old) = &old {
        if metadata_matches
            && old.identity == identity
            && old.size == size
            && old.modified == modified
            && old.parser_version == PARSER_VERSION
            && (source.kind != AgentKind::Antigravity
                || (old.offset == size
                    && prefix_digest(&mut file, old.offset, cancel)? == old.prefix_hash))
        {
            return Ok(old.state.bad_lines > 0
                || old.state.unknown_events > 0
                || old.offset < size);
        }
    }
    let ag_initial_hash = if source.kind == AgentKind::Antigravity {
        Some(prefix_digest(&mut file, size, cancel)?)
    } else {
        None
    };
    let incremental = if let Some(old) = &old {
        metadata_matches
            && source.kind != AgentKind::Antigravity
            && !summary_only
            && old.identity == identity
            && old.offset <= size
            && old.parser_version == PARSER_VERSION
            && prefix_digest(&mut file, old.offset, cancel)? == old.prefix_hash
    } else {
        false
    };
    let mut state = if incremental {
        old.as_ref().unwrap().state.clone()
    } else {
        ag_seed.or(grok).unwrap_or_default()
    };
    let mut offset = if incremental {
        old.as_ref().unwrap().offset
    } else {
        0
    };
    let mut lines = if incremental {
        old.as_ref().unwrap().lines
    } else {
        0
    };
    if summary_only {
        offset = size;
    }
    let archived = path
        .strip_prefix(&source.root)
        .ok()
        .is_some_and(|relative| {
            relative
                .components()
                .any(|c| c.as_os_str() == "archived_sessions")
        });
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let file_id = if let Some(old) = &old {
        if !incremental {
            tx.execute("DELETE FROM messages WHERE file_id=?1", [old.id])
                .map_err(error)?;
        }
        old.id
    } else {
        tx.execute("INSERT INTO files(source_id,path,identity,size,modified,offset,lines,prefix_hash,parser_version,state,archived) VALUES(?1,?2,?3,0,'',0,0,'',?4,'{}',?5)",params![source.id,path_string,identity,PARSER_VERSION,archived]).map_err(error)?;
        tx.last_insert_rowid()
    };
    file.seek(SeekFrom::Start(offset)).map_err(error)?;
    let read_limit = if source.kind == AgentKind::Antigravity {
        size.saturating_sub(offset)
    } else {
        u64::MAX
    };
    let mut reader = BufReader::with_capacity(64 * 1024, file.take(read_limit));
    let mut buffer = Vec::new();
    let mut grok_append: Option<GrokAppend> = None;
    let mut ag_steps: HashMap<u64, String> = HashMap::new();
    let mut ag_conflicts = HashSet::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Indexing cancelled.".into());
        }
        let (length, complete, oversized) = bounded_line(&mut reader, &mut buffer, cancel)?;
        if length == 0 || !complete {
            break;
        }
        lines += 1;
        let line_offset = offset;
        offset += length;
        let mut stored_line = lines;
        let mut placeholder = None;
        let mut role = "system".to_owned();
        let mut timestamp = None;
        let mut search = String::new();
        let mut fallback = false;
        let mut store = true;
        let mut grok_prompt_index = None;
        let mut grok_text_chunk = false;
        if oversized {
            adapters::grok_end_user_run(&mut state);
            state.bad_lines += 1;
            placeholder = Some("[Oversized JSON record omitted]".to_owned());
        } else if buffer.iter().all(u8::is_ascii_whitespace) {
            adapters::grok_end_user_run(&mut state);
            store = false;
        } else {
            match serde_json::from_slice::<serde_json::Value>(&buffer) {
                Ok(value) => {
                    if source.kind == AgentKind::Antigravity {
                        match crate::antigravity::parse_step(&value) {
                            Ok(step) => {
                                stored_line = step.index + 1;
                                let digest = hash_id(&[&value.to_string()]);
                                if step.cleared || ag_conflicts.contains(&stored_line) {
                                    ag_conflicts.insert(stored_line);
                                    tx.execute(
                                        "DELETE FROM messages WHERE file_id=?1 AND line=?2",
                                        params![file_id, stored_line as i64],
                                    )
                                    .map_err(error)?;
                                    if step.cleared {
                                        state.unknown_events += 1;
                                    }
                                    continue;
                                }
                                if let Some(previous) = ag_steps.get(&stored_line) {
                                    if previous != &digest {
                                        ag_conflicts.insert(stored_line);
                                        state.unknown_events += 1;
                                        tx.execute(
                                            "DELETE FROM messages WHERE file_id=?1 AND line=?2",
                                            params![file_id, stored_line as i64],
                                        )
                                        .map_err(error)?;
                                    }
                                    continue;
                                }
                                ag_steps.insert(stored_line, digest);
                            }
                            Err(_) => {
                                state.unknown_events += 1;
                                if let Some(index) = value
                                    .get("step_index")
                                    .and_then(serde_json::Value::as_u64)
                                    .filter(|index| *index < i64::MAX as u64)
                                {
                                    ag_conflicts.insert(index + 1);
                                    tx.execute(
                                        "DELETE FROM messages WHERE file_id=?1 AND line=?2",
                                        params![file_id, (index + 1) as i64],
                                    )
                                    .map_err(error)?;
                                }
                                continue;
                            }
                        }
                    }
                    if let Some(message) =
                        adapters::parse_value(source.kind, &value, &mut state, path)
                    {
                        role = message.role.clone();
                        grok_text_chunk = source.kind == AgentKind::Grok && message.searchable;
                        timestamp = message.timestamp.clone();
                        fallback = message.fallback;
                        search = adapters::search_text(&value, source.kind, &message);
                        // Only bounded locator metadata and searchable prose are persisted.
                        if !message.searchable {
                            placeholder = Some(message.text);
                        }
                    } else {
                        store = false;
                    }
                    if source.kind == AgentKind::Grok {
                        grok_prompt_index = value
                            .get("params")
                            .unwrap_or(&value)
                            .pointer("/update/_meta/promptIndex")
                            .and_then(serde_json::Value::as_u64);
                        if let Some(boundary) = adapters::grok_timeline(&value, &mut state, lines) {
                            tx.execute(
                                "DELETE FROM messages WHERE file_id=?1 AND line>=?2",
                                params![file_id, boundary as i64],
                            )
                            .map_err(error)?;
                            state.first_user = tx.query_row("SELECT search_text FROM messages WHERE file_id=?1 AND role='user' AND search_text<>'' ORDER BY line LIMIT 1", [file_id], |row| row.get::<_, String>(0))
                                .optional().map_err(error)?.map(|text| adapters::short_text(&text, 100));
                        }
                    }
                }
                Err(_) => {
                    adapters::grok_end_user_run(&mut state);
                    state.bad_lines += 1;
                    placeholder = Some("[Malformed JSON record]".to_owned());
                }
            }
        }
        if source.kind == AgentKind::Grok {
            if store
                && placeholder.is_none()
                && grok_text_chunk
                && matches!(role.as_str(), "user" | "assistant")
            {
                let merge_start = state
                    .grok_message_run
                    .as_ref()
                    .filter(|run| {
                        run.last_line.checked_add(1) == Some(lines)
                            && run.role == role
                            && run.prompt_index == grok_prompt_index
                    })
                    .map(|run| run.start_line);
                if grok_append.as_ref().map(|pending| pending.line) != merge_start {
                    flush_grok_append(&tx, file_id, &mut grok_append)?;
                }
                let mut start_line = lines;
                if let Some(start) = merge_start {
                    let start_offset = if let Some(pending) = &grok_append {
                        Some(pending.byte_offset)
                    } else {
                        tx.query_row(
                            "SELECT byte_offset FROM messages WHERE file_id=?1 AND line=?2",
                            params![file_id, start as i64],
                            |row| row.get::<_, i64>(0).map(|value| value as u64),
                        )
                        .optional()
                        .map_err(error)?
                    };
                    if let Some(start_offset) = start_offset {
                        let span_len = offset - start_offset;
                        if span_len <= MAX_LINE_BYTES as u64 {
                            let pending = grok_append.get_or_insert_with(|| GrokAppend {
                                line: start,
                                byte_offset: start_offset,
                                byte_len: span_len,
                                text: String::new(),
                            });
                            pending.byte_len = span_len;
                            pending.text.push_str(&search);
                            start_line = start;
                            store = false;
                        } else {
                            flush_grok_append(&tx, file_id, &mut grok_append)?;
                        }
                    }
                }
                if search.is_empty() && start_line == lines {
                    // Do not create an empty preview bubble. A subsequent text
                    // chunk can begin the span; rewind still uses the user run.
                    state.grok_message_run = None;
                    store = false;
                } else {
                    state.grok_message_run = Some(adapters::GrokMessageRun {
                        start_line,
                        last_line: lines,
                        role: role.clone(),
                        prompt_index: grok_prompt_index,
                    });
                }
            } else {
                flush_grok_append(&tx, file_id, &mut grok_append)?;
                state.grok_message_run = None;
            }
        }
        if source.kind == AgentKind::Antigravity && placeholder.is_some() {
            store = false;
        }
        if store {
            tx.prepare_cached("INSERT INTO messages(file_id,line,byte_offset,byte_len,role,timestamp,search_text,fallback,hidden,placeholder) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,?9) ON CONFLICT(file_id,line) DO UPDATE SET byte_offset=excluded.byte_offset,byte_len=excluded.byte_len,role=excluded.role,timestamp=excluded.timestamp,search_text=excluded.search_text,fallback=excluded.fallback,hidden=0,placeholder=excluded.placeholder").map_err(error)?.execute(params![file_id,stored_line as i64,line_offset as i64,length as i64,role,timestamp,search,fallback,placeholder]).map_err(error)?;
        }
    }
    flush_grok_append(&tx, file_id, &mut grok_append)?;
    let mut file = reader.into_inner().into_inner();
    let after = file.metadata().map_err(error)?;
    // Writers may append during a scan. Retry instead of committing inconsistent locators.
    if after.len() != size || modification(&after) != modified {
        return Err("Transcript changed during indexing; refresh to retry.".into());
    }
    let prefix_hash = prefix_digest(&mut file, offset, cancel)?;
    if let Some(expected) = ag_initial_hash {
        if prefix_digest(&mut file, size, cancel)? != expected {
            return Err(
                "Antigravity transcript contents changed during indexing; refresh to retry.".into(),
            );
        }
    }
    let verified = file.metadata().map_err(error)?;
    let path_still_matches = fs::metadata(path)
        .map(|m| {
            path_identity(path, &m).is_ok_and(|value| value == identity)
                && m.len() == size
                && modification(&m) == modified
        })
        .unwrap_or(false);
    if !path_still_matches || verified.len() != size || modification(&verified) != modified {
        return Err("Transcript changed while verifying its checkpoint; refresh to retry.".into());
    }
    if source.kind == AgentKind::Grok {
        if grok_metadata(path)?.grok_metadata_hash != state.grok_metadata_hash {
            return Err("Grok metadata changed during indexing; refresh to retry.".into());
        }
        state.first_user = tx.query_row("SELECT search_text FROM messages WHERE file_id=?1 AND role='user' AND search_text<>'' ORDER BY line LIMIT 1", [file_id], |row| row.get::<_,String>(0)).optional().map_err(error)?.map(|text| adapters::short_text(&text, 100));
    }
    if source.kind == AgentKind::Antigravity {
        if lines == 0 {
            state.unknown_events += 1;
            state.history_warning = Some(
                "The persisted Antigravity transcript is empty or has no complete records yet."
                    .into(),
            );
        }
        state.first_user = tx.query_row("SELECT search_text FROM messages WHERE file_id=?1 AND role='user' AND search_text<>'' ORDER BY line LIMIT 1", [file_id], |row| row.get::<_,String>(0)).optional().map_err(error)?.map(|text| adapters::short_text(&text, 100));
    }
    let session_id = if state.recognized {
        if state.external_id.is_none() {
            state.external_id = Some(adapters::fallback_id(path, source.kind));
        }
        Some(session_identity(
            source,
            state.external_id.as_deref().unwrap(),
        ))
    } else {
        None
    };
    tx.execute("UPDATE files SET session_id=?1,identity=?2,size=?3,modified=?4,offset=?5,lines=?6,prefix_hash=?7,parser_version=?8,state=?9,archived=?10,trailing_partial=?11 WHERE id=?12",
        params![session_id,identity,size as i64,modified,offset as i64,lines as i64,prefix_hash,PARSER_VERSION,serde_json::to_string(&state).map_err(error)?,archived,offset<size,file_id]).map_err(error)?;
    reconcile_fallback_messages(&tx, file_id, cancel)?;
    if let Some(id) = &session_id {
        if source.kind == AgentKind::Antigravity {
            // Transcript/metadata-only transitions are one atomic replacement, so concurrent
            // previews cannot select the stale sibling before source reconciliation.
            tx.execute(
                "DELETE FROM files WHERE source_id=?1 AND session_id=?2 AND id<>?3",
                params![source.id, id, file_id],
            )
            .map_err(error)?;
        }
        rebuild_session(&tx, source, id)?;
    }
    if let Some(old_id) = old
        .as_ref()
        .and_then(|old| old.session_id.as_ref())
        .filter(|id| Some(*id) != session_id.as_ref())
    {
        rebuild_session(&tx, source, old_id)?;
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("Indexing cancelled.".into());
    }
    tx.commit().map_err(error)?;
    Ok(state.bad_lines > 0 || state.unknown_events > 0 || offset < size)
}

// Some Codex versions repeat messages in event_msg and response_item records.
// The previous correlated lookup scanned all canonical rows for every fallback.
// A temporary digest index avoids quadratic scans without duplicating prose or
// trusting hashes as equality: the final predicate still compares exact text.
fn reconcile_fallback_messages(
    conn: &Connection,
    file_id: i64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let has_fallback: bool = conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM messages WHERE file_id=?1 AND fallback=1)")
        .map_err(error)?
        .query_row([file_id], |row| row.get(0))
        .map_err(error)?;
    if !has_fallback {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS message_dedup(
            message_rowid INTEGER PRIMARY KEY, digest BLOB NOT NULL,
            role TEXT NOT NULL, fallback INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS temp.message_dedup_lookup ON message_dedup(digest,role,fallback);
         DELETE FROM temp.message_dedup;",
    ).map_err(error)?;
    let mut read = conn
        .prepare_cached("SELECT rowid,role,search_text,fallback FROM messages WHERE file_id=?1")
        .map_err(error)?;
    let mut rows = read.query([file_id]).map_err(error)?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO temp.message_dedup(message_rowid,digest,role,fallback) VALUES(?1,?2,?3,?4)"
    ).map_err(error)?;
    while let Some(row) = rows.next().map_err(error)? {
        if cancel.load(Ordering::Relaxed) {
            return Err("Indexing cancelled.".into());
        }
        let text: String = row.get(2).map_err(error)?;
        let digest = Sha256::digest(text.as_bytes());
        insert
            .execute(params![
                row.get::<_, i64>(0).map_err(error)?,
                digest.as_slice(),
                row.get::<_, String>(1).map_err(error)?,
                row.get::<_, bool>(3).map_err(error)?
            ])
            .map_err(error)?;
    }
    drop(rows);
    drop(read);
    drop(insert);
    if cancel.load(Ordering::Relaxed) {
        return Err("Indexing cancelled.".into());
    }
    apply_fallback_visibility(conn, file_id)?;
    if cancel.load(Ordering::Relaxed) {
        return Err("Indexing cancelled.".into());
    }
    Ok(())
}

fn apply_fallback_visibility(conn: &Connection, file_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE messages AS target SET hidden=CASE WHEN target.search_text<>'' AND EXISTS(
            SELECT 1 FROM temp.message_dedup original
            JOIN temp.message_dedup candidate ON candidate.digest=original.digest
                AND candidate.role=original.role AND candidate.fallback=0
            JOIN messages canonical ON canonical.rowid=candidate.message_rowid
            WHERE original.message_rowid=target.rowid
                AND canonical.file_id=target.file_id
                AND canonical.role=target.role
                AND canonical.search_text=target.search_text
        ) THEN 1 ELSE 0 END WHERE file_id=?1 AND fallback=1",
        [file_id],
    )
    .map_err(error)?;
    Ok(())
}

fn refresh_source_titles(
    conn: &mut Connection,
    source: &HistorySource,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if source.kind != AgentKind::Codex {
        return Ok(());
    }
    let names = adapters::source_titles(source.kind, Path::new(&source.root))?;
    // Cached parser state restores the fallback when a source name is removed.
    // This also observes renames when every transcript is otherwise unchanged.
    // Acquire the writer before reading cached title state, matching indexing
    // and curation transactions and avoiding a read-to-write WAL upgrade.
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let sessions = tx
        .prepare(
            "SELECT s.id,s.external_id,s.title,f.state FROM sessions s JOIN files f ON f.id=(
                SELECT id FROM files WHERE session_id=s.id ORDER BY archived ASC,modified DESC,path LIMIT 1
            ) WHERE s.source_id=?1",
        )
        .map_err(error)?
        .query_map([&source.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error)?;
    for (id, external_id, previous, json) in sessions {
        if cancel.load(Ordering::Relaxed) {
            return Err("Indexing cancelled.".into());
        }
        let state = serde_json::from_str::<ParsedState>(&json).map_err(error)?;
        let title = names
            .get(&external_id)
            .cloned()
            .unwrap_or_else(|| adapters::display_title(&state, source.kind, &external_id));
        if title != previous {
            tx.execute(
                "UPDATE sessions SET title=?1 WHERE id=?2",
                params![title, id],
            )
            .map_err(error)?;
        }
    }
    tx.commit().map_err(error)
}

fn rebuild_session(conn: &Connection, source: &HistorySource, id: &str) -> Result<(), String> {
    let files=conn.prepare("SELECT path,state,archived,trailing_partial FROM files WHERE session_id=?1 ORDER BY archived ASC,modified DESC,path").map_err(error)?.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,bool>(2)?,r.get::<_,bool>(3)?))).map_err(error)?.collect::<Result<Vec<_>,_>>().map_err(error)?;
    if files.is_empty() {
        conn.execute("DELETE FROM sessions WHERE id=?1", [id])
            .map_err(error)?;
        return Ok(());
    }
    let mut states = Vec::new();
    for (path, json, archived, trailing) in &files {
        states.push((
            path,
            serde_json::from_str::<ParsedState>(json).map_err(error)?,
            *archived,
            *trailing,
        ));
    }
    let primary = &states[0].1;
    let external_id = primary
        .external_id
        .as_deref()
        .ok_or("Transcript has no session identity.")?;
    let cwd = primary
        .cwd
        .as_deref()
        .filter(|cwd| Path::new(cwd).is_absolute());
    let project_id = ensure_project(conn, cwd, false)?;
    let event_at = states
        .iter()
        .filter_map(|(_, state, _, _)| {
            state
                .antigravity_updated_at
                .as_ref()
                .or(state.grok_summary_at.as_ref())
                .or(state.event_at.as_ref())
        })
        .max()
        .cloned();
    let (updated_at, time_source) = match event_at {
        Some(time) => (time, "event"),
        None => {
            let fallback = states
                .iter()
                .filter_map(|(path, _, _, _)| fs::metadata(path).ok().map(|m| mtime_rfc3339(&m)))
                .max()
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());
            (fallback, "mtime")
        }
    };
    let title = adapters::display_title(primary, source.kind, external_id);
    let parent = primary
        .parent_external
        .as_ref()
        .map(|parent| session_identity(source, parent));
    let archived = states.iter().all(|(_, _, archived, _)| *archived);
    let partial = states.len() > 1
        || states.iter().any(|(_, state, _, trailing)| {
            *trailing || state.bad_lines > 0 || state.unknown_events > 0
        });
    conn.execute("INSERT INTO sessions(id,source_id,kind,external_id,project_id,title,cwd,updated_at,time_source,archived,parent_id,child,partial)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
        ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,title=excluded.title,cwd=excluded.cwd,updated_at=excluded.updated_at,time_source=excluded.time_source,archived=excluded.archived,parent_id=excluded.parent_id,child=excluded.child,partial=excluded.partial",
        params![id,source.id,source.kind.as_str(),external_id,project_id,title,primary.cwd,updated_at,time_source,archived,parent,primary.child,partial]).map_err(error)?;
    Ok(())
}

fn index_opencode(
    conn: &mut Connection,
    source: &HistorySource,
    cancel: &AtomicBool,
) -> Result<SourceHealth, String> {
    let opencode_parser_version = PARSER_VERSION * 100 + crate::opencode::READER_REVISION;
    let database = Path::new(&source.root).join("opencode.db");
    let prefix = format!("{}#", database.display());
    // Per-session fingerprints from the last committed index. Sessions whose
    // fingerprint is unchanged are not re-read; a reader upgrade (parser
    // version) re-reads everything.
    let known: HashMap<String, String> = conn
        .prepare("SELECT path,prefix_hash FROM files WHERE source_id=?1 AND parser_version=?2")
        .map_err(error)?
        .query_map(params![source.id, opencode_parser_version], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(error)?
        .filter_map(|row| {
            row.ok()
                .and_then(|(path, hash)| path.strip_prefix(&prefix).map(|id| (id.to_owned(), hash)))
        })
        .collect();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let mut seen = HashSet::new();
    let mut sessions = 0usize;
    let summary = crate::opencode::read_sessions(
        Path::new(&source.root),
        cancel,
        &known,
        &mut |record| {
            if cancel.load(Ordering::Relaxed) {
                return Err("Indexing cancelled".into());
            }
            sessions += 1;
            let id = session_identity(source, &record.id);
            // Logical per-session records share one physical SQLite database.
            // This path is only a catalog key; it is never opened as a file.
            let path = format!("{prefix}{}", record.id);
            seen.insert(path.clone());
            if record.unchanged {
                return Ok(());
            }
            let state = ParsedState {
                external_id: Some(record.id.clone()),
                cwd: record.cwd.clone(),
                title: record.title.clone(),
                event_at: record.updated_at.clone(),
                parent_external: record.parent_id.clone(),
                child: record.parent_id.is_some(),
                recognized: true,
                authoritative_cwd: true,
                unknown_events: u64::from(record.partial),
                ..Default::default()
            };
            tx.execute("INSERT INTO files(source_id,path,session_id,identity,size,modified,offset,lines,prefix_hash,parser_version,state,archived,trailing_partial) VALUES(?1,?2,?3,?10,0,'',0,?4,?5,?6,?7,?8,?9) ON CONFLICT(source_id,path) DO UPDATE SET session_id=excluded.session_id,identity=excluded.identity,lines=excluded.lines,prefix_hash=excluded.prefix_hash,parser_version=excluded.parser_version,state=excluded.state,archived=excluded.archived,trailing_partial=excluded.trailing_partial", params![source.id,path,id,record.messages.len(),record.fingerprint,opencode_parser_version,serde_json::to_string(&state).map_err(error)?,record.archived,record.partial,record.identity]).map_err(error)?;
            let file_id: i64 = tx
                .query_row(
                    "SELECT id FROM files WHERE source_id=?1 AND path=?2",
                    params![source.id, path],
                    |row| row.get(0),
                )
                .map_err(error)?;
            tx.execute("DELETE FROM messages WHERE file_id=?1", [file_id])
                .map_err(error)?;
            let mut insert = tx.prepare_cached("INSERT INTO messages(file_id,line,byte_offset,byte_len,role,timestamp,search_text) VALUES(?1,?2,0,0,?3,?4,?5)").map_err(error)?;
            for (line, message) in record.messages.iter().enumerate() {
                insert
                    .execute(params![
                        file_id,
                        line + 1,
                        message.role,
                        message.timestamp,
                        message.text
                    ])
                    .map_err(error)?;
            }
            rebuild_session(&tx, source, &id)
        },
    )?;
    let old = tx
        .prepare("SELECT id,path,session_id FROM files WHERE source_id=?1")
        .map_err(error)?
        .query_map([&source.id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error)?;
    for (id, path, session) in old {
        if !seen.contains(&path) {
            tx.execute("DELETE FROM files WHERE id=?1", [id])
                .map_err(error)?;
            rebuild_session(&tx, source, &session)?;
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("Indexing cancelled".into());
    }
    let mut warnings = summary.warnings;
    // Unchanged sessions were not re-read; keep reporting their partial state.
    let partial: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM files WHERE source_id=?1 AND trailing_partial=1)",
            [&source.id],
            |row| row.get(0),
        )
        .map_err(error)?;
    if partial
        && !warnings
            .iter()
            .any(|w| w == crate::opencode::PARTIAL_WARNING)
    {
        warnings.push(crate::opencode::PARTIAL_WARNING.into());
    }
    tx.commit().map_err(error)?;
    Ok(SourceHealth {
        source_id: source.id.clone(),
        status: if warnings.is_empty() {
            if sessions == 0 {
                "empty"
            } else {
                "ready"
            }
        } else {
            "partial"
        }
        .into(),
        files: sessions,
        message: (!warnings.is_empty()).then(|| warnings.join(" ")),
    })
}

fn opencode_transcript(
    conn: &Connection,
    session: &Session,
    file_id: i64,
    expected: &str,
    before: Option<u64>,
    limit: usize,
    snapshot_id: Option<String>,
) -> Result<TranscriptPage, String> {
    let root: String = conn
        .query_row(
            "SELECT root FROM sources WHERE id=?1",
            [&session.source_id],
            |row| row.get(0),
        )
        .map_err(error)?;
    // Verifies only this session's fingerprint against the refreshed mirror;
    // other sessions changing no longer makes this preview stale.
    let current = crate::opencode::session_fingerprint(Path::new(&root), &session.external_id);
    if !current.is_ok_and(|fingerprint| fingerprint.as_deref() == Some(expected)) {
        return Ok(stale_page("OpenCode database or WAL changed or cannot be verified. Refresh before loading the transcript."));
    }
    let limit = limit.clamp(1, 200);
    let mut messages = conn.prepare("SELECT role,search_text,timestamp,line FROM messages WHERE file_id=?1 AND line<?2 ORDER BY line DESC LIMIT ?3").map_err(error)?.query_map(params![file_id,before.unwrap_or(i64::MAX as u64).min(i64::MAX as u64) as i64,limit+1], |row| Ok(TranscriptMessage { role: row.get(0)?, text: row.get(1)?, timestamp: row.get(2)?, line: row.get(3)? })).map_err(error)?.collect::<Result<Vec<_>,_>>().map_err(error)?;
    let mut has_more = messages.len() > limit;
    messages.truncate(limit);
    let mut bytes = 0;
    let mut retained = Vec::new();
    for mut message in messages {
        if message.text.len() > MAX_PREVIEW_MESSAGE_BYTES {
            let mut end = MAX_PREVIEW_MESSAGE_BYTES;
            while !message.text.is_char_boundary(end) {
                end -= 1;
            }
            message.text.truncate(end);
            message
                .text
                .push_str("\n[Preview shortened; complete supported text remains searchable.]");
        }
        if !retained.is_empty() && bytes + message.text.len() > MAX_PREVIEW_PAGE_BYTES {
            has_more = true;
            break;
        }
        bytes += message.text.len();
        retained.push(message);
    }
    retained.reverse();
    Ok(TranscriptPage { before_line: retained.first().map(|m| m.line), messages: retained, has_more, stale: false, snapshot_id, warning: session.partial.then(|| "OpenCode history contains incomplete, reverted, or unsupported records. Only verified user/assistant text is shown.".into()) })
}

#[cfg(test)]
mod dedup_tests {
    use super::*;

    #[test]
    fn cancelled_digest_pass_rolls_back_and_can_retry() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE messages(file_id INTEGER,role TEXT,search_text TEXT,fallback INTEGER,hidden INTEGER);
            CREATE TABLE checkpoint(offset INTEGER);
            INSERT INTO checkpoint VALUES(1);
            INSERT INTO messages VALUES(1,'user','same',1,0);").unwrap();
        {
            let tx = conn.transaction().unwrap();
            tx.execute("UPDATE checkpoint SET offset=2", []).unwrap();
            tx.execute("INSERT INTO messages VALUES(1,'user','same',0,0)", [])
                .unwrap();
            let error = reconcile_fallback_messages(&tx, 1, &AtomicBool::new(true)).unwrap_err();
            assert_eq!(error, "Indexing cancelled.");
            // Dropping the file transaction must undo both checkpoint and rows.
        }
        assert_eq!(
            conn.query_row("SELECT offset FROM checkpoint", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM messages", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let tx = conn.transaction().unwrap();
        tx.execute("INSERT INTO messages VALUES(1,'user','same',0,0)", [])
            .unwrap();
        reconcile_fallback_messages(&tx, 1, &AtomicBool::new(false)).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            conn.query_row("SELECT SUM(hidden) FROM messages", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn digest_candidates_still_require_exact_text_role_and_file() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE messages(file_id INTEGER,line INTEGER,role TEXT,search_text TEXT,fallback INTEGER,hidden INTEGER);
            CREATE TEMP TABLE message_dedup(message_rowid INTEGER PRIMARY KEY,digest BLOB,role TEXT,fallback INTEGER);
            CREATE INDEX temp.message_dedup_lookup ON message_dedup(digest,role,fallback);
            INSERT INTO messages VALUES
                (1,1,'user','match',1,0),
                (1,2,'user','match',0,0),
                (1,3,'user','different',1,0),
                (1,4,'user','other',0,0),
                (1,5,'assistant','match',1,0),
                (1,6,'user','',1,1),
                (1,7,'user','',0,0),
                (2,1,'user','different',0,0);
            INSERT INTO temp.message_dedup SELECT rowid,x'00',role,fallback FROM messages;").unwrap();
        // Deliberately force every digest to collide, including another file.
        apply_fallback_visibility(&conn, 1).unwrap();
        let hidden: Vec<i64> = conn
            .prepare("SELECT hidden FROM messages ORDER BY rowid")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(hidden, vec![1, 0, 0, 0, 0, 0, 0, 0]);
    }
}

fn read_revision(conn: &Connection) -> Result<u64, String> {
    conn.query_row(
        "SELECT revision FROM catalog_revision WHERE id=1",
        [],
        |row| row.get(0),
    )
    .map_err(error)
}

#[cfg(test)]
mod revision_snapshot_tests {
    use super::*;

    #[test]
    fn launch_revision_reservation_blocks_catalog_commit_until_admission_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.sqlite");
        let catalog = Catalog::open(&path).unwrap();
        let writer = Connection::open(&path).unwrap();
        writer.busy_timeout(Duration::ZERO).unwrap();
        let revision = catalog.revision().unwrap();
        catalog
            .with_launch_revision(|observed| {
                assert_eq!(observed, revision);
                let error = writer
                    .execute("INSERT INTO projects(id,name) VALUES('p','Synthetic')", [])
                    .unwrap_err();
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy)
                );
                // Existing planning readers remain usable while writer admission is reserved.
                assert!(catalog.projects()?.is_empty());
                Ok(())
            })
            .unwrap();
        writer
            .execute("INSERT INTO projects(id,name) VALUES('p','Synthetic')", [])
            .unwrap();
        assert!(catalog.revision().unwrap() > revision);
    }

    #[test]
    fn batch_revision_count_and_rows_share_one_snapshot_without_blocking_a_writer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.sqlite");
        let catalog = Catalog::open(&path).unwrap();
        let writer = Connection::open(&path).unwrap();
        let before = catalog.revision().unwrap().to_string();
        let page = catalog.query_observed(&SessionQuery::default(), |phase| {
            if phase == "connect" {
                // Commits after the reader captured its revision, before COUNT.
                writer.execute_batch("INSERT INTO sources VALUES('s','codex','synthetic',1,'synthetic');
                    INSERT INTO projects(id,name) VALUES('p','Synthetic');
                    INSERT INTO sessions(id,source_id,kind,external_id,project_id,title,updated_at,time_source,archived,partial)
                    VALUES('s','s','codex','s','p','Synthetic','2026-01-01T00:00:00Z','event',0,0);").unwrap();
            }
        }).unwrap();
        assert_eq!(page.catalog_revision, before);
        assert_eq!(page.total, 0);
        assert!(page.items.is_empty());
        let next = catalog.query(&SessionQuery::default()).unwrap();
        assert_ne!(next.catalog_revision, before);
        assert_eq!(next.total, 1);
        assert_eq!(next.items.len(), 1);
    }
}

// Metadata inspection only; no source file is mutated by these helpers.
fn inspection_path_is_plain(path: &Path) -> bool {
    path.ancestors()
        .all(|part| fs::symlink_metadata(part).is_ok_and(|m| !m.file_type().is_symlink()))
}
fn inspection_single_link(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.nlink() == 1
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        false
    } // No portable hardlink proof: remain conservative.
}
