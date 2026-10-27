//! Git workbench core: discovery, status and repository operations.
//!
//! Every request names a project and, where relevant, a repository identity
//! from discovery. The repository must still be one the project contains;
//! writes are serialized per Git common dir and revalidate state first.
pub mod branches;
pub mod conflict;
pub mod diff;
pub mod discovery;
pub mod history;
pub mod hosting;
pub mod patch;
pub mod path;
pub mod recovery;
pub mod refs;
pub mod remote;
pub mod runner;
pub mod status;
pub mod worktrees;

use crate::tr;
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
    Discover {
        /// Explicit "keep scanning": deeper and longer than the default.
        #[serde(default)]
        extended: bool,
        #[serde(default)]
        max_depth: Option<usize>,
    },
    /// Adds the repository that contains an opened project file.
    IncludePath {
        path: String,
    },
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
    Worktrees {
        repo_id: String,
    },
    WorktreeAdd {
        repo_id: String,
        branch: String,
        /// Create the branch (from `base`, default HEAD) instead of using an existing one.
        #[serde(default)]
        create: bool,
        base: Option<String>,
        path: Option<String>,
    },
    WorktreeRemove {
        repo_id: String,
        path: String,
        /// Stash local changes first; without it a dirty checkout is refused.
        #[serde(default)]
        stash: bool,
    },
    WorktreePrune {
        repo_id: String,
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
    Merge {
        repo_id: String,
        rev: String,
        #[serde(default)]
        no_ff: bool,
        expected_head: String,
    },
    ConflictFile {
        repo_id: String,
        path: RepoPath,
    },
    SaveConflict {
        repo_id: String,
        path: RepoPath,
        token: String,
        content: String,
    },
    MarkResolved {
        repo_id: String,
        path: RepoPath,
        token: String,
        #[serde(default)]
        allow_markers: bool,
    },
    ResolveWith {
        repo_id: String,
        path: RepoPath,
        token: String,
        choice: conflict::Choice,
        new_path: Option<RepoPath>,
    },
    ContinueOperation {
        repo_id: String,
    },
    AbortOperation {
        repo_id: String,
    },
    RemoteMappings {
        repo_id: String,
    },
    SetRemoteMapping {
        repo_id: String,
        remote: String,
        connection_id: Option<String>,
        project: Option<String>,
    },
    Pulls {
        repo_id: String,
        remote: String,
        #[serde(default)]
        state: String,
        #[serde(default)]
        refresh: bool,
    },
    PullDetail {
        repo_id: String,
        remote: String,
        number: u64,
    },
    PullFiles {
        repo_id: String,
        remote: String,
        number: u64,
    },
    PullComments {
        repo_id: String,
        remote: String,
        number: u64,
    },
    PullComment {
        repo_id: String,
        remote: String,
        number: u64,
        body: String,
        position: Option<hosting::review::LinePosition>,
        expected_head: String,
    },
    PullReview {
        repo_id: String,
        remote: String,
        number: u64,
        event: hosting::review::ReviewEvent,
        #[serde(default)]
        body: String,
        expected_head: String,
    },
    PullMerge {
        repo_id: String,
        remote: String,
        number: u64,
        method: String,
        expected_head: String,
    },
    PullCreate {
        repo_id: String,
        remote: String,
        title: String,
        #[serde(default)]
        body: String,
        source: String,
        target: String,
        #[serde(default)]
        draft: bool,
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
    extra_repos: Mutex<HashMap<PathBuf, Vec<RepoInfo>>>,
    cancels: Mutex<HashMap<PathBuf, Arc<AtomicBool>>>,
    write_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    recovery_dir: Option<PathBuf>,
    hosting: Option<hosting::Hosting>,
}

pub const STALE_SELECTION: &str =
    "The content changed after you selected it (perhaps an agent, editor or another Git operation), so nothing was written; select again";

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
        return Err(tr!("No files selected"));
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

    /// Recovery points and host connections live in the app data directory.
    pub fn with_data_dir(directory: PathBuf) -> Self {
        Self {
            recovery_dir: Some(directory.join("git-recovery")),
            hosting: Some(hosting::Hosting::new(directory.join("git-hosts.json"))),
            ..Self::default()
        }
    }

    pub fn hosting(&self) -> Result<&hosting::Hosting, String> {
        self.hosting
            .as_ref()
            .ok_or_else(|| tr!("No storage location is available for host settings"))
    }

    pub fn handle_hosting(
        &self,
        project_root: &Path,
        request: hosting::HostRequest,
    ) -> Result<Value, String> {
        let runner = self.runner()?;
        self.hosting()?.handle(&runner, project_root, request)
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
            .ok_or_else(|| tr!("No storage location is available for recovery points, so the destructive operation stopped"))
    }

    /// Only a successful detection is cached, so installing Git later works.
    pub fn runner(&self) -> Result<GitRunner, GitError> {
        let mut guard = self
            .runner
            .lock()
            .map_err(|_| GitError::failed(tr!("Could not lock the Git state")))?;
        if let Some(runner) = guard.as_ref() {
            return Ok(runner.clone());
        }
        let runner = GitRunner::detect()?;
        *guard = Some(runner.clone());
        Ok(runner)
    }

    pub fn handle(&self, project_root: &Path, request: GitRequest) -> Result<Value, String> {
        match request {
            GitRequest::Discover { extended, max_depth } => {
                let limits = if extended || max_depth.is_some() {
                    discovery::ScanLimits::extended(max_depth)
                } else {
                    discovery::ScanLimits::default()
                };
                json(self.discover_with(project_root, limits)?)
            }
            GitRequest::IncludePath { path } => json(self.include_path(project_root, &path)?),
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
            GitRequest::Worktrees { repo_id } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(worktrees::list(&runner, &repo)?)
            }
            GitRequest::WorktreeAdd { repo_id, branch, create, base, path } => {
                self.write(project_root, &repo_id, |runner, repo| {
                    json(worktrees::add(runner, repo, &branch, create, base.as_deref(), path.as_deref())?)
                })
            }
            GitRequest::WorktreeRemove { repo_id, path, stash } => {
                self.write(project_root, &repo_id, |runner, repo| json(worktrees::remove(runner, repo, &path, stash)?))
            }
            GitRequest::WorktreePrune { repo_id } => {
                self.write(project_root, &repo_id, |runner, repo| json(worktrees::prune(runner, repo)?))
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
            GitRequest::Merge { repo_id, rev, no_ff, expected_head } => self.write(project_root, &repo_id, |runner, repo| {
                json(conflict::merge(runner, repo, &rev, no_ff, &expected_head)?)
            }),
            GitRequest::ConflictFile { repo_id, path } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(conflict::conflict_file(&runner, &repo, &path)?)
            }
            GitRequest::SaveConflict { repo_id, path, token, content } => self.write(project_root, &repo_id, |runner, repo| {
                Ok(serde_json::json!({ "token": conflict::save(runner, repo, &path, &token, &content)? }))
            }),
            GitRequest::MarkResolved { repo_id, path, token, allow_markers } => self.write(project_root, &repo_id, |runner, repo| {
                json(conflict::mark_resolved(runner, repo, &path, &token, allow_markers)?)
            }),
            GitRequest::ResolveWith { repo_id, path, token, choice, new_path } => self.write(project_root, &repo_id, |runner, repo| {
                json(conflict::resolve_with(runner, repo, &path, &token, choice, new_path.as_ref())?)
            }),
            GitRequest::ContinueOperation { repo_id } => self.write(project_root, &repo_id, |runner, repo| {
                json(conflict::continue_operation(runner, repo)?)
            }),
            GitRequest::AbortOperation { repo_id } => {
                let store = self.store()?;
                self.write(project_root, &repo_id, |runner, repo| json(conflict::abort_operation(&store, runner, repo)?))
            }
            GitRequest::RemoteMappings { repo_id } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                json(self.remote_mappings(&runner, &repo)?)
            }
            GitRequest::SetRemoteMapping { repo_id, remote, connection_id, project } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                remote::remote_exists(&runner, &repo, &remote)?;
                self.hosting()?.set_mapping(&repo.id, &remote, connection_id.as_deref(), project.as_deref())?;
                json(self.remote_mappings(&runner, &repo)?)
            }
            GitRequest::Pulls { repo_id, remote, state, refresh } => self.with_pulls(project_root, &repo_id, &remote, |api, _, hosting| {
                let key = format!("{}|list|{state}", api.project);
                if !refresh {
                    if let Some(cached) = hosting.cache.get(&api.connection.id, &key, 15) {
                        return Ok(cached);
                    }
                }
                let value = json(api.list(&state)?)?;
                hosting.cache.put(&api.connection.id, &key, value.clone());
                Ok(value)
            }),
            GitRequest::PullDetail { repo_id, remote, number } => self.with_pulls(project_root, &repo_id, &remote, |api, viewer, _| {
                let mut value = json(api.detail(number, viewer)?)?;
                value["connection"] = serde_json::json!({ "id": api.connection.id, "account": viewer, "host": api.connection.host, "provider": api.connection.provider });
                Ok(value)
            }),
            GitRequest::PullFiles { repo_id, remote, number } => self.with_pulls(project_root, &repo_id, &remote, |api, _, _| {
                let (files, truncated) = api.files(number)?;
                Ok(serde_json::json!({ "files": files, "truncated": truncated }))
            }),
            GitRequest::PullComments { repo_id, remote, number } => self.with_pulls(project_root, &repo_id, &remote, |api, _, _| Ok(json(api.comments(number)?)?)),
            GitRequest::PullComment { repo_id, remote, number, body, position, expected_head } => self.with_pulls(project_root, &repo_id, &remote, |api, viewer, _| {
                api.comment(number, &body, position.as_ref(), &expected_head, viewer)?;
                Ok(Value::Null)
            }),
            GitRequest::PullReview { repo_id, remote, number, event, body, expected_head } => self.with_pulls(project_root, &repo_id, &remote, |api, viewer, _| {
                api.review(number, event, &body, &expected_head, viewer)?;
                Ok(Value::Null)
            }),
            GitRequest::PullMerge { repo_id, remote, number, method, expected_head } => self.with_pulls(project_root, &repo_id, &remote, |api, viewer, hosting| {
                api.merge(number, &method, &expected_head, viewer)?;
                hosting.cache.forget(&api.connection.id);
                Ok(Value::Null)
            }),
            GitRequest::PullCreate { repo_id, remote, title, body, source, target, draft } => {
                let (runner, repo) = self.repo(project_root, &repo_id)?;
                remote::check_ref_name(&runner, &repo, &source, &crate::tr!("source branch"))?;
                remote::check_ref_name(&runner, &repo, &target, &crate::tr!("target branch"))?;
                let pushed = runner
                    .run(runner::Invocation::new(&repo.root_path, Access::Read, ["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{remote}/{source}")]))?
                    .success();
                if !pushed {
                    return Err(tr!("{{source}} is not on {{remote}}; push this branch before creating a PR / MR", source = source, remote = remote));
                }
                self.with_pulls(project_root, &repo_id, &remote, |api, _, hosting| {
                    let created = api.create(&title, &body, &source, &target, draft)?;
                    hosting.cache.forget(&api.connection.id);
                    Ok(json(created)?)
                })
            }
            GitRequest::CancelOperation { repo_id } => {
                if let Some(flag) = self
                    .operations
                    .lock()
                    .map_err(|_| tr!("Could not lock the Git state"))?
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

    /// Each remote with its parsed host/project, candidate connections and
    /// the saved choice, which the user can inspect and correct.
    pub fn remote_mappings(
        &self,
        runner: &GitRunner,
        repo: &RepoInfo,
    ) -> Result<Vec<Value>, String> {
        let hosting = self.hosting()?;
        let hosts = hosting.load();
        let saved = hosting.mappings_for(&repo.id);
        let mut list = Vec::new();
        for remote in refs::remotes(runner, repo)? {
            let mut parsed = hosting::remote_url::parse(&remote.url);
            if let Some(parsed) = parsed.as_mut() {
                hosting::remote_url::resolve_ssh_alias(parsed);
            }
            let candidates: Vec<&hosting::Connection> = hosts
                .connections
                .iter()
                .filter(|c| {
                    parsed.as_ref().is_some_and(|p| {
                        let name = c.host.split(':').next().unwrap_or_default();
                        name == p.resolved_host || name == p.host
                    })
                })
                .collect();
            let mapping = saved.iter().find(|m| m.remote == remote.name);
            // A single matching account is a suggestion, never silent: the
            // UI shows it as unconfirmed until the user saves it.
            let suggested =
                (mapping.is_none() && candidates.len() == 1).then(|| candidates[0].id.clone());
            list.push(serde_json::json!({
                "remote": remote.name,
                "url": remote.url,
                "parsed": parsed,
                "candidates": candidates.iter().map(|c| serde_json::json!({ "id": c.id, "provider": c.provider, "host": c.host, "account": c.account })).collect::<Vec<_>>(),
                "mapping": mapping,
                "suggested": suggested,
            }));
        }
        Ok(list)
    }

    /// Resolves the confirmed account and project for a repo remote.
    fn with_pulls(
        &self,
        project_root: &Path,
        repo_id: &str,
        remote: &str,
        action: impl FnOnce(
            &hosting::review::Api<'_>,
            &str,
            &hosting::Hosting,
        ) -> Result<Value, hosting::http::HostError>,
    ) -> Result<Value, String> {
        let (runner, repo) = self.repo(project_root, repo_id)?;
        let hosting = self.hosting()?;
        let mapping = hosting
            .mappings_for(&repo.id)
            .into_iter()
            .find(|m| m.remote == remote)
            .ok_or_else(|| tr!("{{remote}} is not linked to a host account yet; confirm the mapping under \"Hosts and accounts\"", remote = remote))?;
        let connection = hosting.connection(&mapping.connection_id)?;
        let token = hosting.token(&runner, project_root, &connection)?;
        let api = hosting::review::Api {
            client: &hosting.client,
            connection: &connection,
            token: &token,
            project: &mapping.project,
        };
        action(&api, &connection.account, hosting).map_err(String::from)
    }

    fn begin_operation(&self, repo_id: &str) -> Result<Arc<AtomicBool>, String> {
        let flag = Arc::new(AtomicBool::new(false));
        self.operations
            .lock()
            .map_err(|_| tr!("Could not lock the Git state"))?
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
        let _guard = lock
            .lock()
            .map_err(|_| tr!("Could not take the Git write lock"))?;
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
                return Err(crate::i18n::tr(STALE_SELECTION));
            }
            let selected = patch::selected_lines(&raw, selection)?;
            let Some(bytes) = patch::build(&raw, path.as_bytes(), &selected, direction)? else {
                return Err(tr!("The selection has no changes to apply"));
            };
            let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
            if direction == Direction::Unstage {
                args.push("--reverse");
            }
            args.push("-");
            runner
                .ok(Invocation::new(&repo.root_path, Access::Write, args).stdin(bytes))
                .map_err(|e| {
                    tr!(
                        "Cannot apply the selected changes (nothing was written): {{error}}",
                        error = e
                    )
                })?;
            Ok(Value::Null)
        })
    }

    pub fn discover(&self, project_root: &Path) -> Result<ProjectGit, String> {
        self.discover_with(project_root, discovery::ScanLimits::default())
    }

    /// Finds the repo of an opened file and keeps it with this project's
    /// discovery (also across later rescans). Returns the updated state.
    pub fn include_path(&self, project_root: &Path, path: &str) -> Result<ProjectGit, String> {
        let runner = self.runner()?;
        let Some(repo) = discovery::repo_for_path(&runner, project_root, path)? else {
            return self.current(project_root);
        };
        self.extra_repos
            .lock()
            .map_err(|_| tr!("Could not lock the Git state"))?
            .entry(project_root.to_owned())
            .or_default()
            .retain(|known| known.id != repo.id);
        self.extra_repos
            .lock()
            .map_err(|_| tr!("Could not lock the Git state"))?
            .entry(project_root.to_owned())
            .or_default()
            .push(repo.clone());
        let mut discoveries = self
            .discoveries
            .lock()
            .map_err(|_| tr!("Could not lock the Git state"))?;
        if let Some(found) = discoveries.get_mut(project_root) {
            if !found.repos.iter().any(|known| known.id == repo.id) {
                found.repos.push(repo);
            }
            return Ok(ProjectGit::Ready(found.clone()));
        }
        drop(discoveries);
        self.discover(project_root)
    }

    fn current(&self, project_root: &Path) -> Result<ProjectGit, String> {
        let cached = self
            .discoveries
            .lock()
            .map_err(|_| tr!("Could not lock the Git state"))?
            .get(project_root)
            .cloned();
        match cached {
            Some(found) => Ok(ProjectGit::Ready(found)),
            None => self.discover(project_root),
        }
    }

    pub fn discover_with(
        &self,
        project_root: &Path,
        limits: discovery::ScanLimits,
    ) -> Result<ProjectGit, String> {
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
            .map_err(|_| tr!("Could not lock the Git state"))?
            .insert(project_root.to_owned(), cancel.clone());
        let mut found = discovery::discover_with(&runner, project_root, &cancel, limits)?;
        // Repos found through opened files stay listed after a rescan.
        if let Some(extra) = self
            .extra_repos
            .lock()
            .map_err(|_| tr!("Could not lock the Git state"))?
            .get(project_root)
        {
            for repo in extra {
                if repo.root_path.is_dir() && !found.repos.iter().any(|known| known.id == repo.id) {
                    found.repos.push(repo.clone());
                }
            }
        }
        self.discoveries
            .lock()
            .map_err(|_| tr!("Could not lock the Git state"))?
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
            .map_err(|_| tr!("Could not lock the Git state"))?
            .get(project_root)
            .and_then(|found| found.repos.iter().find(|repo| repo.id == repo_id).cloned());
        let repo = match cached {
            Some(repo) => repo,
            None => match self.discover(project_root)? {
                ProjectGit::Ready(found) => found
                    .repos
                    .into_iter()
                    .find(|repo| repo.id == repo_id)
                    .ok_or(tr!("This repository was not found; refresh the Git panel"))?,
                ProjectGit::Unavailable { message } => return Err(message),
            },
        };
        if !repo.root_path.is_dir() || !repo.git_dir_path.exists() {
            return Err(tr!(
                "The repository no longer exists or was moved; refresh the Git panel"
            ));
        }
        Ok((runner, repo))
    }

    /// Serializes Session Bay's own writes per common dir. External Git
    /// processes keep using Git's index.lock, which is never removed here.
    pub fn write_lock(&self, repo: &RepoInfo) -> Result<Arc<Mutex<()>>, String> {
        let mut locks = self
            .write_locks
            .lock()
            .map_err(|_| tr!("Could not lock the Git state"))?;
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
