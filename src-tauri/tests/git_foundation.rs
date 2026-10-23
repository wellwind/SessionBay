//! G1: Git discovery, identity and status over synthetic repositories only.
#[path = "support/git_fixture.rs"]
mod git_fixture;

use git_fixture::{commit_file, git, init_repo, temp};
use sessionbay_lib::git::{
    discovery::{Discovery, IssueKind},
    GitRequest, GitService, ProjectGit,
};
use std::{fs, path::Path};

fn ready(service: &GitService, root: &Path) -> Discovery {
    match service.discover(root).unwrap() {
        ProjectGit::Ready(found) => found,
        ProjectGit::Unavailable { message } => panic!("git unavailable: {message}"),
    }
}

#[test]
fn plain_directory_and_fake_git_folder_offer_no_repositories() {
    let (_temp, base) = temp();
    let plain = base.join("plain");
    fs::create_dir_all(plain.join("src")).unwrap();
    let found = ready(&GitService::new(), &plain);
    assert!(found.repos.is_empty());
    assert!(found.issues.is_empty());

    // A folder merely named .git is not a repository.
    let fake = base.join("fake");
    fs::create_dir_all(fake.join(".git")).unwrap();
    let found = ready(&GitService::new(), &fake);
    assert!(found.repos.is_empty());
    assert_eq!(found.issues.len(), 1);
    assert_eq!(found.issues[0].kind, IssueKind::Broken);
}

#[test]
fn git_file_subdirectory_and_linked_worktree_have_distinct_identities() {
    let (_temp, base) = temp();
    let main = init_repo(&base.join("main"));
    commit_file(&main, "src/lib.txt", b"one\n", "initial");

    // Project opened from a repo subdirectory.
    let found = ready(&GitService::new(), &main.join("src"));
    assert_eq!(found.repos.len(), 1);
    assert!(found.repos[0].encloses_project);
    assert_eq!(found.repos[0].root, main.display().to_string());

    // Separate gitdir: the work tree holds a .git *file*.
    let separate = base.join("separate");
    fs::create_dir_all(&separate).unwrap();
    git(
        &separate,
        &[
            "init",
            "-q",
            "--separate-git-dir",
            base.join("separate.gitdir").to_str().unwrap(),
        ],
    );
    assert!(separate.join(".git").is_file());
    let found = ready(&GitService::new(), &separate);
    assert_eq!(found.repos.len(), 1);
    assert!(!found.repos[0].linked_worktree);

    // Linked worktree: same common dir, different gitdir and identity.
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "side",
            base.join("linked").to_str().unwrap(),
        ],
    );
    let main_info = ready(&GitService::new(), &main).repos.remove(0);
    let linked_info = ready(&GitService::new(), &base.join("linked"))
        .repos
        .remove(0);
    assert!(linked_info.linked_worktree);
    assert!(!main_info.linked_worktree);
    assert_ne!(main_info.id, linked_info.id);
    assert_eq!(main_info.common_dir, linked_info.common_dir);
}

#[test]
fn same_named_repositories_bare_and_submodules_are_isolated() {
    let (_temp, base) = temp();
    let project = base.join("project");
    let a = init_repo(&project.join("a/app"));
    let b = init_repo(&project.join("b/app"));
    commit_file(&a, "readme.txt", b"a\n", "a");
    commit_file(&b, "readme.txt", b"b\n", "b");
    git(&project, &["init", "-q", "--bare", "mirror.git"]);
    fs::create_dir_all(project.join("node_modules/pkg/.git")).unwrap();

    let found = ready(&GitService::new(), &project);
    assert_eq!(found.repos.len(), 2, "{found:?}");
    assert_eq!(found.repos[0].name, "app");
    assert_eq!(found.repos[1].name, "app");
    assert_ne!(found.repos[0].id, found.repos[1].id);
    assert_eq!(found.repos[0].relative_path, "a/app");
    assert_eq!(found.repos[1].relative_path, "b/app");
    // The bare repo has no .git entry and node_modules is skipped.
    assert!(found.issues.is_empty(), "{:?}", found.issues);

    // Probing the bare repo itself reports an explicit state.
    let bare = ready(&GitService::new(), &project.join("mirror.git"));
    assert!(bare.repos.is_empty());
    assert_eq!(bare.issues[0].kind, IssueKind::Bare);

    // Submodules are recognized as a boundary, not operated on.
    let library = init_repo(&base.join("library"));
    commit_file(&library, "lib.txt", b"lib\n", "lib");
    git(
        &a,
        &[
            "submodule",
            "add",
            "-q",
            library.to_str().unwrap(),
            "vendor/library",
        ],
    );
    let found = ready(&GitService::new(), &project);
    assert_eq!(found.repos.len(), 2);
    let submodule = found
        .issues
        .iter()
        .find(|issue| issue.kind == IssueKind::Submodule)
        .expect("submodule issue");
    assert_eq!(submodule.relative_path, "a/app/vendor/library");
}

#[test]
fn cancelled_scan_reports_cancellation() {
    let (_temp, base) = temp();
    let project = base.join("project");
    init_repo(&project.join("nested"));
    let service = GitService::new();
    let runner = service.runner().unwrap();
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let found = sessionbay_lib::git::discovery::discover(&runner, &project, &cancel).unwrap();
    assert!(found.cancelled);
    assert!(found.repos.is_empty());
}

#[test]
fn status_reports_changes_and_revision_tracks_external_edits() {
    let (_temp, base) = temp();
    let repo = init_repo(&base.join("repo"));
    commit_file(&repo, "tracked.txt", b"one\n", "initial");
    let service = GitService::new();
    let id = ready(&service, &repo).repos[0].id.clone();
    let status = |service: &GitService| {
        service
            .handle(
                &repo,
                GitRequest::Status {
                    repo_id: id.clone(),
                },
            )
            .unwrap()
    };
    let clean = status(&service);
    assert_eq!(clean["branch"]["head"], "main");
    assert_eq!(clean["entries"].as_array().unwrap().len(), 0);

    fs::write(repo.join("tracked.txt"), b"two\n").unwrap();
    fs::write(repo.join("-new file.txt"), b"x\n").unwrap();
    let dirty = status(&service);
    assert_ne!(dirty["revision"], clean["revision"]);
    let entries = dirty["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries
        .iter()
        .any(|e| e["path"]["path"] == "-new file.txt" && e["untracked"] == true));
    assert!(entries
        .iter()
        .any(|e| e["path"]["path"] == "tracked.txt" && e["unstaged"] == "modified"));

    // Unknown identities never fall back to another repository.
    assert!(service
        .handle(
            &repo,
            GitRequest::Status {
                repo_id: "missing".into()
            }
        )
        .is_err());
}
