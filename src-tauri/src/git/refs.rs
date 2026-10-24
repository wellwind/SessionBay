//! Branches, tags and worktrees as Git reports them.
use super::{
    discovery::{canonical, RepoInfo},
    runner::{Access, GitError, GitRunner, Invocation},
};
use serde::Serialize;
use std::{path::PathBuf, time::Duration};

pub const MAX_REFS: usize = 5_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub full_name: String,
    pub remote: bool,
    pub oid: String,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub upstream_gone: bool,
    pub current: bool,
    /// Another worktree has this branch checked out.
    pub worktree: Option<String>,
    pub subject: String,
    pub committed_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub name: String,
    pub oid: String,
    /// Commit (or object) the tag points to after peeling.
    pub target: String,
    pub annotated: bool,
    pub message: String,
    pub tagger: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Refs {
    pub branches: Vec<Branch>,
    pub tags: Vec<Tag>,
    pub remotes: Vec<Remote>,
    pub worktrees: Vec<Worktree>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    /// Fetch URL with any embedded credentials removed.
    pub url: String,
    pub push_url: String,
}

pub fn worktrees(runner: &GitRunner, repo: &RepoInfo) -> Result<Vec<Worktree>, GitError> {
    let output = runner.ok(Invocation::new(
        &repo.root_path,
        Access::Read,
        ["worktree", "list", "--porcelain", "-z"],
    ))?;
    let mut list = Vec::new();
    let mut current: Option<Worktree> = None;
    for field in output.stdout.split(|b| *b == 0) {
        let text = String::from_utf8_lossy(field).into_owned();
        if text.is_empty() {
            if let Some(done) = current.take() {
                list.push(done);
            }
            continue;
        }
        if let Some(path) = text.strip_prefix("worktree ") {
            if let Some(done) = current.take() {
                list.push(done);
            }
            let is_current = canonical(&PathBuf::from(path))
                .map(|p| p == repo.root_path)
                .unwrap_or(false);
            current = Some(Worktree {
                path: path.to_owned(),
                head: None,
                branch: None,
                bare: false,
                detached: false,
                locked: false,
                prunable: false,
                current: is_current,
            });
        } else if let Some(entry) = current.as_mut() {
            if let Some(head) = text.strip_prefix("HEAD ") {
                entry.head = Some(head.to_owned());
            } else if let Some(branch) = text.strip_prefix("branch ") {
                entry.branch = Some(branch.to_owned());
            } else if text == "bare" {
                entry.bare = true;
            } else if text == "detached" {
                entry.detached = true;
            } else if text.starts_with("locked") {
                entry.locked = true;
            } else if text.starts_with("prunable") {
                entry.prunable = true;
            }
        }
    }
    if let Some(done) = current.take() {
        list.push(done);
    }
    Ok(list)
}

fn parse_track(track: &str) -> (Option<u32>, Option<u32>, bool) {
    if track.contains("gone") {
        return (None, None, true);
    }
    let mut ahead = None;
    let mut behind = None;
    for part in track.trim_matches(['[', ']']).split(", ") {
        if let Some(value) = part.strip_prefix("ahead ") {
            ahead = value.parse().ok();
        } else if let Some(value) = part.strip_prefix("behind ") {
            behind = value.parse().ok();
        }
    }
    (ahead, behind, false)
}

pub fn refs(runner: &GitRunner, repo: &RepoInfo) -> Result<Refs, GitError> {
    let worktrees = worktrees(runner, repo)?;
    let format = "%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)%00%(contents:subject)%00%(committerdate:unix)%00%(objecttype)%00%(*objectname)%00%(taggername) %(taggeremail)%00%(taggerdate:unix)%00%(contents)%00%(symref)%01";
    let output = runner.ok(Invocation::new(
        &repo.root_path,
        Access::Read,
        ["for-each-ref", "--sort=-committerdate"],
    )
    .arg(format!("--format={format}"))
    .args(["refs/heads", "refs/remotes", "refs/tags"])
    .timeout(Duration::from_secs(30))
    .limit(32 * 1024 * 1024))?;
    let mut branches = Vec::new();
    let mut tags = Vec::new();
    let mut truncated = false;
    for record in output.stdout.split(|b| *b == 1) {
        let record = record.strip_prefix(b"\n").unwrap_or(record);
        if record.is_empty() {
            continue;
        }
        if branches.len() + tags.len() >= MAX_REFS {
            truncated = true;
            break;
        }
        let fields: Vec<String> = record
            .split(|b| *b == 0)
            .map(|f| String::from_utf8_lossy(f).into_owned())
            .collect();
        if fields.len() < 14 {
            continue;
        }
        let full = &fields[0];
        if !fields[13].is_empty() {
            // Symbolic refs such as origin/HEAD duplicate a real branch.
            continue;
        }
        if let Some(name) = full.strip_prefix("refs/tags/") {
            let annotated = fields[8] == "tag";
            tags.push(Tag {
                name: name.to_owned(),
                oid: fields[2].clone(),
                target: if annotated && !fields[9].is_empty() {
                    fields[9].clone()
                } else {
                    fields[2].clone()
                },
                annotated,
                message: if annotated {
                    fields[12].chars().take(4000).collect()
                } else {
                    String::new()
                },
                tagger: if annotated {
                    fields[10].trim().to_owned()
                } else {
                    String::new()
                },
                created_at: fields[11]
                    .parse()
                    .or_else(|_| fields[7].parse())
                    .unwrap_or(0),
            });
        } else {
            let remote = full.starts_with("refs/remotes/");
            let (ahead, behind, gone) = parse_track(&fields[4]);
            let worktree = worktrees
                .iter()
                .find(|w| !w.current && w.branch.as_deref() == Some(full.as_str()))
                .map(|w| w.path.clone());
            branches.push(Branch {
                name: fields[1].clone(),
                full_name: full.clone(),
                remote,
                oid: fields[2].clone(),
                upstream: (!fields[3].is_empty()).then(|| fields[3].clone()),
                ahead,
                behind,
                upstream_gone: gone,
                current: fields[5] == "*",
                worktree,
                subject: fields[6].chars().take(300).collect(),
                committed_at: fields[7].parse().unwrap_or(0),
            });
        }
    }
    tags.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.name.cmp(&b.name)));
    Ok(Refs {
        branches,
        tags,
        remotes: remotes(runner, repo)?,
        worktrees,
        truncated,
    })
}

pub fn remotes(runner: &GitRunner, repo: &RepoInfo) -> Result<Vec<Remote>, GitError> {
    let names = runner.ok(Invocation::new(&repo.root_path, Access::Read, ["remote"]))?;
    let mut list = Vec::new();
    for name in names.stdout_text().lines().filter(|n| !n.is_empty()) {
        let url = |push: bool| -> Result<String, GitError> {
            let mut invocation =
                Invocation::new(&repo.root_path, Access::Read, ["remote", "get-url"]);
            if push {
                invocation = invocation.arg("--push");
            }
            let output = runner.run(invocation.arg("--").arg(name))?;
            Ok(super::runner::redact_url_credentials(
                output.stdout_text().trim(),
            ))
        };
        list.push(Remote {
            name: name.to_owned(),
            url: url(false)?,
            push_url: url(true)?,
        });
    }
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::parse_track;

    #[test]
    fn parses_tracking_summaries() {
        assert_eq!(
            parse_track("[ahead 2, behind 3]"),
            (Some(2), Some(3), false)
        );
        assert_eq!(parse_track("[behind 1]"), (None, Some(1), false));
        assert_eq!(parse_track("[gone]"), (None, None, true));
        assert_eq!(parse_track(""), (None, None, false));
    }
}
