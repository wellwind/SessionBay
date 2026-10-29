//! Best-effort DND detection. API choices are UNVERIFIED against primary docs
//! and live platform behavior; failure must never prevent an attention sound.

pub fn muted() -> bool {
    match platform_muted() {
        Ok(muted) => muted,
        Err(error) => {
            #[cfg(debug_assertions)]
            eprintln!("[attention sound] DND unavailable; playing as usual: {error}");
            #[cfg(not(debug_assertions))]
            let _ = error;
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn platform_muted() -> Result<bool, String> {
    // UNVERIFIED: INFocusStatusCenter requires OS availability, authorization,
    // and potentially a communication entitlement. This app has no verified
    // entitlement/authorization flow, so macOS Focus detection is unsupported.
    Err("macOS INFocusStatusCenter authorization/entitlement support is unverified".into())
}

#[cfg(windows)]
fn platform_muted() -> Result<bool, String> {
    // UNVERIFIED: SHQueryUserNotificationState is a partial quiet/presentation
    // signal, not a verified detector for every Focus Assist / DND mode.
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHQueryUserNotificationState(state: *mut i32) -> i32;
    }
    let mut state = 0;
    // SAFETY: the API writes one enum-sized value into a valid local pointer.
    let result = unsafe { SHQueryUserNotificationState(&mut state) };
    if result < 0 {
        return Err(format!("SHQueryUserNotificationState failed: {result:#x}"));
    }
    windows_state_muted(state)
}

#[cfg(any(windows, test))]
fn windows_state_muted(state: i32) -> Result<bool, String> {
    match state {
        // UNVERIFIED enum values: busy, D3D fullscreen, presentation, quiet time.
        2..=4 | 6 => Ok(true),
        1 | 5 | 7 => Ok(false),
        _ => Err(format!("unknown Windows notification state: {state}")),
    }
}

#[cfg(target_os = "linux")]
fn platform_muted() -> Result<bool, String> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if desktop.split(':').any(|name| name == "gnome") {
        // UNVERIFIED: GNOME show-banners is a proxy for DND, not a universal API.
        let value = query(
            "gsettings",
            &["get", "org.gnome.desktop.notifications", "show-banners"],
        )?;
        return gnome_muted(&value);
    }
    if desktop.split(':').any(|name| name == "kde") {
        // UNVERIFIED: KDE's notification service may expose Inhibited here;
        // versions/services without this property fall back to normal playback.
        let value = query(
            "gdbus",
            &[
                "call",
                "--session",
                "--dest",
                "org.freedesktop.Notifications",
                "--object-path",
                "/org/freedesktop/Notifications",
                "--method",
                "org.freedesktop.DBus.Properties.Get",
                "org.freedesktop.Notifications",
                "Inhibited",
            ],
        )?;
        return kde_muted(&value);
    }
    Err("unsupported Linux desktop (expected GNOME or KDE)".into())
}

#[cfg(target_os = "linux")]
fn query(program: &str, args: &[&str]) -> Result<String, String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("{program}: {error}"))?;
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} timed out or failed: {result:?}"));
            }
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("{program} exited with {}", output.status));
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

#[cfg(any(target_os = "linux", test))]
fn gnome_muted(value: &str) -> Result<bool, String> {
    match value.trim() {
        "false" => Ok(true),
        "true" => Ok(false),
        _ => Err("unexpected GNOME show-banners value".into()),
    }
}

#[cfg(any(target_os = "linux", test))]
fn kde_muted(value: &str) -> Result<bool, String> {
    match value.trim() {
        "(<true>,)" => Ok(true),
        "(<false>,)" => Ok(false),
        _ => Err("unexpected KDE Inhibited value".into()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn platform_muted() -> Result<bool, String> {
    Err("unsupported platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dnd_signals_without_treating_invalid_output_as_muted() {
        assert_eq!(gnome_muted("false\n"), Ok(true));
        assert_eq!(gnome_muted("true"), Ok(false));
        assert_eq!(kde_muted("(<true>,)\n"), Ok(true));
        assert_eq!(kde_muted("(<false>,)"), Ok(false));
        assert!(gnome_muted("").is_err());
        assert!(kde_muted("service unavailable").is_err());
        for state in [2, 3, 4, 6] {
            assert_eq!(windows_state_muted(state), Ok(true));
        }
        for state in [1, 5, 7] {
            assert_eq!(windows_state_muted(state), Ok(false));
        }
        assert!(windows_state_muted(0).is_err());
    }
}
