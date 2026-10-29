//! Restore only launcher-owned GUI overrides on host subprocesses.
//! No global environment mutation; native launches have no restoration marker.
use portable_pty::CommandBuilder;
use std::{
    ffi::{OsStr, OsString},
    process::Command,
};

const VERSION: &str = "SESSIONBAY_HOST_ENV_VERSION";
const KEYS: [&str; 8] = [
    "WEBKIT_EXEC_PATH",
    "GSETTINGS_SCHEMA_DIR",
    "XDG_DATA_DIRS",
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
    "FONTCONFIG_FILE",
    "FONTCONFIG_PATH",
    "FONTCONFIG_SYSROOT",
];
type Overrides = Vec<(OsString, Option<OsString>)>;

fn restore_values(mut get: impl FnMut(&str) -> Option<OsString>) -> Result<Overrides, String> {
    let Some(version) = get(VERSION) else {
        return Ok(Vec::new());
    };
    if version != "1" {
        return Err("Unsupported launcher environment version".into());
    }
    let mut result = vec![(VERSION.into(), None)];
    for key in KEYS {
        let set = format!("SESSIONBAY_HOST_ENV_{key}_SET");
        let value = format!("SESSIONBAY_HOST_ENV_{key}_VALUE");
        let original = match get(&set).as_deref() {
            Some(flag) if flag == OsStr::new("x") => {
                Some(get(&value).ok_or("Incomplete launcher environment")?)
            }
            Some(flag) if flag.is_empty() => None,
            _ => return Err("Incomplete launcher environment".into()),
        };
        result.push((key.into(), original));
        result.push((set.into(), None));
        result.push((value.into(), None));
    }
    Ok(result)
}

fn restore_command(command: &mut Command, values: Overrides) {
    for (key, value) in values {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
}
fn restore_pty(command: &mut CommandBuilder, values: Overrides) {
    for (key, value) in values {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
}

/// Apply before launch-specific overrides, which retain their existing precedence.
pub(crate) fn command(program: impl AsRef<OsStr>) -> Result<Command, String> {
    let values = restore_values(|key| std::env::var_os(key))?;
    let mut command = Command::new(program);
    restore_command(&mut command, values);
    Ok(command)
}

/// Session state of whatever started this process: the shell's Node version
/// manager or an `npm run` script. A terminal is a new session and must not
/// inherit it, or e.g. fish nvm skips activation while PATH lacks its Node.
fn launcher_state(vars: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<OsString> {
    let vars: Vec<_> = vars.into_iter().collect();
    let npm_script = vars.iter().any(|(key, _)| key == "npm_lifecycle_event");
    vars.into_iter()
        .map(|(key, _)| key)
        .filter(|key| {
            key == "nvm_current_version"
                || (npm_script
                    && (key == "INIT_CWD"
                        || key == "NODE"
                        || key.to_str().is_some_and(|key| key.starts_with("npm_"))))
        })
        .collect()
}

/// Isolated PTYs already clear all inherited environment and do not call this.
pub(crate) fn pty(command: &mut CommandBuilder) -> Result<(), String> {
    restore_pty(command, restore_values(|key| std::env::var_os(key))?);
    for key in launcher_state(std::env::vars_os()) {
        command.env_remove(key);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn snapshot() -> HashMap<String, OsString> {
        let mut env = HashMap::from([(VERSION.into(), "1".into())]);
        for key in KEYS {
            env.insert(format!("SESSIONBAY_HOST_ENV_{key}_SET"), "".into());
            env.insert(format!("SESSIONBAY_HOST_ENV_{key}_VALUE"), "".into());
        }
        env
    }

    #[test]
    fn restores_values_empty_and_unset_on_provider_and_pty() {
        let mut env = snapshot();
        for (key, value) in [("GIO_MODULE_DIR", "/host modules"), ("FONTCONFIG_FILE", "")] {
            env.insert(format!("SESSIONBAY_HOST_ENV_{key}_SET"), "x".into());
            env.insert(format!("SESSIONBAY_HOST_ENV_{key}_VALUE"), value.into());
        }
        let values = restore_values(|key| env.get(key).cloned()).unwrap();
        let mut provider = Command::new("synthetic-provider");
        let mut pty = CommandBuilder::new("synthetic-shell");
        pty.env_clear();
        for key in KEYS {
            provider.env(key, "/snap/gui-only");
            pty.env(key, "/snap/gui-only");
        }
        restore_command(&mut provider, values.clone());
        restore_pty(&mut pty, values);
        let actual: HashMap<_, _> = provider.get_envs().collect();
        for (key, expected) in [
            ("GIO_MODULE_DIR", Some(OsStr::new("/host modules"))),
            ("FONTCONFIG_FILE", Some(OsStr::new(""))),
            ("GIO_EXTRA_MODULES", None),
            ("WEBKIT_EXEC_PATH", None),
        ] {
            assert_eq!(actual[OsStr::new(key)], expected);
            assert_eq!(pty.get_env(key), expected);
        }
        assert_eq!(actual[OsStr::new(VERSION)], None);
        assert_eq!(pty.get_env(VERSION), None);
    }

    #[test]
    fn launcher_session_state_is_not_inherited() {
        let env = |pairs: &[&str]| -> Vec<(OsString, OsString)> {
            pairs
                .iter()
                .map(|key| (key.into(), "synthetic".into()))
                .collect()
        };
        let mut removed = launcher_state(env(&[
            "PATH",
            "HOME",
            "nvm_current_version",
            "npm_lifecycle_event",
            "npm_config_prefix",
            "INIT_CWD",
            "NODE",
        ]));
        removed.sort();
        assert_eq!(
            removed,
            [
                "INIT_CWD",
                "NODE",
                "npm_config_prefix",
                "npm_lifecycle_event",
                "nvm_current_version"
            ]
        );
        // Without an npm script these may be the user's own settings.
        assert_eq!(
            launcher_state(env(&["npm_config_prefix", "NODE", "INIT_CWD"])),
            Vec::<OsString>::new()
        );
    }

    #[test]
    fn native_launch_is_unchanged() {
        let values = restore_values(|_| None).unwrap();
        let mut command = Command::new("synthetic");
        command.env("GIO_MODULE_DIR", "/native modules");
        restore_command(&mut command, values.clone());
        assert_eq!(
            command.get_envs().collect::<Vec<_>>(),
            vec![(
                OsStr::new("GIO_MODULE_DIR"),
                Some(OsStr::new("/native modules"))
            )]
        );
        let mut pty = CommandBuilder::new("synthetic");
        pty.env("FONTCONFIG_FILE", "/native/fonts.conf");
        restore_pty(&mut pty, values);
        assert_eq!(
            pty.get_env("FONTCONFIG_FILE"),
            Some(OsStr::new("/native/fonts.conf"))
        );
    }

    #[test]
    fn incomplete_or_unknown_snapshot_fails_closed() {
        let mut env = snapshot();
        env.remove("SESSIONBAY_HOST_ENV_GIO_MODULE_DIR_SET");
        assert!(restore_values(|key| env.get(key).cloned()).is_err());
        env.insert(VERSION.into(), "2".into());
        assert!(restore_values(|key| env.get(key).cloned()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_original_value_is_preserved() {
        use std::os::unix::ffi::OsStringExt;
        let mut env = snapshot();
        let value = OsString::from_vec(vec![b'/', 0xff]);
        env.insert("SESSIONBAY_HOST_ENV_FONTCONFIG_PATH_SET".into(), "x".into());
        env.insert(
            "SESSIONBAY_HOST_ENV_FONTCONFIG_PATH_VALUE".into(),
            value.clone(),
        );
        let values = restore_values(|key| env.get(key).cloned()).unwrap();
        assert!(values.contains(&("FONTCONFIG_PATH".into(), Some(value))));
    }
}
