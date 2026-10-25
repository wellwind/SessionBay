//! Linked worktrees: list, add, remove and prune.
//!
//! Removal never deletes a branch and never discards work. A checkout with
//! changes is refused unless the user asks to stash them first; the stash
//! lives in the shared repository, so it stays reachable from every worktree.
use super::{
    branches::Outcome,
    discovery::{canonical, RepoInfo},
    refs,
    remote::check_ref_name,
    runner::{Access, GitError, GitRunner, Invocation},
};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

/// Upper bound on listed worktrees; each one costs a status read.
const MAX_WORKTREES: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: Option<String>,
    /// Short branch name; `None` when detached.
    pub branch: Option<String>,
    pub main: bool,
    /// The worktree this repository entry was opened from.
    pub current: bool,
    pub locked: bool,
    /// Git reports the checkout as missing; `prune` removes the record.
    pub prunable: bool,
    /// Unknown for missing checkouts.
    pub dirty: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAdded {
    pub path: String,
    pub branch: String,
}

fn git(
    runner: &GitRunner,
    cwd: &Path,
    access: Access,
    args: Vec<String>,
    env: &[(&str, &str)],
) -> Result<String, String> {
    let mut invocation = Invocation::new(cwd, access, args)
        .env("GIT_EDITOR", "true")
        .timeout(Duration::from_secs(120));
    for (key, value) in env {
        invocation = invocation.env(key, value);
    }
    let output = runner.run(invocation).map_err(String::from)?;
    if !output.success() {
        return Err(GitError::from_output(&output).to_string());
    }
    Ok(output.stdout_text())
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (canonical(a), canonical(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn dirty(runner: &GitRunner, path: &Path) -> Option<bool> {
    git(
        runner,
        path,
        Access::Read,
        vec![
            "status".into(),
            "--porcelain".into(),
            "--untracked-files=all".into(),
        ],
        &[],
    )
    .ok()
    .map(|out| !out.trim().is_empty())
}

pub fn list(runner: &GitRunner, repo: &RepoInfo) -> Result<Vec<Worktree>, String> {
    // Reuse the NUL-separated parser in refs; add main/dirty for management.
    let mut items = Vec::new();
    for (index, entry) in refs::worktrees(runner, repo)
        .map_err(String::from)?
        .into_iter()
        .enumerate()
    {
        if entry.bare {
            continue;
        }
        let path = PathBuf::from(&entry.path);
        let dirty = (!entry.prunable && path.is_dir())
            .then(|| dirty(runner, &path))
            .flatten();
        items.push(Worktree {
            branch: entry.branch.map(|b| {
                b.strip_prefix("refs/heads/")
                    .map(str::to_owned)
                    .unwrap_or(b)
            }),
            path: entry.path,
            head: entry.head,
            main: index == 0,
            current: entry.current,
            locked: entry.locked,
            prunable: entry.prunable,
            dirty,
        });
        if items.len() >= MAX_WORKTREES {
            break;
        }
    }
    Ok(items)
}

/// `<parent of main checkout>/<main name>.worktrees/<branch with / as ->`.
pub fn default_path(main: &Path, branch: &str) -> PathBuf {
    let name = main
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    let slug: String = branch
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    main.parent()
        .unwrap_or(main)
        .join(format!("{name}.worktrees"))
        .join(slug.trim_matches('.'))
}

fn branch_exists(runner: &GitRunner, repo: &RepoInfo, branch: &str) -> bool {
    git(
        runner,
        &repo.root_path,
        Access::Read,
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            "--end-of-options".into(),
            format!("refs/heads/{branch}"),
        ],
        &[],
    )
    .is_ok()
}

pub fn add(
    runner: &GitRunner,
    repo: &RepoInfo,
    branch: &str,
    create: bool,
    base: Option<&str>,
    path: Option<&str>,
) -> Result<WorktreeAdded, String> {
    check_ref_name(runner, repo, branch, "Branch ")?;
    let exists = branch_exists(runner, repo, branch);
    if create && exists {
        return Err(format!("Branch {branch} 已存在；請改用「使用既有 branch」"));
    }
    if !create && !exists {
        return Err(format!("找不到 branch：{branch}"));
    }
    let worktrees = list(runner, repo)?;
    if !create
        && worktrees
            .iter()
            .any(|w| w.branch.as_deref() == Some(branch))
    {
        return Err(format!("Branch {branch} 已在另一個 worktree 使用中"));
    }
    let main = worktrees
        .iter()
        .find(|w| w.main)
        .map(|w| PathBuf::from(&w.path))
        .unwrap_or_else(|| repo.root_path.clone());
    let target = match path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err("Worktree 路徑必須是絕對路徑".into());
            }
            path
        }
        None => default_path(&main, branch),
    };
    if target.exists() {
        return Err(format!("路徑已存在，未建立 worktree：{}", target.display()));
    }
    let target_arg = target.to_string_lossy().into_owned();
    let mut args = vec!["worktree".to_owned(), "add".into()];
    if create {
        args.extend(["-b".into(), branch.into(), "--".into(), target_arg.clone()]);
        if let Some(base) = base.map(str::trim).filter(|b| !b.is_empty()) {
            args.push(base.into());
        }
    } else {
        args.extend(["--".into(), target_arg.clone(), branch.into()]);
    }
    git(runner, &repo.root_path, Access::Write, args, &[])?;
    Ok(WorktreeAdded {
        path: target_arg,
        branch: branch.into(),
    })
}

pub fn remove(
    runner: &GitRunner,
    repo: &RepoInfo,
    path: &str,
    stash: bool,
) -> Result<Outcome, String> {
    let worktrees = list(runner, repo)?;
    let target = worktrees
        .iter()
        .find(|w| same_path(Path::new(&w.path), Path::new(path)))
        .ok_or("找不到這個 worktree")?;
    if target.main {
        return Err("主要 worktree 不能移除".into());
    }
    if target.current {
        return Err("無法移除目前所在的 worktree；請從主要 repository 移除".into());
    }
    if target.locked {
        return Err("Worktree 已鎖定，未移除".into());
    }
    let checkout = PathBuf::from(&target.path);
    let mut note = String::new();
    if target.dirty == Some(true) {
        if !stash {
            return Err("Worktree 有未提交的變更，未移除；可選擇先 stash 再移除".into());
        }
        let label = target.branch.clone().unwrap_or_else(|| "detached".into());
        // `stash -u` cleans untracked files through an internal `:/` pathspec.
        git(
            runner,
            &checkout,
            Access::Write,
            vec![
                "stash".into(),
                "push".into(),
                "--include-untracked".into(),
                "-m".into(),
                format!("Session Bay：移除 worktree {label} 前的變更"),
            ],
            &[("GIT_LITERAL_PATHSPECS", "0")],
        )?;
        if dirty(runner, &checkout) == Some(true) {
            return Err("Stash 後仍有變更，未移除 worktree".into());
        }
        note = "；變更已存成 stash，可在 Stash 區取回".into();
    }
    git(
        runner,
        &repo.root_path,
        Access::Write,
        vec![
            "worktree".into(),
            "remove".into(),
            "--".into(),
            target.path.clone(),
        ],
        &[],
    )?;
    Ok(Outcome::plain(format!(
        "已移除 worktree（branch {} 保留）{note}",
        target.branch.as_deref().unwrap_or("detached")
    )))
}

pub fn prune(runner: &GitRunner, repo: &RepoInfo) -> Result<Outcome, String> {
    git(
        runner,
        &repo.root_path,
        Access::Write,
        vec!["worktree".into(), "prune".into()],
        &[],
    )?;
    Ok(Outcome::plain("已清理失效的 worktree 紀錄"))
}
