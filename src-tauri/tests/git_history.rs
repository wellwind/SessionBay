//! G4: history graph data, commit details and blame on synthetic repos.
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
        let service = GitService::new();
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
}

fn subjects(page: &Value) -> Vec<String> {
    page["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["subject"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn empty_repository_has_no_history() {
    let repo = Repo::new();
    let page = repo.request(json!({ "op": "log", "limit": 50 })).unwrap();
    assert!(page["commits"].as_array().unwrap().is_empty());
}

#[test]
fn branching_history_pages_and_merge_parents() {
    let repo = Repo::new();
    let base = commit_file(&repo.root, "a.txt", b"a\n", "base");
    git(&repo.root, &["switch", "-q", "-c", "topic"]);
    commit_file(&repo.root, "topic.txt", b"t\n", "topic work");
    git(&repo.root, &["switch", "-q", "main"]);
    commit_file(&repo.root, "main.txt", b"m\n", "main work");
    git(
        &repo.root,
        &["merge", "-q", "--no-ff", "-m", "merge topic", "topic"],
    );
    git(&repo.root, &["tag", "v1"]);

    let page = repo.request(json!({ "op": "log", "limit": 10 })).unwrap();
    let commits = page["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 4);
    assert_eq!(commits[0]["subject"], "merge topic");
    assert_eq!(commits[0]["parents"].as_array().unwrap().len(), 2);
    let labels: Vec<_> = commits[0]["refs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["name"].clone(), r["kind"].clone()))
        .collect();
    assert!(labels.contains(&(json!("main"), json!("branch"))));
    assert!(labels.contains(&(json!("v1"), json!("tag"))));
    assert!(
        labels.contains(&(json!("topic"), json!("branch")))
            || commits
                .iter()
                .any(|c| c["refs"].to_string().contains("topic"))
    );
    assert_eq!(commits[3]["oid"], base);
    assert_eq!(page["hasMore"], false);
    // Topological order: every parent appears after its children.
    let order: Vec<&str> = commits.iter().map(|c| c["oid"].as_str().unwrap()).collect();
    for (index, commit) in commits.iter().enumerate() {
        for parent in commit["parents"].as_array().unwrap() {
            assert!(
                order
                    .iter()
                    .position(|o| *o == parent.as_str().unwrap())
                    .unwrap()
                    > index
            );
        }
    }

    let first = repo.request(json!({ "op": "log", "limit": 2 })).unwrap();
    assert_eq!(first["hasMore"], true);
    let second = repo
        .request(json!({ "op": "log", "offset": 2, "limit": 2 }))
        .unwrap();
    let mut joined = subjects(&first);
    joined.extend(subjects(&second));
    assert_eq!(joined, subjects(&page));

    // A merge commit needs an explicit parent; each parent shows its side.
    let merge = commits[0]["oid"].as_str().unwrap();
    let detail = repo
        .request(json!({ "op": "commitDetail", "commit": merge }))
        .unwrap();
    assert_eq!(detail["parents"].as_array().unwrap().len(), 2);
    assert!(repo
        .request(json!({ "op": "changedFiles", "source": { "kind": "commit", "commit": merge, "parent": null } }))
        .unwrap_err()
        .contains("parent"));
    let first_parent = repo
        .request(json!({ "op": "changedFiles", "source": { "kind": "commit", "commit": merge, "parent": 1 } }))
        .unwrap();
    assert_eq!(first_parent["files"][0]["path"]["path"], "topic.txt");
    let second_parent = repo
        .request(json!({ "op": "changedFiles", "source": { "kind": "commit", "commit": merge, "parent": 2 } }))
        .unwrap();
    assert_eq!(second_parent["files"][0]["path"]["path"], "main.txt");
    // A root commit compares against the empty tree.
    let root = repo
        .request(json!({ "op": "changedFiles", "source": { "kind": "commit", "commit": base, "parent": null } }))
        .unwrap();
    assert_eq!(root["files"][0]["status"], "A");
}

#[test]
fn filters_follow_renames_and_blame_lines() {
    let repo = Repo::new();
    commit_file(&repo.root, "old name.txt", b"one\ntwo\n", "Create file");
    git(&repo.root, &["mv", "old name.txt", "new name.txt"]);
    git(&repo.root, &["commit", "-q", "-m", "Rename file"]);
    git(
        &repo.root,
        &[
            "-c",
            "user.name=Other Person",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "Unrelated NOTE",
        ],
    );
    fs::write(repo.root.join("new name.txt"), b"one\nTWO\n").unwrap();
    git(&repo.root, &["commit", "-q", "-am", "Edit second line"]);

    let by_text = repo
        .request(json!({ "op": "log", "limit": 10, "filter": { "text": "note" } }))
        .unwrap();
    assert_eq!(subjects(&by_text), vec!["Unrelated NOTE"]);
    assert_eq!(by_text["filtered"], true);
    let by_author = repo
        .request(json!({ "op": "log", "limit": 10, "filter": { "author": "other person" } }))
        .unwrap();
    assert_eq!(subjects(&by_author), vec!["Unrelated NOTE"]);
    let by_path = repo
        .request(json!({ "op": "log", "limit": 10, "filter": { "path": "new name.txt" } }))
        .unwrap();
    assert_eq!(subjects(&by_path), vec!["Edit second line", "Rename file"]);

    let history = repo
        .request(json!({ "op": "fileHistory", "path": "new name.txt", "limit": 10 }))
        .unwrap();
    let revisions = history["revisions"].as_array().unwrap();
    assert_eq!(revisions.len(), 3);
    assert_eq!(revisions[0]["path"]["path"], "new name.txt");
    assert_eq!(revisions[1]["status"], "R");
    assert_eq!(revisions[2]["path"]["path"], "old name.txt");

    fs::write(repo.root.join("new name.txt"), b"one\nTWO\nlocal\n").unwrap();
    let blame = repo
        .request(json!({ "op": "blame", "path": "new name.txt", "rev": null }))
        .unwrap();
    let lines = blame["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 3);
    let summary = |line: &Value| blame["commits"][line["oid"].as_str().unwrap()]["summary"].clone();
    assert_eq!(summary(&lines[0]), "Create file");
    assert_eq!(summary(&lines[1]), "Edit second line");
    assert_eq!(
        blame["commits"][lines[2]["oid"].as_str().unwrap()]["uncommitted"],
        true
    );
    assert_eq!(
        blame["commits"][lines[0]["oid"].as_str().unwrap()]["path"]["path"],
        "old name.txt"
    );

    let at_rename = repo
        .request(json!({ "op": "blame", "path": "new name.txt", "rev": "HEAD~2" }))
        .unwrap();
    assert_eq!(at_rename["lines"].as_array().unwrap().len(), 2);
    assert!(repo
        .request(json!({ "op": "blame", "path": "new name.txt", "rev": "--incremental" }))
        .is_err());
}
