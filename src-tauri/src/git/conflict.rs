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
        Ok(_) => Err(format!("{} 不是一般檔案", path.display())),
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
            "檔案或衝突狀態已在開啟後變更（可能是 Agent 或其他編輯器），未寫入；請重新載入".into(),
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
    let base = ("共同祖先（base）".to_owned(), "兩邊分歧前的版本".to_owned());
    match operation {
        Some(Operation::Merge) => [
            base,
            (
                format!(
                    "目前 branch（{}）",
                    current.unwrap_or_else(|| "HEAD".into())
                ),
                head,
            ),
            ("要合併進來的版本".into(), short(runner, repo, "MERGE_HEAD")),
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
                    "Rebase 目標（已重放的內容）".into(),
                    format!("{head}（onto {}）", &onto[..onto.len().min(7)]),
                ),
                ("正在重放的你的 commit".into(), replaying),
            ]
        }
        Some(Operation::CherryPick) => [
            base,
            ("目前 HEAD".into(), head),
            (
                "要 cherry-pick 的 commit".into(),
                short(runner, repo, "CHERRY_PICK_HEAD"),
            ),
        ],
        Some(Operation::Revert) => [
            base,
            ("目前 HEAD".into(), head),
            (
                "反向套用的 commit".into(),
                short(runner, repo, "REVERT_HEAD"),
            ),
        ],
        Some(Operation::Am) => [
            base,
            ("目前 HEAD".into(), head),
            ("正在套用的 patch".into(), String::new()),
        ],
        _ => [
            base,
            ("目前 HEAD（或更新後的內容）".into(), head),
            ("套用中的變更（例如 stash）".into(), String::new()),
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
            label: "結果（工作目錄檔案）".into(),
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
    let parent = target.parent().ok_or("路徑無效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("無法建立暫存檔：{e}"))?;
    temporary
        .write_all(bytes)
        .map_err(|e| format!("無法寫入：{e}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| format!("無法寫入：{e}"))?;
    if let Ok(meta) = fs::metadata(&target) {
        let _ = fs::set_permissions(temporary.path(), meta.permissions());
    }
    temporary
        .persist(&target)
        .map_err(|e| format!("無法儲存檔案：{}", e.error))?;
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
        return Err("內容過大".into());
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
            return Err("檔案仍含衝突標記；請先處理，或明確確認要保留標記".into());
        }
    }
    let mut invocation = Invocation::new(&repo.root_path, Access::Write, ["add", "-A", "--"]);
    invocation = invocation.arg(path_arg(path.as_bytes())?);
    runner.ok(invocation)?;
    Ok(Outcome {
        message: format!("已將 {} 標記為已解決", path.display()),
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
                message: format!("已刪除 {} 並標記為已解決", path.display()),
                recovery: None,
                conflicts: false,
            })
        }
        (Choice::KeepWorkTree, _) => {
            if work_bytes(repo, path)?.is_none() {
                return Err("工作目錄沒有此檔案；請改選其他版本或刪除".into());
            }
            runner.ok(Invocation::new(&repo.root_path, Access::Write, ["add", "--"]).arg(&arg))?;
            Ok(Outcome {
                message: format!("已保留工作目錄的 {}", path.display()),
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
                    return Err(format!("{} 已存在，未覆蓋", new_path.display()));
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
                message: format!("已採用版本並標記 {} 為已解決", target.display()),
                recovery: None,
                conflicts: false,
            })
        }
        _ => Err("此衝突沒有所選的版本".into()),
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
        return Err(format!("有進行中的 {operation:?} 操作"));
    }
    if super::remote::head(runner, repo)?.as_deref() != Some(expected_head) {
        return Err("HEAD 已在確認後變更，未合併".into());
    }
    if status::status(runner, repo)?
        .entries
        .iter()
        .any(|e| !e.untracked)
    {
        return Err("工作目錄有未提交的變更；請先 commit 或 stash，確保 abort 可完整還原".into());
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
            message: format!("已合併 {}", display_rev(rev)),
            recovery: None,
            conflicts: false,
        });
    }
    if status::operation(repo) == Some(Operation::Merge) {
        return Ok(Outcome {
            message: format!(
                "合併 {} 產生衝突；請在 Git 面板逐一解決後 continue，或 abort",
                display_rev(rev)
            ),
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
    let operation = status::operation(repo).ok_or("沒有進行中的操作")?;
    if operation == Operation::Bisect {
        return Err("Bisect 不支援 continue".into());
    }
    let state = status::status(runner, repo)?;
    if state.entries.iter().any(|e| e.conflict.is_some()) {
        return Err("仍有未解決的衝突檔案".into());
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
            message: "已完成並繼續".into(),
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
            message: "下一個 commit 也有衝突，請繼續解決".into(),
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
    let operation = status::operation(repo).ok_or("沒有進行中的操作")?;
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
    let label = format!("中止 {operation:?} 前");
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
        message: format!("已中止 {operation:?}，回到操作前狀態"),
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
