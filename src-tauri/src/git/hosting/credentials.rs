//! Tokens live in the user's existing secure credential flow, never in
//! Session Bay settings: Git credential helpers (Keychain, Credential
//! Manager, libsecret) keyed by host and account, or the GitHub CLI store.
use super::super::runner::{Access, GitRunner, Invocation};
use serde::Serialize;
use std::{path::Path, process::Stdio, time::Duration};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HelperInfo {
    pub helpers: Vec<String>,
    /// A helper that keeps secrets in OS secure storage is configured.
    pub secure: bool,
    /// A plaintext helper (`store`) is configured; Session Bay won't save to it.
    pub plaintext: bool,
}

const SECURE_HELPERS: &[&str] = &[
    "osxkeychain",
    "manager",
    "manager-core",
    "wincred",
    "libsecret",
    "gnome-keyring",
    "1password",
    "oauth",
];

pub fn helper_info(runner: &GitRunner, cwd: &Path, host: &str) -> HelperInfo {
    let mut helpers = Vec::new();
    for key in [
        "credential.helper".to_owned(),
        format!("credential.https://{host}.helper"),
    ] {
        if let Ok(output) = runner.run(Invocation::new(
            cwd,
            Access::Read,
            ["config", "--get-all", &key],
        )) {
            if output.success() {
                helpers.extend(
                    output
                        .stdout_text()
                        .lines()
                        .map(str::trim)
                        .filter(|l| !l.is_empty())
                        .map(str::to_owned),
                );
            }
        }
    }
    let name = |helper: &String| {
        helper
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .trim_start_matches("git-credential-")
            .to_owned()
    };
    let secure = helpers
        .iter()
        .any(|h| SECURE_HELPERS.iter().any(|s| name(h).contains(s)));
    let plaintext = helpers.iter().any(|h| name(h) == "store");
    HelperInfo {
        helpers,
        secure,
        plaintext,
    }
}

fn credential_input(host: &str, account: &str, password: Option<&str>) -> Result<Vec<u8>, String> {
    for value in [host, account] {
        if value.is_empty() || value.contains(['\n', '\0', '\r']) {
            return Err("主機或帳號名稱無效".into());
        }
    }
    let mut input = format!("protocol=https\nhost={host}\nusername={account}\n");
    if let Some(password) = password {
        if password.contains(['\n', '\0', '\r']) {
            return Err("Token 含無效字元".into());
        }
        input.push_str(&format!("password={password}\n"));
    }
    input.push('\n');
    Ok(input.into_bytes())
}

/// Looks up an existing credential without prompting.
pub fn fill(
    runner: &GitRunner,
    cwd: &Path,
    host: &str,
    account: &str,
) -> Result<Option<String>, String> {
    let output = runner
        .run(
            Invocation::new(
                cwd,
                Access::Read,
                ["-c", "credential.interactive=false", "credential", "fill"],
            )
            .stdin(credential_input(host, account, None)?)
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "")
            .timeout(Duration::from_secs(20)),
        )
        .map_err(String::from)?;
    if !output.success() {
        return Ok(None);
    }
    let text = output.stdout_text();
    let mut user = None;
    let mut password = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("username=") {
            user = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("password=") {
            password = Some(value.to_owned());
        }
    }
    // A helper answering for a different account must not be used.
    Ok(password.filter(|p| !p.is_empty() && user.as_deref() == Some(account)))
}

pub fn approve(
    runner: &GitRunner,
    cwd: &Path,
    host: &str,
    account: &str,
    token: &str,
) -> Result<(), String> {
    let info = helper_info(runner, cwd, host);
    if !info.secure {
        return Err(if info.plaintext {
            "目前的 Git credential helper 會以明文保存（store）；Session Bay 不會寫入，token 只在本次執行期間保留".into()
        } else {
            "沒有設定安全的 Git credential helper；token 只在本次執行期間保留".into()
        });
    }
    runner
        .ok(
            Invocation::new(cwd, Access::Read, ["credential", "approve"]).stdin(credential_input(
                host,
                account,
                Some(token),
            )?),
        )
        .map(|_| ())
        .map_err(|e| format!("無法寫入安全憑證儲存：{e}"))
}

pub fn reject(runner: &GitRunner, cwd: &Path, host: &str, account: &str) -> Result<(), String> {
    runner
        .ok(Invocation::new(cwd, Access::Read, ["credential", "reject"])
            .stdin(credential_input(host, account, None)?))
        .map(|_| ())
        .map_err(String::from)
}

/// Reads the token the GitHub CLI already keeps for `host`, if installed.
pub fn gh_token(host: &str) -> Option<String> {
    let executable = crate::config::resolve_executable("gh").ok()?;
    let mut command = crate::host_environment::command(&executable).ok()?;
    let child = command
        .args(["auth", "token", "--hostname", host])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let output = child.wait_with_output().ok()?;
    let token = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (output.status.success() && !token.is_empty() && !token.contains(char::is_whitespace))
        .then_some(token)
}
