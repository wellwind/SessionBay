//! Git workbench core: discovery, status and repository operations.
//!
//! Every request names a project and, where relevant, a repository identity
//! from discovery. The repository must still be one the project contains;
//! writes are serialized per Git common dir and revalidate state first.
pub mod diff;
pub mod discovery;
pub mod patch;
pub mod path;
pub mod refs;
pub mod runner;
pub mod status;

use diff::{DiffRequest, DiffSource};
use discovery::{Discovery, RepoInfo};
use patch::{Direction, Selection};
use path::RepoPath;
use runner::{path_arg, Access, Invocation};
use runner::{GitError, GitErrorKind, GitRunner};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ProjectGit {
    /// No usable Git executable; the UI shows no Git actions.
    Unavailable {
        message: String,
    },
    Ready(Discovery),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "op")]
pub enum GitRequest {
    Discover,
    CancelDiscovery,
    Status {
        repo_id: String,
    },
    Diff {
        repo_id: String,
        path: RepoPath,
        old_path: Option<RepoPath>,
        source: DiffSource,
        #[serde(default)]
        ignore_whitespace: bool,
        #[serde(default)]
        untracked: bool,
    },
    ChangedFiles {
        repo_id: String,
        source: DiffSource,
    },
    Refs {
        repo_id: String,
    },
    StagePaths {
        repo_id: String,
        paths: Vec<RepoPath>,
    },
    UnstagePaths {
        repo_id: String,
        paths: Vec<RepoPath>,
    },
    StageSelection {
        repo_id: String,
        path: RepoPath,
        #[serde(default)]
        untracked: bool,
        snapshot: String,
        selection: Selection,
    },
    UnstageSelection {
        repo_id: String,
        path: RepoPath,
        snapshot: String,
        selection: Selection,
    },
}

#[derive(Default)]
pub struct GitService {
    runner: Mutex<Option<GitRunner>>,
    discoveries: Mutex<HashMap<PathBuf, Discovery>>,
    cancels: Mutex<HashMap<PathBuf, Arc<AtomicBool>>>,
    write_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

pub const STALE_SELECTION: &str =
    "內容已在選取後變更（可能是 Agent、編輯器或其他 Git 操作），未寫入任何內容；請重新選取";

fn path_invocation<'a, I, S>(
    repo: &'a RepoInfo,
    args: I,
    paths: &[RepoPath],
) -> Result<Invocation<'a>, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    if paths.is_empty() {
        return Err("沒有選取檔案".into());
    }
    let mut invocation = Invocation::new(&repo.root_path, Access::Write, args);
    for path in paths {
        invocation = invocation.arg(path_arg(path.as_bytes())?);
    }
    Ok(invocation)
}

fn json<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

impl GitService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Only a successful detection is cached, so installing Git later works.
    pub fn runner(&self) -> Result<GitRunner, GitError> {
        let mut guard = self
            .runner
            .lock()
            .map_err(|_| GitError::failed("Git 狀態鎖定失敗"))?;
        if let Some(runner) = guard.as_ref() {
            return Ok(runner.clone());
        }
        let runner = GitRunner::detect()?;
        *guard = Some(runner.clone());
        Ok(runner)
    }

    pub fn handle(&self, project_root: &Path, request: GitRequest) -> Result<Value, String> {
        match request {
            GitRequest::Discover => json(self.discover(project_root)?),
            GitRequest::CancelDiscovery => {
                self.cancel_discovery(project_root);
                Ok(Value::Null)
            }
            GitRequest::Status { repo_id } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(status::status(&runner, &repo)?)
            }
            GitRequest::Diff {
                repo_id,
                path,
                old_path,
                source,
                ignore_whitespace,
                untracked,
            } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(diff::file_diff(
                    &runner,
                    &repo,
                    &DiffRequest {
                        path: &path,
                        old_path: old_path.as_ref(),
                        source: &source,
                        ignore_whitespace,
                        untracked,
                    },
                )?)
            }
            GitRequest::ChangedFiles { repo_id, source } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                let (files, truncated) = diff::changed_files(&runner, &repo, &source)?;
                Ok(serde_json::json!({ "files": files, "truncated": truncated }))
            }
            GitRequest::Refs { repo_id } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(refs::refs(&runner, &repo)?)
            }
            GitRequest::StagePaths { repo_id, paths } => {
                self.write(project_root, &repo_id, |runner, repo| {
                    runner.ok(path_invocation(repo, ["add", "-A", "--"], &paths)?)?;
                    Ok(Value::Null)
                })
            }
            GitRequest::UnstagePaths { repo_id, paths } => {
                self.write(project_root, &repo_id, |runner, repo| {
                    let args: &[&str] = if diff::repo_has_head(runner, repo)? {
                        &["restore", "--staged", "--"]
                    } else {
                        &["rm", "--cached", "-q", "-r", "--"]
                    };
                    runner.ok(path_invocation(repo, args.iter().copied(), &paths)?)?;
                    Ok(Value::Null)
                })
            }
            GitRequest::StageSelection {
                repo_id,
                path,
                untracked,
                snapshot,
                selection,
            } => self.apply_selection(
                project_root,
                &repo_id,
                &path,
                untracked,
                &snapshot,
                &selection,
                Direction::Stage,
            ),
            GitRequest::UnstageSelection {
                repo_id,
                path,
                snapshot,
                selection,
            } => self.apply_selection(
                project_root,
                &repo_id,
                &path,
                false,
                &snapshot,
                &selection,
                Direction::Unstage,
            ),
        }
    }

    /// Runs a write while holding this repository's common-dir lock.
    pub fn write<T>(
        &self,
        project_root: &Path,
        repo_id: &str,
        action: impl FnOnce(&GitRunner, &RepoInfo) -> Result<T, String>,
    ) -> Result<T, String> {
        let (runner, repo) = self.repo(project_root, repo_id)?;
        let lock = self.write_lock(&repo)?;
        let _guard = lock.lock().map_err(|_| "Git 寫入鎖定失敗")?;
        action(&runner, &repo)
    }

    /// Recomputes the exact diff, rejects it if anything changed since the
    /// user selected lines, then applies a byte-exact patch to the index.
    #[allow(clippy::too_many_arguments)]
    fn apply_selection(
        &self,
        project_root: &Path,
        repo_id: &str,
        path: &RepoPath,
        untracked: bool,
        expected: &str,
        selection: &Selection,
        direction: Direction,
    ) -> Result<Value, String> {
        self.write(project_root, repo_id, |runner, repo| {
            let source = match direction {
                Direction::Stage => DiffSource::Unstaged,
                Direction::Unstage => DiffSource::Staged,
            };
            let raw = diff::raw_diff(
                runner,
                repo,
                &DiffRequest {
                    path,
                    old_path: None,
                    source: &source,
                    ignore_whitespace: false,
                    untracked,
                },
            )?;
            let entry = diff::index_entry(runner, repo, path)?;
            if diff::snapshot(&raw, &entry) != expected {
                return Err(STALE_SELECTION.into());
            }
            let selected = patch::selected_lines(&raw, selection)?;
            let Some(bytes) = patch::build(&raw, path.as_bytes(), &selected, direction)? else {
                return Err("所選內容沒有可套用的變更".into());
            };
            let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
            if direction == Direction::Unstage {
                args.push("--reverse");
            }
            args.push("-");
            runner
                .ok(Invocation::new(&repo.root_path, Access::Write, args).stdin(bytes))
                .map_err(|e| format!("無法套用所選變更（未寫入任何內容）：{e}"))?;
            Ok(Value::Null)
        })
    }

    pub fn discover(&self, project_root: &Path) -> Result<ProjectGit, String> {
        let runner = match self.runner() {
            Ok(runner) => runner,
            Err(error) if error.kind == GitErrorKind::NotFound => {
                return Ok(ProjectGit::Unavailable {
                    message: error.to_string(),
                })
            }
            Err(error) => return Err(error.to_string()),
        };
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels
            .lock()
            .map_err(|_| "Git 狀態鎖定失敗")?
            .insert(project_root.to_owned(), cancel.clone());
        let found = discovery::discover(&runner, project_root, &cancel)?;
        self.discoveries
            .lock()
            .map_err(|_| "Git 狀態鎖定失敗")?
            .insert(project_root.to_owned(), found.clone());
        Ok(ProjectGit::Ready(found))
    }

    pub fn cancel_discovery(&self, project_root: &Path) {
        if let Ok(cancels) = self.cancels.lock() {
            if let Some(flag) = cancels.get(project_root) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
    }

    /// Resolves a repository the project's latest discovery reported and
    /// confirms its work tree still exists.
    pub fn repo(
        &self,
        project_root: &Path,
        repo_id: &str,
    ) -> Result<(GitRunner, RepoInfo), String> {
        let runner = self.runner()?;
        let cached = self
            .discoveries
            .lock()
            .map_err(|_| "Git 狀態鎖定失敗")?
            .get(project_root)
            .and_then(|found| found.repos.iter().find(|repo| repo.id == repo_id).cloned());
        let repo = match cached {
            Some(repo) => repo,
            None => match self.discover(project_root)? {
                ProjectGit::Ready(found) => found
                    .repos
                    .into_iter()
                    .find(|repo| repo.id == repo_id)
                    .ok_or("找不到此 repository；請重新整理 Git 面板")?,
                ProjectGit::Unavailable { message } => return Err(message),
            },
        };
        if !repo.root_path.is_dir() || !repo.git_dir_path.exists() {
            return Err("Repository 已不存在或已移動；請重新整理 Git 面板".into());
        }
        Ok((runner, repo))
    }

    /// Serializes Session Bay's own writes per common dir. External Git
    /// processes keep using Git's index.lock, which is never removed here.
    pub fn write_lock(&self, repo: &RepoInfo) -> Result<Arc<Mutex<()>>, String> {
        let mut locks = self.write_locks.lock().map_err(|_| "Git 狀態鎖定失敗")?;
        Ok(locks
            .entry(repo.common_dir_path.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }
}

#[cfg(test)]
mod tests {
    use super::GitRequest;

    #[test]
    fn requests_use_camel_case_fields_like_the_ui() {
        let request: GitRequest =
            serde_json::from_value(serde_json::json!({ "op": "status", "repoId": "r1" })).unwrap();
        assert!(matches!(request, GitRequest::Status { repo_id } if repo_id == "r1"));
    }
}
