//! Paged history, commit details, file history and blame.
use super::{
    diff::{commit_parents, resolve_commit},
    discovery::RepoInfo,
    path::RepoPath,
    runner::{path_arg, Access, GitError, GitRunner, Invocation},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, ffi::OsString, time::Duration};

pub const MAX_PAGE: usize = 500;
pub const MAX_BLAME_LINES: usize = 20_000;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Head,
    Branch,
    Remote,
    Tag,
    Other,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    pub kind: RefKind,
    /// HEAD points at this branch.
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogCommit {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub authored_at: i64,
    pub committed_at: i64,
    pub subject: String,
    pub refs: Vec<RefLabel>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFilter {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub path: Option<RepoPath>,
    /// Limit to one revision (branch/tag/commit) instead of all refs.
    #[serde(default)]
    pub rev: Option<String>,
}

impl LogFilter {
    pub fn narrows(&self) -> bool {
        self.text.as_deref().is_some_and(|t| !t.is_empty())
            || self.author.as_deref().is_some_and(|t| !t.is_empty())
            || self.path.is_some()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<LogCommit>,
    pub has_more: bool,
    /// Filters rewrite ancestry, so lanes are not drawn for filtered pages.
    pub filtered: bool,
}

const FORMAT: &str = "--format=%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s%x00%D";

pub fn parse_refs(decoration: &str) -> Vec<RefLabel> {
    let mut labels = Vec::new();
    for part in decoration.split(", ").filter(|p| !p.is_empty()) {
        if part == "HEAD" {
            labels.push(RefLabel {
                name: "HEAD".into(),
                kind: RefKind::Head,
                current: false,
            });
        } else if let Some(target) = part.strip_prefix("HEAD -> ") {
            labels.push(RefLabel {
                name: "HEAD".into(),
                kind: RefKind::Head,
                current: false,
            });
            labels.extend(parse_refs(target).into_iter().map(|mut label| {
                label.current = true;
                label
            }));
        } else if let Some(tag) = part.strip_prefix("tag: ") {
            labels.push(RefLabel {
                name: tag.strip_prefix("refs/tags/").unwrap_or(tag).into(),
                kind: RefKind::Tag,
                current: false,
            });
        } else if let Some(branch) = part.strip_prefix("refs/heads/") {
            labels.push(RefLabel {
                name: branch.into(),
                kind: RefKind::Branch,
                current: false,
            });
        } else if let Some(remote) = part.strip_prefix("refs/remotes/") {
            if !remote.ends_with("/HEAD") {
                labels.push(RefLabel {
                    name: remote.into(),
                    kind: RefKind::Remote,
                    current: false,
                });
            }
        } else if !part.starts_with("refs/stash") {
            labels.push(RefLabel {
                name: part.into(),
                kind: RefKind::Other,
                current: false,
            });
        }
    }
    labels
}

fn parse_commit(record: &[u8]) -> Option<LogCommit> {
    let fields: Vec<String> = record
        .split(|b| *b == 0)
        .map(|f| String::from_utf8_lossy(f).trim_end_matches('\n').to_owned())
        .collect();
    if fields.len() < 8 {
        return None;
    }
    Some(LogCommit {
        oid: fields[0].trim().to_owned(),
        parents: fields[1].split_whitespace().map(str::to_owned).collect(),
        author: fields[2].clone(),
        email: fields[3].clone(),
        authored_at: fields[4].parse().unwrap_or(0),
        committed_at: fields[5].parse().unwrap_or(0),
        subject: fields[6].chars().take(500).collect(),
        refs: parse_refs(fields[7].trim()),
    })
}

fn checked_text(value: &str, what: &str) -> Result<(), GitError> {
    if value.len() > 512 || value.contains(['\0', '\n']) {
        return Err(GitError::failed(format!("{what}無效")));
    }
    Ok(())
}

pub fn log(
    runner: &GitRunner,
    repo: &RepoInfo,
    filter: &LogFilter,
    offset: usize,
    limit: usize,
) -> Result<LogPage, GitError> {
    let limit = limit.clamp(1, MAX_PAGE);
    let mut args: Vec<OsString> = vec![
        "log".into(),
        "--topo-order".into(),
        "--decorate=full".into(),
        "--no-color".into(),
        FORMAT.into(),
        format!("--skip={offset}").into(),
        format!("--max-count={}", limit + 1).into(),
    ];
    if let Some(text) = filter.text.as_deref().filter(|t| !t.is_empty()) {
        checked_text(text, "搜尋文字")?;
        args.extend(["--regexp-ignore-case".into(), "--fixed-strings".into()]);
        args.push(format!("--grep={text}").into());
    }
    if let Some(author) = filter.author.as_deref().filter(|t| !t.is_empty()) {
        checked_text(author, "作者")?;
        if filter.text.as_deref().is_none_or(str::is_empty) {
            args.extend(["--regexp-ignore-case".into(), "--fixed-strings".into()]);
        }
        args.push(format!("--author={author}").into());
    }
    match filter.rev.as_deref() {
        Some(rev) => args.push(resolve_commit(runner, repo, rev)?.into()),
        None => {
            let has_head = super::diff::repo_has_head(runner, repo)?;
            if !has_head && !has_any_ref(runner, repo)? {
                return Ok(LogPage {
                    commits: Vec::new(),
                    has_more: false,
                    filtered: filter.narrows(),
                });
            }
            args.extend(["--branches".into(), "--remotes".into(), "--tags".into()]);
            if has_head {
                // Includes a detached HEAD that no ref names.
                args.push("HEAD".into());
            }
        }
    }
    if let Some(path) = &filter.path {
        args.push("--".into());
        args.push(path_arg(path.as_bytes())?);
    }
    let output = runner.ok(Invocation::new(&repo.root_path, Access::Read, args)
        .timeout(Duration::from_secs(90))
        .limit(32 * 1024 * 1024))?;
    let mut commits: Vec<LogCommit> = output
        .stdout
        .split(|b| *b == 0x1e)
        .filter(|r| !r.is_empty())
        .filter_map(parse_commit)
        .collect();
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(LogPage {
        commits,
        has_more,
        filtered: filter.narrows(),
    })
}

fn has_any_ref(runner: &GitRunner, repo: &RepoInfo) -> Result<bool, GitError> {
    let output = runner.ok(Invocation::new(
        &repo.root_path,
        Access::Read,
        [
            "for-each-ref",
            "--count=1",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    ))?;
    Ok(!output.stdout.is_empty())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub authored_at: i64,
    pub committer: String,
    pub committer_email: String,
    pub committed_at: i64,
    pub message: String,
    pub refs: Vec<RefLabel>,
}

pub fn commit_detail(
    runner: &GitRunner,
    repo: &RepoInfo,
    rev: &str,
) -> Result<CommitDetail, GitError> {
    let oid = resolve_commit(runner, repo, rev)?;
    let output = runner.ok(Invocation::new(
        &repo.root_path,
        Access::Read,
        [
            "show",
            "-s",
            "--decorate=full",
            "--format=%H%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%D%x00%B",
            &oid,
        ],
    ))?;
    let fields: Vec<String> = output
        .stdout
        .splitn(9, |b| *b == 0)
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect();
    if fields.len() < 9 {
        return Err(GitError::failed("無法解析 commit"));
    }
    Ok(CommitDetail {
        parents: commit_parents(runner, repo, &oid)?,
        oid,
        author: fields[1].clone(),
        email: fields[2].clone(),
        authored_at: fields[3].parse().unwrap_or(0),
        committer: fields[4].clone(),
        committer_email: fields[5].clone(),
        committed_at: fields[6].parse().unwrap_or(0),
        refs: parse_refs(fields[7].trim()),
        message: fields[8].trim_end().chars().take(64 * 1024).collect(),
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileRevision {
    pub commit: LogCommit,
    /// The file's path in this commit (renames followed).
    pub path: RepoPath,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileHistory {
    pub revisions: Vec<FileRevision>,
    pub has_more: bool,
}

pub fn file_history(
    runner: &GitRunner,
    repo: &RepoInfo,
    path: &RepoPath,
    offset: usize,
    limit: usize,
) -> Result<FileHistory, GitError> {
    let limit = limit.clamp(1, MAX_PAGE);
    let output = runner.ok(Invocation::new(
        &repo.root_path,
        Access::Read,
        [
            "log",
            "--follow",
            "--name-status",
            "-z",
            "--decorate=full",
            "--no-color",
        ],
    )
    .arg(FORMAT)
    .arg(format!("--skip={offset}"))
    .arg(format!("--max-count={}", limit + 1))
    .arg("--")
    .arg(path_arg(path.as_bytes())?)
    .timeout(Duration::from_secs(90))
    .limit(32 * 1024 * 1024))?;
    let mut revisions = Vec::new();
    for record in output
        .stdout
        .split(|b| *b == 0x1e)
        .filter(|r| !r.is_empty())
    {
        // Header fields are NUL separated; -z also ends the decoration with
        // NUL, followed by "\n<status>\0<path>[\0<new path>]\0".
        let fields: Vec<&[u8]> = record.split(|b| *b == 0).collect();
        if fields.len() < 8 {
            continue;
        }
        let header: Vec<u8> = fields[..8].join(&0u8);
        let Some(commit) = parse_commit(&header) else {
            continue;
        };
        let rest: Vec<&[u8]> = fields[8..]
            .iter()
            .map(|f| f.strip_prefix(b"\n").unwrap_or(f))
            .filter(|f| !f.is_empty())
            .collect();
        let status = rest
            .first()
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .unwrap_or_default();
        let file = if status.starts_with('R') || status.starts_with('C') {
            rest.get(2).or(rest.get(1))
        } else {
            rest.get(1)
        };
        revisions.push(FileRevision {
            commit,
            path: file
                .map(|f| RepoPath(f.to_vec()))
                .unwrap_or_else(|| path.clone()),
            status: status.chars().next().map(String::from).unwrap_or_default(),
        });
    }
    let has_more = revisions.len() > limit;
    revisions.truncate(limit);
    Ok(FileHistory {
        revisions,
        has_more,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub author: String,
    pub authored_at: i64,
    pub summary: String,
    pub previous: Option<(String, RepoPath)>,
    pub path: RepoPath,
    pub uncommitted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub oid: String,
    pub original_line: u32,
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub path: RepoPath,
    pub rev: Option<String>,
    pub lines: Vec<BlameLine>,
    pub commits: HashMap<String, BlameCommit>,
    pub truncated: bool,
}

pub fn blame(
    runner: &GitRunner,
    repo: &RepoInfo,
    path: &RepoPath,
    rev: Option<&str>,
) -> Result<Blame, GitError> {
    let mut invocation = Invocation::new(
        &repo.root_path,
        Access::Read,
        [
            "blame",
            "--porcelain",
            "-L",
            &format!("1,{MAX_BLAME_LINES}"),
        ],
    );
    let resolved = match rev {
        Some(rev) => {
            let oid = resolve_commit(runner, repo, rev)?;
            invocation = invocation.arg(&oid);
            Some(oid)
        }
        None => None,
    };
    let output = runner.run(
        invocation
            .arg("--")
            .arg(path_arg(path.as_bytes())?)
            .timeout(Duration::from_secs(90))
            .limit(64 * 1024 * 1024),
    )?;
    if !output.success() {
        let message = output.stderr_text();
        // -L beyond EOF fails for short files; retry without the bound.
        if message.contains("has only") || message.contains("lines") {
            let mut retry =
                Invocation::new(&repo.root_path, Access::Read, ["blame", "--porcelain"]);
            if let Some(oid) = &resolved {
                retry = retry.arg(oid);
            }
            let output = runner.ok(retry
                .arg("--")
                .arg(path_arg(path.as_bytes())?)
                .timeout(Duration::from_secs(90))
                .limit(64 * 1024 * 1024))?;
            return parse_blame(&output.stdout, path, resolved);
        }
        return Err(GitError::from_output(&output));
    }
    parse_blame(&output.stdout, path, resolved)
}

pub fn parse_blame(stdout: &[u8], path: &RepoPath, rev: Option<String>) -> Result<Blame, GitError> {
    let mut commits: HashMap<String, BlameCommit> = HashMap::new();
    let mut lines = Vec::new();
    let mut current: Option<(String, u32, u32)> = None;
    for raw in stdout.split(|b| *b == b'\n') {
        if let Some(content) = raw.strip_prefix(b"\t") {
            if let Some((oid, original, final_line)) = current.take() {
                if lines.len() >= MAX_BLAME_LINES {
                    continue;
                }
                let text = String::from_utf8_lossy(content.strip_suffix(b"\r").unwrap_or(content));
                lines.push(BlameLine {
                    oid,
                    original_line: original,
                    line: final_line,
                    text: text.chars().take(4000).collect(),
                });
            }
            continue;
        }
        let text = String::from_utf8_lossy(raw);
        let mut parts = text.splitn(2, ' ');
        let key = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default();
        if key.len() >= 40 && key.chars().all(|c| c.is_ascii_hexdigit()) {
            let mut numbers = value.split(' ').map(|n| n.parse::<u32>().unwrap_or(0));
            let original = numbers.next().unwrap_or(0);
            let final_line = numbers.next().unwrap_or(0);
            commits
                .entry(key.to_owned())
                .or_insert_with(|| BlameCommit {
                    author: String::new(),
                    authored_at: 0,
                    summary: String::new(),
                    previous: None,
                    path: path.clone(),
                    uncommitted: key.chars().all(|c| c == '0'),
                });
            current = Some((key.to_owned(), original, final_line));
            continue;
        }
        let Some((oid, _, _)) = &current else {
            continue;
        };
        let Some(commit) = commits.get_mut(oid) else {
            continue;
        };
        match key {
            "author" => commit.author = value.to_owned(),
            "author-time" => commit.authored_at = value.parse().unwrap_or(0),
            "summary" => commit.summary = value.chars().take(300).collect(),
            "filename" => commit.path = RepoPath(raw[9..].to_vec()),
            "previous" => {
                // "previous <oid> <path>"; slice bytes so the path stays exact.
                let rest = &raw[9..];
                if let Some(space) = rest.iter().position(|b| *b == b' ') {
                    let previous = String::from_utf8_lossy(&rest[..space]).into_owned();
                    commit.previous = Some((previous, RepoPath(rest[space + 1..].to_vec())));
                }
            }
            _ => {}
        }
    }
    let truncated = lines.len() >= MAX_BLAME_LINES;
    Ok(Blame {
        path: path.clone(),
        rev,
        lines,
        commits,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_decorations() {
        let labels = parse_refs("HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0, refs/heads/feature/x");
        assert_eq!(labels[0].kind, RefKind::Head);
        assert_eq!(
            labels[1],
            RefLabel {
                name: "main".into(),
                kind: RefKind::Branch,
                current: true
            }
        );
        assert_eq!(labels[2].kind, RefKind::Remote);
        assert_eq!(
            labels[3],
            RefLabel {
                name: "v1.0".into(),
                kind: RefKind::Tag,
                current: false
            }
        );
        assert_eq!(labels[4].name, "feature/x");
        assert_eq!(labels.len(), 5);
    }

    #[test]
    fn parses_blame_porcelain() {
        let oid = "a".repeat(40);
        let text = format!("{oid} 1 1 2\nauthor Synthetic\nauthor-time 100\nsummary First\nprevious {} old name.txt\nfilename new name.txt\n\tline one\r\n{oid} 2 2\n\tline two\n", "b".repeat(40));
        let blame =
            parse_blame(text.as_bytes(), &RepoPath::from_text("new name.txt"), None).unwrap();
        assert_eq!(blame.lines.len(), 2);
        assert_eq!(blame.lines[0].text, "line one");
        let commit = &blame.commits[&oid];
        assert_eq!(commit.summary, "First");
        assert_eq!(
            commit.previous.as_ref().unwrap().1.display(),
            "old name.txt"
        );
        assert_eq!(commit.path.display(), "new name.txt");
    }
}
