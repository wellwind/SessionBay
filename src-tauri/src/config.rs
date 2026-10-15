use crate::models::{AgentKind, HistorySource};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Executables {
    pub codex: String,
    pub claude: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub version: u32,
    pub theme: String,
    pub terminal_theme: String,
    pub font_family: String,
    pub font_size: u16,
    pub default_agent: AgentKind,
    pub default_profile_id: String,
    pub profiles: Vec<ShellProfile>,
    pub sources: Vec<HistorySource>,
    pub executables: Executables,
    pub shortcuts: HashMap<String, String>,
    pub onboarding_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub kind: AgentKind,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub available: bool,
    pub error: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_file())
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    "/bin/zsh".into()
                } else {
                    "/bin/bash".into()
                }
            });
        let mut shortcuts = HashMap::new();
        for (id, key) in [
            ("command-palette", "Mod+Shift+P"),
            ("search-sessions", "Mod+Shift+F"),
            ("new-terminal", "Mod+Shift+T"),
            ("new-agent", "Mod+Shift+A"),
            ("split-right", "Mod+Shift+D"),
            ("split-down", "Mod+Shift+E"),
            ("next-pane", "Mod+Shift+]"),
            ("maximize-pane", "Mod+Shift+M"),
            ("close-pane", "Mod+Shift+W"),
            ("toggle-sidebar", "Mod+Shift+B"),
        ] {
            shortcuts.insert(id.into(), key.into());
        }
        Self {
            version: 1,
            theme: "dark".into(),
            terminal_theme: "bay".into(),
            font_family: "ui-monospace, SFMono-Regular, Menlo, monospace".into(),
            font_size: 14,
            default_agent: AgentKind::Codex,
            default_profile_id: "default".into(),
            profiles: vec![ShellProfile {
                id: "default".into(),
                name: "預設 Shell".into(),
                executable: shell,
                args: vec!["-l".into()],
                env: HashMap::new(),
            }],
            sources: vec![
                HistorySource {
                    id: "codex-default".into(),
                    kind: AgentKind::Codex,
                    root: std::env::var("CODEX_HOME")
                        .unwrap_or_else(|_| home.join(".codex").to_string_lossy().into_owned()),
                    enabled: true,
                },
                HistorySource {
                    id: "claude-default".into(),
                    kind: AgentKind::Claude,
                    root: std::env::var("CLAUDE_CONFIG_DIR")
                        .unwrap_or_else(|_| home.join(".claude").to_string_lossy().into_owned()),
                    enabled: true,
                },
            ],
            executables: Executables {
                codex: "codex".into(),
                claude: "claude".into(),
            },
            shortcuts,
            onboarding_complete: false,
        }
    }
}

fn clean_string(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.contains('\0')
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("不支援的設定版本；請保留原檔並更新應用程式".into());
        }
        if !["dark", "light", "system"].contains(&self.theme.as_str())
            || !["bay", "classic"].contains(&self.terminal_theme.as_str())
        {
            return Err("主題設定無效".into());
        }
        if !(9..=32).contains(&self.font_size) || !clean_string(&self.font_family, 256) {
            return Err("字型大小須為 9–32，且字型名稱不可為空".into());
        }
        if self.profiles.is_empty() || self.profiles.len() > 32 || self.sources.len() > 32 {
            return Err("至少需要一個 Shell Profile，最多 32 個 Profile／來源".into());
        }
        let mut profiles = HashSet::new();
        for p in &self.profiles {
            if !clean_string(&p.id, 128)
                || !profiles.insert(&p.id)
                || !clean_string(&p.name, 128)
                || !clean_string(&p.executable, 4096)
                || p.args.len() > 64
                || p.args.iter().any(|a| a.len() > 8192 || a.contains('\0'))
            {
                return Err("Shell Profile 的 ID、名稱、執行檔或參數無效".into());
            }
            if p.env.len() > 64
                || p.env.iter().any(|(k, v)| {
                    k.is_empty()
                        || k.len() > 128
                        || k.contains(['=', '\0'])
                        || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                        || v.len() > 8192
                        || v.contains('\0')
                })
            {
                return Err("環境變數格式無效".into());
            }
        }
        if !profiles.contains(&self.default_profile_id) {
            return Err("預設 Shell Profile 不存在".into());
        }
        let mut ids = HashSet::new();
        let mut roots = HashSet::new();
        for s in &self.sources {
            if !clean_string(&s.id, 128)
                || !ids.insert(&s.id)
                || !clean_string(&s.root, 4096)
                || !Path::new(&s.root).is_absolute()
            {
                return Err("來源 ID 不可重複，資料根目錄必須是絕對路徑".into());
            }
            let root = fs::canonicalize(&s.root).unwrap_or_else(|_| PathBuf::from(&s.root));
            if !roots.insert((format!("{:?}", s.kind), root)) {
                return Err("同一 Agent 的資料根目錄不可重複".into());
            }
        }
        if !clean_string(&self.executables.codex, 4096)
            || !clean_string(&self.executables.claude, 4096)
        {
            return Err("Agent 執行檔設定不可空白".into());
        }
        if self.shortcuts.len() > 32 {
            return Err("快捷鍵設定過多".into());
        }
        let mut keys = HashSet::new();
        for (id, key) in &self.shortcuts {
            if !clean_string(id, 64) || key.len() > 64 || key.contains('\0') {
                return Err("快捷鍵格式無效".into());
            }
            if !key.is_empty() && !keys.insert(key.to_lowercase()) {
                return Err(format!("快捷鍵衝突：{key}"));
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct ConfigStore {
    pub directory: PathBuf,
}
impl ConfigStore {
    pub fn open(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|e| format!("無法建立應用資料目錄：{e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Ok(Self { directory })
    }
    pub fn load_settings(&self) -> (Settings, Vec<String>) {
        let path = self.directory.join("settings.json");
        match read_bounded(&path, 1024 * 1024) {
            Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes)
                .map_err(|e| e.to_string())
                .and_then(|s| {
                    s.validate()?;
                    Ok(s)
                }) {
                Ok(s) => (s, vec![]),
                Err(e) => (
                    Settings::default(),
                    vec![format!("設定檔無法讀取，已使用預設值；原檔保留：{e}")],
                ),
            },
            Err(_) if !path.exists() => (Settings::default(), vec![]),
            Err(e) => (Settings::default(), vec![format!("設定檔讀取失敗：{e}")]),
        }
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        settings.validate()?;
        self.write_json("settings.json", settings)
    }
    pub fn load_workspace(&self) -> (serde_json::Value, Option<String>) {
        let path = self.directory.join("workspace.json");
        if !path.exists() {
            return (
                serde_json::json!({"version":1,"tabs":[],"panes":[],"activeTabId":null}),
                None,
            );
        }
        match read_bounded(&path, 2 * 1024 * 1024)
            .and_then(|v| {
                serde_json::from_slice::<serde_json::Value>(&v).map_err(|e| e.to_string())
            })
            .and_then(|v| {
                validate_workspace(&v)?;
                Ok(v)
            }) {
            Ok(v) => (v, None),
            Err(e) => (
                serde_json::json!({"version":1,"tabs":[],"panes":[],"activeTabId":null}),
                Some(format!("布局已還原預設值；原檔保留：{e}")),
            ),
        }
    }
    pub fn save_workspace(&self, workspace: &serde_json::Value) -> Result<(), String> {
        validate_workspace(workspace)?;
        self.write_json("workspace.json", workspace)
    }
    fn write_json(&self, name: &str, value: &impl Serialize) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
        let target = self.directory.join(name);
        let temporary = self
            .directory
            .join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &target)?;
            Ok::<_, std::io::Error>(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result.map_err(|e| format!("設定儲存失敗：{e}"))
    }
}

fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    file.take((max + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > max {
        return Err("檔案超過大小限制".into());
    }
    Ok(data)
}

pub fn validate_workspace(value: &serde_json::Value) -> Result<(), String> {
    if value.get("version").and_then(|v| v.as_u64()) != Some(1) || !value.is_object() {
        return Err("不支援的布局版本".into());
    }
    if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
        return Err("布局超過 2 MiB 限制".into());
    }
    fn check(v: &serde_json::Value, depth: usize) -> bool {
        if depth > 32 {
            return false;
        }
        match v {
            serde_json::Value::Object(m) => {
                !m.keys()
                    .any(|k| ["pid", "runtimeId", "onEvent"].contains(&k.as_str()))
                    && m.values().all(|v| check(v, depth + 1))
            }
            serde_json::Value::Array(a) => a.len() <= 256 && a.iter().all(|v| check(v, depth + 1)),
            _ => true,
        }
    }
    if !check(value, 0) {
        return Err("布局不可保存 Runtime/PID，或超過巢狀與數量限制".into());
    }
    Ok(())
}

pub fn resolve_executable(value: &str) -> Result<PathBuf, String> {
    if !clean_string(value, 4096) {
        return Err("執行檔名稱無效".into());
    }
    let value = Path::new(value);
    let candidates = if value.components().count() > 1 || value.is_absolute() {
        if !value.is_absolute() {
            return Err("自訂執行檔請填寫絕對路徑".into());
        }
        vec![value.to_path_buf()]
    } else {
        let mut paths: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .filter(|p| p.is_absolute())
                .collect();
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".local/bin"));
            paths.push(home.join(".cargo/bin"));
        }
        for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            paths.push(PathBuf::from(p));
        }
        paths.into_iter().map(|p| p.join(value)).collect()
    };
    for p in candidates {
        if let Ok(m) = fs::metadata(&p) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if m.is_file() && m.permissions().mode() & 0o111 != 0 {
                    return Ok(p);
                }
            }
        }
    }
    Err(format!(
        "找不到可執行檔 {}，請在設定指定完整路徑",
        value.display()
    ))
}

pub fn detect_paths(settings: &Settings) -> Vec<Installation> {
    [
        (AgentKind::Codex, &settings.executables.codex),
        (AgentKind::Claude, &settings.executables.claude),
    ]
    .into_iter()
    .map(|(kind, path)| match resolve_executable(path) {
        Err(e) => Installation {
            kind,
            executable: None,
            version: None,
            available: false,
            error: Some(e),
        },
        Ok(path) => Installation {
            kind,
            executable: Some(path.to_string_lossy().into_owned()),
            version: None,
            available: true,
            error: None,
        },
    })
    .collect()
}

pub fn detect(settings: &Settings) -> Vec<Installation> {
    detect_paths(settings)
        .into_iter()
        .map(|mut installation| {
            if let Some(path) = &installation.executable {
                match version(Path::new(path)) {
                    Ok(v) => installation.version = Some(v),
                    Err(e) => installation.error = Some(e),
                }
            }
            installation
        })
        .collect()
}

fn version(path: &Path) -> Result<String, String> {
    use crate::runtime::{LaunchSpec, RuntimeManager, TerminalEvent};
    use std::sync::{mpsc, Arc};
    let runtime = RuntimeManager::new();
    let (sender, receiver) = mpsc::channel();
    let info = runtime.launch(
        LaunchSpec {
            executable: path.to_string_lossy().into_owned(),
            args: vec!["--version".into()],
            cwd: PathBuf::from("/"),
            env: HashMap::new(),
            session_id: None,
            pane_id: "version-probe".into(),
        },
        80,
        24,
        Arc::new(move |event| {
            sender
                .send(event)
                .map_err(|_| "Version probe receiver closed".to_string())
        }),
    )?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut bytes = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(TerminalEvent::Output {
                runtime_id,
                sequence,
                data,
            }) => {
                let remaining = 4096usize.saturating_sub(bytes.len());
                bytes.extend_from_slice(&data[..data.len().min(remaining)]);
                runtime.ack(&runtime_id, sequence)?;
            }
            Ok(TerminalEvent::Exit { exit_code, .. }) => {
                runtime.shutdown()?;
                let value = String::from_utf8_lossy(&bytes).trim().to_owned();
                return if exit_code == Some(0) && !value.is_empty() {
                    Ok(value)
                } else {
                    Err("工具版本查詢失敗；仍可嘗試啟動".into())
                };
            }
            Ok(TerminalEvent::Error { message, .. }) => {
                let _ = runtime.stop(&info.id);
                return Err(message);
            }
            Err(_) => {
                runtime.stop(&info.id)?;
                return Err("工具版本查詢逾時；仍可嘗試啟動".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_validate() {
        Settings::default().validate().unwrap();
    }
    #[test]
    fn reject_duplicate_shortcuts_and_profiles() {
        let mut s = Settings::default();
        s.shortcuts.insert("extra".into(), "Mod+Shift+F".into());
        assert!(s.validate().unwrap_err().contains("衝突"));
        s.shortcuts.clear();
        s.profiles.push(s.profiles[0].clone());
        assert!(s.validate().is_err());
    }
    #[test]
    fn atomic_settings_and_corruption_preserves_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(dir.path().join("app")).unwrap();
        let s = Settings::default();
        store.save_settings(&s).unwrap();
        assert!(store.load_settings().1.is_empty());
        let path = store.directory.join("settings.json");
        fs::write(&path, b"broken").unwrap();
        assert!(!store.load_settings().1.is_empty());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
    }
    #[test]
    fn workspace_rejects_persisted_runtime() {
        assert!(
            validate_workspace(&serde_json::json!({"version":1,"pane":{"runtimeId":"bad"}}))
                .is_err()
        );
        assert!(validate_workspace(&serde_json::json!({"version":1,"tabs":[]})).is_ok());
    }
    #[test]
    fn executable_resolution_does_not_evaluate_shell() {
        assert!(resolve_executable("sh; touch /tmp/pwned").is_err());
        assert!(resolve_executable("/bin/sh").is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(dir.path().join("app")).unwrap();
        store.save_settings(&Settings::default()).unwrap();
        assert_eq!(
            fs::metadata(&store.directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(store.directory.join("settings.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn version_timeout_cleans_owned_descendant() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let pidfile = temp.path().join("pid");
        let executable = temp.path().join("wrapper");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nsleep 60 &\necho $! > '{}'\nwait\n",
                pidfile.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let start = Instant::now();
        assert!(version(&executable).unwrap_err().contains("逾時"));
        assert!(start.elapsed() < Duration::from_secs(6));
        let pid = fs::read_to_string(pidfile).unwrap();
        let path = PathBuf::from(format!("/proc/{}/status", pid.trim()));
        let state = fs::read_to_string(path).unwrap_or_default();
        assert!(
            state.is_empty() || state.contains("State:\tZ"),
            "Probe child remains alive: {state}"
        );
    }
}
