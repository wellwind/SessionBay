//! Catalog-owned tasks and explicit commands. Session links intentionally have no
//! foreign key to the rebuildable history index.
use super::{directory_key, error, session_row, Catalog, SESSION_COLUMNS};
use crate::{models::Session, tr};
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KanbanStage {
    Unsorted,
    Todo,
    Doing,
    Review,
    Done,
}
impl KanbanStage {
    fn key(self) -> &'static str {
        match self {
            Self::Unsorted => "unsorted",
            Self::Todo => "todo",
            Self::Doing => "doing",
            Self::Review => "review",
            Self::Done => "done",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanColumn {
    pub id: String,
    pub project_id: String,
    /// None means the UI translates default_name in its current language.
    pub name: Option<String>,
    pub default_name: Option<String>,
    pub stage: KanbanStage,
    pub position: u32,
    pub system_role: Option<KanbanStage>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanSession {
    pub session: Session,
    pub branch: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanCard {
    pub id: String,
    pub project_id: String,
    pub column_id: String,
    /// Empty until the first session supplies a title; render as Untitled task.
    pub title: String,
    pub notes: String,
    pub position: u32,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub sessions: Vec<KanbanSession>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanBoard {
    pub project_id: String,
    pub enabled: bool,
    pub enabled_at: String,
    pub columns: Vec<KanbanColumn>,
    /// Includes archived tasks so callers can offer a recoverable Archived view.
    pub cards: Vec<KanbanCard>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KanbanSessionDisposition {
    Unsorted,
    Detach,
}

pub(super) fn migrate(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    tx.execute_batch("
        CREATE TABLE IF NOT EXISTS kanban_boards(
            project_id TEXT PRIMARY KEY REFERENCES projects(id), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), enabled_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS kanban_columns(
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES kanban_boards(project_id),
            name TEXT, default_name TEXT, stage TEXT NOT NULL CHECK(stage IN ('unsorted','todo','doing','review','done')),
            position INTEGER NOT NULL CHECK(position>=0), system_role TEXT CHECK(system_role IN ('unsorted','done')),
            CHECK(system_role IS NULL OR stage=system_role), UNIQUE(project_id,system_role), UNIQUE(id,project_id));
        CREATE INDEX IF NOT EXISTS kanban_columns_order ON kanban_columns(project_id,position,id);
        CREATE TABLE IF NOT EXISTS kanban_cards(
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES kanban_boards(project_id),
            column_id TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL,
            position INTEGER NOT NULL CHECK(position>=0), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            FOREIGN KEY(column_id,project_id) REFERENCES kanban_columns(id,project_id));
        CREATE INDEX IF NOT EXISTS kanban_cards_order ON kanban_cards(column_id,archived,position,id);
        CREATE TABLE IF NOT EXISTS kanban_card_sessions(
            session_id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
            source_root TEXT NOT NULL, branch TEXT, position INTEGER NOT NULL, automatic INTEGER NOT NULL, source_id TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS kanban_card_sessions_card ON kanban_card_sessions(card_id,position,session_id);
        CREATE TABLE IF NOT EXISTS kanban_observed_sessions(
            session_id TEXT NOT NULL, source_root TEXT NOT NULL, suppressed INTEGER NOT NULL DEFAULT 0, last_activity TEXT NOT NULL, PRIMARY KEY(session_id,source_root));
        CREATE TABLE IF NOT EXISTS kanban_resume_requests(
            session_id TEXT NOT NULL, source_root TEXT NOT NULL, requested_at TEXT NOT NULL, PRIMARY KEY(session_id,source_root));
        INSERT OR IGNORE INTO kanban_observed_sessions(session_id,source_root,last_activity) SELECT s.id,src.storage_root,s.updated_at FROM sessions s JOIN sources src ON src.id=s.source_id;
        PRAGMA user_version=7;").map_err(error)?;
    for table in [
        "kanban_boards",
        "kanban_columns",
        "kanban_cards",
        "kanban_card_sessions",
        "kanban_observed_sessions",
        "kanban_resume_requests",
    ] {
        for operation in ["INSERT", "UPDATE", "DELETE"] {
            tx.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS revision_{table}_{operation} AFTER {operation} ON {table} BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;")).map_err(error)?;
        }
    }
    tx.commit().map_err(error)
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn title_valid(value: &str, allow_empty: bool) -> Result<(), String> {
    if (!allow_empty && value.trim().is_empty())
        || value.chars().count() > 500
        || value.chars().any(char::is_control)
    {
        return Err(tr!(
            "Kanban names must contain 1–500 characters and no control characters."
        ));
    }
    Ok(())
}
fn notes_valid(value: &str) -> Result<(), String> {
    if value.len() > 1024 * 1024 || value.contains('\0') {
        return Err(tr!(
            "Kanban notes must be at most 1 MiB and contain no null characters."
        ));
    }
    Ok(())
}
fn stage(value: String) -> rusqlite::Result<KanbanStage> {
    serde_json::from_value(serde_json::Value::String(value)).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn column(conn: &Connection, column_id: &str) -> Result<KanbanColumn, String> {
    conn.query_row("SELECT id,project_id,name,default_name,stage,position,system_role FROM kanban_columns WHERE id=?1", [column_id], |r| Ok(KanbanColumn {
        id:r.get(0)?, project_id:r.get(1)?, name:r.get(2)?, default_name:r.get(3)?, stage:stage(r.get(4)?)?, position:r.get(5)?, system_role:r.get::<_,Option<String>>(6)?.map(stage).transpose()?,
    })).optional().map_err(error)?.ok_or(tr!("Kanban column not found."))
}
fn card(conn: &Connection, card_id: &str) -> Result<KanbanCard, String> {
    let mut card = conn.query_row("SELECT id,project_id,column_id,title,notes,position,archived,created_at,updated_at FROM kanban_cards WHERE id=?1", [card_id], |r| Ok(KanbanCard {
        id:r.get(0)?, project_id:r.get(1)?, column_id:r.get(2)?, title:r.get(3)?, notes:r.get(4)?, position:r.get(5)?, archived:r.get(6)?, created_at:r.get(7)?, updated_at:r.get(8)?, sessions:Vec::new(),
    })).optional().map_err(error)?.ok_or(tr!("Kanban card not found."))?;
    card.sessions = conn.prepare(&format!("SELECT {SESSION_COLUMNS},l.branch FROM kanban_card_sessions l JOIN sessions s ON s.id=l.session_id JOIN sources src ON src.id=s.source_id AND src.storage_root=l.source_root WHERE l.card_id=?1 AND NOT EXISTS(SELECT 1 FROM session_trash t WHERE t.session_id=s.id AND t.source_root=l.source_root) ORDER BY l.position,l.session_id")).map_err(error)?
        .query_map([card_id], |r| Ok(KanbanSession { session:session_row(r)?, branch:r.get(15)? })).map_err(error)?.collect::<Result<Vec<_>,_>>().map_err(error)?;
    Ok(card)
}
fn strings(conn: &Connection, sql: &str, key: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(sql).map_err(error)?;
    let read: fn(&rusqlite::Row<'_>) -> rusqlite::Result<String> = |r| r.get(0);
    let rows = if stmt.parameter_count() == 0 {
        stmt.query_map([], read)
    } else {
        stmt.query_map([key], read)
    }
    .map_err(error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(error)
}
fn require_enabled(conn: &Connection, project: &str) -> Result<(), String> {
    let enabled: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM kanban_boards b JOIN projects p ON p.id=b.project_id WHERE b.project_id=?1 AND b.enabled=1 AND p.manual=1)", [project], |r| r.get(0)).map_err(error)?;
    if !enabled {
        return Err(tr!("Enable a board for this curated project first."));
    }
    Ok(())
}
fn same_project(left: &str, right: &str) -> Result<(), String> {
    if left != right {
        return Err(tr!(
            "Kanban cards and sessions cannot move between projects."
        ));
    }
    Ok(())
}
fn touch(conn: &Connection, card_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE kanban_cards SET updated_at=?1 WHERE id=?2",
        params![now(), card_id],
    )
    .map_err(error)?;
    Ok(())
}
fn normalize(conn: &Connection, column_id: &str) -> Result<(), String> {
    for (position, id) in strings(
        conn,
        "SELECT id FROM kanban_cards WHERE column_id=?1 ORDER BY position,id",
        column_id,
    )?
    .iter()
    .enumerate()
    {
        conn.execute(
            "UPDATE kanban_cards SET position=?1 WHERE id=?2 AND position<>?1",
            params![position as i64, id],
        )
        .map_err(error)?;
    }
    Ok(())
}
fn create_card(
    conn: &Connection,
    column_id: &str,
    title: &str,
    notes: &str,
) -> Result<String, String> {
    title_valid(title, true)?;
    notes_valid(notes)?;
    let col = column(conn, column_id)?;
    require_enabled(conn, &col.project_id)?;
    let position: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position)+1,0) FROM kanban_cards WHERE column_id=?1",
            [column_id],
            |r| r.get(0),
        )
        .map_err(error)?;
    let id = id();
    conn.execute("INSERT INTO kanban_cards(id,project_id,column_id,title,notes,position,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)", params![id,col.project_id,column_id,title,notes,position,now()]).map_err(error)?;
    Ok(id)
}
fn unsorted(conn: &Connection, project: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT id FROM kanban_columns WHERE project_id=?1 AND system_role='unsorted'",
        [project],
        |r| r.get(0),
    )
    .map_err(error)
}
fn linked_card(conn: &Connection, session_id: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT l.card_id FROM kanban_card_sessions l JOIN sessions s ON s.id=l.session_id JOIN sources src ON src.id=s.source_id AND src.storage_root=l.source_root WHERE l.session_id=?1", [session_id], |r|r.get(0)).optional().map_err(error)
}

impl Catalog {
    fn kanban_write<T>(
        &self,
        action: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let result = action(&tx)?;
        tx.commit().map_err(error)?;
        Ok(result)
    }
    pub fn kanban_board(&self, project_id: &str) -> Result<Option<KanbanBoard>, String> {
        let conn = self.connect()?;
        let tx = conn.unchecked_transaction().map_err(error)?;
        board(&tx, project_id)
    }
    pub fn list_kanban_boards(&self) -> Result<Vec<KanbanBoard>, String> {
        let conn = self.connect()?;
        let tx = conn.unchecked_transaction().map_err(error)?;
        strings(&tx,"SELECT b.project_id FROM kanban_boards b JOIN projects p ON p.id=b.project_id WHERE b.enabled=1 AND p.manual=1 ORDER BY b.project_id", "")?
            .iter().map(|id|board(&tx,id)?.ok_or(tr!("Kanban board not found."))).collect()
    }
    pub fn set_kanban_board_enabled(
        &self,
        project_id: &str,
        enabled: bool,
    ) -> Result<KanbanBoard, String> {
        self.kanban_write(|conn| {
            let curated: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND manual=1)", [project_id], |r|r.get(0)).map_err(error)?;
            if !curated { return Err(tr!("Only curated projects can have a Kanban board.")); }
            let existed = board(conn,project_id)?;
            conn.execute("INSERT INTO kanban_boards VALUES(?1,?2,?3) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,enabled_at=CASE WHEN kanban_boards.enabled=0 AND excluded.enabled=1 THEN excluded.enabled_at ELSE kanban_boards.enabled_at END", params![project_id,enabled,now()]).map_err(error)?;
            if enabled && existed.as_ref().is_none_or(|b|!b.enabled) {
                // Do not consume another board's intake while its scan is in progress.
                for session in strings(conn,"SELECT s.id FROM sessions s JOIN sources src ON src.id=s.source_id WHERE NOT EXISTS(SELECT 1 FROM kanban_observed_sessions o WHERE o.session_id=s.id AND o.source_root=src.storage_root)","")? {
                    if session_context(conn,&session)?.0==project_id {
                        observe(conn,&session)?;
                    }
                }
            }
            if existed.is_none() {
                for (position, (name,stage,role)) in [("Unsorted","unsorted",Some("unsorted")),("Todo","todo",None),("In progress","doing",None),("Review","review",None),("Done","done",Some("done"))].iter().enumerate() {
                    conn.execute("INSERT INTO kanban_columns VALUES(?1,?2,NULL,?3,?4,?5,?6)", params![id(),project_id,name,stage,position as i64,role]).map_err(error)?;
                }
            }
            board(conn,project_id)?.ok_or(tr!("Kanban board not found."))
        })
    }
    pub fn create_kanban_column(
        &self,
        project_id: &str,
        name: &str,
        stage: Option<KanbanStage>,
    ) -> Result<KanbanColumn, String> {
        title_valid(name, false)?;
        self.kanban_write(|conn| {
            require_enabled(conn, project_id)?;
            let position: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(position)+1,0) FROM kanban_columns WHERE project_id=?1",
                    [project_id],
                    |r| r.get(0),
                )
                .map_err(error)?;
            let id = id();
            conn.execute(
                "INSERT INTO kanban_columns VALUES(?1,?2,?3,NULL,?4,?5,NULL)",
                params![
                    id,
                    project_id,
                    name,
                    stage.unwrap_or(KanbanStage::Doing).key(),
                    position
                ],
            )
            .map_err(error)?;
            column(conn, &id)
        })
    }
    pub fn rename_kanban_column(
        &self,
        column_id: &str,
        name: &str,
    ) -> Result<KanbanColumn, String> {
        title_valid(name, false)?;
        self.kanban_write(|conn| {
            require_enabled(conn, &column(conn, column_id)?.project_id)?;
            conn.execute(
                "UPDATE kanban_columns SET name=?1 WHERE id=?2",
                params![name, column_id],
            )
            .map_err(error)?;
            column(conn, column_id)
        })
    }
    pub fn set_kanban_column_stage(
        &self,
        column_id: &str,
        stage: KanbanStage,
    ) -> Result<KanbanColumn, String> {
        self.kanban_write(|conn| {
            let col = column(conn, column_id)?;
            require_enabled(conn, &col.project_id)?;
            if col.system_role.is_some_and(|role| role != stage) {
                return Err(tr!(
                    "System columns have a fixed stage and cannot be deleted."
                ));
            }
            conn.execute(
                "UPDATE kanban_columns SET stage=?1 WHERE id=?2",
                params![stage.key(), column_id],
            )
            .map_err(error)?;
            column(conn, column_id)
        })
    }
    pub fn reorder_kanban_columns(
        &self,
        project_id: &str,
        column_ids: &[String],
    ) -> Result<(), String> {
        self.kanban_write(|conn| {
            require_enabled(conn, project_id)?;
            let existing = strings(
                conn,
                "SELECT id FROM kanban_columns WHERE project_id=?1",
                project_id,
            )?;
            let unique: HashSet<_> = column_ids.iter().collect();
            if existing.len() != column_ids.len()
                || unique.len() != column_ids.len()
                || existing.iter().any(|id| !unique.contains(id))
            {
                return Err(tr!("Supply every column exactly once when reordering."));
            }
            for (position, id) in column_ids.iter().enumerate() {
                conn.execute(
                    "UPDATE kanban_columns SET position=?1 WHERE id=?2",
                    params![position as i64, id],
                )
                .map_err(error)?;
            }
            Ok(())
        })
    }
    pub fn delete_kanban_column(
        &self,
        column_id: &str,
        target_column_id: &str,
    ) -> Result<(), String> {
        self.kanban_write(|conn| {
            let col = column(conn, column_id)?;
            require_enabled(conn, &col.project_id)?;
            same_project(&col.project_id, &column(conn, target_column_id)?.project_id)?;
            if col.system_role.is_some() {
                return Err(tr!(
                    "System columns have a fixed stage and cannot be deleted."
                ));
            }
            if column_id == target_column_id {
                return Err(tr!("Choose a different destination column."));
            }
            for id in strings(
                conn,
                "SELECT id FROM kanban_cards WHERE column_id=?1 ORDER BY position,id",
                column_id,
            )? {
                move_card(conn, &id, target_column_id, None)?;
            }
            conn.execute("DELETE FROM kanban_columns WHERE id=?1", [column_id])
                .map_err(error)?;
            for (position, id) in strings(
                conn,
                "SELECT id FROM kanban_columns WHERE project_id=?1 ORDER BY position,id",
                &col.project_id,
            )?
            .iter()
            .enumerate()
            {
                conn.execute(
                    "UPDATE kanban_columns SET position=?1 WHERE id=?2",
                    params![position as i64, id],
                )
                .map_err(error)?;
            }
            Ok(())
        })
    }
    pub fn create_kanban_card(
        &self,
        column_id: &str,
        title: &str,
        notes: &str,
    ) -> Result<KanbanCard, String> {
        self.kanban_write(|conn| card(conn, &create_card(conn, column_id, title, notes)?))
    }
    pub fn edit_kanban_card(
        &self,
        card_id: &str,
        title: &str,
        notes: &str,
    ) -> Result<KanbanCard, String> {
        title_valid(title, true)?;
        notes_valid(notes)?;
        self.kanban_write(|conn| {
            require_enabled(conn, &card(conn, card_id)?.project_id)?;
            conn.execute(
                "UPDATE kanban_cards SET title=?1,notes=?2,updated_at=?3 WHERE id=?4",
                params![title, notes, now(), card_id],
            )
            .map_err(error)?;
            card(conn, card_id)
        })
    }
    pub fn move_kanban_card(
        &self,
        card_id: &str,
        column_id: &str,
        position: u32,
    ) -> Result<KanbanCard, String> {
        self.kanban_write(|conn| {
            move_card(conn, card_id, column_id, Some(position))?;
            card(conn, card_id)
        })
    }
    pub fn archive_kanban_card(&self, card_id: &str, archived: bool) -> Result<KanbanCard, String> {
        self.kanban_write(|conn| {
            require_enabled(conn, &card(conn, card_id)?.project_id)?;
            conn.execute(
                "UPDATE kanban_cards SET archived=?1,updated_at=?2 WHERE id=?3",
                params![archived, now(), card_id],
            )
            .map_err(error)?;
            card(conn, card_id)
        })
    }
    pub fn delete_kanban_card(
        &self,
        card_id: &str,
        sessions: KanbanSessionDisposition,
    ) -> Result<(), String> {
        self.kanban_write(|conn| {
            let old=card(conn,card_id)?;
            require_enabled(conn,&old.project_id)?;
            if matches!(sessions,KanbanSessionDisposition::Unsorted) {
                let dest=unsorted(conn,&old.project_id)?;
                let links=strings(conn,"SELECT session_id FROM kanban_card_sessions WHERE card_id=?1 ORDER BY position,session_id",card_id)?;
                let members:HashSet<_>=links.iter().cloned().collect();
                let mut replacements:HashMap<String,String>=HashMap::new();
                for session in links {
                    let mut root=session.clone();
                    let mut visited=HashSet::new();
                    while visited.len()<128 && visited.insert(root.clone()) {
                        let parent:Option<String>=conn.query_row("SELECT parent_id FROM sessions WHERE id=?1",[&root],|r|r.get(0)).optional().map_err(error)?.flatten();
                        match parent {
                            Some(parent) if members.contains(&parent) && !visited.contains(&parent) => root=parent,
                            _=>break,
                        }
                    }
                    let new=if let Some(new)=replacements.get(&root) {new.clone()} else {
                        let title:String=conn.query_row("SELECT title FROM sessions WHERE id=?1",[&root],|r|r.get(0)).optional().map_err(error)?.unwrap_or_default();
                        let new=create_card(conn,&dest,&title,"")?;
                        replacements.insert(root,new.clone());
                        new
                    };
                    let position:i64=conn.query_row("SELECT COUNT(*) FROM kanban_card_sessions WHERE card_id=?1",[&new],|r|r.get(0)).map_err(error)?;
                    conn.execute("UPDATE kanban_card_sessions SET card_id=?1,position=?2 WHERE session_id=?3",params![new,position,session]).map_err(error)?;
                }
            }
            if matches!(sessions, KanbanSessionDisposition::Detach) {
                conn.execute("UPDATE kanban_observed_sessions SET suppressed=1 WHERE session_id IN (SELECT session_id FROM kanban_card_sessions WHERE card_id=?1)",[card_id]).map_err(error)?;
            }
            conn.execute("DELETE FROM kanban_cards WHERE id=?1",[card_id]).map_err(error)?;
            normalize(conn,&old.column_id)
        })
    }
    pub fn attach_kanban_session(
        &self,
        card_id: &str,
        session_id: &str,
    ) -> Result<KanbanCard, String> {
        self.kanban_write(|conn| {
            attach(conn, card_id, session_id, false)?;
            follow_children(conn, session_id)?;
            card(conn, card_id)
        })
    }
    pub fn detach_kanban_session(
        &self,
        card_id: &str,
        session_id: &str,
    ) -> Result<KanbanCard, String> {
        self.kanban_write(|conn| {
            require_enabled(conn, &card(conn, card_id)?.project_id)?;
            let count = conn
                .execute(
                    "DELETE FROM kanban_card_sessions WHERE card_id=?1 AND session_id=?2",
                    params![card_id, session_id],
                )
                .map_err(error)?;
            if count == 0 {
                return Err(tr!("This session is not attached to the card."));
            }
            conn.execute(
                "UPDATE kanban_observed_sessions SET suppressed=1 WHERE session_id=?1",
                [session_id],
            )
            .map_err(error)?;
            touch(conn, card_id)?;
            card(conn, card_id)
        })
    }
    pub fn merge_kanban_cards(
        &self,
        source_card_id: &str,
        target_card_id: &str,
    ) -> Result<KanbanCard, String> {
        self.kanban_write(|conn| {
            let source = card(conn, source_card_id)?;
            let target = card(conn, target_card_id)?;
            require_enabled(conn, &source.project_id)?;
            same_project(&source.project_id, &target.project_id)?;
            if source_card_id == target_card_id {
                return Err(tr!("Choose a different destination card."));
            }
            let notes = [
                target.notes.as_str(),
                source.title.as_str(),
                source.notes.as_str(),
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
            notes_valid(&notes)?;
            let offset: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(position)+1,0) FROM kanban_card_sessions WHERE card_id=?1",
                    [target_card_id],
                    |r| r.get(0),
                )
                .map_err(error)?;
            conn.execute(
                "UPDATE kanban_card_sessions SET card_id=?1,position=position+?2 WHERE card_id=?3",
                params![target_card_id, offset, source_card_id],
            )
            .map_err(error)?;
            conn.execute(
                "UPDATE kanban_cards SET title=?1,notes=?2,updated_at=?3 WHERE id=?4",
                params![
                    if target.title.is_empty() {
                        &source.title
                    } else {
                        &target.title
                    },
                    notes,
                    now(),
                    target_card_id
                ],
            )
            .map_err(error)?;
            conn.execute("DELETE FROM kanban_cards WHERE id=?1", [source_card_id])
                .map_err(error)?;
            normalize(conn, &source.column_id)?;
            card(conn, target_card_id)
        })
    }
    pub fn split_kanban_session(
        &self,
        card_id: &str,
        session_id: &str,
    ) -> Result<KanbanCard, String> {
        self.kanban_write(|conn| {
            let old = card(conn, card_id)?;
            require_enabled(conn, &old.project_id)?;
            if linked_card(conn, session_id)?.as_deref() != Some(card_id) {
                return Err(tr!("This session is not attached to the card."));
            }
            let title: String = conn
                .query_row(
                    "SELECT title FROM sessions WHERE id=?1",
                    [session_id],
                    |r| r.get(0),
                )
                .map_err(error)?;
            let new = create_card(conn, &old.column_id, &title, "")?;
            attach(conn, &new, session_id, false)?;
            follow_children(conn, session_id)?;
            move_card(conn, &new, &old.column_id, Some(old.position + 1))?;
            card(conn, &new)
        })
    }
    pub fn add_kanban_session(&self, session_id: &str) -> Result<KanbanCard, String> {
        self.kanban_write(|conn| {
            let id = intake(conn, session_id, true, &mut HashSet::new())?
                .ok_or(tr!("Enable a board for this curated project first."))?;
            follow_children(conn, session_id)?;
            card(conn, &id)
        })
    }
    pub fn kanban_session_card(&self, session_id: &str) -> Result<Option<KanbanCard>, String> {
        let conn = self.connect()?;
        let tx = conn.unchecked_transaction().map_err(error)?;
        linked_card(&tx, session_id)?
            .map(|id| card(&tx, &id))
            .transpose()
    }
    /// Called only after a successful resume, never by launch preview/planning.
    pub fn kanban_session_resumed(&self, session_id: &str) -> Result<Option<KanbanCard>, String> {
        self.kanban_write(|conn| {
            let id = intake(conn, session_id, true, &mut HashSet::new())?;
            follow_children(conn, session_id)?;
            id.map(|id| card(conn, &id)).transpose()
        })
    }
    /// A successful manual provider resume can precede discovery of its transcript.
    pub fn request_kanban_resume(
        &self,
        source: &crate::models::HistorySource,
        external_id: &str,
    ) -> Result<(), String> {
        let session_id = super::session_identity(source, external_id);
        let root = directory_key(&source.root);
        self.kanban_write(|conn| {
            conn.execute("INSERT INTO kanban_resume_requests VALUES(?1,?2,?3) ON CONFLICT(session_id,source_root) DO UPDATE SET requested_at=excluded.requested_at",params![session_id,root,now()]).map_err(error)?;
            let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sessions s JOIN sources src ON src.id=s.source_id WHERE s.id=?1 AND src.storage_root=?2)",params![session_id,root],|r|r.get(0)).map_err(error)?;
            if exists {
                intake(conn,&session_id,true,&mut HashSet::new())?;
                follow_children(conn,&session_id)?;
                conn.execute("DELETE FROM kanban_resume_requests WHERE session_id=?1 AND source_root=?2",params![session_id,root]).map_err(error)?;
            }
            Ok(())
        })
    }
    pub(super) fn refresh_kanban_intake(&self) -> Result<(), String> {
        self.kanban_write(|conn| {
            let enabled:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM kanban_boards b JOIN projects p ON p.id=b.project_id WHERE b.enabled=1 AND p.manual=1)",[],|r|r.get(0)).map_err(error)?;
            let candidates=strings(conn,"SELECT s.id FROM sessions s JOIN sources src ON src.id=s.source_id LEFT JOIN kanban_observed_sessions o ON o.session_id=s.id AND o.source_root=src.storage_root WHERE o.session_id IS NULL OR o.last_activity<>s.updated_at OR EXISTS(SELECT 1 FROM kanban_resume_requests r WHERE r.session_id=s.id AND r.source_root=src.storage_root) ORDER BY s.id", "")?;
            for session in candidates {
                if enabled { intake(conn,&session,false,&mut HashSet::new())?; follow_children(conn,&session)?; }
                observe(conn,&session)?;
                conn.execute("DELETE FROM kanban_resume_requests WHERE session_id=?1",[&session]).map_err(error)?;
            }
            Ok(())
        })
    }
}

fn board(conn: &Connection, project_id: &str) -> Result<Option<KanbanBoard>, String> {
    let row: Option<(bool, String)> = conn
        .query_row(
            "SELECT enabled,enabled_at FROM kanban_boards WHERE project_id=?1",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(error)?;
    let Some((enabled, enabled_at)) = row else {
        return Ok(None);
    };
    let columns = strings(
        conn,
        "SELECT id FROM kanban_columns WHERE project_id=?1 ORDER BY position,id",
        project_id,
    )?
    .iter()
    .map(|id| column(conn, id))
    .collect::<Result<_, _>>()?;
    let cards = strings(
        conn,
        "SELECT id FROM kanban_cards WHERE project_id=?1 ORDER BY column_id,position,id",
        project_id,
    )?
    .iter()
    .map(|id| card(conn, id))
    .collect::<Result<_, _>>()?;
    Ok(Some(KanbanBoard {
        project_id: project_id.into(),
        enabled,
        enabled_at,
        columns,
        cards,
    }))
}
fn move_card(
    conn: &Connection,
    card_id: &str,
    column_id: &str,
    position: Option<u32>,
) -> Result<(), String> {
    let old = card(conn, card_id)?;
    let dest = column(conn, column_id)?;
    require_enabled(conn, &old.project_id)?;
    same_project(&old.project_id, &dest.project_id)?;
    let mut ids = strings(
        conn,
        "SELECT id FROM kanban_cards WHERE column_id=?1 ORDER BY position,id",
        column_id,
    )?;
    ids.retain(|id| id != card_id);
    let position = position.map(|p| p as usize).unwrap_or(ids.len());
    if position > ids.len() {
        return Err(tr!("The card position is outside the destination column."));
    }
    ids.insert(position, card_id.into());
    conn.execute(
        "UPDATE kanban_cards SET column_id=?1,updated_at=?2 WHERE id=?3",
        params![column_id, now(), card_id],
    )
    .map_err(error)?;
    for (position, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE kanban_cards SET position=?1 WHERE id=?2",
            params![position as i64, id],
        )
        .map_err(error)?;
    }
    if old.column_id != column_id {
        normalize(conn, &old.column_id)?;
    }
    Ok(())
}
fn observe(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute("INSERT INTO kanban_observed_sessions(session_id,source_root,last_activity) SELECT s.id,src.storage_root,s.updated_at FROM sessions s JOIN sources src ON src.id=s.source_id WHERE s.id=?1 ON CONFLICT(session_id,source_root) DO UPDATE SET last_activity=excluded.last_activity WHERE last_activity<>excluded.last_activity",[session_id]).map_err(error)?;
    Ok(())
}

/// Only Git itself resolves linked worktrees. No repository or history writes.
fn worktree(cwd: Option<&str>) -> Option<(String, String)> {
    use crate::git::runner::{Access, GitRunner, Invocation};
    let cwd = Path::new(cwd?);
    if !cwd.ancestors().any(|p| p.join(".git").is_file()) {
        return None;
    }
    let runner = GitRunner::detect().ok()?;
    let branch = runner
        .run(Invocation::new(
            cwd,
            Access::Read,
            ["rev-parse", "--abbrev-ref", "HEAD"],
        ))
        .ok()?
        .checked()
        .ok()?
        .stdout_text();
    let trees = runner
        .run(Invocation::new(
            cwd,
            Access::Read,
            ["worktree", "list", "--porcelain"],
        ))
        .ok()?
        .checked()
        .ok()?
        .stdout_text();
    let main = trees.lines().next()?.strip_prefix("worktree ")?;
    Some((directory_key(main), branch.trim().to_owned()))
}
fn session_context(
    conn: &Connection,
    session_id: &str,
) -> Result<(String, String, String, Option<String>), String> {
    let (project,root,cwd,title):(String,String,Option<String>,String)=conn.query_row("SELECT s.project_id,src.storage_root,s.cwd,s.title FROM sessions s JOIN sources src ON src.id=s.source_id WHERE s.id=?1",[session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(error)?.ok_or(tr!("Kanban session not found."))?;
    let mut project = project;
    let mut branch = None;
    if let Some((main, head)) = worktree(cwd.as_deref()) {
        if let Some(id) = conn
            .query_row(
                "SELECT project_id FROM project_directories WHERE path=?1",
                [main],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(error)?
        {
            project = id;
        }
        branch = Some(head);
    }
    Ok((project, root, title, branch))
}
fn attach(
    conn: &Connection,
    card_id: &str,
    session_id: &str,
    automatic: bool,
) -> Result<(), String> {
    let target = card(conn, card_id)?;
    require_enabled(conn, &target.project_id)?;
    let (mut project, root, title, branch) = session_context(conn, session_id)?;
    // A child without cwd inherits its nearest attached ancestor's board.
    let ancestor:Option<String>=conn.query_row(
        "WITH RECURSIVE ancestors(id,depth) AS (
            SELECT parent_id,0 FROM sessions WHERE id=?1 AND parent_id IS NOT NULL
            UNION ALL SELECT s.parent_id,a.depth+1 FROM sessions s JOIN ancestors a ON s.id=a.id WHERE s.parent_id IS NOT NULL AND a.depth<127
        ) SELECT c.project_id FROM ancestors a JOIN kanban_card_sessions l ON l.session_id=a.id JOIN kanban_cards c ON c.id=l.card_id ORDER BY a.depth LIMIT 1",
        [session_id],|r|r.get(0)).optional().map_err(error)?;
    if let Some(ancestor) = ancestor {
        project = ancestor;
    }
    same_project(&project, &target.project_id)?;
    if linked_card(conn, session_id)?.as_deref() == Some(card_id) {
        observe(conn, session_id)?;
        if !automatic {
            conn.execute(
                "UPDATE kanban_card_sessions SET automatic=0 WHERE session_id=?1",
                [session_id],
            )
            .map_err(error)?;
            conn.execute(
                "UPDATE kanban_observed_sessions SET suppressed=0 WHERE session_id=?1",
                [session_id],
            )
            .map_err(error)?;
        }
        return Ok(());
    }
    if let Some(old) = linked_card(conn, session_id)? {
        touch(conn, &old)?;
    }
    let position: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position)+1,0) FROM kanban_card_sessions WHERE card_id=?1",
            [card_id],
            |r| r.get(0),
        )
        .map_err(error)?;
    conn.execute("INSERT INTO kanban_card_sessions VALUES(?1,?2,?3,?4,?5,?6,(SELECT source_id FROM sessions WHERE id=?1)) ON CONFLICT(session_id) DO UPDATE SET card_id=excluded.card_id,source_root=excluded.source_root,branch=excluded.branch,position=excluded.position,automatic=excluded.automatic,source_id=excluded.source_id",params![session_id,card_id,root,branch,position,automatic]).map_err(error)?;
    conn.execute("UPDATE kanban_cards SET title=CASE WHEN title='' THEN ?1 ELSE title END,updated_at=?2 WHERE id=?3",params![title,now(),card_id]).map_err(error)?;
    observe(conn, session_id)?;
    conn.execute(
        "UPDATE kanban_observed_sessions SET suppressed=0 WHERE session_id=?1",
        [session_id],
    )
    .map_err(error)?;
    Ok(())
}
fn auto_requested(
    conn: &Connection,
    session_id: &str,
    root: &str,
    project: &str,
) -> Result<bool, String> {
    let (seen,suppressed,activity):(bool,bool,bool)=conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM kanban_observed_sessions WHERE session_id=?1 AND source_root=?2),
        EXISTS(SELECT 1 FROM kanban_observed_sessions WHERE session_id=?1 AND source_root=?2 AND suppressed=1),
        EXISTS(SELECT 1 FROM sessions s JOIN kanban_observed_sessions o ON o.session_id=s.id AND o.source_root=?2 JOIN kanban_boards b ON b.project_id=?3 WHERE s.id=?1 AND s.time_source='event' AND s.updated_at>o.last_activity AND s.updated_at>=b.enabled_at)",
        params![session_id,root,project],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(error)?;
    let resumed:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM kanban_resume_requests r JOIN kanban_boards b ON b.project_id=?3 WHERE r.session_id=?1 AND r.source_root=?2 AND r.requested_at>=b.enabled_at)",params![session_id,root,project],|r|r.get(0)).map_err(error)?;
    if resumed {
        return Ok(true);
    }
    if suppressed || (seen && !activity) {
        return Ok(false);
    }
    // Imported old history is not new; fresh event activity on observed history is a resume.
    let old:bool=conn.query_row("SELECT COALESCE((SELECT MIN(m.timestamp) FROM messages m JOIN files f ON f.id=m.file_id WHERE f.session_id=?1) < (SELECT enabled_at FROM kanban_boards WHERE project_id=?2),0)",params![session_id,project],|r|r.get(0)).map_err(error)?;
    Ok(activity || !old)
}
fn intake(
    conn: &Connection,
    session_id: &str,
    force: bool,
    visiting: &mut HashSet<String>,
) -> Result<Option<String>, String> {
    if let Some(card_id) = linked_card(conn, session_id)? {
        if require_enabled(conn, &card(conn, &card_id)?.project_id).is_err() {
            return Ok(None);
        }
        return Ok(Some(card_id));
    }
    if visiting.len() >= 128 || !visiting.insert(session_id.into()) {
        return Ok(None);
    }
    let (project, root, title, _) = session_context(conn, session_id)?;
    if !force {
        let excluded:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM kanban_observed_sessions o WHERE o.session_id=?1 AND o.source_root=?2 AND o.suppressed=1) AND NOT EXISTS(SELECT 1 FROM kanban_resume_requests r WHERE r.session_id=?1 AND r.source_root=?2)",params![session_id,root],|r|r.get(0)).map_err(error)?;
        if excluded {
            return Ok(None);
        }
    }
    let parent: Option<String> = conn
        .query_row(
            "SELECT parent_id FROM sessions WHERE id=?1",
            [session_id],
            |r| r.get(0),
        )
        .map_err(error)?;
    if let Some(parent) = parent {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
                [&parent],
                |r| r.get(0),
            )
            .map_err(error)?;
        if exists {
            let mut parent_card = intake(conn, &parent, force, visiting)?;
            if parent_card.is_none() && !force {
                let (parent_project, parent_root, _, _) = session_context(conn, &parent)?;
                let excluded:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM kanban_observed_sessions WHERE session_id=?1 AND source_root=?2 AND suppressed=1)",params![parent,parent_root],|r|r.get(0)).map_err(error)?;
                if !excluded
                    && require_enabled(conn, &parent_project).is_ok()
                    && auto_requested(conn, session_id, &root, &parent_project)?
                {
                    parent_card = intake(conn, &parent, true, &mut HashSet::new())?;
                }
            }
            if let Some(parent_card) = parent_card {
                attach(conn, &parent_card, session_id, true)?;
                return Ok(Some(parent_card));
            }
        }
    }
    if require_enabled(conn, &project).is_err() {
        return Ok(None);
    }
    let hidden: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM session_trash WHERE session_id=?1 AND source_root=?2)",
            params![session_id, root],
            |r| r.get(0),
        )
        .map_err(error)?;
    if hidden {
        return Ok(None);
    }
    if !force && !auto_requested(conn, session_id, &root, &project)? {
        return Ok(None);
    }
    let id = create_card(conn, &unsorted(conn, &project)?, &title, "")?;
    attach(conn, &id, session_id, !force)?;
    Ok(Some(id))
}
fn follow_children(conn: &Connection, parent: &str) -> Result<(), String> {
    let Some(target) = linked_card(conn, parent)? else {
        return Ok(());
    };
    if require_enabled(conn, &card(conn, &target)?.project_id).is_err() {
        return Ok(());
    }
    let children=strings(conn,"WITH RECURSIVE descendants(id) AS (SELECT id FROM sessions WHERE parent_id=?1 UNION SELECT s.id FROM sessions s JOIN descendants d ON s.parent_id=d.id) SELECT d.id FROM descendants d LEFT JOIN kanban_card_sessions l ON l.session_id=d.id WHERE (l.session_id IS NULL OR l.automatic=1) AND NOT EXISTS(SELECT 1 FROM kanban_observed_sessions o JOIN sources src ON src.storage_root=o.source_root JOIN sessions s ON s.source_id=src.id AND s.id=o.session_id WHERE o.session_id=d.id AND o.suppressed=1)",parent)?;
    for child in children {
        attach(conn, &target, &child, true)?;
    }
    Ok(())
}
pub(super) fn detach_missing(conn: &Connection, session_id: &str) -> Result<(), String> {
    if let Some(id) = conn
        .query_row(
            "SELECT card_id FROM kanban_card_sessions WHERE session_id=?1",
            [session_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(error)?
    {
        conn.execute(
            "DELETE FROM kanban_card_sessions WHERE session_id=?1",
            [session_id],
        )
        .map_err(error)?;
        touch(conn, &id)?;
    }
    Ok(())
}
pub(super) fn detach_source(conn: &Connection, source_id: &str) -> Result<(), String> {
    for id in strings(
        conn,
        "SELECT session_id FROM kanban_card_sessions WHERE source_id=?1",
        source_id,
    )? {
        detach_missing(conn, &id)?;
    }
    Ok(())
}

pub(super) fn detach_absent(conn: &Connection, source_id: &str) -> Result<(), String> {
    for id in strings(conn, "SELECT l.session_id FROM kanban_card_sessions l WHERE l.source_id=?1 AND NOT EXISTS(SELECT 1 FROM sessions s JOIN sources src ON src.id=s.source_id WHERE s.id=l.session_id AND src.storage_root=l.source_root)", source_id)? {
        detach_missing(conn,&id)?;
    }
    Ok(())
}
