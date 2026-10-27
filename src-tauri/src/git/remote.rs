//! Commit, fetch, pull and push with Git's own hooks, signing and helpers.
//!
//! Nothing here retries a network write: a failure is reported as is, and
//! success is confirmed from refreshed refs rather than assumed.
use super::{
    diff::{self, ChangedFile, DiffSource},
    discovery::RepoInfo,
    runner::{Access, GitError, GitErrorKind, GitRunner, Invocation},
    status::{self, Operation},
};
use crate::tr;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);
pub const HOOK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitPreview {
    pub repo_id: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub files: Vec<ChangedFile>,
    pub truncated: bool,
    /// Identifies the exact index the user reviewed.
    pub token: String,
    pub hooks: Vec<String>,
    pub signing: Option<String>,
    pub author: Option<String>,
    pub operation: Option<Operation>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub oid: String,
    pub summary: String,
    pub output: String,
}

fn config(runner: &GitRunner, repo: &RepoInfo, args: &[&str]) -> Option<String> {
    let output = runner
        .run(Invocation::new(&repo.root_path, Access::Read, ["config"]).args(args))
        .ok()?;
    output
        .success()
        .then(|| output.stdout_text().trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub fn head(runner: &GitRunner, repo: &RepoInfo) -> Result<Option<String>, GitError> {
    let output = runner.run(Invocation::new(
        &repo.root_path,
        Access::Read,
        ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    ))?;
    Ok(output
        .success()
        .then(|| output.stdout_text().trim().to_owned()))
}

pub fn index_token(runner: &GitRunner, repo: &RepoInfo) -> Result<String, GitError> {
    let stage =
        runner.ok(
            Invocation::new(&repo.root_path, Access::Read, ["ls-files", "--stage", "-z"])
                .limit(256 * 1024 * 1024),
        )?;
    let mut hasher = Sha256::new();
    hasher.update(head(runner, repo)?.unwrap_or_default().as_bytes());
    hasher.update([0]);
    hasher.update(&stage.stdout);
    Ok(hasher.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Hooks that will run for `kind`, listed so failures are not a surprise.
pub fn hooks(runner: &GitRunner, repo: &RepoInfo, names: &[&str]) -> Vec<String> {
    let directory = config(runner, repo, &["--path", "core.hooksPath"])
        .map(|path| {
            let path = std::path::PathBuf::from(path);
            if path.is_absolute() {
                path
            } else {
                repo.root_path.join(path)
            }
        })
        .unwrap_or_else(|| repo.common_dir_path.join("hooks"));
    names
        .iter()
        .filter(|name| {
            let path = directory.join(name);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                path.metadata()
                    .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                    .unwrap_or(false)
            }
            #[cfg(not(unix))]
            {
                path.is_file()
            }
        })
        .map(|name| name.to_string())
        .collect()
}

pub fn commit_preview(runner: &GitRunner, repo: &RepoInfo) -> Result<CommitPreview, GitError> {
    let state = status::status(runner, repo)?;
    let (files, truncated) = diff::changed_files(runner, repo, &DiffSource::Staged)?;
    let signing = (config(runner, repo, &["--bool", "commit.gpgsign"]).as_deref() == Some("true"))
        .then(|| config(runner, repo, &["gpg.format"]).unwrap_or_else(|| "openpgp".into()));
    let author = runner
        .run(Invocation::new(
            &repo.root_path,
            Access::Read,
            ["var", "GIT_AUTHOR_IDENT"],
        ))
        .ok()
        .filter(|o| o.success())
        .map(|o| {
            // Drop the trailing timestamp and zone.
            let text = o.stdout_text();
            text.rsplitn(3, ' ')
                .nth(2)
                .unwrap_or(text.trim())
                .to_owned()
        });
    Ok(CommitPreview {
        repo_id: repo.id.clone(),
        branch: state.branch.head.clone(),
        head: state.branch.oid.clone(),
        files,
        truncated,
        token: index_token(runner, repo)?,
        hooks: hooks(
            runner,
            repo,
            &[
                "pre-commit",
                "prepare-commit-msg",
                "commit-msg",
                "post-commit",
            ],
        ),
        signing,
        author,
        operation: state.operation,
    })
}

pub fn commit(
    runner: &GitRunner,
    repo: &RepoInfo,
    message: &str,
    token: &str,
    cancel: Arc<AtomicBool>,
) -> Result<CommitResult, String> {
    if message.trim().is_empty() {
        return Err(tr!("The commit message cannot be empty"));
    }
    if message.len() > 64 * 1024 || message.contains('\0') {
        return Err(tr!(
            "The commit message is too long or has invalid characters"
        ));
    }
    if index_token(runner, repo)? != token {
        return Err(
            tr!("The index changed after the preview (perhaps an agent or another Git operation), so no commit was created; review the preview again"),
        );
    }
    let (files, _) = diff::changed_files(runner, repo, &DiffSource::Staged)?;
    let merging = matches!(status::operation(repo), Some(Operation::Merge));
    if files.is_empty() && !merging {
        return Err(tr!("No staged changes"));
    }
    // -F - keeps the message out of argv; no -a, no paths, no --no-verify:
    // exactly the index is committed and the user's hooks and signing run.
    let output = runner
        .run(
            Invocation::new(&repo.root_path, Access::Write, ["commit", "-F", "-"])
                .stdin(message.as_bytes().to_vec())
                .env("GIT_EDITOR", "true")
                .timeout(HOOK_TIMEOUT)
                .cancel(cancel),
        )
        .map_err(String::from)?;
    if !output.success() {
        let error = GitError::from_output(&output);
        let mut text = error.to_string();
        let stdout = output.stdout_text();
        if !stdout.trim().is_empty() {
            text.push('\n');
            text.push_str(&super::runner::sanitize_message(stdout.trim()));
        }
        return Err(text);
    }
    let oid = head(runner, repo)?.ok_or(tr!("HEAD is missing after the commit"))?;
    let summary = runner
        .ok(Invocation::new(
            &repo.root_path,
            Access::Read,
            ["log", "-1", "--format=%s", &oid],
        ))?
        .stdout_text()
        .trim()
        .to_owned();
    Ok(CommitResult {
        oid,
        summary,
        output: super::runner::sanitize_message(output.stdout_text().trim()),
    })
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PullStrategy {
    Merge,
    Rebase,
    FastForwardOnly,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushPlan {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream_remote: Option<String>,
    pub upstream_branch: Option<String>,
    pub push_remote: Option<String>,
    pub remotes: Vec<String>,
    pub ahead: u32,
    pub behind: u32,
    pub hooks: Vec<String>,
    /// `push.followTags` is set; Session Bay still passes --no-follow-tags.
    pub follow_tags_configured: bool,
    pub pull_rebase_configured: Option<String>,
}

pub fn push_plan(runner: &GitRunner, repo: &RepoInfo) -> Result<PushPlan, GitError> {
    let state = status::status(runner, repo)?;
    let remotes: Vec<String> = runner
        .ok(Invocation::new(&repo.root_path, Access::Read, ["remote"]))?
        .stdout_text()
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    let branch = state.branch.head.clone();
    let (upstream_remote, upstream_branch) = match &branch {
        Some(name) => (
            config(runner, repo, &[&format!("branch.{name}.remote")]),
            config(runner, repo, &[&format!("branch.{name}.merge")]).map(|merge| {
                merge
                    .strip_prefix("refs/heads/")
                    .unwrap_or(&merge)
                    .to_owned()
            }),
        ),
        None => (None, None),
    };
    let push_remote = branch
        .as_ref()
        .and_then(|name| config(runner, repo, &[&format!("branch.{name}.pushRemote")]))
        .or_else(|| config(runner, repo, &["remote.pushDefault"]));
    Ok(PushPlan {
        branch,
        head: state.branch.oid,
        upstream_remote,
        upstream_branch,
        push_remote,
        remotes,
        ahead: state.branch.ahead,
        behind: state.branch.behind,
        hooks: hooks(runner, repo, &["pre-push"]),
        follow_tags_configured: config(runner, repo, &["--bool", "push.followTags"]).as_deref()
            == Some("true"),
        pull_rebase_configured: config(runner, repo, &["pull.rebase"]),
    })
}

fn valid_name(value: &str, what: &str) -> Result<(), String> {
    if value.is_empty()
        || value.starts_with('-')
        || value.len() > 255
        || value.chars().any(|c| {
            c.is_control()
                || c == ' '
                || c == ':'
                || c == '~'
                || c == '^'
                || c == '?'
                || c == '*'
                || c == '['
                || c == '\\'
        })
        || value.contains("..")
        || value.contains("@{")
        || value.ends_with('/')
        || value.ends_with(".lock")
    {
        return Err(tr!(
            "Invalid {{what}} name: {{value}}",
            what = what,
            value = value
        ));
    }
    Ok(())
}

pub fn check_ref_name(
    runner: &GitRunner,
    repo: &RepoInfo,
    value: &str,
    what: &str,
) -> Result<(), String> {
    valid_name(value, what)?;
    let output = runner
        .run(Invocation::new(
            &repo.root_path,
            Access::Read,
            ["check-ref-format", "--branch", value],
        ))
        .map_err(String::from)?;
    if !output.success() {
        return Err(tr!(
            "Invalid {{what}} name: {{value}}",
            what = what,
            value = value
        ));
    }
    Ok(())
}

pub fn remote_exists(runner: &GitRunner, repo: &RepoInfo, remote: &str) -> Result<(), String> {
    valid_name(remote, &crate::tr!("remote"))?;
    let remotes = runner
        .ok(Invocation::new(&repo.root_path, Access::Read, ["remote"]))
        .map_err(String::from)?
        .stdout_text();
    if !remotes.lines().any(|line| line == remote) {
        return Err(tr!("Remote not found: {{remote}}", remote = remote));
    }
    Ok(())
}

fn network(
    runner: &GitRunner,
    repo: &RepoInfo,
    args: Vec<String>,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let output = runner
        .run(
            Invocation::new(&repo.root_path, Access::Write, args)
                .env("GIT_EDITOR", "true")
                .timeout(NETWORK_TIMEOUT)
                .cancel(cancel),
        )
        .map_err(|error| match error.kind {
            GitErrorKind::Timeout | GitErrorKind::Cancelled => tr!(
                "{{error}}. The network operation may have partly completed; refresh to check the remote. Session Bay does not resend it automatically",
                error = error
            ),
            _ => error.to_string(),
        })?;
    if !output.success() {
        return Err(GitError::from_output(&output).to_string());
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

pub fn fetch(
    runner: &GitRunner,
    repo: &RepoInfo,
    remote: Option<&str>,
    prune: bool,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let mut args = vec!["fetch".to_owned()];
    if prune {
        args.push("--prune".into());
    }
    match remote {
        Some(remote) => {
            remote_exists(runner, repo, remote)?;
            args.push("--".into());
            args.push(remote.into());
        }
        None => args.push("--all".into()),
    }
    network(runner, repo, args, cancel)
}

pub fn pull(
    runner: &GitRunner,
    repo: &RepoInfo,
    strategy: PullStrategy,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let plan = push_plan(runner, repo)?;
    let (Some(_), Some(remote), Some(branch)) =
        (&plan.branch, &plan.upstream_remote, &plan.upstream_branch)
    else {
        return Err(tr!("The current branch has no upstream; set a push target first or create it from a remote branch"));
    };
    if status::operation(repo).is_some() {
        return Err(tr!(
            "A merge, rebase or similar operation is in progress; finish or abort it first"
        ));
    }
    let flag = match strategy {
        PullStrategy::Merge => "--no-rebase",
        PullStrategy::Rebase => "--rebase",
        PullStrategy::FastForwardOnly => "--ff-only",
    };
    let mut args = vec!["pull".to_owned(), flag.into()];
    if strategy == PullStrategy::Merge {
        args.push("--no-edit".into());
    }
    args.extend(["--".into(), remote.clone(), branch.clone()]);
    network(runner, repo, args, cancel)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub remote: String,
    pub local_branch: String,
    pub remote_branch: String,
    #[serde(default)]
    pub set_upstream: bool,
    /// Expected remote oid; present only for an explicitly confirmed force.
    #[serde(default)]
    pub force_with_lease: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub output: String,
    /// Remote-tracking ref equals the pushed commit after refresh.
    pub confirmed: bool,
    pub pushed: String,
}

pub fn push(
    runner: &GitRunner,
    repo: &RepoInfo,
    request: &PushRequest,
    cancel: Arc<AtomicBool>,
) -> Result<PushResult, String> {
    remote_exists(runner, repo, &request.remote)?;
    check_ref_name(
        runner,
        repo,
        &request.local_branch,
        &crate::tr!("local branch"),
    )?;
    check_ref_name(
        runner,
        repo,
        &request.remote_branch,
        &crate::tr!("remote branch"),
    )?;
    let local = format!("refs/heads/{}", request.local_branch);
    let pushed = runner
        .run(Invocation::new(
            &repo.root_path,
            Access::Read,
            ["rev-parse", "--verify", "--quiet", &local],
        ))
        .map_err(String::from)?;
    if !pushed.success() {
        return Err(tr!(
            "Local branch does not exist: {{branch}}",
            branch = request.local_branch
        ));
    }
    let pushed = pushed.stdout_text().trim().to_owned();
    // Never --tags or follow-tags: tags are pushed one by one, explicitly.
    let mut args = vec![
        "push".to_owned(),
        "--no-follow-tags".into(),
        "--porcelain".into(),
    ];
    if request.set_upstream {
        args.push("--set-upstream".into());
    }
    if let Some(expected) = &request.force_with_lease {
        if expected.len() < 7 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(tr!("Force push needs an explicit remote commit"));
        }
        args.push(format!(
            "--force-with-lease=refs/heads/{}:{expected}",
            request.remote_branch
        ));
    }
    args.extend([
        "--".into(),
        request.remote.clone(),
        format!("{local}:refs/heads/{}", request.remote_branch),
    ]);
    let output = network(runner, repo, args, cancel)?;
    let tracking = format!("refs/remotes/{}/{}", request.remote, request.remote_branch);
    let confirmed = runner
        .run(Invocation::new(
            &repo.root_path,
            Access::Read,
            ["rev-parse", "--verify", "--quiet", &tracking],
        ))
        .map(|o| o.success() && o.stdout_text().trim() == pushed)
        .unwrap_or(false);
    Ok(PushResult {
        output,
        confirmed,
        pushed,
    })
}
