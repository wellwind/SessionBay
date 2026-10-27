//! G8: PR/MR flows against stateful loopback mocks of GitHub and GitLab.
//! These are contract tests of Session Bay's requests, not of real hosts.
#[path = "support/git_fixture.rs"]
mod git_fixture;
#[path = "support/mock_host.rs"]
mod mock_host;

use git_fixture::{commit_file, git, init_repo, temp};
use mock_host::MockHost;
use serde_json::{json, Value};
use sessionbay_lib::git::{GitRequest, GitService, ProjectGit};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

fn bare_path(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

fn github(head: Arc<Mutex<String>>) -> MockHost {
    MockHost::start(Box::new(move |seen| {
        if seen.header("authorization") != Some("Bearer token-alice") {
            return (401, vec![], "{}".into());
        }
        let head = head.lock().unwrap().clone();
        let base = "/api/v3/repos/team/app";
        let pull = json!({ "number": 7, "title": "Add feature", "state": "open", "draft": false, "user": { "login": "bob" },
            "head": { "ref": "feature", "sha": head }, "base": { "ref": "main", "sha": "b".repeat(40) }, "mergeable": true,
            "mergeable_state": "clean", "body": "Body", "html_url": "https://github.example.test/team/app/pull/7", "updated_at": "2026-10-20T00:00:00Z" });
        let path = bare_path(&seen.path);
        let body: Value = serde_json::from_str(&seen.body).unwrap_or(Value::Null);
        let ok = |value: Value| (200, vec![], value.to_string());
        match (
            seen.method.as_str(),
            path.strip_prefix(base).unwrap_or(path),
        ) {
            ("GET", "/api/v3/user") => ok(json!({ "login": "alice" })),
            ("GET", "") => ok(
                json!({ "permissions": { "push": true }, "allow_merge_commit": true, "allow_squash_merge": true, "allow_rebase_merge": false }),
            ),
            ("GET", "/pulls") => ok(json!([pull])),
            ("GET", "/pulls/7") => ok(pull),
            ("GET", "/pulls/7/reviews") => {
                ok(json!([{ "user": { "login": "carol" }, "state": "APPROVED" }]))
            }
            ("GET", "/pulls/7/files") => ok(
                json!([{ "filename": "src/a.rs", "status": "modified", "additions": 1, "deletions": 1, "patch": "@@ -1 +1 @@\n-a\n+b" },
                { "filename": "logo.png", "status": "added", "additions": 0, "deletions": 0 }]),
            ),
            ("GET", "/issues/7/comments") => ok(
                json!([{ "id": 1, "user": { "login": "carol" }, "body": "LGTM", "created_at": "2026-10-20T01:00:00Z" }]),
            ),
            ("GET", "/pulls/7/comments") => ok(
                json!([{ "id": 2, "user": { "login": "carol" }, "body": "nit", "created_at": "2026-10-20T00:30:00Z", "path": "src/a.rs", "line": 1, "side": "RIGHT" }]),
            ),
            ("GET", p) if p.ends_with("/check-runs") => ok(
                json!({ "check_runs": [{ "name": "build", "status": "completed", "conclusion": "success", "html_url": "https://ci" },
                { "name": "test", "status": "in_progress", "conclusion": null }] }),
            ),
            ("GET", p) if p.ends_with("/status") => ok(json!({ "statuses": [] })),
            ("POST", "/pulls/7/comments")
            | ("POST", "/issues/7/comments")
            | ("POST", "/pulls/7/reviews") => (201, vec![], "{}".into()),
            ("PUT", "/pulls/7/merge") if body["sha"] != head => (
                409,
                vec![],
                json!({ "message": "Head branch was modified" }).to_string(),
            ),
            ("PUT", "/pulls/7/merge") => ok(json!({ "merged": true })),
            ("POST", "/pulls") => (201, vec![], pull.to_string()),
            _ => (404, vec![], "{}".into()),
        }
    }))
}

fn gitlab(head: Arc<Mutex<String>>) -> MockHost {
    MockHost::start(Box::new(move |seen| {
        if seen.header("private-token") != Some("glpat-carol") {
            return (401, vec![], "{}".into());
        }
        let head = head.lock().unwrap().clone();
        let base = "/api/v4/projects/team%2Fsub%2Fapp";
        let body: Value = serde_json::from_str(&seen.body).unwrap_or(Value::Null);
        let mr = json!({ "iid": 3, "title": "Fix", "state": "opened", "draft": false, "author": { "username": "dave" }, "source_branch": "fix", "target_branch": "main",
            "sha": head, "diff_refs": { "base_sha": "1".repeat(40), "start_sha": "2".repeat(40), "head_sha": head }, "user": { "can_merge": false },
            "detailed_merge_status": "mergeable", "head_pipeline": { "id": 9, "status": "failed", "web_url": "https://gitlab.ci/9" }, "web_url": "https://gl/mr/3" });
        let ok = |value: Value| (200, vec![], value.to_string());
        let path = bare_path(&seen.path);
        match (
            seen.method.as_str(),
            path.strip_prefix(base).unwrap_or(path),
        ) {
            ("GET", "/api/v4/user") => ok(json!({ "username": "carol" })),
            ("GET", "/api/v4/version") => ok(json!({ "version": "16.11.0" })),
            ("GET", "") => ok(
                json!({ "permissions": { "project_access": { "access_level": 30 } }, "merge_method": "merge", "squash_option": "default_off" }),
            ),
            ("GET", "/merge_requests/3") => ok(mr),
            ("GET", "/merge_requests/3/approvals") => ok(json!({ "approved_by": [] })),
            ("POST", "/merge_requests/3/approve") if body["sha"] != head => (
                409,
                vec![],
                json!({ "message": "SHA does not match HEAD of source branch" }).to_string(),
            ),
            ("POST", "/merge_requests/3/approve") | ("POST", "/merge_requests/3/discussions") => {
                (201, vec![], "{}".into())
            }
            ("PUT", "/merge_requests/3/merge") => (
                405,
                vec![],
                json!({ "message": "405 Method Not Allowed" }).to_string(),
            ),
            _ => (404, vec![], "{}".into()),
        }
    }))
}

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    service: GitService,
}

impl Fixture {
    fn new(provider: &str, server: &MockHost, token: &str, url: &str, project: &str) -> Self {
        let (temp, base) = temp();
        let root = init_repo(&base.join("repo"));
        commit_file(&root, "f.txt", b"x\n", "initial");
        git(&root, &["remote", "add", "origin", url]);
        let fixture = Self {
            _temp: temp,
            root,
            service: GitService::with_data_dir(base.join("data")),
        };
        let added = fixture
            .service
            .handle_hosting(&fixture.root, serde_json::from_value(json!({ "op": "addConnection", "provider": provider, "webUrl": server.base, "token": token, "source": "entered", "account": null })).unwrap())
            .unwrap();
        fixture.git(json!({ "op": "setRemoteMapping", "remote": "origin", "connectionId": added["connection"]["id"], "project": project })).unwrap();
        fixture
    }
    fn git(&self, mut value: Value) -> Result<Value, String> {
        let ProjectGit::Ready(found) = self.service.discover(&self.root).unwrap() else {
            panic!()
        };
        value["repoId"] = json!(found.repos[0].id);
        if value.get("remote").is_none() {
            value["remote"] = json!("origin");
        }
        self.service.handle(
            &self.root,
            serde_json::from_value::<GitRequest>(value).unwrap(),
        )
    }
}

#[test]
fn github_review_and_merge_are_bound_to_the_seen_head() {
    let head = Arc::new(Mutex::new("a".repeat(40)));
    let server = github(head.clone());
    let fixture = Fixture::new(
        "github",
        &server,
        "token-alice",
        "git@127.0.0.1:team/app.git",
        "team/app",
    );

    let list = fixture
        .git(json!({ "op": "pulls", "state": "open" }))
        .unwrap();
    assert_eq!(list[0]["number"], 7);
    let detail = fixture
        .git(json!({ "op": "pullDetail", "number": 7 }))
        .unwrap();
    assert_eq!(detail["ci"]["state"], "running");
    assert_eq!(detail["approvedBy"], json!(["carol"]));
    assert_eq!(
        detail["capabilities"]["mergeMethods"],
        json!(["merge", "squash"])
    );
    assert_eq!(detail["capabilities"]["canApprove"], true);
    assert_eq!(detail["connection"]["account"], "alice");
    let files = fixture
        .git(json!({ "op": "pullFiles", "number": 7 }))
        .unwrap();
    assert!(files["files"][1]["patch"].is_null());
    let comments = fixture
        .git(json!({ "op": "pullComments", "number": 7 }))
        .unwrap();
    assert_eq!(comments[0]["body"], "nit");
    assert_eq!(comments[0]["side"], "new");
    let seen = detail["summary"]["headSha"].as_str().unwrap().to_owned();

    fixture
        .git(
            json!({ "op": "pullComment", "number": 7, "body": "Why?", "expectedHead": seen,
        "position": { "path": "src/a.rs", "oldPath": null, "side": "new", "line": 1 } }),
        )
        .unwrap();
    let posted: Value = serde_json::from_str(
        &server
            .requests()
            .iter()
            .rev()
            .find(|r| r.method == "POST")
            .unwrap()
            .body,
    )
    .unwrap();
    assert_eq!(posted["commit_id"], seen);
    assert_eq!(posted["side"], "RIGHT");

    // Someone pushes: the old review and merge previews are stale.
    *head.lock().unwrap() = "c".repeat(40);
    let before = server.requests().len();
    let error = fixture
        .git(json!({ "op": "pullReview", "number": 7, "event": "approve", "expectedHead": seen }))
        .unwrap_err();
    assert!(error.contains("A new commit is on the remote"), "{error}");
    assert!(fixture
        .git(json!({ "op": "pullMerge", "number": 7, "method": "merge", "expectedHead": seen }))
        .is_err());
    assert!(
        server.requests()[before..]
            .iter()
            .all(|r| r.method == "GET"),
        "no write after a stale head"
    );

    let fresh = "c".repeat(40);
    fixture
        .git(json!({ "op": "pullReview", "number": 7, "event": "approve", "expectedHead": fresh }))
        .unwrap();
    let review: Value = serde_json::from_str(
        &server
            .requests()
            .iter()
            .rev()
            .find(|r| r.method == "POST")
            .unwrap()
            .body,
    )
    .unwrap();
    assert_eq!(
        (review["event"].as_str(), review["commit_id"].as_str()),
        (Some("APPROVE"), Some(fresh.as_str()))
    );
    assert!(fixture
        .git(json!({ "op": "pullMerge", "number": 7, "method": "rebase", "expectedHead": fresh }))
        .unwrap_err()
        .contains("does not allow"));
    fixture
        .git(json!({ "op": "pullMerge", "number": 7, "method": "squash", "expectedHead": fresh }))
        .unwrap();
    let merge: Value = serde_json::from_str(
        &server
            .requests()
            .iter()
            .rev()
            .find(|r| r.method == "PUT")
            .unwrap()
            .body,
    )
    .unwrap();
    assert_eq!(merge["sha"], fresh);

    // Creating a PR requires the source branch on the remote.
    git(&fixture.root, &["branch", "feature"]);
    assert!(fixture
        .git(json!({ "op": "pullCreate", "title": "x", "source": "feature", "target": "main" }))
        .unwrap_err()
        .contains("push this branch"));
    git(
        &fixture.root,
        &["update-ref", "refs/remotes/origin/feature", "HEAD"],
    );
    let created = fixture.git(json!({ "op": "pullCreate", "title": "Add feature", "source": "feature", "target": "main", "draft": true })).unwrap();
    assert_eq!(created["number"], 7);
    let sent: Value = serde_json::from_str(
        &server
            .requests()
            .iter()
            .rev()
            .find(|r| r.method == "POST")
            .unwrap()
            .body,
    )
    .unwrap();
    assert_eq!(
        (
            sent["head"].as_str(),
            sent["base"].as_str(),
            sent["draft"].as_bool()
        ),
        (Some("feature"), Some("main"), Some(true))
    );
}

#[test]
fn gitlab_permissions_ci_and_positions_follow_the_platform() {
    let head = Arc::new(Mutex::new("d".repeat(40)));
    let server = gitlab(head.clone());
    let fixture = Fixture::new(
        "gitlab",
        &server,
        "glpat-carol",
        "ssh://git@127.0.0.1:2222/team/sub/app.git",
        "team/sub/app",
    );
    let detail = fixture
        .git(json!({ "op": "pullDetail", "number": 3 }))
        .unwrap();
    assert_eq!(detail["ci"]["state"], "failure");
    assert_eq!(detail["ci"]["webUrl"], "https://gitlab.ci/9");
    assert_eq!(detail["capabilities"]["canMerge"], false);
    assert_eq!(detail["capabilities"]["canRequestChanges"], false);
    assert_eq!(detail["startSha"], "2".repeat(40));
    let seen = "d".repeat(40);

    fixture
        .git(
            json!({ "op": "pullComment", "number": 3, "body": "Consider", "expectedHead": seen,
        "position": { "path": "a.rb", "oldPath": "a.rb", "side": "old", "line": 4 } }),
        )
        .unwrap();
    let discussion: Value = serde_json::from_str(
        &server
            .requests()
            .iter()
            .rev()
            .find(|r| r.method == "POST")
            .unwrap()
            .body,
    )
    .unwrap();
    assert_eq!(discussion["position"]["old_line"], 4);
    assert_eq!(discussion["position"]["start_sha"], "2".repeat(40));
    assert_eq!(discussion["position"]["head_sha"], seen);

    fixture
        .git(json!({ "op": "pullReview", "number": 3, "event": "approve", "expectedHead": seen }))
        .unwrap();
    let approve: Value = serde_json::from_str(
        &server
            .requests()
            .iter()
            .rev()
            .find(|r| r.method == "POST")
            .unwrap()
            .body,
    )
    .unwrap();
    assert_eq!(approve["sha"], seen);
    assert!(fixture.git(json!({ "op": "pullReview", "number": 3, "event": "requestChanges", "body": "x", "expectedHead": seen })).unwrap_err().contains("does not support"));
    // The platform's refusal is reported, not hidden behind a uniform button.
    let error = fixture
        .git(json!({ "op": "pullMerge", "number": 3, "method": "merge", "expectedHead": seen }))
        .unwrap_err();
    assert!(
        error.contains("host rejected") || error.contains("HTTP 405"),
        "{error}"
    );
    // An unmapped remote has no account to use.
    git(
        &fixture.root,
        &["remote", "add", "fork", "https://example.test/x/y.git"],
    );
    assert!(fixture
        .git(json!({ "op": "pulls", "remote": "fork" }))
        .unwrap_err()
        .contains("not linked to a host account"));
}
