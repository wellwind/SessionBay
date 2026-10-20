//! Launch-local Claude Code mod for authoritative main-turn lifecycle reports.
//! No global settings or source transcripts are read or written.
use crate::{provider_hooks, runtime::LaunchSpec};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, OnceLock},
};
#[cfg(unix)]
use std::{
    io::Read,
    process::Stdio,
    time::{Duration, Instant},
};
use tempfile::TempDir;

const MODULE: &str = include_str!("claude_state_mod.js");
const HELPER: &str = "SESSIONBAY_CLAUDE_STATE_HELPER";
const SEQUENCE: &str = "SESSIONBAY_CLAUDE_STATE_SEQUENCE";
#[cfg(unix)]
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(unix)]
const MAX_VERSION_BYTES: usize = 8192;
static PLUGINS: OnceLock<Mutex<HashMap<String, TempDir>>> = OnceLock::new();

fn plugins() -> &'static Mutex<HashMap<String, TempDir>> {
    PLUGINS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn supported_version(output: &[u8]) -> bool {
    let Ok(output) = std::str::from_utf8(output) else {
        return false;
    };
    let Some(version) = output.split_whitespace().next() else {
        return false;
    };
    let components = version
        .split('.')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>();
    matches!(components, Ok(ref v) if v.len() == 3 && v.as_slice() >= [2, 1, 287].as_slice())
}

#[cfg(unix)]
fn drain_version(stdout: &mut impl Read, output: &mut Vec<u8>) -> Result<(), String> {
    let mut chunk = [0u8; 1024];
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) => return Ok(()),
            Ok(n) => {
                if output.len() + n > MAX_VERSION_BYTES {
                    return Err("Claude Code version output exceeds limit".into());
                }
                output.extend_from_slice(&chunk[..n]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Cannot read Claude Code version".into()),
        }
    }
}

#[cfg(unix)]
fn version(spec: &LaunchSpec) -> Result<Vec<u8>, String> {
    use std::os::fd::AsRawFd;
    let mut child = crate::host_environment::command(&spec.executable)?
        .arg("--version")
        .current_dir(&spec.cwd)
        .envs(&spec.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Cannot check Claude Code version".to_string())?;
    let mut stdout = child.stdout.take().expect("stdout was piped");
    let result = (|| {
        let fd = stdout.as_raw_fd();
        // The pipe belongs to this child. Nonblocking reads keep an inherited
        // writer or misbehaving --version from holding launch indefinitely.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err("Cannot read Claude Code version".to_string());
        }
        let started = Instant::now();
        let mut output = Vec::new();
        loop {
            drain_version(&mut stdout, &mut output)?;
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "Cannot check Claude Code version")?
            {
                // Exit may race the read above; consume the final pipe bytes.
                drain_version(&mut stdout, &mut output)?;
                return status
                    .success()
                    .then_some(output)
                    .ok_or_else(|| "Claude Code version check failed".into());
            }
            if started.elapsed() >= VERSION_TIMEOUT {
                return Err("Claude Code version check timed out".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

#[cfg(not(unix))]
fn version(_spec: &LaunchSpec) -> Result<Vec<u8>, String> {
    Err("Claude state reporting currently requires Unix".into())
}

/// Call after the broker installs the launch-local routing environment.
/// The owner MUST call `cleanup` on launch failure and runtime exit/revocation.
pub fn prepare(spec: &mut LaunchSpec, helper: &Path) -> Result<(), String> {
    let output = version(spec)?;
    if !supported_version(&output) {
        return Err("即時 Claude 狀態需要 Claude Code 2.1.287 或更新版本；請更新後再啟用".into());
    }
    install(spec, helper)
}

fn install(spec: &mut LaunchSpec, helper: &Path) -> Result<(), String> {
    let launch = spec
        .env
        .get(provider_hooks::LAUNCH)
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or("Missing Claude state launch identity")?
        .clone();
    let helper = helper
        .to_str()
        .filter(|value| helper.is_absolute() && !value.chars().any(char::is_control))
        .ok_or("Claude state helper must have a safe absolute path")?
        .to_string();
    let mut plugins = plugins()
        .lock()
        .map_err(|_| "Claude plugin registry unavailable")?;
    if plugins.contains_key(&launch) {
        return Err("Claude state launch is already prepared".into());
    }
    let mut builder = tempfile::Builder::new();
    builder.prefix("sessionbay-claude-state-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let directory = builder
        .tempdir()
        .map_err(|_| "Cannot create private Claude plugin directory")?;
    let path = directory.path();
    let plugin_path = path
        .to_str()
        .ok_or("Claude plugin path is not UTF-8")?
        .to_string();
    std::fs::create_dir(path.join(".claude-plugin"))
        .and_then(|()| std::fs::create_dir(path.join("hooks")))
        .and_then(|()| std::fs::write(path.join(".claude-plugin/plugin.json"),
            r#"{"name":"sessionbay-state","version":"1.0.0","description":"Reports main-turn lifecycle metadata to this SessionBay launch"}"#))
        .and_then(|()| std::fs::write(path.join("hooks/hooks.json"), r#"{"modules":["./register.js"]}"#))
        .and_then(|()| std::fs::write(path.join("hooks/register.js"), MODULE))
        .map_err(|_| "Cannot write launch-local Claude plugin")?;
    spec.args.extend(["--plugin-dir".into(), plugin_path]);
    spec.env.insert(HELPER.into(), helper);
    spec.env.insert(SEQUENCE.into(), "0".into());
    plugins.insert(launch, directory);
    Ok(())
}

/// Removes only the TempDir created for this exact launch; never accepts a path
/// supplied by a provider callback. Idempotent for failure/exit races.
pub fn cleanup(launch: &str) {
    if let Ok(mut plugins) = plugins().lock() {
        plugins.remove(launch);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn spec() -> LaunchSpec {
        LaunchSpec {
            executable: "claude".into(),
            args: vec!["--resume".into(), "synthetic-session".into()],
            cwd: std::env::temp_dir(),
            env: HashMap::from([(
                provider_hooks::LAUNCH.into(),
                uuid::Uuid::new_v4().to_string(),
            )]),
            session_id: None,
            resume_key: None,
            pane_id: "synthetic-pane".into(),
        }
    }
    #[test]
    fn gates_supported_stable_versions() {
        for version in ["2.1.287 (Claude Code)\n", "2.1.300 (Claude Code)", "3.0.0"] {
            assert!(supported_version(version.as_bytes()), "{version}");
        }
        for version in [
            "2.1.286 (Claude Code)",
            "2.1.287-beta",
            "2.1",
            "Claude 2.1.287",
            "2.1.287.1",
            "",
            "999999999999.0.0",
        ] {
            assert!(!supported_version(version.as_bytes()), "{version}");
        }
    }
    #[test]
    fn plugin_is_launch_local_metadata_only_and_cleaned() {
        let mut spec = spec();
        let original_args = spec.args.clone();
        let launch = spec.env[provider_hooks::LAUNCH].clone();
        let helper = std::env::current_exe().unwrap();
        install(&mut spec, &helper).unwrap();
        assert_eq!(&spec.args[..original_args.len()], original_args.as_slice());
        let path = std::path::PathBuf::from(spec.args.last().unwrap());
        assert_eq!(
            std::fs::read_to_string(path.join("hooks/register.js")).unwrap(),
            MODULE
        );
        assert!(!MODULE.contains(&launch));
        assert!(!MODULE.contains("e.answer") && !MODULE.contains("e.text"));
        assert_eq!(spec.env[SEQUENCE], "0");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o077,
                0
            );
        }
        assert!(install(&mut spec, Path::new("/synthetic/helper")).is_err());
        cleanup(&launch);
        cleanup(&launch);
        assert!(!path.exists());
    }
    #[test]
    fn rejects_missing_launch_and_relative_helper_atomically() {
        let mut spec = spec();
        let before = spec.args.clone();
        assert!(install(&mut spec, Path::new("relative/helper")).is_err());
        spec.env.remove(provider_hooks::LAUNCH);
        assert!(install(&mut spec, Path::new("/synthetic/helper")).is_err());
        assert_eq!(spec.args, before);
    }

    #[cfg(unix)]
    fn fake_provider(directory: &Path, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let executable = directory.join("synthetic-claude");
        std::fs::write(&executable, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        executable.to_str().unwrap().to_owned()
    }

    #[cfg(unix)]
    #[test]
    fn prepare_probes_only_version_and_rejects_old_versions_without_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let mut spec = spec();
        spec.executable = fake_provider(
            directory.path(),
            "[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 7\nprintf '2.1.287 (Claude Code)\\n'",
        );
        let launch = spec.env[provider_hooks::LAUNCH].clone();
        prepare(&mut spec, Path::new("/synthetic/helper")).unwrap();
        cleanup(&launch);
        let mut old = super::tests::spec();
        old.executable = fake_provider(directory.path(), "printf '2.1.286 (Claude Code)\\n'");
        let before = serde_json::to_string(&old).unwrap();
        assert!(prepare(&mut old, Path::new("/synthetic/helper"))
            .unwrap_err()
            .contains("2.1.287"));
        assert_eq!(serde_json::to_string(&old).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn version_probe_bounds_output_and_wait_time() {
        let directory = tempfile::tempdir().unwrap();
        let mut spec = spec();
        spec.executable = fake_provider(directory.path(), "printf '%9000s' x");
        assert!(version(&spec).unwrap_err().contains("limit"));
        spec.executable = fake_provider(directory.path(), "exec sleep 10");
        let started = Instant::now();
        assert!(version(&spec).unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
