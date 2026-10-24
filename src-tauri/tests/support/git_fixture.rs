//! Synthetic Git repositories with an isolated global config.
//! Never touches the developer's repositories, config or credentials.
#![allow(dead_code)]
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Once,
};

static ISOLATE: Once = Once::new();

/// Every test binary shares one isolated config; set before any Git runs.
pub fn isolate_git() {
    ISOLATE.call_once(|| {
        let dir = std::env::temp_dir().join(format!("sessionbay-git-tests-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("gitconfig");
        std::fs::write(
            &config,
            "[user]\n\tname = Synthetic Tester\n\temail = tester@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[protocol \"file\"]\n\tallow = always\n[core]\n\tautocrlf = false\n",
        )
        .unwrap();
        std::env::set_var("GIT_CONFIG_GLOBAL", &config);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        std::env::remove_var("GIT_DIR");
        std::env::remove_var("GIT_WORK_TREE");
        std::env::remove_var("GIT_INDEX_FILE");
    });
}

pub fn git(cwd: &Path, args: &[&str]) -> String {
    isolate_git();
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

pub fn git_bytes(cwd: &Path, args: &[&str]) -> Vec<u8> {
    isolate_git();
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

pub fn init_repo(path: &Path) -> PathBuf {
    std::fs::create_dir_all(path).unwrap();
    git(path, &["init", "-q"]);
    path.to_path_buf()
}

pub fn commit_file(repo: &Path, name: &str, contents: &[u8], message: &str) -> String {
    let file = repo.join(name);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&file, contents).unwrap();
    git(repo, &["add", "--", name]);
    git(repo, &["commit", "-q", "-m", message]);
    git(repo, &["rev-parse", "HEAD"]).trim().to_owned()
}

pub fn temp() -> (tempfile::TempDir, PathBuf) {
    isolate_git();
    let temp = tempfile::tempdir().unwrap();
    // macOS temp lives under a /var symlink; compare canonical paths.
    // Same canonical form the app reports: no Windows `\\?\` verbatim prefix,
    // which Git commands such as `submodule add` cannot take either.
    let base = sessionbay_lib::git::discovery::canonical(temp.path()).unwrap();
    (temp, base)
}
