//! Merging and in-app conflict resolution.
//!
//! Conflict views name sides by the running operation's real meaning. Every
//! write checks a token over the file's index stages and work-tree bytes, so
//! a concurrent Agent or editor change stops the write instead of being lost.
use super::{
    branches::Outcome,
    diff::resolve_commit,
    discovery::RepoInfo,
    path::RepoPath,
    recovery::{Capture, Store},
    runner::{path_arg, Access, GitError, GitRunner, Invocation},
    status::{self, Operation},
};
use crate::tr;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, time::Duration};

pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

/// Mode and object id of conflict stages 1 (base), 2 (ours) and 3 (theirs).
type Stages = [Option<(String, String)>; 3];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub label: String,
    pub detail: String,
    pub present: bool,
    pub oid: Option<String>,
    pub mode: Option<String>,
    pub size: u64,
    /// UTF-8 text when it is safe to show; `None` for binary or too large.
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: RepoPath,
    pub operation: Option<Operation>,
    pub base: Side,
    pub ours: Side,
    pub theirs: Side,
    pub result: Side,
    pub textual: bool,
    pub token: String,
    pub unmerged: bool,
}

fn stage_entries(
    runner: &GitRunner,
    repo: &RepoInfo,
    path: &RepoPath,
) -> Result<(Vec<u8>, Stages), GitError> {
    let output = runner.ok(Invocation::new(
        &repo.root_path,
        Access::Read,
        ["ls-files", "-u", "-z", "--"],
    )
    .arg(path_arg(path.as_bytes())?))?;
    let mut stages: Stages = [None, None, None];
    for record in output.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        // "<mode> <oid> <stage>\t<path>"
        let text = String::from_utf8_lossy(record);
        let Some((meta, _)) = text.split_once('\t') else {
            continue;
        };
        let parts: Vec<&str> = meta.split(' ').collect();
        if parts.len() == 3 {
            if let Ok(stage @ 1..=3) = parts[2].parse::<usize>() {
                stages[stage - 1] = Some((parts[0].to_owned(), parts[1].to_owned()));
            }
        }
    }
    Ok((output.stdout, stages))
}

fn work_bytes(repo: &RepoInfo, path: &RepoPath) -> Result<Option<Vec<u8>>, String> {
    let file = repo.root_path.join(path_arg(path.as_bytes())?);
    match fs::symlink_metadata(&file) {
        Ok(meta) if meta.is_file() => fs::read(&file).map(Some).map_err(|e| e.to_string()),
        Ok(_) => Err(tr!("{{v1}} is not a regular file", v1 = path.display())),
        Err(_) => Ok(None),
    }
}

pub fn token(runner: &GitRunner, repo: &RepoInfo, path: &RepoPath) -> Result<String, String> {
    let (stages, _) = stage_entries(runner, repo, path)?;
    let work = work_bytes(repo, path)?;
    let mut hasher = Sha256::new();
    hasher.update(&stages);
    hasher.update([0xff]);
    match &work {
        Some(bytes) => {
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        }
        None => hasher.update(b"absent"),
    }
    Ok(hasher.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn check_token(
    runner: &GitRunner,
    repo: &RepoInfo,
    path: &RepoPath,
    expected: &str,
) -> Result<(), String> {
    if token(runner, repo, path)? != expected {
        return Err(
            tr!("The file or conflict state changed after opening (perhaps an agent or another editor), so nothing was written; reload"),
        );
    }
    Ok(())
}

fn as_text(bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_TEXT_BYTES || bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes.to_vec()).ok()
}

fn short(runner: &GitRunner, repo: &RepoInfo, rev: &str) -> String {
    runner
        .run(Invocation::new(
            &repo.root_path,
            Access::Read,
            ["log", "-1", "--format=%h %s", rev, "--"],
        ))
        .ok()
        .filter(|o| o.success())
        .map(|o| o.stdout_text().trim().chars().take(120).collect())
        .unwrap_or_else(|| rev.to_owned())
}

fn read_text(repo: &RepoInfo, name: &str) -> Option<String> {
    fs::read_to_string(repo.git_dir_path.join(name))
        .ok()
        .map(|s| s.trim().to_owned())
}

/// Labels follow the operation: during a rebase "ours" is the branch being
/// rebuilt onto, and "theirs" is the user's own commit being replayed.
pub fn labels(
    runner: &GitRunner,
    repo: &RepoInfo,
    operation: Option<Operation>,
) -> [(String, String); 3] {
    let head = short(runner, repo, "HEAD");
    let current = runner
        .run(Invocation::new(
            &repo.root_path,
            Access::Read,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
        ))
        .ok()
        .filter(|o| o.success())
        .map(|o| o.stdout_text().trim().to_owned());
    let base = (
        tr!("Common ancestor (base)").to_owned(),
        tr!("The version before the two sides diverged").to_owned(),
    );
    match operation {
        Some(Operation::Merge) => [
            base,
            (
                tr!(
                    "Current branch ({{v1}})",
                    v1 = current.unwrap_or_else(|| "HEAD".into())
                ),
                head,
            ),
            (tr!("Incoming version"), short(runner, repo, "MERGE_HEAD")),
        ],
        Some(Operation::Rebase) => {
            let replaying = read_text(repo, "rebase-merge/stopped-sha")
                .or_else(|| read_text(repo, "REBASE_HEAD"))
                .map(|oid| short(runner, repo, &oid))
                .unwrap_or_default();
            let onto = read_text(repo, "rebase-merge/onto")
                .or_else(|| read_text(repo, "rebase-apply/onto"))
                .unwrap_or_default();
            [
                base,
                (
                    tr!("Rebase target (already replayed)"),
                    tr!(
                        "{{head}} (onto {{v1}})",
                        head = head,
                        v1 = &onto[..onto.len().min(7)]
                    ),
                ),
                (tr!("Your commit being replayed"), replaying),
            ]
        }
        Some(Operation::CherryPick) => [
            base,
            (tr!("Current HEAD"), head),
            (
                tr!("Commit being cherry-picked"),
                short(runner, repo, "CHERRY_PICK_HEAD"),
            ),
        ],
        Some(Operation::Revert) => [
            base,
            (tr!("Current HEAD"), head),
            (
                tr!("Commit being reverted"),
                short(runner, repo, "REVERT_HEAD"),
            ),
        ],
        Some(Operation::Am) => [
            base,
            (tr!("Current HEAD"), head),
            (tr!("Patch being applied"), String::new()),
        ],
        _ => [
            base,
            (tr!("Current HEAD (or updated content)"), head),
            (
                tr!("Changes being applied (such as a stash)"),
                String::new(),
            ),
        ],
    }
}

fn blob(runner: &GitRunner, repo: &RepoInfo, oid: &str) -> Result<Vec<u8>, GitError> {
    Ok(runner
        .ok(
            Invocation::new(&repo.root_path, Access::Read, ["cat-file", "blob", oid])
                .limit(256 * 1024 * 1024),
        )?
        .stdout)
}

pub fn conflict_file(
    runner: &GitRunner,
    repo: &RepoInfo,
    path: &RepoPath,
) -> Result<ConflictFile, String> {
    let operation = status::operation(repo);
    let (_, stages) = stage_entries(runner, repo, path)?;
    let names = labels(runner, repo, operation);
    let mut textual = true;
    let mut side = |entry: &Option<(String, String)>,
                    (label, detail): &(String, String)|
     -> Result<Side, String> {
        let Some((mode, oid)) = entry else {
            return Ok(Side {
                label: label.clone(),
                detail: detail.clone(),
                present: false,
                oid: None,
                mode: None,
                size: 0,
                text: Some(String::new()),
            });
        };
        let bytes = blob(runner, repo, oid)?;
        let text = if mode == "160000" || mode == "120000" {
            None
        } else {
            as_text(&bytes)
        };
        textual &= text.is_some();
        Ok(Side {
            label: label.clone(),
            detail: detail.clone(),
            present: true,
            oid: Some(oid.clone()),
            mode: Some(mode.clone()),
            size: bytes.len() as u64,
            text,
        })
    };
    let base = side(&stages[0], &names[0])?;
    let ours = side(&stages[1], &names[1])?;
    let theirs = side(&stages[2], &names[2])?;
    let work = work_bytes(repo, path)?;
    let result_text = work.as_deref().and_then(as_text);
    if work.is_some() && result_text.is_none() {
        textual = false;
    }
    // Add/delete style conflicts need a whole-file decision.
    if !ours.present || !theirs.present {
        textual = false;
    }
    Ok(ConflictFile {
        path: path.clone(),
        operation,
        result: Side {
            label: tr!("Result (working tree file)"),
            detail: String::new(),
            present: work.is_some(),
            oid: None,
            mode: None,
            size: work.as_ref().map_or(0, |b| b.len() as u64),
            text: result_text,
        },
        base,
        ours,
        theirs,
        textual,
        token: token(runner, repo, path)?,
        unmerged: stages.iter().any(Option::is_some),
    })
}

/// Writes through a sibling temp file and rename, keeping permissions.
fn write_atomic(repo: &RepoInfo, path: &RepoPath, bytes: &[u8]) -> Result<(), String> {
    let target = repo.root_path.join(path_arg(path.as_bytes())?);
    let parent = target.parent().ok_or(tr!("Invalid path"))?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| tr!("Cannot create a temporary file: {{e}}", e = e))?;
    temporary
        .write_all(bytes)
        .map_err(|e| tr!("Cannot write: {{e}}", e = e))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| tr!("Cannot write: {{e}}", e = e))?;
    if let Ok(meta) = fs::metadata(&target) {
        let _ = fs::set_permissions(temporary.path(), meta.permissions());
    }
    temporary
        .persist(&target)
        .map_err(|e| tr!("Cannot save the file: {{v1}}", v1 = e.error))?;
    Ok(())
}

pub fn save(
    runner: &GitRunner,
    repo: &RepoInfo,
    path: &RepoPath,
    expected: &str,
    content: &str,
) -> Result<String, String> {
    check_token(runner, repo, path, expected)?;
    if content.len() > MAX_TEXT_BYTES * 2 {
        return Err(tr!("The content is too large"));
    }
    write_atomic(repo, path, content.as_bytes())?;
    token(runner, repo, path)
}

pub fn has_markers(text: &str) -> bool {
    let mut open = false;
    for line in text.lines() {
        if line.starts_with("<<<<<<< ") || line == "<<<<<<<" {
            open = true;
        } else if open && (line.starts_with(">>>>>>> ") || line == ">>>>>>>") {
            return true;
        }
    }
    false
}

pub fn mark_resolved(
    runner: &GitRunner,
    repo: &RepoInfo,
    path: &RepoPath,
    expected: &str,
    allow_markers: bool,
) -> Result<Outcome, String> {
    check_token(runner, repo, path, expected)?;
    let work = work_bytes(repo, path)?;
    if let Some(text) = work.as_deref().and_then(as_text) {
        if has_markers(&text) && !allow_markers {
            return Err(tr!("The file still has conflict markers; resolve them first, or confirm that you want to keep them"));
        }
    }
    let mut invocation = Invocation::new(&repo.root_path, Access::Write, ["add", "-A", "--"]);
    invocation = invocation.arg(path_arg(path.as_bytes())?);
    runner.ok(invocation)?;
    Ok(Outcome {
        message: tr!("Marked {{v1}} as resolved", v1 = path.display()),
        recovery: None,
        conflicts: false,
    })
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    Ours,
    Theirs,
    Base,
    Delete,
    KeepWorkTree,
}

/// Whole-file decisions for binary, add/delete and rename conflicts.
pub fn resolve_with(
    runner: &GitRunner,
    repo: &RepoInfo,
    path: &RepoPath,
    expected: &str,
    choice: Choice,
    new_path: Option<&RepoPath>,
) -> Result<Outcome, String> {
    check_token(runner, repo, path, expected)?;
    let (_, stages) = stage_entries(runner, repo, path)?;
    let stage = match choice {
        Choice::Base => Some(&stages[0]),
        Choice::Ours => Some(&stages[1]),
        Choice::Theirs => Some(&stages[2]),
        _ => None,
    };
    let arg = path_arg(path.as_bytes())?;
    match (choice, stage) {
        (Choice::Delete, _) => {
            if let Some(file) = work_bytes(repo, path)?.map(|_| repo.root_path.join(&arg)) {
                fs::remove_file(file).map_err(|e| e.to_string())?;
            }
            runner.ok(Invocation::new(
                &repo.root_path,
                Access::Write,
                ["rm", "-q", "--cached", "--ignore-unmatch", "--"],
            )
            .arg(&arg))?;
            Ok(Outcome {
                message: tr!(
                    "Deleted {{v1}} and marked it as resolved",
                    v1 = path.display()
                ),
                recovery: None,
                conflicts: false,
            })
        }
        (Choice::KeepWorkTree, _) => {
            if work_bytes(repo, path)?.is_none() {
                return Err(tr!(
                    "The working tree does not have this file; choose another version or delete it"
                ));
            }
            runner.ok(Invocation::new(&repo.root_path, Access::Write, ["add", "--"]).arg(&arg))?;
            Ok(Outcome {
                message: tr!(
                    "Kept the working tree version of {{v1}}",
                    v1 = path.display()
                ),
                recovery: None,
                conflicts: false,
            })
        }
        (_, Some(Some((mode, oid)))) => {
            let bytes = blob(runner, repo, oid)?;
            let target = new_path.unwrap_or(path);
            if let Some(new_path) = new_path {
                new_path.validate()?;
                if work_bytes(repo, new_path)?.is_some() {
                    return Err(tr!(
                        "{{v1}} already exists and was not overwritten",
                        v1 = new_path.display()
                    ));
                }
            }
            write_atomic(repo, target, &bytes)?;
            #[cfg(unix)]
            if mode == "100755" {
                use std::os::unix::fs::PermissionsExt;
                let file = repo.root_path.join(path_arg(target.as_bytes())?);
                let _ = fs::set_permissions(file, fs::Permissions::from_mode(0o755));
            }
            #[cfg(not(unix))]
            let _ = mode;
            if new_path.is_some() {
                if work_bytes(repo, path)?.is_some() {
                    fs::remove_file(repo.root_path.join(&arg)).map_err(|e| e.to_string())?;
                }
                runner.ok(Invocation::new(
                    &repo.root_path,
                    Access::Write,
                    ["rm", "-q", "--cached", "--ignore-unmatch", "--"],
                )
                .arg(&arg))?;
            }
            runner.ok(
                Invocation::new(&repo.root_path, Access::Write, ["add", "--"])
                    .arg(path_arg(target.as_bytes())?),
            )?;
            Ok(Outcome {
                message: tr!(
                    "Used the chosen version and marked {{v1}} as resolved",
                    v1 = target.display()
                ),
                recovery: None,
                conflicts: false,
            })
        }
        _ => Err(tr!("This conflict does not have the chosen version")),
    }
}

/// `refs/heads/x` → `x`, `refs/remotes/o/x` → `o/x` for messages.
fn display_rev(rev: &str) -> &str {
    rev.strip_prefix("refs/heads/")
        .or_else(|| rev.strip_prefix("refs/remotes/"))
        .unwrap_or(rev)
}

pub fn merge(
    runner: &GitRunner,
    repo: &RepoInfo,
    rev: &str,
    no_ff: bool,
    expected_head: &str,
) -> Result<Outcome, String> {
    if let Some(operation) = status::operation(repo) {
        return Err(tr!(
            "A {{operation}} operation is in progress",
            operation = format!("{operation:?}")
        ));
    }
    if super::remote::head(runner, repo)?.as_deref() != Some(expected_head) {
        return Err(tr!(
            "HEAD changed after you confirmed, so nothing was merged"
        ));
    }
    if status::status(runner, repo)?
        .entries
        .iter()
        .any(|e| !e.untracked)
    {
        return Err(tr!("The working tree has uncommitted changes; commit or stash them first so an abort can restore everything"));
    }
    let target = resolve_commit(runner, repo, rev)?;
    let mut args = vec!["merge".to_owned(), "--no-edit".into()];
    if no_ff {
        args.push("--no-ff".into());
    }
    args.push(target.clone());
    let output = runner
        .run(
            Invocation::new(&repo.root_path, Access::Write, args)
                .env("GIT_EDITOR", "true")
                .timeout(Duration::from_secs(600)),
        )
        .map_err(String::from)?;
    if output.success() {
        return Ok(Outcome {
            message: tr!("Merged {{v1}}", v1 = display_rev(rev)),
            recovery: None,
            conflicts: false,
        });
    }
    if status::operation(repo) == Some(Operation::Merge) {
        return Ok(Outcome {
            message: tr!("Merging {{v1}} caused conflicts; resolve them one by one in the Git panel, then continue, or abort", v1 = display_rev(rev)),
            recovery: None,
            conflicts: true,
        });
    }
    Err(GitError::from_output(&output).to_string())
}

fn operation_args(operation: Operation, action: &str) -> Vec<String> {
    let command = match operation {
        Operation::Merge => "merge",
        Operation::Rebase => "rebase",
        Operation::Am => "am",
        Operation::CherryPick => "cherry-pick",
        Operation::Revert => "revert",
        Operation::Bisect => "bisect",
    };
    vec![command.into(), format!("--{action}")]
}

pub fn continue_operation(runner: &GitRunner, repo: &RepoInfo) -> Result<Outcome, String> {
    let operation = status::operation(repo).ok_or(tr!("No operation is in progress"))?;
    if operation == Operation::Bisect {
        return Err(tr!("Bisect does not support continue"));
    }
    let state = status::status(runner, repo)?;
    if state.entries.iter().any(|e| e.conflict.is_some()) {
        return Err(tr!("There are still unresolved conflicted files"));
    }
    let args = if operation == Operation::Merge {
        // Uses MERGE_MSG; hooks and signing run as usual.
        vec!["commit".to_owned(), "--no-edit".into()]
    } else {
        operation_args(operation, "continue")
    };
    let output = runner
        .run(
            Invocation::new(&repo.root_path, Access::Write, args)
                .env("GIT_EDITOR", "true")
                .timeout(Duration::from_secs(600)),
        )
        .map_err(String::from)?;
    if output.success() {
        return Ok(Outcome {
            message: tr!("Done; continuing"),
            recovery: None,
            conflicts: false,
        });
    }
    if status::operation(repo).is_some()
        && status::status(runner, repo)?
            .entries
            .iter()
            .any(|e| e.conflict.is_some())
    {
        return Ok(Outcome {
            message: tr!("The next commit has conflicts too; keep resolving"),
            recovery: None,
            conflicts: true,
        });
    }
    Err(GitError::from_output(&output).to_string())
}

pub fn abort_operation(
    store: &Store,
    runner: &GitRunner,
    repo: &RepoInfo,
) -> Result<Outcome, String> {
    let operation = status::operation(repo).ok_or(tr!("No operation is in progress"))?;
    let action = if operation == Operation::Bisect {
        "reset"
    } else {
        "abort"
    };
    // Keep resolutions made so far recoverable. An unmerged index cannot be
    // stashed, so copy the changed work-tree files instead.
    let changed: Vec<RepoPath> = status::status(runner, repo)?
        .entries
        .into_iter()
        .filter(|e| !e.untracked && !e.submodule)
        .map(|e| e.path)
        .collect();
    let label = tr!(
        "Before aborting {{operation}}",
        operation = format!("{operation:?}")
    );
    let mut point = match store.create(runner, repo, &label, Capture::Tracked) {
        Ok(point) => point,
        Err(_) => store.create(runner, repo, &label, Capture::WorkFiles(&changed))?,
    };
    let args = if operation == Operation::Bisect {
        vec!["bisect".to_owned(), "reset".into()]
    } else {
        operation_args(operation, action)
    };
    let output = runner
        .run(
            Invocation::new(&repo.root_path, Access::Write, args).timeout(Duration::from_secs(300)),
        )
        .map_err(String::from)?;
    if !output.success() {
        return Err(GitError::from_output(&output).to_string());
    }
    store.mark_after(runner, repo, &mut point)?;
    Ok(Outcome {
        message: tr!(
            "Aborted {{operation}} and returned to the earlier state",
            operation = format!("{operation:?}")
        ),
        recovery: Some(point),
        conflicts: false,
    })
}

#[cfg(test)]
mod tests {
    use super::has_markers;

    #[test]
    fn detects_complete_conflict_blocks_only() {
        assert!(has_markers(
            "a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> topic\nb\n"
        ));
        assert!(!has_markers("<<<<<<< not closed\n"));
        assert!(!has_markers("a <<<<<<< inline\n>>>>>>> inline"));
    }
}
