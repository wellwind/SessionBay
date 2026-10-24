//! GitHub and self-hosted GitLab connections.
//!
//! A connection is one account on one host. Settings keep only non-secret
//! fields; tokens come from the session, a secure Git credential helper or
//! the GitHub CLI, and caches are keyed by connection so hosts and accounts
//! never share credentials or data.
pub mod credentials;
pub mod http;
pub mod pulls;
pub mod remote_url;
pub mod review;

use super::runner::GitRunner;
use http::{Auth, Client, HostError, HostErrorKind};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Github,
    Gitlab,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TokenSource {
    /// Entered by the user; saved to a secure credential helper if possible.
    Entered,
    /// An existing Git credential for this host and account.
    GitCredential,
    /// The GitHub CLI's stored login.
    GhCli,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthScheme {
    Bearer,
    PrivateToken,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub provider: Provider,
    /// `host[:port]`, also the credential key.
    pub host: String,
    pub web_url: String,
    pub api_url: String,
    pub account: String,
    pub source: TokenSource,
    pub scheme: AuthScheme,
    /// Saved to the OS credential store by Session Bay (so it may forget it).
    pub stored_by_app: bool,
    pub server_version: Option<String>,
    pub scopes: Vec<String>,
    pub verified_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    pub repo_id: String,
    pub remote: String,
    pub connection_id: String,
    pub project: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsFile {
    pub connections: Vec<Connection>,
    pub mappings: Vec<Mapping>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "op")]
pub enum HostRequest {
    Connections,
    AddConnection {
        provider: Provider,
        web_url: String,
        account: Option<String>,
        token: Option<String>,
        source: TokenSource,
        #[serde(default)]
        persist: bool,
    },
    TestConnection {
        id: String,
    },
    RemoveConnection {
        id: String,
        #[serde(default)]
        forget: bool,
    },
    OpenExternal {
        url: String,
    },
}

pub struct Hosting {
    file: PathBuf,
    state: Mutex<()>,
    /// Session-only tokens, keyed by connection id.
    session: Mutex<HashMap<String, String>>,
    pub client: Client,
    pub cache: pulls::Cache,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Normalizes a web URL and derives the API base for the provider.
pub fn endpoints(provider: Provider, web_url: &str) -> Result<(String, String, String), String> {
    let web = web_url.trim().trim_end_matches('/').to_owned();
    http::validate_base(&web)?;
    let rest = web
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or_default();
    let (authority, _) = rest.split_once('/').unwrap_or((rest, ""));
    let authority = authority
        .rsplit_once('@')
        .map(|(_, a)| a)
        .unwrap_or(authority)
        .to_lowercase();
    if authority.is_empty() || authority.contains(char::is_whitespace) {
        return Err("主機網址無效".into());
    }
    let web = format!(
        "{}://{authority}{}",
        web.split("://").next().unwrap_or("https"),
        &rest[rest.find('/').unwrap_or(rest.len())..]
    );
    let api = match provider {
        Provider::Github if authority == "github.com" => "https://api.github.com".to_owned(),
        Provider::Github => format!("{web}/api/v3"),
        Provider::Gitlab => format!("{web}/api/v4"),
    };
    Ok((authority, web, api))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub account: String,
    pub server_version: Option<String>,
    pub scopes: Vec<String>,
    pub scheme: AuthScheme,
}

pub fn auth(scheme: AuthScheme, token: &str) -> Auth<'_> {
    match scheme {
        AuthScheme::Bearer => Auth::Bearer(token),
        AuthScheme::PrivateToken => Auth::PrivateToken(token),
    }
}

/// Confirms who a token belongs to and what the server is.
pub fn identify(
    client: &Client,
    provider: Provider,
    api: &str,
    token: &str,
) -> Result<Identity, HostError> {
    match provider {
        Provider::Github => {
            let response = client.get::<serde_json::Value>(
                &format!("{api}/user"),
                Auth::Bearer(token),
                &[("X-GitHub-Api-Version", "2022-11-28")],
            )?;
            let account = response.body["login"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let scopes = response
                .header("x-oauth-scopes")
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_owned())
                        .filter(|p| !p.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let version = response
                .header("x-github-enterprise-version")
                .map(|v| format!("GitHub Enterprise Server {v}"));
            Ok(Identity {
                account,
                server_version: version.or_else(|| Some("github.com".into())),
                scopes,
                scheme: AuthScheme::Bearer,
            })
        }
        Provider::Gitlab => {
            // Personal access tokens use PRIVATE-TOKEN; OAuth tokens (e.g. from
            // Git Credential Manager) use Bearer.
            let (response, scheme) = match client.get::<serde_json::Value>(
                &format!("{api}/user"),
                Auth::PrivateToken(token),
                &[],
            ) {
                Ok(response) => (response, AuthScheme::PrivateToken),
                Err(error) if error.kind == HostErrorKind::Unauthorized => (
                    client.get::<serde_json::Value>(
                        &format!("{api}/user"),
                        Auth::Bearer(token),
                        &[],
                    )?,
                    AuthScheme::Bearer,
                ),
                Err(error) => return Err(error),
            };
            let account = response.body["username"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let version = client
                .get::<serde_json::Value>(&format!("{api}/version"), auth(scheme, token), &[])
                .ok()
                .and_then(|r| r.body["version"].as_str().map(|v| format!("GitLab {v}")));
            let scopes = client
                .get::<serde_json::Value>(
                    &format!("{api}/personal_access_tokens/self"),
                    auth(scheme, token),
                    &[],
                )
                .ok()
                .and_then(|r| {
                    r.body["scopes"].as_array().map(|s| {
                        s.iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect()
                    })
                })
                .unwrap_or_default();
            Ok(Identity {
                account,
                server_version: version,
                scopes,
                scheme,
            })
        }
    }
}

impl Hosting {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            state: Mutex::new(()),
            session: Mutex::new(HashMap::new()),
            client: Client::new(),
            cache: pulls::Cache::default(),
        }
    }

    pub fn load(&self) -> HostsFile {
        fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save(&self, hosts: &HostsFile) -> Result<(), String> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temporary = self.file.with_extension("json.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(hosts).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("無法儲存主機設定：{e}"))?;
        fs::rename(&temporary, &self.file).map_err(|e| format!("無法儲存主機設定：{e}"))
    }

    pub fn connection(&self, id: &str) -> Result<Connection, String> {
        self.load()
            .connections
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| "找不到主機連線".into())
    }

    /// The token for a connection, from the session or its secure source.
    pub fn token(
        &self,
        runner: &GitRunner,
        cwd: &Path,
        connection: &Connection,
    ) -> Result<String, String> {
        if let Some(token) = self
            .session
            .lock()
            .map_err(|_| "鎖定失敗")?
            .get(&connection.id)
        {
            return Ok(token.clone());
        }
        let found = match connection.source {
            TokenSource::GhCli => credentials::gh_token(&connection.host),
            TokenSource::Entered | TokenSource::GitCredential => {
                credentials::fill(runner, cwd, &connection.host, &connection.account)?
            }
        };
        found.ok_or_else(|| {
            format!(
                "找不到 {}@{} 的登入資訊；請重新設定帳號",
                connection.account, connection.host
            )
        })
    }

    pub fn handle(
        &self,
        runner: &GitRunner,
        cwd: &Path,
        request: HostRequest,
    ) -> Result<serde_json::Value, String> {
        match request {
            HostRequest::Connections => {
                let hosts = self.load();
                let session = self.session.lock().map_err(|_| "鎖定失敗")?;
                let list: Vec<serde_json::Value> = hosts
                    .connections
                    .iter()
                    .map(|c| {
                        let mut value = serde_json::to_value(c).unwrap_or_default();
                        value["sessionOnly"] = serde_json::json!(session.contains_key(&c.id));
                        value["helper"] =
                            serde_json::to_value(credentials::helper_info(runner, cwd, &c.host))
                                .unwrap_or_default();
                        value
                    })
                    .collect();
                Ok(serde_json::json!({
                    "connections": list,
                    "ghAvailable": crate::config::resolve_executable("gh").is_ok(),
                }))
            }
            HostRequest::AddConnection {
                provider,
                web_url,
                account,
                token,
                source,
                persist,
            } => {
                let _guard = self.state.lock().map_err(|_| "鎖定失敗")?;
                let (host, web, api) = endpoints(provider, &web_url)?;
                let account_hint = account
                    .map(|a| a.trim().to_owned())
                    .filter(|a| !a.is_empty());
                let token = match source {
                    TokenSource::Entered => token
                        .map(|t| t.trim().to_owned())
                        .filter(|t| !t.is_empty())
                        .ok_or("請輸入 token")?,
                    TokenSource::GitCredential => {
                        let account = account_hint
                            .as_deref()
                            .ok_or("使用既有 Git 憑證需要填寫帳號名稱")?;
                        credentials::fill(runner, cwd, &host, account)?.ok_or_else(|| {
                            format!("Git credential helper 沒有 {account}@{host} 的憑證")
                        })?
                    }
                    TokenSource::GhCli => credentials::gh_token(&host)
                        .ok_or("GitHub CLI 沒有此主機的登入（gh auth login）")?,
                };
                let identity = identify(&self.client, provider, &api, &token)?;
                if identity.account.is_empty() {
                    return Err("主機沒有回報帳號名稱".into());
                }
                if let Some(hint) = &account_hint {
                    if !hint.eq_ignore_ascii_case(&identity.account) {
                        return Err(format!(
                            "Token 屬於 {}，不是 {hint}；未儲存",
                            identity.account
                        ));
                    }
                }
                let mut hosts = self.load();
                if hosts
                    .connections
                    .iter()
                    .any(|c| c.host == host && c.account.eq_ignore_ascii_case(&identity.account))
                {
                    return Err(format!("{}@{host} 已經連線", identity.account));
                }
                let id = uuid::Uuid::new_v4().simple().to_string();
                let mut warnings = Vec::new();
                let mut stored_by_app = false;
                if source == TokenSource::Entered {
                    let saved = if persist {
                        credentials::approve(runner, cwd, &host, &identity.account, &token)
                    } else {
                        Err("依選擇只在本次執行期間保留 token".into())
                    };
                    match saved {
                        Ok(()) => stored_by_app = true,
                        Err(message) => {
                            warnings.push(message);
                            self.session
                                .lock()
                                .map_err(|_| "鎖定失敗")?
                                .insert(id.clone(), token.clone());
                        }
                    }
                }
                let connection = Connection {
                    id,
                    provider,
                    host,
                    web_url: web,
                    api_url: api,
                    account: identity.account,
                    source,
                    scheme: identity.scheme,
                    stored_by_app,
                    server_version: identity.server_version,
                    scopes: identity.scopes,
                    verified_at: now(),
                };
                hosts.connections.push(connection.clone());
                self.save(&hosts)?;
                Ok(serde_json::json!({ "connection": connection, "warnings": warnings }))
            }
            HostRequest::TestConnection { id } => {
                let connection = self.connection(&id)?;
                let token = self.token(runner, cwd, &connection)?;
                let identity = identify(
                    &self.client,
                    connection.provider,
                    &connection.api_url,
                    &token,
                )?;
                if !identity.account.eq_ignore_ascii_case(&connection.account) {
                    return Err(format!(
                        "目前的 token 屬於 {}，不是 {}",
                        identity.account, connection.account
                    ));
                }
                let _guard = self.state.lock().map_err(|_| "鎖定失敗")?;
                let mut hosts = self.load();
                if let Some(saved) = hosts.connections.iter_mut().find(|c| c.id == id) {
                    saved.server_version = identity.server_version.clone();
                    saved.scopes = identity.scopes.clone();
                    saved.scheme = identity.scheme;
                    saved.verified_at = now();
                }
                self.save(&hosts)?;
                serde_json::to_value(&identity).map_err(|e| e.to_string())
            }
            HostRequest::RemoveConnection { id, forget } => {
                let _guard = self.state.lock().map_err(|_| "鎖定失敗")?;
                let mut hosts = self.load();
                let connection = hosts
                    .connections
                    .iter()
                    .find(|c| c.id == id)
                    .cloned()
                    .ok_or("找不到主機連線")?;
                if forget && connection.stored_by_app {
                    credentials::reject(runner, cwd, &connection.host, &connection.account)?;
                }
                hosts.connections.retain(|c| c.id != id);
                hosts.mappings.retain(|m| m.connection_id != id);
                self.save(&hosts)?;
                self.session.lock().map_err(|_| "鎖定失敗")?.remove(&id);
                self.cache.forget(&id);
                Ok(serde_json::Value::Null)
            }
            HostRequest::OpenExternal { url } => {
                self.open_external(&url)?;
                Ok(serde_json::Value::Null)
            }
        }
    }

    /// Opens a page of a configured host (or a token page) in the system
    /// browser; arbitrary URLs are refused.
    pub fn open_external(&self, url: &str) -> Result<(), String> {
        http::validate_base(url)?;
        let lower = url.to_ascii_lowercase();
        let allowed = lower.starts_with("https://github.com/")
            || self
                .load()
                .connections
                .iter()
                .any(|c| lower.starts_with(&format!("{}/", c.web_url.to_ascii_lowercase())));
        if !allowed || url.chars().any(|c| c.is_control() || c == ' ') {
            return Err("只能開啟已設定主機的網址".into());
        }
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("open");
        #[cfg(windows)]
        let mut command = {
            let mut command = std::process::Command::new("rundll32");
            command.arg("url.dll,FileProtocolHandler");
            command
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut command = std::process::Command::new("xdg-open");
        command
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("無法開啟瀏覽器：{e}"))
    }

    pub fn mappings_for(&self, repo_id: &str) -> Vec<Mapping> {
        self.load()
            .mappings
            .into_iter()
            .filter(|m| m.repo_id == repo_id)
            .collect()
    }

    pub fn set_mapping(
        &self,
        repo_id: &str,
        remote: &str,
        connection_id: Option<&str>,
        project: Option<&str>,
    ) -> Result<(), String> {
        let _guard = self.state.lock().map_err(|_| "鎖定失敗")?;
        let mut hosts = self.load();
        hosts
            .mappings
            .retain(|m| !(m.repo_id == repo_id && m.remote == remote));
        if let Some(connection_id) = connection_id {
            if !hosts.connections.iter().any(|c| c.id == connection_id) {
                return Err("找不到主機連線".into());
            }
            let project = project
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or("請填寫 project 路徑")?;
            if project.split('/').count() < 2
                || project
                    .split('/')
                    .any(|p| p.is_empty() || p == "." || p == "..")
                || project.contains(char::is_whitespace)
            {
                return Err("Project 路徑格式應為 owner/repo 或 group/subgroup/project".into());
            }
            hosts.mappings.push(Mapping {
                repo_id: repo_id.to_owned(),
                remote: remote.to_owned(),
                connection_id: connection_id.to_owned(),
                project: project.to_owned(),
            });
        }
        self.save(&hosts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_api_endpoints_per_provider() {
        assert_eq!(
            endpoints(Provider::Github, "https://github.com/").unwrap(),
            (
                "github.com".into(),
                "https://github.com".into(),
                "https://api.github.com".into()
            )
        );
        assert_eq!(
            endpoints(Provider::Github, "https://ghe.example.test")
                .unwrap()
                .2,
            "https://ghe.example.test/api/v3"
        );
        let (host, web, api) = endpoints(
            Provider::Gitlab,
            "https://user@GitLab.Example.test:8443/gitlab",
        )
        .unwrap();
        assert_eq!(host, "gitlab.example.test:8443");
        assert_eq!(web, "https://gitlab.example.test:8443/gitlab");
        assert_eq!(api, "https://gitlab.example.test:8443/gitlab/api/v4");
        assert!(endpoints(Provider::Gitlab, "http://gitlab.example.test").is_err());
    }
}
