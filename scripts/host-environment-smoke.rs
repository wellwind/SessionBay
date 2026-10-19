//! Standalone low-memory harness: compile against the cached portable-pty rlib.
//! Runs synthetic shell probes only, never Session Bay or an Agent.
#[path = "../src-tauri/src/host_environment.rs"]
mod host_environment;

#[cfg(unix)]
#[test]
fn launcher_provider_and_real_pty_round_trip() {
    use std::{
        fs,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };
    let root = std::env::temp_dir().join(format!(
        "sessionbay-env-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone());
    let snap = root.join("snap mount x1");
    fs::create_dir_all(snap.join("usr/bin")).unwrap();
    fs::copy(
        std::env::current_exe().unwrap(),
        snap.join("usr/bin/sessionbay"),
    )
    .unwrap();
    let launcher = std::env::var_os("SESSIONBAY_TEST_LAUNCHER").expect("launcher path required");
    let output = Command::new("/bin/sh")
        .arg(launcher)
        .args(["--exact", "launched_fixture", "--nocapture"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &root)
        .env("SNAP", &snap)
        .env("SESSIONBAY_TEST_FIXTURE", "1")
        .env("GIO_MODULE_DIR", "/host modules")
        .env("FONTCONFIG_FILE", "")
        .env("XDG_DATA_DIRS", "/host/share")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[test]
fn launched_fixture() {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    if std::env::var_os("SESSIONBAY_TEST_FIXTURE").is_none() {
        return;
    }
    let snap = std::path::PathBuf::from(std::env::var_os("SNAP").unwrap());
    assert_eq!(
        std::env::var_os("GIO_MODULE_DIR").unwrap(),
        snap.join("usr/lib/x86_64-linux-gnu/gio/modules")
    );
    assert_eq!(
        std::env::var_os("FONTCONFIG_FILE").unwrap(),
        snap.join("usr/share/sessionbay/fonts.conf")
    );
    assert!(std::env::var_os("GIO_EXTRA_MODULES").is_none());
    let assertions = r#"
set -eu
test "$GIO_MODULE_DIR" = '/host modules'
test "${GIO_EXTRA_MODULES+x}" != x
test "${FONTCONFIG_FILE+x}" = x
test -z "$FONTCONFIG_FILE"
test "$XDG_DATA_DIRS" = '/host/share'
test "${WEBKIT_EXEC_PATH+x}" != x
test "${GSETTINGS_SCHEMA_DIR+x}" != x
test "${FONTCONFIG_PATH+x}" != x
test "${FONTCONFIG_SYSROOT+x}" != x
test "${SESSIONBAY_HOST_ENV_VERSION+x}" != x
test "${SESSIONBAY_HOST_ENV_GIO_MODULE_DIR_VALUE+x}" != x
"#;
    let status = host_environment::command("/bin/sh")
        .unwrap()
        .args(["-c", assertions])
        .status()
        .unwrap();
    assert!(
        status.success(),
        "synthetic provider probe inherited GUI overrides"
    );
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new("/bin/sh");
    host_environment::pty(&mut command).unwrap();
    command.args(["-c", assertions]);
    let mut child = pair.slave.spawn_command(command).unwrap();
    assert!(
        child.wait().unwrap().success(),
        "PTY inherited GUI overrides"
    );
}
