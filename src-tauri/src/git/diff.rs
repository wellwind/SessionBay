//! Text diffs between explicit sources, kept byte-exact for patch building.
//!
//! Display settings such as ignoring whitespace produce a separate, read-only
//! view; staging always recomputes the exact diff and checks its snapshot.
use super::{
    discovery::RepoInfo,
    path::RepoPath,
    runner::{path_arg, Access, GitError, GitErrorKind, GitRunner, Invocation},
};
use crate::tr;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::OsString, time::Duration};

pub const MAX_DIFF_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_DIFF_LINES: usize = 20_000;
pub const MAX_LINE_CHARS: usize = 4_000;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum DiffSource {
    /// Index → work tree (unstaged).
    Unstaged,
    /// HEAD → index (staged).
    Staged,
    /// HEAD → work tree (everything uncommitted).
    WorkingTree,
    /// A commit against one explicit parent (1-based, merge commits choose).
    Commit { commit: String, parent: Option<u32> },
    /// Two endpoints; `merge_base` compares from their merge base (`a...b`).
    Compare {
        base: String,
        head: String,
        merge_base: bool,
    },
}

impl DiffSource {
    pub fn stageable(&self) -> bool {
        matches!(self, Self::Unstaged | Self::Staged)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Add,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawLine {
    pub kind: LineKind,
    /// Content including its diff line terminator.
    pub bytes: Vec<u8>,
    /// The file has no newline after this line.
    pub no_newline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawHunk {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub section: Vec<u8>,
    pub lines: Vec<RawLine>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawDiff {
    pub header: Vec<Vec<u8>>,
    pub hunks: Vec<RawHunk>,
    pub binary: bool,
    pub new_file: bool,
    pub deleted_file: bool,
    pub renamed: bool,
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    pub submodule: bool,
    /// Byte-exact output, hashed into the snapshot.
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub text: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub no_newline: bool,
    pub crlf: bool,
    /// Display text was shortened; patch bytes are unaffected.
    pub clipped: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub repo_id: String,
    pub path: RepoPath,
    pub old_path: Option<RepoPath>,
    pub source: DiffSource,
    pub ignore_whitespace: bool,
    pub binary: bool,
    pub new_file: bool,
    pub deleted_file: bool,
    pub renamed: bool,
    pub submodule: bool,
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    pub hunks: Vec<DiffHunk>,
    pub too_large: bool,
    pub truncated: bool,
    pub unsupported_encoding: bool,
    /// Identifies the exact bytes partial operations were selected from.
    pub snapshot: String,
    /// Why line/hunk operations are unavailable, if they are.
    pub partial_blocked: Option<String>,
}

pub struct DiffRequest<'a> {
    pub path: &'a RepoPath,
    pub old_path: Option<&'a RepoPath>,
    pub source: &'a DiffSource,
    pub ignore_whitespace: bool,
    pub untracked: bool,
}

/// Resolves a user-supplied revision to a full commit id. `--end-of-options`
/// keeps names like `-x` from being read as flags.
pub fn resolve_commit(runner: &GitRunner, repo: &RepoInfo, rev: &str) -> Result<String, GitError> {
    if rev.is_empty() || rev.len() > 512 || rev.contains(['\0', '\n']) {
        return Err(GitError::failed(tr!("Invalid revision")));
    }
    let output = runner.run(
        Invocation::new(
            &repo.root_path,
            Access::Read,
            ["rev-parse", "--verify", "--quiet", "--end-of-options"],
        )
        .arg(format!("{rev}^{{commit}}")),
    )?;
    if !output.success() {
        return Err(GitError::failed(tr!(
            "Commit not found: {{rev}}",
            rev = rev
        )));
    }
    Ok(output.stdout_text().trim().to_owned())
}

pub fn empty_tree(runner: &GitRunner, repo: &RepoInfo) -> Result<String, GitError> {
    // Works for SHA-1 and SHA-256 repositories alike.
    let output = runner.ok(Invocation::new(
        &repo.root_path,
        Access::Read,
        ["hash-object", "-t", "tree", "--stdin"],
    )
    .stdin(Vec::new()))?;
    Ok(output.stdout_text().trim().to_owned())
}

fn common_args(ignore_whitespace: bool, renames: bool) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-c",
        "diff.suppressBlankEmpty=false",
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.mnemonicPrefix=false",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    args.extend(
        [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-relative",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--full-index",
            "-U3",
        ]
        .into_iter()
        .map(OsString::from),
    );
    args.push(OsString::from(if renames { "-M" } else { "--no-renames" }));
    if ignore_whitespace {
        args.push("-w".into());
    }
    args
}

/// Runs the byte-exact diff for one file. Exit status 1 from `--no-index`
/// means "differences found", not failure.
pub fn raw_diff(
    runner: &GitRunner,
    repo: &RepoInfo,
    request: &DiffRequest<'_>,
) -> Result<RawDiff, GitError> {
    let path = path_arg(request.path.as_bytes())?;
    let renames = !matches!(request.source, DiffSource::Unstaged);
    let mut args = common_args(request.ignore_whitespace, renames);
    let mut no_index = false;
    match request.source {
        DiffSource::Unstaged if request.untracked => {
            no_index = true;
            args.push("--no-index".into());
            args.push("--".into());
            args.push("/dev/null".into());
            args.push(path.clone());
        }
        DiffSource::Unstaged => {}
        DiffSource::Staged => args.push("--cached".into()),
        DiffSource::WorkingTree => {
            if repo_has_head(runner, repo)? {
                args.push("HEAD".into());
            } else {
                args.push(empty_tree(runner, repo)?.into());
            }
        }
        DiffSource::Commit { .. } | DiffSource::Compare { .. } => {
            args.extend(endpoints(runner, repo, request.source)?)
        }
    }
    if !no_index {
        args.push("--".into());
        args.push(path);
        if let Some(old) = request.old_path {
            args.push(path_arg(old.as_bytes())?);
        }
    }
    let output = runner.run(
        Invocation::new(&repo.root_path, Access::Read, args)
            .timeout(Duration::from_secs(60))
            .limit(MAX_DIFF_BYTES),
    )?;
    let accepted = output.success() || (no_index && output.code == Some(1));
    if !accepted {
        return Err(GitError::from_output(&output));
    }
    parse(&output.stdout)
}

/// Resolved endpoint arguments for commit and compare sources.
pub fn endpoints(
    runner: &GitRunner,
    repo: &RepoInfo,
    source: &DiffSource,
) -> Result<Vec<OsString>, GitError> {
    match source {
        DiffSource::Commit { commit, parent } => {
            let commit = resolve_commit(runner, repo, commit)?;
            let parents = commit_parents(runner, repo, &commit)?;
            let base = match (parents.len(), *parent) {
                (0, _) => empty_tree(runner, repo)?,
                (count, Some(n)) if n >= 1 && n as usize <= count => {
                    parents[n as usize - 1].clone()
                }
                (1, None) => parents[0].clone(),
                (_, None) => {
                    return Err(GitError::failed(tr!(
                        "A merge commit needs an explicit parent to compare with"
                    )))
                }
                _ => return Err(GitError::failed(tr!("The chosen parent does not exist"))),
            };
            Ok(vec![base.into(), commit.into()])
        }
        DiffSource::Compare {
            base,
            head,
            merge_base,
        } => {
            let base = resolve_commit(runner, repo, base)?;
            let head = resolve_commit(runner, repo, head)?;
            Ok(if *merge_base {
                vec![format!("{base}...{head}").into()]
            } else {
                vec![base.into(), head.into()]
            })
        }
        _ => Err(GitError::failed(tr!("This source has no commit end"))),
    }
}

pub fn repo_has_head(runner: &GitRunner, repo: &RepoInfo) -> Result<bool, GitError> {
    Ok(runner
        .run(Invocation::new(
            &repo.root_path,
            Access::Read,
            ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        ))?
        .success())
}

pub fn commit_parents(
    runner: &GitRunner,
    repo: &RepoInfo,
    commit: &str,
) -> Result<Vec<String>, GitError> {
    let output = runner.ok(Invocation::new(
        &repo.root_path,
        Access::Read,
        ["rev-list", "--parents", "-n", "1", commit],
    ))?;
    Ok(output
        .stdout_text()
        .split_whitespace()
        .skip(1)
        .map(str::to_owned)
        .collect())
}

fn number(text: &str) -> Option<(u32, u32)> {
    let mut parts = text.splitn(2, ',');
    let start = parts.next()?.parse().ok()?;
    let count = parts.next().map(|c| c.parse().ok()).unwrap_or(Some(1))?;
    Some((start, count))
}

pub fn parse_hunk_header(line: &[u8]) -> Option<(u32, u32, u32, u32, Vec<u8>)> {
    let rest = line.strip_prefix(b"@@ -")?;
    let end = rest.windows(3).position(|w| w == b" @@")?;
    let ranges = std::str::from_utf8(&rest[..end]).ok()?;
    let (old, new) = ranges.split_once(" +")?;
    let (old_start, old_count) = number(old)?;
    let (new_start, new_count) = number(new)?;
    let section = rest[end + 3..].to_vec();
    Some((old_start, old_count, new_start, new_count, section))
}

pub fn parse(output: &[u8]) -> Result<RawDiff, GitError> {
    let mut diff = RawDiff {
        bytes: output.to_vec(),
        ..RawDiff::default()
    };
    let mut lines = output.split_inclusive(|b| *b == b'\n').peekable();
    let mut sections = 0;
    // Header.
    while let Some(line) = lines.peek() {
        if line.starts_with(b"@@ ") {
            break;
        }
        let line = lines.next().unwrap_or_default();
        if line.starts_with(b"diff --git ") {
            sections += 1;
            if sections > 1 {
                return Err(GitError::failed(tr!(
                    "This diff has several file sections and cannot be handled safely"
                )));
            }
        }
        let text = String::from_utf8_lossy(line);
        let text = text.trim_end_matches(['\n', '\r']);
        if let Some(mode) = text.strip_prefix("new file mode ") {
            diff.new_file = true;
            diff.new_mode = Some(mode.to_owned());
        } else if let Some(mode) = text.strip_prefix("deleted file mode ") {
            diff.deleted_file = true;
            diff.old_mode = Some(mode.to_owned());
        } else if let Some(mode) = text.strip_prefix("old mode ") {
            diff.old_mode = Some(mode.to_owned());
        } else if let Some(mode) = text.strip_prefix("new mode ") {
            diff.new_mode = Some(mode.to_owned());
        } else if text.starts_with("rename from ") || text.starts_with("copy from ") {
            diff.renamed = true;
        } else if text.starts_with("Binary files ") || text == "GIT binary patch" {
            diff.binary = true;
        } else if let Some(index) = text.strip_prefix("index ") {
            if diff.old_mode.is_none() && diff.new_mode.is_none() {
                if let Some((_, mode)) = index.split_once(' ') {
                    diff.old_mode = Some(mode.to_owned());
                    diff.new_mode = Some(mode.to_owned());
                }
            }
        }
        diff.header.push(line.to_vec());
    }
    if diff.old_mode.as_deref() == Some("160000") || diff.new_mode.as_deref() == Some("160000") {
        diff.submodule = true;
    }
    // Hunks.
    for line in lines {
        let bare = line.strip_suffix(b"\n").unwrap_or(line);
        if bare.starts_with(b"@@ ") {
            let (old_start, old_count, new_start, new_count, section) = parse_hunk_header(bare)
                .ok_or_else(|| GitError::failed(tr!("Cannot parse the diff hunk")))?;
            diff.hunks.push(RawHunk {
                old_start,
                old_count,
                new_start,
                new_count,
                section,
                lines: Vec::new(),
            });
            continue;
        }
        if line.starts_with(b"diff --git ") {
            return Err(GitError::failed(tr!(
                "This diff has several file sections and cannot be handled safely"
            )));
        }
        let hunk = diff
            .hunks
            .last_mut()
            .ok_or_else(|| GitError::failed(tr!("The diff content is missing a hunk header")))?;
        match line.first() {
            Some(b'\\') => {
                if let Some(previous) = hunk.lines.last_mut() {
                    previous.no_newline = true;
                }
            }
            Some(kind @ (b' ' | b'+' | b'-')) => hunk.lines.push(RawLine {
                kind: match kind {
                    b'+' => LineKind::Add,
                    b'-' => LineKind::Delete,
                    _ => LineKind::Context,
                },
                bytes: line[1..].to_vec(),
                no_newline: false,
            }),
            // An empty context line (diff.suppressBlankEmpty) carries no prefix.
            Some(b'\n') => hunk.lines.push(RawLine {
                kind: LineKind::Context,
                bytes: b"\n".to_vec(),
                no_newline: false,
            }),
            _ => return Err(GitError::failed(tr!("Cannot parse a diff content line"))),
        }
    }
    for hunk in &diff.hunks {
        let old = hunk
            .lines
            .iter()
            .filter(|l| l.kind != LineKind::Add)
            .count() as u32;
        let new = hunk
            .lines
            .iter()
            .filter(|l| l.kind != LineKind::Delete)
            .count() as u32;
        if old != hunk.old_count || new != hunk.new_count {
            return Err(GitError::failed(tr!(
                "The diff hunk line count does not match its header"
            )));
        }
    }
    Ok(diff)
}

pub fn snapshot(diff: &RawDiff, index_entry: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update((diff.bytes.len() as u64).to_le_bytes());
    hasher.update(&diff.bytes);
    hasher.update(index_entry);
    hasher.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Stage/mode/oid of the path in the index, part of every snapshot.
pub fn index_entry(
    runner: &GitRunner,
    repo: &RepoInfo,
    path: &RepoPath,
) -> Result<Vec<u8>, GitError> {
    Ok(runner
        .ok(Invocation::new(
            &repo.root_path,
            Access::Read,
            ["ls-files", "--stage", "-z", "--"],
        )
        .arg(path_arg(path.as_bytes())?))?
        .stdout)
}

fn display_line(line: &RawLine, old_line: Option<u32>, new_line: Option<u32>) -> (DiffLine, bool) {
    let mut bytes = line.bytes.as_slice();
    bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    let crlf = bytes.ends_with(b"\r");
    if crlf {
        bytes = &bytes[..bytes.len() - 1];
    }
    let (text, valid) = match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_owned(), true),
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), false),
    };
    let clipped = text.chars().count() > MAX_LINE_CHARS;
    let text = if clipped {
        text.chars().take(MAX_LINE_CHARS).collect()
    } else {
        text
    };
    (
        DiffLine {
            kind: line.kind,
            text,
            old_line,
            new_line,
            no_newline: line.no_newline,
            crlf,
            clipped,
        },
        valid,
    )
}

pub fn file_diff(
    runner: &GitRunner,
    repo: &RepoInfo,
    request: &DiffRequest<'_>,
) -> Result<FileDiff, GitError> {
    let mut result = FileDiff {
        repo_id: repo.id.clone(),
        path: request.path.clone(),
        old_path: request.old_path.cloned(),
        source: request.source.clone(),
        ignore_whitespace: request.ignore_whitespace,
        binary: false,
        new_file: false,
        deleted_file: false,
        renamed: false,
        submodule: false,
        old_mode: None,
        new_mode: None,
        hunks: Vec::new(),
        too_large: false,
        truncated: false,
        unsupported_encoding: false,
        snapshot: String::new(),
        partial_blocked: None,
    };
    let raw = match raw_diff(runner, repo, request) {
        Ok(raw) => raw,
        Err(error) if error.kind == GitErrorKind::TooLarge => {
            result.too_large = true;
            result.partial_blocked = Some(tr!(
                "The diff exceeds the {{limit}} MB viewing limit; you can stage the whole file, but partial line operations are not available",
                limit = MAX_DIFF_BYTES / 1024 / 1024
            ));
            return Ok(result);
        }
        Err(error) => return Err(error),
    };
    let entry = if request.source.stageable() {
        index_entry(runner, repo, request.path)?
    } else {
        Vec::new()
    };
    result.snapshot = snapshot(&raw, &entry);
    result.binary = raw.binary;
    result.new_file = raw.new_file;
    result.deleted_file = raw.deleted_file;
    result.renamed = raw.renamed;
    result.submodule = raw.submodule;
    result.old_mode = raw.old_mode.clone();
    result.new_mode = raw.new_mode.clone();
    let mut total = 0usize;
    for hunk in &raw.hunks {
        if total >= MAX_DIFF_LINES {
            result.truncated = true;
            break;
        }
        let mut old = hunk.old_start.max(if hunk.old_count == 0 { 0 } else { 1 });
        let mut new = hunk.new_start.max(if hunk.new_count == 0 { 0 } else { 1 });
        let mut lines = Vec::with_capacity(hunk.lines.len());
        for line in &hunk.lines {
            let (old_line, new_line) = match line.kind {
                LineKind::Context => (Some(old), Some(new)),
                LineKind::Delete => (Some(old), None),
                LineKind::Add => (None, Some(new)),
            };
            if line.kind != LineKind::Add {
                old += 1;
            }
            if line.kind != LineKind::Delete {
                new += 1;
            }
            let (display, valid) = display_line(line, old_line, new_line);
            result.unsupported_encoding |= !valid;
            lines.push(display);
            total += 1;
        }
        result.hunks.push(DiffHunk {
            header: format!(
                "@@ -{},{} +{},{} @@{}",
                hunk.old_start,
                hunk.old_count,
                hunk.new_start,
                hunk.new_count,
                String::from_utf8_lossy(&hunk.section).trim_end()
            ),
            old_start: hunk.old_start,
            old_count: hunk.old_count,
            new_start: hunk.new_start,
            new_count: hunk.new_count,
            lines,
        });
    }
    result.partial_blocked = partial_blocked(&result);
    Ok(result)
}

fn partial_blocked(diff: &FileDiff) -> Option<String> {
    let reason = if !diff.source.stageable() {
        tr!("This comparison is view-only")
    } else if diff.ignore_whitespace {
        tr!("\"Ignore whitespace\" only affects the view; turn it off to stage partially, so the patch matches the real content")
    } else if diff.binary {
        tr!("Non-text files do not support partial line operations; stage or unstage the whole file")
    } else if diff.submodule {
        tr!("Submodule pointers can only be changed as a whole")
    } else if diff.renamed {
        tr!("Stage or unstage renamed files as a whole")
    } else if diff.unsupported_encoding {
        tr!("The file is not UTF-8 text, so partial line operations are not available")
    } else if diff.truncated || diff.too_large {
        tr!("The diff exceeds the viewing limit, so partial line operations are not available")
    } else if diff.hunks.is_empty() {
        tr!("No text changes to select")
    } else {
        return None;
    };
    Some(reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hunks_markers_and_blank_context() {
        let output = b"diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@ fn x\n a\n\n-b\r\n+c\n\\ No newline at end of file\n";
        let diff = parse(output).unwrap();
        assert_eq!(diff.old_mode.as_deref(), Some("100644"));
        assert_eq!(diff.hunks.len(), 1);
        let hunk = &diff.hunks[0];
        assert_eq!(hunk.section, b" fn x");
        assert_eq!(hunk.lines.len(), 4);
        assert_eq!(hunk.lines[1].kind, LineKind::Context);
        assert_eq!(hunk.lines[2].bytes, b"b\r\n");
        assert!(hunk.lines[3].no_newline);
        assert_eq!(parse_hunk_header(b"@@ -0,0 +1 @@").unwrap().3, 1);
    }

    #[test]
    fn rejects_inconsistent_hunk_counts() {
        assert!(parse(b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n a\n").is_err());
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Git status letter: A, M, D, R, C, T.
    pub status: String,
    pub path: RepoPath,
    pub old_path: Option<RepoPath>,
}

pub const MAX_CHANGED_FILES: usize = 5_000;

/// Files changed between the endpoints of a read-only source.
pub fn changed_files(
    runner: &GitRunner,
    repo: &RepoInfo,
    source: &DiffSource,
) -> Result<(Vec<ChangedFile>, bool), GitError> {
    let mut args: Vec<OsString> = [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-relative",
        "--name-status",
        "-z",
        "-M",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    match source {
        DiffSource::Commit { .. } | DiffSource::Compare { .. } => {
            args.extend(endpoints(runner, repo, source)?)
        }
        DiffSource::WorkingTree => {
            args.push(
                if repo_has_head(runner, repo)? {
                    "HEAD".to_owned()
                } else {
                    empty_tree(runner, repo)?
                }
                .into(),
            );
        }
        DiffSource::Staged => args.push("--cached".into()),
        DiffSource::Unstaged => {}
    }
    let output = runner.ok(Invocation::new(&repo.root_path, Access::Read, args)
        .timeout(Duration::from_secs(60))
        .limit(16 * 1024 * 1024))?;
    let mut files = Vec::new();
    let mut truncated = false;
    let mut fields = output.stdout.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(status) = fields.next() {
        let status = String::from_utf8_lossy(status).into_owned();
        let letter = status.chars().next().unwrap_or('M').to_string();
        let first = fields
            .next()
            .ok_or_else(|| GitError::failed(tr!("Cannot parse the changed file list")))?;
        let (path, old_path) = if letter == "R" || letter == "C" {
            let second = fields
                .next()
                .ok_or_else(|| GitError::failed(tr!("Cannot parse the rename")))?;
            (RepoPath(second.to_vec()), Some(RepoPath(first.to_vec())))
        } else {
            (RepoPath(first.to_vec()), None)
        };
        if files.len() >= MAX_CHANGED_FILES {
            truncated = true;
            continue;
        }
        files.push(ChangedFile {
            status: letter,
            path,
            old_path,
        });
    }
    Ok((files, truncated))
}
