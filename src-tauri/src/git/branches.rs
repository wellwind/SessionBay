//! Branches, stashes, reset, revert, discard and tags.
//!
//! Destructive requests carry the object the user confirmed (expected HEAD
//! or ref value); a mismatch stops the operation before any write, and a
//! recovery point is created first or the operation does not run.
use super::{
    diff::resolve_commit,
    discovery::RepoInfo,
    path::RepoPath,
    recovery::{Capture, RecoveryPoint, SavedRef, Store},
    refs,
    remote::{self, check_ref_name, remote_exists},
    runner::{path_arg, Access, GitError, GitRunner, Invocation},
    status::{self, Operation},
};
use crate::tr;
use serde::{Deserialize, Serialize};
use std::time::Duration;

fn ok(runner: &GitRunner, repo: &RepoInfo, args: Vec<String>) -> Result<String, String> {
    run_with(runner, repo, args, &[])
}

fn run_with(
    runner: &GitRunner,
    repo: &RepoInfo,
    args: Vec<String>,
    env: &[(&str, &str)],
) -> Result<String, String> {
    let mut invocation = Invocation::new(&repo.root_path, Access::Write, args)
        .env("GIT_EDITOR", "true")
        .timeout(Duration::from_secs(300));
    for (key, value) in env {
        invocation = invocation.env(key, value);
    }
    let output = runner.run(invocation).map_err(String::from)?;
    if !output.success() {
        let mut message = GitError::from_output(&output).to_string();
        let stdout = output.stdout_text();
        if !stdout.trim().is_empty() {
            message.push('\n');
            message.push_str(&super::runner::sanitize_message(stdout.trim()));
        }
        return Err(message);
    }
    Ok(super::runner::sanitize_message(
        format!(
            "{}\n{}",
            output.stdout_text().trim(),
            output.stderr_text().trim()
        )
        .trim(),
    ))
}

fn rev_oid(runner: &GitRunner, repo: &RepoInfo, name: &str) -> Result<Option<String>, String> {
    let output = runner
        .run(Invocation::new(
            &repo.root_path,
            Access::Read,
            ["rev-parse", "--verify", "--quiet", "--end-of-options", name],
        ))
        .map_err(String::from)?;
    Ok(output
        .success()
        .then(|| output.stdout_text().trim().to_owned()))
}

fn expect_head(runner: &GitRunner, repo: &RepoInfo, expected: &str) -> Result<String, String> {
    let head = remote::head(runner, repo)?.ok_or(tr!("There are no commits yet"))?;
    if head != expected {
        return Err(tr!(
            "HEAD changed after you confirmed, so nothing was done; review again"
        ));
    }
    Ok(head)
}

fn no_operation(repo: &RepoInfo) -> Result<(), String> {
    if let Some(operation) = status::operation(repo) {
        return Err(tr!(
            "A {{operation}} operation is in progress; finish or abort it first",
            operation = format!("{operation:?}")
        ));
    }
    Ok(())
}

fn tracked_dirty(runner: &GitRunner, repo: &RepoInfo) -> Result<bool, String> {
    Ok(status::status(runner, repo)?
        .entries
        .iter()
        .any(|e| !e.untracked))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub message: String,
    pub recovery: Option<RecoveryPoint>,
    /// The operation stopped with conflicts the user must resolve.
    pub conflicts: bool,
}

impl Outcome {
    pub(crate) fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            recovery: None,
            conflicts: false,
        }
    }
}

pub fn create_branch(
    runner: &GitRunner,
    repo: &RepoInfo,
    name: &str,
    start: Option<&str>,
    switch: bool,
) -> Result<Outcome, String> {
    check_ref_name(runner, repo, name, &crate::tr!("branch"))?;
    if rev_oid(runner, repo, &format!("refs/heads/{name}"))?.is_some() {
        return Err(tr!("Branch {{name}} already exists", name = name));
    }
    let start = match start {
        Some(rev) => resolve_commit(runner, repo, rev)?,
        None => remote::head(runner, repo)?.ok_or(tr!(
            "There are no commits yet, so a branch cannot be created"
        ))?,
    };
    ok(
        runner,
        repo,
        vec![
            "branch".into(),
            "--no-track".into(),
            name.into(),
            start.clone(),
        ],
    )?;
    if switch {
        switch_branch(runner, repo, name)?;
        return Ok(Outcome::plain(tr!(
            "Created and switched to {{name}} (from {{v1}})",
            name = name,
            v1 = &start[..7]
        )));
    }
    Ok(Outcome::plain(tr!(
        "Created branch {{name}} (from {{v1}})",
        name = name,
        v1 = &start[..7]
    )))
}

/// Switches only when nothing would be carried over or overwritten.
pub fn switch_branch(runner: &GitRunner, repo: &RepoInfo, name: &str) -> Result<Outcome, String> {
    no_operation(repo)?;
    if tracked_dirty(runner, repo)? {
        return Err(tr!("The working tree has uncommitted changes; commit or stash them before switching branches"));
    }
    let all = refs::refs(runner, repo)?;
    if let Some(local) = all.branches.iter().find(|b| !b.remote && b.name == name) {
        if let Some(path) = &local.worktree {
            return Err(tr!(
                "Branch {{name}} is already used by another worktree: {{path}}",
                name = name,
                path = path
            ));
        }
        ok(
            runner,
            repo,
            vec!["switch".into(), "--no-guess".into(), name.into()],
        )?;
        return Ok(Outcome::plain(tr!("Switched to {{name}}", name = name)));
    }
    if let Some(remote_branch) = all.branches.iter().find(|b| b.remote && b.name == name) {
        let local = remote_branch
            .name
            .split_once('/')
            .map(|(_, rest)| rest)
            .unwrap_or(name);
        check_ref_name(runner, repo, local, &crate::tr!("branch"))?;
        if all.branches.iter().any(|b| !b.remote && b.name == local) {
            return Err(tr!(
                "{{local}} already exists locally; switch to the local branch instead",
                local = local
            ));
        }
        ok(
            runner,
            repo,
            vec![
                "switch".into(),
                "-c".into(),
                local.into(),
                "--track".into(),
                remote_branch.full_name.clone(),
            ],
        )?;
        return Ok(Outcome::plain(tr!(
            "Created local branch {{name}} tracking {{local}} and switched to it",
            name = name,
            local = local
        )));
    }
    Err(tr!("Branch not found: {{name}}", name = name))
}

pub fn delete_branch(
    store: &Store,
    runner: &GitRunner,
    repo: &RepoInfo,
    name: &str,
    expected: &str,
    force: bool,
) -> Result<Outcome, String> {
    check_ref_name(runner, repo, name, &crate::tr!("branch"))?;
    let full = format!("refs/heads/{name}");
    let oid = rev_oid(runner, repo, &full)?
        .ok_or_else(|| tr!("Branch not found: {{name}}", name = name))?;
    if oid != expected {
        return Err(tr!(
            "The branch changed after you confirmed, so it was not deleted"
        ));
    }
    let all = refs::refs(runner, repo)?;
    let branch = all
        .branches
        .iter()
        .find(|b| !b.remote && b.name == name)
        .ok_or(tr!("Branch not found"))?;
    if branch.current {
        return Err(tr!("The current branch cannot be deleted"));
    }
    if let Some(path) = &branch.worktree {
        return Err(tr!(
            "Branch {{name}} is in use by another worktree: {{path}}",
            name = name,
            path = path
        ));
    }
    let mut point = store.create(
        runner,
        repo,
        &tr!("Delete branch {{name}}", name = name),
        Capture::Refs(vec![SavedRef {
            name: full,
            oid: oid.clone(),
            stash_message: None,
        }]),
    )?;
    ok(
        runner,
        repo,
        vec![
            "branch".into(),
            if force { "-D" } else { "-d" }.into(),
            name.into(),
        ],
    )
    .map_err(|e| {
        if force {
            e
        } else {
            tr!(
                "{{e}}\n(an unmerged branch needs an explicit force delete)",
                e = e
            )
        }
    })?;
    store.mark_after(runner, repo, &mut point)?;
    Ok(Outcome {
        message: tr!(
            "Deleted branch {{name}} ({{v1}})",
            name = name,
            v1 = &oid[..7]
        ),
        recovery: Some(point),
        conflicts: false,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: usize,
    pub oid: String,
    pub message: String,
    pub created_at: i64,
}

pub fn stashes(runner: &GitRunner, repo: &RepoInfo) -> Result<Vec<StashEntry>, String> {
    let output = runner.ok(Invocation::new(
        &repo.root_path,
        Access::Read,
        ["stash", "list", "-z", "--format=%H%x00%gs%x00%ct"],
    ))?;
    let fields: Vec<String> = output
        .stdout
        .split(|b| *b == 0)
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect();
    Ok(fields
        .chunks(3)
        .filter(|chunk| chunk.len() == 3 && !chunk[0].is_empty())
        .enumerate()
        .map(|(index, chunk)| StashEntry {
            index,
            oid: chunk[0].trim_start_matches('\n').to_owned(),
            message: chunk[1].clone(),
            created_at: chunk[2].parse().unwrap_or(0),
        })
        .collect())
}

fn stash_at(
    runner: &GitRunner,
    repo: &RepoInfo,
    index: usize,
    expected: &str,
) -> Result<StashEntry, String> {
    let entry = stashes(runner, repo)?
        .into_iter()
        .find(|s| s.index == index)
        .ok_or(tr!("Stash not found"))?;
    if entry.oid != expected {
        return Err(tr!(
            "The stash list changed after you confirmed, so nothing was done"
        ));
    }
    Ok(entry)
}

pub fn stash_push(
    runner: &GitRunner,
    repo: &RepoInfo,
    message: &str,
    include_untracked: bool,
    keep_index: bool,
) -> Result<Outcome, String> {
    if message.contains('\0') || message.len() > 1000 {
        return Err(tr!("Invalid stash message"));
    }
    let mut args = vec!["stash".to_owned(), "push".into()];
    if include_untracked {
        args.push("--include-untracked".into());
    }
    if keep_index {
        args.push("--keep-index".into());
    }
    if !message.trim().is_empty() {
        args.extend(["-m".into(), message.trim().into()]);
    }
    // `stash -u` cleans untracked files through an internal `:/` pathspec,
    // which literal pathspecs would leave behind (saved *and* still present).
    // No user path is passed here, so magic pathspecs are safe.
    let output = run_with(runner, repo, args, &[("GIT_LITERAL_PATHSPECS", "0")])?;
    if output.contains("No local changes to save") {
        return Err(tr!("There are no changes to stash"));
    }
    Ok(Outcome::plain(tr!("Created a stash")))
}

pub fn stash_apply(
    runner: &GitRunner,
    repo: &RepoInfo,
    index: usize,
    expected: &str,
    pop: bool,
    restore_index: bool,
) -> Result<Outcome, String> {
    no_operation(repo)?;
    let entry = stash_at(runner, repo, index, expected)?;
    let mut args = vec!["stash".to_owned(), if pop { "pop" } else { "apply" }.into()];
    if restore_index {
        args.push("--index".into());
    }
    args.push(format!("stash@{{{}}}", entry.index));
    match ok(runner, repo, args) {
        Ok(_) => Ok(Outcome::plain(if pop {
            tr!("Applied and removed the stash")
        } else {
            tr!("Applied the stash (kept it)")
        })),
        Err(error) => {
            let conflicts = status::status(runner, repo)?
                .entries
                .iter()
                .any(|e| e.conflict.is_some());
            if conflicts {
                Ok(Outcome {
                    message: tr!("Applying the stash caused conflicts; {{v1}}resolve them, then drop it manually", v1 = if pop { tr!("the stash is kept; ") } else { String::new() }),
                    recovery: None,
                    conflicts: true,
                })
            } else {
                Err(error)
            }
        }
    }
}

pub fn stash_drop(
    store: &Store,
    runner: &GitRunner,
    repo: &RepoInfo,
    index: usize,
    expected: &str,
) -> Result<Outcome, String> {
    let entry = stash_at(runner, repo, index, expected)?;
    let point = store.create(
        runner,
        repo,
        &tr!("Delete stash@{{{index}}}", index = index),
        Capture::Refs(vec![SavedRef {
            name: format!("stash@{{{index}}}"),
            oid: entry.oid.clone(),
            stash_message: Some(entry.message.clone()),
        }]),
    )?;
    ok(
        runner,
        repo,
        vec![
            "stash".into(),
            "drop".into(),
            "-q".into(),
            format!("stash@{{{index}}}"),
        ],
    )?;
    Ok(Outcome {
        message: tr!("Deleted stash: {{v1}}", v1 = entry.message),
        recovery: Some(point),
        conflicts: false,
    })
}

pub fn stash_clear(
    store: &Store,
    runner: &GitRunner,
    repo: &RepoInfo,
    expected: &[String],
) -> Result<Outcome, String> {
    let entries = stashes(runner, repo)?;
    if entries.iter().map(|e| &e.oid).ne(expected.iter()) {
        return Err(tr!(
            "The stash list changed after you confirmed, so nothing was cleared"
        ));
    }
    let saved = entries
        .iter()
        .rev()
        .map(|e| SavedRef {
            name: format!("stash@{{{}}}", e.index),
            oid: e.oid.clone(),
            stash_message: Some(e.message.clone()),
        })
        .collect();
    let point = store.create(
        runner,
        repo,
        &tr!("Clear all stashes"),
        Capture::Refs(saved),
    )?;
    ok(runner, repo, vec!["stash".into(), "clear".into()])?;
    Ok(Outcome {
        message: tr!("Cleared {{v1}} stashes", v1 = entries.len()),
        recovery: Some(point),
        conflicts: false,
    })
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

pub fn reset(
    store: &Store,
    runner: &GitRunner,
    repo: &RepoInfo,
    target: &str,
    mode: ResetMode,
    expected_head: &str,
) -> Result<Outcome, String> {
    no_operation(repo)?;
    expect_head(runner, repo, expected_head)?;
    let target = resolve_commit(runner, repo, target)?;
    let label = match mode {
        ResetMode::Soft => "soft",
        ResetMode::Mixed => "mixed",
        ResetMode::Hard => "hard",
    };
    let mut point = store.create(
        runner,
        repo,
        &tr!(
            "reset --{{label}} to {{v1}}",
            label = label,
            v1 = &target[..7]
        ),
        Capture::Tracked,
    )?;
    ok(
        runner,
        repo,
        vec![
            "reset".into(),
            format!("--{label}"),
            "-q".into(),
            target.clone(),
        ],
    )?;
    store.mark_after(runner, repo, &mut point)?;
    Ok(Outcome {
        message: tr!(
            "Ran reset --{{label}} to {{v1}}",
            label = label,
            v1 = &target[..7]
        ),
        recovery: Some(point),
        conflicts: false,
    })
}

pub fn revert(
    runner: &GitRunner,
    repo: &RepoInfo,
    commit: &str,
    parent: Option<u32>,
    expected_head: &str,
) -> Result<Outcome, String> {
    no_operation(repo)?;
    expect_head(runner, repo, expected_head)?;
    if tracked_dirty(runner, repo)? {
        return Err(tr!(
            "The working tree has uncommitted changes; commit or stash them before reverting"
        ));
    }
    let commit = resolve_commit(runner, repo, commit)?;
    let parents = super::diff::commit_parents(runner, repo, &commit)?;
    let mut args = vec!["revert".to_owned(), "--no-edit".into()];
    match (parents.len(), parent) {
        (count, Some(n)) if count > 1 && n >= 1 && n as usize <= count => {
            args.extend(["-m".into(), n.to_string()])
        }
        (count, None) if count > 1 => {
            return Err(tr!(
                "Reverting a merge commit needs an explicit mainline parent"
            ))
        }
        (_, Some(_)) => return Err(tr!("Only merge commits need a parent")),
        _ => {}
    }
    args.push(commit.clone());
    match ok(runner, repo, args) {
        Ok(_) => Ok(Outcome::plain(tr!(
            "Created a revert commit (reversing {{v1}})",
            v1 = &commit[..7]
        ))),
        Err(error) if status::operation(repo) == Some(Operation::Revert) => Ok(Outcome {
            message: tr!(
                "The revert caused conflicts; resolve them, then continue or abort: {{error}}",
                error = error
            ),
            recovery: None,
            conflicts: true,
        }),
        Err(error) => Err(error),
    }
}

/// Discards work-tree changes of tracked files and deletes untracked ones,
/// after backing both up.
pub fn discard(
    store: &Store,
    runner: &GitRunner,
    repo: &RepoInfo,
    paths: &[RepoPath],
    untracked: &[RepoPath],
) -> Result<Outcome, String> {
    if paths.is_empty() && untracked.is_empty() {
        return Err(tr!("No files selected"));
    }
    let state = status::status(runner, repo)?;
    for path in untracked {
        if !state.entries.iter().any(|e| e.untracked && &e.path == path) {
            return Err(tr!(
                "{{v1}} is no longer untracked, so nothing was done",
                v1 = path.display()
            ));
        }
    }
    let mut point = store.create(
        runner,
        repo,
        &tr!("Discard working tree changes"),
        Capture::TrackedAndUntracked(untracked),
    )?;
    if !paths.is_empty() {
        let mut invocation = Invocation::new(
            &repo.root_path,
            Access::Write,
            ["restore", "--worktree", "--"],
        );
        for path in paths {
            invocation = invocation.arg(path_arg(path.as_bytes())?);
        }
        runner.ok(invocation)?;
    }
    for path in untracked {
        std::fs::remove_file(repo.root_path.join(path_arg(path.as_bytes())?))
            .map_err(|e| tr!("Cannot delete {{v1}}: {{e}}", v1 = path.display(), e = e))?;
    }
    store.mark_after(runner, repo, &mut point)?;
    Ok(Outcome {
        message: tr!(
            "Discarded changes to {{v1}} files",
            v1 = paths.len() + untracked.len()
        ),
        recovery: Some(point),
        conflicts: false,
    })
}

pub fn create_tag(
    runner: &GitRunner,
    repo: &RepoInfo,
    name: &str,
    target: Option<&str>,
    message: Option<&str>,
    sign: bool,
) -> Result<Outcome, String> {
    check_ref_name(runner, repo, name, &crate::tr!("tag"))?;
    if rev_oid(runner, repo, &format!("refs/tags/{name}"))?.is_some() {
        return Err(tr!(
            "Tag {{name}} already exists; delete it explicitly before moving it",
            name = name
        ));
    }
    let target = match target {
        Some(rev) => resolve_commit(runner, repo, rev)?,
        None => remote::head(runner, repo)?.ok_or(tr!("There are no commits yet"))?,
    };
    let mut args = vec!["tag".to_owned()];
    match message.map(str::trim).filter(|m| !m.is_empty()) {
        Some(message) => {
            if message.contains('\0') || message.len() > 64 * 1024 {
                return Err(tr!("Invalid tag message"));
            }
            args.push(if sign { "-s" } else { "-a" }.into());
            args.extend(["-m".into(), message.into()]);
        }
        None if sign => return Err(tr!("A signed tag needs a message")),
        None => {}
    }
    args.extend(["--".into(), name.into(), target.clone()]);
    ok(runner, repo, args)?;
    Ok(Outcome::plain(tr!(
        "Created tag {{name}} → {{v1}}",
        name = name,
        v1 = &target[..7]
    )))
}

pub fn delete_tag(
    store: &Store,
    runner: &GitRunner,
    repo: &RepoInfo,
    name: &str,
    expected: &str,
) -> Result<Outcome, String> {
    check_ref_name(runner, repo, name, &crate::tr!("tag"))?;
    let full = format!("refs/tags/{name}");
    let oid =
        rev_oid(runner, repo, &full)?.ok_or_else(|| tr!("Tag not found: {{name}}", name = name))?;
    if oid != expected {
        return Err(tr!(
            "The tag changed after you confirmed, so it was not deleted"
        ));
    }
    let mut point = store.create(
        runner,
        repo,
        &tr!("Delete local tag {{name}}", name = name),
        Capture::Refs(vec![SavedRef {
            name: full.clone(),
            oid,
            stash_message: None,
        }]),
    )?;
    // Delete only if the ref still holds the confirmed object.
    ok(
        runner,
        repo,
        vec!["update-ref".into(), "-d".into(), full, expected.into()],
    )?;
    store.mark_after(runner, repo, &mut point)?;
    Ok(Outcome {
        message: tr!(
            "Deleted local tag {{name}}; the remote tag is unchanged",
            name = name
        ),
        recovery: Some(point),
        conflicts: false,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTag {
    pub name: String,
    pub oid: String,
}

pub fn remote_tags(
    runner: &GitRunner,
    repo: &RepoInfo,
    remote_name: &str,
) -> Result<Vec<RemoteTag>, String> {
    remote_exists(runner, repo, remote_name)?;
    let output = runner
        .run(
            Invocation::new(
                &repo.root_path,
                Access::Read,
                ["ls-remote", "--tags", "--refs", "--", remote_name],
            )
            .timeout(remote::NETWORK_TIMEOUT),
        )
        .map_err(String::from)?;
    if !output.success() {
        return Err(GitError::from_output(&output).to_string());
    }
    Ok(output
        .stdout_text()
        .lines()
        .filter_map(|line| {
            let (oid, name) = line.split_once('\t')?;
            Some(RemoteTag {
                name: name.strip_prefix("refs/tags/")?.to_owned(),
                oid: oid.to_owned(),
            })
        })
        .collect())
}

/// Pushes exactly one tag; replacing a different remote tag needs `force`.
pub fn push_tag(
    runner: &GitRunner,
    repo: &RepoInfo,
    remote_name: &str,
    name: &str,
    force: bool,
) -> Result<Outcome, String> {
    remote_exists(runner, repo, remote_name)?;
    check_ref_name(runner, repo, name, &crate::tr!("tag"))?;
    let full = format!("refs/tags/{name}");
    rev_oid(runner, repo, &full)?.ok_or_else(|| tr!("Tag not found: {{name}}", name = name))?;
    let refspec = format!("{}{full}:{full}", if force { "+" } else { "" });
    ok(
        runner,
        repo,
        vec![
            "push".into(),
            "--no-follow-tags".into(),
            "--porcelain".into(),
            "--".into(),
            remote_name.into(),
            refspec,
        ],
    )?;
    Ok(Outcome::plain(tr!(
        "Pushed tag {{name}} to {{remote_name}}",
        name = name,
        remote_name = remote_name
    )))
}

pub fn delete_remote_tag(
    runner: &GitRunner,
    repo: &RepoInfo,
    remote_name: &str,
    name: &str,
    expected: &str,
) -> Result<Outcome, String> {
    remote_exists(runner, repo, remote_name)?;
    check_ref_name(runner, repo, name, &crate::tr!("tag"))?;
    let current = remote_tags(runner, repo, remote_name)?;
    let tag = current.iter().find(|t| t.name == name).ok_or_else(|| {
        tr!(
            "There is no tag {{remote_name}} on {{name}}",
            remote_name = remote_name,
            name = name
        )
    })?;
    if tag.oid != expected {
        return Err(tr!(
            "The remote tag changed after you confirmed, so it was not deleted"
        ));
    }
    let full = format!("refs/tags/{name}");
    ok(
        runner,
        repo,
        vec![
            "push".into(),
            "--no-follow-tags".into(),
            "--porcelain".into(),
            format!("--force-with-lease={full}:{expected}"),
            "--".into(),
            remote_name.into(),
            format!(":{full}"),
        ],
    )?;
    Ok(Outcome::plain(tr!(
        "Deleted tag {{remote_name}} on {{name}}; the local tag is unchanged",
        remote_name = remote_name,
        name = name
    )))
}
