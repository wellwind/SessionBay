//! G5: branches, stash, reset, revert, tags and recovery points.
//! Only synthetic repositories and local bare remotes are touched.
#[path = "support/git_fixture.rs"]
mod git_fixture;

use git_fixture::{commit_file, git, git_bytes, init_repo, temp};
use serde_json::{json, Value};
use sessionbay_lib::git::{GitRequest, GitService, ProjectGit};
use std::{fs, path::PathBuf};

struct Repo {
    _temp: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    service: GitService,
    id: String,
}

impl Repo {
    fn build(protected: bool) -> Self {
        let (temp, base) = temp();
        let service = if protected {
            GitService::with_recovery_dir(base.join("recovery"))
        } else {
            GitService::new()
        };
        let root = init_repo(&base.join("repo"));
        commit_file(&root, "f.txt", b"one\n", "initial");
        let ProjectGit::Ready(found) = service.discover(&root).unwrap() else {
            panic!()
        };
        let id = found.repos[0].id.clone();
        Self {
            _temp: temp,
            base,
            root,
            service,
            id,
        }
    }
    fn new() -> Self {
        Self::build(true)
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
    /// HEAD, refs, index and every work-tree byte.
    fn snapshot(&self) -> (String, String, Vec<u8>, Vec<u8>) {
        let mut files = Vec::new();
        let mut paths: Vec<_> = walk(&self.root);
        paths.sort();
        for path in paths {
            files.extend(path.to_string_lossy().as_bytes());
            files.extend(fs::read(&path).unwrap());
        }
        (
            self.head(),
            git(
                &self.root,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads",
                    "refs/tags",
                    "refs/stash",
                ],
            ),
            git_bytes(&self.root, &["ls-files", "--stage", "-z"]),
            files,
        )
    }
}

fn walk(root: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in fs::read_dir(root).unwrap().flatten() {
        let path = entry.path();
        if path.file_name().unwrap() == ".git" {
            continue;
        }
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

#[test]
fn dirty_tree_detached_head_and_other_worktrees_are_handled_safely() {
    let repo = Repo::new();
    git(&repo.root, &["branch", "side"]);
    fs::write(repo.root.join("f.txt"), b"dirty\n").unwrap();
    let before = repo.snapshot();
    let error = repo
        .request(json!({ "op": "switchBranch", "name": "side" }))
        .unwrap_err();
    assert!(error.contains("未提交"), "{error}");
    assert_eq!(repo.snapshot(), before);
    fs::write(repo.root.join("f.txt"), b"one\n").unwrap();

    // Detached HEAD: create a branch from here, then switch back.
    let head = repo.head();
    git(&repo.root, &["switch", "-q", "--detach", "HEAD"]);
    let status = repo.request(json!({ "op": "status" })).unwrap();
    assert_eq!(status["branch"]["head"], Value::Null);
    repo.request(json!({ "op": "createBranch", "name": "rescue", "start": null, "switch": true }))
        .unwrap();
    assert_eq!(
        git(&repo.root, &["branch", "--show-current"]).trim(),
        "rescue"
    );
    assert_eq!(repo.head(), head);

    // A branch checked out elsewhere can be neither switched to nor deleted.
    let other = repo.base.join("other");
    git(
        &repo.root,
        &["worktree", "add", "-q", other.to_str().unwrap(), "side"],
    );
    assert!(repo
        .request(json!({ "op": "switchBranch", "name": "side" }))
        .unwrap_err()
        .contains("另一個 worktree"));
    let side = git(&repo.root, &["rev-parse", "side"]).trim().to_owned();
    assert!(repo
        .request(json!({ "op": "deleteBranch", "name": "side", "expected": side, "force": true }))
        .unwrap_err()
        .contains("worktree"));
    // Option-shaped names never reach Git.
    assert!(repo
        .request(json!({ "op": "createBranch", "name": "-D", "start": null }))
        .is_err());
}

#[test]
fn stale_confirmations_and_missing_backups_change_nothing() {
    let repo = Repo::new();
    commit_file(&repo.root, "f.txt", b"two\n", "second");
    fs::write(repo.root.join("f.txt"), b"local edit\n").unwrap();
    let before = repo.snapshot();
    let error = repo
        .request(json!({ "op": "reset", "target": "HEAD~1", "mode": "hard", "expectedHead": "0".repeat(40) }))
        .unwrap_err();
    assert!(error.contains("HEAD 已在確認後變更"), "{error}");
    assert_eq!(repo.snapshot(), before);

    // Without recovery storage the destructive operation refuses to start.
    let unprotected = Repo::build(false);
    fs::write(unprotected.root.join("f.txt"), b"keep me\n").unwrap();
    let before = unprotected.snapshot();
    let head = unprotected.head();
    let error = unprotected
        .request(json!({ "op": "reset", "target": "HEAD", "mode": "hard", "expectedHead": head }))
        .unwrap_err();
    assert!(error.contains("復原點"), "{error}");
    assert_eq!(unprotected.snapshot(), before);

    // An untracked entry that cannot be backed up stops the discard.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("f.txt", repo.root.join("link")).unwrap();
        let before = repo.snapshot();
        let error = repo
            .request(json!({ "op": "discard", "untracked": ["link"] }))
            .unwrap_err();
        assert!(error.contains("無法安全備份"), "{error}");
        assert_eq!(repo.snapshot(), before);
        fs::remove_file(repo.root.join("link")).unwrap();
    }
}

#[test]
fn hard_reset_and_discard_are_recoverable_without_overwriting_new_work() {
    let repo = Repo::new();
    commit_file(&repo.root, "f.txt", b"two\n", "second");
    fs::write(repo.root.join("f.txt"), b"uncommitted\n").unwrap();
    fs::write(repo.root.join("staged.txt"), b"staged\n").unwrap();
    git(&repo.root, &["add", "staged.txt"]);
    let head = repo.head();
    let outcome = repo
        .request(json!({ "op": "reset", "target": "HEAD~1", "mode": "hard", "expectedHead": head }))
        .unwrap();
    let point = &outcome["recovery"];
    assert_eq!(point["coverage"]["index"], true);
    assert_eq!(point["coverage"]["trackedFiles"], true);
    assert_eq!(fs::read(repo.root.join("f.txt")).unwrap(), b"one\n");
    assert!(!repo.root.join("staged.txt").exists());

    // New uncommitted work blocks the restore instead of being overwritten.
    fs::write(repo.root.join("f.txt"), b"newer work\n").unwrap();
    let id = point["id"].as_str().unwrap();
    assert!(repo
        .request(json!({ "op": "restoreRecovery", "id": id }))
        .unwrap_err()
        .contains("未提交"));
    assert_eq!(fs::read(repo.root.join("f.txt")).unwrap(), b"newer work\n");
    git(&repo.root, &["checkout", "--", "f.txt"]);

    repo.request(json!({ "op": "restoreRecovery", "id": id }))
        .unwrap();
    assert_eq!(repo.head(), head);
    assert_eq!(fs::read(repo.root.join("f.txt")).unwrap(), b"uncommitted\n");
    assert_eq!(
        git(&repo.root, &["diff", "--cached", "--name-only"]),
        "staged.txt\n"
    );

    // Discarding an untracked file keeps a byte copy; restore skips files
    // that exist again.
    fs::write(repo.root.join("scratch.bin"), b"\x00\x01untracked").unwrap();
    let outcome = repo
        .request(json!({ "op": "discard", "untracked": ["scratch.bin"], "paths": ["f.txt"] }))
        .unwrap();
    assert!(!repo.root.join("scratch.bin").exists());
    assert_eq!(fs::read(repo.root.join("f.txt")).unwrap(), b"two\n");
    assert_eq!(outcome["recovery"]["coverage"]["untrackedFiles"], 1);
    let points = repo.request(json!({ "op": "recoveryPoints" })).unwrap();
    assert!(points.as_array().unwrap().len() >= 2);
    git(&repo.root, &["stash", "-q"]);
    repo.request(json!({ "op": "restoreRecovery", "id": outcome["recovery"]["id"] }))
        .unwrap();
    assert_eq!(
        fs::read(repo.root.join("scratch.bin")).unwrap(),
        b"\x00\x01untracked"
    );
}

#[test]
fn stash_conflicts_keep_the_stash_and_drops_are_recoverable() {
    let repo = Repo::new();
    fs::write(repo.root.join("f.txt"), b"stashed change\n").unwrap();
    repo.request(json!({ "op": "stashPush", "message": "wip" }))
        .unwrap();
    commit_file(&repo.root, "f.txt", b"conflicting commit\n", "conflict");
    let stashes = repo.request(json!({ "op": "stashes" })).unwrap();
    let oid = stashes[0]["oid"].as_str().unwrap().to_owned();
    assert!(stashes[0]["message"].as_str().unwrap().contains("wip"));
    let outcome = repo
        .request(json!({ "op": "stashApply", "index": 0, "expected": oid, "pop": true }))
        .unwrap();
    assert_eq!(outcome["conflicts"], true);
    assert_eq!(
        repo.request(json!({ "op": "stashes" }))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    git(&repo.root, &["checkout", "-q", "HEAD", "--", "f.txt"]);
    git(&repo.root, &["reset", "-q"]);

    assert!(repo
        .request(json!({ "op": "stashDrop", "index": 0, "expected": "0".repeat(40) }))
        .is_err());
    let dropped = repo
        .request(json!({ "op": "stashDrop", "index": 0, "expected": oid }))
        .unwrap();
    assert!(repo
        .request(json!({ "op": "stashes" }))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    repo.request(json!({ "op": "restoreRecovery", "id": dropped["recovery"]["id"] }))
        .unwrap();
    assert_eq!(
        repo.request(json!({ "op": "stashes" })).unwrap()[0]["oid"],
        oid
    );
}

#[test]
fn unmerged_branch_delete_needs_force_and_can_be_restored() {
    let repo = Repo::new();
    git(&repo.root, &["switch", "-q", "-c", "topic"]);
    commit_file(&repo.root, "t.txt", b"t\n", "topic");
    git(&repo.root, &["switch", "-q", "main"]);
    let topic = git(&repo.root, &["rev-parse", "topic"]).trim().to_owned();
    let error = repo
        .request(json!({ "op": "deleteBranch", "name": "topic", "expected": topic }))
        .unwrap_err();
    assert!(error.contains("強制刪除"), "{error}");
    let outcome = repo
        .request(json!({ "op": "deleteBranch", "name": "topic", "expected": topic, "force": true }))
        .unwrap();
    assert!(git(&repo.root, &["branch", "--list", "topic"]).is_empty());
    repo.request(json!({ "op": "restoreRecovery", "id": outcome["recovery"]["id"] }))
        .unwrap();
    assert_eq!(git(&repo.root, &["rev-parse", "topic"]).trim(), topic);
    // Restoring again never overwrites the existing branch.
    assert!(repo
        .request(json!({ "op": "restoreRecovery", "id": outcome["recovery"]["id"] }))
        .unwrap_err()
        .contains("已存在"));
}

#[test]
fn revert_merge_requires_mainline_and_tags_stay_local_until_pushed() {
    let repo = Repo::new();
    git(&repo.root, &["switch", "-q", "-c", "topic"]);
    commit_file(&repo.root, "t.txt", b"t\n", "topic");
    git(&repo.root, &["switch", "-q", "main"]);
    git(
        &repo.root,
        &["merge", "-q", "--no-ff", "-m", "merge", "topic"],
    );
    let merge = repo.head();
    assert!(repo
        .request(json!({ "op": "revert", "commit": merge, "parent": null, "expectedHead": merge }))
        .unwrap_err()
        .contains("parent"));
    repo.request(json!({ "op": "revert", "commit": merge, "parent": 1, "expectedHead": merge }))
        .unwrap();
    assert!(!repo.root.join("t.txt").exists());
    assert_eq!(
        git(&repo.root, &["rev-list", "--count", "HEAD"]).trim(),
        "4"
    );

    let bare = repo.base.join("remote.git");
    git(
        &repo.base,
        &["init", "-q", "--bare", bare.to_str().unwrap()],
    );
    git(
        &repo.root,
        &["remote", "add", "origin", bare.to_str().unwrap()],
    );
    git(&repo.root, &["push", "-q", "origin", "main"]);
    repo.request(json!({ "op": "createTag", "name": "v1", "target": null, "message": "Release" }))
        .unwrap();
    repo.request(json!({ "op": "createTag", "name": "v2", "target": "HEAD~1", "message": null }))
        .unwrap();
    assert!(git(&bare, &["tag"]).is_empty());
    repo.request(json!({ "op": "pushTag", "remote": "origin", "name": "v1" }))
        .unwrap();
    assert_eq!(git(&bare, &["tag"]), "v1\n");
    let remote = repo
        .request(json!({ "op": "remoteTags", "remote": "origin" }))
        .unwrap();
    assert_eq!(remote[0]["name"], "v1");

    // Local deletion leaves the published tag; remote deletion leaves local.
    let v1 = git(&repo.root, &["rev-parse", "refs/tags/v1"])
        .trim()
        .to_owned();
    let deleted = repo
        .request(json!({ "op": "deleteTag", "name": "v1", "expected": v1 }))
        .unwrap();
    assert_eq!(git(&bare, &["tag"]), "v1\n");
    repo.request(json!({ "op": "restoreRecovery", "id": deleted["recovery"]["id"] }))
        .unwrap();
    assert_eq!(git(&repo.root, &["cat-file", "-t", "v1"]).trim(), "tag");
    assert!(repo
        .request(json!({ "op": "deleteRemoteTag", "remote": "origin", "name": "v1", "expected": "0".repeat(40) }))
        .is_err());
    repo.request(json!({ "op": "deleteRemoteTag", "remote": "origin", "name": "v1", "expected": remote[0]["oid"] })).unwrap();
    assert!(git(&bare, &["tag"]).is_empty());
    assert!(!git(&repo.root, &["tag"]).is_empty());
}
