//! Bounded, read-only discovery of built-in provider history roots.
//! A readable root is a setup candidate, not evidence that it contains sessions.
use crate::models::AgentKind;
use crate::{models::HistorySource, providers};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
};

pub const MAX_ROOT_PATH_BYTES: usize = 4096;
pub const MAX_CONFIGURED_SOURCES: usize = 32;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HistorySourceCandidateStatus {
    Found,
    Missing,
    PermissionDenied,
    CheckFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistorySourceCandidate {
    pub kind: AgentKind,
    pub root: String,
    pub status: HistorySourceCandidateStatus,
    pub configured: bool,
    pub configured_source_ids: Vec<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistorySourceDiscovery {
    pub kind: AgentKind,
    pub supported: bool,
    pub candidates: Vec<HistorySourceCandidate>,
    pub message: Option<String>,
}

/// Explicit inputs keep tests isolated from global environment and real user data.
#[derive(Debug, Default)]
pub struct HistorySourceDiscoveryInputs {
    pub home: Option<PathBuf>,
    pub source_env: Option<PathBuf>,
}

pub fn detect_history_sources(
    kind: AgentKind,
    saved_sources: &[HistorySource],
) -> HistorySourceDiscovery {
    let provider = providers::definition(kind);
    // Unsupported providers must not even inspect their product data roots.
    if !provider.history.supported {
        return unsupported(kind);
    }
    let inputs = HistorySourceDiscoveryInputs {
        home: dirs::home_dir(),
        source_env: provider
            .history
            .source_env
            .as_ref()
            .and_then(std::env::var_os)
            .map(PathBuf::from),
    };
    discover_history_sources(kind, &inputs, saved_sources)
}

pub fn discover_history_sources(
    kind: AgentKind,
    inputs: &HistorySourceDiscoveryInputs,
    saved_sources: &[HistorySource],
) -> HistorySourceDiscovery {
    let provider = providers::definition(kind);
    if !provider.history.supported {
        return unsupported(kind);
    }

    // Settings validation caps this list at 32. Retain the bound for other callers.
    let mut configured: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for source in saved_sources.iter().take(MAX_CONFIGURED_SOURCES) {
        let path = PathBuf::from(&source.root);
        if source.kind == kind
            && valid_root(&path)
            && !source.id.is_empty()
            && source.id.len() <= 128
            && !source.id.contains('\0')
        {
            configured
                .entry(fs::canonicalize(&path).unwrap_or(path))
                .or_default()
                .push(source.id.clone());
        }
    }
    let default_root = inputs
        .home
        .as_ref()
        .map(|home| home.join(&provider.history.default_directory));
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    // Exactly two possible roots; no PATH scan, recursive walk, or transcript reads.
    for (origin, root) in inputs
        .source_env
        .iter()
        .filter(|_| provider.history.source_env.is_some())
        .map(|root| ("provider environment", root))
        .chain(default_root.iter().map(|root| ("home default", root)))
    {
        let (resolved, status, mut message) = check_root(root);
        if !seen.insert(resolved.clone()) {
            continue;
        }
        if status == HistorySourceCandidateStatus::Found {
            if let Some(directory) = &provider.history.probe_directory {
                let (_, nested_status, _) = check_root(&resolved.join(directory));
                message = match nested_status {
                    HistorySourceCandidateStatus::Found => None,
                    HistorySourceCandidateStatus::Missing => Some(format!(
                        "The root is readable, but the {directory} history directory does not exist yet. You can still add this root."
                    )),
                    HistorySourceCandidateStatus::PermissionDenied => Some(format!(
                        "The root is readable, but permission was denied for its {directory} history directory."
                    )),
                    HistorySourceCandidateStatus::CheckFailed => Some(format!(
                        "The root is readable, but its {directory} history directory could not be checked."
                    )),
                };
            }
        }
        let configured_source_ids = configured.get(&resolved).cloned().unwrap_or_default();
        candidates.push(HistorySourceCandidate {
            kind,
            configured: !configured_source_ids.is_empty(),
            configured_source_ids,
            // Rejected environment values must not become unbounded IPC payloads or
            // expose control/non-UTF-8 bytes through a lossy display path.
            root: if valid_root(&resolved) {
                resolved.to_string_lossy().into_owned()
            } else {
                format!("[invalid {origin} history root]")
            },
            status,
            message,
        });
    }
    let message = if candidates.is_empty() {
        Some("No home directory or provider source environment path is available.".into())
    } else {
        None
    };
    HistorySourceDiscovery {
        kind,
        supported: true,
        candidates,
        message,
    }
}

fn unsupported(kind: AgentKind) -> HistorySourceDiscovery {
    HistorySourceDiscovery {
        kind,
        supported: false,
        candidates: Vec::new(),
        message: Some(providers::definition(kind).history.description.clone()),
    }
}

fn valid_root(path: &Path) -> bool {
    #[cfg(windows)]
    if !crate::windows_fs::valid_filesystem_path(path) {
        return false;
    }
    path.is_absolute()
        && path.to_str().is_some_and(|value| {
            value.len() <= MAX_ROOT_PATH_BYTES && !value.chars().any(char::is_control)
        })
}

fn check_root(path: &Path) -> (PathBuf, HistorySourceCandidateStatus, Option<String>) {
    use HistorySourceCandidateStatus::{CheckFailed, Found};
    if !valid_root(path) {
        return (
            path.to_owned(),
            CheckFailed,
            Some("History roots must be absolute UTF-8 paths of at most 4096 bytes without control characters.".into()),
        );
    }
    let canonical = match fs::canonicalize(path) {
        Ok(path) => path,
        Err(error) => return failed_check(path.to_owned(), error),
    };
    if !valid_root(&canonical) {
        return (
            path.to_owned(),
            CheckFailed,
            Some("The resolved history root is not a supported absolute UTF-8 path.".into()),
        );
    }
    match readable_directory(&canonical) {
        Ok(true) => (canonical, Found, None),
        Ok(false) => (
            canonical,
            CheckFailed,
            Some("The history root exists but is not a directory.".into()),
        ),
        Err(error) => failed_check(canonical, error),
    }
}

fn readable_directory(path: &Path) -> io::Result<bool> {
    if !fs::metadata(path)?.is_dir() {
        return Ok(false);
    }
    // Open the directory solely to check read access. Do not enumerate its entries.
    drop(fs::read_dir(path)?);
    Ok(true)
}

fn failed_check(
    path: PathBuf,
    error: io::Error,
) -> (PathBuf, HistorySourceCandidateStatus, Option<String>) {
    use HistorySourceCandidateStatus::{CheckFailed, Missing, PermissionDenied};
    let (status, message) = match error.kind() {
        io::ErrorKind::NotFound => (Missing, "The history root does not exist.".into()),
        io::ErrorKind::PermissionDenied => (
            PermissionDenied,
            "Permission was denied while checking the history root.".into(),
        ),
        _ => (
            CheckFailed,
            format!("Cannot check the history root: {error}"),
        ),
    };
    (path, status, Some(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_failures_keep_missing_permissions_and_other_errors_distinct() {
        for (error, expected) in [
            (
                io::ErrorKind::NotFound,
                HistorySourceCandidateStatus::Missing,
            ),
            (
                io::ErrorKind::PermissionDenied,
                HistorySourceCandidateStatus::PermissionDenied,
            ),
            (
                io::ErrorKind::Other,
                HistorySourceCandidateStatus::CheckFailed,
            ),
        ] {
            let (_, status, message) = failed_check(PathBuf::from("/synthetic"), error.into());
            assert_eq!(status, expected);
            assert!(message.is_some());
        }
    }
}
