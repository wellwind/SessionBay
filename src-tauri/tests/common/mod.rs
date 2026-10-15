use std::{fs, os::unix::fs::PermissionsExt, path::Path};

/// A self-contained executable fixture for tests that only validate launch plans.
/// Keep its parent temporary directory alive for the duration of the test.
pub fn noop_executable(directory: &Path) -> String {
    let executable = directory.join("synthetic noop executable");
    fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    executable.to_string_lossy().into_owned()
}
