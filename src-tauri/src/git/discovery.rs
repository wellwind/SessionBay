//! Finds the Git work trees a project contains, using Git's own answers.
//!
//! A `.git` entry is only a hint: every candidate is confirmed with
//! `git rev-parse`, so broken gitdirs, bare repos and untrusted owners get
//! explicit states instead of operable buttons.
use super::runner::{Access, GitErrorKind, GitRunner, Invocation};
use crate::tr;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const SCAN_MAX_DEPTH: usize = 5;
pub const SCAN_MAX_DIRECTORIES: usize = 5_000;
pub const SCAN_BUDGET: Duration = Duration::from_millis(1_500);
pub const MAX_REPOSITORIES: usize = 32;

/// Bounds for one subfolder scan. Reaching `max_depth` is the configured
/// scope (like VS Code's `git.repositoryScanMaxDepth`), not a truncation;
/// only time, directory and repository budgets truncate.
#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    pub max_depth: usize,
    pub max_directories: usize,
    pub budget: Duration,
    pub max_repositories: usize,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_depth: SCAN_MAX_DEPTH,
            max_directories: SCAN_MAX_DIRECTORIES,
            budget: SCAN_BUDGET,
            max_repositories: MAX_REPOSITORIES,
        }
    }
}

impl ScanLimits {
    /// The user's explicit "keep scanning": deeper and longer, still bounded.
    pub fn extended(max_depth: Option<usize>) -> Self {
        Self {
            max_depth: max_depth.unwrap_or(12).clamp(1, 32),
            max_directories: 100_000,
            budget: Duration::from_secs(15),
            max_repositories: 256,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LimitReason {
    Time,
    Directories,
    Repositories,
}

const SKIPPED_DIRECTORIES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".next",
    ".turbo",
    "dist",
    "build",
    ".gradle",
    "Pods",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Stable hash of the canonical work tree and gitdir.
    pub id: String,
    pub name: String,
    pub root: String,
    /// Work tree relative to the project root; empty when it is the project
    /// root or an ancestor of it.
    pub relative_path: String,
    pub git_dir: String,
    pub common_dir: String,
    pub linked_worktree: bool,
    /// The project was opened from a subdirectory of this work tree.
    pub encloses_project: bool,
    #[serde(skip)]
    pub root_path: PathBuf,
    #[serde(skip)]
    pub git_dir_path: PathBuf,
    #[serde(skip)]
    pub common_dir_path: PathBuf,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum IssueKind {
    Bare,
    Broken,
    DubiousOwnership,
    Submodule,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoIssue {
    pub kind: IssueKind,
    pub relative_path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub git_version: String,
    pub repos: Vec<RepoInfo>,
    pub issues: Vec<RepoIssue>,
    /// The bounded scan stopped early; more nested repos may exist.
    /// A time/directory/repository budget stopped the scan early.
    pub truncated: bool,
    pub limit_reason: Option<LimitReason>,
    pub cancelled: bool,
    /// Subfolder depth searched; deeper repos are found when one of their
    /// files is opened.
    pub scanned_depth: usize,
}

#[derive(Debug)]
enum Probe {
    WorkTree(Box<RepoInfo>, Option<PathBuf>),
    Bare(String),
    NotRepo,
    Broken(String),
    Dubious(String),
}

pub fn discover(
    runner: &GitRunner,
    project_root: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<Discovery, String> {
    discover_with(runner, project_root, cancel, ScanLimits::default())
}

pub fn discover_with(
    runner: &GitRunner,
    project_root: &Path,
    cancel: &Arc<AtomicBool>,
    limits: ScanLimits,
) -> Result<Discovery, String> {
    let root = canonical(project_root)
        .map_err(|e| tr!("Cannot open the project folder: {{error}}", error = e))?;
    let mut repos: Vec<RepoInfo> = Vec::new();
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    let mut record = |probe: Probe,
                      directory: &Path,
                      repos: &mut Vec<RepoInfo>,
                      issues: &mut Vec<RepoIssue>| {
        let relative = relative_display(&root, directory);
        match probe {
            Probe::WorkTree(info, superproject) => {
                if let Some(superproject) = superproject {
                    // Submodules are shown, never silently operated on.
                    issues.push(RepoIssue {
                            kind: IssueKind::Submodule,
                            relative_path: relative,
                            message: tr!(
                                "Submodule (parent {{parent}}); Session Bay does not run Git operations inside submodules yet",
                                parent = superproject.display()
                            ),
                        });
                } else if seen.insert(info.id.clone()) {
                    repos.push(*info);
                }
            }
            Probe::Bare(message) => issues.push(RepoIssue {
                kind: IssueKind::Bare,
                relative_path: relative,
                message,
            }),
            Probe::Broken(message) => issues.push(RepoIssue {
                kind: IssueKind::Broken,
                relative_path: relative,
                message,
            }),
            Probe::Dubious(message) => issues.push(RepoIssue {
                kind: IssueKind::DubiousOwnership,
                relative_path: relative,
                message,
            }),
            Probe::NotRepo => {}
        }
    };
    record(probe(runner, &root, &root), &root, &mut repos, &mut issues);

    let started = Instant::now();
    let mut queue = VecDeque::from([(root.clone(), 0usize)]);
    let mut visited = 0usize;
    let mut limit_reason = None;
    let mut cancelled = false;
    while let Some((directory, depth)) = queue.pop_front() {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        limit_reason = if visited >= limits.max_directories {
            Some(LimitReason::Directories)
        } else if started.elapsed() > limits.budget {
            Some(LimitReason::Time)
        } else if repos.len() >= limits.max_repositories {
            Some(LimitReason::Repositories)
        } else {
            None
        };
        if limit_reason.is_some() {
            break;
        }
        visited += 1;
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        let mut children: Vec<PathBuf> = Vec::new();
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // Never follow symlinks or junctions out of the project.
            if !kind.is_dir() || kind.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if SKIPPED_DIRECTORIES.contains(&name) {
                continue;
            }
            children.push(entry.path());
        }
        children.sort();
        for child in children {
            if child.join(".git").symlink_metadata().is_ok() {
                // A repo boundary: confirm it and never walk into it.
                record(
                    probe(runner, &child, &root),
                    &child,
                    &mut repos,
                    &mut issues,
                );
                continue;
            }
            if depth + 1 < limits.max_depth {
                queue.push_back((child, depth + 1));
            }
        }
    }
    for repo in &repos {
        for path in submodule_paths(runner, repo) {
            let absolute = repo.root_path.join(&path);
            issues.push(RepoIssue {
                kind: IssueKind::Submodule,
                relative_path: relative_display(&root, &absolute),
                message: tr!(
                    "Submodule of {{repo}}; Session Bay does not run Git operations inside submodules yet",
                    repo = repo.name
                ),
            });
        }
    }
    let mut reported = HashSet::new();
    issues.retain(|issue| reported.insert((issue.kind, issue.relative_path.clone())));
    repos.sort_by(|a, b| {
        (!a.encloses_project, &a.relative_path).cmp(&(!b.encloses_project, &b.relative_path))
    });
    Ok(Discovery {
        git_version: runner.version(),
        repos,
        issues,
        truncated: limit_reason.is_some(),
        limit_reason,
        cancelled,
        scanned_depth: limits.max_depth,
    })
}

/// The work tree containing a project file, found the way VS Code finds
/// repos for open editors: from the file's folder upward, bounded by Git.
pub fn repo_for_path(
    runner: &GitRunner,
    project_root: &Path,
    relative: &str,
) -> Result<Option<RepoInfo>, String> {
    let root = canonical(project_root)
        .map_err(|e| tr!("Cannot open the project folder: {{error}}", error = e))?;
    if relative.is_empty() || relative.contains('\0') || Path::new(relative).is_absolute() {
        return Err(tr!("Invalid file path"));
    }
    let target = canonical(&root.join(relative)).map_err(|_| tr!("File not found"))?;
    if !target.starts_with(&root) {
        return Err(tr!("The file is not in the project"));
    }
    let directory = if target.is_dir() {
        target
    } else {
        target
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or(root.clone())
    };
    Ok(match probe(runner, &directory, &root) {
        Probe::WorkTree(info, None) => Some(*info),
        _ => None,
    })
}

/// Declared submodule paths; the scan never walks into a repo to find them.
fn submodule_paths(runner: &GitRunner, repo: &RepoInfo) -> Vec<String> {
    let file = repo.root_path.join(".gitmodules");
    if !file.is_file() {
        return Vec::new();
    }
    let Ok(output) = runner.run(
        Invocation::new(&repo.root_path, Access::Read, ["config", "-z", "--file"])
            .arg(&file)
            .args(["--get-regexp", r"^submodule\..*\.path$"])
            .timeout(Duration::from_secs(10)),
    ) else {
        return Vec::new();
    };
    output
        .stdout
        .split(|b| *b == 0)
        .filter_map(|record| {
            let index = record.iter().position(|b| *b == b'\n')?;
            let path = String::from_utf8_lossy(&record[index + 1..]).into_owned();
            (!path.is_empty() && !path.starts_with('/') && !path.split('/').any(|p| p == ".."))
                .then_some(path)
        })
        .take(256)
        .collect()
}

fn rev_parse(runner: &GitRunner, directory: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    let output = runner
        .run(
            Invocation::new(
                directory,
                Access::Read,
                ["rev-parse", "--path-format=absolute"],
            )
            .args(args)
            .timeout(Duration::from_secs(10)),
        )
        .map_err(|error| error.to_string())?;
    if output.success() {
        Ok(output.stdout_text().lines().map(str::to_owned).collect())
    } else {
        Err(output.stderr_text())
    }
}

fn probe(runner: &GitRunner, directory: &Path, project_root: &Path) -> Probe {
    let lines = match rev_parse(
        runner,
        directory,
        &[
            "--is-bare-repository",
            "--is-inside-work-tree",
            "--absolute-git-dir",
            "--git-common-dir",
        ],
    ) {
        Ok(lines) => lines,
        Err(stderr) => {
            if super::runner::classify(&stderr) == GitErrorKind::DubiousOwnership {
                return Probe::Dubious(
                    tr!("Git's safe.directory protection rejects this folder; Session Bay never changes your Git config automatically"),
                );
            }
            if stderr.contains("not a git repository") && !has_git_marker(directory, project_root) {
                return Probe::NotRepo;
            }
            return Probe::Broken(stderr.trim().to_owned());
        }
    };
    if lines.first().map(String::as_str) == Some("true") {
        return Probe::Bare(tr!(
            "A bare repository has no working tree, so changes and staging are not available"
        ));
    }
    if lines.get(1).map(String::as_str) != Some("true") || lines.len() < 4 {
        // Inside a .git directory or an unexpected answer.
        return Probe::NotRepo;
    }
    let git_dir = PathBuf::from(&lines[2]);
    let common_dir = PathBuf::from(&lines[3]);
    let top = match rev_parse(
        runner,
        directory,
        &["--show-toplevel", "--show-superproject-working-tree"],
    ) {
        Ok(top) if !top.is_empty() => top,
        Ok(_) => return Probe::Broken(tr!("Git did not report a working tree")),
        Err(stderr) => return Probe::Broken(stderr.trim().to_owned()),
    };
    let toplevel = PathBuf::from(&top[0]);
    let superproject = top
        .get(1)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from);
    let (Ok(root_path), Ok(git_dir_path), Ok(common_dir_path)) = (
        canonical(&toplevel),
        canonical(&git_dir),
        canonical(&common_dir),
    ) else {
        return Probe::Broken(tr!(
            "The working tree or gitdir reported by Git is not accessible"
        ));
    };
    let encloses_project = root_path != project_root && project_root.starts_with(&root_path);
    let relative_path = if encloses_project {
        String::new()
    } else {
        relative_display(project_root, &root_path)
    };
    let name = root_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| root_path.display().to_string());
    let info = RepoInfo {
        id: identity(&root_path, &git_dir_path),
        name,
        root: display(&root_path),
        relative_path,
        git_dir: display(&git_dir_path),
        common_dir: display(&common_dir_path),
        linked_worktree: git_dir_path != common_dir_path,
        encloses_project,
        root_path,
        git_dir_path,
        common_dir_path,
    };
    Probe::WorkTree(Box::new(info), superproject)
}

/// Whether `directory` or an ancestor up to the project has a `.git` entry,
/// which turns a "not a git repository" answer into a broken-repo warning.
fn has_git_marker(directory: &Path, project_root: &Path) -> bool {
    let mut current = Some(directory);
    while let Some(path) = current {
        if path.join(".git").symlink_metadata().is_ok() {
            return true;
        }
        if path == project_root {
            break;
        }
        current = path.parent();
    }
    false
}

pub fn identity(root: &Path, git_dir: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalize_case(&display(root)).as_bytes());
    hasher.update([0]);
    hasher.update(normalize_case(&display(git_dir)).as_bytes());
    let digest = hasher.finalize();
    digest[..10].iter().map(|b| format!("{b:02x}")).collect()
}

/// macOS and Windows default volumes are case-insensitive; two distinct
/// repositories there cannot differ only by case.
fn normalize_case(value: &str) -> String {
    if cfg!(any(target_os = "macos", windows)) {
        value.to_lowercase()
    } else {
        value.to_owned()
    }
}

pub fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    let path = std::fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            if !rest.starts_with("UNC\\") {
                return Ok(PathBuf::from(rest));
            }
        }
    }
    Ok(path)
}

fn display(path: &Path) -> String {
    path.display().to_string()
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|relative| {
            relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_else(|_| display(path))
}
