use crate::tr;
use crate::{
    broker::{BrokerClient, RuntimeRecord, UiEmitter},
    catalog::Catalog,
    config::{self, ConfigStore, Installation, Settings},
    models::{
        AgentKind, IndexStatus, Project, WorkspaceFileChunk, WorkspaceFileInfo, WorkspaceFilePage,
        WorkspaceFilePreview, WorkspaceFileSearch,
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
    pub kanban_card_id: Option<String>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerStatus {
    pub generation: String,
    pub build_mismatch: bool,
    pub running_count: usize,
}

pub struct Service {
    pub catalog: Catalog,
    pub config: ConfigStore,
    pub runtime: RuntimeManager,
    pub git: crate::git::GitService,
    os_trash: crate::os_trash::PlanStore,
    pub file_staging: Mutex<Option<crate::file_input::FileStaging>>,
    pub image_staging: Mutex<Option<crate::image_input::ImageStaging>>,
    fresh_launches: Mutex<crate::fresh_launch::FreshLaunches>,
    fresh_launch_control: Arc<crate::fresh_launch::FreshLaunchControl>,
    launch_provenance: Mutex<Option<crate::launch_provenance::LaunchProvenance>>,
    broker: Mutex<Option<BrokerClient>>,
    ui_owner: Mutex<Option<crate::broker::NativeUiLease>>,
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
        Self::open_internal(directory, None, Vec::new())
    }
    pub fn open_desktop(directory: PathBuf) -> Result<Arc<Self>, String> {
        Self::open_desktop_with_warnings(directory, Vec::new())
    }
    pub fn open_desktop_with_warnings(
        directory: PathBuf,
        warnings: Vec<String>,
    ) -> Result<Arc<Self>, String> {
        // Establish local configuration storage before creating its private IPC child.
        let config = ConfigStore::open(directory.clone())?;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let broker = BrokerClient::connect(&config.directory, &executable)?;
        let owner = broker.start_ui_owner()?;
        let service = Self::open_internal(directory, Some(broker), warnings)?;
        *service
            .ui_owner
            .lock()
            .map_err(|_| "UI owner lock unavailable")? = owner;
        Ok(service)
    }
    fn open_internal(
        directory: PathBuf,
        broker: Option<BrokerClient>,
        mut warnings: Vec<String>,
    ) -> Result<Arc<Self>, String> {
        let config = ConfigStore::open(directory)?;
        let (settings, config_warnings) = config.load_settings();
        warnings.extend(config_warnings);
        let catalog = Catalog::open(&config.directory.join("catalog.sqlite"))?;
        let git = crate::git::GitService::with_data_dir(config.directory.clone());
        let opencode_staging = config.directory.join("opencode-export");
        let fresh_launch_control = Arc::new(crate::fresh_launch::FreshLaunchControl::default());
        let service = Arc::new(Self {
            catalog,
            config,
            runtime: RuntimeManager::new(),
            git,
            os_trash: crate::os_trash::PlanStore::default().with_staging(opencode_staging),
            image_staging: Mutex::new(None),
            file_staging: Mutex::new(None),
            fresh_launches: Mutex::new(crate::fresh_launch::FreshLaunches::new(
                fresh_launch_control.clone(),
            )),
            fresh_launch_control,
            launch_provenance: Mutex::new(None),
            broker: Mutex::new(broker),
            ui_owner: Mutex::new(None),
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
            .map_err(|_| tr!("Could not lock the settings"))
    }
    pub fn resolve_terminal_file(
        &self,
        project_id: &str,
        pane_id: &str,
        runtime_id: &str,
        path: &str,
    ) -> Result<crate::models::TerminalFileResolution, String> {
        let records = self.broker()?.list()?;
        let cwd =
            crate::terminal_file_links::launch_cwd(&records, project_id, pane_id, runtime_id)?;
        let root = self.catalog.workspace_root(project_id)?;
        crate::terminal_file_links::resolve(&root, &cwd, path)
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
    pub fn search_workspace_files(
        &self,
        project_id: &str,
        query: &str,
    ) -> Result<WorkspaceFileSearch, String> {
        let root = self.catalog.workspace_root(project_id)?;
        workspace_files::search(&root, query)
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
    pub fn read_workspace_image(
        &self,
        project_id: &str,
        path: &str,
        version: &str,
    ) -> Result<Vec<u8>, String> {
        let root = self.catalog.workspace_root(project_id)?;
        crate::workspace_images::read(&root, path, version)
    }
    pub fn git_request(
        &self,
        project_id: &str,
        request: crate::git::GitRequest,
    ) -> Result<serde_json::Value, String> {
        let root = self.catalog.workspace_root(project_id)?;
        self.git.handle(&root, request)
    }
    pub fn git_hosting(
        &self,
        project_id: &str,
        request: crate::git::hosting::HostRequest,
    ) -> Result<serde_json::Value, String> {
        let root = self.catalog.workspace_root(project_id)?;
        self.git.handle_hosting(&root, request)
    }
    pub fn bootstrap(&self) -> Result<Bootstrap, String> {
        // The native service survives WebView reloads. Revalidate its connection
        // through the same ownership-checked connect/start path before listing.
        if self
            .broker
            .lock()
            .map_err(|_| "Broker lock unavailable")?
            .is_some()
        {
            self.background_service_status()?;
        }
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
            runtimes: self.list_runtimes()?,
        })
    }
    pub fn save_settings(self: &Arc<Self>, settings: Settings) -> Result<Settings, String> {
        // Fresh planning takes fresh -> settings. Never reverse this lock order.
        let mut fresh = self
            .fresh_launches
            .lock()
            .map_err(|_| "Fresh launch lock failed")?;
        let mut current = self
            .settings
            .lock()
            .map_err(|_| tr!("Could not lock the settings"))?;
        // Palette/font changes do not change the scan's immutable source snapshot.
        // Compare all other fields so this exception cannot silently widen to source edits.
        let mut previous = serde_json::to_value(&*current).map_err(|e| e.to_string())?;
        let mut next = serde_json::to_value(&settings).map_err(|e| e.to_string())?;
        for field in [
            "theme",
            "themePalette",
            "terminalTheme",
            "terminalAlwaysDark",
            "systemNotifications",
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
                return Err(tr!(
                    "Cancel indexing and wait for it to finish before changing source settings"
                ));
            }
            Some(self.scan_guard.try_lock().map_err(|_| {
                tr!("Cancel indexing and wait for it to finish before changing source settings")
            })?)
        };
        settings.validate()?;
        if let Some(broker) = self
            .broker
            .lock()
            .map_err(|_| "Broker lock unavailable")?
            .as_ref()
        {
            for kind in AgentKind::ALL {
                if !settings.is_agent_hooks_enabled(kind) {
                    broker.revoke_provider_hooks(kind)?;
                }
            }
        }
        self.config.save_settings(&settings)?;
        if serde_json::to_value(&*current).map_err(|e| e.to_string())?
            != serde_json::to_value(&settings).map_err(|e| e.to_string())?
        {
            fresh.invalidate_rejected();
        }
        *current = settings.clone();
        Ok(settings)
    }
    pub fn index_status(&self) -> Result<IndexStatus, String> {
        let mut status = self
            .index
            .lock()
            .map_err(|_| tr!("Could not lock the index status"))?
            .clone();
        // Also report committed changes while a scan is still running.
        status.revision = self.catalog.revision()?;
        Ok(status)
    }
    pub fn start_index(self: &Arc<Self>, rebuild: bool) -> Result<IndexStatus, String> {
        {
            let mut status = self
                .index
                .lock()
                .map_err(|_| tr!("Could not lock the index status"))?;
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
                let _guard = service
                    .scan_guard
                    .lock()
                    .map_err(|_| tr!("Could not lock the index"))?;
                if rebuild {
                    service.catalog.clear()?;
                }
                let settings = service.settings()?;
                let paused_providers: HashSet<_> = AgentKind::ALL
                    .into_iter()
                    .filter(|kind| !settings.is_agent_enabled(*kind))
                    .collect();
                let _ = service.reconcile_kanban_launches();
                let result = service.catalog.sync_with_paused_providers(
                    &settings.sources,
                    &paused_providers,
                    &service.cancel,
                    |mut progress| {
                        if let Ok(mut status) = service.index.lock() {
                            progress.revision = status.revision;
                            *status = progress;
                        }
                    },
                )?;
                let _ = service.reconcile_kanban_launches();
                Ok(result)
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
            return Err(tr!("Indexing is stopping; clear it again shortly"));
        }
        let _guard = self
            .scan_guard
            .try_lock()
            .map_err(|_| tr!("Indexing is stopping; clear it again shortly"))?;
        self.catalog.clear()?;
        let mut empty = empty_index();
        empty.revision = self.catalog.revision()?;
        *self
            .index
            .lock()
            .map_err(|_| tr!("Could not lock the index status"))? = empty;
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
    pub fn list_runtimes(&self) -> Result<Vec<RuntimeRecord>, String> {
        let records = self
            .broker
            .lock()
            .map_err(|_| "Broker lock unavailable")?
            .as_ref()
            .map(|broker| broker.list())
            .transpose()?
            .unwrap_or_default();
        self.correlate_runtime_identities(records)
    }

    fn correlate_runtime_identities(
        &self,
        mut records: Vec<RuntimeRecord>,
    ) -> Result<Vec<RuntimeRecord>, String> {
        for record in &mut records {
            if record.kind == "opencode" {
                // Raw terminal IDs never populate provider_session_id in the broker.
                // Re-check the catalog on every read, including after delayed indexing.
                record.provider_session_id = self.opencode_runtime_identity(record)?;
            }
            record.terminal_session_hint = None;
        }
        Ok(records)
    }

    fn opencode_runtime_identity(&self, record: &RuntimeRecord) -> Result<Option<String>, String> {
        if record.kind != "opencode" {
            return Ok(None);
        }
        let Some(hint) = &record.terminal_session_hint else {
            return Ok(None);
        };
        if hint.launch_started_at <= 0 || hint.ids.len() >= 64 {
            return Ok(None);
        }
        let Ok(cwd) = std::fs::canonicalize(&record.info.cwd) else {
            return Ok(None);
        };
        let mut matches = Vec::new();
        for id in &hint.ids {
            if id.len() > 32 || !crate::opencode::valid_session_id(id) {
                continue;
            }
            let candidates = self.catalog.opencode_launch_candidates(id)?;
            // IDs duplicated across sources are ambiguous even if one matches.
            let [(_, state)] = candidates.as_slice() else {
                continue;
            };
            if state
                .opencode_version
                .as_ref()
                .and_then(|version| crate::opencode_version::parse_version(version.as_bytes()))
                .is_some_and(|version| version[0] == 2)
                && state
                    .opencode_created_at
                    .is_some_and(|created| created > hint.launch_started_at)
                && state
                    .cwd
                    .as_ref()
                    .and_then(|path| std::fs::canonicalize(path).ok())
                    .as_ref()
                    == Some(&cwd)
                && !matches.contains(id)
            {
                matches.push(id.clone());
            }
        }
        Ok(if matches.len() == 1 {
            matches.pop()
        } else {
            None
        })
    }

    pub fn reconcile_kanban_launches(&self) -> Result<(), String> {
        if let Some(broker) = self
            .broker
            .lock()
            .map_err(|_| "Broker lock unavailable")?
            .as_ref()
        {
            for record in self.correlate_runtime_identities(broker.list()?)? {
                if let Some(external) = record.provider_session_id {
                    self.catalog
                        .reconcile_kanban_launch(&record.info.id, &external)?;
                }
            }
        }
        Ok(())
    }
    pub fn plan_launch(&self, request: &LaunchRequest) -> Result<LaunchSpec, String> {
        if let Some(card) = &request.kanban_card_id {
            self.catalog
                .validate_kanban_launch(card, request.project_id.as_deref())?;
        }
        if request.pane_id.is_empty()
            || request.pane_id.len() > 128
            || request.pane_id.contains('\0')
        {
            return Err(tr!("Invalid pane ID"));
        }
        if request.cols < 2 || request.cols > 1000 || request.rows < 1 || request.rows > 1000 {
            return Err(tr!("Invalid terminal size"));
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
                    .ok_or(tr!("The home folder path is not valid Unicode"))?
                    .to_owned(),
            );
        }
        if let Some(project_id) = &request.project_id {
            let project = self
                .catalog
                .projects()?
                .into_iter()
                .find(|p| &p.id == project_id)
                .ok_or(tr!("Project not found; choose it again"))?;
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
                return Err(tr!("The session's tool does not match the launch options"));
            }
            if !settings.sources.iter().any(|s| {
                s.id == source.id && s.enabled && s.root == source.root && s.kind == session.kind
            }) {
                return Err(tr!("The session's source was disabled or changed; reindex"));
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
        let cwd = cwd.ok_or(tr!("Choose a project or a working directory first; the folder of unclassified history is never guessed"))?;
        let cwd = PathBuf::from(cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(tr!(
                "The working directory does not exist or is not absolute; relocate the project"
            ));
        }
        let fallbacks = if agent.is_some() {
            config::executable_fallback_directories()
        } else {
            config::shell_fallback_directories()
        };
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
                .ok_or(tr!("Shell profile not found"))?;
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
            if let Some(path) = config::launch_path_with(
                &executable,
                std::env::var_os("PATH").as_deref(),
                &fallbacks,
            ) {
                env.insert("PATH".into(), path);
            }
        }
        if let Some(kind) = agent {
            // Preferences remain enabled on platforms without a live source, but
            // must not prevent the original CLI from launching there. No launch
            // has been sent and no retry/fallback occurs; activity stays unknown.
            if settings.is_agent_hooks_enabled(kind) && crate::provider_hooks::supported(kind) {
                env.insert(crate::provider_hooks::OPT_IN.into(), "live".into());
            }
        }
        if let Some(card) = &request.kanban_card_id {
            self.catalog.validate_kanban_launch_cwd(card, &cwd)?;
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
                self.record_kanban_resume(request)?;
                return Ok(existing);
            }
        }
        let spec = self.plan_launch(request)?;
        if spec.env.contains_key(crate::provider_hooks::OPT_IN) {
            return Err(tr!(
                "Activity hooks require launching through the persistent broker"
            ));
        }
        let result = self
            .runtime
            .launch(spec, request.cols, request.rows, emit)?;
        self.record_kanban_resume(request)?;
        Ok(result)
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
                    .ok_or(tr!("Project not found; choose it again"))?;
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
    pub fn broker(&self) -> Result<BrokerClient, String> {
        self.broker
            .lock()
            .map_err(|_| "Broker lock unavailable")?
            .clone()
            .ok_or_else(|| "Persistent runtime broker is not connected".into())
    }
    fn replace_broker(&self, slot: &mut Option<BrokerClient>) -> Result<(), String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        self.install_broker(
            slot,
            BrokerClient::connect(&self.config.directory, &executable)?,
        )
    }
    fn install_broker(
        &self,
        slot: &mut Option<BrokerClient>,
        client: BrokerClient,
    ) -> Result<(), String> {
        let owner = client.start_ui_owner()?;
        *self
            .ui_owner
            .lock()
            .map_err(|_| "UI owner lock unavailable")? = owner;
        if let Some(old) = slot.replace(client) {
            old.detach_all();
        }
        Ok(())
    }
    pub fn background_service_status(&self) -> Result<BrokerStatus, String> {
        let mut slot = self.broker.lock().map_err(|_| "Broker lock unavailable")?;
        let client = slot
            .as_ref()
            .ok_or("Persistent runtime broker is not connected")?;
        let replace = match client.running_count() {
            Ok(count) => {
                client.build_mismatch()? && count == 0 && client.retire_if_idle().unwrap_or(true)
            }
            Err(_) => true,
        };
        if replace {
            self.replace_broker(&mut slot)?;
        }
        Self::broker_status(
            slot.as_ref()
                .ok_or("Persistent runtime broker is not connected")?,
        )
    }
    fn broker_status(client: &BrokerClient) -> Result<BrokerStatus, String> {
        Ok(BrokerStatus {
            generation: client.generation(),
            build_mismatch: client.build_mismatch()?,
            running_count: client.running_count()?,
        })
    }
    /// Renderer confirmation is required, and generation fences a stale dialog.
    pub fn restart_background_service(
        &self,
        generation: &str,
        confirmed: bool,
    ) -> Result<BrokerStatus, String> {
        self.restart_background_service_with(generation, confirmed, |slot| {
            self.replace_broker(slot)
        })
    }
    fn restart_background_service_with(
        &self,
        generation: &str,
        confirmed: bool,
        replace: impl FnOnce(&mut Option<BrokerClient>) -> Result<(), String>,
    ) -> Result<BrokerStatus, String> {
        if !confirmed {
            return Err("Background service restart requires confirmation".into());
        }
        let mut slot = self.broker.lock().map_err(|_| "Broker lock unavailable")?;
        let client = slot
            .as_ref()
            .ok_or("Persistent runtime broker is not connected")?;
        if client.generation() == generation {
            client.shutdown_broker()?;
            replace(&mut slot)?;
        }
        Self::broker_status(
            slot.as_ref()
                .ok_or("Persistent runtime broker is not connected")?,
        )
    }
    /// Mint and validate a genuinely fresh identity without disturbing existing broker runtimes.
    pub fn launch_fresh(&self, request: &LaunchRequest) -> Result<RuntimeInfo, String> {
        self.launch_fresh_mode(request, false)
    }
    pub fn cancel_fresh(&self, intent: &str) -> Result<(), String> {
        self.fresh_launch_control.cancel(intent)
    }
    pub fn launch_fresh_without_hooks(
        &self,
        request: &LaunchRequest,
    ) -> Result<RuntimeInfo, String> {
        self.launch_fresh_mode(request, true)
    }
    fn launch_fresh_mode(
        &self,
        request: &LaunchRequest,
        without_hooks: bool,
    ) -> Result<RuntimeInfo, String> {
        let broker = self.broker()?;
        let mut fresh = self
            .fresh_launches
            .lock()
            .map_err(|_| "Fresh launch lock failed")?;
        let mut launch = |revision| {
            let context = format!(
                "{}:{}",
                revision,
                serde_json::to_string(&self.settings()?).map_err(|e| e.to_string())?
            );
            fresh.launch_with_context(
                request,
                &broker,
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
                    provenance.record(generation, record).map_err(|error| tr!("{{error}} (launch proof location: {{v1}}; only clean up proofs of sessions that have certainly ended, and never delete locks or attachments)", error = error, v1 = self.config.directory.join("launch-provenance-v1").display()))
                },
                &context,
                without_hooks,
            )
        };
        // Keep catalog commits outside the confirmation's admission/consume boundary.
        // Both launch paths reserve in the same fresh -> catalog -> settings order.
        let result = self.catalog.with_launch_revision(&mut launch)?;
        if let Some(card) = &request.kanban_card_id {
            self.catalog
                .record_kanban_launch(card, &result.id, &request.kind)?;
        }
        Ok(result)
    }

    /// Live Session Bay runtimes that resume or launched this Session.
    fn session_running(&self) -> Result<impl Fn(&str, &str) -> bool, String> {
        let records = self.list_runtimes()?;
        Ok(move |session_id: &str, external_id: &str| {
            records.iter().any(|record| {
                matches!(
                    record.info.state.as_str(),
                    "running" | "stopping" | "unknown"
                ) && (record.info.session_id.as_deref() == Some(session_id)
                    || record.resume_id.as_deref() == Some(external_id)
                    || (matches!(record.kind.as_str(), "claude" | "opencode")
                        && record.provider_session_id.as_deref() == Some(external_id)))
            })
        })
    }
    /// The configured OpenCode CLI, when it resolves to an executable.
    fn opencode_cli(&self) -> Result<Option<crate::os_trash::OpenCodeProcess>, String> {
        let settings = self.settings()?;
        Ok(config::resolve_executable(&settings.executables.opencode)
            .ok()
            .map(|executable| crate::os_trash::OpenCodeProcess { executable }))
    }
    pub fn prepare_os_trash(&self, trash_id: &str) -> Result<crate::os_trash::OsTrashPlan, String> {
        let running = self.session_running()?;
        let cli = self.opencode_cli()?;
        self.os_trash.prepare(
            &self.catalog,
            trash_id,
            &running,
            cli.as_ref().map(|c| c as &dyn crate::os_trash::OpenCodeCli),
        )
    }
    pub fn os_trashed(&self) -> Result<Vec<crate::os_trash::OsTrashedSession>, String> {
        crate::os_trash::list_moved(&self.catalog, &crate::os_trash::SystemTrash)
    }
    pub fn restore_os_trashed(&self, id: &str) -> Result<crate::os_trash::OsTrashResult, String> {
        let cli = self.opencode_cli()?;
        crate::os_trash::restore_moved(
            &self.catalog,
            id,
            &crate::os_trash::SystemTrash,
            cli.as_ref().map(|c| c as &dyn crate::os_trash::OpenCodeCli),
        )
    }
    pub fn execute_os_trash(
        &self,
        plan_id: &str,
    ) -> Result<crate::os_trash::OsTrashResult, String> {
        let running = self.session_running()?;
        let cli = self.opencode_cli()?;
        self.os_trash.execute(
            &self.catalog,
            plan_id,
            &running,
            &crate::os_trash::SystemTrash,
            cli.as_ref().map(|c| c as &dyn crate::os_trash::OpenCodeCli),
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
            .ok_or(tr!("The target session for the file does not exist."))?;
        if broker.generation() != generation {
            return Err(tr!(
                "The background process changed; confirm the session again."
            ));
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
                    return Err(tr!("The agent started, but its local file access proof could not be saved: {{error}}. Nothing was inserted.", error = error));
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
                let result = if existing.pane_id == request.pane_id {
                    self.broker()?.attach(&existing.id, attachment_id, emit)
                } else {
                    Ok(existing)
                }?;
                self.record_kanban_resume(request)?;
                return Ok(result);
            }
        }
        let spec = self.plan_launch(request)?;
        let result = self.broker()?.launch(spec, request, attachment_id, emit)?;
        self.record_kanban_resume(request)?;
        Ok(result)
    }
    fn record_kanban_resume(&self, request: &LaunchRequest) -> Result<(), String> {
        if let Some(id) = &request.session_id {
            if self.catalog.session(id).is_ok() {
                self.catalog.kanban_session_resumed(id)?;
            }
        } else if let (Ok(kind), Some(external)) = (
            AgentKind::parse(&request.kind),
            request.resume_id.as_deref(),
        ) {
            let settings = self.settings()?;
            let Ok(root) = manual_resume_root(&settings, kind) else {
                return Ok(());
            };
            if let Some(source) = settings
                .sources
                .iter()
                .find(|s| s.kind == kind && s.enabled && s.root == root)
            {
                self.catalog.request_kanban_resume(source, external)?;
            }
        }
        Ok(())
    }

    pub fn is_shutdown(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    pub fn shutdown(&self) -> Result<(), String> {
        self.cancel.store(true, Ordering::Release);
        if let Some(broker) = self
            .broker
            .lock()
            .map_err(|_| "Broker lock unavailable")?
            .as_ref()
        {
            broker.detach_all();
        }
        self.runtime.shutdown()?;
        // Native owner survives renderer reload; close only after local shutdown succeeds.
        self.ui_owner
            .lock()
            .map_err(|_| "UI owner lock unavailable")?
            .take();
        self.closed.store(true, Ordering::Release);
        Ok(())
    }
}

fn temporary_terminal_home(home: Option<PathBuf>) -> Result<PathBuf, String> {
    let home = home.ok_or(tr!(
        "Cannot find your home folder; check your system user settings"
    ))?;
    if !home.is_absolute() || !home.is_dir() {
        return Err(tr!(
            "Your home folder does not exist or is not an absolute path"
        ));
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
    #[cfg(unix)]
    #[test]
    fn native_service_close_preserves_broker_idle_prompt_and_original_identity() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        ConfigStore::open(app.clone()).unwrap();
        let broker_dir = app.clone();
        let host = std::thread::spawn(move || crate::broker::run(broker_dir));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let client = loop {
            if let Ok(client) = BrokerClient::existing_for_test(&app) {
                break client;
            }
            assert!(!host.is_finished());
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        };
        let owner = client.start_ui_owner().unwrap().unwrap();
        let service = Service::open_internal(app, Some(client.clone()), Vec::new()).unwrap();
        *service.ui_owner.lock().unwrap() = Some(owner);
        let request = LaunchRequest {
            kanban_card_id: None,
            pane_id: "native-owner-prompt".into(),
            kind: "shell".into(),
            project_id: Some("synthetic-project".into()),
            session_id: None,
            resume_id: None,
            cwd: Some(temp.path().to_string_lossy().into_owned()),
            profile_id: None,
            cols: 80,
            rows: 24,
        };
        let info = client
            .launch_unattached(
                LaunchSpec {
                    executable: "/bin/sh".into(),
                    args: vec![
                        "-c".into(),
                        "read value; test \"$value\" = after-close".into(),
                    ],
                    cwd: temp.path().into(),
                    env: std::collections::HashMap::from([(
                        "HOME".into(),
                        temp.path().to_string_lossy().into_owned(),
                    )]),
                    session_id: None,
                    resume_key: None,
                    pane_id: request.pane_id.clone(),
                },
                &request,
            )
            .unwrap();
        service.shutdown().unwrap();
        drop(service);
        let records = client.list().unwrap();
        assert_eq!(records[0].info.id, info.id);
        assert_eq!(records[0].info.state, "running");
        client.write(&info.id, "after-close\n").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if client.list().unwrap()[0].info.state == "exited" {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(client.list().unwrap()[0].info.exit_code, Some(0));
        client.shutdown_broker().unwrap();
        host.join().unwrap().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn terminal_file_resolution_binds_real_broker_identity_and_project_read_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        let root = temp.path().join("workspace");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/file.ts"), "synthetic source").unwrap();
        let root = root.canonicalize().unwrap();
        ConfigStore::open(app.clone()).unwrap();
        let broker_dir = app.clone();
        let host = std::thread::spawn(move || crate::broker::run(broker_dir));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let client = loop {
            if let Ok(client) = BrokerClient::existing_for_test(&app) {
                break client;
            }
            assert!(!host.is_finished());
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        };
        let service = Service::open_internal(app, Some(client.clone()), Vec::new()).unwrap();
        let project = service
            .catalog
            .add_project(root.to_str().unwrap(), Some("Synthetic project"))
            .unwrap();
        let request = LaunchRequest {
            kanban_card_id: None,
            pane_id: "source-pane".into(),
            kind: "shell".into(),
            project_id: Some(project.id.clone()),
            session_id: None,
            resume_id: None,
            cwd: Some(root.join("src").to_string_lossy().into_owned()),
            profile_id: None,
            cols: 80,
            rows: 24,
        };
        let info = client
            .launch_unattached(
                LaunchSpec {
                    executable: "/bin/sh".into(),
                    args: vec!["-c".into(), "read value".into()],
                    cwd: root.join("src"),
                    env: std::collections::HashMap::from([(
                        "HOME".into(),
                        root.to_string_lossy().into_owned(),
                    )]),
                    session_id: None,
                    resume_key: None,
                    pane_id: request.pane_id.clone(),
                },
                &request,
            )
            .unwrap();
        let relative = service
            .resolve_terminal_file(&project.id, &request.pane_id, &info.id, "file.ts")
            .unwrap();
        assert!(!relative.absolute);
        assert_eq!(relative.candidates[0].path, "src/file.ts");
        assert!(relative.candidates[0].from_launch_directory);
        let absolute = service
            .resolve_terminal_file(
                &project.id,
                &request.pane_id,
                &info.id,
                root.join("src/file.ts").to_str().unwrap(),
            )
            .unwrap();
        assert!(absolute.absolute);
        assert_eq!(
            absolute.candidates[0].version,
            service
                .inspect_workspace_file(&project.id, "src/file.ts")
                .unwrap()
                .version
        );
        assert!(service
            .resolve_terminal_file(&project.id, "other-pane", &info.id, "file.ts")
            .is_err());
        assert!(service
            .resolve_terminal_file("other-project", &request.pane_id, &info.id, "file.ts")
            .is_err());
        assert!(service
            .resolve_terminal_file(
                &project.id,
                &request.pane_id,
                &info.id,
                temp.path().join("outside.txt").to_str().unwrap()
            )
            .is_err());
        assert_eq!(client.list().unwrap()[0].info.state, "running");
        service.shutdown().unwrap();
        client.shutdown_broker().unwrap();
        host.join().unwrap().unwrap();
    }

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
        let service = Service::open_internal(app, Some(client.clone()), Vec::new()).unwrap();
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
        // This fixture tests reattachment, not provider hooks; the synthetic CLI
        // intentionally implements only a long-running process, not --version.
        for kind in [AgentKind::Codex, AgentKind::Grok] {
            settings.agent_hooks.insert(kind.as_str().into(), false);
        }
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
            kanban_card_id: None,
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
        assert!(bootstrap.warnings[0]
            .contains("The layout was reset to defaults; the original file is kept"));
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

#[cfg(test)]
mod terminal_identity_tests {
    use super::*;
    use crate::{broker::TerminalSessionHint, models::HistorySource};
    use rusqlite::{params, Connection};

    #[test]
    fn opencode_identity_requires_catalog_version_directory_and_creation_after_launch() {
        std::env::set_var(
            crate::opencode::MIRROR_DIR_ENV,
            std::env::temp_dir().join("sessionbay-test-opencode-mirror"),
        );
        let root = tempfile::tempdir().unwrap();
        let source_root = root.path().join("history");
        std::fs::create_dir(&source_root).unwrap();
        let service = Service::open(root.path().join("app")).unwrap();
        let source = HistorySource {
            id: "synthetic-source".into(),
            kind: AgentKind::OpenCode,
            root: source_root.to_string_lossy().into_owned(),
            enabled: true,
        };
        let db = Connection::open(source_root.join("opencode.db")).unwrap();
        db.execute_batch(include_str!("../../fixtures/opencode/schema.sql"))
            .unwrap();
        let cwd = root
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let started = 1_790_000_000_000_i64;
        let mut record = RuntimeRecord {
            provider_session_id: None,
            terminal_session_hint: Some(TerminalSessionHint {
                launch_started_at: started,
                ids: vec!["ses_identity".into()],
            }),
            info: RuntimeInfo {
                id: "runtime".into(),
                pane_id: "pane".into(),
                session_id: None,
                state: "running".into(),
                cwd: cwd.clone(),
                exit_code: None,
            },
            kind: "opencode".into(),
            project_id: None,
            profile_id: None,
            resume_id: None,
            home_directory: Some(false),
            image_input: false,
            file_input: Some(false),
        };
        let sync = || {
            let status = service
                .catalog
                .sync(
                    std::slice::from_ref(&source),
                    &AtomicBool::new(false),
                    |_| {},
                )
                .unwrap();
            assert!(status.errors.is_empty(), "{:?}", status.errors);
        };
        assert!(service
            .opencode_runtime_identity(&record)
            .unwrap()
            .is_none());
        for (version, directory, created, accepted) in [
            ("2.2.3", cwd.as_str(), started + 1, true),
            ("2.2.3", cwd.as_str(), started, false),
            ("2.2.3", cwd.as_str(), started - 1, false),
            ("1.19.5", cwd.as_str(), started + 1, false),
            ("3.0.0", cwd.as_str(), started + 1, false),
            ("2.2.3-beta", cwd.as_str(), started + 1, false),
            ("2.2.3", source_root.to_str().unwrap(), started + 1, false),
        ] {
            db.execute("INSERT OR REPLACE INTO session_v2 VALUES('ses_identity','global',?1,'Synthetic','2.2.3',?2,?2,NULL,NULL,NULL)", params![directory, created]).unwrap();
            db.execute("UPDATE session_v2 SET version=?1", [version])
                .unwrap();
            sync();
            assert_eq!(
                service
                    .opencode_runtime_identity(&record)
                    .unwrap()
                    .as_deref(),
                accepted.then_some("ses_identity"),
                "{version} {directory} {created}"
            );
        }
        db.execute("UPDATE session_v2 SET directory=?1,version='2.2.3'", [&cwd])
            .unwrap();
        sync();
        let correlated = service
            .correlate_runtime_identities(vec![record.clone()])
            .unwrap()
            .remove(0);
        assert_eq!(
            correlated.provider_session_id.as_deref(),
            Some("ses_identity")
        );
        assert!(correlated.terminal_session_hint.is_none());
        assert!(record.provider_session_id.is_none());
        // Multiple matching pending sessions cannot identify the launched root.
        db.execute("INSERT INTO session_v2 SELECT 'ses_other',project_id,directory,title,version,time_created,time_updated,parent_id,time_archived,revert FROM session_v2", []).unwrap();
        sync();
        record
            .terminal_session_hint
            .as_mut()
            .unwrap()
            .ids
            .push("ses_other".into());
        assert!(service
            .opencode_runtime_identity(&record)
            .unwrap()
            .is_none());
        record.terminal_session_hint.as_mut().unwrap().ids = vec!["ses_absent".into()];
        assert!(service
            .opencode_runtime_identity(&record)
            .unwrap()
            .is_none());
        record.terminal_session_hint.as_mut().unwrap().ids = vec!["ses_identity".into()];
        let mut duplicate_source = source.clone();
        duplicate_source.id = "duplicate-source".into();
        let status = service
            .catalog
            .sync(
                &[source.clone(), duplicate_source],
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        assert!(service
            .opencode_runtime_identity(&record)
            .unwrap()
            .is_none());
        sync();
        // Saturated hints fail closed rather than selecting an arbitrary record.
        record.terminal_session_hint.as_mut().unwrap().ids = vec!["ses_identity".into(); 64];
        assert!(service
            .opencode_runtime_identity(&record)
            .unwrap()
            .is_none());
        record.terminal_session_hint = None;
        assert!(service
            .opencode_runtime_identity(&record)
            .unwrap()
            .is_none());
    }
}

#[cfg(all(test, unix))]
mod broker_replacement_tests {
    use super::*;
    use std::{thread, time::Instant};

    fn start(parent: &std::path::Path) -> (BrokerClient, thread::JoinHandle<()>) {
        let root = parent.to_path_buf();
        let worker = thread::spawn(move || crate::broker::run(root).unwrap());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(client) = BrokerClient::existing_for_test(parent) {
                return (client, worker);
            }
            assert!(Instant::now() < deadline, "synthetic broker did not start");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn restart_requires_confirmation_fences_stale_dialog_and_replaces_after_confirmation() {
        for running in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (client, old) = start(root.path());
            let generation = client.generation();
            if running {
                let request = LaunchRequest {
                    kanban_card_id: None,
                    pane_id: "synthetic-confirmation".into(),
                    kind: "shell".into(),
                    project_id: None,
                    session_id: None,
                    resume_id: None,
                    cwd: Some(root.path().to_string_lossy().into_owned()),
                    profile_id: None,
                    cols: 80,
                    rows: 24,
                };
                client
                    .launch_unattached(
                        LaunchSpec {
                            executable: "/bin/sh".into(),
                            args: vec!["-c".into(), "read value".into()],
                            cwd: root.path().into(),
                            env: HashMap::new(),
                            session_id: None,
                            resume_key: None,
                            pane_id: request.pane_id.clone(),
                        },
                        &request,
                    )
                    .unwrap();
            }
            let service = Service::open_internal(root.path().into(), Some(client), vec![]).unwrap();
            assert!(service
                .restart_background_service_with(&generation, false, |_| panic!(
                    "unconfirmed restart"
                ))
                .is_err());
            assert_eq!(service.broker().unwrap().generation(), generation);
            let status = service
                .restart_background_service_with("stale-dialog", true, |_| panic!("stale restart"))
                .unwrap();
            assert_eq!(status.generation, generation);
            assert_eq!(status.running_count, usize::from(running));
            let mut replacement = None;
            let status = service
                .restart_background_service_with(&generation, true, |slot| {
                    old.join().unwrap();
                    let (client, worker) = start(root.path());
                    replacement = Some(worker);
                    service.install_broker(slot, client)
                })
                .unwrap();
            assert_ne!(status.generation, generation);
            assert_eq!(status.running_count, 0);
            service.broker().unwrap().shutdown_broker().unwrap();
            replacement.unwrap().join().unwrap();
        }
    }

    #[test]
    fn window_reload_bootstrap_reconnects_a_native_service_with_a_dead_client() {
        let root = tempfile::tempdir().unwrap();
        let (dead, old) = start(root.path());
        let service =
            Service::open_internal(root.path().into(), Some(dead.clone()), vec![]).unwrap();
        dead.shutdown_broker().unwrap();
        old.join().unwrap();
        assert!(dead.list().is_err());
        let (replacement, worker) = start(root.path());
        assert!(service.bootstrap().is_ok());
        assert_eq!(
            service.broker().unwrap().generation(),
            replacement.generation()
        );
        replacement.shutdown_broker().unwrap();
        worker.join().unwrap();
    }
}
