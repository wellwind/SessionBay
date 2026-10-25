//! G7/G8 against a real, self-hosted GitLab instance. Opt-in and synthetic:
//! it creates its own throwaway project and users and never touches anything
//! else. Run against a disposable local container, for example:
//!
//! SESSIONBAY_TEST_GITLAB_URL=http://127.0.0.1:8929 \
//! SESSIONBAY_TEST_GITLAB_ADMIN_TOKEN=<admin token of that container> \
//! cargo test --no-default-features --test git_real_gitlab -- --ignored --nocapture
#[path = "support/git_fixture.rs"]
mod git_fixture;

use git_fixture::{commit_file, git, init_repo, temp};
use serde_json::{json, Value};
use sessionbay_lib::git::{GitRequest, GitService, ProjectGit};
use std::{path::Path, process::Command};

struct Gitlab {
    url: String,
    token: String,
}

impl Gitlab {
    /// Plain REST through curl, so the test exercises Session Bay's client only.
    fn api(&self, method: &str, path: &str, body: Option<Value>) -> Value {
        let mut command = Command::new("curl");
        command.args([
            "-sS",
            "-X",
            method,
            "-H",
            &format!("PRIVATE-TOKEN: {}", self.token),
            "-H",
            "Content-Type: application/json",
        ]);
        if let Some(body) = body {
            command.args(["--data", &body.to_string()]);
        }
        let output = command
            .arg(format!("{}/api/v4{path}", self.url))
            .output()
            .unwrap();
        assert!(output.status.success(), "curl {method} {path}");
        serde_json::from_slice(&output.stdout).unwrap_or(Value::Null)
    }
}

fn hosting(service: &GitService, root: &Path, value: Value) -> Result<Value, String> {
    service.handle_hosting(root, serde_json::from_value(value).unwrap())
}

fn request(service: &GitService, root: &Path, mut value: Value) -> Result<Value, String> {
    let ProjectGit::Ready(found) = service.discover(root).unwrap() else {
        panic!("not a repository")
    };
    value["repoId"] = json!(found.repos[0].id);
    if value.get("remote").is_none() {
        value["remote"] = json!("origin");
    }
    service.handle(root, serde_json::from_value::<GitRequest>(value).unwrap())
}

#[test]
#[ignore]
fn real_gitlab_connection_review_and_merge_round_trip() {
    let (Ok(url), Ok(admin)) = (
        std::env::var("SESSIONBAY_TEST_GITLAB_URL"),
        std::env::var("SESSIONBAY_TEST_GITLAB_ADMIN_TOKEN"),
    ) else {
        panic!("set SESSIONBAY_TEST_GITLAB_URL and SESSIONBAY_TEST_GITLAB_ADMIN_TOKEN");
    };
    let admin = Gitlab {
        url: url.trim_end_matches('/').to_owned(),
        token: admin,
    };
    let version = admin.api("GET", "/version", None);
    println!("GitLab version: {}", version["version"]);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();

    // Synthetic owner (maintainer) and reader (reporter) accounts with their own tokens.
    let user = |name: &str| {
        let created = admin.api("POST", "/users", Some(json!({ "username": format!("{name}{stamp}"), "name": name,
            "email": format!("{name}{stamp}@example.invalid"), "password": "Synthetic-Pass-2026!", "skip_confirmation": true })));
        let id = created["id"].as_i64().expect("user created");
        let token = admin.api("POST", &format!("/users/{id}/impersonation_tokens"),
            Some(json!({ "name": "sessionbay-acceptance", "scopes": ["api"], "expires_at": "2027-12-31" })));
        (id, token["token"].as_str().expect("token").to_owned())
    };
    let (owner_id, owner_token) = user("sbowner");
    let (reader_id, reader_token) = user("sbreader");
    let owner = Gitlab {
        url: admin.url.clone(),
        token: owner_token.clone(),
    };
    let project = owner.api(
        "POST",
        "/projects",
        Some(json!({ "name": format!("sb-acceptance-{stamp}"), "visibility": "private" })),
    );
    let project_id = project["id"].as_i64().expect("project created");
    let path = project["path_with_namespace"].as_str().unwrap().to_owned();
    admin.api(
        "POST",
        &format!("/projects/{project_id}/members"),
        Some(json!({ "user_id": reader_id, "access_level": 20 })),
    );
    let _ = owner_id;

    // Local repository pushing to the real instance (credentials only in the push URL).
    let (_temp, base) = temp();
    let root = init_repo(&base.join("repo"));
    commit_file(&root, "app.txt", b"one\ntwo\nthree\n", "initial");
    let authority = admin.url.split("://").nth(1).unwrap();
    let push_url = format!("http://oauth2:{owner_token}@{authority}/{path}.git");
    git(
        &root,
        &[
            "remote",
            "add",
            "origin",
            &format!("{}/{path}.git", admin.url),
        ],
    );
    git(&root, &["push", "-q", &push_url, "main"]);
    git(&root, &["switch", "-q", "-c", "feature"]);
    commit_file(&root, "app.txt", b"one\nTWO\nthree\n", "change two");
    git(&root, &["push", "-q", &push_url, "feature"]);
    let first_head = git(&root, &["rev-parse", "HEAD"]).trim().to_owned();

    // G7: connection through Session Bay, then remote mapping.
    let data = base.join("data");
    let service = GitService::with_data_dir(data.clone());
    let added = hosting(&service, &root, json!({ "op": "addConnection", "provider": "gitlab", "webUrl": admin.url, "token": owner_token, "source": "entered", "account": null })).unwrap();
    let connection = added["connection"]["id"].as_str().unwrap().to_owned();
    hosting(
        &service,
        &root,
        json!({ "op": "testConnection", "id": connection }),
    )
    .unwrap();
    request(&service, &root, json!({ "op": "setRemoteMapping", "remote": "origin", "connectionId": connection, "project": path })).unwrap();

    // G8: create, list and inspect the MR.
    let created = request(&service, &root, json!({ "op": "pullCreate", "title": "Change two", "body": "Synthetic", "source": "feature", "target": "main", "draft": false })).unwrap();
    let number = created["number"].as_u64().expect("MR number");
    let listed = request(&service, &root, json!({ "op": "pulls", "state": "open" })).unwrap();
    assert!(listed.to_string().contains("Change two"), "{listed}");
    let detail = request(
        &service,
        &root,
        json!({ "op": "pullDetail", "number": number }),
    )
    .unwrap();
    assert_eq!(detail["summary"]["headSha"], first_head, "{detail}");
    assert_ne!(
        detail["ci"]["state"], "success",
        "no CI must never read as passed: {detail}"
    );
    let files = request(
        &service,
        &root,
        json!({ "op": "pullFiles", "number": number }),
    )
    .unwrap();
    assert!(files.to_string().contains("app.txt"), "{files}");

    // Line comment on the new side, then approval bound to the seen head.
    request(&service, &root, json!({ "op": "pullComment", "number": number, "body": "Synthetic line note", "expectedHead": first_head,
        "position": { "path": "app.txt", "oldPath": "app.txt", "side": "new", "line": 2 } })).unwrap();
    let discussions = owner.api(
        "GET",
        &format!("/projects/{project_id}/merge_requests/{number}/discussions"),
        None,
    );
    assert!(
        discussions.to_string().contains("Synthetic line note"),
        "{discussions}"
    );
    request(&service, &root, json!({ "op": "pullReview", "number": number, "event": "approve", "expectedHead": first_head })).unwrap();
    let approvals = owner.api(
        "GET",
        &format!("/projects/{project_id}/merge_requests/{number}/approvals"),
        None,
    );
    assert!(
        approvals["approved_by"]
            .as_array()
            .is_some_and(|by| !by.is_empty()),
        "{approvals}"
    );

    // A reader cannot merge; the platform's refusal is reported.
    let reader = hosting(&service, &root, json!({ "op": "addConnection", "provider": "gitlab", "webUrl": admin.url, "token": reader_token, "source": "entered", "account": null })).unwrap();
    request(&service, &root, json!({ "op": "setRemoteMapping", "remote": "origin", "connectionId": reader["connection"]["id"], "project": path })).unwrap();
    let refused = request(&service, &root, json!({ "op": "pullMerge", "number": number, "method": "merge", "expectedHead": first_head })).unwrap_err();
    println!("reader merge refused: {refused}");
    request(&service, &root, json!({ "op": "setRemoteMapping", "remote": "origin", "connectionId": connection, "project": path })).unwrap();

    // The head moves on the host: merging the old head must be rejected.
    commit_file(&root, "app.txt", b"one\nTWO\nTHREE\n", "change three");
    git(&root, &["push", "-q", &push_url, "feature"]);
    let fresh_head = git(&root, &["rev-parse", "HEAD"]).trim().to_owned();
    std::thread::sleep(std::time::Duration::from_secs(3)); // let GitLab refresh the MR head
    let stale = request(&service, &root, json!({ "op": "pullMerge", "number": number, "method": "merge", "expectedHead": first_head })).unwrap_err();
    println!("stale merge refused: {stale}");
    assert_eq!(
        owner.api(
            "GET",
            &format!("/projects/{project_id}/merge_requests/{number}"),
            None
        )["state"],
        "opened"
    );

    // Merge with the fresh head.
    let mut merged = Err(String::new());
    for _ in 0..10 {
        merged = request(
            &service,
            &root,
            json!({ "op": "pullMerge", "number": number, "method": "merge", "expectedHead": fresh_head }),
        );
        if merged.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(2)); // mergeability is computed asynchronously
    }
    merged.unwrap();
    assert_eq!(
        owner.api(
            "GET",
            &format!("/projects/{project_id}/merge_requests/{number}"),
            None
        )["state"],
        "merged"
    );

    // Tokens never land in Session Bay's own files.
    for entry in walk(&data) {
        let bytes = std::fs::read(&entry).unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            !text.contains(&owner_token) && !text.contains(&reader_token),
            "token persisted in {}",
            entry.display()
        );
    }
    println!("GitLab {} round trip passed for {path}", version["version"]);
}

fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}
