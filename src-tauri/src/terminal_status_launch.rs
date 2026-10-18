//! Native, launch-local terminal-status capability selection. Never rewrites CLI
//! arguments, cwd, session/resume/fork selection, permissions, or configuration.
use crate::{models::AgentKind, runtime::LaunchSpec};

pub fn supported_version(kind: AgentKind, output: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(output) else {
        return false;
    };
    let versions: Vec<_> = text
        .split_ascii_whitespace()
        .filter_map(|word| {
            let word = word.strip_prefix('v').unwrap_or(word);
            let parts: Vec<_> = word.split('.').collect();
            if parts.len() != 3
                || parts.iter().any(|p| {
                    p.is_empty()
                        || !p.bytes().all(|b| b.is_ascii_digit())
                        || (p.len() > 1 && p.starts_with('0'))
                })
            {
                return None;
            }
            parts
                .iter()
                .map(|p| p.parse::<u32>())
                .collect::<Result<Vec<_>, _>>()
                .ok()
        })
        .collect();
    let [version] = versions.as_slice() else {
        return false;
    };
    match kind {
        AgentKind::Codex => version[0] == 0 && version.as_slice() >= [0, 163, 0].as_slice(),
        AgentKind::Grok => version[0] == 1 && version.as_slice() >= [1, 0, 52].as_slice(),
        AgentKind::Antigravity => version[0] == 1 && version.as_slice() >= [1, 4, 0].as_slice(),
        _ => false,
    }
}
#[cfg(unix)]
pub fn prepare(kind: AgentKind, spec: &mut LaunchSpec) -> Result<bool, String> {
    use crate::runtime::{RuntimeManager, TerminalEvent};
    use std::{
        os::unix::fs::PermissionsExt,
        sync::{mpsc, Arc},
        time::{Duration, Instant},
    };
    let directory = tempfile::Builder::new()
        .prefix("sessionbay-status-version-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .map_err(|_| "Cannot create isolated version probe")?;
    let mut env = std::collections::HashMap::new();
    for key in [
        "HOME",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "TMPDIR",
        "CODEX_HOME",
        "GROK_HOME",
    ] {
        env.insert(key.into(), directory.path().to_string_lossy().into_owned());
    }
    env.insert("AGY_CLI_DISABLE_AUTO_UPDATE".into(), "true".into());
    if let Some(path) = spec
        .env
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok())
    {
        env.insert("PATH".into(), path);
    }
    let runtime = RuntimeManager::new();
    let (sender, receiver) = mpsc::channel();
    let info = runtime.launch_isolated(
        LaunchSpec {
            executable: spec.executable.clone(),
            args: vec!["--version".into()],
            cwd: directory.path().to_owned(),
            env,
            session_id: None,
            resume_key: None,
            pane_id: "terminal-status-version".into(),
        },
        80,
        24,
        Arc::new(move |event| {
            sender
                .send(event)
                .map_err(|_| "Version probe receiver closed".into())
        }),
    )?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let result = (|| {
        let mut output = Vec::new();
        loop {
            if Instant::now() >= deadline {
                return Err("Provider version probe timed out");
            }
            match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(TerminalEvent::Output {
                    runtime_id,
                    sequence,
                    data,
                }) => {
                    runtime
                        .ack(&runtime_id, sequence)
                        .map_err(|_| "Cannot acknowledge provider version")?;
                    if output.len() + data.len() > 8192 {
                        return Err("Provider version exceeds limit");
                    }
                    output.extend(data);
                }
                Ok(TerminalEvent::Exit {
                    exit_code: Some(0), ..
                }) => return Ok(output),
                Ok(TerminalEvent::Exit { .. } | TerminalEvent::Error { .. }) => {
                    return Err("Provider version probe failed")
                }
                Err(_) => return Err("Provider version probe timed out"),
            }
        }
    })();
    // Shared PTY supervision retains waitable ownership until every managed
    // process group is cleaned. Never signal a reaped or guessed PID here.
    runtime.stop(&info.id)?;
    runtime.shutdown()?;
    let supported = supported_version(kind, &result.map_err(str::to_owned)?);
    if supported && kind == AgentKind::Antigravity {
        spec.env.insert("AGY_CLI_OSC7501".into(), "on".into());
        spec.env
            .insert("AGY_CLI_OSC7501_MESSAGES".into(), "brief".into());
    }
    Ok(supported)
}
#[cfg(not(unix))]
pub fn prepare(_: AgentKind, _: &mut LaunchSpec) -> Result<bool, String> {
    Ok(false)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_reviewed_stable_major_versions_enable_status() {
        for (kind, accepted, denied) in [
            (AgentKind::Codex, "codex-cli 0.163.0", "codex-cli 0.162.0"),
            (AgentKind::Grok, "grok 1.0.52", "grok 1.0.51"),
            (AgentKind::Antigravity, "agy 1.4.1", "agy 1.3.5"),
        ] {
            assert!(supported_version(kind, accepted.as_bytes()));
            assert!(!supported_version(kind, denied.as_bytes()));
            assert!(!supported_version(kind, b"2.0.0"));
            assert!(!supported_version(kind, b"1.4.0-beta"));
            assert!(!supported_version(kind, b"1.4.0 1.4.1"));
        }
    }
    #[cfg(unix)]
    fn synthetic_spec(root: &std::path::Path, body: &str) -> LaunchSpec {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join("synthetic-provider");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        LaunchSpec {
            executable: path.to_string_lossy().into_owned(),
            args: vec![
                "resume".into(),
                "native-id".into(),
                "--sandbox".into(),
                "read-only".into(),
            ],
            cwd: root.into(),
            env: std::collections::HashMap::from([(
                "SYNTHETIC_PRIVATE_VALUE".into(),
                "do-not-inherit".into(),
            )]),
            session_id: None,
            resume_key: None,
            pane_id: "fixture".into(),
        }
    }
    #[cfg(unix)]
    #[test]
    fn version_probe_is_isolated_and_native_argv_policy_is_untouched() {
        let root = tempfile::tempdir().unwrap();
        let mut spec = synthetic_spec(root.path(), "[ \"$1\" = --version ] || exit 2; [ -z \"$SYNTHETIC_PRIVATE_VALUE\" ] || exit 3; [ \"$HOME\" = \"$CODEX_HOME\" ] || exit 4; printf 'codex-cli 0.163.0\\n'");
        let original = serde_json::to_value(&spec).unwrap();
        assert!(prepare(AgentKind::Codex, &mut spec).unwrap());
        assert_eq!(serde_json::to_value(&spec).unwrap(), original);
    }
    #[cfg(unix)]
    #[test]
    fn version_probe_timeout_and_output_flood_are_bounded() {
        let root = tempfile::tempdir().unwrap();
        let mut spec = synthetic_spec(root.path(), "exec sleep 30");
        let started = std::time::Instant::now();
        assert!(prepare(AgentKind::Grok, &mut spec)
            .unwrap_err()
            .contains("timed out"));
        assert!(started.elapsed() < std::time::Duration::from_secs(8));
        let mut spec = synthetic_spec(
            root.path(),
            "while :; do printf '0123456789012345678901234567890123456789'; done",
        );
        assert!(prepare(AgentKind::Grok, &mut spec)
            .unwrap_err()
            .contains("limit"));
    }
}
