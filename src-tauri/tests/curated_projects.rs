#[path = "support/revision_schema.rs"]
mod revision_schema;
use rusqlite::{params, Connection};
use serde_json::json;
use sessionbay_lib::{
    catalog::Catalog,
    models::{AgentKind, HistorySource, Project, SessionQuery},
};
use std::{fs, path::Path, sync::atomic::AtomicBool};

fn source(root: &Path) -> HistorySource {
    HistorySource {
        id: "synthetic-history".into(),
        kind: AgentKind::Codex,
        root: root.join("history").to_string_lossy().into_owned(),
        enabled: true,
    }
}

fn write_history(source: &HistorySource, id: &str, cwd: Option<&Path>) -> std::path::PathBuf {
    let dir = Path::new(&source.root).join("sessions");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{id}.jsonl"));
    fs::write(&path, format!("{}\n{}\n",
        json!({"type":"session_meta","payload":{"id":id,"cwd":cwd}}),
        json!({"type":"response_item","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Synthetic curated project history"}]}}),
    )).unwrap();
    path
}

fn sync(catalog: &Catalog, source: &HistorySource) {
    let status = catalog
        .sync(
            std::slice::from_ref(source),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
    assert!(status.errors.is_empty(), "{:?}", status.errors);
}

fn project(catalog: &Catalog, id: &str) -> Project {
    catalog
        .projects()
        .unwrap()
        .into_iter()
        .find(|p| p.id == id)
        .unwrap()
}

#[test]
fn membership_pin_rename_and_removal_leave_sessions_and_launch_metadata_intact() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let catalog = Catalog::open(&root.join("catalog.sqlite")).unwrap();
    let source = source(root);
    let missing = root.join("missing-original");
    let file = write_history(&source, "one", Some(&missing));
    let original = fs::read(&file).unwrap();
    sync(&catalog, &source);
    let discovered = catalog.projects().unwrap().remove(0);
    assert!(!discovered.curated && !discovered.pinned && !discovered.exists);
    let relocated = root.join("relocated");
    fs::create_dir(&relocated).unwrap();
    let renamed = catalog
        .update_project(
            &discovered.id,
            None,
            Some(relocated.to_str().unwrap()),
            None,
            Some("Chosen name"),
        )
        .unwrap();
    assert!(!renamed.curated);
    let curated = catalog
        .update_project(&discovered.id, None, None, Some(true), None)
        .unwrap();
    assert!(curated.curated && !curated.pinned);
    assert_eq!(curated.path, discovered.path);
    let pinned = catalog
        .update_project(&discovered.id, Some(true), None, None, None)
        .unwrap();
    assert!(pinned.curated && pinned.pinned);
    let unpinned = catalog
        .update_project(&discovered.id, Some(false), None, None, None)
        .unwrap();
    assert!(unpinned.curated && !unpinned.pinned);
    // Explicit removal takes precedence even in an inconsistent caller payload.
    let removed = catalog
        .update_project(&discovered.id, Some(true), None, Some(false), None)
        .unwrap();
    assert!(!removed.curated && !removed.pinned);
    assert_eq!(removed.path, discovered.path);
    assert_eq!(removed.launch_path.as_deref(), relocated.to_str());
    assert_eq!(removed.name, "Chosen name");
    assert_eq!(removed.session_count, 1);
    sync(&catalog, &source);
    let sessions = catalog.query(&SessionQuery::default()).unwrap();
    assert_eq!(sessions.total, 1);
    assert_eq!(sessions.items[0].project_id, removed.id);
    assert_eq!(sessions.items[0].cwd.as_deref(), missing.to_str());
    assert!(catalog.resume_source(&sessions.items[0].id).is_ok());
    assert!(!project(&catalog, &removed.id).curated);
    assert_eq!(fs::read(file).unwrap(), original);
    assert!(relocated.is_dir());
}

#[test]
fn missing_history_can_be_curated_but_unclassified_requires_real_relocation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let catalog = Catalog::open(&root.join("catalog.sqlite")).unwrap();
    let source = source(root);
    let missing = root.join("missing");
    write_history(&source, "known", Some(&missing));
    write_history(&source, "unknown", None);
    sync(&catalog, &source);
    let projects = catalog.projects().unwrap();
    let known = projects.iter().find(|p| p.path.is_some()).unwrap();
    let unknown = projects.iter().find(|p| p.path.is_none()).unwrap();
    assert!(
        catalog
            .update_project(&known.id, None, None, Some(true), None)
            .unwrap()
            .curated
    );
    assert!(catalog
        .add_project(missing.to_str().unwrap(), None)
        .is_err());
    assert!(catalog
        .update_project(&unknown.id, None, None, Some(true), None)
        .is_err());
    assert!(catalog
        .update_project(&unknown.id, Some(true), None, None, None)
        .is_err());
    assert!(catalog
        .update_project(
            &unknown.id,
            None,
            Some(missing.to_str().unwrap()),
            Some(true),
            None
        )
        .is_err());
    let relocated = catalog
        .update_project(
            &unknown.id,
            Some(true),
            Some(root.to_str().unwrap()),
            None,
            Some("Relocated unknown"),
        )
        .unwrap();
    assert!(relocated.curated && relocated.pinned);
    assert!(relocated.path.is_none());
    assert!(catalog
        .update_project(&unknown.id, None, Some(""), None, None)
        .is_err());
    let removed = catalog
        .update_project(&unknown.id, None, None, Some(false), None)
        .unwrap();
    assert!(!removed.curated && !removed.pinned);
    assert_eq!(removed.launch_path, relocated.launch_path);
    assert_eq!(catalog.query(&SessionQuery::default()).unwrap().total, 2);
}

#[test]
fn curated_choices_and_custom_names_survive_restart_clear_and_reindex() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let db = root.join("catalog.sqlite");
    let catalog = Catalog::open(&db).unwrap();
    let source = source(root);
    let cwd = root.join("project");
    fs::create_dir(&cwd).unwrap();
    write_history(&source, "one", Some(&cwd));
    sync(&catalog, &source);
    let before = catalog.projects().unwrap().remove(0);
    let added = catalog
        .add_project(cwd.to_str().unwrap(), Some("Custom title"))
        .unwrap();
    assert_eq!(before.id, added.id);
    assert!(added.curated);
    assert_eq!(added.session_count, 1);
    catalog
        .update_project(&added.id, Some(true), None, None, None)
        .unwrap();
    catalog
        .update_project(&added.id, Some(false), None, None, None)
        .unwrap();
    catalog.clear().unwrap();
    let reopened = Catalog::open(&db).unwrap();
    let selected = project(&reopened, &added.id);
    assert!(selected.curated && !selected.pinned);
    assert_eq!(selected.name, "Custom title");
    assert_eq!(selected.session_count, 0);
    sync(&reopened, &source);
    assert_eq!(project(&reopened, &added.id).session_count, 1);
    assert!(project(&reopened, &added.id).curated);
    reopened
        .update_project(&added.id, None, None, Some(false), None)
        .unwrap();
    reopened.clear().unwrap();
    let reopened = Catalog::open(&db).unwrap();
    sync(&reopened, &source);
    assert!(!project(&reopened, &added.id).curated);
    assert_eq!(project(&reopened, &added.id).name, "Custom title");
    assert_eq!(reopened.projects().unwrap().len(), 1);
}

#[test]
fn version_two_migration_preserves_only_manual_or_pinned_membership() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let db = root.join("catalog.sqlite");
    let catalog = Catalog::open(&db).unwrap();
    let source = source(root);
    for id in ["manual", "pinned", "automatic", "relocated"] {
        write_history(&source, id, Some(&root.join(id)));
    }
    sync(&catalog, &source);
    let before = catalog.query(&SessionQuery::default()).unwrap();
    let conn = Connection::open(&db).unwrap();
    conn.execute("UPDATE projects SET manual=(name='manual'),pinned=(name='pinned'),launch_path=CASE WHEN name='relocated' THEN ?1 ELSE NULL END", [root.to_str().unwrap()]).unwrap();
    revision_schema::remove_revision_schema(&conn);
    conn.execute_batch("DROP TABLE project_directories; DROP TABLE session_trash; ALTER TABLE sources DROP COLUMN storage_root; PRAGMA user_version=2;")
        .unwrap();
    drop(conn);
    let migrated = Catalog::open(&db).unwrap();
    for project in migrated.projects().unwrap() {
        assert_eq!(
            project.curated,
            ["manual", "pinned"].contains(&project.name.as_str())
        );
        assert_eq!(project.pinned, project.name == "pinned");
        assert_eq!(project.session_count, 1);
        if project.name == "relocated" {
            assert_eq!(project.launch_path.as_deref(), root.to_str());
        }
    }
    let after = migrated.query(&SessionQuery::default()).unwrap();
    assert_eq!(
        serde_json::to_value((&before.items, before.total)).unwrap(),
        serde_json::to_value((&after.items, after.total)).unwrap()
    );
    let reopened = Catalog::open(&db).unwrap();
    assert_eq!(
        reopened
            .projects()
            .unwrap()
            .iter()
            .filter(|p| p.curated)
            .count(),
        2
    );
    let conn = Connection::open(&db).unwrap();
    assert_eq!(
        conn.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
            .unwrap(),
        6
    );
}

#[test]
fn create_project_is_exclusive_and_rejects_unsafe_names_or_missing_parents() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let catalog = Catalog::open(&root.join("catalog.sqlite")).unwrap();
    let parent = root.join("parent");
    fs::create_dir(&parent).unwrap();
    let existing = parent.join("existing");
    fs::create_dir(&existing).unwrap();
    fs::write(existing.join("keep.txt"), "original").unwrap();
    let file = parent.join("file");
    fs::write(&file, "original file").unwrap();
    for name in [
        "",
        " ",
        ".",
        "..",
        "../escape",
        "nested/child",
        "nested\\child",
        "/absolute",
        "nul\0name",
        "line\nname",
        "existing",
        "file",
    ] {
        assert!(
            catalog
                .create_project(parent.to_str().unwrap(), name)
                .is_err(),
            "accepted {name:?}"
        );
    }
    assert!(catalog
        .create_project(parent.to_str().unwrap(), &"a".repeat(256))
        .is_err());
    assert!(catalog.create_project("relative", "new").is_err());
    assert!(catalog
        .create_project(file.to_str().unwrap(), "new")
        .is_err());
    let missing_parent = root.join("missing/parent");
    assert!(catalog
        .create_project(missing_parent.to_str().unwrap(), "new")
        .is_err());
    assert!(!root.join("missing").exists());
    assert!(!parent.join("nested").exists());
    assert!(!root.join("escape").exists());
    assert!(catalog.projects().unwrap().is_empty());
    let name = "中文 project ;$(literal)";
    let created = catalog
        .create_project(parent.to_str().unwrap(), name)
        .unwrap();
    assert!(created.curated && created.exists && !created.pinned);
    assert_eq!(created.name, name);
    assert_eq!(
        created.path.as_deref(),
        parent.canonicalize().unwrap().join(name).to_str()
    );
    assert_eq!(created.session_count, 0);
    assert!(parent.join(name).is_dir());
    assert!(catalog
        .create_project(parent.to_str().unwrap(), name)
        .is_err());
    assert_eq!(
        fs::read_to_string(existing.join("keep.txt")).unwrap(),
        "original"
    );
    assert_eq!(fs::read_to_string(file).unwrap(), "original file");
}

#[test]
fn create_existing_history_location_reuses_identity_without_rewriting_cwd() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let catalog = Catalog::open(&root.join("catalog.sqlite")).unwrap();
    let source = source(root);
    let cwd = root.canonicalize().unwrap().join("future-project");
    write_history(&source, "one", Some(&cwd));
    sync(&catalog, &source);
    let before = catalog.projects().unwrap().remove(0);
    let created = catalog
        .create_project(root.to_str().unwrap(), "future-project")
        .unwrap();
    assert_eq!(created.id, before.id);
    assert_eq!(created.path, before.path);
    assert_eq!(created.session_count, 1);
    assert!(created.curated && created.exists);
    catalog.clear().unwrap();
    sync(&catalog, &source);
    let session = catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    assert_eq!(session.cwd.as_deref(), cwd.to_str());
    assert_eq!(session.project_id, before.id);
}

#[test]
#[cfg(unix)]
fn adding_newly_resolvable_canonical_alias_preserves_historical_group() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let catalog = Catalog::open(&root.join("catalog.sqlite")).unwrap();
    let source = source(root);
    let alias = root.join("historical-alias");
    let canonical = root.join("real-project");
    write_history(&source, "one", Some(&alias));
    sync(&catalog, &source);
    let before = catalog.projects().unwrap().remove(0);
    fs::create_dir(&canonical).unwrap();
    symlink(&canonical, &alias).unwrap();
    let added = catalog
        .add_project(canonical.to_str().unwrap(), Some("Matched history"))
        .unwrap();
    assert_eq!(added.id, before.id);
    assert_eq!(added.path.as_deref(), alias.to_str());
    assert_eq!(added.session_count, 1);
    write_history(&source, "two", Some(&canonical));
    catalog.clear().unwrap();
    sync(&catalog, &source);
    let projects = catalog.projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, before.id);
    assert_eq!(projects[0].session_count, 2);
    let sessions = catalog.query(&SessionQuery::default()).unwrap();
    assert_eq!(
        sessions
            .items
            .iter()
            .find(|s| s.external_id == "one")
            .unwrap()
            .cwd
            .as_deref(),
        alias.to_str()
    );
    assert_eq!(
        sessions
            .items
            .iter()
            .find(|s| s.external_id == "two")
            .unwrap()
            .cwd
            .as_deref(),
        canonical.to_str()
    );
}

#[test]
fn invalid_project_names_are_atomic_and_indexing_does_not_reset_membership() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let catalog = Catalog::open(&root.join("catalog.sqlite")).unwrap();
    let source = source(root);
    write_history(&source, "one", Some(root));
    sync(&catalog, &source);
    let project = catalog.projects().unwrap().remove(0);
    for name in ["", " ", "bad\0name", "bad\nname"] {
        assert!(catalog
            .add_project(root.to_str().unwrap(), Some(name))
            .is_err());
        assert!(catalog
            .update_project(&project.id, Some(true), None, None, Some(name))
            .is_err());
    }
    assert!(!catalog.projects().unwrap()[0].curated);
    let scanner = catalog.clone();
    let history = source.clone();
    let worker = std::thread::spawn(move || {
        use std::io::Write;
        let path = Path::new(&history.root).join("sessions/one.jsonl");
        for i in 0..20 {
            // Force incremental writes as well as source reconciliation while
            // the other connection changes curated metadata.
            writeln!(fs::OpenOptions::new().append(true).open(&path).unwrap(), "{}",
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":format!("Append {i}")}]}})
            ).unwrap();
            let transient = write_history(&history, "temporary", Some(Path::new(&history.root)));
            sync(&scanner, &history);
            fs::remove_file(transient).unwrap();
            sync(&scanner, &history);
        }
    });
    for i in 0..20 {
        let name = format!("Choice {i}");
        catalog
            .update_project(&project.id, Some(true), None, None, Some(&name))
            .unwrap();
        catalog
            .update_project(&project.id, Some(false), None, None, None)
            .unwrap();
    }
    worker.join().unwrap();
    let chosen = catalog
        .projects()
        .unwrap()
        .into_iter()
        .find(|p| p.id == project.id)
        .unwrap();
    assert!(chosen.curated && !chosen.pinned);
    assert_eq!(chosen.name, "Choice 19");
    assert_eq!(chosen.session_count, 1);
    let conn = Connection::open(root.join("catalog.sqlite")).unwrap();
    let aliases: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM project_directories WHERE project_id=?1",
            params![chosen.id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(aliases >= 1);
}

#[test]
#[cfg(unix)]
fn adding_canonical_directory_after_alias_removal_restores_launch_path() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let catalog = Catalog::open(&root.join("catalog.sqlite")).unwrap();
    let source = source(root);
    let canonical = root.join("real-project");
    let alias = root.join("historical-alias");
    fs::create_dir(&canonical).unwrap();
    symlink(&canonical, &alias).unwrap();
    let history = write_history(&source, "one", Some(&alias));
    let original = fs::read(&history).unwrap();
    sync(&catalog, &source);
    let before = catalog.projects().unwrap().remove(0);
    assert_eq!(before.path.as_deref(), alias.to_str());
    assert!(before.launch_path.is_none());
    fs::remove_file(&alias).unwrap();
    assert!(!project(&catalog, &before.id).exists);

    let added = catalog
        .add_project(canonical.to_str().unwrap(), None)
        .unwrap();
    assert_eq!(added.id, before.id);
    assert_eq!(added.path, before.path);
    assert_eq!(added.launch_path.as_deref(), canonical.to_str());
    assert!(added.curated && added.exists);
    assert_eq!(added.session_count, 1);
    catalog.clear().unwrap();
    sync(&catalog, &source);
    let session = catalog
        .query(&SessionQuery::default())
        .unwrap()
        .items
        .remove(0);
    assert_eq!(session.project_id, before.id);
    assert_eq!(session.cwd.as_deref(), alias.to_str());
    assert!(project(&catalog, &before.id).exists);
    assert_eq!(fs::read(history).unwrap(), original);
}
