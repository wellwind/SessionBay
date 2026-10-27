//! HTTPS client for hosting APIs with diagnosable, token-free errors.
use crate::tr;
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

impl From<String> for HostError {
    fn from(message: String) -> Self {
        Self::new(HostErrorKind::Invalid, None, message)
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
        tr!(" ({{detail}})", detail = detail)
    };
    let (kind, text) = match status {
        401 => (
            HostErrorKind::Unauthorized,
            tr!("Your login expired or the token is invalid; set up the account again"),
        ),
        403 if sso => (
            HostErrorKind::SsoRequired,
            tr!("This organization requires SSO; authorize the token in your browser, then try again"),
        ),
        403 if detail.to_lowercase().contains("rate limit") => {
            (HostErrorKind::RateLimited, tr!("API rate limit reached; try again later"))
        }
        403 => (
            HostErrorKind::Forbidden,
            tr!("Permission denied: this account or token cannot do this"),
        ),
        404 => (HostErrorKind::NotFound, tr!("Not found, or this account cannot read it")),
        405 | 409 | 422 => (HostErrorKind::Conflict, tr!("The host rejected this operation")),
        429 => (HostErrorKind::RateLimited, tr!("API rate limit reached; try again later")),
        400..=499 => (HostErrorKind::Invalid, tr!("The host rejected this request")),
        _ => (HostErrorKind::Server, tr!("The host had an error; try again later")),
    };
    HostError::new(
        kind,
        Some(status),
        tr!(
            "{{text}}{{suffix}} (HTTP {{status}})",
            text = text,
            suffix = suffix,
            status = status
        ),
    )
}

fn transport(error: ureq::Error) -> HostError {
    match error {
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) | ureq::Error::Pem(_) => HostError::new(
            HostErrorKind::Tls,
            None,
            tr!("TLS certificate verification failed: your OS does not trust the host certificate. Install an enterprise CA into the system trust store; Session Bay never disables certificate verification"),
        ),
        ureq::Error::HostNotFound => HostError::new(HostErrorKind::Dns, None, tr!("Host not found (DNS); for internal hosts, check your VPN and the host name")),
        ureq::Error::Timeout(_) => HostError::new(HostErrorKind::Timeout, None, tr!("The connection timed out; check your network, VPN or proxy")),
        ureq::Error::Io(io) => HostError::new(HostErrorKind::Network, None, tr!("Cannot connect to the host ({{reason}}); check your network, VPN, firewall or proxy", reason = io.kind())),
        ureq::Error::ConnectionFailed => HostError::new(HostErrorKind::Network, None, tr!("Cannot connect to the host; check your network, VPN, firewall or proxy")),
        ureq::Error::InvalidProxyUrl => HostError::new(HostErrorKind::Network, None, tr!("Invalid proxy environment variables")),
        other => HostError::new(HostErrorKind::Network, None, tr!("Connection failed: {{error}}", error = super::super::runner::redact_url_credentials(&other.to_string()))),
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
    Err(tr!("The host URL must use https://"))
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
                tr!("Cannot parse the host response: {{error}}", error = e),
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
                        tr!("Unsupported HTTP method"),
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
