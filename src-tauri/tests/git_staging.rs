//! G2: byte-exact diffs and partial staging over synthetic repositories.
#[path = "support/git_fixture.rs"]
mod git_fixture;

use git_fixture::{commit_file, git, git_bytes, init_repo, temp};
use serde_json::{json, Value};
use sessionbay_lib::git::{GitRequest, GitService, ProjectGit, STALE_SELECTION};
use std::{fs, path::Path};

struct Repo {
    _temp: tempfile::TempDir,
    root: std::path::PathBuf,
    service: GitService,
    id: String,
}

impl Repo {
    fn new() -> Self {
        let (temp, base) = temp();
        let root = init_repo(&base.join("repo"));
        let service = GitService::new();
        let ProjectGit::Ready(found) = service.discover(&root).unwrap() else {
            panic!("git unavailable")
        };
        let id = found.repos[0].id.clone();
        Self {
            _temp: temp,
            root,
            service,
            id,
        }
    }
    fn request(&self, value: Value) -> Result<Value, String> {
        let mut value = value;
        value["repoId"] = json!(self.id);
        let request: GitRequest = serde_json::from_value(value).unwrap();
        self.service.handle(&self.root, request)
    }
    fn diff(&self, path: &str, source: &str) -> Value {
        self.request(json!({ "op": "diff", "path": path, "source": { "kind": source } }))
            .unwrap()
    }
    fn index_blob(&self, path: &str) -> Vec<u8> {
        git_bytes(&self.root, &["show", &format!(":{path}")])
    }
    fn state(&self) -> (String, Vec<u8>) {
        (
            git(&self.root, &["rev-parse", "HEAD"]),
            git_bytes(&self.root, &["ls-files", "--stage", "-z"]),
        )
    }
    /// Index of the n-th line with `kind` in hunk 0.
    fn changed(diff: &Value, hunk: usize, kind: &str, text: &str) -> Value {
        let lines = diff["hunks"][hunk]["lines"].as_array().unwrap();
        let line = lines
            .iter()
            .position(|l| l["kind"] == kind && l["text"] == text)
            .unwrap_or_else(|| panic!("no {kind} line {text:?} in {diff}"));
        json!({ "hunk": hunk, "line": line })
    }
}

fn write(root: &Path, name: &str, bytes: &[u8]) {
    fs::write(root.join(name), bytes).unwrap();
}

#[test]
fn stages_one_of_two_changes_in_the_same_hunk_then_unstages_partially() {
    let repo = Repo::new();
    commit_file(&repo.root, "f.txt", b"a\nb\nc\nd\n", "initial");
    write(&repo.root, "f.txt", b"a\nB\nc\nD\n");
    let diff = repo.diff("f.txt", "unstaged");
    assert_eq!(diff["hunks"].as_array().unwrap().len(), 1);
    assert!(diff["partialBlocked"].is_null());
    let lines = json!([
        Repo::changed(&diff, 0, "delete", "d"),
        Repo::changed(&diff, 0, "add", "D")
    ]);
    repo.request(
        json!({ "op": "stageSelection", "path": "f.txt", "snapshot": diff["snapshot"],
        "selection": { "kind": "lines", "lines": lines } }),
    )
    .unwrap();
    assert_eq!(repo.index_blob("f.txt"), b"a\nb\nc\nD\n");
    assert_eq!(fs::read(repo.root.join("f.txt")).unwrap(), b"a\nB\nc\nD\n");

    // Stage the rest, then unstage only the first change: D stays staged.
    let diff = repo.diff("f.txt", "unstaged");
    repo.request(
        json!({ "op": "stageSelection", "path": "f.txt", "snapshot": diff["snapshot"],
        "selection": { "kind": "hunks", "hunks": [0] } }),
    )
    .unwrap();
    assert_eq!(repo.index_blob("f.txt"), b"a\nB\nc\nD\n");
    let staged = repo.diff("f.txt", "staged");
    let lines = json!([
        Repo::changed(&staged, 0, "delete", "b"),
        Repo::changed(&staged, 0, "add", "B")
    ]);
    repo.request(
        json!({ "op": "unstageSelection", "path": "f.txt", "snapshot": staged["snapshot"],
        "selection": { "kind": "lines", "lines": lines } }),
    )
    .unwrap();
    assert_eq!(repo.index_blob("f.txt"), b"a\nb\nc\nD\n");
    assert_eq!(fs::read(repo.root.join("f.txt")).unwrap(), b"a\nB\nc\nD\n");
}

#[test]
fn stale_snapshot_is_rejected_without_writing() {
    let repo = Repo::new();
    commit_file(&repo.root, "f.txt", b"one\ntwo\n", "initial");
    write(&repo.root, "f.txt", b"one\nTWO\n");
    let diff = repo.diff("f.txt", "unstaged");
    // An Agent edits the file after the user selected lines.
    write(&repo.root, "f.txt", b"ONE\nTWO\n");
    let before = repo.state();
    let error = repo
        .request(
            json!({ "op": "stageSelection", "path": "f.txt", "snapshot": diff["snapshot"],
            "selection": { "kind": "hunks", "hunks": [0] } }),
        )
        .unwrap_err();
    assert_eq!(error, STALE_SELECTION);
    assert_eq!(repo.state(), before);

    // An index change also invalidates an unstage selection.
    git(&repo.root, &["add", "f.txt"]);
    let staged = repo.diff("f.txt", "staged");
    write(&repo.root, "f.txt", b"ONE\nTWO\nthree\n");
    git(&repo.root, &["add", "f.txt"]);
    let before = repo.state();
    assert!(repo
        .request(
            json!({ "op": "unstageSelection", "path": "f.txt", "snapshot": staged["snapshot"],
            "selection": { "kind": "hunks", "hunks": [0] } })
        )
        .is_err());
    assert_eq!(repo.state(), before);
}

#[test]
fn crlf_unicode_and_missing_final_newline_are_preserved() {
    let repo = Repo::new();
    commit_file(
        &repo.root,
        "crlf.txt",
        "頭\r\n中\r\n尾".as_bytes(),
        "initial",
    );
    write(
        &repo.root,
        "crlf.txt",
        "頭\r\n中文\r\n尾\r\n新增".as_bytes(),
    );
    let diff = repo.diff("crlf.txt", "unstaged");
    assert!(diff["partialBlocked"].is_null(), "{diff}");
    let line = &diff["hunks"][0]["lines"][1];
    assert_eq!(line["kind"], "delete");
    assert_eq!(line["crlf"], true);
    // Stage only the middle replacement; the end-of-file change stays out.
    let lines = json!([
        Repo::changed(&diff, 0, "delete", "中"),
        Repo::changed(&diff, 0, "add", "中文")
    ]);
    repo.request(
        json!({ "op": "stageSelection", "path": "crlf.txt", "snapshot": diff["snapshot"],
        "selection": { "kind": "lines", "lines": lines } }),
    )
    .unwrap();
    assert_eq!(repo.index_blob("crlf.txt"), "頭\r\n中文\r\n尾".as_bytes());

    // The end-of-file change cannot be split from its newline counterpart.
    let diff = repo.diff("crlf.txt", "unstaged");
    let only_add = json!([Repo::changed(&diff, 0, "add", "新增")]);
    let error = repo
        .request(
            json!({ "op": "stageSelection", "path": "crlf.txt", "snapshot": diff["snapshot"],
            "selection": { "kind": "lines", "lines": only_add } }),
        )
        .unwrap_err();
    assert!(error.contains("檔案結尾換行"), "{error}");
    repo.request(
        json!({ "op": "stageSelection", "path": "crlf.txt", "snapshot": diff["snapshot"],
        "selection": { "kind": "hunks", "hunks": [0] } }),
    )
    .unwrap();
    assert_eq!(
        repo.index_blob("crlf.txt"),
        "頭\r\n中文\r\n尾\r\n新增".as_bytes()
    );
}

#[test]
fn untracked_and_deleted_files_support_partial_lines() {
    let repo = Repo::new();
    commit_file(&repo.root, "gone.txt", b"keep\ndrop\n", "initial");
    write(&repo.root, "-new file.txt", b"first\nsecond\n");
    let diff = repo
        .request(json!({ "op": "diff", "path": "-new file.txt", "untracked": true, "source": { "kind": "unstaged" } }))
        .unwrap();
    assert_eq!(diff["newFile"], true);
    let lines = json!([Repo::changed(&diff, 0, "add", "second")]);
    repo.request(json!({ "op": "stageSelection", "path": "-new file.txt", "untracked": true, "snapshot": diff["snapshot"],
        "selection": { "kind": "lines", "lines": lines } }))
        .unwrap();
    assert_eq!(repo.index_blob("-new file.txt"), b"second\n");

    fs::remove_file(repo.root.join("gone.txt")).unwrap();
    let diff = repo.diff("gone.txt", "unstaged");
    assert_eq!(diff["deletedFile"], true);
    let lines = json!([Repo::changed(&diff, 0, "delete", "drop")]);
    repo.request(
        json!({ "op": "stageSelection", "path": "gone.txt", "snapshot": diff["snapshot"],
        "selection": { "kind": "lines", "lines": lines } }),
    )
    .unwrap();
    assert_eq!(repo.index_blob("gone.txt"), b"keep\n");
    // Staging the remaining line now deletes the file from the index.
    let diff = repo.diff("gone.txt", "unstaged");
    repo.request(
        json!({ "op": "stageSelection", "path": "gone.txt", "snapshot": diff["snapshot"],
        "selection": { "kind": "hunks", "hunks": [0] } }),
    )
    .unwrap();
    assert!(git(&repo.root, &["ls-files", "--", "gone.txt"]).is_empty());
}

#[test]
fn binary_rename_mode_and_whitespace_views_block_partial_operations() {
    let repo = Repo::new();
    commit_file(&repo.root, "image.bin", b"\x00\x01\x02", "binary");
    commit_file(
        &repo.root,
        "old.txt",
        b"same\ncontent\nhere\n",
        "rename source",
    );
    commit_file(&repo.root, "ws.txt", b"a  b\n", "whitespace");
    write(&repo.root, "image.bin", b"\x00\x09\x02\x03");
    let diff = repo.diff("image.bin", "unstaged");
    assert_eq!(diff["binary"], true);
    assert!(diff["hunks"].as_array().unwrap().is_empty());
    assert!(diff["partialBlocked"].as_str().unwrap().contains("非文字"));
    repo.request(json!({ "op": "stagePaths", "paths": ["image.bin"] }))
        .unwrap();
    assert_eq!(repo.index_blob("image.bin"), b"\x00\x09\x02\x03");

    git(&repo.root, &["mv", "old.txt", "new.txt"]);
    let diff = repo
        .request(json!({ "op": "diff", "path": "new.txt", "oldPath": "old.txt", "source": { "kind": "staged" } }))
        .unwrap();
    assert_eq!(diff["renamed"], true);
    assert!(diff["partialBlocked"]
        .as_str()
        .unwrap()
        .contains("重新命名"));
    repo.request(json!({ "op": "unstagePaths", "paths": ["new.txt", "old.txt"] }))
        .unwrap();
    assert_eq!(
        git(&repo.root, &["diff", "--cached", "--name-only"]),
        "image.bin\n"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = repo.root.join("ws.txt");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        let diff = repo.diff("ws.txt", "unstaged");
        assert_eq!(diff["oldMode"], "100644");
        assert_eq!(diff["newMode"], "100755");
        repo.request(json!({ "op": "stagePaths", "paths": ["ws.txt"] }))
            .unwrap();
        assert!(git(&repo.root, &["ls-files", "-s", "ws.txt"]).starts_with("100755"));
    }

    // Ignoring whitespace changes the view only; partial operations require
    // the exact diff and the real patch bytes stay untouched.
    write(&repo.root, "ws.txt", b"a b\nnew\n");
    let view = repo
        .request(json!({ "op": "diff", "path": "ws.txt", "ignoreWhitespace": true, "source": { "kind": "unstaged" } }))
        .unwrap();
    assert!(view["partialBlocked"]
        .as_str()
        .unwrap()
        .contains("忽略空白"));
    let exact = repo.diff("ws.txt", "unstaged");
    assert_ne!(view["snapshot"], exact["snapshot"]);
    let error = repo
        .request(
            json!({ "op": "stageSelection", "path": "ws.txt", "snapshot": view["snapshot"],
            "selection": { "kind": "hunks", "hunks": [0] } }),
        )
        .unwrap_err();
    assert_eq!(error, STALE_SELECTION);
}

#[cfg(unix)]
#[test]
fn non_utf8_file_names_round_trip() {
    use std::os::unix::ffi::OsStrExt;
    let repo = Repo::new();
    commit_file(&repo.root, "seed.txt", b"seed\n", "seed");
    let name = std::ffi::OsStr::from_bytes(b"latin1-\xe9.txt");
    if fs::write(repo.root.join(name), b"x\n").is_err() {
        // Some filesystems (APFS normalization aside) reject invalid UTF-8.
        return;
    }
    let status = repo.request(json!({ "op": "status" })).unwrap();
    let entry = status["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["path"]["raw"].is_string())
        .cloned();
    let Some(entry) = entry else { return };
    repo.request(json!({ "op": "stagePaths", "paths": [entry["path"]] }))
        .unwrap();
    let listed = git_bytes(
        &repo.root,
        &["-c", "core.quotepath=false", "ls-files", "-z"],
    );
    let name: &[u8] = b"latin1-\xe9.txt";
    assert!(listed.windows(name.len()).any(|w| w == name), "{listed:?}");
}

#[test]
fn compare_sources_distinguish_direct_and_merge_base() {
    let repo = Repo::new();
    commit_file(&repo.root, "f.txt", b"base\n", "base");
    git(&repo.root, &["switch", "-q", "-c", "topic"]);
    commit_file(&repo.root, "topic.txt", b"topic\n", "topic");
    git(&repo.root, &["switch", "-q", "main"]);
    commit_file(&repo.root, "main.txt", b"main\n", "main");
    let direct = repo
        .request(json!({ "op": "changedFiles", "source": { "kind": "compare", "base": "main", "head": "topic", "mergeBase": false } }))
        .unwrap();
    let names: Vec<_> = direct["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"]["path"].clone())
        .collect();
    assert_eq!(names, vec![json!("main.txt"), json!("topic.txt")]);
    let since = repo
        .request(json!({ "op": "changedFiles", "source": { "kind": "compare", "base": "main", "head": "topic", "mergeBase": true } }))
        .unwrap();
    assert_eq!(since["files"].as_array().unwrap().len(), 1);
    assert_eq!(since["files"][0]["path"]["path"], "topic.txt");
    // Option-looking revisions never reach Git as flags.
    assert!(repo
        .request(json!({ "op": "changedFiles", "source": { "kind": "compare", "base": "--output=/tmp/x", "head": "topic", "mergeBase": false } }))
        .is_err());
}

#[test]
fn refs_list_branches_tags_remotes_and_other_worktrees() {
    let repo = Repo::new();
    commit_file(&repo.root, "f.txt", b"x\n", "first");
    git(&repo.root, &["tag", "v1"]);
    git(&repo.root, &["tag", "-a", "v2", "-m", "Release two"]);
    git(&repo.root, &["branch", "busy"]);
    let other = repo.root.parent().unwrap().join("other-tree");
    git(
        &repo.root,
        &["worktree", "add", "-q", other.to_str().unwrap(), "busy"],
    );
    git(
        &repo.root,
        &[
            "remote",
            "add",
            "origin",
            "https://user:secret@git.example.invalid/team/repo.git",
        ],
    );
    let refs = repo.request(json!({ "op": "refs" })).unwrap();
    let branches = refs["branches"].as_array().unwrap();
    let main = branches.iter().find(|b| b["name"] == "main").unwrap();
    assert_eq!(main["current"], true);
    let busy = branches.iter().find(|b| b["name"] == "busy").unwrap();
    assert!(busy["worktree"].as_str().unwrap().ends_with("other-tree"));
    let tags = refs["tags"].as_array().unwrap();
    let v2 = tags.iter().find(|t| t["name"] == "v2").unwrap();
    assert_eq!(v2["annotated"], true);
    assert!(v2["message"].as_str().unwrap().contains("Release two"));
    assert_eq!(v2["target"], main["oid"]);
    assert_eq!(
        tags.iter().find(|t| t["name"] == "v1").unwrap()["annotated"],
        false
    );
    assert_eq!(
        refs["remotes"][0]["url"],
        "https://***@git.example.invalid/team/repo.git"
    );
    assert_eq!(refs["worktrees"].as_array().unwrap().len(), 2);
}
