//! Git workbench core: discovery, status and repository operations.
//!
//! Every request names a project and, where relevant, a repository identity
//! from discovery. The repository must still be one the project contains;
//! writes are serialized per Git common dir and revalidate state first.
pub mod branches;
pub mod diff;
pub mod discovery;
pub mod history;
pub mod patch;
pub mod path;
pub mod recovery;
pub mod refs;
pub mod remote;
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
    CommitPreview {
        repo_id: String,
    },
    Commit {
        repo_id: String,
        message: String,
        token: String,
    },
    PushPlan {
        repo_id: String,
    },
    Fetch {
        repo_id: String,
        remote: Option<String>,
        #[serde(default)]
        prune: bool,
    },
    Pull {
        repo_id: String,
        strategy: remote::PullStrategy,
    },
    Push {
        repo_id: String,
        #[serde(flatten)]
        request: remote::PushRequest,
    },
    Log {
        repo_id: String,
        #[serde(default)]
        filter: history::LogFilter,
        #[serde(default)]
        offset: usize,
        limit: usize,
    },
    CommitDetail {
        repo_id: String,
        commit: String,
    },
    FileHistory {
        repo_id: String,
        path: RepoPath,
        #[serde(default)]
        offset: usize,
        limit: usize,
    },
    Blame {
        repo_id: String,
        path: RepoPath,
        rev: Option<String>,
    },
    CreateBranch {
        repo_id: String,
        name: String,
        start: Option<String>,
        #[serde(default)]
        switch: bool,
    },
    SwitchBranch {
        repo_id: String,
        name: String,
    },
    DeleteBranch {
        repo_id: String,
        name: String,
        expected: String,
        #[serde(default)]
        force: bool,
    },
    Stashes {
        repo_id: String,
    },
    StashPush {
        repo_id: String,
        #[serde(default)]
        message: String,
        #[serde(default)]
        include_untracked: bool,
        #[serde(default)]
        keep_index: bool,
    },
    StashApply {
        repo_id: String,
        index: usize,
        expected: String,
        #[serde(default)]
        pop: bool,
        #[serde(default)]
        restore_index: bool,
    },
    StashDrop {
        repo_id: String,
        index: usize,
        expected: String,
    },
    StashClear {
        repo_id: String,
        expected: Vec<String>,
    },
    Reset {
        repo_id: String,
        target: String,
        mode: branches::ResetMode,
        expected_head: String,
    },
    Revert {
        repo_id: String,
        commit: String,
        parent: Option<u32>,
        expected_head: String,
    },
    Discard {
        repo_id: String,
        #[serde(default)]
        paths: Vec<RepoPath>,
        #[serde(default)]
        untracked: Vec<RepoPath>,
    },
    CreateTag {
        repo_id: String,
        name: String,
        target: Option<String>,
        message: Option<String>,
        #[serde(default)]
        sign: bool,
    },
    DeleteTag {
        repo_id: String,
        name: String,
        expected: String,
    },
    RemoteTags {
        repo_id: String,
        remote: String,
    },
    PushTag {
        repo_id: String,
        remote: String,
        name: String,
        #[serde(default)]
        force: bool,
    },
    DeleteRemoteTag {
        repo_id: String,
        remote: String,
        name: String,
        expected: String,
    },
    RecoveryPoints {
        repo_id: String,
    },
    RestoreRecovery {
        repo_id: String,
        id: String,
        #[serde(default)]
        allow_head_move: bool,
    },
    RemoveRecovery {
        repo_id: String,
        id: String,
    },
    /// Stops a running hook or network command of this repository.
    CancelOperation {
        repo_id: String,
    },
}

#[derive(Default)]
pub struct GitService {
    runner: Mutex<Option<GitRunner>>,
    discoveries: Mutex<HashMap<PathBuf, Discovery>>,
    cancels: Mutex<HashMap<PathBuf, Arc<AtomicBool>>>,
    write_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    recovery_dir: Option<PathBuf>,
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

    /// Destructive operations need somewhere to keep recovery points.
    pub fn with_recovery_dir(directory: PathBuf) -> Self {
        Self {
            recovery_dir: Some(directory),
            ..Self::default()
        }
    }

    fn store(&self) -> Result<recovery::Store, String> {
        self.recovery_dir
            .clone()
            .map(|directory| recovery::Store { directory })
            .ok_or_else(|| "沒有可用的復原點儲存位置；已停止破壞性操作".into())
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
            GitRequest::CommitPreview { repo_id } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(remote::commit_preview(&runner, &repo)?)
            }
            GitRequest::Commit {
                repo_id,
                message,
                token,
            } => {
                let cancel = self.begin_operation(&repo_id)?;
                let result = self.write(project_root, &repo_id, |runner, repo| {
                    remote::commit(runner, repo, &message, &token, cancel)
                });
                self.end_operation(&repo_id);
                json(result?)
            }
            GitRequest::PushPlan { repo_id } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(remote::push_plan(&runner, &repo)?)
            }
            GitRequest::Fetch {
                repo_id,
                remote: name,
                prune,
            } => self.long(project_root, &repo_id, |runner, repo, cancel| {
                remote::fetch(runner, repo, name.as_deref(), prune, cancel)
            }),
            GitRequest::Pull { repo_id, strategy } => {
                self.long(project_root, &repo_id, |runner, repo, cancel| {
                    remote::pull(runner, repo, strategy, cancel)
                })
            }
            GitRequest::Push { repo_id, request } => {
                let cancel = self.begin_operation(&repo_id)?;
                let result = self.write(project_root, &repo_id, |runner, repo| {
                    remote::push(runner, repo, &request, cancel)
                });
                self.end_operation(&repo_id);
                json(result?)
            }
            GitRequest::Log {
                repo_id,
                filter,
                offset,
                limit,
            } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(history::log(&runner, &repo, &filter, offset, limit)?)
            }
            GitRequest::CommitDetail { repo_id, commit } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(history::commit_detail(&runner, &repo, &commit)?)
            }
            GitRequest::FileHistory {
                repo_id,
                path,
                offset,
                limit,
            } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(history::file_history(&runner, &repo, &path, offset, limit)?)
            }
            GitRequest::Blame { repo_id, path, rev } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(history::blame(&runner, &repo, &path, rev.as_deref())?)
            }
            GitRequest::CreateBranch {
                repo_id,
                name,
                start,
                switch,
            } => self.write(project_root, &repo_id, |runner, repo| {
                json(branches::create_branch(
                    runner,
                    repo,
                    &name,
                    start.as_deref(),
                    switch,
                )?)
            }),
            GitRequest::SwitchBranch { repo_id, name } => {
                self.write(project_root, &repo_id, |runner, repo| {
                    json(branches::switch_branch(runner, repo, &name)?)
                })
            }
            GitRequest::DeleteBranch {
                repo_id,
                name,
                expected,
                force,
            } => {
                let store = self.store()?;
                self.write(project_root, &repo_id, |runner, repo| {
                    json(branches::delete_branch(
                        &store, runner, repo, &name, &expected, force,
                    )?)
                })
            }
            GitRequest::Stashes { repo_id } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(branches::stashes(&runner, &repo)?)
            }
            GitRequest::StashPush {
                repo_id,
                message,
                include_untracked,
                keep_index,
            } => self.write(project_root, &repo_id, |runner, repo| {
                json(branches::stash_push(
                    runner,
                    repo,
                    &message,
                    include_untracked,
                    keep_index,
                )?)
            }),
            GitRequest::StashApply {
                repo_id,
                index,
                expected,
                pop,
                restore_index,
            } => self.write(project_root, &repo_id, |runner, repo| {
                json(branches::stash_apply(
                    runner,
                    repo,
                    index,
                    &expected,
                    pop,
                    restore_index,
                )?)
            }),
            GitRequest::StashDrop {
                repo_id,
                index,
                expected,
            } => {
                let store = self.store()?;
                self.write(project_root, &repo_id, |runner, repo| {
                    json(branches::stash_drop(
                        &store, runner, repo, index, &expected,
                    )?)
                })
            }
            GitRequest::StashClear { repo_id, expected } => {
                let store = self.store()?;
                self.write(project_root, &repo_id, |runner, repo| {
                    json(branches::stash_clear(&store, runner, repo, &expected)?)
                })
            }
            GitRequest::Reset {
                repo_id,
                target,
                mode,
                expected_head,
            } => {
                let store = self.store()?;
                self.write(project_root, &repo_id, |runner, repo| {
                    json(branches::reset(
                        &store,
                        runner,
                        repo,
                        &target,
                        mode,
                        &expected_head,
                    )?)
                })
            }
            GitRequest::Revert {
                repo_id,
                commit,
                parent,
                expected_head,
            } => self.write(project_root, &repo_id, |runner, repo| {
                json(branches::revert(
                    runner,
                    repo,
                    &commit,
                    parent,
                    &expected_head,
                )?)
            }),
            GitRequest::Discard {
                repo_id,
                paths,
                untracked,
            } => {
                let store = self.store()?;
                self.write(project_root, &repo_id, |runner, repo| {
                    json(branches::discard(&store, runner, repo, &paths, &untracked)?)
                })
            }
            GitRequest::CreateTag {
                repo_id,
                name,
                target,
                message,
                sign,
            } => self.write(project_root, &repo_id, |runner, repo| {
                json(branches::create_tag(
                    runner,
                    repo,
                    &name,
                    target.as_deref(),
                    message.as_deref(),
                    sign,
                )?)
            }),
            GitRequest::DeleteTag {
                repo_id,
                name,
                expected,
            } => {
                let store = self.store()?;
                self.write(project_root, &repo_id, |runner, repo| {
                    json(branches::delete_tag(
                        &store, runner, repo, &name, &expected,
                    )?)
                })
            }
            GitRequest::RemoteTags { repo_id, remote } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(branches::remote_tags(&runner, &repo, &remote)?)
            }
            GitRequest::PushTag {
                repo_id,
                remote,
                name,
                force,
            } => self.write(project_root, &repo_id, |runner, repo| {
                json(branches::push_tag(runner, repo, &remote, &name, force)?)
            }),
            GitRequest::DeleteRemoteTag {
                repo_id,
                remote,
                name,
                expected,
            } => self.write(project_root, &repo_id, |runner, repo| {
                json(branches::delete_remote_tag(
                    runner, repo, &remote, &name, &expected,
                )?)
            }),
            GitRequest::RecoveryPoints { repo_id } => {
                let (_, repo) = self.repo(project_root, &repo_id)?;
                json(
                    self.store()
                        .map(|store| store.list(&repo))
                        .unwrap_or_default(),
                )
            }
            GitRequest::RestoreRecovery {
                repo_id,
                id,
                allow_head_move,
            } => {
                let store = self.store()?;
                self.write(project_root, &repo_id, |runner, repo| {
                    json(store.restore(runner, repo, &id, allow_head_move)?)
                })
            }
            GitRequest::RemoveRecovery { repo_id, id } => {
                let store = self.store()?;
                self.write(project_root, &repo_id, |runner, repo| {
                    store.remove(runner, repo, &id)?;
                    Ok(Value::Null)
                })
            }
            GitRequest::CancelOperation { repo_id } => {
                if let Some(flag) = self
                    .operations
                    .lock()
                    .map_err(|_| "Git 狀態鎖定失敗")?
                    .get(&repo_id)
                {
                    flag.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                Ok(Value::Null)
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

    fn begin_operation(&self, repo_id: &str) -> Result<Arc<AtomicBool>, String> {
        let flag = Arc::new(AtomicBool::new(false));
        self.operations
            .lock()
            .map_err(|_| "Git 狀態鎖定失敗")?
            .insert(repo_id.to_owned(), flag.clone());
        Ok(flag)
    }

    fn end_operation(&self, repo_id: &str) {
        if let Ok(mut operations) = self.operations.lock() {
            operations.remove(repo_id);
        }
    }

    /// A cancellable write returning Git's own (sanitized) output.
    fn long(
        &self,
        project_root: &Path,
        repo_id: &str,
        action: impl FnOnce(&GitRunner, &RepoInfo, Arc<AtomicBool>) -> Result<String, String>,
    ) -> Result<Value, String> {
        let cancel = self.begin_operation(repo_id)?;
        let result = self.write(project_root, repo_id, |runner, repo| {
            action(runner, repo, cancel)
        });
        self.end_operation(repo_id);
        Ok(serde_json::json!({ "output": result? }))
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
