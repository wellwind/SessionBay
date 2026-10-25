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
    #[serde(default = "default_opencode_executable")]
    pub opencode: String,
}

fn default_opencode_executable() -> String {
    providers::definition(AgentKind::OpenCode)
        .executable
        .clone()
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
            AgentKind::OpenCode => &self.opencode,
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
            opencode: default_opencode_executable(),
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
    pub opencode: AgentLaunchOptions,
}

impl AgentOptions {
    pub fn for_kind(&self, kind: AgentKind) -> &AgentLaunchOptions {
        match kind {
            AgentKind::Codex => &self.codex,
            AgentKind::Claude => &self.claude,
            AgentKind::Grok => &self.grok,
            AgentKind::Antigravity => &self.antigravity,
            AgentKind::OpenCode => &self.opencode,
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
    /// 「終端固定用深色」: opt out of the terminal following the UI light/dark mode.
    #[serde(default)]
    pub terminal_always_dark: bool,
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
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub agent_enabled: HashMap<String, bool>,
    #[serde(
        default = "default_agent_hooks",
        deserialize_with = "deserialize_agent_hooks"
    )]
    pub agent_hooks: HashMap<String, bool>,
    pub shortcuts: HashMap<String, String>,
    pub onboarding_complete: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let home = default_home();
        let (shell, shell_args) = default_shell();
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
            terminal_always_dark: false,
            font_family: DEFAULT_FONT_FAMILY.into(),
            font_size: 14,
            app_zoom: default_app_zoom(),
            default_agent: AgentKind::Codex,
            default_profile_id: "default".into(),
            profiles: vec![ShellProfile {
                id: "default".into(),
                name: "預設 Shell".into(),
                executable: shell,
                args: shell_args,
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
            agent_enabled: HashMap::new(),
            agent_hooks: default_agent_hooks(),
            shortcuts,
            onboarding_complete: false,
        }
    }
}

fn clean_string(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.contains('\0')
}

/// Matches the bundled JetBrains Mono in `src/fonts.ts`.
pub const DEFAULT_FONT_FAMILY: &str =
    "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans TC Variable', monospace";
const LEGACY_DEFAULT_FONT_FAMILY: &str = "ui-monospace, SFMono-Regular, Menlo, monospace";

fn default_app_zoom() -> u16 {
    100
}

fn default_theme_palette() -> String {
    "bay".into()
}

fn default_agent_hooks() -> HashMap<String, bool> {
    AgentKind::ALL
        .into_iter()
        .map(|kind| (kind.as_str().into(), true))
        .collect()
}

fn deserialize_agent_hooks<'de, D>(deserializer: D) -> Result<HashMap<String, bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let saved = HashMap::<String, bool>::deserialize(deserializer)?;
    let mut hooks = default_agent_hooks();
    hooks.extend(saved);
    Ok(hooks)
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
    /// Absent entries remain enabled, including settings saved before this field existed.
    /// String keys preserve future provider IDs across older application versions.
    pub fn is_agent_enabled(&self, kind: AgentKind) -> bool {
        self.agent_enabled
            .get(kind.as_str())
            .copied()
            .unwrap_or(true)
    }

    /// New providers and legacy settings default to launch-local activity hooks.
    /// An explicitly saved false always remains an opt-out.
    pub fn is_agent_hooks_enabled(&self, kind: AgentKind) -> bool {
        self.agent_hooks.get(kind.as_str()).copied().unwrap_or(true)
    }

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
            #[cfg(windows)]
            if p.env
                .keys()
                .map(|key| key.to_ascii_uppercase())
                .collect::<HashSet<_>>()
                .len()
                != p.env.len()
            {
                return Err("Windows 環境變數名稱不區分大小寫，不可重複設定".into());
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
            #[cfg(windows)]
            if !crate::windows_fs::valid_filesystem_path(Path::new(&s.root)) {
                return Err("來源根目錄必須是完整檔案系統路徑，不可使用裝置名稱或資料串流".into());
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
        if self.agent_hooks.keys().any(|kind| {
            !matches!(
                kind.as_str(),
                "codex" | "claude" | "opencode" | "grok" | "antigravity"
            )
        }) {
            return Err("此 Agent 尚未支援真實 hooks".into());
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
                .and_then(|mut s| {
                    s.validate()?;
                    // Only the untouched previous default follows the bundled font;
                    // any value the user typed is kept.
                    if s.font_family == LEGACY_DEFAULT_FONT_FAMILY {
                        s.font_family = DEFAULT_FONT_FAMILY.into();
                    }
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

/// Platform-native fallback directories used by discovery and launch planning.
/// Only absolute paths participate: an empty/relative PATH entry never opts in
/// to searching an untrusted working directory.
pub fn executable_fallback_directories() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".local/bin"));
        paths.push(home.join(".cargo/bin"));
        paths.push(home.join(".opencode/bin"));
        #[cfg(windows)]
        paths.push(home.join(".grok/bin"));
    }
    #[cfg(windows)]
    {
        for (key, suffixes) in [
            (
                "LOCALAPPDATA",
                &[
                    "Microsoft/WinGet/Links",
                    "Programs/OpenAI/Codex/bin",
                    "agy/bin",
                ][..],
            ),
            ("APPDATA", &["npm"][..]),
            ("ProgramFiles", &["PowerShell/7", "Git/bin"][..]),
            (
                "SystemRoot",
                &["System32", "System32/WindowsPowerShell/v1.0"][..],
            ),
        ] {
            if let Some(root) = std::env::var_os(key)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
            {
                paths.extend(suffixes.iter().map(|suffix| root.join(suffix)));
            }
        }
    }
    #[cfg(unix)]
    paths.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    paths.retain(|path| path.is_absolute());
    paths
}

pub fn default_home() -> PathBuf {
    dirs::home_dir()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { r"C:\" } else { "/" }))
}

fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        // Prefer native PowerShell; do not pass Unix login-shell flags to it.
        for name in ["pwsh.exe", "powershell.exe"] {
            if let Ok(path) = resolve_executable(name) {
                return (path.to_string_lossy().into_owned(), vec!["-NoLogo".into()]);
            }
        }
        let shell = std::env::var("COMSPEC")
            .ok()
            .filter(|value| Path::new(value).is_absolute())
            .and_then(|value| resolve_executable(&value).ok())
            .or_else(|| resolve_executable("cmd.exe").ok())
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| "cmd.exe".into());
        (shell, vec!["/D".into()])
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_file())
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    "/bin/zsh"
                } else {
                    "/bin/bash"
                }
                .into()
            });
        (shell, vec!["-l".into()])
    }
}

/// Windows PATHEXT discovery is bounded to launchable native executables and
/// batch wrappers. Never use file associations for arbitrary extensions.
#[cfg(windows)]
pub(crate) fn windows_extensions(value: Option<&std::ffi::OsStr>) -> Vec<String> {
    let mut extensions = Vec::new();
    let value = value
        .and_then(|value| value.to_str())
        .filter(|value| value.len() <= 4096)
        .unwrap_or(".COM;.EXE;.BAT;.CMD");
    for extension in value.split(';') {
        let extension = extension.to_ascii_lowercase();
        if [".exe", ".com", ".cmd", ".bat"].contains(&extension.as_str())
            && !extensions.contains(&extension)
        {
            extensions.push(extension);
        }
    }
    extensions
}

pub(crate) fn executable_candidates(path: &Path, extensions: &[String]) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        if path.extension().is_some() {
            return vec![path.to_owned()];
        }
        extensions
            .iter()
            .map(|extension| {
                let mut name = path.as_os_str().to_os_string();
                name.push(extension);
                PathBuf::from(name)
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        let _ = extensions;
        vec![path.to_owned()]
    }
}

pub(crate) fn executable_extensions() -> Vec<String> {
    #[cfg(windows)]
    {
        windows_extensions(std::env::var_os("PATHEXT").as_deref())
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

pub fn is_windows_native_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com")
        })
}

pub fn is_windows_batch_script(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

pub(crate) fn executable_file(path: &Path) -> bool {
    #[cfg(windows)]
    if !crate::windows_fs::valid_filesystem_path(path) {
        return false;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        is_windows_native_executable(path) || is_windows_batch_script(path)
    }
    #[cfg(not(any(unix, windows)))]
    false
}

pub fn resolve_executable(value: &str) -> Result<PathBuf, String> {
    resolve_executable_with_paths(
        value,
        std::env::var_os("PATH").as_deref(),
        &executable_fallback_directories(),
        &executable_extensions(),
    )
}

fn resolve_executable_with_paths(
    value: &str,
    path: Option<&std::ffi::OsStr>,
    fallbacks: &[PathBuf],
    extensions: &[String],
) -> Result<PathBuf, String> {
    if !clean_string(value, 4096) || value.chars().any(char::is_control) {
        return Err("執行檔名稱無效".into());
    }
    let value = Path::new(value);
    let candidates = if value.components().count() > 1 || value.is_absolute() {
        if !value.is_absolute() {
            return Err("自訂執行檔請填寫絕對路徑".into());
        }
        executable_candidates(value, extensions)
    } else {
        std::env::split_paths(path.unwrap_or_default())
            .chain(fallbacks.iter().cloned())
            .filter(|directory| directory.is_absolute())
            .flat_map(|directory| executable_candidates(&directory.join(value), extensions))
            .collect()
    };
    for path in candidates {
        if executable_file(&path) {
            #[cfg(windows)]
            if is_windows_batch_script(&path) {
                return Err(format!("找到 Windows 批次包裝檔 {}；為保留參數邊界，請改用官方原生 .exe 執行檔，或設定直接執行程式的 Shell Profile。Session Bay 不會將參數拼接為 cmd.exe 指令。", path.display()));
            }
            return Ok(path);
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
            cwd: dirs::home_dir()
                .filter(|path| path.is_dir())
                .or_else(|| std::env::current_dir().ok())
                .or_else(|| path.parent().map(Path::to_owned))
                .ok_or("無法取得版本查詢的工作目錄")?,
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
                let value = version_text(&bytes);
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

// Version probes use a PTY, so even a silent child can produce ConPTY setup and
// teardown traffic. Decode only this bounded, non-interactive consumer; terminal
// sessions still receive the original bytes. Unterminated control strings are
// discarded rather than exposing titles, hyperlinks or partial protocol text.
fn version_text(bytes: &[u8]) -> String {
    #[derive(Clone, Copy)]
    enum State {
        Text,
        Escape,
        EscapeIntermediate,
        Csi,
        String,
        StringEscape,
    }
    let mut state = State::Text;
    let mut text = String::new();
    for ch in String::from_utf8_lossy(bytes).chars() {
        state = match (state, ch) {
            (State::Text, '\u{1b}') => State::Escape,
            (State::Text, '\u{9b}') => State::Csi,
            (State::Text, '\u{90}' | '\u{98}' | '\u{9d}' | '\u{9e}' | '\u{9f}') => State::String,
            (State::Text, ch) => {
                if !ch.is_control() || matches!(ch, '\r' | '\n' | '\t') {
                    text.push(ch);
                }
                State::Text
            }
            (State::Escape, '[') => State::Csi,
            (State::Escape, 'P' | 'X' | ']' | '^' | '_') => State::String,
            (State::Escape | State::EscapeIntermediate, '\u{20}'..='\u{2f}') => {
                State::EscapeIntermediate
            }
            (State::Escape | State::EscapeIntermediate, _) => State::Text,
            (State::Csi, '\u{40}'..='\u{7e}') => State::Text,
            (State::Csi, _) => State::Csi,
            (State::String | State::StringEscape, '\u{7}' | '\u{9c}')
            | (State::StringEscape, '\\') => State::Text,
            (State::String | State::StringEscape, '\u{1b}') => State::StringEscape,
            (State::String | State::StringEscape, _) => State::String,
        };
    }
    text.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_text_strips_terminal_protocol_without_losing_unicode() {
        assert_eq!(version_text(b"\x1b[?9001h\x1b[6n\x1b[?25l\x1b[0m\r\n"), "");
        assert_eq!(
            version_text("\x1b]0;title\x07\x1b[32mAgent 1.2 中文\x1b[0m\r\n\x1b[?9001l".as_bytes()),
            "Agent 1.2 中文"
        );
        assert_eq!(version_text(b"\x1bPdiscard\x1b\\ok\x1b]unterminated"), "ok");
        assert_eq!(
            version_text("\u{9b}?9001h\u{9d}discard\u{9c}v1".as_bytes()),
            "v1"
        );
    }
    #[test]
    fn defaults_validate() {
        let settings = Settings::default();
        settings.validate().unwrap();
        assert_eq!(settings.shortcuts["next-pane"], "Mod+Alt+ArrowDown");
    }

    #[test]
    fn agent_hooks_default_to_enabled_for_every_provider() {
        let settings = Settings::default();
        assert_eq!(settings.agent_hooks.len(), AgentKind::ALL.len());
        for kind in AgentKind::ALL {
            assert_eq!(settings.agent_hooks.get(kind.as_str()), Some(&true));
            assert!(settings.is_agent_hooks_enabled(kind));
        }
    }

    #[test]
    fn legacy_agent_hooks_fill_missing_values_without_changing_other_settings() {
        for hooks in [None, Some(serde_json::json!({}))] {
            let mut old = serde_json::to_value(Settings::default()).unwrap();
            old.as_object_mut().unwrap().remove("agentHooks");
            if let Some(hooks) = hooks {
                old["agentHooks"] = hooks;
            }
            old["fontSize"] = 21.into();
            old["executables"]["codex"] = "synthetic-custom-codex".into();
            let migrated: Settings = serde_json::from_value(old).unwrap();
            assert_eq!(migrated.agent_hooks, default_agent_hooks());
            assert_eq!(migrated.font_size, 21);
            assert_eq!(migrated.executables.codex, "synthetic-custom-codex");
            migrated.validate().unwrap();
        }
    }

    #[test]
    fn agent_hooks_partial_settings_preserve_each_explicit_opt_out_and_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(dir.path().join("app")).unwrap();
        for disabled in AgentKind::ALL {
            let mut saved = serde_json::to_value(Settings::default()).unwrap();
            saved["agentHooks"] = serde_json::json!({disabled.as_str(): false});
            let settings: Settings = serde_json::from_value(saved).unwrap();
            for kind in AgentKind::ALL {
                assert_eq!(settings.is_agent_hooks_enabled(kind), kind != disabled);
                assert_eq!(settings.agent_hooks[kind.as_str()], kind != disabled);
            }
            store.save_settings(&settings).unwrap();
            let (loaded, warnings) = store.load_settings();
            assert!(warnings.is_empty());
            assert_eq!(loaded.agent_hooks, settings.agent_hooks);
            assert_eq!(
                serde_json::to_value(&loaded).unwrap()["agentHooks"][disabled.as_str()],
                false
            );
        }
    }

    #[test]
    fn agent_hooks_preserve_all_explicit_opt_outs_and_handle_in_memory_missing_keys() {
        let mut settings = Settings::default();
        settings.agent_hooks.clear();
        for kind in AgentKind::ALL {
            assert!(settings.is_agent_hooks_enabled(kind));
            settings.agent_hooks.insert(kind.as_str().into(), false);
        }
        let loaded: Settings =
            serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
        assert_eq!(loaded.agent_hooks, settings.agent_hooks);
        for kind in AgentKind::ALL {
            assert!(!loaded.is_agent_hooks_enabled(kind));
        }
    }

    #[test]
    fn agent_hooks_reject_non_boolean_values_and_unknown_provider_ids() {
        for value in [
            serde_json::json!({"codex":"false"}),
            serde_json::json!({"codex":0}),
            serde_json::Value::Null,
        ] {
            let mut settings = serde_json::to_value(Settings::default()).unwrap();
            settings["agentHooks"] = value;
            assert!(serde_json::from_value::<Settings>(settings).is_err());
        }
        let mut settings = serde_json::to_value(Settings::default()).unwrap();
        settings["agentHooks"] = serde_json::json!({"future-agent":true});
        let settings: Settings = serde_json::from_value(settings).unwrap();
        assert!(settings.validate().is_err());
    }

    #[test]
    fn legacy_agent_enablement_defaults_to_enabled_and_keeps_other_settings() {
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        old.as_object_mut().unwrap().remove("agentEnabled");
        old["fontSize"] = 21.into();
        old["executables"]["codex"] = "synthetic-custom-codex".into();
        let migrated: Settings = serde_json::from_value(old).unwrap();
        assert!(migrated.agent_enabled.is_empty());
        for kind in AgentKind::ALL {
            assert!(migrated.is_agent_enabled(kind));
        }
        assert_eq!(migrated.font_size, 21);
        assert_eq!(migrated.executables.codex, "synthetic-custom-codex");
        migrated.validate().unwrap();
    }

    #[test]
    fn agent_enablement_roundtrips_known_and_future_ids_without_changing_sources() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(dir.path().join("app")).unwrap();
        let mut settings = Settings {
            agent_enabled: HashMap::from([
                ("codex".into(), false),
                ("claude".into(), true),
                ("future-agent".into(), false),
            ]),
            ..Settings::default()
        };
        settings.sources[0].enabled = false;
        let sources = serde_json::to_value(&settings.sources).unwrap();
        store.save_settings(&settings).unwrap();
        let (loaded, warnings) = store.load_settings();
        assert!(warnings.is_empty());
        assert_eq!(loaded.agent_enabled, settings.agent_enabled);
        assert!(!loaded.is_agent_enabled(AgentKind::Codex));
        assert!(loaded.is_agent_enabled(AgentKind::Claude));
        assert!(loaded.is_agent_enabled(AgentKind::Grok));
        assert_eq!(serde_json::to_value(&loaded.sources).unwrap(), sources);
        let serialized = serde_json::to_value(&loaded).unwrap();
        assert_eq!(serialized["agentEnabled"]["future-agent"], false);
        assert!(serialized.get("agent_enabled").is_none());
    }

    #[test]
    fn agent_enablement_rejects_non_boolean_map_values() {
        for value in [
            serde_json::json!({"codex":"false"}),
            serde_json::json!({"codex":0}),
            serde_json::Value::Null,
        ] {
            let mut settings = serde_json::to_value(Settings::default()).unwrap();
            settings["agentEnabled"] = value;
            assert!(serde_json::from_value::<Settings>(settings).is_err());
        }
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
        let mut updated = s.clone();
        updated.theme = "light".into();
        store.save_settings(&updated).unwrap();
        assert_eq!(store.load_settings().0.theme, "light");
        assert!(store.load_settings().1.is_empty());
        assert_eq!(fs::read_dir(&store.directory).unwrap().count(), 1);
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
    fn only_the_untouched_legacy_terminal_font_moves_to_the_bundled_default() {
        let temp = tempfile::tempdir().unwrap();
        let store = ConfigStore::open(temp.path().join("app")).unwrap();
        let path = store.directory.join("settings.json");
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        old["fontFamily"] = LEGACY_DEFAULT_FONT_FAMILY.into();
        fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(store.load_settings().0.font_family, DEFAULT_FONT_FAMILY);
        old["fontFamily"] = "Synthetic custom font".into();
        fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(store.load_settings().0.font_family, "Synthetic custom font");
    }

    #[test]
    fn legacy_settings_default_terminal_to_following_the_ui_mode() {
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        old.as_object_mut().unwrap().remove("terminalAlwaysDark");
        let migrated: Settings = serde_json::from_value(old).unwrap();
        assert!(!migrated.terminal_always_dark);
        let mut pinned = serde_json::to_value(Settings::default()).unwrap();
        pinned["terminalAlwaysDark"] = true.into();
        let pinned: Settings = serde_json::from_value(pinned).unwrap();
        assert!(pinned.terminal_always_dark);
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
        #[cfg(unix)]
        assert!(resolve_executable("/bin/sh").is_ok());
        #[cfg(windows)]
        assert!(resolve_executable("cmd.exe").is_ok());
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

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn conpty_version_probe_returns_clean_text_and_rejects_silent_success() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("probe.rs");
        fs::write(
            &source,
            r#"fn main() {
            let path = std::env::current_exe().unwrap();
            if path.file_stem().unwrap() == "visible version 中文" {
                print!("\x1b[32mSynthetic 1.2 中文\x1b[0m\r\n");
            }
        }"#,
        )
        .unwrap();
        let visible = temp.path().join("visible version 中文.exe");
        let output = std::process::Command::new("rustc")
            .args([
                "--crate-name",
                "sessionbay_version_fixture",
                "--edition",
                "2021",
            ])
            .arg(&source)
            .arg("-o")
            .arg(&visible)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let silent = temp.path().join("silent.exe");
        fs::copy(&visible, &silent).unwrap();
        assert_eq!(
            version(&visible, AgentKind::Codex).unwrap(),
            "Synthetic 1.2 中文"
        );
        assert!(version(&silent, AgentKind::Codex)
            .unwrap_err()
            .contains("失敗"));
    }

    fn fixture(root: &Path, name: &str) -> PathBuf {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"synthetic discovery-only file").unwrap();
        path
    }

    #[test]
    fn native_defaults_do_not_use_unix_paths_or_login_flags() {
        let settings = Settings::default();
        settings.validate().unwrap();
        assert!(!settings.profiles[0].args.iter().any(|arg| arg == "-l"));
        assert!(is_windows_native_executable(Path::new(
            &settings.profiles[0].executable
        )));
        assert!(settings
            .sources
            .iter()
            .all(|source| Path::new(&source.root).is_absolute()));
        assert!(executable_fallback_directories()
            .iter()
            .all(|path| path.is_absolute()));
    }

    #[test]
    fn settings_reject_windows_device_stream_and_relative_source_roots() {
        let mut settings = Settings::default();
        for invalid in [
            r"C:relative",
            r"\root-relative",
            "/root-relative",
            r"C:\history\file:stream",
            r"C:\history\NUL.txt",
            r"\\.\pipe\name",
            r"\\server\pipe\name",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\history",
        ] {
            settings.sources[0].root = invalid.into();
            assert!(settings.validate().is_err(), "accepted {invalid}");
        }
        let temp = tempfile::tempdir().unwrap();
        settings.sources[0].root = temp.path().to_string_lossy().into_owned();
        settings.validate().unwrap();
        settings.sources[0].root = temp
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        settings.validate().unwrap();
    }

    #[test]
    fn pathext_is_case_insensitive_bounded_and_does_not_enable_file_associations() {
        assert_eq!(
            windows_extensions(Some(OsStr::new(".EXE;.exe;.COM;.PS1;.;.CMD;.BAT;../EXE"))),
            [".exe", ".com", ".cmd", ".bat"]
        );
        assert!(windows_extensions(Some(OsStr::new(".PS1;.JS"))).is_empty());
        assert_eq!(windows_extensions(None), [".com", ".exe", ".bat", ".cmd"]);
    }

    #[test]
    fn resolves_literal_executable_with_spaces_unicode_and_metacharacters() {
        let temp = tempfile::tempdir().unwrap();
        let binary = fixture(temp.path(), "工具 & %VALUE%.EXE");
        assert_eq!(
            resolve_executable_with_paths(binary.to_str().unwrap(), None, &[], &[]).unwrap(),
            binary
        );
        assert_eq!(fs::read(&binary).unwrap(), b"synthetic discovery-only file");
        for invalid in [r"C:relative.exe", r"\relative.exe", r".\relative.exe"] {
            assert!(resolve_executable_with_paths(invalid, None, &[], &[]).is_err());
        }
    }

    #[test]
    fn path_order_and_pathext_order_are_respected_without_current_directory_search() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first path");
        let second = temp.path().join("second path");
        let binary = fixture(&first, "agent.exe");
        fixture(&second, "agent.com");
        let path = std::env::join_paths([Path::new("."), &first, &second]).unwrap();
        let extensions = windows_extensions(Some(OsStr::new(".COM;.EXE")));
        assert_eq!(
            resolve_executable_with_paths("agent", Some(&path), &[], &extensions).unwrap(),
            binary
        );
        let explicit = binary.with_extension("");
        assert_eq!(
            resolve_executable_with_paths(explicit.to_str().unwrap(), None, &[], &extensions)
                .unwrap(),
            binary
        );
    }

    #[test]
    fn batch_shadows_fail_safely_instead_of_becoming_healthy_or_running_shell_text() {
        let temp = tempfile::tempdir().unwrap();
        for suffix in ["cmd", "bat"] {
            let wrapper = fixture(temp.path(), &format!("agent.{suffix}"));
            fixture(temp.path(), "agent.exe");
            let extensions = windows_extensions(Some(OsStr::new(&format!(".{suffix};.EXE"))));
            let path = std::env::join_paths([temp.path()]).unwrap();
            let error =
                resolve_executable_with_paths("agent", Some(&path), &[], &extensions).unwrap_err();
            assert!(error.contains("原生 .exe"));
            assert!(resolve_executable_with_paths(
                wrapper.to_str().unwrap(),
                None,
                &[],
                &extensions
            )
            .is_err());
            let mut settings = Settings::default();
            settings.executables.codex = wrapper.to_string_lossy().into_owned();
            let installation = detect_paths(&settings)
                .into_iter()
                .find(|item| item.kind == AgentKind::Codex)
                .unwrap();
            assert!(!installation.available);
            assert!(installation.executable.is_none());
        }
    }

    #[test]
    fn directories_and_script_associations_are_not_executables() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("directory.exe");
        fs::create_dir(&folder).unwrap();
        assert!(!executable_file(&folder));
        assert!(!executable_file(&fixture(temp.path(), "agent.ps1")));
        assert!(!executable_file(&fixture(temp.path(), "agent.js")));
    }
}
