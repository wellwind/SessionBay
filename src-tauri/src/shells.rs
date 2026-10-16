//! Read-only shell candidates. Discovery never starts a shell or changes profiles.
//! An executable candidate does not establish that login/startup configuration works.

use serde::{Deserialize, Serialize};
#[cfg(not(windows))]
use std::fs::OpenOptions;
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const MAX_SHELL_LIST_BYTES: usize = 64 * 1024;
pub const MAX_SHELL_LIST_LINES: usize = 128;
pub const MAX_SEARCH_DIRECTORIES: usize = 32;
pub const MAX_CANDIDATE_PROBES: usize = 256;
pub const MAX_SHELL_CANDIDATES: usize = 64;
pub const MAX_SAVED_EXECUTABLES: usize = 32;
pub const MAX_SAVED_SEARCH_DIRECTORIES: usize = 128;
pub const MAX_SAVED_EXECUTABLE_PROBES: usize = 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_PATH_ENV_BYTES: usize = 64 * 1024;
#[cfg(not(windows))]
const COMMON_SHELLS: &[&str] = &[
    "zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu",
];
#[cfg(windows)]
const COMMON_SHELLS: &[&str] = &[
    "pwsh.exe",
    "powershell.exe",
    "cmd.exe",
    "nu.exe",
    "bash.exe",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellCandidate {
    pub name: String,
    pub executable: String,
}

/// Explicit inputs keep discovery independent of ambient environment in tests.
/// Saved executable strings are read-only exclusion inputs. Profile names,
/// arguments, environment, defaults, startup files, and history are never inputs.
#[derive(Debug, Default)]
pub struct ShellDiscoveryInputs {
    pub shells_file: Option<PathBuf>,
    pub current_shell: Option<PathBuf>,
    pub path: Option<OsString>,
    #[cfg(windows)]
    pub pathext: Option<OsString>,
    pub standard_directories: Vec<PathBuf>,
    pub saved_executables: Vec<String>,
    /// Fallbacks after PATH, in the same order as config::resolve_executable.
    pub profile_fallback_directories: Vec<PathBuf>,
}

pub fn detect_shells(saved_executables: &[String]) -> Vec<ShellCandidate> {
    let profile_fallback_directories = crate::config::executable_fallback_directories();
    #[cfg(windows)]
    let standard_directories = profile_fallback_directories.clone();
    #[cfg(not(windows))]
    let standard_directories = [
        "/bin",
        "/usr/bin",
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/run/current-system/sw/bin",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    discover_shells(&ShellDiscoveryInputs {
        shells_file: if cfg!(windows) {
            None
        } else {
            Some(PathBuf::from("/etc/shells"))
        },
        current_shell: std::env::var_os(if cfg!(windows) { "COMSPEC" } else { "SHELL" })
            .map(PathBuf::from),
        path: std::env::var_os("PATH"),
        #[cfg(windows)]
        pathext: std::env::var_os("PATHEXT"),
        standard_directories,
        saved_executables: saved_executables
            .iter()
            .take(MAX_SAVED_EXECUTABLES + 1)
            .cloned()
            .collect(),
        profile_fallback_directories,
    })
}

/// Read a bounded system list and probe only absolute, known candidate paths.
/// Each candidate uses at most one canonicalization and one metadata query.
pub fn discover_shells(inputs: &ShellDiscoveryInputs) -> Vec<ShellCandidate> {
    let shell_list = inputs
        .shells_file
        .as_deref()
        .and_then(read_shell_list)
        .unwrap_or_default();
    discover_with_probe(inputs, &shell_list, executable_identity)
}

fn valid_path(path: &Path) -> bool {
    #[cfg(windows)]
    if !crate::windows_fs::valid_filesystem_path(path) {
        return false;
    }
    path.is_absolute()
        && path.to_str().is_some_and(|value| {
            value.len() <= MAX_PATH_BYTES && !value.chars().any(char::is_control)
        })
}

fn read_shell_list(path: &Path) -> Option<String> {
    if !valid_path(path) {
        return None;
    }
    #[cfg(not(windows))]
    let file = {
        let mut options = OpenOptions::new();
        options.read(true);
        // Avoid following substituted links or blocking on a FIFO/device. Check the
        // opened handle's type, not a racy pre-open metadata result.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
        }
        options.open(path).ok()?
    };
    #[cfg(windows)]
    let file = crate::windows_fs::open_regular_readonly_nofollow(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SHELL_LIST_BYTES as u64 {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_SHELL_LIST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAX_SHELL_LIST_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn executable_identity(path: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path).ok()?;
    if !valid_path(&canonical) {
        return None;
    }
    let metadata = fs::metadata(&canonical).ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        (metadata.permissions().mode() & 0o111 != 0).then_some(canonical)
    }
    #[cfg(windows)]
    {
        crate::config::is_windows_native_executable(path).then_some(canonical)
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

/// Resolve saved commands without executing anything. A bounded, incomplete
/// resolution fails closed so we never advertise a possibly already-saved target.
fn saved_canonical_targets(
    inputs: &ShellDiscoveryInputs,
    probe: &mut impl FnMut(&Path) -> Option<PathBuf>,
) -> Option<HashSet<PathBuf>> {
    if inputs.saved_executables.len() > MAX_SAVED_EXECUTABLES {
        return None;
    }
    #[cfg(windows)]
    let extensions = crate::config::windows_extensions(inputs.pathext.as_deref());
    #[cfg(not(windows))]
    let extensions = Vec::new();
    let mut targets = HashSet::new();
    let mut cache: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();
    let mut probes = 0;
    let mut checked_probe = |path: &Path| -> Option<Option<PathBuf>> {
        if let Some(result) = cache.get(path) {
            return Some(result.clone());
        }
        if probes >= MAX_SAVED_EXECUTABLE_PROBES {
            return None;
        }
        probes += 1;
        let result = probe(path);
        cache.insert(path.to_owned(), result.clone());
        Some(result)
    };
    for value in &inputs.saved_executables {
        if value.is_empty() || value.len() > MAX_PATH_BYTES || value.contains('\0') {
            continue;
        }
        let executable = Path::new(value);
        if executable.is_absolute() {
            for candidate in crate::config::executable_candidates(executable, &extensions) {
                if let Some(target) = checked_probe(&candidate)? {
                    targets.insert(target);
                    break;
                }
            }
        } else if executable.components().count() <= 1 {
            let path = inputs.path.as_deref().unwrap_or_default();
            if path.len() > MAX_PATH_ENV_BYTES {
                return None;
            }
            // Match launch resolution: PATH first, then home and standard bins.
            // Inspect one extra entry to distinguish exhaustion from truncation.
            let directories = std::env::split_paths(path)
                .chain(inputs.profile_fallback_directories.iter().cloned());
            let mut seen = HashSet::new();
            'directories: for (index, directory) in directories
                .take(MAX_SAVED_SEARCH_DIRECTORIES + 1)
                .enumerate()
            {
                if index == MAX_SAVED_SEARCH_DIRECTORIES {
                    return None;
                }
                if !directory.is_absolute() || !seen.insert(directory.clone()) {
                    continue;
                }
                for candidate in
                    crate::config::executable_candidates(&directory.join(executable), &extensions)
                {
                    if candidate.as_os_str().len() > MAX_PATH_BYTES {
                        // An uninspected earlier executable could shadow later ones.
                        return None;
                    }
                    if let Some(target) = checked_probe(&candidate)? {
                        targets.insert(target);
                        break 'directories;
                    }
                }
            }
        }
    }
    Some(targets)
}

fn discover_with_probe(
    inputs: &ShellDiscoveryInputs,
    shell_list: &str,
    mut probe: impl FnMut(&Path) -> Option<PathBuf>,
) -> Vec<ShellCandidate> {
    let Some(mut seen_canonical) = saved_canonical_targets(inputs, &mut probe) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut probes = 0;
    let mut consider = |path: &Path| {
        if candidates.len() >= MAX_SHELL_CANDIDATES
            || probes >= MAX_CANDIDATE_PROBES
            || !valid_path(path)
            || !seen_paths.insert(path.to_owned())
        {
            return;
        }
        probes += 1;
        let Some(canonical) = probe(path) else {
            return;
        };
        if !seen_canonical.insert(canonical) {
            return;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return;
        };
        // Keep the original absolute spelling: invoking a symlink such as sh
        // may intentionally differ from invoking its canonical target directly.
        candidates.push(ShellCandidate {
            name: name.into(),
            executable: path.to_str().expect("validated UTF-8 path").into(),
        });
    };
    if let Some(path) = &inputs.current_shell {
        consider(path);
    }
    if shell_list.len() <= MAX_SHELL_LIST_BYTES {
        for line in shell_list.lines().take(MAX_SHELL_LIST_LINES) {
            let line = line.trim();
            if !line.is_empty() && !line.starts_with('#') {
                // A line is a literal path, never a shell command or arg list.
                consider(Path::new(line));
            }
        }
    }
    let path = inputs
        .path
        .as_deref()
        .filter(|value| value.len() <= MAX_PATH_ENV_BYTES)
        .unwrap_or_default();
    let mut seen_directories = HashSet::new();
    for directory in inputs
        .standard_directories
        .iter()
        .cloned()
        .chain(std::env::split_paths(path))
        .take(MAX_SEARCH_DIRECTORIES)
    {
        if valid_path(&directory) && seen_directories.insert(directory.clone()) {
            for shell in COMMON_SHELLS {
                consider(&directory.join(shell));
            }
        }
    }
    candidates
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn metadata_probe_budget_is_enforced_even_for_missing_files() {
        let input = ShellDiscoveryInputs {
            current_shell: Some("/current/shell".into()),
            standard_directories: (0..100).map(|i| format!("/bin-{i}").into()).collect(),
            ..Default::default()
        };
        let list: String = (0..MAX_SHELL_LIST_LINES)
            .map(|i| format!("/missing-{i}\n"))
            .collect();
        let mut calls = 0;
        let found = discover_with_probe(&input, &list, |_| {
            calls += 1;
            None
        });
        assert!(found.is_empty());
        assert_eq!(calls, MAX_CANDIDATE_PROBES);
    }

    #[test]
    fn duplicate_and_relative_paths_do_not_consume_probe_budget() {
        let input = ShellDiscoveryInputs {
            current_shell: Some("/bin/bash".into()),
            path: Some(".:relative::/bin:/bin".into()),
            standard_directories: vec!["/bin".into()],
            ..Default::default()
        };
        let mut calls = Vec::new();
        discover_with_probe(&input, "/bin/bash\nrelative\n", |path| {
            calls.push(path.to_owned());
            None
        });
        assert_eq!(calls.len(), COMMON_SHELLS.len());
        assert!(calls.iter().all(|path| path.is_absolute()));
    }

    #[test]
    fn saved_resolution_has_an_independent_probe_budget_and_fails_closed() {
        let input = ShellDiscoveryInputs {
            current_shell: Some("/available/shell".into()),
            saved_executables: (0..MAX_SAVED_EXECUTABLES)
                .map(|i| format!("saved-{i}"))
                .collect(),
            profile_fallback_directories: (0..64)
                .map(|i| format!("/profile-bin-{i}").into())
                .collect(),
            ..Default::default()
        };
        let mut calls = 0;
        let found = discover_with_probe(&input, "", |_| {
            calls += 1;
            None
        });
        assert!(found.is_empty());
        assert_eq!(calls, MAX_SAVED_EXECUTABLE_PROBES);
    }
}
