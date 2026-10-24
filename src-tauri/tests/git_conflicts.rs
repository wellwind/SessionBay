//! G6: merge and in-app conflict resolution on synthetic repositories.
#[path = "support/git_fixture.rs"]
mod git_fixture;

use git_fixture::{commit_file, git, init_repo, temp};
use serde_json::{json, Value};
use sessionbay_lib::git::{GitRequest, GitService, ProjectGit};
use std::{fs, path::PathBuf};

struct Repo {
    _temp: tempfile::TempDir,
    root: PathBuf,
    service: GitService,
    id: String,
}

impl Repo {
    fn new() -> Self {
        let (temp, base) = temp();
        let root = init_repo(&base.join("repo"));
        let service = GitService::with_recovery_dir(base.join("recovery"));
        let ProjectGit::Ready(found) = service.discover(&root).unwrap() else {
            panic!()
        };
        let id = found.repos[0].id.clone();
        Self {
            _temp: temp,
            root,
            service,
            id,
        }
    }
    fn request(&self, mut value: Value) -> Result<Value, String> {
        value["repoId"] = json!(self.id);
        self.service.handle(
            &self.root,
            serde_json::from_value::<GitRequest>(value).unwrap(),
        )
    }
    fn head(&self) -> String {
        git(&self.root, &["rev-parse", "HEAD"]).trim().to_owned()
    }
    /// main and topic both change `name` from `base` content.
    fn diverge(&self, name: &str, base: &[u8], ours: &[u8], theirs: &[u8]) {
        commit_file(&self.root, name, base, "base");
        git(&self.root, &["switch", "-q", "-c", "topic"]);
        commit_file(&self.root, name, theirs, "topic change");
        git(&self.root, &["switch", "-q", "main"]);
        commit_file(&self.root, name, ours, "main change");
    }
    fn merge_topic(&self) -> Value {
        let head = self.head();
        self.request(json!({ "op": "merge", "rev": "topic", "expectedHead": head }))
            .unwrap()
    }
    fn conflicts(&self) -> Vec<String> {
        let status = self.request(json!({ "op": "status" })).unwrap();
        status["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| !e["conflict"].is_null())
            .map(|e| e["path"]["path"].as_str().unwrap().to_owned())
            .collect()
    }
}

#[test]
fn text_conflict_is_resolved_saved_marked_and_continued() {
    let repo = Repo::new();
    repo.diverge("f.txt", b"a\nb\nc\n", b"a\nOURS\nc\n", b"a\nTHEIRS\nc\n");
    let outcome = repo.merge_topic();
    assert_eq!(outcome["conflicts"], true);
    assert_eq!(repo.conflicts(), vec!["f.txt"]);

    let file = repo
        .request(json!({ "op": "conflictFile", "path": "f.txt" }))
        .unwrap();
    assert_eq!(file["operation"], "merge");
    assert_eq!(file["textual"], true);
    assert_eq!(file["base"]["text"], "a\nb\nc\n");
    assert_eq!(file["ours"]["text"], "a\nOURS\nc\n");
    assert_eq!(file["theirs"]["text"], "a\nTHEIRS\nc\n");
    assert!(file["ours"]["label"]
        .as_str()
        .unwrap()
        .contains("目前 branch（main）"));
    assert!(file["result"]["text"].as_str().unwrap().contains("<<<<<<<"));

    // Markers still present: marking resolved is refused.
    let error = repo
        .request(json!({ "op": "markResolved", "path": "f.txt", "token": file["token"] }))
        .unwrap_err();
    assert!(error.contains("衝突標記"), "{error}");
    assert_eq!(repo.conflicts(), vec!["f.txt"]);

    let saved = repo
        .request(json!({ "op": "saveConflict", "path": "f.txt", "token": file["token"], "content": "a\nOURS\nTHEIRS\nc\n" }))
        .unwrap();
    // The old token is stale after saving.
    assert!(repo
        .request(json!({ "op": "markResolved", "path": "f.txt", "token": file["token"] }))
        .is_err());
    repo.request(json!({ "op": "markResolved", "path": "f.txt", "token": saved["token"] }))
        .unwrap();
    assert!(repo.conflicts().is_empty());
    repo.request(json!({ "op": "continueOperation" })).unwrap();
    assert_eq!(
        git(&repo.root, &["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
    assert_eq!(
        fs::read(repo.root.join("f.txt")).unwrap(),
        b"a\nOURS\nTHEIRS\nc\n"
    );
}

#[test]
fn concurrent_edits_stop_the_write() {
    let repo = Repo::new();
    repo.diverge("f.txt", b"a\n", b"ours\n", b"theirs\n");
    repo.merge_topic();
    let file = repo
        .request(json!({ "op": "conflictFile", "path": "f.txt" }))
        .unwrap();
    // An Agent rewrites the file while the conflict view is open.
    fs::write(repo.root.join("f.txt"), b"agent wrote this\n").unwrap();
    let error = repo
        .request(json!({ "op": "saveConflict", "path": "f.txt", "token": file["token"], "content": "mine\n" }))
        .unwrap_err();
    assert!(error.contains("已在開啟後變更"), "{error}");
    assert_eq!(
        fs::read(repo.root.join("f.txt")).unwrap(),
        b"agent wrote this\n"
    );
    assert!(repo.request(json!({ "op": "resolveWith", "path": "f.txt", "token": file["token"], "choice": "ours", "newPath": null })).is_err());
    // Unresolved conflicts block continue.
    assert!(repo
        .request(json!({ "op": "continueOperation" }))
        .unwrap_err()
        .contains("未解決"));
}

#[test]
fn binary_and_delete_conflicts_take_whole_file_decisions() {
    let repo = Repo::new();
    repo.diverge("img.bin", b"\x00base", b"\x00ours", b"\x00theirs");
    repo.merge_topic();
    let file = repo
        .request(json!({ "op": "conflictFile", "path": "img.bin" }))
        .unwrap();
    assert_eq!(file["textual"], false);
    assert!(file["ours"]["text"].is_null());
    repo.request(json!({ "op": "resolveWith", "path": "img.bin", "token": file["token"], "choice": "theirs", "newPath": null })).unwrap();
    assert_eq!(fs::read(repo.root.join("img.bin")).unwrap(), b"\x00theirs");
    assert!(repo.conflicts().is_empty());
    repo.request(json!({ "op": "continueOperation" })).unwrap();

    // modify/delete: topic deletes, main modifies.
    commit_file(&repo.root, "doc.txt", b"v1\n", "doc");
    git(&repo.root, &["switch", "-q", "-c", "remover"]);
    git(&repo.root, &["rm", "-q", "doc.txt"]);
    git(&repo.root, &["commit", "-q", "-m", "remove doc"]);
    git(&repo.root, &["switch", "-q", "main"]);
    commit_file(&repo.root, "doc.txt", b"v2\n", "edit doc");
    let head = repo.head();
    assert_eq!(
        repo.request(json!({ "op": "merge", "rev": "remover", "expectedHead": head }))
            .unwrap()["conflicts"],
        true
    );
    let file = repo
        .request(json!({ "op": "conflictFile", "path": "doc.txt" }))
        .unwrap();
    assert_eq!(file["theirs"]["present"], false);
    assert_eq!(file["textual"], false);
    repo.request(json!({ "op": "resolveWith", "path": "doc.txt", "token": file["token"], "choice": "delete", "newPath": null })).unwrap();
    assert!(!repo.root.join("doc.txt").exists());
    assert!(repo.conflicts().is_empty());
}

#[test]
fn add_add_conflict_can_keep_one_side_under_a_new_name() {
    let repo = Repo::new();
    commit_file(&repo.root, "seed.txt", b"seed\n", "seed");
    git(&repo.root, &["switch", "-q", "-c", "topic"]);
    commit_file(&repo.root, "new.txt", b"from topic\n", "topic adds");
    git(&repo.root, &["switch", "-q", "main"]);
    commit_file(&repo.root, "new.txt", b"from main\n", "main adds");
    repo.merge_topic();
    let file = repo
        .request(json!({ "op": "conflictFile", "path": "new.txt" }))
        .unwrap();
    assert_eq!(file["base"]["present"], false);
    // Keep theirs as a separate file, then main's version for the original.
    repo.request(json!({ "op": "resolveWith", "path": "new.txt", "token": file["token"], "choice": "theirs", "newPath": "new.topic.txt" })).unwrap();
    assert_eq!(
        fs::read(repo.root.join("new.topic.txt")).unwrap(),
        b"from topic\n"
    );
    assert!(!repo.root.join("new.txt").exists());
    assert!(repo.conflicts().is_empty());
}

#[test]
fn abort_restores_the_pre_merge_state_and_rebase_labels_follow_semantics() {
    let repo = Repo::new();
    repo.diverge("f.txt", b"a\n", b"ours\n", b"theirs\n");
    let before = repo.head();
    repo.merge_topic();
    let file = repo
        .request(json!({ "op": "conflictFile", "path": "f.txt" }))
        .unwrap();
    repo.request(json!({ "op": "saveConflict", "path": "f.txt", "token": file["token"], "content": "half done\n" })).unwrap();
    let outcome = repo.request(json!({ "op": "abortOperation" })).unwrap();
    assert!(outcome["recovery"]["id"].is_string());
    assert_eq!(repo.head(), before);
    assert_eq!(fs::read(repo.root.join("f.txt")).unwrap(), b"ours\n");
    assert_eq!(git(&repo.root, &["status", "--porcelain"]), "");
    // The half-done resolution is recoverable as work-tree content.
    let restored = repo
        .request(json!({ "op": "restoreRecovery", "id": outcome["recovery"]["id"] }))
        .unwrap();
    assert!(restored.to_string().contains("f.txt"), "{restored}");
    assert_eq!(fs::read(repo.root.join("f.txt")).unwrap(), b"half done\n");
    git(&repo.root, &["checkout", "--", "f.txt"]);

    // Rebasing main onto topic: "ours" is the rebuilt base, "theirs" is the
    // user's own commit being replayed.
    let error = git_rebase(&repo);
    assert!(error, "rebase should stop on conflict");
    let file = repo
        .request(json!({ "op": "conflictFile", "path": "f.txt" }))
        .unwrap();
    assert_eq!(file["operation"], "rebase");
    assert!(file["ours"]["label"]
        .as_str()
        .unwrap()
        .contains("Rebase 目標"));
    assert!(file["theirs"]["label"]
        .as_str()
        .unwrap()
        .contains("正在重放"));
    assert!(file["theirs"]["detail"]
        .as_str()
        .unwrap()
        .contains("main change"));
    repo.request(json!({ "op": "abortOperation" })).unwrap();
    assert_eq!(repo.head(), before);
}

fn git_rebase(repo: &Repo) -> bool {
    let output = std::process::Command::new("git")
        .args(["rebase", "topic"])
        .current_dir(&repo.root)
        .env("GIT_EDITOR", "true")
        .output()
        .unwrap();
    !output.status.success()
}
