//! Git workbench core: discovery, status and repository operations.
//!
//! Every request names a project and, where relevant, a repository identity
//! from discovery. The repository must still be one the project contains;
//! writes are serialized per Git common dir and revalidate state first.
pub mod discovery;
pub mod path;
pub mod runner;
pub mod status;

use discovery::{Discovery, RepoInfo};
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
#[serde(rename_all = "camelCase", tag = "op")]
pub enum GitRequest {
    Discover,
    CancelDiscovery,
    Status { repo_id: String },
}

#[derive(Default)]
pub struct GitService {
    runner: Mutex<Option<GitRunner>>,
    discoveries: Mutex<HashMap<PathBuf, Discovery>>,
    cancels: Mutex<HashMap<PathBuf, Arc<AtomicBool>>>,
    write_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
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
        }
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
