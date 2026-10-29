use rusqlite::Connection;
use serde_json::json;
use sessionbay_lib::{
    catalog::{kanban::*, session_identity, Catalog},
    models::{AgentKind, HistorySource},
};
use std::{fs, path::PathBuf, sync::atomic::AtomicBool};
use tempfile::TempDir;

struct Harness {
    temp: TempDir,
    catalog: Catalog,
    source: HistorySource,
    project: String,
    cwd: String,
}
impl Harness {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let cwd = root.join("project");
        fs::create_dir(&cwd).unwrap();
        let catalog = Catalog::open(&root.join("catalog.sqlite")).unwrap();
        let project = catalog.add_project(cwd.to_str().unwrap(), None).unwrap().id;
        let history = root.join("history");
        fs::create_dir(&history).unwrap();
        Self {
            temp,
            catalog,
            source: HistorySource {
                id: "synthetic".into(),
                kind: AgentKind::Codex,
                root: history.to_string_lossy().into_owned(),
                enabled: true,
            },
            project,
            cwd: cwd.to_string_lossy().into_owned(),
        }
    }
    fn db(&self) -> Connection {
        Connection::open(self.temp.path().join("catalog.sqlite")).unwrap()
    }
    fn enable(&self) -> KanbanBoard {
        self.catalog
            .set_kanban_board_enabled(&self.project, true)
            .unwrap()
    }
    fn board(&self) -> KanbanBoard {
        self.catalog.kanban_board(&self.project).unwrap().unwrap()
    }
    fn write(&self, id: &str, time: &str, cwd: Option<&str>) -> PathBuf {
        let path = PathBuf::from(&self.source.root).join(format!("sessions/{id}.jsonl"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let cwd = cwd.unwrap_or(&self.cwd);
        fs::write(&path, format!("{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":id,"cwd":cwd}}),
            json!({"timestamp":time,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":format!("Synthetic {id}")}]}})
        )).unwrap();
        path
    }
    fn sync(&self) {
        let result = self
            .catalog
            .sync(
                std::slice::from_ref(&self.source),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
        assert!(result.errors.is_empty(), "{:?}", result.errors);
    }
    fn session(&self, id: &str) -> String {
        session_identity(&self.source, id)
    }
    fn card(&self, id: &str) -> Option<KanbanCard> {
        self.catalog.kanban_session_card(&self.session(id)).unwrap()
    }
}
const NEW: &str = "2099-01-01T00:00:00Z";
const OLD: &str = "2020-01-01T00:00:00Z";

#[test]
fn boards_require_curated_projects_and_disable_without_destroying_tasks() {
    let h = Harness::new();
    assert!(h.catalog.kanban_board(&h.project).unwrap().is_none());
    assert!(h.catalog.set_kanban_board_enabled("missing", true).is_err());
    h.catalog
        .update_project(&h.project, None, None, Some(false), None)
        .unwrap();
    assert!(h
        .catalog
        .set_kanban_board_enabled(&h.project, true)
        .is_err());
    h.catalog
        .update_project(&h.project, None, None, Some(true), None)
        .unwrap();
    let board = h.enable();
    assert_eq!(board.columns.len(), 5);
    assert!(board.cards.is_empty());
    assert!(board.columns.iter().all(|c| c.name.is_none()));
    assert_eq!(board.columns[0].default_name.as_deref(), Some("Unsorted"));
    let card = h
        .catalog
        .create_kanban_card(&board.columns[1].id, "Plan", "Notes")
        .unwrap();
    assert!(
        !h.catalog
            .set_kanban_board_enabled(&h.project, false)
            .unwrap()
            .enabled
    );
    assert!(h.catalog.list_kanban_boards().unwrap().is_empty());
    assert!(h.catalog.edit_kanban_card(&card.id, "No", "").is_err());
    assert_eq!(h.enable().cards[0].id, card.id);
    assert_eq!(h.catalog.list_kanban_boards().unwrap().len(), 1);
    h.catalog
        .update_project(&h.project, None, None, Some(false), None)
        .unwrap();
    assert!(h.catalog.list_kanban_boards().unwrap().is_empty());
}

#[test]
fn column_commands_validate_roles_stages_order_and_atomic_relocation() {
    let h = Harness::new();
    let b = h.enable();
    let custom = h
        .catalog
        .create_kanban_column(&h.project, "Blocked", None)
        .unwrap();
    assert_eq!(custom.stage, KanbanStage::Doing);
    assert_eq!(
        h.catalog
            .set_kanban_column_stage(&custom.id, KanbanStage::Review)
            .unwrap()
            .stage,
        KanbanStage::Review
    );
    assert_eq!(
        h.catalog
            .rename_kanban_column(&b.columns[0].id, "Inbox")
            .unwrap()
            .name
            .as_deref(),
        Some("Inbox")
    );
    for col in [&b.columns[0], &b.columns[4]] {
        assert!(h
            .catalog
            .delete_kanban_column(&col.id, &b.columns[1].id)
            .is_err());
        assert!(h
            .catalog
            .set_kanban_column_stage(&col.id, KanbanStage::Todo)
            .is_err());
    }
    assert!(h
        .catalog
        .create_kanban_column(&h.project, " \n", None)
        .is_err());
    assert!(h
        .catalog
        .rename_kanban_column(&custom.id, &"x".repeat(501))
        .is_err());
    let mut ids: Vec<_> = h.board().columns.iter().map(|c| c.id.clone()).collect();
    ids.reverse();
    h.catalog.reorder_kanban_columns(&h.project, &ids).unwrap();
    assert_eq!(h.board().columns[0].id, custom.id);
    let revision = h.catalog.revision().unwrap();
    assert!(h
        .catalog
        .reorder_kanban_columns(&h.project, &vec![ids[0].clone(); 6])
        .is_err());
    assert_eq!(h.catalog.revision().unwrap(), revision);
    let a = h.catalog.create_kanban_card(&custom.id, "A", "").unwrap();
    let z = h
        .catalog
        .create_kanban_card(&b.columns[1].id, "Z", "")
        .unwrap();
    h.catalog.archive_kanban_card(&a.id, true).unwrap();
    assert!(h
        .catalog
        .delete_kanban_column(&custom.id, &custom.id)
        .is_err());
    h.catalog
        .delete_kanban_column(&custom.id, &b.columns[1].id)
        .unwrap();
    let board = h.board();
    let moved = board.cards.iter().find(|c| c.id == a.id).unwrap();
    assert_eq!(moved.column_id, z.column_id);
    assert_eq!(moved.position, 1);
    assert!(moved.archived);
    assert_eq!(
        board.columns.iter().map(|c| c.position).collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4]
    );
}

#[test]
fn card_commands_preserve_manual_order_archive_and_validate_input() {
    let h = Harness::new();
    let b = h.enable();
    let a = h
        .catalog
        .create_kanban_card(&b.columns[1].id, "A", "")
        .unwrap();
    let z = h
        .catalog
        .create_kanban_card(&b.columns[1].id, "Z", "")
        .unwrap();
    let a = h
        .catalog
        .edit_kanban_card(&a.id, "Renamed", "Markdown **notes**")
        .unwrap();
    assert_eq!(a.notes, "Markdown **notes**");
    assert!(a.updated_at >= a.created_at);
    h.catalog.move_kanban_card(&z.id, &a.column_id, 0).unwrap();
    assert_eq!(
        h.board()
            .cards
            .iter()
            .find(|c| c.id == a.id)
            .unwrap()
            .position,
        1
    );
    assert!(h
        .catalog
        .move_kanban_card(&a.id, &b.columns[2].id, 1)
        .is_err());
    assert_eq!(
        h.catalog
            .move_kanban_card(&a.id, &b.columns[2].id, 0)
            .unwrap()
            .position,
        0
    );
    assert_eq!(
        h.board()
            .cards
            .iter()
            .find(|c| c.id == z.id)
            .unwrap()
            .position,
        0
    );
    assert!(h.catalog.archive_kanban_card(&a.id, true).unwrap().archived);
    assert!(
        !h.catalog
            .archive_kanban_card(&a.id, false)
            .unwrap()
            .archived
    );
    assert!(h
        .catalog
        .create_kanban_card(&a.column_id, "bad\nname", "")
        .is_err());
    assert!(h
        .catalog
        .edit_kanban_card(&a.id, "A", &"a".repeat(1024 * 1024 + 1))
        .is_err());
    h.catalog
        .delete_kanban_card(&a.id, KanbanSessionDisposition::Detach)
        .unwrap();
    assert_eq!(h.board().cards.len(), 1);
}

#[test]
fn explicit_session_commands_add_attach_detach_merge_and_split() {
    let h = Harness::new();
    h.write("a", OLD, None);
    h.write("b", OLD, None);
    h.sync();
    let b = h.enable();
    assert!(h.board().cards.is_empty());
    let a = h.catalog.add_kanban_session(&h.session("a")).unwrap();
    assert_eq!(a.title, "Synthetic a");
    assert_eq!(
        h.catalog.add_kanban_session(&h.session("a")).unwrap().id,
        a.id
    );
    let task = h
        .catalog
        .create_kanban_card(&b.columns[1].id, "", "Task notes")
        .unwrap();
    let task = h
        .catalog
        .attach_kanban_session(&task.id, &h.session("a"))
        .unwrap();
    assert_eq!(task.title, "Synthetic a");
    assert_eq!(task.sessions.len(), 1);
    h.catalog
        .attach_kanban_session(&task.id, &h.session("a"))
        .unwrap();
    assert_eq!(h.card("a").unwrap().sessions.len(), 1);
    h.catalog
        .attach_kanban_session(&task.id, &h.session("b"))
        .unwrap();
    let split = h
        .catalog
        .split_kanban_session(&task.id, &h.session("b"))
        .unwrap();
    assert_eq!(split.position, task.position + 1);
    assert_eq!(split.title, "Synthetic b");
    assert_eq!(h.card("a").unwrap().sessions.len(), 1);
    assert!(h
        .catalog
        .split_kanban_session(&task.id, &h.session("b"))
        .is_err());
    let merged = h.catalog.merge_kanban_cards(&split.id, &task.id).unwrap();
    assert_eq!(merged.sessions.len(), 2);
    assert!(merged.notes.contains("Task notes"));
    assert!(merged.notes.contains("Synthetic b"));
    assert!(h.catalog.merge_kanban_cards(&task.id, &task.id).is_err());
    assert!(
        h.catalog
            .detach_kanban_session(&task.id, &h.session("a"))
            .unwrap()
            .sessions
            .len()
            == 1
    );
    assert!(h
        .catalog
        .detach_kanban_session(&task.id, &h.session("a"))
        .is_err());
    h.sync();
    assert!(h.card("a").is_none());
    assert!(h
        .catalog
        .attach_kanban_session(&task.id, "missing")
        .is_err());
    assert!(h.catalog.add_kanban_session("missing").is_err());
}

#[test]
fn delete_cards_can_return_sessions_to_unsorted_or_leave_the_board() {
    let h = Harness::new();
    h.enable();
    h.write("a", NEW, None);
    h.write("b", NEW, None);
    h.sync();
    let a = h.card("a").unwrap();
    let b = h.card("b").unwrap();
    h.catalog.merge_kanban_cards(&a.id, &b.id).unwrap();
    h.catalog
        .delete_kanban_card(&b.id, KanbanSessionDisposition::Unsorted)
        .unwrap();
    assert_ne!(h.card("a").unwrap().id, h.card("b").unwrap().id);
    assert!(h
        .board()
        .cards
        .iter()
        .all(|c| c.column_id == h.board().columns[0].id));
    h.catalog
        .delete_kanban_card(&h.card("a").unwrap().id, KanbanSessionDisposition::Detach)
        .unwrap();
    h.sync();
    assert!(h.card("a").is_none());
    assert!(h.catalog.session(&h.session("a")).is_ok());
}

#[test]
fn commands_reject_cross_project_columns_cards_and_sessions_without_mutating() {
    let h = Harness::new();
    let b = h.enable();
    let other = h.temp.path().join("other");
    fs::create_dir(&other).unwrap();
    let project = h
        .catalog
        .add_project(other.to_str().unwrap(), None)
        .unwrap();
    let other_board = h
        .catalog
        .set_kanban_board_enabled(&project.id, true)
        .unwrap();
    h.write("foreign", NEW, other.to_str());
    h.sync();
    let local = h
        .catalog
        .create_kanban_card(&b.columns[1].id, "Local", "")
        .unwrap();
    let foreign = h.card("foreign").unwrap();
    let revision = h.catalog.revision().unwrap();
    assert!(h
        .catalog
        .attach_kanban_session(&local.id, &h.session("foreign"))
        .is_err());
    assert!(h
        .catalog
        .move_kanban_card(&local.id, &other_board.columns[1].id, 0)
        .is_err());
    assert!(h
        .catalog
        .merge_kanban_cards(&foreign.id, &local.id)
        .is_err());
    assert!(h
        .catalog
        .delete_kanban_column(&b.columns[1].id, &other_board.columns[1].id)
        .is_err());
    assert_eq!(h.catalog.revision().unwrap(), revision);
}

#[test]
fn intake_only_adds_new_sessions_and_explicit_resumes_without_backfilling() {
    let h = Harness::new();
    h.write("existing", OLD, None);
    h.sync();
    h.enable();
    h.write("imported", OLD, None);
    h.write("new", NEW, None);
    h.sync();
    assert!(h.card("existing").is_none());
    assert!(h.card("imported").is_none());
    assert!(h.card("new").is_some());
    let resumed = h
        .catalog
        .kanban_session_resumed(&h.session("existing"))
        .unwrap()
        .unwrap();
    assert_eq!(resumed.sessions.len(), 1);
    assert_eq!(
        h.catalog
            .kanban_session_resumed(&h.session("existing"))
            .unwrap()
            .unwrap()
            .id,
        resumed.id
    );
    assert_eq!(h.board().cards.len(), 2);
    h.catalog
        .set_kanban_board_enabled(&h.project, false)
        .unwrap();
    h.write("disabled", NEW, None);
    h.sync();
    assert!(h.card("disabled").is_none());
    assert!(h
        .catalog
        .kanban_session_resumed(&h.session("disabled"))
        .unwrap()
        .is_none());
    h.enable();
    h.sync();
    assert!(h.card("disabled").is_none());
    h.catalog
        .add_kanban_session(&h.session("disabled"))
        .unwrap();
}

#[test]
fn child_sessions_follow_parents_even_when_discovered_first_or_without_cwd() {
    let h = Harness::new();
    h.enable();
    let parent = h.write("parent", NEW, None);
    let child = h.write("child", NEW, None);
    let grandchild = h.write("grandchild", NEW, None);
    fn set_parent(path: &std::path::Path, parent: &str, remove_cwd: bool) {
        let text = fs::read_to_string(path).unwrap();
        let mut lines: Vec<serde_json::Value> = text
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        lines[0]["payload"]["parent_session_id"] = json!(parent);
        if remove_cwd {
            lines[0]["payload"].as_object_mut().unwrap().remove("cwd");
        }
        fs::write(
            path,
            lines
                .into_iter()
                .map(|line| line.to_string() + "\n")
                .collect::<String>(),
        )
        .unwrap();
    }
    set_parent(&child, "parent", true);
    set_parent(&grandchild, "child", true);
    h.sync();
    let task = h.card("parent").unwrap();
    assert_eq!(task.sessions.len(), 3);
    assert_eq!(h.card("child").unwrap().id, task.id);
    assert_eq!(h.card("grandchild").unwrap().id, task.id);
    assert_eq!(h.board().cards.len(), 1);
    let planned = h
        .catalog
        .create_kanban_card(&h.board().columns[1].id, "Family", "")
        .unwrap();
    h.catalog
        .attach_kanban_session(&planned.id, &h.session("parent"))
        .unwrap();
    assert_eq!(h.card("child").unwrap().id, planned.id);
    assert_eq!(h.card("grandchild").unwrap().id, planned.id);
    h.catalog
        .detach_kanban_session(&planned.id, &h.session("child"))
        .unwrap();
    h.catalog
        .attach_kanban_session(&planned.id, &h.session("parent"))
        .unwrap();
    assert!(h.card("child").is_none());
    let late = h.write("late", NEW, None);
    set_parent(&late, "parent", true);
    h.sync();
    assert_eq!(h.card("late").unwrap().id, planned.id);
    // A disabled board must not make indexing a fresh child fail.
    h.catalog
        .set_kanban_board_enabled(&h.project, false)
        .unwrap();
    let disabled = h.write("disabled-child", NEW, None);
    set_parent(&disabled, "parent", true);
    h.sync();
    assert!(h.card("disabled-child").is_none());
    assert!(parent.exists());
}

#[test]
fn recycle_restore_missing_and_system_trash_preserve_empty_tasks() {
    let h = Harness::new();
    h.enable();
    let path = h.write("a", NEW, None);
    h.sync();
    let a = h.card("a").unwrap();
    let session = h.catalog.session(&h.session("a")).unwrap();
    let trash = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    assert!(h.card("a").unwrap().sessions.is_empty());
    h.catalog.restore_session(&trash).unwrap();
    assert_eq!(h.card("a").unwrap().id, a.id);
    assert_eq!(h.card("a").unwrap().sessions.len(), 1);
    fs::remove_file(path).unwrap();
    h.sync();
    assert!(h.card("a").is_none());
    assert!(h
        .board()
        .cards
        .iter()
        .any(|c| c.id == a.id && c.sessions.is_empty()));
    h.write("b", NEW, None);
    h.sync();
    let b = h.card("b").unwrap();
    let session = h.catalog.session(&h.session("b")).unwrap();
    let trash = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    h.catalog
        .purge_trashed(&trash, &session.id, 123, &[])
        .unwrap();
    assert!(h.card("b").is_none());
    assert!(h.board().cards.iter().any(|c| c.id == b.id));
    assert_eq!(h.catalog.os_trash_records().unwrap().len(), 1);
}

#[test]
fn rebuild_preserves_board_card_links_exclusions_and_recycle_visibility() {
    let h = Harness::new();
    h.enable();
    h.write("a", NEW, None);
    h.write("b", NEW, None);
    h.sync();
    let a = h.card("a").unwrap();
    let b = h.card("b").unwrap();
    h.catalog
        .detach_kanban_session(&b.id, &h.session("b"))
        .unwrap();
    let session = h.catalog.session(&h.session("a")).unwrap();
    let trash = h
        .catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    h.catalog.archive_kanban_card(&a.id, true).unwrap();
    h.catalog.clear().unwrap();
    assert_eq!(h.board().cards.len(), 2);
    assert!(h.board().cards.iter().all(|c| c.sessions.is_empty()));
    h.sync();
    assert_eq!(h.board().cards.len(), 2);
    assert!(h.card("a").unwrap().archived);
    assert!(h.card("a").unwrap().sessions.is_empty());
    assert!(h.card("b").is_none());
    h.catalog.restore_session(&trash).unwrap();
    assert_eq!(h.card("a").unwrap().id, a.id);
    assert_eq!(h.card("a").unwrap().sessions.len(), 1);
}

#[test]
fn rebuild_detaches_confirmed_missing_sessions_but_not_unavailable_sources() {
    let h = Harness::new();
    h.enable();
    let path = h.write("a", NEW, None);
    h.sync();
    h.catalog.clear().unwrap();
    fs::remove_file(path).unwrap();
    h.sync();
    assert_eq!(
        h.db()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM kanban_card_sessions", [], |r| r
                .get(0))
            .unwrap(),
        0
    );
    h.write("b", NEW, None);
    h.sync();
    let unavailable = h.temp.path().join("unavailable");
    fs::rename(&h.source.root, &unavailable).unwrap();
    h.catalog.clear().unwrap();
    h.catalog
        .sync(
            std::slice::from_ref(&h.source),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    assert_eq!(
        h.db()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM kanban_card_sessions", [], |r| r
                .get(0))
            .unwrap(),
        1
    );
    fs::rename(unavailable, &h.source.root).unwrap();
    h.sync();
    assert!(h.card("b").is_some());
}

#[test]
fn migration_from_v6_retains_catalog_choices_and_does_not_intake_old_history() {
    let h = Harness::new();
    h.write("old", OLD, None);
    h.sync();
    let session = h.catalog.session(&h.session("old")).unwrap();
    h.catalog
        .trash_session(&session.id, session.trash_identity.as_deref().unwrap())
        .unwrap();
    h.catalog
        .update_project(&h.project, None, None, None, Some("Chosen name"))
        .unwrap();
    let db = h.db();
    let triggers = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'revision_kanban_%'",
        )
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for trigger in triggers {
        db.execute_batch(&format!("DROP TRIGGER {trigger}"))
            .unwrap();
    }
    db.execute_batch("DROP TABLE kanban_card_sessions; DROP TABLE kanban_resume_requests; DROP TABLE kanban_observed_sessions; DROP TABLE kanban_cards; DROP TABLE kanban_columns; DROP TABLE kanban_boards; PRAGMA user_version=6;").unwrap();
    let migrated = Catalog::open(&h.temp.path().join("catalog.sqlite")).unwrap();
    assert_eq!(
        db.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        8
    );
    assert_eq!(migrated.projects().unwrap()[0].name, "Chosen name");
    assert_eq!(migrated.trashed_sessions(0, 10).unwrap().total, 1);
    assert_eq!(migrated.session(&session.id).unwrap().title, session.title);
    assert!(migrated
        .set_kanban_board_enabled(&h.project, true)
        .unwrap()
        .cards
        .is_empty());
    let revision = migrated.revision().unwrap();
    let b = migrated.kanban_board(&h.project).unwrap().unwrap();
    migrated
        .create_kanban_card(&b.columns[1].id, "Persist", "")
        .unwrap();
    assert!(migrated.revision().unwrap() > revision);
    let reopened = Catalog::open(&h.temp.path().join("catalog.sqlite")).unwrap();
    assert_eq!(
        reopened
            .kanban_board(&h.project)
            .unwrap()
            .unwrap()
            .cards
            .len(),
        1
    );
}

#[test]
fn linked_worktree_sessions_map_to_main_board_and_keep_branch_metadata() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let h = Harness::new();
    fn git(cwd: &str, args: &[&str], input: Option<&str>) -> String {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            );
        if input.is_some() {
            command.stdin(Stdio::piped());
        }
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        if let Some(input) = input {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
        }
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8(result.stdout).unwrap().trim().into()
    }
    // Build a minimal synthetic object graph without invoking git commit.
    git(&h.cwd, &["init", "--initial-branch=main"], None);
    let tree = git(
        &h.cwd,
        &["hash-object", "-t", "tree", "-w", "--stdin"],
        Some(""),
    );
    let commit=git(&h.cwd,&["hash-object","-t","commit","-w","--stdin"],Some(&format!("tree {tree}\nauthor Synthetic <synthetic@example.invalid> 1700000000 +0000\ncommitter Synthetic <synthetic@example.invalid> 1700000000 +0000\n\nSynthetic\n")));
    git(&h.cwd, &["update-ref", "HEAD", &commit], None);
    let linked = h.temp.path().join("linked");
    git(
        &h.cwd,
        &[
            "worktree",
            "add",
            "-b",
            "feature/synthetic",
            linked.to_str().unwrap(),
        ],
        None,
    );
    let board = h.enable();
    let planned = h
        .catalog
        .create_kanban_card(&board.columns[1].id, "Worktree task", "")
        .unwrap();
    assert!(h.catalog.bind_kanban_worktree(&planned.id, &h.cwd).is_err());
    h.catalog
        .bind_kanban_worktree(&planned.id, linked.to_str().unwrap())
        .unwrap();
    let other = h
        .catalog
        .create_kanban_card(&board.columns[1].id, "Other", "")
        .unwrap();
    assert!(h
        .catalog
        .bind_kanban_worktree(&other.id, linked.to_str().unwrap())
        .is_err());
    h.write("root", NEW, linked.to_str());
    h.sync();
    assert_eq!(h.card("root").unwrap().id, planned.id);
    h.catalog.clear().unwrap();
    assert_eq!(
        h.board()
            .cards
            .iter()
            .find(|c| c.id == planned.id)
            .unwrap()
            .worktree_path
            .as_deref(),
        linked.canonicalize().unwrap().to_str()
    );
    let nested = linked.join("nested");
    fs::create_dir(&nested).unwrap();
    h.write("linked", NEW, nested.to_str());
    h.sync();
    let card = h.card("linked").unwrap();
    assert_eq!(card.project_id, h.project);
    assert_eq!(card.id, planned.id);
    let link = card
        .sessions
        .iter()
        .find(|link| link.session.id == h.session("linked"))
        .unwrap();
    assert_eq!(link.branch.as_deref(), Some("feature/synthetic"));
    assert_eq!(link.session.cwd.as_deref(), nested.to_str());
}

#[test]
fn concurrent_commands_allocate_distinct_positions_and_reads_do_not_change_revision() {
    let h = Harness::new();
    let b = h.enable();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|i| {
            let catalog = h.catalog.clone();
            let column = b.columns[1].id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                catalog
                    .create_kanban_card(&column, &format!("Task {i}"), "")
                    .unwrap();
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let revision = h.catalog.revision().unwrap();
    let board = h.board();
    assert_eq!(
        board.cards.iter().map(|c| c.position).collect::<Vec<_>>(),
        (0..8).collect::<Vec<_>>()
    );
    h.catalog.list_kanban_boards().unwrap();
    assert_eq!(h.catalog.revision().unwrap(), revision);
}

#[test]
fn activity_on_old_history_and_manual_resumes_before_indexing_request_intake() {
    let h = Harness::new();
    let path = h.write("old", OLD, None);
    h.sync();
    h.enable();
    assert!(h.card("old").is_none());
    use std::io::Write;
    let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(file,"{}",json!({"timestamp":NEW,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Synthetic resumed activity"}]}})).unwrap();
    drop(file);
    h.sync();
    assert!(h.card("old").is_some());
    h.catalog
        .request_kanban_resume(&h.source, "manual")
        .unwrap();
    h.write("manual", OLD, None);
    h.sync();
    assert!(h.card("manual").is_some());
    h.catalog
        .detach_kanban_session(&h.card("manual").unwrap().id, &h.session("manual"))
        .unwrap();
    h.catalog
        .request_kanban_resume(&h.source, "manual")
        .unwrap();
    assert!(h.card("manual").is_some());
    assert_eq!(
        h.db()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM kanban_resume_requests", [], |r| r
                .get(0))
            .unwrap(),
        0
    );
}

#[test]
fn deleting_a_family_returns_parent_and_children_to_one_unsorted_card() {
    let h = Harness::new();
    h.enable();
    let parent = h.write("parent", NEW, None);
    let child = h.write("child", NEW, None);
    let text = fs::read_to_string(&child).unwrap().replace(
        "\"id\":\"child\"",
        "\"id\":\"child\",\"parent_session_id\":\"parent\"",
    );
    fs::write(child, text).unwrap();
    h.sync();
    let task = h.card("parent").unwrap();
    assert_eq!(h.card("child").unwrap().id, task.id);
    h.catalog
        .delete_kanban_card(&task.id, KanbanSessionDisposition::Unsorted)
        .unwrap();
    assert_eq!(h.card("parent").unwrap().id, h.card("child").unwrap().id);
    assert_eq!(h.board().cards.len(), 1);
    assert!(parent.exists());
}

#[test]
fn a_new_child_intakes_an_older_parent_but_explicit_child_exclusions_survive_activity() {
    use std::io::Write;
    let h = Harness::new();
    h.write("parent", OLD, None);
    h.sync();
    h.enable();
    let child = h.write("child", NEW, None);
    let text = fs::read_to_string(&child).unwrap().replace(
        "\"id\":\"child\"",
        "\"id\":\"child\",\"parent_session_id\":\"parent\"",
    );
    fs::write(&child, text).unwrap();
    h.sync();
    let task = h.card("parent").unwrap();
    assert_eq!(h.card("child").unwrap().id, task.id);
    h.catalog
        .detach_kanban_session(&task.id, &h.session("child"))
        .unwrap();
    let mut file = fs::OpenOptions::new().append(true).open(child).unwrap();
    writeln!(file,"{}",json!({"timestamp":"2099-01-02T00:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Synthetic child activity"}]}})).unwrap();
    drop(file);
    h.sync();
    assert!(h.card("child").is_none());
}

#[test]
fn disabled_sources_preserve_links_and_replaced_or_removed_sources_detach_them() {
    let h = Harness::new();
    h.enable();
    h.write("a", NEW, None);
    h.sync();
    let original = h.card("a").unwrap();
    let mut disabled = h.source.clone();
    disabled.enabled = false;
    h.catalog
        .sync(&[disabled], &AtomicBool::new(false), |_| {})
        .unwrap();
    assert!(h.card("a").is_none());
    h.sync();
    assert_eq!(h.card("a").unwrap().id, original.id);
    let replacement = h.temp.path().join("replacement");
    fs::create_dir(&replacement).unwrap();
    let mut source = h.source.clone();
    source.root = replacement.to_string_lossy().into_owned();
    h.catalog
        .sync(&[source], &AtomicBool::new(false), |_| {})
        .unwrap();
    assert!(h.card("a").is_none());
    assert!(h
        .board()
        .cards
        .iter()
        .any(|c| c.id == original.id && c.sessions.is_empty()));
    h.sync();
    // The original observed identity remains excluded after source replacement.
    assert!(h.card("a").is_none());
    h.catalog.add_kanban_session(&h.session("a")).unwrap();
    h.catalog.clear().unwrap();
    h.catalog
        .sync(&[], &AtomicBool::new(false), |_| {})
        .unwrap();
    assert_eq!(
        h.db()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM kanban_card_sessions", [], |r| r
                .get(0))
            .unwrap(),
        0
    );
}

#[test]
fn enabling_another_board_does_not_consume_pending_intake() {
    let h = Harness::new();
    h.enable();
    h.write("pending", NEW, None);
    h.sync();
    // Model the committed index rows before a scan reaches board reconciliation.
    h.db().execute_batch("DELETE FROM kanban_card_sessions; DELETE FROM kanban_cards; DELETE FROM kanban_observed_sessions;").unwrap();
    let path = h.temp.path().join("other-board");
    fs::create_dir(&path).unwrap();
    let project = h.catalog.add_project(path.to_str().unwrap(), None).unwrap();
    h.catalog
        .set_kanban_board_enabled(&project.id, true)
        .unwrap();
    h.sync();
    assert!(h.card("pending").is_some());
    assert!(h
        .catalog
        .kanban_board(&project.id)
        .unwrap()
        .unwrap()
        .cards
        .is_empty());
}

#[test]
fn auto_archive_is_opt_in_stage_based_recoverable_and_survives_rebuild() {
    let h = Harness::new();
    let b = h.enable();
    let done = h
        .catalog
        .create_kanban_card(&b.columns[4].id, "Old completed task", "Notes")
        .unwrap();
    let todo = h
        .catalog
        .create_kanban_card(&b.columns[1].id, "Old planned task", "")
        .unwrap();
    h.db()
        .execute(
            "UPDATE kanban_cards SET updated_at='2020-01-01T00:00:00Z'",
            [],
        )
        .unwrap();
    assert!(h.board().cards.iter().all(|c| !c.archived));
    assert!(h
        .catalog
        .set_kanban_auto_archive(&h.project, Some(0))
        .is_err());
    h.catalog
        .set_kanban_auto_archive(&h.project, Some(7))
        .unwrap();
    let board = h.board();
    assert_eq!(board.auto_archive_days, Some(7));
    assert!(
        board
            .cards
            .iter()
            .find(|c| c.id == done.id)
            .unwrap()
            .archived
    );
    assert!(
        !board
            .cards
            .iter()
            .find(|c| c.id == todo.id)
            .unwrap()
            .archived
    );
    h.catalog.archive_kanban_card(&done.id, false).unwrap();
    assert!(
        !h.board()
            .cards
            .iter()
            .find(|c| c.id == done.id)
            .unwrap()
            .archived
    );
    h.catalog.clear().unwrap();
    assert_eq!(h.board().auto_archive_days, Some(7));
    assert_eq!(h.board().cards.len(), 2);
    h.catalog.set_kanban_auto_archive(&h.project, None).unwrap();
    assert_eq!(h.board().auto_archive_days, None);
}

#[test]
fn launched_sessions_wait_for_exact_provider_identity_and_keep_the_planned_card() {
    let h = Harness::new();
    // Configure the synthetic source before launching; no real agent data is involved.
    h.sync();
    let b = h.enable();
    let planned = h
        .catalog
        .create_kanban_card(&b.columns[1].id, "Planned work", "Keep notes")
        .unwrap();
    h.catalog
        .validate_kanban_launch(&planned.id, Some(&h.project))
        .unwrap();
    assert!(h
        .catalog
        .validate_kanban_launch(&planned.id, Some("different-project"))
        .is_err());
    h.catalog
        .validate_kanban_launch_cwd(&planned.id, std::path::Path::new(&h.cwd))
        .unwrap();
    assert!(h
        .catalog
        .validate_kanban_launch_cwd(&planned.id, h.temp.path())
        .is_err());
    h.catalog
        .record_kanban_launch(&planned.id, "synthetic-runtime", "codex")
        .unwrap();
    // The handshake may arrive before the transcript. Persist it through index rebuilds.
    h.catalog
        .reconcile_kanban_launch("synthetic-runtime", "started")
        .unwrap();
    h.catalog.clear().unwrap();
    h.write("unrelated", NEW, None);
    h.write("started", NEW, None);
    h.sync();
    h.catalog
        .reconcile_kanban_launch("synthetic-runtime", "started")
        .unwrap();
    assert_eq!(h.card("started").unwrap().id, planned.id);
    assert_ne!(h.card("unrelated").unwrap().id, planned.id);
    assert_eq!(h.card("started").unwrap().notes, "Keep notes");
    assert_eq!(h.board().cards.len(), 2);
    h.catalog.archive_kanban_card(&planned.id, true).unwrap();
    assert!(h
        .catalog
        .validate_kanban_launch(&planned.id, Some(&h.project))
        .is_err());
}

#[test]
fn launch_source_replacement_never_attaches_a_reused_native_id() {
    let h = Harness::new();
    h.sync();
    let b = h.enable();
    let planned = h
        .catalog
        .create_kanban_card(&b.columns[1].id, "Planned", "")
        .unwrap();
    h.catalog
        .record_kanban_launch(&planned.id, "synthetic-runtime", "codex")
        .unwrap();
    h.catalog
        .reconcile_kanban_launch("synthetic-runtime", "reused")
        .unwrap();
    let replacement = h.temp.path().join("replacement");
    fs::create_dir(&replacement).unwrap();
    let source = HistorySource {
        root: replacement.to_string_lossy().into_owned(),
        ..h.source.clone()
    };
    let other = Harness { source, ..h };
    other.write("reused", NEW, None);
    other.sync();
    other
        .catalog
        .reconcile_kanban_launch("synthetic-runtime", "reused")
        .unwrap();
    assert!(other
        .board()
        .cards
        .iter()
        .find(|c| c.id == planned.id)
        .unwrap()
        .sessions
        .is_empty());
    assert_ne!(other.card("reused").unwrap().id, planned.id);
}

#[test]
fn delayed_launch_identity_does_not_override_explicit_attachment_or_exclusion() {
    let h = Harness::new();
    h.sync();
    let b = h.enable();
    let planned = h
        .catalog
        .create_kanban_card(&b.columns[1].id, "Planned", "")
        .unwrap();
    let chosen = h
        .catalog
        .create_kanban_card(&b.columns[1].id, "User choice", "")
        .unwrap();
    h.catalog
        .record_kanban_launch(&planned.id, "late-runtime", "codex")
        .unwrap();
    h.write("late", NEW, None);
    h.sync();
    h.catalog
        .attach_kanban_session(&chosen.id, &h.session("late"))
        .unwrap();
    h.catalog
        .reconcile_kanban_launch("late-runtime", "late")
        .unwrap();
    assert_eq!(h.card("late").unwrap().id, chosen.id);
    h.catalog
        .record_kanban_launch(&planned.id, "excluded-runtime", "codex")
        .unwrap();
    h.write("excluded", NEW, None);
    h.sync();
    let automatic = h.card("excluded").unwrap();
    h.catalog
        .detach_kanban_session(&automatic.id, &h.session("excluded"))
        .unwrap();
    h.catalog
        .reconcile_kanban_launch("excluded-runtime", "excluded")
        .unwrap();
    assert!(h.card("excluded").is_none());
}

#[test]
fn ambiguous_configured_sources_require_explicit_attachment() {
    let h = Harness::new();
    let other_root = h.temp.path().join("other-history");
    fs::create_dir(&other_root).unwrap();
    let second = HistorySource {
        id: "second".into(),
        root: other_root.to_string_lossy().into_owned(),
        ..h.source.clone()
    };
    h.catalog
        .sync(
            &[h.source.clone(), second.clone()],
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    let b = h.enable();
    let planned = h
        .catalog
        .create_kanban_card(&b.columns[1].id, "Planned", "")
        .unwrap();
    h.catalog
        .record_kanban_launch(&planned.id, "ambiguous-runtime", "codex")
        .unwrap();
    h.write("same-id", NEW, None);
    h.catalog
        .sync(&[h.source.clone(), second], &AtomicBool::new(false), |_| {})
        .unwrap();
    h.catalog
        .reconcile_kanban_launch("ambiguous-runtime", "same-id")
        .unwrap();
    assert_ne!(h.card("same-id").unwrap().id, planned.id);
}
