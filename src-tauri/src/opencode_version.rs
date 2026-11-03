//! Isolated OpenCode CLI version detection for cleanup and executable discovery.
use crate::{runtime::LaunchSpec, tr};
use std::{collections::HashMap, path::Path};
#[cfg(unix)]
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[cfg(unix)]
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(unix)]
const MAX_VERSION_BYTES: usize = 8192;

/// Accept only the two version-output formats verified with official binaries.
pub(crate) fn parse_version(output: &[u8]) -> Option<[u32; 3]> {
    let text = std::str::from_utf8(output).ok()?.trim();
    let text = text.strip_prefix("opencode v").unwrap_or(text);
    let parts = text.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts.iter().any(|s| {
            s.is_empty()
                || !s.bytes().all(|b| b.is_ascii_digit())
                || (s.len() > 1 && s.starts_with('0'))
        })
    {
        return None;
    }
    Some([
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ])
}

pub(crate) fn cli_major(executable: &Path) -> Result<u32, String> {
    let spec = LaunchSpec {
        executable: executable.to_string_lossy().into_owned(),
        args: vec![],
        cwd: std::env::temp_dir(),
        env: HashMap::new(),
        session_id: None,
        resume_key: None,
        pane_id: String::new(),
    };
    match parse_version(&version(&spec)?) {
        Some([1, _, _]) => Err(tr!(
            "OpenCode 1.x is no longer supported. Install OpenCode 2.x and try again."
        )),
        Some([2, _, _]) => Ok(2),
        _ => Err(tr!(
            "Cannot determine a supported OpenCode CLI major version."
        )),
    }
}

#[cfg(unix)]
fn drain_version(stdout: &mut impl Read, output: &mut Vec<u8>) -> Result<(), String> {
    let mut chunk = [0u8; 1024];
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) => return Ok(()),
            Ok(n) => {
                if output.len() + n > MAX_VERSION_BYTES {
                    return Err("OpenCode version output exceeds limit".into());
                }
                output.extend_from_slice(&chunk[..n]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Cannot read OpenCode version".into()),
        }
    }
}

#[cfg(unix)]
fn version(spec: &LaunchSpec) -> Result<Vec<u8>, String> {
    use std::os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, PermissionsExt},
    };
    // Even --version initializes provider data in reviewed OpenCode builds.
    // Isolate that initialization from user credentials and configuration.
    let directory = tempfile::Builder::new()
        .prefix("sessionbay-opencode-version-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .map_err(|_| "Cannot create private OpenCode version directory")?;
    let mut command = Command::new(&spec.executable);
    command
        .arg("--version")
        .current_dir(&spec.cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, folder) in [
        ("HOME", "home"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_STATE_HOME", "state"),
        ("TMPDIR", "tmp"),
    ] {
        let path = directory.path().join(folder);
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|_| "Cannot create isolated OpenCode version environment")?;
        command.env(key, path);
    }
    if let Some(value) = spec.env.get("PATH") {
        command.env("PATH", value);
    } else if let Some(value) = std::env::var_os("PATH") {
        command.env("PATH", value);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot check OpenCode version".to_string())?;
    let mut stdout = child.stdout.take().expect("stdout was piped");
    let result = (|| {
        let fd = stdout.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err("Cannot read OpenCode version".to_string());
        }
        let started = Instant::now();
        let mut output = Vec::new();
        loop {
            drain_version(&mut stdout, &mut output)?;
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "Cannot check OpenCode version")?
            {
                drain_version(&mut stdout, &mut output)?;
                return status
                    .success()
                    .then_some(output)
                    .ok_or_else(|| "OpenCode version check failed".into());
            }
            if started.elapsed() >= VERSION_TIMEOUT {
                return Err("OpenCode version check timed out".into());
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
    Err("OpenCode version detection currently requires Unix".into())
}
