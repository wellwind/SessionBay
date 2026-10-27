//! Parses `git status --porcelain=v2 -z --branch` without lossy path decoding.
use super::{
    discovery::RepoInfo,
    path::RepoPath,
    runner::{Access, GitError, GitRunner, Invocation},
};
use crate::tr;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub const MAX_STATUS_ENTRIES: usize = 5_000;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Change {
    Modified,
    TypeChanged,
    Added,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    BothDeleted,
    AddedByUs,
    DeletedByThem,
    AddedByThem,
    DeletedByUs,
    BothAdded,
    BothModified,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Merge,
    Rebase,
    Am,
    CherryPick,
    Revert,
    Bisect,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: RepoPath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<RepoPath>,
    pub staged: Option<Change>,
    pub unstaged: Option<Change>,
    pub untracked: bool,
    pub conflict: Option<ConflictKind>,
    pub submodule: bool,
    /// Octal modes: HEAD, index, work tree ("000000" when absent).
    pub modes: [String; 3],
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BranchState {
    pub oid: Option<String>,
    /// `None` when HEAD is detached.
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// A branch with no commits yet.
    pub unborn: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub repo_id: String,
    /// Changes whenever the status output or operation changes.
    pub revision: String,
    pub branch: BranchState,
    pub operation: Option<Operation>,
    pub stash_count: u32,
    pub entries: Vec<StatusEntry>,
    pub truncated: bool,
}

pub fn status(runner: &GitRunner, repo: &RepoInfo) -> Result<RepoStatus, GitError> {
    let output = runner.ok(Invocation::new(
        &repo.root_path,
        Access::Read,
        [
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--show-stash",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )
    .timeout(Duration::from_secs(60))
    .limit(64 * 1024 * 1024))?;
    let operation = operation(repo);
    let mut hasher = Sha256::new();
    hasher.update(&output.stdout);
    hasher.update(format!("{operation:?}").as_bytes());
    let revision: String = hasher.finalize()[..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let mut parsed = parse(&output.stdout)?;
    parsed.repo_id = repo.id.clone();
    parsed.revision = revision;
    parsed.operation = operation;
    Ok(parsed)
}

pub fn operation(repo: &RepoInfo) -> Option<Operation> {
    let dir = &repo.git_dir_path;
    if dir.join("rebase-merge").is_dir() {
        Some(Operation::Rebase)
    } else if dir.join("rebase-apply").is_dir() {
        if dir.join("rebase-apply/applying").exists() {
            Some(Operation::Am)
        } else {
            Some(Operation::Rebase)
        }
    } else if dir.join("MERGE_HEAD").is_file() {
        Some(Operation::Merge)
    } else if dir.join("CHERRY_PICK_HEAD").is_file() {
        Some(Operation::CherryPick)
    } else if dir.join("REVERT_HEAD").is_file() {
        Some(Operation::Revert)
    } else if dir.join("BISECT_LOG").is_file() {
        Some(Operation::Bisect)
    } else {
        None
    }
}

fn change(code: u8) -> Option<Change> {
    match code {
        b'M' => Some(Change::Modified),
        b'T' => Some(Change::TypeChanged),
        b'A' => Some(Change::Added),
        b'D' => Some(Change::Deleted),
        b'R' => Some(Change::Renamed),
        b'C' => Some(Change::Copied),
        _ => None,
    }
}

fn conflict(xy: &[u8]) -> Option<ConflictKind> {
    Some(match xy {
        b"DD" => ConflictKind::BothDeleted,
        b"AU" => ConflictKind::AddedByUs,
        b"UD" => ConflictKind::DeletedByThem,
        b"UA" => ConflictKind::AddedByThem,
        b"DU" => ConflictKind::DeletedByUs,
        b"AA" => ConflictKind::BothAdded,
        b"UU" => ConflictKind::BothModified,
        _ => return None,
    })
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Splits a record into `count` space-separated fields plus the remainder,
/// which is the path and may itself contain spaces.
fn fields(record: &[u8], count: usize) -> Option<(Vec<&[u8]>, &[u8])> {
    let mut parts = Vec::with_capacity(count);
    let mut rest = record;
    for _ in 0..count {
        let index = rest.iter().position(|b| *b == b' ')?;
        parts.push(&rest[..index]);
        rest = &rest[index + 1..];
    }
    Some((parts, rest))
}

pub fn parse(stdout: &[u8]) -> Result<RepoStatus, GitError> {
    let mut status = RepoStatus {
        repo_id: String::new(),
        revision: String::new(),
        branch: BranchState::default(),
        operation: None,
        stash_count: 0,
        entries: Vec::new(),
        truncated: false,
    };
    let bad = || GitError::failed(tr!("Cannot parse the git status output"));
    let mut records = stdout.split(|b| *b == 0).peekable();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix(b"# ") {
            let header = text(header);
            if let Some(oid) = header.strip_prefix("branch.oid ") {
                status.branch.unborn = oid == "(initial)";
                status.branch.oid = (!status.branch.unborn).then(|| oid.to_owned());
            } else if let Some(head) = header.strip_prefix("branch.head ") {
                status.branch.head = (head != "(detached)").then(|| head.to_owned());
            } else if let Some(upstream) = header.strip_prefix("branch.upstream ") {
                status.branch.upstream = Some(upstream.to_owned());
            } else if let Some(ab) = header.strip_prefix("branch.ab ") {
                for part in ab.split(' ') {
                    if let Some(value) = part.strip_prefix('+') {
                        status.branch.ahead = value.parse().unwrap_or(0);
                    } else if let Some(value) = part.strip_prefix('-') {
                        status.branch.behind = value.parse().unwrap_or(0);
                    }
                }
            } else if let Some(count) = header.strip_prefix("stash ") {
                status.stash_count = count.parse().unwrap_or(0);
            }
            continue;
        }
        if status.entries.len() >= MAX_STATUS_ENTRIES {
            status.truncated = true;
            // Rename records own a second NUL-separated field.
            if record.starts_with(b"2 ") {
                records.next();
            }
            continue;
        }
        let entry = match record.first() {
            Some(b'1') => {
                let (parts, path) = fields(record, 8).ok_or_else(bad)?;
                ordinary(&parts, path, None)
            }
            Some(b'2') => {
                let (parts, path) = fields(record, 9).ok_or_else(bad)?;
                let orig = records.next().ok_or_else(bad)?;
                ordinary(&parts, path, Some(RepoPath(orig.to_vec())))
            }
            Some(b'u') => {
                let (parts, path) = fields(record, 10).ok_or_else(bad)?;
                StatusEntry {
                    path: RepoPath(path.to_vec()),
                    orig_path: None,
                    staged: None,
                    unstaged: None,
                    untracked: false,
                    conflict: conflict(parts[1]),
                    submodule: parts[2].first() == Some(&b'S'),
                    modes: [text(parts[3]), text(parts[4]), text(parts[6])],
                }
            }
            Some(b'?') => StatusEntry {
                path: RepoPath(record.get(2..).ok_or_else(bad)?.to_vec()),
                orig_path: None,
                staged: None,
                unstaged: None,
                untracked: true,
                conflict: None,
                submodule: false,
                modes: ["000000".into(), "000000".into(), "100644".into()],
            },
            _ => continue,
        };
        status.entries.push(entry);
    }
    Ok(status)
}

fn ordinary(parts: &[&[u8]], path: &[u8], orig: Option<RepoPath>) -> StatusEntry {
    let xy = parts[1];
    StatusEntry {
        path: RepoPath(path.to_vec()),
        orig_path: orig,
        staged: xy.first().copied().and_then(change),
        unstaged: xy.get(1).copied().and_then(change),
        untracked: false,
        conflict: None,
        submodule: parts[2].first() == Some(&b'S'),
        modes: [text(parts[3]), text(parts[4]), text(parts[5])],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_headers_entries_renames_and_conflicts() {
        let output = b"# branch.oid 1111111111111111111111111111111111111111\0\
# branch.head feature/x\0# branch.upstream origin/feature/x\0# branch.ab +2 -3\0# stash 4\0\
1 .M N... 100644 100644 100644 aaaa bbbb dir/a file.txt\0\
2 R. N... 100644 100644 100644 aaaa aaaa R100 new name.txt\0old name.txt\0\
u UU N... 100644 100644 100644 100644 a b c conflicted.txt\0\
1 M. SC.. 160000 160000 160000 aaaa bbbb vendor/sub\0\
? -untracked\0";
        let status = parse(output).unwrap();
        assert_eq!(status.branch.head.as_deref(), Some("feature/x"));
        assert_eq!(status.branch.upstream.as_deref(), Some("origin/feature/x"));
        assert_eq!((status.branch.ahead, status.branch.behind), (2, 3));
        assert_eq!(status.stash_count, 4);
        assert_eq!(status.entries.len(), 5);
        assert_eq!(status.entries[0].path.display(), "dir/a file.txt");
        assert_eq!(status.entries[0].unstaged, Some(Change::Modified));
        assert_eq!(status.entries[0].staged, None);
        assert_eq!(status.entries[1].staged, Some(Change::Renamed));
        assert_eq!(
            status.entries[1].orig_path.as_ref().unwrap().display(),
            "old name.txt"
        );
        assert_eq!(status.entries[2].conflict, Some(ConflictKind::BothModified));
        assert!(status.entries[3].submodule);
        assert!(status.entries[4].untracked);
        assert_eq!(status.entries[4].path.display(), "-untracked");
    }

    #[test]
    fn detached_and_unborn_heads() {
        let detached = parse(b"# branch.oid abc\0# branch.head (detached)\0").unwrap();
        assert_eq!(detached.branch.head, None);
        assert!(!detached.branch.unborn);
        let unborn = parse(b"# branch.oid (initial)\0# branch.head main\0").unwrap();
        assert!(unborn.branch.unborn);
        assert_eq!(unborn.branch.oid, None);
        assert_eq!(unborn.branch.head.as_deref(), Some("main"));
    }
}
