//! G3: commit and remote operations against synthetic local remotes only.
#[path = "support/git_fixture.rs"]
mod git_fixture;

use git_fixture::{commit_file, git, git_bytes, init_repo, temp};
use serde_json::{json, Value};
use sessionbay_lib::git::{GitRequest, GitService, ProjectGit};
use std::{
    fs,
    path::{Path, PathBuf},
};

struct Fixture {
    _temp: tempfile::TempDir,
    base: PathBuf,
    project: PathBuf,
    service: GitService,
}

impl Fixture {
    fn new() -> Self {
        let (temp, base) = temp();
        let project = base.join("project");
        fs::create_dir_all(&project).unwrap();
        Self {
            _temp: temp,
            base,
            project,
            service: GitService::new(),
        }
    }
    fn repo(&self, name: &str) -> PathBuf {
        let root = init_repo(&self.project.join(name));
        commit_file(&root, "readme.txt", b"one\n", "initial");
        root
    }
    fn remote(&self, repo: &Path, name: &str) -> PathBuf {
        let bare = self.base.join(format!("{name}.git"));
        git(
            &self.base,
            &["init", "-q", "--bare", bare.to_str().unwrap()],
        );
        git(repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        bare
    }
    fn id(&self, root: &Path) -> String {
        let ProjectGit::Ready(found) = self.service.discover(&self.project).unwrap() else {
            panic!()
        };
        found
            .repos
            .into_iter()
            .find(|r| r.root == root.display().to_string())
            .unwrap()
            .id
    }
    fn request(&self, root: &Path, mut value: Value) -> Result<Value, String> {
        value["repoId"] = json!(self.id(root));
        let request: GitRequest = serde_json::from_value(value).unwrap();
        self.service.handle(&self.project, request)
    }
}

fn head(root: &Path) -> String {
    git(root, &["rev-parse", "HEAD"]).trim().to_owned()
}

#[test]
fn commit_contains_only_the_index_and_never_mixes_repositories() {
    let fixture = Fixture::new();
    let a = fixture.repo("a");
    let b = fixture.repo("b");
    fs::write(a.join("readme.txt"), b"one\ntwo\n").unwrap();
    fs::write(a.join("staged.txt"), b"staged\n").unwrap();
    git(&a, &["add", "staged.txt"]);
    fs::write(b.join("readme.txt"), b"b change\n").unwrap();
    git(&b, &["add", "readme.txt"]);
    let b_index = git_bytes(&b, &["ls-files", "--stage", "-z"]);

    let preview = fixture
        .request(&a, json!({ "op": "commitPreview" }))
        .unwrap();
    let files = preview["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["path"]["path"], "staged.txt");
    assert_eq!(preview["branch"], "main");

    let result = fixture
        .request(&a, json!({ "op": "commit", "message": "Add staged file\n\nBody line", "token": preview["token"] }))
        .unwrap();
    assert_eq!(result["summary"], "Add staged file");
    assert_eq!(
        git(&a, &["show", "--name-only", "--format=", "HEAD"]),
        "staged.txt\n"
    );
    assert_eq!(fs::read(a.join("readme.txt")).unwrap(), b"one\ntwo\n");
    assert_eq!(git(&a, &["status", "--porcelain"]), " M readme.txt\n");
    // The other repository's index and HEAD are untouched.
    assert_eq!(git_bytes(&b, &["ls-files", "--stage", "-z"]), b_index);
    assert_eq!(git(&b, &["log", "--format=%s"]), "initial\n");
}

#[test]
fn commit_rejects_a_changed_index_and_reports_hooks_and_signing() {
    let fixture = Fixture::new();
    let a = fixture.repo("a");
    fs::write(a.join("x.txt"), b"x\n").unwrap();
    git(&a, &["add", "x.txt"]);
    let preview = fixture
        .request(&a, json!({ "op": "commitPreview" }))
        .unwrap();
    fs::write(a.join("y.txt"), b"y\n").unwrap();
    git(&a, &["add", "y.txt"]);
    let before = head(&a);
    let error = fixture
        .request(
            &a,
            json!({ "op": "commit", "message": "x", "token": preview["token"] }),
        )
        .unwrap_err();
    assert!(error.contains("Index 已在預覽後變更"), "{error}");
    assert_eq!(head(&a), before);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let hook = a.join(".git/hooks/pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\necho 'lint failed: synthetic' >&2\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let preview = fixture
            .request(&a, json!({ "op": "commitPreview" }))
            .unwrap();
        assert_eq!(preview["hooks"], json!(["pre-commit"]));
        let error = fixture
            .request(
                &a,
                json!({ "op": "commit", "message": "x", "token": preview["token"] }),
            )
            .unwrap_err();
        assert!(error.contains("lint failed: synthetic"), "{error}");
        assert_eq!(head(&a), before);
        fs::remove_file(hook).unwrap();
    }

    git(&a, &["config", "commit.gpgsign", "true"]);
    git(&a, &["config", "gpg.program", "false"]);
    let preview = fixture
        .request(&a, json!({ "op": "commitPreview" }))
        .unwrap();
    assert_eq!(preview["signing"], "openpgp");
    let error = fixture
        .request(
            &a,
            json!({ "op": "commit", "message": "x", "token": preview["token"] }),
        )
        .unwrap_err();
    assert!(error.contains("簽章失敗"), "{error}");
    assert_eq!(head(&a), before);
}

#[test]
fn push_sets_upstream_confirms_and_never_pushes_tags() {
    let fixture = Fixture::new();
    let a = fixture.repo("a");
    let bare = fixture.remote(&a, "a");
    git(&a, &["config", "push.followTags", "true"]);
    git(&a, &["tag", "-a", "v1", "-m", "release"]);
    git(&a, &["tag", "light"]);
    let plan = fixture.request(&a, json!({ "op": "pushPlan" })).unwrap();
    assert_eq!(plan["upstreamRemote"], Value::Null);
    assert_eq!(plan["followTagsConfigured"], true);
    let result = fixture
        .request(&a, json!({ "op": "push", "remote": "origin", "localBranch": "main", "remoteBranch": "main", "setUpstream": true }))
        .unwrap();
    assert_eq!(result["confirmed"], true);
    assert_eq!(git(&bare, &["rev-parse", "main"]).trim(), head(&a));
    assert!(
        git(&bare, &["tag"]).is_empty(),
        "tags must not be pushed implicitly"
    );
    let plan = fixture.request(&a, json!({ "op": "pushPlan" })).unwrap();
    assert_eq!(plan["upstreamRemote"], "origin");
    assert_eq!(plan["upstreamBranch"], "main");
}

#[test]
fn rejected_and_offline_pushes_are_never_reported_as_success() {
    let fixture = Fixture::new();
    let a = fixture.repo("a");
    let bare = fixture.remote(&a, "a");
    git(&a, &["push", "-q", "-u", "origin", "main"]);
    // Someone else advances the remote.
    let other = fixture.base.join("other");
    git(
        &fixture.base,
        &[
            "clone",
            "-q",
            bare.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    commit_file(&other, "theirs.txt", b"theirs\n", "theirs");
    git(&other, &["push", "-q", "origin", "main"]);
    commit_file(&a, "ours.txt", b"ours\n", "ours");
    let error = fixture
        .request(&a, json!({ "op": "push", "remote": "origin", "localBranch": "main", "remoteBranch": "main" }))
        .unwrap_err();
    assert!(error.contains("遠端拒絕推送"), "{error}");

    // ff-only pull refuses diverged history; merge pull integrates it.
    let error = fixture
        .request(&a, json!({ "op": "pull", "strategy": "fastForwardOnly" }))
        .unwrap_err();
    assert!(!error.is_empty());
    fixture
        .request(&a, json!({ "op": "pull", "strategy": "merge" }))
        .unwrap();
    assert_eq!(git(&a, &["rev-list", "--count", "HEAD"]).trim(), "4");

    git(
        &a,
        &[
            "remote",
            "set-url",
            "origin",
            "http://127.0.0.1:9/unreachable.git",
        ],
    );
    let before = head(&a);
    let error = fixture
        .request(&a, json!({ "op": "fetch", "remote": "origin" }))
        .unwrap_err();
    assert!(
        error.contains("無法連線遠端") || error.contains("Git 操作失敗"),
        "{error}"
    );
    assert_eq!(head(&a), before);

    // Option-shaped names never reach Git.
    assert!(fixture
        .request(&a, json!({ "op": "push", "remote": "--receive-pack=evil", "localBranch": "main", "remoteBranch": "main" }))
        .is_err());
    assert!(fixture
        .request(&a, json!({ "op": "push", "remote": "origin", "localBranch": "main", "remoteBranch": "-delete" }))
        .is_err());
}

/// Everything a cancelled network operation must leave untouched.
#[cfg(unix)]
fn local_state(root: &Path, bare: &Path) -> (String, Vec<u8>, Vec<u8>, String, String, bool) {
    (
        head(root),
        git_bytes(root, &["ls-files", "--stage", "-z"]),
        fs::read(root.join("readme.txt")).unwrap(),
        git(root, &["for-each-ref", "--format=%(refname) %(objectname)"]),
        git(bare, &["for-each-ref", "--format=%(refname) %(objectname)"]),
        root.join(".git/index.lock").exists(),
    )
}

/// Run `op` while the synthetic remote's pack program hangs, cancel it midway
/// and require a prompt, explicit cancellation with no state change at all.
#[cfg(unix)]
fn cancel_midway(op: Value, program: &str) {
    use std::time::{Duration, Instant};
    let fixture = Fixture::new();
    let a = fixture.repo("a");
    let bare = fixture.remote(&a, "a");
    git(&a, &["push", "-q", "origin", "main"]);
    git(&a, &["fetch", "-q", "origin"]);
    git(&a, &["branch", "-q", "--set-upstream-to=origin/main"]);
    commit_file(&a, "readme.txt", b"two\n", "local change");
    // Git runs the remote pack program through the shell for local transports.
    git(
        &a,
        &[
            "config",
            &format!("remote.origin.{program}"),
            &format!(
                "sleep 30; git-{}",
                if program == "uploadpack" {
                    "upload-pack"
                } else {
                    "receive-pack"
                }
            ),
        ],
    );
    let before = local_state(&a, &bare);
    let started = Instant::now();
    let result = std::thread::scope(|scope| {
        let running = scope.spawn(|| fixture.request(&a, op));
        // Keep asking until the operation has registered and stopped.
        while !running.is_finished() {
            std::thread::sleep(Duration::from_millis(100));
            fixture
                .request(&a, json!({ "op": "cancelOperation" }))
                .unwrap();
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "cancel did not stop the operation"
            );
        }
        running.join().unwrap()
    });
    assert!(started.elapsed() < Duration::from_secs(15));
    let message = result.expect_err("a cancelled network operation must not report success");
    assert!(message.contains("取消"), "{message}");
    assert!(message.contains("不會自動重送"), "{message}");
    assert_eq!(
        local_state(&a, &bare),
        before,
        "cancel changed repository state"
    );
}

#[cfg(unix)]
#[test]
fn cancelling_fetch_midway_changes_nothing() {
    cancel_midway(json!({ "op": "fetch", "remote": "origin" }), "uploadpack");
}

#[cfg(unix)]
#[test]
fn cancelling_pull_midway_changes_nothing() {
    cancel_midway(
        json!({ "op": "pull", "strategy": "fastForwardOnly" }),
        "uploadpack",
    );
}

#[cfg(unix)]
#[test]
fn cancelling_push_midway_changes_nothing() {
    cancel_midway(
        json!({ "op": "push", "remote": "origin", "localBranch": "main", "remoteBranch": "main" }),
        "receivepack",
    );
}
