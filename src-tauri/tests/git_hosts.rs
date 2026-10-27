//! G7: host/account connections against loopback mock APIs only.
#[path = "support/git_fixture.rs"]
mod git_fixture;
#[path = "support/mock_host.rs"]
mod mock_host;

use git_fixture::{commit_file, git, init_repo, temp};
use mock_host::MockHost;
use serde_json::{json, Value};
use sessionbay_lib::git::{hosting::HostRequest, GitRequest, GitService, ProjectGit};
use std::{fs, path::PathBuf};

/// GitHub-style API: each token belongs to one login.
fn github() -> MockHost {
    MockHost::start(Box::new(|seen| {
        let user = match seen.header("authorization") {
            Some("Bearer token-alice") => "alice",
            Some("Bearer token-bob") => "bob",
            _ => {
                return (
                    401,
                    vec![],
                    json!({ "message": "Bad credentials" }).to_string(),
                )
            }
        };
        match seen.path.as_str() {
            "/api/v3/user" => (
                200,
                vec![
                    ("X-OAuth-Scopes".into(), "repo, read:org".into()),
                    ("X-GitHub-Enterprise-Version".into(), "3.17.0".into()),
                ],
                json!({ "login": user }).to_string(),
            ),
            _ => (404, vec![], json!({ "message": "Not Found" }).to_string()),
        }
    }))
}

struct Fixture {
    _temp: tempfile::TempDir,
    data: PathBuf,
    root: PathBuf,
    service: GitService,
}

impl Fixture {
    fn new() -> Self {
        let (temp, base) = temp();
        let root = init_repo(&base.join("repo"));
        commit_file(&root, "f.txt", b"x\n", "initial");
        let data = base.join("data");
        Self {
            _temp: temp,
            service: GitService::with_data_dir(data.clone()),
            data,
            root,
        }
    }
    fn host(&self, value: Value) -> Result<Value, String> {
        self.service.handle_hosting(
            &self.root,
            serde_json::from_value::<HostRequest>(value).unwrap(),
        )
    }
    fn git(&self, mut value: Value) -> Result<Value, String> {
        let ProjectGit::Ready(found) = self.service.discover(&self.root).unwrap() else {
            panic!()
        };
        value["repoId"] = json!(found.repos[0].id);
        self.service.handle(
            &self.root,
            serde_json::from_value::<GitRequest>(value).unwrap(),
        )
    }
}

#[test]
fn accounts_on_one_host_keep_separate_tokens_and_settings_hold_no_secrets() {
    let fixture = Fixture::new();
    let server = github();
    let add = |token: &str, account: Option<&str>| {
        fixture.host(
            json!({ "op": "addConnection", "provider": "github", "webUrl": server.base,
        "account": account, "token": token, "source": "entered", "persist": false }),
        )
    };
    let alice = add("token-alice", Some("alice")).unwrap();
    assert_eq!(alice["connection"]["account"], "alice");
    assert_eq!(
        alice["connection"]["serverVersion"],
        "GitHub Enterprise Server 3.17.0"
    );
    assert_eq!(alice["connection"]["scopes"], json!(["repo", "read:org"]));
    assert!(alice["warnings"][0]
        .as_str()
        .unwrap()
        .contains("for this run only"));
    // A token for a different account than claimed is refused.
    assert!(add("token-bob", Some("alice"))
        .unwrap_err()
        .contains("belongs to bob"));
    let bob = add("token-bob", None).unwrap();
    assert!(add("token-bob", None)
        .unwrap_err()
        .contains("already connected"));

    for (connection, token) in [(&alice, "token-alice"), (&bob, "token-bob")] {
        fixture
            .host(json!({ "op": "testConnection", "id": connection["connection"]["id"] }))
            .unwrap();
        let last = server.requests().pop().unwrap();
        assert_eq!(
            last.header("authorization"),
            Some(&*format!("Bearer {token}"))
        );
        assert!(!last.path.contains("token"));
    }
    let settings = fs::read_to_string(fixture.data.join("git-hosts.json")).unwrap();
    assert!(!settings.contains("token-alice") && !settings.contains("token-bob"));
    let listed = fixture.host(json!({ "op": "connections" })).unwrap();
    assert_eq!(listed["connections"].as_array().unwrap().len(), 2);
    assert_eq!(listed["connections"][0]["sessionOnly"], true);

    // A fresh service (new app session) has no session tokens to fall back on.
    let restarted = GitService::with_data_dir(fixture.data.clone());
    let error = restarted
        .handle_hosting(
            &fixture.root,
            serde_json::from_value(
                json!({ "op": "testConnection", "id": alice["connection"]["id"] }),
            )
            .unwrap(),
        )
        .unwrap_err();
    assert!(error.contains("No login found for alice@"), "{error}");

    fixture
        .host(json!({ "op": "removeConnection", "id": bob["connection"]["id"] }))
        .unwrap();
    assert_eq!(
        fixture.host(json!({ "op": "connections" })).unwrap()["connections"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn gitlab_identity_failures_are_diagnosable() {
    let fixture = Fixture::new();
    let server = MockHost::start(Box::new(|seen| {
        match (seen.path.as_str(), seen.header("private-token")) {
            ("/gitlab/api/v4/user", Some("glpat-good")) => {
                (200, vec![], json!({ "username": "carol" }).to_string())
            }
            ("/gitlab/api/v4/version", Some("glpat-good")) => {
                (200, vec![], json!({ "version": "17.11.2-ee" }).to_string())
            }
            ("/gitlab/api/v4/personal_access_tokens/self", Some("glpat-good")) => {
                (200, vec![], json!({ "scopes": ["api"] }).to_string())
            }
            _ => (
                401,
                vec![],
                json!({ "message": "401 Unauthorized" }).to_string(),
            ),
        }
    }));
    let web = format!("{}/gitlab", server.base);
    let ok = fixture
        .host(json!({ "op": "addConnection", "provider": "gitlab", "webUrl": web, "token": "glpat-good", "source": "entered", "account": null }))
        .unwrap();
    assert_eq!(ok["connection"]["serverVersion"], "GitLab 17.11.2-ee");
    assert_eq!(ok["connection"]["scheme"], "privateToken");
    assert_eq!(ok["connection"]["apiUrl"], format!("{web}/api/v4"));
    let error = fixture
        .host(json!({ "op": "addConnection", "provider": "gitlab", "webUrl": web, "token": "glpat-expired", "source": "entered", "account": null }))
        .unwrap_err();
    assert!(error.contains("login expired"), "{error}");
    // Plain HTTP is only for loopback; DNS failures name the likely cause.
    assert!(fixture
        .host(json!({ "op": "addConnection", "provider": "gitlab", "webUrl": "http://gitlab.example.test", "token": "x", "source": "entered", "account": null }))
        .unwrap_err()
        .contains("https"));
    let error = fixture
        .host(json!({ "op": "addConnection", "provider": "gitlab", "webUrl": "https://gitlab.sessionbay.invalid", "token": "x", "source": "entered", "account": null }))
        .unwrap_err();
    assert!(
        error.contains("DNS") || error.contains("Cannot connect"),
        "{error}"
    );
    // Only configured hosts may be opened in the browser.
    assert!(fixture
        .host(json!({ "op": "openExternal", "url": "https://evil.example.test/x" }))
        .unwrap_err()
        .contains("configured hosts"));
}

#[cfg(unix)]
#[test]
fn plaintext_credential_helpers_are_never_written() {
    let fixture = Fixture::new();
    let server = github();
    let store = fixture.data.parent().unwrap().join("plain-credentials");
    git(
        &fixture.root,
        &[
            "config",
            "credential.helper",
            &format!("store --file={}", store.display()),
        ],
    );
    let added = fixture
        .host(json!({ "op": "addConnection", "provider": "github", "webUrl": server.base, "token": "token-alice", "source": "entered", "persist": true, "account": null }))
        .unwrap();
    assert!(
        added["warnings"][0]
            .as_str()
            .unwrap()
            .contains("plain text"),
        "{added}"
    );
    assert!(!store.exists() || !fs::read_to_string(&store).unwrap().contains("token-alice"));
    assert_eq!(added["connection"]["storedByApp"], false);
}

#[test]
fn remote_mappings_match_host_and_require_a_confirmed_project() {
    let fixture = Fixture::new();
    let server = github();
    let alice = fixture
        .host(json!({ "op": "addConnection", "provider": "github", "webUrl": server.base, "token": "token-alice", "source": "entered", "account": null }))
        .unwrap();
    git(
        &fixture.root,
        &[
            "remote",
            "add",
            "origin",
            "ssh://git@127.0.0.1:2222/team/sub/app.git",
        ],
    );
    git(
        &fixture.root,
        &[
            "remote",
            "add",
            "mirror",
            "https://elsewhere.example.test/x/y.git",
        ],
    );
    let mappings = fixture.git(json!({ "op": "remoteMappings" })).unwrap();
    let origin = mappings
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["remote"] == "origin")
        .unwrap();
    assert_eq!(origin["parsed"]["path"], "team/sub/app");
    assert_eq!(origin["parsed"]["port"], 2222);
    assert_eq!(origin["suggested"], alice["connection"]["id"]);
    assert!(origin["mapping"].is_null());
    let mirror = mappings
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["remote"] == "mirror")
        .unwrap();
    assert!(mirror["candidates"].as_array().unwrap().is_empty());

    assert!(fixture
        .git(json!({ "op": "setRemoteMapping", "remote": "origin", "connectionId": alice["connection"]["id"], "project": "../x" }))
        .is_err());
    let saved = fixture
        .git(json!({ "op": "setRemoteMapping", "remote": "origin", "connectionId": alice["connection"]["id"], "project": "team/sub/app" }))
        .unwrap();
    let origin = saved
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["remote"] == "origin")
        .unwrap();
    assert_eq!(origin["mapping"]["project"], "team/sub/app");
    assert!(fixture.git(json!({ "op": "setRemoteMapping", "remote": "nope", "connectionId": null, "project": null })).is_err());
}

/// A synthetic helper named like a secure one, storing per-account lines in
/// a temp file, to exercise approve/fill/reject without touching the real
/// OS credential store.
#[cfg(unix)]
#[test]
fn secure_helper_round_trip_is_isolated_per_account() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let server = github();
    let dir = fixture.data.parent().unwrap().join("helper");
    fs::create_dir_all(&dir).unwrap();
    let db = dir.join("db");
    let script = dir.join("git-credential-libsecret");
    fs::write(&script, format!(r#"#!/bin/sh
db="{db}"
touch "$db"
input=$(cat)
user=$(printf '%s\n' "$input" | sed -n 's/^username=//p')
host=$(printf '%s\n' "$input" | sed -n 's/^host=//p')
case "$1" in
  get) line=$(grep "^$host $user " "$db" | tail -n 1); [ -n "$line" ] && printf 'username=%s\npassword=%s\n' "$user" "${{line##* }}" ;;
  store) pass=$(printf '%s\n' "$input" | sed -n 's/^password=//p'); grep -v "^$host $user " "$db" > "$db.tmp"; mv "$db.tmp" "$db"; echo "$host $user $pass" >> "$db" ;;
  erase) grep -v "^$host $user " "$db" > "$db.tmp"; mv "$db.tmp" "$db" ;;
esac
"#, db = db.display())).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    git(
        &fixture.root,
        &["config", "credential.helper", script.to_str().unwrap()],
    );

    let add = |token: &str| {
        fixture
            .host(
                json!({ "op": "addConnection", "provider": "github", "webUrl": server.base,
        "token": token, "source": "entered", "persist": true, "account": null }),
            )
            .unwrap()
    };
    let alice = add("token-alice");
    let bob = add("token-bob");
    assert_eq!(alice["connection"]["storedByApp"], true);
    assert!(alice["warnings"].as_array().unwrap().is_empty());
    assert!(!fs::read_to_string(fixture.data.join("git-hosts.json"))
        .unwrap()
        .contains("token-"));

    // After a restart each connection reads back its own account's token.
    let restarted = GitService::with_data_dir(fixture.data.clone());
    for (connection, token) in [(&alice, "token-alice"), (&bob, "token-bob")] {
        restarted
            .handle_hosting(
                &fixture.root,
                serde_json::from_value(
                    json!({ "op": "testConnection", "id": connection["connection"]["id"] }),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(
            server.requests().pop().unwrap().header("authorization"),
            Some(&*format!("Bearer {token}"))
        );
    }
    restarted
        .handle_hosting(&fixture.root, serde_json::from_value(json!({ "op": "removeConnection", "id": alice["connection"]["id"], "forget": true })).unwrap())
        .unwrap();
    let stored = fs::read_to_string(&db).unwrap();
    assert!(!stored.contains("token-alice") && stored.contains("token-bob"));
}

/// Real OS credential store (Windows Credential Manager via GCM, Linux
/// libsecret, macOS Keychain). Opt-in for CI runners only: it writes and then
/// removes one synthetic entry for a `.invalid` host, never a real account.
/// `SESSIONBAY_TEST_CREDENTIAL_HELPER` names the helper to configure.
#[test]
#[ignore]
fn os_credential_store_round_trip() {
    use sessionbay_lib::git::hosting::credentials;
    let Ok(helper) = std::env::var("SESSIONBAY_TEST_CREDENTIAL_HELPER") else {
        panic!("set SESSIONBAY_TEST_CREDENTIAL_HELPER to run this test");
    };
    let fixture = Fixture::new();
    git(
        &fixture.root,
        &["config", "--global", "credential.helper", &helper],
    );
    let runner = fixture.service.runner().unwrap();
    let host = "sessionbay-ci.invalid";
    let account = format!("synthetic-{}", std::process::id());
    let other = format!("{account}-other");
    let token = format!("token-{}", std::process::id());
    let info = credentials::helper_info(&runner, &fixture.root, host);
    assert!(info.secure, "{info:?}");
    credentials::approve(&runner, &fixture.root, host, &account, &token).unwrap();
    let stored = credentials::fill(&runner, &fixture.root, host, &account).unwrap();
    // Remove the entry before asserting so a failure never leaves it behind.
    let isolated = credentials::fill(&runner, &fixture.root, host, &other).unwrap();
    credentials::reject(&runner, &fixture.root, host, &account).unwrap();
    let forgotten = credentials::fill(&runner, &fixture.root, host, &account).unwrap();
    assert_eq!(stored.as_deref(), Some(token.as_str()));
    assert_eq!(isolated, None, "another account must not read this token");
    assert_eq!(forgotten, None);
}
