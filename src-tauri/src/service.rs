use crate::{
    catalog::Catalog,
    config::{self, ConfigStore, Installation, Settings},
    models::{AgentKind, IndexStatus, Project},
    runtime::{LaunchSpec, RuntimeInfo, RuntimeManager, TerminalEvent},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchRequest {
    pub pane_id: String,
    pub kind: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub resume_id: Option<String>,
    pub cwd: Option<String>,
    pub profile_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPreview {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub settings: Settings,
    pub projects: Vec<Project>,
    pub installations: Vec<Installation>,
    pub index: IndexStatus,
    pub workspace: serde_json::Value,
    pub warnings: Vec<String>,
}

pub struct Service {
    pub catalog: Catalog,
    pub config: ConfigStore,
    pub runtime: RuntimeManager,
    settings: Mutex<Settings>,
    index: Mutex<IndexStatus>,
    scan_guard: Mutex<()>,
    revision: AtomicU64,
    cancel: AtomicBool,
    paused: AtomicBool,
    closed: AtomicBool,
    warnings: Vec<String>,
}

impl Service {
    pub fn open(directory: PathBuf) -> Result<Arc<Self>, String> {
        let config = ConfigStore::open(directory)?;
        let (settings, warnings) = config.load_settings();
        let catalog = Catalog::open(&config.directory.join("catalog.sqlite"))?;
        let service = Arc::new(Self {
            catalog,
            config,
            runtime: RuntimeManager::new(),
            settings: Mutex::new(settings),
            index: Mutex::new(empty_index()),
            scan_guard: Mutex::new(()),
            revision: AtomicU64::new(0),
            cancel: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            warnings,
        });
        Ok(service)
    }
    pub fn settings(&self) -> Result<Settings, String> {
        self.settings
            .lock()
            .map(|v| v.clone())
            .map_err(|_| "設定鎖定失敗".into())
    }
    pub fn bootstrap(&self) -> Result<Bootstrap, String> {
        let settings = self.settings()?;
        let (workspace, warning) = self.config.load_workspace();
        let mut warnings = self.warnings.clone();
        if let Some(w) = warning {
            warnings.push(w);
        }
        Ok(Bootstrap {
            projects: self.catalog.projects()?,
            installations: config::detect_paths(&settings),
            settings,
            index: self.index_status()?,
            workspace,
            warnings,
        })
    }
    pub fn save_settings(self: &Arc<Self>, settings: Settings) -> Result<Settings, String> {
        let mut current = self.settings.lock().map_err(|_| "設定鎖定失敗")?;
        // Palette/font changes do not change the scan's immutable source snapshot.
        // Compare all other fields so this exception cannot silently widen to source edits.
        let mut previous = serde_json::to_value(&*current).map_err(|e| e.to_string())?;
        let mut next = serde_json::to_value(&settings).map_err(|e| e.to_string())?;
        for field in [
            "theme",
            "themePalette",
            "terminalTheme",
            "fontFamily",
            "fontSize",
        ] {
            previous.as_object_mut().unwrap().remove(field);
            next.as_object_mut().unwrap().remove(field);
        }
        let _guard = if previous == next {
            None
        } else {
            if self.index_status()?.running {
                return Err("請先取消索引並等待完成，再修改來源設定".into());
            }
            Some(
                self.scan_guard
                    .try_lock()
                    .map_err(|_| "請先取消索引並等待完成，再修改來源設定")?,
            )
        };
        self.config.save_settings(&settings)?;
        *current = settings.clone();
        Ok(settings)
    }
    pub fn index_status(&self) -> Result<IndexStatus, String> {
        self.index
            .lock()
            .map(|v| v.clone())
            .map_err(|_| "索引狀態鎖定失敗".into())
    }
    pub fn start_index(self: &Arc<Self>, rebuild: bool) -> Result<IndexStatus, String> {
        {
            let mut status = self.index.lock().map_err(|_| "索引狀態鎖定失敗")?;
            if status.running {
                return Ok(status.clone());
            }
            *status = empty_index();
            status.running = true;
            status.revision = self.revision.load(Ordering::Acquire);
        }
        self.cancel.store(false, Ordering::Release);
        self.paused.store(false, Ordering::Release);
        let service = Arc::clone(self);
        std::thread::spawn(move || {
            let result = (|| {
                let _guard = service.scan_guard.lock().map_err(|_| "索引鎖定失敗")?;
                if rebuild {
                    service.catalog.clear()?;
                }
                let sources = service.settings()?.sources;
                service
                    .catalog
                    .sync(&sources, &service.cancel, |mut progress| {
                        if let Ok(mut status) = service.index.lock() {
                            progress.revision = service.revision.load(Ordering::Acquire);
                            *status = progress;
                        }
                    })
            })();
            if let Ok(mut status) = service.index.lock() {
                match result {
                    Ok(mut final_status) => {
                        final_status.running = false;
                        final_status.revision = service.revision.fetch_add(1, Ordering::AcqRel) + 1;
                        *status = final_status;
                    }
                    Err(e) => {
                        status.running = false;
                        status.errors.push(e);
                    }
                }
            }
        });
        self.index_status()
    }
    pub fn cancel_index(&self) {
        self.paused.store(true, Ordering::Release);
        self.cancel.store(true, Ordering::Release);
    }
    pub fn clear_index(&self) -> Result<(), String> {
        self.cancel_index();
        if self.index_status()?.running {
            return Err("索引正在停止，請稍後再清除".into());
        }
        let _guard = self
            .scan_guard
            .try_lock()
            .map_err(|_| "索引正在停止，請稍後再清除")?;
        self.catalog.clear()?;
        let mut empty = empty_index();
        empty.revision = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
        *self.index.lock().map_err(|_| "索引狀態鎖定失敗")? = empty;
        Ok(())
    }
    pub fn begin_reconcile(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(10));
            let Some(service) = weak.upgrade() else { break };
            if service.closed.load(Ordering::Acquire) {
                break;
            }
            if !service.paused.load(Ordering::Acquire)
                && service
                    .settings()
                    .map(|s| s.onboarding_complete)
                    .unwrap_or(false)
            {
                let _ = service.start_index(false);
            }
        });
        if self
            .settings()
            .map(|s| s.onboarding_complete)
            .unwrap_or(false)
        {
            let _ = self.start_index(false);
        }
    }
    pub fn plan_launch(&self, request: &LaunchRequest) -> Result<LaunchSpec, String> {
        if request.pane_id.is_empty()
            || request.pane_id.len() > 128
            || request.pane_id.contains('\0')
        {
            return Err("面板 ID 無效".into());
        }
        if request.cols < 2 || request.cols > 1000 || request.rows < 1 || request.rows > 1000 {
            return Err("終端尺寸無效".into());
        }
        if request.session_id.is_some() && request.resume_id.is_some() {
            return Err("Choose an indexed session or a manual resume ID, not both.".into());
        }
        let settings = self.settings()?;
        let mut env = HashMap::new();
        let mut args = vec![];
        let mut resume_key = None;
        let mut cwd = request.cwd.clone();
        if let Some(project_id) = &request.project_id {
            let project = self
                .catalog
                .projects()?
                .into_iter()
                .find(|p| &p.id == project_id)
                .ok_or("找不到專案，請重新選擇")?;
            if cwd.is_none() && request.session_id.is_none() {
                cwd = project.launch_path.or(project.path);
            }
        }
        let agent = if request.kind == "shell" {
            None
        } else {
            Some(AgentKind::parse(&request.kind)?)
        };
        if let Some(resume_id) = &request.resume_id {
            if !agent.is_some_and(|kind| crate::providers::definition(kind).resume.manual_id) {
                return Err(
                    "Manual resume IDs are supported for Grok Build and Antigravity CLI only."
                        .into(),
                );
            }
            validate_resume_id(resume_id)?;
        }
        if let Some(session_id) = &request.session_id {
            let (session, source) = self.catalog.resume_source(session_id)?;
            if request
                .project_id
                .as_ref()
                .is_some_and(|id| id != &session.project_id)
            {
                return Err("Session does not belong to the selected project.".into());
            }
            if agent.as_ref() != Some(&session.kind) {
                return Err("Session 的工具與啟動選項不一致".into());
            }
            if !settings.sources.iter().any(|s| {
                s.id == source.id && s.enabled && s.root == source.root && s.kind == session.kind
            }) {
                return Err("Session 的來源已停用或變更，請重新索引".into());
            }
            let id = &session.external_id;
            validate_resume_id(id)?;
            if cwd.is_none() {
                let project = self
                    .catalog
                    .projects()?
                    .into_iter()
                    .find(|p| p.id == session.project_id);
                // Grouping canonical aliases must not replace a session's own
                // historical cwd. Only an explicit launch override takes priority.
                cwd = project.and_then(|p| p.launch_path).or(session.cwd);
            }
            if let Some(key) = history_environment(session.kind) {
                resume_key = Some(provider_resume_key(session.kind, &source.root, id));
                env.insert(key.into(), source.root);
            } else if session.kind == AgentKind::Antigravity {
                if let Some(reason) =
                    crate::catalog::antigravity_resume_disabled_reason(&source.root, id)
                {
                    return Err(reason);
                }
                resume_key = Some(provider_resume_key(session.kind, &source.root, id));
            } else {
                return Err("This provider has no supported indexed resume source.".into());
            }
            args = resume_arguments(session.kind, id);
        } else if let Some(kind) = agent {
            args = crate::providers::definition(kind).launch.new_args.clone();
            if let Some(key) = history_environment(kind) {
                if request.resume_id.is_some()
                    && settings
                        .sources
                        .iter()
                        .filter(|s| s.enabled && s.kind == kind)
                        .count()
                        > 1
                {
                    return Err("Manual resume is ambiguous with multiple enabled history sources. Choose an indexed session or enable only the intended source.".into());
                }
                if let Some(source) = settings
                    .sources
                    .iter()
                    .find(|s| s.enabled && s.kind == kind)
                {
                    env.insert(key.into(), source.root.clone());
                }
            }
            if let Some(id) = &request.resume_id {
                args = resume_arguments(kind, id);
                let provider = crate::providers::definition(kind);
                let source_root = provider
                    .history
                    .source_env
                    .as_ref()
                    .and_then(|key| env.get(key).cloned())
                    .unwrap_or_else(|| {
                        provider
                            .state_root(&dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
                            .to_string_lossy()
                            .into_owned()
                    });
                resume_key = Some(provider_resume_key(kind, &source_root, id));
            }
        }
        let cwd = cwd.ok_or("請先選擇專案或指定工作目錄；未分類歷史不會猜測目前目錄")?;
        let cwd = PathBuf::from(cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err("工作目錄不存在或不是絕對路徑；請重新定位專案".into());
        }
        let executable = if let Some(kind) = &agent {
            args.extend(crate::launch_options::arguments(
                *kind,
                settings.agent_options.for_kind(*kind),
            )?);
            args.extend(crate::providers::definition(*kind).cwd_arguments(&cwd));
            config::resolve_executable(settings.executables.for_kind(*kind))?
        } else {
            let profile_id = request
                .profile_id
                .as_deref()
                .unwrap_or(&settings.default_profile_id);
            let profile = settings
                .profiles
                .iter()
                .find(|p| p.id == profile_id)
                .ok_or("找不到 Shell Profile")?;
            args = profile.args.clone();
            env = profile.env.clone();
            config::resolve_executable(&profile.executable)?
        };
        // GUI launches often omit Homebrew and user-local bins. Never invoke a login shell to evaluate a command string.
        if !env.contains_key("PATH") {
            let mut paths: Vec<PathBuf> =
                std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                    .filter(|p| p.is_absolute())
                    .collect();
            if let Some(parent) = executable.parent() {
                paths.insert(0, parent.to_path_buf());
            }
            for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
                let p = PathBuf::from(p);
                if !paths.contains(&p) {
                    paths.push(p);
                }
            }
            if let Some(home) = dirs::home_dir() {
                paths.push(home.join(".local/bin"));
                paths.push(home.join(".cargo/bin"));
            }
            if let Ok(path) = std::env::join_paths(paths) {
                env.insert("PATH".into(), path.to_string_lossy().into_owned());
            }
        }
        Ok(LaunchSpec {
            executable: executable.to_string_lossy().into_owned(),
            args,
            cwd,
            env,
            session_id: request.session_id.clone(),
            resume_key,
            pane_id: request.pane_id.clone(),
        })
    }
    pub fn preview_launch(&self, request: &LaunchRequest) -> Result<LaunchPreview, String> {
        let spec = self.plan_launch(request)?;
        Ok(LaunchPreview {
            executable: spec.executable,
            args: spec.args,
            cwd: spec.cwd.to_string_lossy().into_owned(),
        })
    }
    pub fn launch(
        &self,
        request: &LaunchRequest,
        emit: Arc<dyn Fn(TerminalEvent) -> Result<(), String> + Send + Sync>,
    ) -> Result<RuntimeInfo, String> {
        // Focus a live source-qualified conversation even when its transcript
        // has grown. A catalog ID alone is insufficient: source IDs can
        // be repointed to another root while an older runtime is still active.
        if let Some(id) = request
            .session_id
            .as_ref()
            .filter(|_| request.resume_id.is_none())
        {
            if let Ok(session) = self.catalog.session(id) {
                if session.resume_disabled_reason.is_none()
                    && session.kind.as_str() == request.kind
                    && request
                        .project_id
                        .as_ref()
                        .is_none_or(|id| id == &session.project_id)
                {
                    if let Some(source) = self.settings()?.sources.iter().find(|source| {
                        source.id == session.source_id
                            && source.kind == session.kind
                            && source.enabled
                    }) {
                        let source_unchanged = self
                            .catalog
                            .history_source(&session.source_id)
                            .is_ok_and(|cached| {
                                cached.enabled
                                    && cached.kind == source.kind
                                    && cached.root == source.root
                            });
                        if source_unchanged && self.catalog.indexed_files_still_match(id)? {
                            let key = provider_resume_key(
                                session.kind,
                                &source.root,
                                &session.external_id,
                            );
                            if let Some(existing) = self.runtime.find_running_resume(&key) {
                                return Ok(existing);
                            }
                        }
                    }
                }
            }
        }
        let spec = self.plan_launch(request)?;
        self.runtime.launch(spec, request.cols, request.rows, emit)
    }
    pub fn is_shutdown(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    pub fn shutdown(&self) -> Result<(), String> {
        self.cancel.store(true, Ordering::Release);
        self.runtime.shutdown()?;
        self.closed.store(true, Ordering::Release);
        Ok(())
    }
}

fn provider_resume_key(kind: AgentKind, root: &str, id: &str) -> String {
    let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
    let canonical_uuid = (kind == AgentKind::Antigravity)
        .then(|| uuid::Uuid::parse_str(id).ok())
        .flatten()
        .map(|id| id.hyphenated().to_string());
    let mut hash = Sha256::new();
    for part in [
        kind.as_str(),
        canonical.to_str().unwrap_or(root),
        canonical_uuid.as_deref().unwrap_or(id),
    ] {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part.as_bytes());
    }
    format!("provider-{:x}", hash.finalize())
}

fn validate_resume_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 256
        || !id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    {
        return Err("Session ID must start with a letter or number and contain only letters, numbers, hyphens, underscores or dots (maximum 256 characters).".into());
    }
    Ok(())
}

fn history_environment(kind: AgentKind) -> Option<&'static str> {
    crate::providers::definition(kind)
        .history
        .source_env
        .as_deref()
}

fn resume_arguments(kind: AgentKind, id: &str) -> Vec<String> {
    crate::providers::definition(kind).resume_arguments(id)
}

fn empty_index() -> IndexStatus {
    IndexStatus {
        revision: 0,
        running: false,
        processed: 0,
        total: 0,
        cancelled: false,
        errors: vec![],
        sources: vec![],
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn appearance_saves_during_indexing_but_other_changes_remain_blocked() {
        let temp = tempfile::tempdir().unwrap();
        let service = Service::open(temp.path().join("app")).unwrap();
        let mut next = service.settings().unwrap();
        service.index.lock().unwrap().running = true;
        let _scan = service.scan_guard.lock().unwrap();
        next.theme_palette = "rose".into();
        next.terminal_theme = "ocean-light".into();
        let saved = service.save_settings(next.clone()).unwrap();
        assert_eq!(saved.theme_palette, "rose");
        assert_eq!(
            service.config.load_settings().0.terminal_theme,
            "ocean-light"
        );
        next.sources.clear();
        assert!(service.save_settings(next).is_err());
        let mut other = service.settings().unwrap();
        other.profiles[0].name = "Unrelated edit".into();
        assert!(service.save_settings(other).is_err());
        assert_eq!(service.settings().unwrap().theme_palette, "rose");
    }

    #[test]
    fn failed_appearance_write_does_not_change_in_memory_settings() {
        let temp = tempfile::tempdir().unwrap();
        let service = Service::open(temp.path().join("app")).unwrap();
        std::fs::create_dir(service.config.directory.join("settings.json")).unwrap();
        let mut next = service.settings().unwrap();
        next.theme_palette = "forest".into();
        assert!(service.save_settings(next).is_err());
        assert_eq!(service.settings().unwrap().theme_palette, "bay");
    }

    #[test]
    fn antigravity_runtime_identity_normalizes_uuid_case_without_rewriting_argv() {
        let id = "07EB4413-E2D7-4D1D-9E39-85AD75ECFF49";
        assert_eq!(
            super::provider_resume_key(crate::models::AgentKind::Antigravity, "/synthetic/cli", id),
            super::provider_resume_key(
                crate::models::AgentKind::Antigravity,
                "/synthetic/cli",
                &id.to_ascii_lowercase()
            )
        );
        assert_eq!(
            super::resume_arguments(crate::models::AgentKind::Antigravity, id),
            ["--conversation", id]
        );
    }
    use super::*;
    fn request(cwd: Option<String>) -> LaunchRequest {
        LaunchRequest {
            pane_id: "test-pane".into(),
            kind: "shell".into(),
            project_id: None,
            session_id: None,
            resume_id: None,
            cwd,
            profile_id: None,
            cols: 80,
            rows: 24,
        }
    }
    #[test]
    fn launch_requires_explicit_valid_directory() {
        let d = tempfile::tempdir().unwrap();
        let s = Service::open(d.path().join("app")).unwrap();
        assert!(s.plan_launch(&request(None)).is_err());
        assert!(s.plan_launch(&request(Some("relative".into()))).is_err());
        assert!(s
            .plan_launch(&request(Some(d.path().to_string_lossy().into())))
            .is_ok());
    }
    #[test]
    fn launch_keeps_metacharacter_path_out_of_shell() {
        let d = tempfile::tempdir().unwrap();
        let cwd = d.path().join("a;$(echo no)");
        std::fs::create_dir(&cwd).unwrap();
        let s = Service::open(d.path().join("app")).unwrap();
        let plan = s
            .plan_launch(&request(Some(cwd.to_string_lossy().into())))
            .unwrap();
        assert_eq!(plan.cwd, cwd);
        assert!(!plan.args.iter().any(|a| a.contains("echo no")));
    }
}
