//! Read-only Git discovery and status for the Git workbench (G1).
//!
//! Every Git fact comes from the `git` CLI (see docs/decisions.md). A folder
//! named `.git` is only a hint for where to ask Git; it is never treated as
//! proof of a valid repository. Commands use separate argv/cwd, a cleaned
//! environment, `GIT_OPTIONAL_LOCKS=0`, bounded output and a timeout, and never
//! write to the repository.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Environment variables that would redirect Git away from the probed path.
const SCRUBBED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const PROBE_OUTPUT_LIMIT: usize = 64 * 1024;
const STATUS_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitProbeState {
    /// A non-bare repository with a work tree that Git accepts.
    Repository,
    /// Git found no repository for the path.
    NotRepository,
    /// Bare repository: no work tree, so no work-tree operations are offered.
    Bare,
    /// A `.git` entry exists but Git rejects it, or it is shadowed by a parent repo.
    BrokenGitDir,
    /// Git refuses the repository because of `safe.directory` ownership rules.
    Untrusted,
    /// The git executable could not be started.
    GitMissing,
    /// Timeout, cancellation or another Git failure.
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitRepositoryKind {
    /// The main work tree of a repository.
    Primary,
    /// A linked worktree (`git worktree add`); gitdir differs from common dir.
    LinkedWorktree,
    /// A registered/checked-out submodule; listed but never operated on silently.
    Submodule,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepository {
    /// Stable opaque identity derived from canonical common dir + worktree root.
    pub id: String,
    pub name: String,
    pub worktree_root: String,
    pub git_dir: String,
    pub common_dir: String,
    pub kind: GitRepositoryKind,
    pub superproject: Option<String>,
    /// Path relative to the project root using `/`; `null` when the repository
    /// root is the project root's ancestor (project opened from a subdirectory).
    pub relative_path: Option<String>,
    pub contains_project: bool,
    /// Enclosing repository found by discovery (nested repo boundary).
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProbe {
    pub path: String,
    pub state: GitProbeState,
    pub repository: Option<GitRepository>,
    pub git_dir: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiscovery {
    pub project_root: String,
    pub git_available: bool,
    pub git_version: Option<String>,
    pub root: GitProbe,
    pub repositories: Vec<GitRepository>,
    /// Non-repository findings (bare, broken, untrusted) shown as explicit states.
    pub issues: Vec<GitProbe>,
    pub scanned_directories: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSummary {
    pub repo_id: String,
    pub worktree_root: String,
    pub branch: Option<String>,
    pub oid: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    /// Output exceeded the bound; counts are lower bounds.
    pub limited: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct DiscoveryLimits {
    pub max_depth: usize,
    pub max_directories: usize,
    pub max_repositories: usize,
    pub deadline: Duration,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self {
            max_depth: 6,
            max_directories: 5_000,
            max_repositories: 64,
            deadline: Duration::from_secs(10),
        }
    }
}

#[derive(Debug)]
enum RunError {
    Missing,
    Timeout,
    Cancelled,
    Io(String),
}

struct Output {
    ok: bool,
    stdout: Vec<u8>,
    stderr: String,
    truncated: bool,
}

/// Executes Git with a cleaned environment, bounded output and a timeout.
pub struct GitCli {
    executable: OsString,
}

impl Default for GitCli {
    fn default() -> Self {
        Self::new("git")
    }
}

impl GitCli {
    pub fn new(executable: impl Into<OsString>) -> Self {
        Self {
            executable: executable.into(),
        }
    }

    fn run(
        &self,
        cwd: &Path,
        args: &[&str],
        limit: usize,
        timeout: Duration,
        cancel: Option<&AtomicBool>,
    ) -> Result<Output, RunError> {
        let mut command = Command::new(&self.executable);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .env("LANGUAGE", "C");
        for key in SCRUBBED_ENV {
            command.env_remove(key);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => RunError::Missing,
            _ => RunError::Io(e.to_string()),
        })?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let out_thread = std::thread::spawn(move || read_bounded(stdout, limit));
        let err_thread = std::thread::spawn(move || read_bounded(stderr, 16 * 1024));
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(e) => return Err(RunError::Io(e.to_string())),
            }
            let cancelled = cancel.is_some_and(|c| c.load(Ordering::Relaxed));
            if cancelled || started.elapsed() > timeout {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if cancelled {
                    RunError::Cancelled
                } else {
                    RunError::Timeout
                });
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let (stdout, truncated) = out_thread.join().unwrap_or_default();
        let (stderr, _) = err_thread.join().unwrap_or_default();
        Ok(Output {
            ok: status.success(),
            stdout,
            stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
            truncated,
        })
    }

    /// Returns `Ok(None)` when git is missing.
    pub fn version(&self) -> Option<String> {
        let out = self
            .run(
                Path::new(if cfg!(windows) { "C:\\" } else { "/" }),
                &["--version"],
                4096,
                PROBE_TIMEOUT,
                None,
            )
            .ok()?;
        out.ok
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Ask Git what `path` belongs to. Never mutates anything.
    pub fn probe(&self, path: &Path, cancel: Option<&AtomicBool>) -> GitProbe {
        let display = display_path(path);
        let fail = |state, message: String| GitProbe {
            path: display.clone(),
            state,
            repository: None,
            git_dir: None,
            message: Some(message),
        };
        let has_dot_git = path.join(".git").symlink_metadata().is_ok();
        let first = match self.run(
            path,
            &[
                "rev-parse",
                "--is-bare-repository",
                "--is-inside-work-tree",
                "--path-format=absolute",
                "--absolute-git-dir",
                "--git-common-dir",
            ],
            PROBE_OUTPUT_LIMIT,
            PROBE_TIMEOUT,
            cancel,
        ) {
            Ok(out) => out,
            Err(e) => return run_failure(display, e),
        };
        if !first.ok {
            let state = classify_stderr(&first.stderr, has_dot_git);
            return fail(state, first.stderr);
        }
        let text = String::from_utf8_lossy(&first.stdout).to_string();
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() < 4 {
            return fail(GitProbeState::Failed, "Git 回傳格式無法辨識".into());
        }
        let git_dir = canonical_string(Path::new(lines[2]));
        let common_dir = canonical_string(Path::new(lines[3]));
        if lines[0] == "true" {
            return GitProbe {
                path: display,
                state: GitProbeState::Bare,
                repository: None,
                git_dir: Some(git_dir),
                message: Some("裸 repository 沒有工作目錄，不提供工作目錄操作".into()),
            };
        }
        if lines[1] != "true" {
            // e.g. the path is inside a .git directory.
            return fail(
                GitProbeState::NotRepository,
                "路徑位於 Git 內部資料夾，不是工作目錄".into(),
            );
        }
        let second = match self.run(
            path,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--show-superproject-working-tree",
            ],
            PROBE_OUTPUT_LIMIT,
            PROBE_TIMEOUT,
            cancel,
        ) {
            Ok(out) if out.ok => out,
            Ok(out) => return fail(GitProbeState::Failed, out.stderr),
            Err(e) => return run_failure(display, e),
        };
        let text = String::from_utf8_lossy(&second.stdout).to_string();
        let mut lines = text.lines();
        let Some(top) = lines.next().filter(|l| !l.is_empty()) else {
            return fail(GitProbeState::Failed, "Git 未回報工作目錄根".into());
        };
        let worktree_root = canonical_string(Path::new(top));
        let superproject = lines
            .next()
            .filter(|l| !l.is_empty())
            .map(|l| canonical_string(Path::new(l)));
        // A `.git` entry right here that Git ignores (it resolved a parent repo)
        // is a broken boundary, not a silent part of the parent repository.
        if has_dot_git && !same_path(&worktree_root, &canonical_string(path)) {
            return fail(
                GitProbeState::BrokenGitDir,
                format!("此處的 .git 無效；Git 改用上層 repository {worktree_root}"),
            );
        }
        let kind = if superproject.is_some() {
            GitRepositoryKind::Submodule
        } else if !same_path(&git_dir, &common_dir) {
            GitRepositoryKind::LinkedWorktree
        } else {
            GitRepositoryKind::Primary
        };
        let repository = GitRepository {
            id: repository_id(&common_dir, &worktree_root),
            name: Path::new(&worktree_root)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| worktree_root.clone()),
            worktree_root,
            git_dir: git_dir.clone(),
            common_dir,
            kind,
            superproject,
            relative_path: None,
            contains_project: false,
            parent_id: None,
        };
        GitProbe {
            path: display,
            state: GitProbeState::Repository,
            repository: Some(repository),
            git_dir: Some(git_dir),
            message: None,
        }
    }

    /// Read-only `git status --porcelain=v2` summary for a validated work tree.
    pub fn status(&self, repo: &GitRepository) -> Result<GitStatusSummary, String> {
        let out = self
            .run(
                Path::new(&repo.worktree_root),
                &[
                    "status",
                    "--porcelain=v2",
                    "--branch",
                    "-z",
                    "--untracked-files=normal",
                ],
                STATUS_OUTPUT_LIMIT,
                STATUS_TIMEOUT,
                None,
            )
            .map_err(|e| match e {
                RunError::Missing => "找不到 Git 執行檔".to_string(),
                RunError::Timeout => "Git status 逾時".to_string(),
                RunError::Cancelled => "已取消".to_string(),
                RunError::Io(e) => e,
            })?;
        if !out.ok && !out.truncated {
            return Err(if out.stderr.is_empty() {
                "Git status 失敗".into()
            } else {
                out.stderr
            });
        }
        let mut summary = parse_status_v2(&out.stdout);
        summary.limited = out.truncated;
        summary.repo_id = repo.id.clone();
        summary.worktree_root = repo.worktree_root.clone();
        Ok(summary)
    }

    /// Bounded, cancellable discovery of repositories under `project_root`.
    pub fn discover(
        &self,
        project_root: &Path,
        limits: DiscoveryLimits,
        cancel: &AtomicBool,
    ) -> GitDiscovery {
        let root_canonical = canonical(project_root);
        let version = self.version();
        let root_probe = self.probe(&root_canonical, Some(cancel));
        let mut discovery = GitDiscovery {
            project_root: display_path(&root_canonical),
            git_available: version.is_some() && root_probe.state != GitProbeState::GitMissing,
            git_version: version,
            root: root_probe.clone(),
            repositories: Vec::new(),
            issues: Vec::new(),
            scanned_directories: 0,
            truncated: false,
            cancelled: false,
        };
        if !discovery.git_available {
            discovery.root.state = GitProbeState::GitMissing;
            discovery.root.message = Some("找不到 Git 執行檔；請安裝 Git 並確認在 PATH 中".into());
            discovery.root.repository = None;
            return discovery;
        }
        let mut seen = HashSet::new();
        match root_probe.state {
            GitProbeState::Repository => {
                let mut repo = root_probe.repository.clone().expect("repository");
                repo.contains_project = true;
                repo.relative_path = relative(&root_canonical, Path::new(&repo.worktree_root));
                seen.insert(repo.id.clone());
                discovery.repositories.push(repo);
            }
            GitProbeState::Bare | GitProbeState::BrokenGitDir | GitProbeState::Untrusted => {
                discovery.issues.push(root_probe.clone())
            }
            _ => {}
        }
        if root_probe.state == GitProbeState::Bare {
            return discovery;
        }
        let started = Instant::now();
        let mut queue = VecDeque::from([(root_canonical.clone(), 0usize)]);
        while let Some((dir, depth)) = queue.pop_front() {
            if cancel.load(Ordering::Relaxed) {
                discovery.cancelled = true;
                break;
            }
            if started.elapsed() > limits.deadline
                || discovery.scanned_directories >= limits.max_directories
            {
                discovery.truncated = true;
                break;
            }
            discovery.scanned_directories += 1;
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut children: Vec<PathBuf> = entries
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()))
                .map(|e| e.path())
                .filter(|p| !skip_directory(p.file_name().unwrap_or_default()))
                .collect();
            children.sort();
            for child in children {
                if cancel.load(Ordering::Relaxed) {
                    discovery.cancelled = true;
                    break;
                }
                let has_dot_git = child.join(".git").symlink_metadata().is_ok();
                let looks_bare = !has_dot_git && looks_like_bare(&child);
                if has_dot_git || looks_bare {
                    let probe = self.probe(&child, Some(cancel));
                    match probe.state {
                        GitProbeState::Repository => {
                            let mut repo = probe.repository.expect("repository");
                            if seen.insert(repo.id.clone()) {
                                if discovery.repositories.len() >= limits.max_repositories {
                                    discovery.truncated = true;
                                    return finish(discovery);
                                }
                                repo.relative_path =
                                    relative(&root_canonical, Path::new(&repo.worktree_root));
                                repo.parent_id = enclosing(&discovery.repositories, &repo);
                                discovery.repositories.push(repo);
                            }
                        }
                        GitProbeState::Failed if cancel.load(Ordering::Relaxed) => {
                            discovery.cancelled = true;
                            break;
                        }
                        GitProbeState::NotRepository if looks_bare => {}
                        GitProbeState::Bare => {
                            discovery.issues.push(probe);
                            continue; // never walk into a bare repository's internals
                        }
                        _ => discovery.issues.push(probe),
                    }
                }
                if depth + 1 < limits.max_depth {
                    queue.push_back((child, depth + 1));
                } else if std::fs::read_dir(&child)
                    .map(|mut d| {
                        d.any(|e| e.is_ok_and(|e| e.file_type().is_ok_and(|t| t.is_dir())))
                    })
                    .unwrap_or(false)
                {
                    discovery.truncated = true;
                }
            }
            if discovery.cancelled {
                break;
            }
        }
        finish(discovery)
    }
}

fn finish(mut discovery: GitDiscovery) -> GitDiscovery {
    if discovery.cancelled {
        discovery.truncated = true;
    }
    discovery
}

fn enclosing(found: &[GitRepository], repo: &GitRepository) -> Option<String> {
    found
        .iter()
        .filter(|r| {
            Path::new(&repo.worktree_root).starts_with(&r.worktree_root)
                && !same_path(&r.worktree_root, &repo.worktree_root)
        })
        .max_by_key(|r| r.worktree_root.len())
        .map(|r| r.id.clone())
}

/// `.git` internals are never scanned; `node_modules` is skipped to keep the
/// bounded budget for real source trees (documented limitation).
fn skip_directory(name: &OsStr) -> bool {
    name == ".git" || name == "node_modules"
}

fn looks_like_bare(dir: &Path) -> bool {
    dir.join("HEAD").is_file() && dir.join("objects").is_dir() && dir.join("refs").is_dir()
}

fn run_failure(path: String, error: RunError) -> GitProbe {
    let (state, message) = match error {
        RunError::Missing => (GitProbeState::GitMissing, "找不到 Git 執行檔".to_string()),
        RunError::Timeout => (GitProbeState::Failed, "Git 探測逾時".to_string()),
        RunError::Cancelled => (GitProbeState::Failed, "已取消".to_string()),
        RunError::Io(e) => (GitProbeState::Failed, e),
    };
    GitProbe {
        path,
        state,
        repository: None,
        git_dir: None,
        message: Some(message),
    }
}

fn classify_stderr(stderr: &str, has_dot_git: bool) -> GitProbeState {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("dubious ownership") || lower.contains("safe.directory") {
        GitProbeState::Untrusted
    } else if has_dot_git {
        GitProbeState::BrokenGitDir
    } else if lower.contains("not a git repository") {
        GitProbeState::NotRepository
    } else {
        GitProbeState::Failed
    }
}

fn read_bounded(mut reader: impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.len() + n > limit {
                    out.extend_from_slice(&buf[..limit - out.len()]);
                    truncated = true;
                    // Keep draining so the child never blocks on a full pipe.
                    while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
                    break;
                }
                out.extend_from_slice(&buf[..n]);
            }
        }
    }
    (out, truncated)
}

/// Canonical path with platform rules: symlinks resolved and, on Windows, the
/// verbatim `\\?\` prefix removed so it matches paths shown elsewhere in the UI.
pub fn canonical(path: &Path) -> PathBuf {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    strip_verbatim(resolved)
}

#[cfg(windows)]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

#[cfg(not(windows))]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

fn canonical_string(path: &Path) -> String {
    display_path(&canonical(path))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// Windows paths compare case-insensitively; other platforms byte-exact.
pub fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn identity_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

pub fn repository_id(common_dir: &str, worktree_root: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"sessionbay-git-repo-v1\0");
    hasher.update(identity_key(common_dir).as_bytes());
    hasher.update(b"\0");
    hasher.update(identity_key(worktree_root).as_bytes());
    let digest = hasher.finalize();
    digest[..12].iter().map(|b| format!("{b:02x}")).collect()
}

fn relative(root: &Path, target: &Path) -> Option<String> {
    let rel = target.strip_prefix(root).ok()?;
    Some(
        rel.components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// Parse `git status --porcelain=v2 --branch -z` output.
pub fn parse_status_v2(bytes: &[u8]) -> GitStatusSummary {
    let mut summary = GitStatusSummary::default();
    let mut records = bytes.split(|b| *b == 0).peekable();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(record);
        if let Some(header) = text.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => {
                    summary.unborn = value == "(initial)";
                    if !summary.unborn {
                        summary.oid = Some(value.to_string());
                    }
                }
                "branch.head" => {
                    summary.detached = value == "(detached)";
                    if !summary.detached {
                        summary.branch = Some(value.to_string());
                    }
                }
                "branch.upstream" => summary.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            summary.ahead = n.parse().ok();
                        } else if let Some(n) = part.strip_prefix('-') {
                            summary.behind = n.parse().ok();
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = record[0];
        let xy = record.get(2..4).unwrap_or(b"..");
        match kind {
            b'1' | b'2' => {
                if xy[0] != b'.' {
                    summary.staged += 1;
                }
                if xy[1] != b'.' {
                    summary.unstaged += 1;
                }
                if kind == b'2' {
                    records.next(); // original path of a rename/copy
                }
            }
            b'u' => summary.conflicted += 1,
            b'?' => summary.untracked += 1,
            _ => {}
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_counts_and_renames() {
        let raw = b"# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0\
1 M. N... 100644 100644 100644 a a f1\0\
1 .M N... 100644 100644 100644 a a f2\0\
2 R. N... 100644 100644 100644 a a R100 new\0old\0\
u UU N... 1 1 1 1 a a a c\0? u1\0? u2\0";
        let s = parse_status_v2(raw);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!((s.ahead, s.behind), (Some(2), Some(3)));
        assert_eq!(
            (s.staged, s.unstaged, s.untracked, s.conflicted),
            (2, 1, 2, 1)
        );
    }

    #[test]
    fn parses_detached_and_unborn() {
        let s = parse_status_v2(b"# branch.oid (initial)\0# branch.head (detached)\0");
        assert!(s.unborn && s.detached && s.branch.is_none() && s.oid.is_none());
    }

    #[test]
    fn identity_differs_by_path_and_is_stable() {
        assert_eq!(
            repository_id("/a/.git", "/a"),
            repository_id("/a/.git", "/a")
        );
        assert_ne!(
            repository_id("/a/x/.git", "/a/x"),
            repository_id("/b/x/.git", "/b/x")
        );
    }

    #[test]
    fn stderr_classification() {
        assert_eq!(
            classify_stderr("fatal: detected dubious ownership", false),
            GitProbeState::Untrusted
        );
        assert_eq!(
            classify_stderr("fatal: not a git repository: /x", true),
            GitProbeState::BrokenGitDir
        );
        assert_eq!(
            classify_stderr("fatal: not a git repository (or any parent)", false),
            GitProbeState::NotRepository
        );
    }
}
