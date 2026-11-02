//! Launch-local OpenCode lifecycle plugin. User configuration and argv stay intact.
use crate::tr;
use crate::{provider_hooks, runtime::LaunchSpec};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, OnceLock},
};
#[cfg(unix)]
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;

const MODULE_V2: &str = include_str!("opencode_state_plugin_v2.mjs");
const MODULE: &str = include_str!("opencode_state_plugin.mjs");
const CONFIG: &str = "OPENCODE_CONFIG_CONTENT";
const HELPER: &str = "SESSIONBAY_OPENCODE_STATE_HELPER";
pub(crate) const SESSION: &str = "SESSIONBAY_OPENCODE_STATE_SESSION";
const DIRECTORY: &str = "SESSIONBAY_OPENCODE_STATE_DIRECTORY";
const MAX_CONFIG_BYTES: usize = 1024 * 1024;
#[cfg(unix)]
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(unix)]
const MAX_VERSION_BYTES: usize = 8192;
static PLUGINS: OnceLock<Mutex<HashMap<String, TempDir>>> = OnceLock::new();

fn plugins() -> &'static Mutex<HashMap<String, TempDir>> {
    PLUGINS.get_or_init(|| Mutex::new(HashMap::new()))
}

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

fn supported_version(output: &[u8]) -> bool {
    matches!(parse_version(output), Some([1, minor, patch]) if (minor, patch) >= (19, 2))
        || matches!(parse_version(output), Some([2, 2, 0..=5]))
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
        Some([major @ (1 | 2), _, _]) => Ok(major),
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
    Err("OpenCode state reporting currently requires Unix".into())
}

/// The source-aware launch plan carries the native ID in argv. `resume_key`
/// hashes provider/database identity and MUST NOT be sent as a provider ID.
pub(crate) fn expected_session(spec: &LaunchSpec) -> Result<Option<String>, String> {
    if effective_env(spec, "OPENCODE_PURE")?
        .is_some_and(|value| !matches!(value.as_str(), "false" | "0"))
    {
        return Err("OpenCode OPENCODE_PURE disables plugins or is unrecognized; turn off live state or disable pure mode".into());
    }
    let mut session = None;
    let mut args = spec.args.iter();
    while let Some(arg) = args.next() {
        if arg == "--pure" || arg.starts_with("--pure=") {
            return Err(
                "OpenCode --pure disables plugins; turn off live state or remove --pure".into(),
            );
        }
        let value = if matches!(arg.as_str(), "--session" | "-s") {
            Some(
                args.next()
                    .ok_or("Missing OpenCode session argument")?
                    .as_str(),
            )
        } else {
            arg.strip_prefix("--session=")
                .or_else(|| arg.strip_prefix("-s="))
        };
        if let Some(value) = value {
            if session.is_some() || !crate::opencode::valid_session_id(value) {
                return Err("Ambiguous or invalid OpenCode resume identity".into());
            }
            session = Some(value.to_owned());
        }
    }
    if spec.resume_key.is_some() && session.is_none() {
        return Err("OpenCode resume source is missing its native session argument".into());
    }
    if session.is_some()
        && spec
            .args
            .iter()
            .any(|arg| arg == "--fork" || arg.starts_with("--fork="))
    {
        return Err("OpenCode fork identity cannot be instrumented safely".into());
    }
    Ok(session)
}

#[derive(Clone, Copy)]
struct Token {
    kind: u8,
    start: usize,
    end: usize,
}

/// Validate a deliberately limited JSONC dialect: JSON with line/block comments
/// and trailing commas. Preserve byte offsets for an insertion into the original
/// text, so comments, duplicate non-plugin keys, numbers and expansions survive.
fn jsonc_tokens(text: &str) -> Result<(serde_json::Value, Vec<Token>), String> {
    let invalid = || {
        "Cannot safely extend OpenCode inline configuration; original settings preserved".to_owned()
    };
    if text.len() > MAX_CONFIG_BYTES {
        return Err(
            "OpenCode inline configuration exceeds limit; original settings preserved".into(),
        );
    }
    let bytes = text.as_bytes();
    let mut json = bytes.to_vec();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        if bytes[i..].starts_with(b"//") {
            while i < bytes.len() && !matches!(bytes[i], b'\n' | b'\r') {
                json[i] = b' ';
                i += 1;
            }
            continue;
        }
        if bytes[i..].starts_with(b"/*") {
            i += 2;
            while i + 1 < bytes.len() && !bytes[i..].starts_with(b"*/") {
                i += 1;
            }
            if i + 1 >= bytes.len() {
                return Err(invalid());
            }
            i += 2;
            json[start..i].fill(b' ');
            continue;
        }
        let kind = bytes[i];
        if kind == b'"' {
            i += 1;
            loop {
                match bytes.get(i) {
                    Some(b'\\') => i += 2,
                    Some(b'"') => {
                        i += 1;
                        break;
                    }
                    Some(_) => i += 1,
                    None => return Err(invalid()),
                }
            }
        } else if b"{}[],:".contains(&kind) {
            i += 1;
        } else {
            while i < bytes.len()
                && !bytes[i].is_ascii_whitespace()
                && !b"{}[],:/".contains(&bytes[i])
            {
                i += 1;
            }
            if i == start {
                return Err(invalid());
            }
        }
        tokens.push(Token {
            kind,
            start,
            end: i,
        });
    }
    for (index, token) in tokens.iter().enumerate() {
        if token.kind == b','
            && index > 0
            && !b"[{,:".contains(&tokens[index - 1].kind)
            && tokens
                .get(index + 1)
                .is_some_and(|t| b"]}".contains(&t.kind))
        {
            json[token.start] = b' ';
        }
    }
    let value = serde_json::from_slice(&json).map_err(|_| invalid())?;
    Ok((value, tokens))
}

#[cfg(test)]
fn extend_config(original: &str, uri: &str) -> Result<String, String> {
    extend_config_key(original, uri, "plugin")
}

fn extend_config_key(original: &str, uri: &str, key_name: &str) -> Result<String, String> {
    let (value, tokens) = jsonc_tokens(original)?;
    let object = value
        .as_object()
        .ok_or("OpenCode inline configuration must be an object")?;
    if object.get(key_name).is_some_and(|value| !value.is_array()) {
        return Err(
            "OpenCode inline plugin setting must be an array; original settings preserved".into(),
        );
    }
    let mut plugin_close = None;
    let mut i = 1;
    while tokens[i].kind != b'}' {
        let key: String = serde_json::from_str(&original[tokens[i].start..tokens[i].end])
            .map_err(|_| "Unsupported OpenCode configuration key")?;
        i += 2; // key, colon
        let first = i;
        if b"[{".contains(&tokens[i].kind) {
            let mut depth = 1;
            i += 1;
            while depth > 0 {
                if b"[{".contains(&tokens[i].kind) {
                    depth += 1;
                } else if b"]}".contains(&tokens[i].kind) {
                    depth -= 1;
                }
                i += 1;
            }
        } else {
            i += 1;
        }
        if key == key_name {
            if plugin_close.is_some() || tokens[first].kind != b'[' {
                return Err(
                    "Ambiguous OpenCode inline plugin setting; original settings preserved".into(),
                );
            }
            plugin_close = Some(i - 1);
        }
        if tokens[i].kind == b',' {
            i += 1;
        }
    }
    let close = plugin_close.unwrap_or(tokens.len() - 1);
    let previous = tokens[close - 1].kind;
    let separator = if b"[{,".contains(&previous) { "" } else { "," };
    let uri = serde_json::to_string(uri).map_err(|_| "Cannot encode OpenCode plugin URI")?;
    let addition = if plugin_close.is_some() {
        format!("{separator}{uri}")
    } else {
        format!("{separator}\"{key_name}\":[{uri}]")
    };
    let mut result = original.to_owned();
    result.insert_str(tokens[close].start, &addition);
    // Defense in depth against unsupported source syntax and insertion mistakes.
    jsonc_tokens(&result)?;
    Ok(result)
}

fn file_uri(path: &Path) -> Result<String, String> {
    let path = path
        .to_str()
        .filter(|_| path.is_absolute())
        .ok_or("OpenCode plugin path must be absolute UTF-8")?;
    let mut uri = String::from("file://");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(uri, "%{byte:02X}").expect("writing to a string cannot fail");
        }
    }
    Ok(uri)
}

fn effective_env(spec: &LaunchSpec, key: &str) -> Result<Option<String>, String> {
    if let Some(value) = spec.env.get(key) {
        return Ok(Some(value.clone()));
    }
    match std::env::var(key) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!(
            "Inherited {key} is not UTF-8; original settings preserved"
        )),
    }
}

fn effective_config(spec: &LaunchSpec) -> Result<String, String> {
    Ok(effective_env(spec, CONFIG)?.unwrap_or_else(|| "{}".into()))
}

/// Call after the broker installs the launch-local routing environment.
/// The owner MUST call `cleanup` on launch failure and runtime exit/revocation.
pub fn prepare(spec: &mut LaunchSpec, helper: &Path) -> Result<(), String> {
    expected_session(spec)?;
    let output = version(spec)?;
    if !supported_version(&output) {
        return Err(tr!(
            "Live OpenCode status needs stable OpenCode 1.19.2 through 1.x, or 2.2.0 through 2.2.5"
        ));
    }
    let v2 = parse_version(&output).unwrap()[0] == 2;
    if v2
        && spec
            .args
            .iter()
            .any(|arg| arg == "--server" || arg.starts_with("--server="))
    {
        return Err(
            "OpenCode --server uses another server that never loads this launch's plugin; turn off live state or remove --server"
                .into(),
        );
    }
    install_module(spec, helper, if v2 { MODULE_V2 } else { MODULE })?;
    // A running 2.x background service was started without this launch's
    // plugin config; a private server is the only one that loads it.
    if v2 && !spec.args.iter().any(|arg| arg == "--standalone") {
        spec.args.insert(0, "--standalone".into());
    }
    Ok(())
}

#[cfg(test)]
fn install(spec: &mut LaunchSpec, helper: &Path) -> Result<(), String> {
    install_module(spec, helper, MODULE)
}

fn install_module(spec: &mut LaunchSpec, helper: &Path, module: &str) -> Result<(), String> {
    let session = expected_session(spec)?;
    let launch = spec
        .env
        .get(provider_hooks::LAUNCH)
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or("Missing OpenCode state launch identity")?
        .clone();
    let helper = helper
        .to_str()
        .filter(|value| helper.is_absolute() && !value.chars().any(char::is_control))
        .ok_or("OpenCode state helper must have a safe absolute path")?
        .to_owned();
    let cwd = spec
        .cwd
        .to_str()
        .filter(|value| spec.cwd.is_absolute() && !value.chars().any(char::is_control))
        .ok_or("OpenCode state directory must be absolute UTF-8")?
        .to_owned();
    let original = effective_config(spec)?;
    let mut plugins = plugins()
        .lock()
        .map_err(|_| "OpenCode plugin registry unavailable")?;
    if plugins.contains_key(&launch) {
        return Err("OpenCode state launch is already prepared".into());
    }
    let mut builder = tempfile::Builder::new();
    builder.prefix("sessionbay-opencode-state-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let directory = builder
        .tempdir()
        .map_err(|_| "Cannot create private OpenCode plugin directory")?;
    let path = directory.path().join("sessionbay-state.mjs");
    let v2 = module == MODULE_V2;
    let target = if v2 { directory.path() } else { &path };
    let config = extend_config_key(
        &original,
        &file_uri(target)?,
        if v2 { "plugins" } else { "plugin" },
    )?;
    if v2 {
        let manifest = directory.path().join("package.json");
        std::fs::write(&manifest, r#"{"name":"sessionbay-launch-state","type":"module","exports":{".":"./sessionbay-state.mjs"}}"#)
            .map_err(|_| "Cannot write launch-local OpenCode plugin manifest")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(manifest, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "Cannot protect launch-local OpenCode plugin manifest")?;
        }
    }
    std::fs::write(&path, module).map_err(|_| "Cannot write launch-local OpenCode plugin")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Cannot protect launch-local OpenCode plugin")?;
    }
    // Commit only after all fallible preparation, preserving argv and every
    // pre-existing environment entry on failure. An empty value masks any
    // accidentally inherited session hint for a genuinely new launch.
    spec.env.insert(CONFIG.into(), config);
    spec.env.insert(HELPER.into(), helper);
    spec.env.insert(DIRECTORY.into(), cwd);
    spec.env.insert(SESSION.into(), session.unwrap_or_default());
    plugins.insert(launch, directory);
    Ok(())
}

/// Only removes the private directory registered for this exact launch UUID.
pub fn cleanup(launch: &str) {
    if let Ok(mut plugins) = plugins().lock() {
        plugins.remove(launch);
    }
}

#[cfg(test)]
#[cfg_attr(not(unix), allow(dead_code))] // Only Unix provider-hook tests stage plugins.
pub(crate) fn staged_path(launch: &str) -> Option<std::path::PathBuf> {
    plugins()
        .lock()
        .unwrap()
        .get(launch)
        .map(|directory| directory.path().join("sessionbay-state.mjs"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn spec() -> LaunchSpec {
        LaunchSpec {
            executable: "opencode".into(),
            args: vec!["--session".into(), "ses_syntheticRoot".into()],
            cwd: std::env::temp_dir(),
            env: HashMap::from([
                (
                    provider_hooks::LAUNCH.into(),
                    uuid::Uuid::new_v4().to_string(),
                ),
                (CONFIG.into(), "{}".into()),
                ("OPENCODE_PURE".into(), "false".into()),
            ]),
            session_id: Some("catalog-id".into()),
            resume_key: Some("provider-opaque-source-identity".into()),
            pane_id: "synthetic-pane".into(),
        }
    }

    fn plugin_path(launch: &str) -> std::path::PathBuf {
        plugins().lock().unwrap()[launch]
            .path()
            .join("sessionbay-state.mjs")
    }

    #[test]
    fn gates_supported_stable_versions_for_each_plugin() {
        for version in [
            "1.19.2\n",
            "1.19.3",
            "1.20.0",
            "1.99.999",
            "opencode v2.2.0",
            "opencode v2.2.3\n",
            "opencode v2.2.5",
        ] {
            assert!(supported_version(version.as_bytes()), "{version}");
        }
        for version in [
            "1.19.1",
            "1.18.999",
            "2.0.0",
            "opencode v2.2.6",
            "opencode v2.1.9",
            "0.99.999",
            "1.19.2-beta",
            "1.19.2+build",
            "v1.19.2",
            "01.19.2",
            "1.019.2",
            "1.19",
            "1.19.2.0",
            "OpenCode 1.19.2",
            "1.19.2\nwarning",
            "999999999999.0.0",
            "",
            "+1.19.2",
        ] {
            assert!(!supported_version(version.as_bytes()), "{version}");
        }
    }

    #[test]
    fn v2_prepare_rejects_an_external_server_and_keeps_an_existing_standalone() {
        let directory = tempfile::tempdir().unwrap();
        let mut spec = spec();
        spec.executable = fake_provider(directory.path(), "printf 'opencode v2.2.3\\n'");
        spec.args.push("--server=http://127.0.0.1:4096".into());
        let before = (spec.args.clone(), spec.env.clone());
        assert!(prepare(&mut spec, Path::new("/synthetic/helper")).is_err());
        assert_eq!((spec.args.clone(), spec.env.clone()), before);

        let mut spec = self::spec();
        spec.executable = fake_provider(directory.path(), "printf 'opencode v2.2.3\\n'");
        spec.args.push("--standalone".into());
        let launch = spec.env[provider_hooks::LAUNCH].clone();
        prepare(&mut spec, Path::new("/synthetic/helper")).unwrap();
        assert_eq!(
            spec.args
                .iter()
                .filter(|arg| *arg == "--standalone")
                .count(),
            1
        );
        cleanup(&launch);
    }

    #[test]
    fn v2_prepare_uses_plural_plugins_and_a_private_package_directory() {
        let directory = tempfile::tempdir().unwrap();
        let mut spec = spec();
        spec.executable = fake_provider(directory.path(), "printf 'opencode v2.2.3\\n'");
        let original = "{ // retained\n \"plugins\":[\"existing\"],\"model\":\"unchanged\",}";
        spec.env.insert(CONFIG.into(), original.into());
        let launch = spec.env[provider_hooks::LAUNCH].clone();
        let before = spec.args.clone();
        prepare(&mut spec, Path::new("/synthetic/helper")).unwrap();
        let path = plugin_path(&launch);
        let mut expected = before.clone();
        expected.insert(0, "--standalone".into());
        assert_eq!(spec.args, expected);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), MODULE_V2);
        let (config, _) = jsonc_tokens(&spec.env[CONFIG]).unwrap();
        assert_eq!(config["plugins"][0], "existing");
        assert_eq!(
            config["plugins"][1],
            file_uri(path.parent().unwrap()).unwrap()
        );
        assert!(config.get("plugin").is_none());
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(path.parent().unwrap().join("package.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["exports"]["."], "./sessionbay-state.mjs");
        assert_eq!(
            std::fs::metadata(path.parent().unwrap().join("package.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        cleanup(&launch);
    }

    #[test]
    fn version_parser_covers_both_official_formats_and_fails_closed() {
        assert_eq!(parse_version(b"1.19.5\n"), Some([1, 19, 5]));
        assert_eq!(parse_version(b"opencode v2.2.3\n"), Some([2, 2, 3]));
        for output in [
            "opencode v2.2.3-beta",
            "opencode v2.02.3",
            "opencode v2.2.3\nwarning",
            "opencode v2.2",
            "garbage",
        ] {
            assert_eq!(parse_version(output.as_bytes()), None);
        }
        for output in ["opencode v2.2.0", "opencode v2.2.5"] {
            assert!(supported_version(output.as_bytes()));
        }
        for output in ["opencode v2.1.9", "opencode v2.2.6", "opencode v3.0.0"] {
            assert!(!supported_version(output.as_bytes()));
        }
    }

    #[test]
    fn uri_encodes_spaces_unicode_controls_and_url_delimiters() {
        assert_eq!(
            file_uri(Path::new("/tmp/插件 a#b?c%\n\r\t.mjs")).unwrap(),
            "file:///tmp/%E6%8F%92%E4%BB%B6%20a%23b%3Fc%25%0A%0D%09.mjs"
        );
        assert_eq!(
            file_uri(Path::new("/safe-a_b.~.mjs")).unwrap(),
            "file:///safe-a_b.~.mjs"
        );
        assert!(file_uri(Path::new("relative.mjs")).is_err());
    }

    #[test]
    fn config_preserves_every_original_setting_and_jsonc_text() {
        for original in [
            "{}",
            r#"{"model":"provider/model","permission":{"*":"ask"},"plugin":[]}"#,
            r#"{"plugin":["file:///existing.mjs",["existing-package",{"option":true}]],"nested":{"plugin":[]}}"#,
            "{ // user comment\n \"plugin\": [\"original\", /* kept */], \"model\": \"unchanged\", }",
            "{/* original */ \"provider\":{\"key\":\"{env:SECRET}\",},}",
            r#"{"plugin":["a//b/*c*/\"d"],"large":123456789012345678901234567890,"duplicate":1,"duplicate":2}"#,
            "{\"plugin\": [ /* empty */ ], // final comment\n}",
            "{\"\\u0070lugin\": [\"old\"]}",
        ] {
            let uri = "file:///new%20plugin.mjs";
            let extended = extend_config(original, uri).unwrap();
            let (before, _) = jsonc_tokens(original).unwrap();
            let (mut after, _) = jsonc_tokens(&extended).unwrap();
            assert_eq!(after["plugin"].as_array_mut().unwrap().pop().unwrap(), uri);
            if before.get("plugin").is_none() {
                after.as_object_mut().unwrap().remove("plugin");
            }
            assert_eq!(before, after);
            // Every original byte remains, in order; only one insertion is made.
            let at = original.bytes().zip(extended.bytes())
                .position(|(left, right)| left != right).unwrap();
            let mut restored = extended.clone();
            restored.drain(at..at + extended.len() - original.len());
            assert_eq!(restored, original);
        }
    }

    #[test]
    fn config_rejects_unsupported_syntax_without_guessing() {
        for original in [
            "",
            "null",
            "[]",
            "{",
            "{\"plugin\":null}",
            "{\"plugin\":\"file:///x\"}",
            "{\"plugin\":[],\"plugin\":[]}",
            "{\"plugin\":[],\"\\u0070lugin\":[]}",
            "{\"plugin\":[,]}",
            "{\"plugin\":[,,]}",
            "{,}",
            "{\"x\":1,,}",
            "{/* unclosed}",
            "{'single':'quotes'}",
            "{unquoted:1}",
            "{\"x\":NaN}",
            "{\"x\":1} garbage",
            "{\"plugin\":[\"unterminated]}",
        ] {
            assert!(
                extend_config(original, "file:///plugin.mjs").is_err(),
                "{original}"
            );
        }
        assert!(extend_config(&" ".repeat(MAX_CONFIG_BYTES + 1), "file:///x").is_err());
    }

    #[test]
    fn launch_private_plugin_preserves_args_config_and_source_identity() {
        let mut spec = spec();
        let original = r#"{"model":"unchanged/model","plugin":["original"]}"#;
        spec.env.insert(CONFIG.into(), original.into());
        spec.env
            .insert("OPENCODE_DB".into(), "/synthetic/source/opencode.db".into());
        let original_args = spec.args.clone();
        let launch = spec.env[provider_hooks::LAUNCH].clone();
        let helper = Path::new("/synthetic app/helper");
        install(&mut spec, helper).unwrap();
        let path = plugin_path(&launch);
        assert_eq!(spec.args, original_args);
        assert_eq!(spec.env[HELPER], helper.to_str().unwrap());
        assert_eq!(spec.env[SESSION], "ses_syntheticRoot");
        assert_eq!(spec.env[DIRECTORY], spec.cwd.to_str().unwrap());
        assert_eq!(spec.env["OPENCODE_DB"], "/synthetic/source/opencode.db");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), MODULE);
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let config: serde_json::Value = serde_json::from_str(&spec.env[CONFIG]).unwrap();
        assert_eq!(config["model"], "unchanged/model");
        assert_eq!(config["plugin"][0], "original");
        assert_eq!(config["plugin"][1], file_uri(&path).unwrap());
        assert!(!MODULE.contains(&launch));
        let installed = serde_json::to_string(&spec).unwrap();
        assert!(install(&mut spec, helper).is_err());
        assert_eq!(serde_json::to_string(&spec).unwrap(), installed);
        cleanup(&launch);
        cleanup(&launch);
        assert!(!path.parent().unwrap().exists());
    }

    #[test]
    fn invalid_config_paths_launch_or_pure_never_mutate_spec() {
        for change in 0..7 {
            let mut spec = spec();
            let mut helper = Path::new("/synthetic/helper");
            match change {
                0 => {
                    spec.env.insert(CONFIG.into(), "{broken".into());
                }
                1 => {
                    spec.env.remove(provider_hooks::LAUNCH);
                }
                2 => helper = Path::new("relative/helper"),
                3 => helper = Path::new("/bad\nhelper"),
                4 => spec.args.push("--pure".into()),
                5 => spec.cwd = "relative".into(),
                6 => spec.args.push("--pure=true".into()),
                _ => unreachable!(),
            }
            let before = serde_json::to_string(&spec).unwrap();
            assert!(install(&mut spec, helper).is_err());
            assert_eq!(serde_json::to_string(&spec).unwrap(), before);
            if let Some(launch) = spec.env.get(provider_hooks::LAUNCH) {
                assert!(!plugins().lock().unwrap().contains_key(launch));
            }
        }
        let mut spec = spec();
        spec.executable = "/provider/that/must/not/run".into();
        spec.args.push("--pure".into());
        assert!(prepare(&mut spec, Path::new("/helper"))
            .unwrap_err()
            .contains("--pure"));
    }

    #[test]
    fn pure_environment_rejects_enabled_and_unknown_values_atomically() {
        for value in ["1", "true", "yes", "", "unexpected", "TRUE"] {
            let mut spec = spec();
            spec.env.insert("OPENCODE_PURE".into(), value.into());
            let before = serde_json::to_string(&spec).unwrap();
            assert!(prepare(&mut spec, Path::new("/helper"))
                .unwrap_err()
                .contains("OPENCODE_PURE"));
            assert_eq!(serde_json::to_string(&spec).unwrap(), before);
        }
        for value in ["0", "false"] {
            let mut spec = spec();
            spec.env.insert("OPENCODE_PURE".into(), value.into());
            assert!(expected_session(&spec).is_ok());
        }
        let mut spec = spec();
        spec.env
            .insert("OPENCODE_DISABLE_DEFAULT_PLUGINS".into(), "true".into());
        assert!(expected_session(&spec).is_ok());
    }

    #[test]
    fn resume_uses_native_session_and_new_launch_masks_inherited_hint() {
        for args in [
            vec!["--session", "ses_root"],
            vec!["-s", "ses_root"],
            vec!["--session=ses_root"],
            vec!["-s=ses_root"],
        ] {
            let mut spec = spec();
            spec.args = args.into_iter().map(str::to_owned).collect();
            assert_eq!(
                expected_session(&spec).unwrap().as_deref(),
                Some("ses_root")
            );
        }
        for args in [
            vec![],
            vec!["--session", "bad-id"],
            vec!["--session"],
            vec!["--session", "ses_one", "-s", "ses_two"],
            vec!["--session", "ses_one", "--fork"],
        ] {
            let mut spec = spec();
            spec.args = args.into_iter().map(str::to_owned).collect();
            assert!(expected_session(&spec).is_err());
        }
        let mut spec = spec();
        spec.args.clear();
        spec.resume_key = None;
        spec.session_id = None;
        spec.env.insert(SESSION.into(), "ses_stale".into());
        let launch = spec.env[provider_hooks::LAUNCH].clone();
        install(&mut spec, Path::new("/helper")).unwrap();
        assert_eq!(spec.env[SESSION], "");
        cleanup(&launch);
    }

    fn fake_provider(directory: &Path, body: &str) -> String {
        let executable = directory.join("synthetic-opencode");
        std::fs::write(&executable, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        executable.to_str().unwrap().to_owned()
    }

    #[test]
    fn prepare_only_probes_version_without_credentials_or_config() {
        let directory = tempfile::tempdir().unwrap();
        let mut spec = spec();
        spec.env
            .insert("OPENAI_API_KEY".into(), "synthetic-never-transmit".into());
        spec.env
            .insert("HOME".into(), "/synthetic-launch-home".into());
        spec.env
            .insert("XDG_CONFIG_HOME".into(), "/synthetic-launch-config".into());
        let captured = directory.path().join("probe-home");
        spec.executable = fake_provider(
            directory.path(),
            &format!(
                r#"
[ "$#" = 1 ] && [ "$1" = --version ] || exit 7
[ -z "$OPENAI_API_KEY$OPENCODE_CONFIG_CONTENT$SESSIONBAY_HOOK_LAUNCH" ] || exit 8
[ "$HOME" != /synthetic-launch-home ] || exit 9
root=${{HOME%/home}}
[ "$XDG_DATA_HOME" = "$root/data" ] && [ "$XDG_CONFIG_HOME" = "$root/config" ] && [ "$XDG_CACHE_HOME" = "$root/cache" ] && [ "$XDG_STATE_HOME" = "$root/state" ] && [ "$TMPDIR" = "$root/tmp" ] || exit 10
for path in "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$TMPDIR"; do [ -d "$path" ] || exit 11; done
printf '%s' "$HOME" > '{}'
printf '1.19.2\n'
"#,
                captured.display()
            ),
        );
        let launch = spec.env[provider_hooks::LAUNCH].clone();
        prepare(&mut spec, Path::new("/helper")).unwrap();
        let probe_home = std::path::PathBuf::from(std::fs::read_to_string(&captured).unwrap());
        assert_ne!(
            probe_home,
            std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_default()
        );
        assert!(!probe_home.parent().unwrap().exists());
        assert_eq!(spec.env["HOME"], "/synthetic-launch-home");
        assert_eq!(spec.env["XDG_CONFIG_HOME"], "/synthetic-launch-config");
        cleanup(&launch);
        for output in ["1.19.1", "2.0.0", "1.19.2-dev"] {
            spec.executable = fake_provider(directory.path(), &format!("printf '{output}'"));
            let before = serde_json::to_string(&spec).unwrap();
            assert!(prepare(&mut spec, Path::new("/helper"))
                .unwrap_err()
                .contains("1.19.2"));
            assert_eq!(serde_json::to_string(&spec).unwrap(), before);
        }
    }

    #[test]
    fn probe_is_bounded_for_large_output_failure_and_timeout() {
        let directory = tempfile::tempdir().unwrap();
        let mut spec = spec();
        spec.executable = fake_provider(directory.path(), "printf '%9000s' x");
        assert!(version(&spec).unwrap_err().contains("limit"));
        spec.executable = fake_provider(directory.path(), "printf 1.19.2; exit 1");
        assert!(version(&spec).unwrap_err().contains("failed"));
        spec.executable = fake_provider(directory.path(), "exec sleep 10");
        let started = Instant::now();
        assert!(version(&spec).unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    // A child process isolates real inherited environment behavior from parallel
    // tests; production precedence is spec override, then inherited process env.
    #[test]
    fn inherited_config_subprocess_contract() {
        const MARKER: &str = "SESSIONBAY_TEST_INHERITED_OPENCODE_CONFIG";
        if std::env::var_os(MARKER).is_some() {
            let mut spec = spec();
            spec.env.remove("OPENCODE_PURE");
            assert!(expected_session(&spec)
                .unwrap_err()
                .contains("OPENCODE_PURE"));
            spec.env.insert("OPENCODE_PURE".into(), "false".into());
            assert!(expected_session(&spec).is_ok());
            spec.env.remove(CONFIG);
            let launch = spec.env[provider_hooks::LAUNCH].clone();
            let inherited = std::env::var(CONFIG).unwrap();
            assert_eq!(effective_config(&spec).unwrap(), inherited);
            install(&mut spec, Path::new("/helper")).unwrap();
            let (config, _) = jsonc_tokens(&spec.env[CONFIG]).unwrap();
            assert_eq!(config["model"], "inherited/model");
            assert_eq!(config["plugin"][0], "inherited-plugin");
            cleanup(&launch);
            let mut overridden = super::tests::spec();
            overridden
                .env
                .insert(CONFIG.into(), "{\"model\":\"profile/model\"}".into());
            assert_eq!(
                effective_config(&overridden).unwrap(),
                "{\"model\":\"profile/model\"}"
            );
            return;
        }
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "opencode_state::tests::inherited_config_subprocess_contract", "--nocapture"])
            .env(MARKER, "1")
            .env("OPENCODE_PURE", "true")
            .env(CONFIG, "{ // inherited\n \"model\":\"inherited/model\",\"plugin\":[\"inherited-plugin\",],}")
            .output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
    }
}
