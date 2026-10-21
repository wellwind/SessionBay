//! Git discovery/status against synthetic temp repositories only.
//! Never touches real user repositories.
use sessionbay_lib::git::{DiscoveryLimits, GitCli, GitProbeState, GitRepositoryKind};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;

fn git(cwd: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.invalid",
        ])
        .args([
            "-c",
            "init.defaultBranch=main",
            "-c",
            "protocol.file.allow=always",
        ])
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", cwd.join("no-such-global-config"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .expect("git available for tests");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn repo(path: &Path) -> PathBuf {
    std::fs::create_dir_all(path).unwrap();
    git(path, &["init", "-q"]);
    std::fs::write(path.join("README.md"), "synthetic\n").unwrap();
    git(path, &["add", "README.md"]);
    git(path, &["commit", "-q", "-m", "init"]);
    path.to_path_buf()
}

fn temp() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    (dir, base)
}

fn discover(path: &Path) -> sessionbay_lib::git::GitDiscovery {
    GitCli::default().discover(path, DiscoveryLimits::default(), &AtomicBool::new(false))
}

#[test]
fn non_repository_and_missing_git_are_distinct() {
    let (_t, base) = temp();
    let plain = base.join("plain");
    std::fs::create_dir(&plain).unwrap();
    assert_eq!(
        GitCli::default().probe(&plain, None).state,
        GitProbeState::NotRepository
    );
    let missing = GitCli::new(base.join("no-such-git-executable"));
    assert_eq!(missing.probe(&plain, None).state, GitProbeState::GitMissing);
    let d = missing.discover(&plain, DiscoveryLimits::default(), &AtomicBool::new(false));
    assert!(!d.git_available);
    assert_eq!(d.root.state, GitProbeState::GitMissing);
    assert!(d.repositories.is_empty());
    let d = discover(&plain);
    assert!(d.git_available && d.repositories.is_empty() && d.issues.is_empty());
}

#[test]
fn folder_named_dot_git_is_not_trusted() {
    let (_t, base) = temp();
    let fake = base.join("fake");
    std::fs::create_dir_all(fake.join(".git")).unwrap();
    let p = GitCli::default().probe(&fake, None);
    assert_eq!(p.state, GitProbeState::BrokenGitDir);
    let d = discover(&base);
    assert!(d.repositories.is_empty());
    assert_eq!(d.issues.len(), 1);
}

#[test]
fn subdirectory_open_reports_enclosing_root() {
    let (_t, base) = temp();
    let root = repo(&base.join("proj"));
    let sub = root.join("src/deep");
    std::fs::create_dir_all(&sub).unwrap();
    let d = discover(&sub);
    assert_eq!(d.root.state, GitProbeState::Repository);
    let r = &d.repositories[0];
    assert_eq!(Path::new(&r.worktree_root), root);
    assert!(r.contains_project);
    assert_eq!(r.relative_path, None);
    assert_eq!(r.kind, GitRepositoryKind::Primary);
    assert_eq!(Path::new(&r.git_dir), root.join(".git"));
}

#[test]
fn dot_git_file_points_to_separate_gitdir() {
    let (_t, base) = temp();
    let work = base.join("work");
    std::fs::create_dir(&work).unwrap();
    let store = base.join("store.git");
    git(
        &work,
        &["init", "-q", "--separate-git-dir", store.to_str().unwrap()],
    );
    assert!(work.join(".git").is_file());
    let p = GitCli::default().probe(&work, None);
    assert_eq!(p.state, GitProbeState::Repository);
    let r = p.repository.unwrap();
    assert_eq!(Path::new(&r.git_dir), store);
    assert_eq!(r.kind, GitRepositoryKind::Primary);
}

#[test]
fn linked_worktree_shares_common_dir_with_distinct_identity() {
    let (_t, base) = temp();
    let main = repo(&base.join("main"));
    let linked = base.join("linked");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            linked.to_str().unwrap(),
        ],
    );
    let a = GitCli::default().probe(&main, None).repository.unwrap();
    let b = GitCli::default().probe(&linked, None).repository.unwrap();
    assert_eq!(b.kind, GitRepositoryKind::LinkedWorktree);
    assert_eq!(a.common_dir, b.common_dir);
    assert_ne!(a.git_dir, b.git_dir);
    assert_ne!(a.id, b.id);
    let s = GitCli::default().status(&b).unwrap();
    assert_eq!(s.branch.as_deref(), Some("feature"));
}

#[test]
fn same_named_repositories_are_isolated() {
    let (_t, base) = temp();
    let a = repo(&base.join("a/app"));
    let _b = repo(&base.join("b/app"));
    std::fs::write(a.join("README.md"), "changed\n").unwrap();
    std::fs::write(a.join("new.txt"), "x").unwrap();
    let d = discover(&base);
    assert_eq!(d.repositories.len(), 2);
    let (ra, rb) = (&d.repositories[0], &d.repositories[1]);
    assert_eq!(ra.name, rb.name);
    assert_ne!(ra.id, rb.id);
    assert_eq!(ra.relative_path.as_deref(), Some("a/app"));
    assert_eq!(rb.relative_path.as_deref(), Some("b/app"));
    let sa = GitCli::default().status(ra).unwrap();
    let sb = GitCli::default().status(rb).unwrap();
    assert_eq!((sa.unstaged, sa.untracked), (1, 1));
    assert_eq!((sb.unstaged, sb.untracked, sb.staged), (0, 0, 0));
    assert_eq!(sa.repo_id, ra.id);
}

#[test]
fn bare_repository_has_its_own_state_and_is_not_walked() {
    let (_t, base) = temp();
    let bare = base.join("server.git");
    std::fs::create_dir(&bare).unwrap();
    git(&bare, &["init", "-q", "--bare"]);
    assert_eq!(
        GitCli::default().probe(&bare, None).state,
        GitProbeState::Bare
    );
    let d = discover(&base);
    assert!(d.repositories.is_empty());
    assert_eq!(d.issues.len(), 1);
    assert_eq!(d.issues[0].state, GitProbeState::Bare);
    assert_eq!(discover(&bare).root.state, GitProbeState::Bare);
}

#[test]
fn broken_gitdir_is_reported_even_inside_parent_repo() {
    let (_t, base) = temp();
    let lone = base.join("lone");
    std::fs::create_dir(&lone).unwrap();
    std::fs::write(lone.join(".git"), "gitdir: /definitely/missing/gitdir\n").unwrap();
    assert_eq!(
        GitCli::default().probe(&lone, None).state,
        GitProbeState::BrokenGitDir
    );
    let parent = repo(&base.join("parent"));
    let inner = parent.join("inner");
    std::fs::create_dir(&inner).unwrap();
    std::fs::write(inner.join(".git"), "gitdir: ../nowhere\n").unwrap();
    let d = discover(&base);
    assert_eq!(d.repositories.len(), 1);
    assert_eq!(Path::new(&d.repositories[0].worktree_root), parent);
    let broken: Vec<_> = d
        .issues
        .iter()
        .filter(|i| i.state == GitProbeState::BrokenGitDir)
        .collect();
    assert_eq!(broken.len(), 2);
}

#[test]
fn nested_repo_and_submodule_boundaries() {
    let (_t, base) = temp();
    let lib = repo(&base.join("lib-src"));
    let outer = repo(&base.join("outer"));
    let nested = repo(&outer.join("vendor/nested"));
    git(
        &outer,
        &[
            "submodule",
            "add",
            "-q",
            lib.to_str().unwrap(),
            "modules/lib",
        ],
    );
    let d = discover(&outer);
    let find = |p: &Path| {
        d.repositories
            .iter()
            .find(|r| Path::new(&r.worktree_root) == p)
            .unwrap()
    };
    let o = find(&outer);
    let n = find(&nested);
    let s = find(&outer.join("modules/lib"));
    assert!(o.contains_project);
    assert_eq!(n.kind, GitRepositoryKind::Primary);
    assert_eq!(n.parent_id.as_deref(), Some(o.id.as_str()));
    assert_eq!(s.kind, GitRepositoryKind::Submodule);
    assert_eq!(
        s.superproject.as_deref().map(Path::new),
        Some(outer.as_path())
    );
    assert_eq!(d.repositories.len(), 3);
    // Status of the outer repo does not descend into nested repo files.
    let st = GitCli::default().status(o).unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
}

#[test]
fn discovery_is_cancellable_and_bounded() {
    let (_t, base) = temp();
    for i in 0..30 {
        std::fs::create_dir_all(base.join(format!("d{i}/x/y"))).unwrap();
    }
    repo(&base.join("d29/x/y/r"));
    let cancelled = AtomicBool::new(true);
    let d = GitCli::default().discover(&base, DiscoveryLimits::default(), &cancelled);
    assert!(d.cancelled && d.truncated);
    assert!(d.repositories.is_empty());
    let limits = DiscoveryLimits {
        max_directories: 5,
        ..DiscoveryLimits::default()
    };
    let d = GitCli::default().discover(&base, limits, &AtomicBool::new(false));
    assert!(d.truncated && !d.cancelled);
    assert!(d.scanned_directories <= 5);
    let limits = DiscoveryLimits {
        max_depth: 2,
        ..DiscoveryLimits::default()
    };
    assert!(
        GitCli::default()
            .discover(&base, limits, &AtomicBool::new(false))
            .truncated
    );
    assert_eq!(discover(&base).repositories.len(), 1);
}

#[test]
fn status_tracks_ahead_behind_staged_and_external_changes() {
    let (_t, base) = temp();
    let upstream = repo(&base.join("up"));
    let clone = base.join("clone");
    git(
        &base,
        &[
            "clone",
            "-q",
            upstream.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    std::fs::write(upstream.join("u.txt"), "u").unwrap();
    git(&upstream, &["add", "u.txt"]);
    git(&upstream, &["commit", "-q", "-m", "up"]);
    git(&clone, &["fetch", "-q"]);
    std::fs::write(clone.join("c.txt"), "c").unwrap();
    git(&clone, &["add", "c.txt"]);
    git(&clone, &["commit", "-q", "-m", "local"]);
    let r = GitCli::default().probe(&clone, None).repository.unwrap();
    let s = GitCli::default().status(&r).unwrap();
    assert_eq!((s.ahead, s.behind), (Some(1), Some(1)));
    assert_eq!(s.upstream.as_deref(), Some("origin/main"));
    std::fs::write(clone.join("s.txt"), "s").unwrap();
    git(&clone, &["add", "s.txt"]);
    let s = GitCli::default().status(&r).unwrap();
    assert_eq!((s.staged, s.unstaged, s.untracked), (1, 0, 0));
    assert!(!s.limited);
}

#[test]
fn service_status_rejects_repositories_outside_project() {
    let (_t, base) = temp();
    let inside = repo(&base.join("project/app"));
    let outside = repo(&base.join("elsewhere"));
    let service = sessionbay_lib::service::Service::open(base.join("app-data")).unwrap();
    let project = service
        .catalog
        .add_project(base.join("project").to_str().unwrap(), None)
        .unwrap();
    let d = service.discover_git(&project.id).unwrap();
    assert_eq!(d.repositories.len(), 1);
    assert!(service
        .git_status(&project.id, inside.to_str().unwrap())
        .is_ok());
    assert!(service
        .git_status(&project.id, outside.to_str().unwrap())
        .is_err());
    assert!(!service.cancel_git_discovery(&project.id).unwrap());
}
