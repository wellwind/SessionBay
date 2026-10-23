//! Repository-relative paths exactly as Git reports them.
//!
//! The UI receives a readable `path`; `raw` (base64 bytes) is present only when
//! the bytes are not UTF-8, so non-UTF-8 names survive a round trip.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RepoPath(pub Vec<u8>);

impl RepoPath {
    pub fn from_text(value: &str) -> Self {
        Self(value.as_bytes().to_vec())
    }
    pub fn display(&self) -> String {
        String::from_utf8_lossy(&self.0).into_owned()
    }
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
    /// Rejects paths that could escape the work tree or be read as options.
    pub fn validate(&self) -> Result<(), String> {
        let bytes = &self.0;
        if bytes.is_empty() || bytes.len() > 4096 || bytes.contains(&0) {
            return Err("檔案路徑無效".into());
        }
        if bytes.starts_with(b"/") || bytes.contains(&b'\\') && cfg!(windows) {
            return Err("檔案路徑必須是 repository 相對路徑".into());
        }
        if bytes
            .split(|b| *b == b'/')
            .any(|part| part == b".." || part == b"." || part.is_empty())
        {
            return Err("檔案路徑不可包含 . 或 .. 片段".into());
        }
        if bytes.split(|b| *b == b'/').next() == Some(b".git") {
            return Err("不可直接操作 .git 內部檔案".into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Wire<'a> {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw: Option<&'a str>,
}

impl Serialize for RepoPath {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match std::str::from_utf8(&self.0) {
            Ok(text) => Wire {
                path: text.to_owned(),
                raw: None,
            }
            .serialize(serializer),
            Err(_) => {
                let encoded = STANDARD.encode(&self.0);
                Wire {
                    path: self.display(),
                    raw: Some(&encoded),
                }
                .serialize(serializer)
            }
        }
    }
}

impl<'de> Deserialize<'de> for RepoPath {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Input {
            Text(String),
            Object {
                path: String,
                #[serde(default)]
                raw: Option<String>,
            },
        }
        let path = match Input::deserialize(deserializer)? {
            Input::Text(path) => RepoPath(path.into_bytes()),
            Input::Object { raw: Some(raw), .. } => {
                RepoPath(STANDARD.decode(raw).map_err(de::Error::custom)?)
            }
            Input::Object { path, raw: None } => RepoPath(path.into_bytes()),
        };
        path.validate().map_err(de::Error::custom)?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_utf8_paths_round_trip_through_raw_bytes() {
        let path = RepoPath(vec![b'a', 0xff, b'.', b't']);
        let json = serde_json::to_string(&path).unwrap();
        assert!(json.contains("\"raw\""));
        let back: RepoPath = serde_json::from_str(&json).unwrap();
        assert_eq!(back, path);
        let plain: RepoPath = serde_json::from_str("\"dir/-file name.txt\"").unwrap();
        assert_eq!(plain.as_bytes(), b"dir/-file name.txt");
    }

    #[test]
    fn rejects_escaping_and_git_internal_paths() {
        for bad in ["../x", "/etc/passwd", "a/../b", ".git/config", "", "a//b"] {
            assert!(RepoPath::from_text(bad).validate().is_err(), "{bad}");
        }
        assert!(RepoPath::from_text("-rf").validate().is_ok());
        assert!(RepoPath::from_text(".github/workflows/ci.yml")
            .validate()
            .is_ok());
    }
}
