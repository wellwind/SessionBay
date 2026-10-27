//! Checks GitHub Releases for a newer Session Bay version.
//!
//! The only data sent is an anonymous request for the public release list; the
//! check can be turned off in Settings. Installing is always left to the user.
use crate::tr;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use ureq::tls::{RootCerts, TlsConfig};
use ureq::Agent;

const RELEASES_API: &str = "https://api.github.com/repos/wellwind/SessionBay/releases?per_page=30";
const RELEASE_PAGES: &str = "https://github.com/wellwind/SessionBay/releases/";
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    published_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub url: String,
    pub prerelease: bool,
    pub published_at: Option<String>,
}

/// `major.minor.patch` with an optional `-pre` suffix; build metadata is ignored.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Version {
    core: (u64, u64, u64),
    // A release (`None`) sorts after any prerelease of the same core version.
    release: bool,
    pre: Vec<String>,
}

fn parse_version(text: &str) -> Option<Version> {
    let text = text.trim().trim_start_matches('v');
    let text = text.split('+').next()?;
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (text, None),
    };
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() {
        return None;
    }
    Some(Version {
        core: version,
        release: pre.is_none(),
        pre: pre
            .map(|p| p.split('.').map(str::to_owned).collect())
            .unwrap_or_default(),
    })
}

/// Picks the newest published release that is newer than `current`.
fn newest(current: &str, releases: Vec<Release>) -> Option<UpdateInfo> {
    let current_version = parse_version(current)?;
    releases
        .into_iter()
        .filter(|r| !r.draft && r.html_url.starts_with(RELEASE_PAGES))
        .filter_map(|r| Some((parse_version(&r.tag_name)?, r)))
        .filter(|(version, _)| *version > current_version)
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, r)| UpdateInfo {
            current: current.to_owned(),
            latest: r.tag_name.trim_start_matches('v').to_owned(),
            url: r.html_url,
            prerelease: r.prerelease,
            published_at: r.published_at,
        })
}

/// Returns the newest release when one is newer than this build.
pub fn check(current: &str) -> Result<Option<UpdateInfo>, String> {
    let agent: Agent = Agent::config_builder()
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .proxy(ureq::Proxy::try_from_env())
        .timeout_global(Some(Duration::from_secs(15)))
        .user_agent(format!("SessionBay/{current}"))
        .build()
        .new_agent();
    let failed = |error: &dyn std::fmt::Display| {
        tr!("Could not check for updates: {{error}}", error = error)
    };
    let mut response = agent
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| failed(&e))?;
    let releases: Vec<Release> = response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_json()
        .map_err(|e| failed(&e))?;
    Ok(newest(current, releases))
}

/// Opens a release page of this repository; any other URL is refused.
pub fn open_release(url: &str) -> Result<(), String> {
    let tag = url.strip_prefix(RELEASE_PAGES).unwrap_or_default();
    let valid = tag.strip_prefix("tag/").is_some_and(|t| {
        !t.is_empty()
            && t.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    });
    if !valid {
        return Err(tr!("Only Session Bay release pages can be opened"));
    }
    crate::git::hosting::open_in_browser(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, draft: bool, prerelease: bool) -> Release {
        Release {
            tag_name: tag.into(),
            html_url: format!("{RELEASE_PAGES}tag/{tag}"),
            draft,
            prerelease,
            published_at: None,
        }
    }

    #[test]
    fn versions_order_like_semver() {
        let v = |t| parse_version(t).unwrap();
        assert!(v("0.2.0") > v("0.1.9"));
        assert!(v("v1.0.0") > v("1.0.0-rc.1"));
        assert!(v("1.0.0-rc.2") > v("1.0.0-rc.1"));
        assert!(v("0.10.0") > v("0.9.0"));
        assert!(parse_version("latest").is_none());
        assert!(parse_version("1.2").is_none());
    }

    #[test]
    fn picks_the_newest_published_release_including_previews() {
        let releases = vec![
            release("v0.1.0", false, true),
            release("v0.3.0", true, false),
            release("v0.2.1", false, true),
            release("v0.2.0", false, false),
            release("nightly", false, true),
        ];
        let update = newest("0.1.0", releases).unwrap();
        assert_eq!(update.latest, "0.2.1");
        assert!(update.prerelease);
        assert_eq!(update.url, format!("{RELEASE_PAGES}tag/v0.2.1"));
    }

    #[test]
    fn reports_nothing_when_up_to_date_or_links_are_foreign() {
        assert_eq!(newest("0.2.0", vec![release("v0.2.0", false, false)]), None);
        let mut foreign = release("v9.0.0", false, false);
        foreign.html_url = "https://example.invalid/v9.0.0".into();
        assert_eq!(newest("0.1.0", vec![foreign]), None);
    }

    #[test]
    fn only_release_pages_can_be_opened() {
        for url in [
            "https://example.invalid/",
            "https://github.com/wellwind/SessionBay/releases/tag/",
            "https://github.com/wellwind/SessionBay/releases/tag/v1;rm",
            "https://github.com/other/repo/releases/tag/v1.0.0",
        ] {
            assert!(open_release(url).is_err(), "{url}");
        }
    }

    /// Real network call against the public API: `cargo test -- --ignored updates`.
    #[test]
    #[ignore]
    fn live_release_list_is_readable() {
        assert!(check("0.0.0").is_ok());
    }
}
