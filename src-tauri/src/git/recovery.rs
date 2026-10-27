//! Verifiable recovery points taken before destructive operations.
//!
//! A point states exactly what it covers. Tracked changes (HEAD, index and
//! tracked work-tree files) are kept as a `git stash create` commit held by a
//! ref under `refs/sessionbay/recovery/`; deleted refs keep their old object;
//! untracked files about to be deleted are copied byte for byte. Anything not
//! listed — ignored files, other worktrees, remote state — is not covered.
use super::{
    discovery::RepoInfo,
    path::RepoPath,
    runner::{path_arg, Access, GitRunner, Invocation},
};
use crate::tr;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

pub const REF_PREFIX: &str = "refs/sessionbay/recovery/";
pub const MAX_UNTRACKED_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_UNTRACKED_FILES: usize = 2_000;
pub const KEEP_POINTS: usize = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub head: bool,
    pub index: bool,
    pub tracked_files: bool,
    pub untracked_files: usize,
    #[serde(default)]
    pub work_files: usize,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedRef {
    pub name: String,
    pub oid: String,
    /// Stash entries are restored with `git stash store`.
    #[serde(default)]
    pub stash_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPoint {
    pub id: String,
    pub repo_id: String,
    pub repo_root: String,
    pub created_at: i64,
    pub operation: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    /// `git stash create` commit for tracked changes, if there were any.
    pub snapshot: Option<String>,
    pub saved_refs: Vec<SavedRef>,
    pub untracked: Vec<RepoPath>,
    /// Work-tree copies of tracked files (used when the index is unmerged).
    #[serde(default)]
    pub files: Vec<RepoPath>,
    pub coverage: Coverage,
    /// HEAD right after the operation; differing later means new work.
    pub head_after: Option<String>,
    pub notes: Vec<String>,
}

pub struct Store {
    pub directory: PathBuf,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    format!(
        "{}-{}",
        now(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    )
}

pub enum Capture<'a> {
    /// HEAD, index and tracked work-tree files.
    Tracked,
    /// Tracked changes plus copies of these untracked files.
    TrackedAndUntracked(&'a [RepoPath]),
    /// Byte copies of these tracked work-tree files plus HEAD; for states
    /// `git stash create` cannot record, such as an unmerged index.
    WorkFiles(&'a [RepoPath]),
    /// Only these refs (branch, tag, stash) with their current objects.
    Refs(Vec<SavedRef>),
}

impl Store {
    fn repo_dir(&self, repo: &RepoInfo) -> PathBuf {
        self.directory.join(&repo.id)
    }

    fn point_path(&self, repo: &RepoInfo, id: &str) -> Result<PathBuf, String> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(tr!("Invalid recovery point ID"));
        }
        Ok(self.repo_dir(repo).join(format!("{id}.json")))
    }

    /// Creates a point or fails; callers must not continue without one.
    pub fn create(
        &self,
        runner: &GitRunner,
        repo: &RepoInfo,
        operation: &str,
        capture: Capture<'_>,
    ) -> Result<RecoveryPoint, String> {
        let id = new_id();
        let head = super::remote::head(runner, repo)?;
        let branch = runner
            .run(Invocation::new(
                &repo.root_path,
                Access::Read,
                ["symbolic-ref", "--quiet", "--short", "HEAD"],
            ))
            .ok()
            .filter(|o| o.success())
            .map(|o| o.stdout_text().trim().to_owned());
        let mut point = RecoveryPoint {
            id: id.clone(),
            repo_id: repo.id.clone(),
            repo_root: repo.root.clone(),
            created_at: now(),
            operation: operation.to_owned(),
            branch,
            head: head.clone(),
            snapshot: None,
            saved_refs: Vec::new(),
            untracked: Vec::new(),
            files: Vec::new(),
            coverage: Coverage {
                head: head.is_some(),
                index: false,
                tracked_files: false,
                untracked_files: 0,
                work_files: 0,
                refs: Vec::new(),
            },
            head_after: None,
            notes: vec![tr!(
                "Ignored files, other worktrees and remote state are not covered"
            )],
        };
        let directory = self.repo_dir(repo);
        fs::create_dir_all(&directory).map_err(|e| {
            tr!(
                "Cannot create the recovery point folder: {{error}}",
                error = e
            )
        })?;
        match capture {
            Capture::Refs(refs) => {
                for saved in &refs {
                    self.keep(
                        runner,
                        repo,
                        &format!("{id}/{}", sanitize(&saved.name)),
                        &saved.oid,
                    )?;
                    point.coverage.refs.push(saved.name.clone());
                }
                point.saved_refs = refs;
            }
            Capture::WorkFiles(paths) => {
                if let Some(head) = &head {
                    self.keep(runner, repo, &format!("{id}/head"), head)?;
                }
                self.copy_files(repo, &format!("{id}.work"), paths, true)?;
                point.files = paths.to_vec();
                point.coverage.work_files = paths.len();
                point
                    .notes
                    .push(tr!("The conflicted index state cannot be saved; the working tree file contents at that time are saved instead"));
            }
            Capture::Tracked | Capture::TrackedAndUntracked(_) => {
                if let Some(head) = &head {
                    self.keep(runner, repo, &format!("{id}/head"), head)?;
                }
                if head.is_some() {
                    let output = runner.ok(Invocation::new(
                        &repo.root_path,
                        Access::Write,
                        ["stash", "create", "sessionbay recovery point"],
                    )
                    .timeout(std::time::Duration::from_secs(120)))?;
                    let snapshot = output.stdout_text().trim().to_owned();
                    if !snapshot.is_empty() {
                        self.keep(runner, repo, &format!("{id}/snapshot"), &snapshot)?;
                        point.snapshot = Some(snapshot);
                    }
                    point.coverage.index = true;
                    point.coverage.tracked_files = true;
                } else {
                    point.notes.push(tr!(
                        "A branch without commits cannot save the index and tracked files"
                    ));
                }
                if let Capture::TrackedAndUntracked(paths) = capture {
                    self.copy_files(repo, &format!("{id}.files"), paths, false)?;
                    point.untracked = paths.to_vec();
                    point.coverage.untracked_files = paths.len();
                }
            }
        }
        self.save(repo, &point)?;
        self.prune(runner, repo)?;
        Ok(point)
    }

    fn copy_files(
        &self,
        repo: &RepoInfo,
        folder: &str,
        paths: &[RepoPath],
        allow_missing: bool,
    ) -> Result<(), String> {
        if paths.len() > MAX_UNTRACKED_FILES {
            return Err(tr!(
                "More than {{limit}} files, so they cannot all be backed up; the operation stopped",
                limit = MAX_UNTRACKED_FILES
            ));
        }
        let mut total = 0u64;
        for path in paths {
            let source = repo.root_path.join(path_arg(path.as_bytes())?);
            let Ok(metadata) = fs::symlink_metadata(&source) else {
                if allow_missing {
                    continue;
                }
                return Err(tr!(
                    "Cannot read {{path}}; the operation stopped",
                    path = path.display()
                ));
            };
            if !metadata.is_file() {
                return Err(tr!(
                    "{{path}} is not a regular file and cannot be backed up safely; the operation stopped",
                    path = path.display()
                ));
            }
            total += metadata.len();
        }
        if total > MAX_UNTRACKED_BYTES {
            return Err(tr!(
                "The files to back up total {{size}} MB, over the {{limit}} MB limit; the operation stopped",
                size = total / 1024 / 1024,
                limit = MAX_UNTRACKED_BYTES / 1024 / 1024
            ));
        }
        let target = self.repo_dir(repo).join(folder);
        fs::create_dir_all(&target)
            .map_err(|e| tr!("Cannot create the backup folder: {{error}}", error = e))?;
        for (index, path) in paths.iter().enumerate() {
            let source = repo.root_path.join(path_arg(path.as_bytes())?);
            if allow_missing && fs::symlink_metadata(&source).is_err() {
                continue;
            }
            fs::copy(&source, target.join(index.to_string())).map_err(|e| {
                tr!(
                    "Cannot back up {{path}}: {{error}}; the operation stopped",
                    path = path.display(),
                    error = e
                )
            })?;
        }
        Ok(())
    }

    fn keep(
        &self,
        runner: &GitRunner,
        repo: &RepoInfo,
        name: &str,
        oid: &str,
    ) -> Result<(), String> {
        runner
            .ok(Invocation::new(
                &repo.root_path,
                Access::Write,
                ["update-ref", &format!("{REF_PREFIX}{name}"), oid],
            ))
            .map(|_| ())
            .map_err(|e| {
                tr!(
                    "Cannot create the recovery point: {{error}}; the operation stopped",
                    error = e
                )
            })
    }

    fn save(&self, repo: &RepoInfo, point: &RecoveryPoint) -> Result<(), String> {
        let path = self.point_path(repo, &point.id)?;
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(point).map_err(|e| e.to_string())?;
        fs::write(&temporary, bytes)
            .map_err(|e| tr!("Cannot write the recovery point: {{error}}", error = e))?;
        fs::rename(&temporary, &path)
            .map_err(|e| tr!("Cannot write the recovery point: {{error}}", error = e))
    }

    pub fn mark_after(
        &self,
        runner: &GitRunner,
        repo: &RepoInfo,
        point: &mut RecoveryPoint,
    ) -> Result<(), String> {
        point.head_after = super::remote::head(runner, repo)?;
        self.save(repo, point)
    }

    pub fn list(&self, repo: &RepoInfo) -> Vec<RecoveryPoint> {
        let Ok(entries) = fs::read_dir(self.repo_dir(repo)) else {
            return Vec::new();
        };
        let mut points: Vec<RecoveryPoint> = entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| serde_json::from_slice(&fs::read(e.path()).ok()?).ok())
            .collect();
        points.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
        points
    }

    pub fn get(&self, repo: &RepoInfo, id: &str) -> Result<RecoveryPoint, String> {
        let bytes =
            fs::read(self.point_path(repo, id)?).map_err(|_| tr!("Recovery point not found"))?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }

    pub fn remove(&self, runner: &GitRunner, repo: &RepoInfo, id: &str) -> Result<(), String> {
        let path = self.point_path(repo, id)?;
        let refs = runner.ok(Invocation::new(
            &repo.root_path,
            Access::Read,
            [
                "for-each-ref",
                "--format=%(refname)",
                &format!("{REF_PREFIX}{id}/"),
            ],
        ))?;
        for name in refs.stdout_text().lines().filter(|l| !l.is_empty()) {
            runner.ok(Invocation::new(
                &repo.root_path,
                Access::Write,
                ["update-ref", "-d", name],
            ))?;
        }
        let _ = fs::remove_dir_all(self.repo_dir(repo).join(format!("{id}.files")));
        let _ = fs::remove_dir_all(self.repo_dir(repo).join(format!("{id}.work")));
        let _ = fs::remove_file(path);
        Ok(())
    }

    fn prune(&self, runner: &GitRunner, repo: &RepoInfo) -> Result<(), String> {
        for old in self.list(repo).into_iter().skip(KEEP_POINTS) {
            self.remove(runner, repo, &old.id)?;
        }
        Ok(())
    }

    /// Restores without overwriting anything made since: tracked restores
    /// need a clean work tree, ref restores never replace an existing ref.
    pub fn restore(
        &self,
        runner: &GitRunner,
        repo: &RepoInfo,
        id: &str,
        allow_head_move: bool,
    ) -> Result<Vec<String>, String> {
        let point = self.get(repo, id)?;
        let mut done = Vec::new();
        for saved in &point.saved_refs {
            if let Some(message) = &saved.stash_message {
                runner.ok(Invocation::new(
                    &repo.root_path,
                    Access::Write,
                    ["stash", "store", "-m", message, &saved.oid],
                ))?;
            } else {
                // Empty old value: create only if the ref is still absent.
                runner
                    .ok(Invocation::new(
                        &repo.root_path,
                        Access::Write,
                        ["update-ref", &saved.name, &saved.oid, ""],
                    ))
                    .map_err(|_| {
                        tr!("{{name}} already exists and was not overwritten; rename or delete the current ref first", name = saved.name)
                    })?;
            }
            done.push(tr!("Restored {{name}}", name = saved.name));
        }
        if point.saved_refs.is_empty() && point.head.is_some() && point.files.is_empty() {
            let status = super::status::status(runner, repo)?;
            if status.entries.iter().any(|e| !e.untracked) {
                return Err(tr!("There are uncommitted changes; commit or stash them before restoring so nothing is overwritten"));
            }
            let current = super::remote::head(runner, repo)?;
            if current != point.head_after && current != point.head && !allow_head_move {
                return Err(tr!("A new commit was made or HEAD has moved since the operation; the branch moves back to the recovery point only after you confirm (new commits stay in the reflog and a new recovery point)"));
            }
            if current != point.head {
                // Keep today's position recoverable before moving back.
                self.create(
                    runner,
                    repo,
                    &tr!(
                        "Before restoring {{operation}}",
                        operation = point.operation
                    ),
                    Capture::Tracked,
                )?;
                if let Some(head) = &point.head {
                    runner.ok(Invocation::new(
                        &repo.root_path,
                        Access::Write,
                        ["reset", "--hard", "-q", head],
                    ))?;
                    done.push(tr!(
                        "HEAD is back at {{commit}}",
                        commit = &head[..head.len().min(12)]
                    ));
                }
            }
            if let Some(snapshot) = &point.snapshot {
                runner.ok(Invocation::new(
                    &repo.root_path,
                    Access::Write,
                    ["stash", "apply", "--index", "-q", snapshot],
                ))?;
                done.push(tr!("Restored the index and tracked files"));
            }
        }
        let work = self.repo_dir(repo).join(format!("{id}.work"));
        for (index, path) in point.files.iter().enumerate() {
            let source = work.join(index.to_string());
            if !source.exists() {
                continue;
            }
            // Overwrite only a file that still matches HEAD, i.e. carries no
            // newer edits; otherwise leave it and say so.
            let target = repo.root_path.join(path_arg(path.as_bytes())?);
            let current = fs::read(&target).ok();
            let committed = runner
                .run(Invocation::new(
                    &repo.root_path,
                    Access::Read,
                    ["cat-file", "blob", &format!("HEAD:{}", path.display())],
                ))
                .ok()
                .filter(|o| o.success())
                .map(|o| o.stdout);
            if current.is_some() && current != committed {
                done.push(tr!(
                    "Skipped {{path}}: the file has newer changes",
                    path = path.display()
                ));
                continue;
            }
            fs::copy(&source, &target).map_err(|e| {
                tr!(
                    "Cannot restore {{path}}: {{error}}",
                    path = path.display(),
                    error = e
                )
            })?;
            done.push(tr!(
                "Restored the working tree content of {{path}}",
                path = path.display()
            ));
        }
        let backup = self.repo_dir(repo).join(format!("{id}.files"));
        for (index, path) in point.untracked.iter().enumerate() {
            let target = repo.root_path.join(path_arg(path.as_bytes())?);
            if target.symlink_metadata().is_ok() {
                done.push(tr!(
                    "Skipped {{path}}: the file already exists",
                    path = path.display()
                ));
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(backup.join(index.to_string()), &target).map_err(|e| {
                tr!(
                    "Cannot restore {{path}}: {{error}}",
                    path = path.display(),
                    error = e
                )
            })?;
            done.push(tr!("Restored {{name}}", name = path.display()));
        }
        Ok(done)
    }
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}
