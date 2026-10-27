//! Linked worktree management against synthetic repositories only.
#[path = "support/git_fixture.rs"]
mod git_fixture;

use git_fixture::{commit_file, git, init_repo, temp};
use serde_json::{json, Value};
use sessionbay_lib::git::{GitRequest, GitService, ProjectGit};
use std::{
    fs,
    path::{Path, PathBuf},
};

struct Fixture {
    _temp: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    service: GitService,
}

impl Fixture {
    fn new() -> Self {
        let (temp, base) = temp();
        let root = init_repo(&base.join("app"));
        commit_file(&root, "readme.txt", b"one\n", "initial");
        Self {
            _temp: temp,
            base,
            root,
            service: GitService::new(),
        }
    }
    fn request(&self, project: &Path, mut value: Value) -> Result<Value, String> {
        let ProjectGit::Ready(found) = self.service.discover(project).unwrap() else {
            panic!("not a repository")
        };
        value["repoId"] = json!(found.repos[0].id);
        self.service.handle(
            project,
            serde_json::from_value::<GitRequest>(value).unwrap(),
        )
    }
    fn list(&self, project: &Path) -> Vec<Value> {
        self.request(project, json!({ "op": "worktrees" }))
            .unwrap()
            .as_array()
            .unwrap()
            .clone()
    }
}

#[test]
fn adds_new_and_existing_branches_beside_the_repository() {
    let f = Fixture::new();
    let added = f
        .request(
            &f.root,
            json!({ "op": "worktreeAdd", "branch": "feature/login", "create": true }),
        )
        .unwrap();
    let path = PathBuf::from(added["path"].as_str().unwrap());
    // Default location: sibling `<repo>.worktrees/<branch with / as ->`.
    assert_eq!(path, f.base.join("app.worktrees").join("feature-login"));
    assert_eq!(
        git(&path, &["branch", "--show-current"]).trim(),
        "feature/login"
    );
    assert_eq!(
        git(&path, &["rev-parse", "HEAD"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );

    git(&f.root, &["branch", "spare"]);
    let custom = f.base.join("elsewhere");
    f.request(&f.root, json!({ "op": "worktreeAdd", "branch": "spare", "create": false, "path": custom.to_str().unwrap() })).unwrap();

    let list = f.list(&f.root);
    assert_eq!(list.len(), 3);
    assert_eq!(list[0]["main"], true);
    assert_eq!(list[0]["current"], true);
    assert!(list
        .iter()
        .any(|w| w["branch"] == "feature/login" && w["dirty"] == false));
    assert!(list.iter().any(|w| w["branch"] == "spare"));
    // Opened from the linked checkout, that entry is the current one.
    let from_linked = f.list(&path);
    assert!(from_linked
        .iter()
        .any(|w| w["branch"] == "feature/login" && w["current"] == true && w["main"] == false));
}

#[test]
fn refuses_unsafe_or_ambiguous_additions() {
    let f = Fixture::new();
    f.request(
        &f.root,
        json!({ "op": "worktreeAdd", "branch": "topic", "create": true }),
    )
    .unwrap();
    let error = |value: Value| f.request(&f.root, value).unwrap_err();
    assert!(
        error(json!({ "op": "worktreeAdd", "branch": "topic", "create": true }))
            .contains("already exists")
    );
    assert!(error(json!({ "op": "worktreeAdd", "branch": "topic", "create": false, "path": f.base.join("x").to_str().unwrap() })).contains("already used by another worktree"));
    assert!(
        error(json!({ "op": "worktreeAdd", "branch": "missing", "create": false }))
            .contains("not found")
    );
    assert!(
        error(json!({ "op": "worktreeAdd", "branch": "bad..name", "create": true }))
            .contains("Invalid branch name")
    );
    fs::create_dir_all(f.base.join("taken")).unwrap();
    assert!(error(json!({ "op": "worktreeAdd", "branch": "other", "create": true, "path": f.base.join("taken").to_str().unwrap() })).contains("already exists"));
    assert!(error(
        json!({ "op": "worktreeAdd", "branch": "other", "create": true, "path": "relative/dir" })
    )
    .contains("must be absolute"));
    assert!(
        !git(&f.root, &["branch", "--list", "other"]).contains("other"),
        "a refused add must not leave a branch"
    );
}

#[test]
fn removal_keeps_branches_and_never_discards_changes() {
    let f = Fixture::new();
    let added = f
        .request(
            &f.root,
            json!({ "op": "worktreeAdd", "branch": "work", "create": true }),
        )
        .unwrap();
    let path = PathBuf::from(added["path"].as_str().unwrap());
    fs::write(path.join("readme.txt"), b"edited\n").unwrap();
    fs::write(path.join("notes.txt"), b"untracked\n").unwrap();
    let remove = |stash: bool| {
        f.request(
            &f.root,
            json!({ "op": "worktreeRemove", "path": path.to_str().unwrap(), "stash": stash }),
        )
    };

    assert!(remove(false).unwrap_err().contains("uncommitted"));
    assert_eq!(
        fs::read(path.join("notes.txt")).unwrap(),
        b"untracked\n",
        "a refused removal changes nothing"
    );

    let outcome = remove(true).unwrap();
    assert!(outcome["message"].as_str().unwrap().contains("stash"));
    assert!(!path.exists());
    assert!(
        git(&f.root, &["branch", "--list", "work"]).contains("work"),
        "the branch is kept"
    );
    let stash = git(&f.root, &["stash", "list"]);
    assert!(stash.contains("removing worktree work"), "{stash}");
    // The stash holds both the edit and the untracked file.
    let files = git(
        &f.root,
        &[
            "stash",
            "show",
            "--include-untracked",
            "--name-only",
            "stash@{0}",
        ],
    );
    assert!(
        files.contains("readme.txt") && files.contains("notes.txt"),
        "{files}"
    );
}

#[test]
fn main_and_current_checkouts_cannot_be_removed_and_missing_ones_prune() {
    let f = Fixture::new();
    let added = f
        .request(
            &f.root,
            json!({ "op": "worktreeAdd", "branch": "gone", "create": true }),
        )
        .unwrap();
    let path = PathBuf::from(added["path"].as_str().unwrap());
    assert!(f
        .request(
            &f.root,
            json!({ "op": "worktreeRemove", "path": f.root.to_str().unwrap() })
        )
        .unwrap_err()
        .contains("main worktree"));
    assert!(f
        .request(
            &path,
            json!({ "op": "worktreeRemove", "path": path.to_str().unwrap() })
        )
        .unwrap_err()
        .contains("current worktree"));

    // A checkout deleted outside Session Bay becomes prunable, then disappears.
    fs::remove_dir_all(&path).unwrap();
    assert!(f
        .list(&f.root)
        .iter()
        .any(|w| w["branch"] == "gone" && w["prunable"] == true && w["dirty"].is_null()));
    f.request(&f.root, json!({ "op": "worktreePrune" }))
        .unwrap();
    assert_eq!(f.list(&f.root).len(), 1);
    assert!(git(&f.root, &["branch", "--list", "gone"]).contains("gone"));
}
