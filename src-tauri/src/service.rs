use crate::{
    broker::{BrokerClient, RuntimeRecord, UiEmitter},
    catalog::Catalog,
    config::{self, ConfigStore, Installation, Settings},
    models::{
        AgentKind, IndexStatus, Project, WorkspaceFileChunk, WorkspaceFileInfo, WorkspaceFilePage,
        WorkspaceFilePreview,
    },
    runtime::{LaunchSpec, RuntimeInfo, RuntimeManager, TerminalEvent},
    workspace_files,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
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

impl LaunchRequest {
    pub(crate) fn uses_home_directory(&self) -> bool {
        self.kind == "shell"
            && self.project_id.is_none()
            && self.session_id.is_none()
            && self.resume_id.is_none()
            && self.cwd.is_none()
    }
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
    pub runtimes: Vec<RuntimeRecord>,
}

pub struct Service {
    pub catalog: Catalog,
    pub config: ConfigStore,
    pub runtime: RuntimeManager,
    pub file_staging: Mutex<Option<crate::file_input::FileStaging>>,
    pub image_staging: Mutex<Option<crate::image_input::ImageStaging>>,
    fresh_launches: Mutex<crate::fresh_launch::FreshLaunches>,
    launch_provenance: Mutex<Option<crate::launch_provenance::LaunchProvenance>>,
    broker: Option<BrokerClient>,
    settings: Mutex<Settings>,
    index: Mutex<IndexStatus>,
    scan_guard: Mutex<()>,
    cancel: AtomicBool,
    paused: AtomicBool,
    closed: AtomicBool,
    warnings: Vec<String>,
}

impl Service {
    pub fn open(directory: PathBuf) -> Result<Arc<Self>, String> {
        Self::open_internal(directory, None)
    }
    pub fn open_desktop(directory: PathBuf) -> Result<Arc<Self>, String> {
        // Establish local configuration storage before creating its private IPC child.
        let config = ConfigStore::open(directory.clone())?;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let broker = BrokerClient::connect(&config.directory, &executable)?;
        Self::open_internal(directory, Some(broker))
    }
    fn open_internal(
        directory: PathBuf,
        broker: Option<BrokerClient>,
    ) -> Result<Arc<Self>, String> {
        let config = ConfigStore::open(directory)?;
        let (settings, warnings) = config.load_settings();
        let catalog = Catalog::open(&config.directory.join("catalog.sqlite"))?;
        let service = Arc::new(Self {
            catalog,
            config,
            runtime: RuntimeManager::new(),
            image_staging: Mutex::new(None),
            file_staging: Mutex::new(None),
            fresh_launches: Mutex::new(Default::default()),
            launch_provenance: Mutex::new(None),
            broker,
            settings: Mutex::new(settings),
            index: Mutex::new(empty_index()),
            scan_guard: Mutex::new(()),
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
    pub fn list_workspace_files(
        &self,
        project_id: &str,
        path: &str,
        offset: usize,
        show_hidden: bool,
    ) -> Result<WorkspaceFilePage, String> {
        let root = self.catalog.workspace_root(project_id)?;
        workspace_files::list(&root, path, offset, show_hidden)
    }
    pub fn read_workspace_file(
        &self,
        project_id: &str,
        path: &str,
    ) -> Result<WorkspaceFilePreview, String> {
        let root = self.catalog.workspace_root(project_id)?;
        workspace_files::read(&root, path)
    }
    pub fn inspect_workspace_file(
        &self,
        project_id: &str,
        path: &str,
    ) -> Result<WorkspaceFileInfo, String> {
        let root = self.catalog.workspace_root(project_id)?;
        workspace_files::inspect(&root, path)
    }
    pub fn read_workspace_file_chunk(
        &self,
        project_id: &str,
        path: &str,
        version: &str,
        offset: u64,
        max_bytes: usize,
    ) -> Result<WorkspaceFileChunk, String> {
        let root = self.catalog.workspace_root(project_id)?;
        workspace_files::read_chunk(&root, path, version, offset, max_bytes)
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
            runtimes: self
                .broker
                .as_ref()
                .map(|broker| broker.list())
                .transpose()?
                .unwrap_or_default(),
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
            "appZoom",
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
        settings.validate()?;
        if let Some(broker) = &self.broker {
            for kind in [AgentKind::Codex, AgentKind::Claude] {
                if settings.agent_hooks.get(kind.as_str()) != Some(&true) {
                    broker.revoke_provider_hooks(kind)?;
                }
            }
        }
        self.config.save_settings(&settings)?;
        *current = settings.clone();
        Ok(settings)
    }
    pub fn index_status(&self) -> Result<IndexStatus, String> {
        let mut status = self.index.lock().map_err(|_| "索引狀態鎖定失敗")?.clone();
        // Also report committed changes while a scan is still running.
        status.revision = self.catalog.revision()?;
        Ok(status)
    }
    pub fn start_index(self: &Arc<Self>, rebuild: bool) -> Result<IndexStatus, String> {
        {
            let mut status = self.index.lock().map_err(|_| "索引狀態鎖定失敗")?;
            if status.running {
                return Ok(status.clone());
            }
            let revision = self.catalog.revision()?;
            *status = empty_index();
            status.running = true;
            status.revision = revision;
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
                let settings = service.settings()?;
                let paused_providers: HashSet<_> = AgentKind::ALL
                    .into_iter()
                    .filter(|kind| !settings.is_agent_enabled(*kind))
                    .collect();
                service.catalog.sync_with_paused_providers(
                    &settings.sources,
                    &paused_providers,
                    &service.cancel,
                    |mut progress| {
                        if let Ok(mut status) = service.index.lock() {
                            progress.revision = status.revision;
                            *status = progress;
                        }
                    },
                )
            })();
            if let Ok(mut status) = service.index.lock() {
                match result {
                    Ok(mut final_status) => {
                        final_status.running = false;
                        final_status.revision = status.revision;
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
        empty.revision = self.catalog.revision()?;
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
        let agent = if request.kind == "shell" {
            None
        } else {
            Some(AgentKind::parse(&request.kind)?)
        };
        if let Some(kind) = agent.filter(|kind| !settings.is_agent_enabled(*kind)) {
            return Err(format!(
                "{} is disabled. Enable it in Settings before starting or resuming a session.",
                crate::providers::definition(kind).name
            ));
        }
        let mut env = HashMap::new();
        let mut args = vec![];
        let mut resume_key = None;
        let mut cwd = request.cwd.clone();
        if request.uses_home_directory() {
            // An unscoped shell is a temporary terminal. Resolve its home in
            // Rust, before applying profile environment; never trust a UI guess.
            let home = temporary_terminal_home(dirs::home_dir())?;
            cwd = Some(
                home.to_str()
                    .ok_or("家目錄路徑不是有效的 Unicode")?
                    .to_owned(),
            );
        }
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
        if let Some(resume_id) = &request.resume_id {
            if !agent.is_some_and(|kind| crate::providers::definition(kind).resume.manual_id) {
                return Err("Manual resume IDs are not supported by this provider.".into());
            }
            validate_resume_id(resume_id)?;
            if agent == Some(AgentKind::OpenCode) && !crate::opencode::valid_session_id(resume_id) {
                return Err("OpenCode resume IDs must use the native ses_ identifier.".into());
            }
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
                resume_key = Some(provider_resume_key(session.kind, &source.root, id)?);
                env.insert(
                    key.into(),
                    history_environment_value(session.kind, &source.root),
                );
            } else if session.kind == AgentKind::Antigravity {
                if let Some(reason) =
                    crate::catalog::antigravity_resume_disabled_reason(&source.root, id)
                {
                    return Err(reason);
                }
                resume_key = Some(provider_resume_key(session.kind, &source.root, id)?);
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
                    env.insert(key.into(), history_environment_value(kind, &source.root));
                }
            }
            if kind == AgentKind::OpenCode && !env.contains_key("OPENCODE_DB") {
                let root = crate::providers::definition(kind)
                    .state_root(&dirs::home_dir().ok_or("Home directory unavailable")?);
                env.insert(
                    "OPENCODE_DB".into(),
                    history_environment_value(kind, &root.to_string_lossy()),
                );
            }
            if let Some(id) = &request.resume_id {
                args = resume_arguments(kind, id);
                let source_root = manual_resume_root(&settings, kind)?;
                resume_key = Some(provider_resume_key(kind, &source_root, id)?);
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
        if !env.keys().any(|key| {
            if cfg!(windows) {
                key.eq_ignore_ascii_case("PATH")
            } else {
                key == "PATH"
            }
        }) {
            let mut paths: Vec<PathBuf> =
                std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                    .filter(|p| p.is_absolute())
                    .collect();
            if let Some(parent) = executable.parent() {
                paths.insert(0, parent.to_path_buf());
            }
            for path in config::executable_fallback_directories() {
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
            if let Ok(path) = std::env::join_paths(paths) {
                env.insert("PATH".into(), path.to_string_lossy().into_owned());
            }
        }
        if let Some(kind) = agent {
            if settings.agent_hooks.get(kind.as_str()) == Some(&true) {
                if !crate::provider_hooks::supported(kind) {
                    return Err("此工具／平台尚未支援 launch-local hooks".into());
                }
                env.insert(crate::provider_hooks::OPT_IN.into(), "live".into());
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
        if let Some(key) = self.existing_resume_key(request)? {
            if let Some(existing) = self.runtime.find_running_resume(&key) {
                return Ok(existing);
            }
        }
        let spec = self.plan_launch(request)?;
        if spec.env.contains_key(crate::provider_hooks::OPT_IN) {
            return Err("真實 hooks 需要 persistent broker 啟動".into());
        }
        self.runtime.launch(spec, request.cols, request.rows, emit)
    }

    fn existing_resume_key(&self, request: &LaunchRequest) -> Result<Option<String>, String> {
        if request.pane_id.is_empty()
            || request.pane_id.len() > 128
            || request.pane_id.contains('\0')
            || request.cols < 2
            || request.cols > 1000
            || request.rows < 1
            || request.rows > 1000
        {
            return Ok(None);
        }
        if let Some(id) = request
            .resume_id
            .as_ref()
            .filter(|_| request.session_id.is_none())
        {
            let kind = AgentKind::parse(&request.kind)?;
            if !crate::providers::definition(kind).resume.manual_id {
                return Ok(None);
            }
            validate_resume_id(id)?;
            if kind == AgentKind::OpenCode && !crate::opencode::valid_session_id(id) {
                return Ok(None);
            }
            let mut cwd = request.cwd.clone();
            if let Some(project_id) = &request.project_id {
                let project = self
                    .catalog
                    .projects()?
                    .into_iter()
                    .find(|project| &project.id == project_id)
                    .ok_or("找不到專案，請重新選擇")?;
                if cwd.is_none() {
                    cwd = project.launch_path.or(project.path);
                }
            }
            if !cwd.as_ref().is_some_and(|cwd| {
                let path = std::path::Path::new(cwd);
                path.is_absolute() && path.is_dir()
            }) {
                return Ok(None);
            }
            let Ok(root) = manual_resume_root(&self.settings()?, kind) else {
                return Ok(None);
            };
            return Ok(provider_resume_key(kind, &root, id).ok());
        }
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
                            return provider_resume_key(
                                session.kind,
                                &source.root,
                                &session.external_id,
                            )
                            .map(Some);
                        }
                    }
                }
            }
        }
        Ok(None)
    }
    pub fn broker(&self) -> Result<&BrokerClient, String> {
        self.broker
            .as_ref()
            .ok_or_else(|| "Persistent runtime broker is not connected".into())
    }
    /// Mint and validate a genuinely fresh identity without disturbing existing broker runtimes.
    pub fn launch_fresh(&self, request: &LaunchRequest) -> Result<RuntimeInfo, String> {
        let broker = self.broker()?;
        self.fresh_launches
            .lock()
            .map_err(|_| "Fresh launch lock failed")?
            .launch(
                request,
                broker,
                |request| self.plan_launch(request),
                |generation, record| {
                    let mut provenance = self
                        .launch_provenance
                        .lock()
                        .map_err(|_| "Launch provenance lock failed")?;
                    if provenance.is_none() {
                        *provenance = Some(crate::launch_provenance::LaunchProvenance::open(
                            &self.config.directory,
                        )?);
                    }
                    let records = broker.list()?;
                    if broker.generation() != generation {
                        return Err("Broker generation changed while recording launch".into());
                    }
                    let provenance = provenance.as_ref().ok_or("Launch provenance unavailable")?;
                    provenance.prune_current_generation(generation, &records)?;
                    provenance.record(generation, record).map_err(|error| format!(
                        "{error}（啟動證明位置：{}；僅能整理確定已結束工作階段的證明，勿刪 lock 或附件）",
                        self.config.directory.join("launch-provenance-v1").display()
                    ))
                },
            )
    }

    /// Staging begin and retain check the live broker record. Missing metadata alone never grants access.
    pub fn check_file_runtime(&self, runtime_id: &str) -> Result<(), String> {
        let broker = self.broker()?;
        let generation = broker.generation();
        let record = broker
            .list()?
            .into_iter()
            .find(|record| record.info.id == runtime_id)
            .ok_or("檔案目標工作階段不存在。")?;
        if broker.generation() != generation {
            return Err("背景程序已變更，請重新確認工作階段。".into());
        }
        crate::fresh_launch::check_file_capability(&record, || {
            let matched = {
                let mut provenance = self
                    .launch_provenance
                    .lock()
                    .map_err(|_| "Launch provenance lock failed")?;
                if provenance.is_none() {
                    *provenance = Some(crate::launch_provenance::LaunchProvenance::open(
                        &self.config.directory,
                    )?);
                }
                provenance
                    .as_ref()
                    .ok_or("Launch provenance unavailable")?
                    .matches(&generation, &record)?
            };
            // Release the store lock before taking the launch registry lock.
            if !matched {
                if let Some(error) = self
                    .fresh_launches
                    .lock()
                    .map_err(|_| "Fresh launch lock failed")?
                    .capability_error(&generation, runtime_id)
                {
                    return Err(format!(
                        "Agent 已啟動，但本機檔案能力證明無法保存：{error}。尚未插入。"
                    ));
                }
            }
            Ok(matched)
        })
    }

    pub fn launch_persistent(
        &self,
        request: &LaunchRequest,
        attachment_id: String,
        emit: UiEmitter,
    ) -> Result<RuntimeInfo, String> {
        // Focus/reattach an existing process before applying the new-launch policy.
        // A provider toggle must never strand a live conversation behind plan_launch.
        if let Some(key) = self.existing_resume_key(request)? {
            if let Some(existing) = self.broker()?.find_running_resume(&key)? {
                return if existing.pane_id == request.pane_id {
                    self.broker()?.attach(&existing.id, attachment_id, emit)
                } else {
                    Ok(existing)
                };
            }
        }
        let spec = self.plan_launch(request)?;
        self.broker()?.launch(spec, request, attachment_id, emit)
    }
    pub fn is_shutdown(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    pub fn shutdown(&self) -> Result<(), String> {
        self.cancel.store(true, Ordering::Release);
        if let Some(broker) = &self.broker {
            broker.detach_all();
        }
        self.runtime.shutdown()?;
        self.closed.store(true, Ordering::Release);
        Ok(())
    }
}

fn temporary_terminal_home(home: Option<PathBuf>) -> Result<PathBuf, String> {
    let home = home.ok_or("無法取得本機家目錄，請檢查系統使用者設定")?;
    if !home.is_absolute() || !home.is_dir() {
        return Err("本機家目錄不存在或不是絕對目錄".into());
    }
    Ok(home)
}

fn manual_resume_root(settings: &Settings, kind: AgentKind) -> Result<String, String> {
    if history_environment(kind).is_some() {
        let mut sources = settings
            .sources
            .iter()
            .filter(|source| source.enabled && source.kind == kind);
        if let Some(source) = sources.next() {
            if sources.next().is_some() {
                return Err("Manual resume is ambiguous with multiple enabled history sources. Choose an indexed session or enable only the intended source.".into());
            }
            return Ok(source.root.clone());
        }
    }
    Ok(crate::providers::definition(kind)
        .state_root(&config::default_home())
        .to_string_lossy()
        .into_owned())
}

fn provider_resume_key(kind: AgentKind, root: &str, id: &str) -> Result<String, String> {
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
    // Bind an OpenCode runtime to the physical database it opened. Reindexing a
    // replacement at the same root must never make the old runtime look current.
    // Normal WAL/checkpoint writes preserve this identity and still deduplicate.
    if kind == AgentKind::OpenCode {
        let identity = crate::opencode::database_identity(PathBuf::from(root).as_path())?;
        hash.update((identity.len() as u64).to_le_bytes());
        hash.update(identity.as_bytes());
    }
    Ok(format!("provider-{:x}", hash.finalize()))
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

fn history_environment_value(kind: AgentKind, root: &str) -> String {
    if kind == AgentKind::OpenCode {
        std::path::Path::new(root)
            .join("opencode.db")
            .to_string_lossy()
            .into_owned()
    } else {
        root.into()
    }
}

fn history_environment(kind: AgentKind) -> Option<&'static str> {
    if kind == AgentKind::OpenCode {
        return Some("OPENCODE_DB");
    }
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
    fn failed_revision_read_does_not_mark_an_unstarted_scan_running() {
        let dir = tempfile::tempdir().unwrap();
        let service = super::Service::open(dir.path().to_path_buf()).unwrap();
        let conn = rusqlite::Connection::open(dir.path().join("catalog.sqlite")).unwrap();
        conn.execute_batch("DROP TABLE catalog_revision").unwrap();
        assert!(service.start_index(false).is_err());
        assert!(!service.index.lock().unwrap().running);
    }

    #[cfg(unix)]
    #[test]
    fn disabled_provider_keeps_persistent_focus_and_attachment_without_new_processes() {
        use std::{fs, os::unix::fs::PermissionsExt, time::Instant};
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        ConfigStore::open(app.clone()).unwrap();
        let broker_dir = app.clone();
        let host = std::thread::spawn(move || crate::broker::run(broker_dir));
        let deadline = Instant::now() + Duration::from_secs(5);
        let client = loop {
            if let Ok(client) = BrokerClient::existing_for_test(&app) {
                break client;
            }
            if host.is_finished() {
                panic!("Test broker stopped: {:?}", host.join().unwrap());
            }
            assert!(Instant::now() < deadline, "test broker did not start");
            std::thread::sleep(Duration::from_millis(5));
        };
        let service = Service::open_internal(app, Some(client.clone())).unwrap();
        let executable = temp.path().join("synthetic sleeper");
        fs::write(&executable, "#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let root = temp.path().join("history");
        fs::create_dir_all(root.join("sessions")).unwrap();
        fs::write(root.join("sessions/live.jsonl"), format!("{}\n", serde_json::json!({"type":"session_meta","payload":{"id":"live-session","cwd":temp.path()}}))).unwrap();
        let mut settings = service.settings().unwrap();
        settings.sources = vec![crate::models::HistorySource {
            id: "synthetic-codex".into(),
            kind: AgentKind::Codex,
            root: root.to_string_lossy().into_owned(),
            enabled: true,
        }];
        settings.executables.codex = executable.to_string_lossy().into_owned();
        settings.executables.grok = settings.executables.codex.clone();
        service.save_settings(settings.clone()).unwrap();
        service
            .catalog
            .sync(&settings.sources, &AtomicBool::new(false), |_| {})
            .unwrap();
        let session = service
            .catalog
            .query(&crate::models::SessionQuery::default())
            .unwrap()
            .items
            .remove(0);
        for kind in [AgentKind::Codex, AgentKind::Grok] {
            let mut launch = request(Some(temp.path().to_string_lossy().into_owned()));
            launch.kind = kind.as_str().into();
            launch.pane_id = format!("{}-pane", kind.as_str());
            if kind == AgentKind::Codex {
                launch.session_id = Some(session.id.clone());
            } else {
                launch.resume_id = Some("synthetic-live-grok".into());
            }
            let first = service
                .launch_persistent(
                    &launch,
                    uuid::Uuid::new_v4().to_string(),
                    Arc::new(|_| Ok(())),
                )
                .unwrap();
            settings.agent_enabled.insert(kind.as_str().into(), false);
            service.save_settings(settings.clone()).unwrap();
            let reattached = service
                .launch_persistent(
                    &launch,
                    uuid::Uuid::new_v4().to_string(),
                    Arc::new(|_| Ok(())),
                )
                .unwrap();
            assert_eq!(reattached.id, first.id);
            launch.pane_id = format!("{}-other-pane", kind.as_str());
            let focused = service
                .launch_persistent(
                    &launch,
                    uuid::Uuid::new_v4().to_string(),
                    Arc::new(|_| Ok(())),
                )
                .unwrap();
            assert_eq!(focused.id, first.id);
            let attached = client
                .attach(
                    &first.id,
                    uuid::Uuid::new_v4().to_string(),
                    Arc::new(|_| Ok(())),
                )
                .unwrap();
            assert_eq!(attached.state, "running");
            assert_eq!(
                client
                    .list()
                    .unwrap()
                    .iter()
                    .filter(|record| record.info.state == "running")
                    .count(),
                1
            );
            client.stop(&first.id).unwrap();
            assert!(service
                .launch_persistent(
                    &launch,
                    uuid::Uuid::new_v4().to_string(),
                    Arc::new(|_| Ok(()))
                )
                .unwrap_err()
                .contains("is disabled"));
        }
        service.shutdown().unwrap();
        client.shutdown_broker().unwrap();
        host.join().unwrap().unwrap();
    }

    #[test]
    fn appearance_saves_during_indexing_but_other_changes_remain_blocked() {
        let temp = tempfile::tempdir().unwrap();
        let service = Service::open(temp.path().join("app")).unwrap();
        let mut next = service.settings().unwrap();
        service.index.lock().unwrap().running = true;
        let _scan = service.scan_guard.lock().unwrap();
        next.app_zoom = 150;
        next.theme_palette = "rose".into();
        next.terminal_theme = "ocean-light".into();
        let saved = service.save_settings(next.clone()).unwrap();
        assert_eq!(saved.theme_palette, "rose");
        assert_eq!(saved.app_zoom, 150);
        assert_eq!(service.config.load_settings().0.app_zoom, 150);
        assert_eq!(
            service.config.load_settings().0.terminal_theme,
            "ocean-light"
        );
        next.sources.clear();
        assert!(service.save_settings(next).is_err());
        let mut other = service.settings().unwrap();
        other.profiles[0].name = "Unrelated edit".into();
        assert!(service.save_settings(other).is_err());
        let mut other = service.settings().unwrap();
        other.agent_enabled.insert("codex".into(), false);
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
    fn explicit_directories_are_validated_and_unscoped_shell_uses_home() {
        let d = tempfile::tempdir().unwrap();
        let s = Service::open(d.path().join("app")).unwrap();
        assert_eq!(
            s.plan_launch(&request(None)).unwrap().cwd,
            dirs::home_dir().unwrap()
        );
        let mut agent = request(None);
        agent.kind = "codex".into();
        assert!(s.plan_launch(&agent).is_err());
        assert!(s.plan_launch(&request(Some("relative".into()))).is_err());
        assert!(s
            .plan_launch(&request(Some(d.path().to_string_lossy().into())))
            .is_ok());
    }
    #[test]
    fn bootstrap_has_no_routine_notice_and_preserves_real_workspace_warnings() {
        let directory = tempfile::tempdir().unwrap();
        let service = Service::open(directory.path().join("app")).unwrap();
        let mut settings = service.settings().unwrap();
        settings.sources.clear();
        service.save_settings(settings).unwrap();
        assert!(service.bootstrap().unwrap().warnings.is_empty());
        std::fs::write(
            service.config.directory.join("workspace.json"),
            b"invalid-json",
        )
        .unwrap();
        let bootstrap = service.bootstrap().unwrap();
        assert_eq!(bootstrap.warnings.len(), 1);
        assert!(bootstrap.warnings[0].contains("布局已還原預設值；原檔保留"));
    }
    #[test]
    fn temporary_home_fails_closed_without_a_real_absolute_directory() {
        let temp = tempfile::tempdir().unwrap();
        assert!(temporary_terminal_home(None).is_err());
        assert!(temporary_terminal_home(Some(PathBuf::from("relative"))).is_err());
        assert!(temporary_terminal_home(Some(temp.path().join("missing"))).is_err());
        let file = temp.path().join("file");
        std::fs::write(&file, "synthetic").unwrap();
        assert!(temporary_terminal_home(Some(file)).is_err());
        let unicode = temp.path().join("家目錄 with spaces");
        std::fs::create_dir(&unicode).unwrap();
        assert_eq!(
            temporary_terminal_home(Some(unicode.clone())).unwrap(),
            unicode
        );
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
