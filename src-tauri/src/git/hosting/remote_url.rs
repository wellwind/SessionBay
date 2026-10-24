//! Maps Git remote URLs to a host and project path.
//!
//! Handles scp-like SSH (`git@host:group/repo.git`), `ssh://` with ports,
//! HTTPS with ports or a GitLab relative root, nested GitLab subgroups and
//! SSH config aliases (resolved with `ssh -G`, which never connects).
use serde::Serialize;
use std::{process::Command, time::Duration};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedRemote {
    pub scheme: String,
    /// Host as written in the URL (may be an SSH alias).
    pub host: String,
    /// Host after SSH alias resolution.
    pub resolved_host: String,
    pub port: Option<u16>,
    /// `group/subgroup/repo`, without `.git`.
    pub path: String,
}

fn trim_path(path: &str) -> String {
    let path = path.trim_matches('/');
    path.strip_suffix(".git")
        .unwrap_or(path)
        .trim_matches('/')
        .to_owned()
}

/// Splits `user@host:port` into host and port.
fn authority(value: &str) -> (String, Option<u16>) {
    let without_user = value
        .rsplit_once('@')
        .map(|(_, rest)| rest)
        .unwrap_or(value);
    if let Some(rest) = without_user.strip_prefix('[') {
        if let Some((host, tail)) = rest.split_once(']') {
            return (
                host.to_owned(),
                tail.strip_prefix(':').and_then(|p| p.parse().ok()),
            );
        }
    }
    match without_user.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() => {
            (host.to_owned(), port.parse().ok())
        }
        _ => (without_user.to_owned(), None),
    }
}

pub fn parse(url: &str) -> Option<ParsedRemote> {
    let url = url.trim();
    if url.is_empty() || url.chars().any(char::is_control) {
        return None;
    }
    if let Some((scheme, rest)) = url.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if !matches!(
            scheme.as_str(),
            "https" | "http" | "ssh" | "git" | "git+ssh" | "ssh+git"
        ) {
            return None;
        }
        let (auth, path) = rest.split_once('/').unwrap_or((rest, ""));
        let (host, port) = authority(auth);
        let path = trim_path(path);
        if host.is_empty() || path.is_empty() {
            return None;
        }
        return Some(ParsedRemote {
            scheme,
            resolved_host: host.to_lowercase(),
            host: host.to_lowercase(),
            port,
            path,
        });
    }
    // scp-like: [user@]host:path — but not a Windows drive or local path.
    let (auth, path) = url.split_once(':')?;
    if auth.contains('/') || auth.len() == 1 || path.starts_with("//") {
        return None;
    }
    let host = auth.rsplit_once('@').map(|(_, h)| h).unwrap_or(auth);
    let path = trim_path(path);
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(ParsedRemote {
        scheme: "ssh".into(),
        host: host.to_lowercase(),
        resolved_host: host.to_lowercase(),
        port: None,
        path,
    })
}

/// Resolves an SSH alias's `HostName`/`Port` without opening a connection.
pub fn resolve_ssh_alias(remote: &mut ParsedRemote) {
    if !remote.scheme.contains("ssh") {
        return;
    }
    let Ok(mut child) = Command::new("ssh")
        .args(["-G", "--", &remote.host])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return;
    };
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(3) {
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
        return;
    }
    let Ok(output) = child.wait_with_output() else {
        return;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(name) = line.strip_prefix("hostname ") {
            remote.resolved_host = name.trim().to_lowercase();
        } else if let Some(port) = line.strip_prefix("port ") {
            if remote.port.is_none() {
                remote.port = port.trim().parse().ok().filter(|p| *p != 22);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_remote_forms() {
        let scp = parse("git@github.com:Owner/Repo.git").unwrap();
        assert_eq!(
            (scp.host.as_str(), scp.path.as_str()),
            ("github.com", "Owner/Repo")
        );
        let ssh = parse("ssh://git@gitlab.example.test:2222/group/sub/project.git").unwrap();
        assert_eq!(
            (ssh.host.as_str(), ssh.port, ssh.path.as_str()),
            ("gitlab.example.test", Some(2222), "group/sub/project")
        );
        let https = parse("https://oauth2:secret@gitlab.example.test:8443/a/b/c/").unwrap();
        assert_eq!(
            (https.host.as_str(), https.port, https.path.as_str()),
            ("gitlab.example.test", Some(8443), "a/b/c")
        );
        let alias = parse("work-gh:team/app").unwrap();
        assert_eq!(alias.host, "work-gh");
        assert!(parse("/local/path/repo.git").is_none());
        assert!(parse("C:\\repos\\x").is_none());
        assert!(parse("file:///tmp/x.git").is_none());
    }
}
