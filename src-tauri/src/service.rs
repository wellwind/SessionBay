use crate::{
    catalog::Catalog,
    config::{self, ConfigStore, Installation, Settings},
    models::{AgentKind, IndexStatus, Project},
    runtime::{LaunchSpec, RuntimeInfo, RuntimeManager, TerminalEvent},
};
use serde::{Deserialize, Serialize};
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
    pub cwd: Option<String>,
    pub profile_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
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
        if self.index_status()?.running {
            return Err("請先取消索引並等待完成，再修改來源設定".into());
        }
        let _guard = self
            .scan_guard
            .try_lock()
            .map_err(|_| "請先取消索引並等待完成，再修改來源設定")?;
        self.config.save_settings(&settings)?;
        *self.settings.lock().map_err(|_| "設定鎖定失敗")? = settings.clone();
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
        let settings = self.settings()?;
        let mut env = HashMap::new();
        let mut args = vec![];
        let mut cwd = request.cwd.clone();
        if let Some(project_id) = &request.project_id {
            let project = self
                .catalog
                .projects()?
                .into_iter()
                .find(|p| &p.id == project_id)
                .ok_or("找不到專案，請重新選擇")?;
            if cwd.is_none() {
                cwd = project.launch_path.or(project.path);
            }
        }
        let agent = match request.kind.as_str() {
            "codex" => Some(AgentKind::Codex),
            "claude" => Some(AgentKind::Claude),
            "shell" => None,
            _ => return Err("不支援的工具種類".into()),
        };
        if let Some(session_id) = &request.session_id {
            let (session, source) = self.catalog.resume_source(session_id)?;
            if agent.as_ref() != Some(&session.kind) {
                return Err("Session 的工具與啟動選項不一致".into());
            }
            if !settings
                .sources
                .iter()
                .any(|s| s.id == source.id && s.enabled && s.root == source.root)
            {
                return Err("Session 的來源已停用或變更，請重新索引".into());
            }
            let id = &session.external_id;
            if id.is_empty()
                || id.len() > 256
                || !id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
                || !id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_ .".contains(c))
                || id.contains(' ')
            {
                return Err("Session ID 格式不支援安全恢復".into());
            }
            if cwd.is_none() {
                let project = self
                    .catalog
                    .projects()?
                    .into_iter()
                    .find(|p| p.id == session.project_id);
                cwd = project
                    .and_then(|p| p.launch_path.or(p.path))
                    .or(session.cwd);
            }
            let key = match session.kind {
                AgentKind::Codex => "CODEX_HOME",
                AgentKind::Claude => "CLAUDE_CONFIG_DIR",
            };
            env.insert(key.into(), source.root);
            args = match session.kind {
                AgentKind::Codex => vec!["resume".into(), id.clone()],
                AgentKind::Claude => vec!["--resume".into(), id.clone()],
            };
        } else if let Some(kind) = &agent {
            if let Some(source) = settings
                .sources
                .iter()
                .find(|s| s.enabled && &s.kind == kind)
            {
                env.insert(
                    match kind {
                        AgentKind::Codex => "CODEX_HOME",
                        AgentKind::Claude => "CLAUDE_CONFIG_DIR",
                    }
                    .into(),
                    source.root.clone(),
                );
            }
        }
        let cwd = cwd.ok_or("請先選擇專案或指定工作目錄；未分類歷史不會猜測目前目錄")?;
        let cwd = PathBuf::from(cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err("工作目錄不存在或不是絕對路徑；請重新定位專案".into());
        }
        let executable = if let Some(kind) = &agent {
            if matches!(kind, AgentKind::Codex) {
                args.extend(["--cd".into(), cwd.to_string_lossy().into_owned()]);
            }
            config::resolve_executable(match kind {
                AgentKind::Codex => &settings.executables.codex,
                AgentKind::Claude => &settings.executables.claude,
            })?
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
            pane_id: request.pane_id.clone(),
        })
    }
    pub fn launch(
        &self,
        request: &LaunchRequest,
        emit: Arc<dyn Fn(TerminalEvent) -> Result<(), String> + Send + Sync>,
    ) -> Result<RuntimeInfo, String> {
        // Check duplicate identity before preflight: an existing managed runtime can be focused even if its source was moved.
        if let Some(id) = &request.session_id {
            if let Some(existing) = self.runtime.list().into_iter().find(|r| {
                r.session_id.as_ref() == Some(id)
                    && ["starting", "running"].contains(&r.state.as_str())
            }) {
                return Ok(existing);
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
    use super::*;
    fn request(cwd: Option<String>) -> LaunchRequest {
        LaunchRequest {
            pane_id: "test-pane".into(),
            kind: "shell".into(),
            project_id: None,
            session_id: None,
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
