//! Untrusted terminal paths resolve only into the existing project read boundary.
use crate::{
    broker::RuntimeRecord,
    models::{TerminalFileCandidate, TerminalFileResolution, WorkspaceFileKind},
    workspace_files,
};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

pub(crate) fn launch_cwd(
    records: &[RuntimeRecord],
    project: &str,
    pane: &str,
    runtime: &str,
) -> Result<PathBuf, String> {
    if [project, pane, runtime]
        .iter()
        .any(|id| id.is_empty() || id.len() > 1024 || id.chars().any(char::is_control))
    {
        return Err("終端身分無效，請重新整理工作區".into());
    }
    records
        .iter()
        .find(|record| {
            record.info.id == runtime
                && record.info.pane_id == pane
                && record.project_id.as_deref() == Some(project)
        })
        .map(|record| PathBuf::from(&record.info.cwd))
        .ok_or_else(|| "終端所屬專案或身分已變更，請重新點選路徑".into())
}
fn validate(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 4096
        || path.chars().any(|c| c.is_control() || matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        || path.contains(['$', '`', ';', '|', '&', '<', '>', '"'])
    {
        return Err("路徑無效或含不支援字元；只接受檔案路徑，不接受命令或網址".into());
    }
    if path.starts_with(['~']) || path.starts_with("//") || path.starts_with('\\') {
        return Err("不支援家目錄縮寫、UNC、網路或裝置路徑；請選擇專案內檔案".into());
    }
    if path.split(['/', '\\']).any(|part| part == "..") {
        return Err("不支援含上層目錄的路徑；請使用專案內路徑".into());
    }
    Ok(())
}
fn drive_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}
fn absolute(path: &str) -> Result<bool, String> {
    if drive_absolute(path) {
        if !cfg!(windows) {
            return Err("Windows 磁碟路徑無法在目前主機解析".into());
        }
        return Ok(true);
    }
    if path.contains(':') || (!cfg!(windows) && path.contains('\\')) {
        return Err("不支援網址、磁碟相對路徑或此平台的路徑語法".into());
    }
    Ok(path.starts_with('/'))
}
// Pure lexical conversion, never canonicalize an untrusted path or follow links.
fn relative_to_root(root: &Path, path: &str) -> Option<String> {
    let root = root.to_str()?;
    #[cfg(windows)]
    let (root, path) = (
        root.strip_prefix(r"\\?\")
            .unwrap_or(root)
            .replace('\\', "/"),
        path.replace('\\', "/"),
    );
    #[cfg(not(windows))]
    let (root, path) = (root.to_owned(), path.to_owned());
    let root = root.trim_end_matches('/');
    let prefix = path.get(..root.len())?;
    let matches = if cfg!(windows) {
        prefix.eq_ignore_ascii_case(root)
    } else {
        prefix == root
    };
    if !matches {
        return None;
    }
    if path.len() == root.len() {
        return Some(String::new());
    }
    path.get(root.len()..)?.strip_prefix('/').map(str::to_owned)
}
fn relative_text(path: &str) -> Result<String, String> {
    #[cfg(windows)]
    let path = path.replace('\\', "/");
    #[cfg(not(windows))]
    let path = path.to_owned();
    let path = path.trim_start_matches("./");
    if path.is_empty()
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | "..") || part.contains(':'))
    {
        return Err("路徑必須指向專案內的一般檔案".into());
    }
    Ok(path.to_owned())
}
fn inspect(
    root: &Path,
    path: &str,
    from_launch_directory: bool,
) -> Result<TerminalFileCandidate, String> {
    validate(path)?;
    let info = workspace_files::inspect(root, path)?;
    if info.kind == WorkspaceFileKind::Binary {
        return Err("此檔案不是支援的文字或圖片".into());
    }
    Ok(TerminalFileCandidate {
        path: info.path,
        version: info.version,
        from_launch_directory,
    })
}
pub(crate) fn resolve(
    root: &Path,
    cwd: &Path,
    path: &str,
) -> Result<TerminalFileResolution, String> {
    validate(path)?;
    if absolute(path)? {
        let relative =
            relative_to_root(root, path).ok_or("路徑不在此終端所屬專案內，未開啟檔案")?;
        let relative = relative_text(&relative)?;
        return Ok(TerminalFileResolution {
            absolute: true,
            launch_directory: None,
            candidates: vec![inspect(root, &relative, false)?],
            truncated: false,
        });
    }
    let relative = relative_text(path)?;
    let launch_directory = cwd
        .to_str()
        .and_then(|cwd| relative_to_root(root, cwd))
        .filter(|base| base.is_empty() || relative_text(base).is_ok());
    let mut paths = Vec::new();
    if let Some(base) = &launch_directory {
        paths.push((
            if base.is_empty() {
                relative.clone()
            } else {
                format!("{base}/{relative}")
            },
            true,
        ));
    }
    paths.push((relative.clone(), false));
    let basename = relative.rsplit('/').next().unwrap();
    let mut truncated = basename.len() > 256;
    if !truncated {
        let search = workspace_files::search(root, basename)?;
        truncated = search.truncated;
        paths.extend(
            search
                .paths
                .into_iter()
                .filter(|candidate| {
                    candidate == &relative || candidate.ends_with(&format!("/{relative}"))
                })
                .map(|path| (path, false)),
        );
    }
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for (path, from_cwd) in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        if candidates.len() == 50 {
            truncated = true;
            break;
        }
        if let Ok(candidate) = inspect(root, &path, from_cwd) {
            candidates.push(candidate);
        }
    }
    Ok(TerminalFileResolution {
        absolute: false,
        launch_directory,
        candidates,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    /// Canonical path without the Windows `\\?\` verbatim prefix.
    fn real_path(path: &std::path::Path) -> std::path::PathBuf {
        let path = path.canonicalize().unwrap();
        #[cfg(windows)]
        if let Some(rest) = path.to_string_lossy().strip_prefix(r"\\?\") {
            if !rest.starts_with("UNC\\") {
                return std::path::PathBuf::from(rest);
            }
        }
        path
    }

    use super::*;
    use std::fs;
    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        // Without the Windows \\?\ prefix, which resolve() rejects as a device path.
        let root = real_path(dir.path());
        (dir, root)
    }
    #[test]
    fn absolute_unicode_space_parentheses_stays_scoped_and_versioned() {
        let (_dir, root) = root();
        let file = root.join("中文 file(test).ts");
        fs::write(&file, "safe text").unwrap();
        let result = resolve(&root, &root, file.to_str().unwrap()).unwrap();
        assert!(result.absolute);
        assert_eq!(result.candidates[0].path, "中文 file(test).ts");
        let old = result.candidates[0].version.clone();
        fs::write(&file, "changed and longer text").unwrap();
        assert_ne!(
            resolve(&root, &root, file.to_str().unwrap())
                .unwrap()
                .candidates[0]
                .version,
            old
        );
        assert!(resolve(&root, &root, root.to_str().unwrap()).is_err());
    }
    #[test]
    fn relative_and_bare_paths_always_require_choice_even_one_candidate() {
        let (_dir, root) = root();
        for path in ["a.rs", "src/a.rs", "other/a.rs"] {
            fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            fs::write(root.join(path), "synthetic").unwrap();
        }
        let result = resolve(&root, &root.join("src"), "a.rs").unwrap();
        assert!(!result.absolute);
        assert_eq!(result.launch_directory.as_deref(), Some("src"));
        assert_eq!(result.candidates[0].path, "src/a.rs");
        assert!(result.candidates[0].from_launch_directory);
        assert_eq!(result.candidates.len(), 3);
        let one = resolve(&root, &root, "./src/a.rs").unwrap();
        assert!(!one.absolute);
        assert_eq!(one.candidates.len(), 1);
        let unknown = resolve(&root, &root.parent().unwrap().join("outside"), "a.rs").unwrap();
        assert!(unknown.launch_directory.is_none());
        assert!(unknown
            .candidates
            .iter()
            .all(|file| !file.from_launch_directory));
    }
    #[test]
    fn outside_root_prefix_collision_traversal_protocols_and_commands_do_not_resolve() {
        let (_dir, root) = root();
        for path in [
            "../secret.txt",
            "src/../secret.txt",
            "file:///etc/passwd",
            "https://example.test/file.ts",
            "C:secret.txt",
            r"\\server\share\file.ts",
            r"\\?\C:\file.ts",
            "$(touch marker).ts",
            "file.ts;touch marker",
            "nul\0.txt",
            "~/.ssh/key",
        ] {
            assert!(resolve(&root, &root, path).is_err(), "{path}");
        }
        let collision = format!("{}-other/file.ts", root.display());
        assert!(resolve(&root, &root, &collision).is_err());
        assert!(resolve(&root, &root, "/etc/passwd").is_err());
        assert!(!root.join("marker").exists());
        #[cfg(not(windows))]
        assert!(resolve(&root, &root, r"C:\work\file.ts").is_err());
    }
    #[test]
    fn missing_directory_binary_and_search_limits_are_explicit() {
        let (_dir, root) = root();
        fs::create_dir(root.join("folder")).unwrap();
        fs::write(root.join("binary.bin"), [0, 1, 2]).unwrap();
        for name in ["missing.ts", "folder", "binary.bin"] {
            assert!(resolve(&root, &root, root.join(name).to_str().unwrap()).is_err());
        }
        for index in 0..60 {
            fs::create_dir(root.join(format!("d{index}"))).unwrap();
            fs::write(root.join(format!("d{index}/same.ts")), "test").unwrap();
        }
        let result = resolve(&root, &root, "same.ts").unwrap();
        assert!(result.truncated);
        assert!(result.candidates.len() <= 50);
        assert!(!result.absolute);
    }
    #[cfg(unix)]
    #[test]
    fn resolution_never_follows_symbolic_or_hard_links() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = root();
        fs::write(root.join("real.txt"), "synthetic").unwrap();
        symlink(root.join("real.txt"), root.join("link.txt")).unwrap();
        fs::hard_link(root.join("real.txt"), root.join("alias.txt")).unwrap();
        for name in ["link.txt", "alias.txt", "real.txt"] {
            assert!(resolve(&root, &root, root.join(name).to_str().unwrap()).is_err());
            assert!(resolve(&root, &root, name).unwrap().candidates.is_empty());
        }
    }
    #[test]
    fn terminal_identity_cannot_borrow_another_pane_or_project_cwd() {
        let record: RuntimeRecord = serde_json::from_value(serde_json::json!({
            "id":"runtime", "paneId":"pane", "projectId":"project", "sessionId":null,
            "state":"running", "cwd":"/synthetic/project", "exitCode":null, "kind":"shell",
            "profileId":null, "resumeId":null
        }))
        .unwrap();
        let records = [record];
        assert_eq!(
            launch_cwd(&records, "project", "pane", "runtime").unwrap(),
            PathBuf::from("/synthetic/project")
        );
        for (project, pane, runtime) in [
            ("other", "pane", "runtime"),
            ("project", "other", "runtime"),
            ("project", "pane", "other"),
        ] {
            assert!(launch_cwd(&records, project, pane, runtime).is_err());
        }
    }
}
