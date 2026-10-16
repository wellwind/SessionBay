pub use crate::models::Installation;
use crate::{
    models::{AgentKind, HistorySource, InstallationStatus, LoginStatus},
    providers,
};
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
    #[serde(default = "default_grok_executable")]
    pub grok: String,
    #[serde(default = "default_antigravity_executable")]
    pub antigravity: String,
}

fn default_grok_executable() -> String {
    providers::definition(AgentKind::Grok).executable.clone()
}
fn default_antigravity_executable() -> String {
    providers::definition(AgentKind::Antigravity)
        .executable
        .clone()
}

impl Executables {
    pub fn for_kind(&self, kind: AgentKind) -> &str {
        match kind {
            AgentKind::Codex => &self.codex,
            AgentKind::Claude => &self.claude,
            AgentKind::Grok => &self.grok,
            AgentKind::Antigravity => &self.antigravity,
        }
    }
}

impl Default for Executables {
    fn default() -> Self {
        Self {
            codex: providers::definition(AgentKind::Codex).executable.clone(),
            claude: providers::definition(AgentKind::Claude).executable.clone(),
            grok: default_grok_executable(),
            antigravity: default_antigravity_executable(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct AgentLaunchOptions {
    pub extra_args: Vec<String>,
    pub bypass_permissions: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct AgentOptions {
    pub codex: AgentLaunchOptions,
    pub claude: AgentLaunchOptions,
    pub grok: AgentLaunchOptions,
    pub antigravity: AgentLaunchOptions,
}

impl AgentOptions {
    pub fn for_kind(&self, kind: AgentKind) -> &AgentLaunchOptions {
        match kind {
            AgentKind::Codex => &self.codex,
            AgentKind::Claude => &self.claude,
            AgentKind::Grok => &self.grok,
            AgentKind::Antigravity => &self.antigravity,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub version: u32,
    pub theme: String,
    #[serde(default = "default_theme_palette")]
    pub theme_palette: String,
    pub terminal_theme: String,
    pub font_family: String,
    pub font_size: u16,
    #[serde(default = "default_app_zoom")]
    pub app_zoom: u16,
    pub default_agent: AgentKind,
    pub default_profile_id: String,
    pub profiles: Vec<ShellProfile>,
    pub sources: Vec<HistorySource>,
    pub executables: Executables,
    #[serde(default)]
    pub agent_options: AgentOptions,
    pub shortcuts: HashMap<String, String>,
    pub onboarding_complete: bool,
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
            ("next-pane", "Mod+Alt+ArrowDown"),
            ("maximize-pane", "Mod+Shift+M"),
            ("close-pane", "Mod+Shift+W"),
            ("toggle-sidebar", "Mod+Shift+B"),
        ] {
            shortcuts.insert(id.into(), key.into());
        }
        Self {
            version: 1,
            theme: "dark".into(),
            theme_palette: default_theme_palette(),
            terminal_theme: "bay".into(),
            font_family: "ui-monospace, SFMono-Regular, Menlo, monospace".into(),
            font_size: 14,
            app_zoom: default_app_zoom(),
            default_agent: AgentKind::Codex,
            default_profile_id: "default".into(),
            profiles: vec![ShellProfile {
                id: "default".into(),
                name: "預設 Shell".into(),
                executable: shell,
                args: vec!["-l".into()],
                env: HashMap::new(),
            }],
            sources: providers::definitions()
                .iter()
                .filter(|provider| provider.history.supported)
                .map(|provider| HistorySource {
                    id: format!("{}-default", provider.id.as_str()),
                    kind: provider.id,
                    root: provider.state_root(&home).to_string_lossy().into_owned(),
                    enabled: true,
                })
                .collect(),
            executables: Executables::default(),
            agent_options: AgentOptions::default(),
            shortcuts,
            onboarding_complete: false,
        }
    }
}

fn clean_string(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.contains('\0')
}

fn default_app_zoom() -> u16 {
    100
}

fn default_theme_palette() -> String {
    "bay".into()
}

// Preserve future catalog IDs so a theme addition cannot reset unrelated settings.
fn valid_theme_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("不支援的設定版本；請保留原檔並更新應用程式".into());
        }
        if !["dark", "light", "system"].contains(&self.theme.as_str())
            || !valid_theme_id(&self.theme_palette)
            || !valid_theme_id(&self.terminal_theme)
        {
            return Err("主題設定無效".into());
        }
        if !(9..=32).contains(&self.font_size) || !clean_string(&self.font_family, 256) {
            return Err("字型大小須為 9–32，且字型名稱不可為空".into());
        }
        if !(50..=200).contains(&self.app_zoom) {
            return Err("工作台縮放須為 50–200 的整數百分比".into());
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
        for provider in providers::definitions() {
            let kind = provider.id;
            if !clean_string(self.executables.for_kind(kind), 4096) {
                return Err("Agent 執行檔設定不可空白".into());
            }
            crate::launch_options::validate(kind, self.agent_options.for_kind(kind))?;
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
    providers::definitions()
        .iter()
        .map(|provider| {
            let kind = provider.id;
            match resolve_executable(settings.executables.for_kind(kind)) {
                Err(e) => Installation {
                    kind,
                    executable: None,
                    version: None,
                    available: false,
                    error: Some(e),
                    status: InstallationStatus::Missing,
                    login_status: LoginStatus::Unknown,
                },
                Ok(path) => Installation {
                    kind,
                    executable: Some(path.to_string_lossy().into_owned()),
                    version: None,
                    available: true,
                    error: None,
                    status: InstallationStatus::Available,
                    login_status: LoginStatus::Unknown,
                },
            }
        })
        .collect()
}

pub fn detect(settings: &Settings) -> Vec<Installation> {
    detect_paths(settings)
        .into_iter()
        .map(|mut installation| {
            if let Some(path) = &installation.executable {
                match version(Path::new(path), installation.kind) {
                    Ok(v) => installation.version = Some(v),
                    Err(e) => {
                        installation.error = Some(e);
                        installation.status = InstallationStatus::VersionCheckFailed;
                    }
                }
            }
            installation
        })
        .collect()
}

fn version(path: &Path, kind: AgentKind) -> Result<String, String> {
    use crate::runtime::{LaunchSpec, RuntimeManager, TerminalEvent};
    use std::sync::{mpsc, Arc};
    let runtime = RuntimeManager::new();
    let (sender, receiver) = mpsc::channel();
    let info = runtime.launch(
        LaunchSpec {
            executable: path.to_string_lossy().into_owned(),
            args: providers::definition(kind).launch.version_args.clone(),
            cwd: PathBuf::from("/"),
            env: HashMap::new(),
            session_id: None,
            resume_key: None,
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
        // A continuously readable output channel must not postpone the deadline.
        if Instant::now() >= deadline {
            runtime.stop(&info.id)?;
            return Err("工具版本查詢逾時；仍可嘗試啟動".into());
        }
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
        let settings = Settings::default();
        settings.validate().unwrap();
        assert_eq!(settings.shortcuts["next-pane"], "Mod+Alt+ArrowDown");
    }
    #[test]
    fn workspace_zoom_migrates_and_roundtrips_independently_of_font() {
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        old.as_object_mut().unwrap().remove("appZoom");
        old["fontSize"] = 21.into();
        let mut settings: Settings = serde_json::from_value(old).unwrap();
        assert_eq!(settings.app_zoom, 100);
        settings.app_zoom = 150;
        let loaded: Settings =
            serde_json::from_value(serde_json::to_value(settings).unwrap()).unwrap();
        assert_eq!(loaded.app_zoom, 150);
        assert_eq!(loaded.font_size, 21);
        loaded.validate().unwrap();
    }
    #[test]
    fn workspace_zoom_rejects_out_of_range_and_noninteger_settings() {
        for value in [0, 49, 201, u16::MAX] {
            let settings = Settings {
                app_zoom: value,
                ..Settings::default()
            };
            assert!(settings.validate().is_err());
        }
        for value in [
            serde_json::json!(99.5),
            serde_json::json!(-1),
            serde_json::json!("100"),
            serde_json::Value::Null,
        ] {
            let mut settings = serde_json::to_value(Settings::default()).unwrap();
            settings["appZoom"] = value;
            assert!(serde_json::from_value::<Settings>(settings).is_err());
        }
        for value in [50, 100, 200] {
            Settings {
                app_zoom: value,
                ..Settings::default()
            }
            .validate()
            .unwrap();
        }
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
    fn legacy_settings_gain_palette_without_changing_the_terminal_or_other_fields() {
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        old.as_object_mut().unwrap().remove("themePalette");
        old["terminalTheme"] = "classic".into();
        old["fontFamily"] = "Synthetic custom font".into();
        let migrated: Settings = serde_json::from_value(old).unwrap();
        assert_eq!(migrated.theme_palette, "bay");
        assert_eq!(migrated.terminal_theme, "classic");
        assert_eq!(migrated.font_family, "Synthetic custom font");
        assert!(migrated.validate().is_ok());
    }

    #[test]
    fn future_theme_ids_roundtrip_without_resetting_settings() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(dir.path().join("app")).unwrap();
        let mut settings = Settings {
            theme_palette: "future-ui".into(),
            terminal_theme: "future-terminal".into(),
            font_size: 19,
            ..Settings::default()
        };
        settings.profiles[0].name = "Keep my custom profile".into();
        store.save_settings(&settings).unwrap();
        let (loaded, warnings) = store.load_settings();
        assert!(warnings.is_empty());
        assert_eq!(loaded.theme_palette, "future-ui");
        assert_eq!(loaded.terminal_theme, "future-terminal");
        assert_eq!(loaded.font_size, 19);
        assert_eq!(loaded.profiles[0].name, "Keep my custom profile");
    }

    #[test]
    fn theme_ids_are_bounded_plain_identifiers() {
        for id in ["bay", "classic", "ocean-dark", "rose-light", "future-42"] {
            assert!(valid_theme_id(id));
        }
        for id in ["", "-bad", "UPPER", "url(example)", "has space", "bad\0"] {
            assert!(!valid_theme_id(id));
        }
        assert!(!valid_theme_id(&"a".repeat(65)));
        for field in ["themePalette", "terminalTheme"] {
            let mut value = serde_json::to_value(Settings::default()).unwrap();
            value[field] = "invalid value".into();
            assert!(serde_json::from_value::<Settings>(value)
                .unwrap()
                .validate()
                .is_err());
        }
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
    fn version_output_is_bounded_and_continuous_output_cannot_extend_deadline() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("synthetic version output");
        fs::write(
            &executable,
            "#!/bin/sh\ni=0; while [ \"$i\" -lt 5000 ]; do printf x; i=$((i + 1)); done\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(version(&executable, AgentKind::Codex).unwrap().len(), 4096);
        fs::write(
            &executable,
            "#!/bin/sh\nwhile :; do printf 'synthetic continuous version output'; done\n",
        )
        .unwrap();
        let started = Instant::now();
        assert!(version(&executable, AgentKind::Codex)
            .unwrap_err()
            .contains("逾時"));
        assert!(started.elapsed() < Duration::from_secs(6));
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
        assert!(version(&executable, AgentKind::Codex)
            .unwrap_err()
            .contains("逾時"));
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
