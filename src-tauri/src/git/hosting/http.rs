//! HTTPS client for hosting APIs with diagnosable, token-free errors.
use serde::{de::DeserializeOwned, Serialize};
use std::time::Duration;
use ureq::{
    config::RedirectAuthHeaders,
    tls::{RootCerts, TlsConfig},
    Agent,
};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HostErrorKind {
    Unauthorized,
    Forbidden,
    SsoRequired,
    NotFound,
    RateLimited,
    Conflict,
    Invalid,
    Server,
    Tls,
    Dns,
    Network,
    Timeout,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    pub kind: HostErrorKind,
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<HostError> for String {
    fn from(value: HostError) -> Self {
        value.message
    }
}

impl HostError {
    pub fn new(kind: HostErrorKind, status: Option<u16>, message: impl Into<String>) -> Self {
        Self {
            kind,
            status,
            message: message.into(),
        }
    }
}

fn describe_status(status: u16, sso: bool, body: &str) -> HostError {
    let detail: String = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .or_else(|| v.get("error_description"))
                .or_else(|| v.get("error"))
                .map(|m| m.to_string().trim_matches('"').to_owned())
        })
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect();
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!("（{detail}）")
    };
    let (kind, text) = match status {
        401 => (
            HostErrorKind::Unauthorized,
            "登入已失效或 token 無效，請重新設定帳號",
        ),
        403 if sso => (
            HostErrorKind::SsoRequired,
            "此組織需要 SSO 授權；請在系統瀏覽器為 token 完成授權後重試",
        ),
        403 if detail.to_lowercase().contains("rate limit") => {
            (HostErrorKind::RateLimited, "已達 API 使用上限，請稍後再試")
        }
        403 => (
            HostErrorKind::Forbidden,
            "權限不足：此帳號或 token 沒有這項操作的權限",
        ),
        404 => (HostErrorKind::NotFound, "找不到資源，或此帳號沒有讀取權限"),
        405 | 409 | 422 => (HostErrorKind::Conflict, "平台拒絕此操作"),
        429 => (HostErrorKind::RateLimited, "已達 API 使用上限，請稍後再試"),
        400..=499 => (HostErrorKind::Invalid, "平台拒絕此請求"),
        _ => (HostErrorKind::Server, "主機發生錯誤，請稍後再試"),
    };
    HostError::new(
        kind,
        Some(status),
        format!("{text}{suffix}（HTTP {status}）"),
    )
}

fn transport(error: ureq::Error) -> HostError {
    match error {
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) | ureq::Error::Pem(_) => HostError::new(
            HostErrorKind::Tls,
            None,
            "TLS 憑證驗證失敗：主機憑證不受作業系統信任。企業 CA 需安裝到系統信任區；Session Bay 不會停用憑證驗證",
        ),
        ureq::Error::HostNotFound => HostError::new(HostErrorKind::Dns, None, "找不到主機（DNS）；內網主機請確認 VPN 與主機名稱"),
        ureq::Error::Timeout(_) => HostError::new(HostErrorKind::Timeout, None, "連線逾時；請確認網路、VPN 或 proxy"),
        ureq::Error::Io(io) => HostError::new(HostErrorKind::Network, None, format!("無法連線主機（{}）；請確認網路、VPN、防火牆或 proxy", io.kind())),
        ureq::Error::ConnectionFailed => HostError::new(HostErrorKind::Network, None, "無法連線主機；請確認網路、VPN、防火牆或 proxy"),
        ureq::Error::InvalidProxyUrl => HostError::new(HostErrorKind::Network, None, "Proxy 環境變數設定無效"),
        other => HostError::new(HostErrorKind::Network, None, format!("連線失敗：{}", super::super::runner::redact_url_credentials(&other.to_string()))),
    }
}

/// HTTPS is required; plain HTTP is accepted only for loopback test hosts.
pub fn validate_base(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    if let Some(rest) = lower.strip_prefix("http://") {
        let host = rest.split(['/', ':']).next().unwrap_or_default();
        if host == "127.0.0.1" || host == "localhost" || host == "[::1]" {
            return Ok(());
        }
    }
    Err("主機網址必須使用 https://".into())
}

pub struct Response<T> {
    pub body: T,
    pub headers: Vec<(String, String)>,
}

impl<T> Response<T> {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Clone)]
pub struct Client {
    agent: Agent,
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy)]
pub enum Auth<'a> {
    Bearer(&'a str),
    /// GitLab personal access tokens.
    PrivateToken(&'a str),
}

impl Client {
    pub fn new() -> Self {
        let agent = Agent::config_builder()
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .proxy(ureq::Proxy::try_from_env())
            .redirect_auth_headers(RedirectAuthHeaders::Never)
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .user_agent("SessionBay")
            .build()
            .new_agent();
        Self { agent }
    }

    fn finish<T: DeserializeOwned>(
        result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    ) -> Result<Response<T>, HostError> {
        let mut response = result.map_err(transport)?;
        let status = response.status().as_u16();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
            .collect();
        let text = response
            .body_mut()
            .with_config()
            .limit(32 * 1024 * 1024)
            .read_to_string()
            .map_err(transport)?;
        if status >= 400 {
            let sso = headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("x-github-sso"));
            return Err(describe_status(status, sso, &text));
        }
        let body = if text.trim().is_empty() {
            serde_json::from_str("null")
        } else {
            serde_json::from_str(&text)
        }
        .map_err(|e| {
            HostError::new(
                HostErrorKind::Invalid,
                Some(status),
                format!("無法解析主機回應：{e}"),
            )
        })?;
        Ok(Response { body, headers })
    }

    fn authorize<B>(request: ureq::RequestBuilder<B>, auth: Auth<'_>) -> ureq::RequestBuilder<B> {
        match auth {
            Auth::Bearer(token) => request.header("Authorization", &format!("Bearer {token}")),
            Auth::PrivateToken(token) => request.header("PRIVATE-TOKEN", token),
        }
        .header("Accept", "application/json")
    }

    pub fn get<T: DeserializeOwned>(
        &self,
        url: &str,
        auth: Auth<'_>,
        extra: &[(&str, &str)],
    ) -> Result<Response<T>, HostError> {
        validate_base(url).map_err(|m| HostError::new(HostErrorKind::Invalid, None, m))?;
        let mut request = Self::authorize(self.agent.get(url), auth);
        for (key, value) in extra {
            request = request.header(*key, *value);
        }
        Self::finish(request.call())
    }

    pub fn send<T: DeserializeOwned>(
        &self,
        method: &str,
        url: &str,
        auth: Auth<'_>,
        body: &serde_json::Value,
        extra: &[(&str, &str)],
    ) -> Result<Response<T>, HostError> {
        validate_base(url).map_err(|m| HostError::new(HostErrorKind::Invalid, None, m))?;
        let mut request = Self::authorize(
            match method {
                "POST" => self.agent.post(url),
                "PUT" => self.agent.put(url),
                "PATCH" => self.agent.patch(url),
                _ => {
                    return Err(HostError::new(
                        HostErrorKind::Invalid,
                        None,
                        "不支援的 HTTP 方法",
                    ))
                }
            },
            auth,
        );
        for (key, value) in extra {
            request = request.header(*key, *value);
        }
        Self::finish(request.send_json(body))
    }

    /// Plain text responses (e.g. unified diffs).
    pub fn get_text(&self, url: &str, auth: Auth<'_>, accept: &str) -> Result<String, HostError> {
        validate_base(url).map_err(|m| HostError::new(HostErrorKind::Invalid, None, m))?;
        let request = match auth {
            Auth::Bearer(token) => self
                .agent
                .get(url)
                .header("Authorization", &format!("Bearer {token}")),
            Auth::PrivateToken(token) => self.agent.get(url).header("PRIVATE-TOKEN", token),
        }
        .header("Accept", accept);
        let mut response = request.call().map_err(transport)?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(16 * 1024 * 1024)
            .read_to_string()
            .map_err(transport)?;
        if status >= 400 {
            return Err(describe_status(status, false, &text));
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_https_except_loopback() {
        assert!(validate_base("https://gitlab.example.test/api/v4").is_ok());
        assert!(validate_base("http://127.0.0.1:8080/api").is_ok());
        assert!(validate_base("http://gitlab.example.test").is_err());
        assert!(validate_base("ftp://x").is_err());
    }

    #[test]
    fn statuses_are_explained_without_tokens() {
        assert_eq!(
            describe_status(401, false, "{\"message\":\"Bad credentials\"}").kind,
            HostErrorKind::Unauthorized
        );
        assert_eq!(
            describe_status(403, true, "").kind,
            HostErrorKind::SsoRequired
        );
        assert_eq!(
            describe_status(403, false, "{\"message\":\"API rate limit exceeded\"}").kind,
            HostErrorKind::RateLimited
        );
        assert!(describe_status(404, false, "").message.contains("HTTP 404"));
    }
}
