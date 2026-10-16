#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{fs, path::Path};

/// A self-contained executable fixture for tests that only validate launch plans.
/// Keep its parent temporary directory alive for the duration of the test.
pub fn noop_executable(directory: &Path) -> String {
    #[cfg(unix)]
    let executable = directory.join("synthetic noop executable");
    #[cfg(windows)]
    let executable = directory.join("synthetic noop executable.exe");
    #[cfg(windows)]
    fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
    #[cfg(unix)]
    fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    executable.to_string_lossy().into_owned()
}
