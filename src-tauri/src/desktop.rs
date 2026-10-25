use crate::{
    broker::{RuntimeRecord, UiEvent},
    config::{self, Installation, Settings},
    history_sources::{self, HistorySourceDiscovery},
    models::{
        AgentKind, IndexStatus, Project, SessionPage, SessionQuery, TranscriptPage, TrashPage,
        WorkspaceFileChunk, WorkspaceFileInfo, WorkspaceFilePage, WorkspaceFilePreview,
        WorkspaceFileSearch,
    },
    runtime::RuntimeInfo,
    service::{Bootstrap, LaunchPreview, LaunchRequest, Service},
    shells::{self, ShellCandidate},
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::{ipc::Channel, Emitter, Manager, State};

type AppState<'a> = State<'a, Arc<Service>>;

// Opt-in smoke diagnostics only. No file paths, file writes, or remote transport.
// Keep the command bounded even if a malfunctioning WebView repeatedly reports errors.
static FRONTEND_DIAGNOSTICS: AtomicUsize = AtomicUsize::new(0);

fn diagnostic_line(phase: &str, message: &str) -> Result<String, String> {
    if !matches!(
        phase,
        "observer" | "module-loaded" | "mounted" | "ready" | "interaction" | "error" | "snapshot"
    ) {
        return Err("Unknown frontend diagnostic phase".into());
    }
    if phase == "snapshot"
        && !matches!(
            message,
            "projects-dark"
                | "directories-dark"
                | "providers-dark"
                | "launcher-dark"
                | "calendar-dark"
                | "projects-light"
                | "directories-light"
                | "providers-light"
                | "launcher-light"
                | "calendar-light"
        )
    {
        return Err("Unknown frontend snapshot identifier".into());
    }
    let message: String = message.chars().take(2048).collect();
    Ok(format!(
        "SESSIONBAY_FRONTEND {}",
        serde_json::json!({ "phase": phase, "message": message })
    ))
}

#[tauri::command]
fn frontend_diagnostic(phase: String, message: String) -> Result<bool, String> {
    if std::env::var("SESSIONBAY_SMOKE").as_deref() != Ok("1")
        || std::env::var("SESSIONBAY_SMOKE_MANUAL").as_deref() == Ok("1")
    {
        // Keep the validated, empty-source test data directory while a person
        // verifies real providers. Never run automated smoke clicks over them.
        return Ok(false);
    }
    // This probe uses only synthetic editor models and explicitly seeded file
    // fixtures; it never opens real user projects or history.
    // Synthetic repository seeded by the smoke runner; never a user repository.
    if phase == "git-probe" {
        return Ok(std::env::var("SESSIONBAY_SMOKE_GIT").as_deref() == Ok("1"));
    }
    if phase == "monaco-probe" {
        return Ok(std::env::var("SESSIONBAY_SMOKE_MONACO").as_deref() == Ok("1"));
    }
    if phase == "terminal-probe" || phase == "files-probe" {
        let flag = if phase == "files-probe" {
            "SESSIONBAY_SMOKE_FILES"
        } else {
            "SESSIONBAY_SMOKE_TERMINAL"
        };
        return Ok(std::env::var(flag).as_deref() == Ok("1")
            && smoke_data_directory().map_err(|e| e.to_string())?.is_some());
    }
    let line = diagnostic_line(&phase, &message)?;
    if FRONTEND_DIAGNOSTICS.fetch_add(1, Ordering::Relaxed) < 32 {
        eprintln!("{line}");
    }
    Ok(true)
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("背景工作失敗：{e}"))?
}

#[tauri::command]
async fn bootstrap(state: AppState<'_>) -> Result<Bootstrap, String> {
    let s = state.inner().clone();
    blocking(move || s.bootstrap()).await
}
#[tauri::command]
async fn detect_installations(state: AppState<'_>) -> Result<Vec<Installation>, String> {
    let s = state.inner().clone();
    blocking(move || Ok(config::detect(&s.settings()?))).await
}
#[tauri::command]
async fn detect_history_sources(
    state: AppState<'_>,
    kind: AgentKind,
) -> Result<HistorySourceDiscovery, String> {
    let s = state.inner().clone();
    blocking(move || {
        Ok(history_sources::detect_history_sources(
            kind,
            &s.settings()?.sources,
        ))
    })
    .await
}
#[tauri::command]
async fn detect_shells(state: AppState<'_>) -> Result<Vec<ShellCandidate>, String> {
    let s = state.inner().clone();
    blocking(move || {
        let saved_executables = s
            .settings()?
            .profiles
            .into_iter()
            .map(|profile| profile.executable)
            .collect::<Vec<_>>();
        Ok(shells::detect_shells(&saved_executables))
    })
    .await
}
#[tauri::command]
async fn save_settings(state: AppState<'_>, settings: Settings) -> Result<Settings, String> {
    let s = state.inner().clone();
    blocking(move || s.save_settings(settings)).await
}
#[tauri::command]
async fn list_projects(state: AppState<'_>) -> Result<Vec<Project>, String> {
    let s = state.inner().clone();
    blocking(move || s.catalog.projects()).await
}
#[tauri::command]
async fn resolve_terminal_file(
    state: AppState<'_>,
    project_id: String,
    pane_id: String,
    runtime_id: String,
    path: String,
) -> Result<crate::models::TerminalFileResolution, String> {
    let s = state.inner().clone();
    blocking(move || s.resolve_terminal_file(&project_id, &pane_id, &runtime_id, &path)).await
}
#[tauri::command]
async fn list_workspace_files(
    state: AppState<'_>,
    project_id: String,
    path: String,
    offset: Option<usize>,
    show_hidden: Option<bool>,
) -> Result<WorkspaceFilePage, String> {
    let s = state.inner().clone();
    blocking(move || {
        s.list_workspace_files(
            &project_id,
            &path,
            offset.unwrap_or(0),
            show_hidden.unwrap_or(false),
        )
    })
    .await
}
#[tauri::command]
async fn search_workspace_files(
    state: AppState<'_>,
    project_id: String,
    query: String,
) -> Result<WorkspaceFileSearch, String> {
    let s = state.inner().clone();
    blocking(move || s.search_workspace_files(&project_id, &query)).await
}
#[tauri::command]
async fn read_workspace_file(
    state: AppState<'_>,
    project_id: String,
    path: String,
) -> Result<WorkspaceFilePreview, String> {
    let s = state.inner().clone();
    blocking(move || s.read_workspace_file(&project_id, &path)).await
}
#[tauri::command]
async fn inspect_workspace_file(
    state: AppState<'_>,
    project_id: String,
    path: String,
) -> Result<WorkspaceFileInfo, String> {
    let s = state.inner().clone();
    blocking(move || s.inspect_workspace_file(&project_id, &path)).await
}
#[tauri::command]
async fn read_workspace_file_chunk(
    state: AppState<'_>,
    project_id: String,
    path: String,
    version: String,
    offset: u64,
    max_bytes: usize,
) -> Result<WorkspaceFileChunk, String> {
    let s = state.inner().clone();
    blocking(move || s.read_workspace_file_chunk(&project_id, &path, &version, offset, max_bytes))
        .await
}
#[tauri::command]
async fn read_workspace_image(
    state: AppState<'_>,
    project_id: String,
    path: String,
    version: String,
) -> Result<tauri::ipc::Response, String> {
    let s = state.inner().clone();
    blocking(move || s.read_workspace_image(&project_id, &path, &version))
        .await
        .map(tauri::ipc::Response::new)
}
#[tauri::command]
async fn git_request(
    state: AppState<'_>,
    project_id: String,
    request: crate::git::GitRequest,
) -> Result<serde_json::Value, String> {
    let s = state.inner().clone();
    blocking(move || s.git_request(&project_id, request)).await
}
#[tauri::command]
async fn git_hosting(
    state: AppState<'_>,
    project_id: String,
    request: crate::git::hosting::HostRequest,
) -> Result<serde_json::Value, String> {
    let s = state.inner().clone();
    blocking(move || s.git_hosting(&project_id, request)).await
}
#[tauri::command]
async fn add_project(
    state: AppState<'_>,
    path: String,
    name: Option<String>,
) -> Result<Project, String> {
    let s = state.inner().clone();
    blocking(move || s.catalog.add_project(&path, name.as_deref())).await
}
#[tauri::command]
async fn create_project(
    state: AppState<'_>,
    parent_path: String,
    name: String,
) -> Result<Project, String> {
    let s = state.inner().clone();
    blocking(move || s.catalog.create_project(&parent_path, &name)).await
}
#[tauri::command]
async fn update_project(
    state: AppState<'_>,
    project_id: String,
    pinned: Option<bool>,
    launch_path: Option<String>,
    curated: Option<bool>,
    name: Option<String>,
) -> Result<Project, String> {
    let s = state.inner().clone();
    blocking(move || {
        s.catalog.update_project(
            &project_id,
            pinned,
            launch_path.as_deref(),
            curated,
            name.as_deref(),
        )
    })
    .await
}
#[tauri::command]
async fn query_sessions(state: AppState<'_>, query: SessionQuery) -> Result<SessionPage, String> {
    let s = state.inner().clone();
    blocking(move || s.catalog.query(&query)).await
}
#[tauri::command]
async fn trash_session(
    state: AppState<'_>,
    session_id: String,
    expected_identity: String,
) -> Result<String, String> {
    let s = state.inner().clone();
    blocking(move || s.catalog.trash_session(&session_id, &expected_identity)).await
}
#[tauri::command]
async fn prepare_session_os_trash(
    state: AppState<'_>,
    trash_id: String,
) -> Result<crate::os_trash::OsTrashPlan, String> {
    let s = state.inner().clone();
    blocking(move || s.prepare_os_trash(&trash_id)).await
}
#[tauri::command]
async fn execute_session_os_trash(
    state: AppState<'_>,
    plan_id: String,
) -> Result<crate::os_trash::OsTrashResult, String> {
    let s = state.inner().clone();
    blocking(move || s.execute_os_trash(&plan_id)).await
}
#[tauri::command]
async fn list_os_trashed_sessions(
    state: AppState<'_>,
) -> Result<Vec<crate::os_trash::OsTrashedSession>, String> {
    let s = state.inner().clone();
    blocking(move || s.os_trashed()).await
}
#[tauri::command]
async fn restore_os_trashed_session(
    state: AppState<'_>,
    id: String,
) -> Result<crate::os_trash::OsTrashResult, String> {
    let s = state.inner().clone();
    blocking(move || s.restore_os_trashed(&id)).await
}
#[tauri::command]
async fn forget_os_trashed_session(state: AppState<'_>, id: String) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.catalog.forget_os_trash(&id)).await
}
#[tauri::command]
async fn restore_session(state: AppState<'_>, session_id: String) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.catalog.restore_session(&session_id)).await
}
#[tauri::command]
async fn list_trashed_sessions(
    state: AppState<'_>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<TrashPage, String> {
    let s = state.inner().clone();
    blocking(move || {
        s.catalog
            .trashed_sessions(offset.unwrap_or(0), limit.unwrap_or(40))
    })
    .await
}
#[tauri::command]
async fn read_transcript(
    state: AppState<'_>,
    session_id: String,
    before_line: Option<u64>,
    limit: Option<usize>,
) -> Result<TranscriptPage, String> {
    let s = state.inner().clone();
    blocking(move || {
        s.catalog
            .transcript(&session_id, before_line, limit.unwrap_or(40).clamp(1, 200))
    })
    .await
}
#[tauri::command]
fn start_index(state: AppState<'_>, rebuild: bool) -> Result<IndexStatus, String> {
    state.inner().start_index(rebuild)
}
#[tauri::command]
fn index_status(state: AppState<'_>) -> Result<IndexStatus, String> {
    state.index_status()
}
#[tauri::command]
fn cancel_index(state: AppState<'_>) {
    state.cancel_index();
}
#[tauri::command]
async fn clear_index(state: AppState<'_>) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.clear_index()).await
}
#[tauri::command]
async fn save_workspace(state: AppState<'_>, workspace: serde_json::Value) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.config.save_workspace(&workspace)).await
}
#[tauri::command]
async fn preview_launch(
    state: AppState<'_>,
    request: LaunchRequest,
) -> Result<LaunchPreview, String> {
    let s = state.inner().clone();
    blocking(move || s.preview_launch(&request)).await
}
#[tauri::command]
async fn launch_runtime(
    state: AppState<'_>,
    request: LaunchRequest,
    on_event: Channel<UiEvent>,
    attachment_id: String,
) -> Result<RuntimeInfo, String> {
    let s = state.inner().clone();
    blocking(move || {
        s.launch_persistent(
            &request,
            attachment_id,
            Arc::new(move |event| on_event.send(event).map_err(|e| e.to_string())),
        )
    })
    .await
}
#[tauri::command]
async fn launch_fresh_runtime(
    state: AppState<'_>,
    request: LaunchRequest,
) -> Result<RuntimeInfo, String> {
    let s = state.inner().clone();
    blocking(move || s.launch_fresh(&request)).await
}
#[tauri::command]
async fn launch_fresh_without_hooks(
    state: AppState<'_>,
    request: LaunchRequest,
) -> Result<RuntimeInfo, String> {
    let s = state.inner().clone();
    blocking(move || s.launch_fresh_without_hooks(&request)).await
}
#[tauri::command]
async fn cancel_fresh_launch(state: AppState<'_>, intent: String) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.cancel_fresh(&intent)).await
}
// The broker is authoritative for runtime identity. A pane label alone is insufficient.
fn image_runtime(s: &Service, runtime_id: &str) -> Result<(), String> {
    s.check_file_runtime(runtime_id)
}
fn with_images<T>(
    s: &Service,
    f: impl FnOnce(&mut crate::image_input::ImageStaging) -> Result<T, String>,
) -> Result<T, String> {
    let mut store = s.image_staging.lock().map_err(|_| "圖片暫存鎖定失敗。")?;
    if store.is_none() {
        *store = Some(crate::image_input::ImageStaging::open(&s.config.directory)?);
    }
    f(store.as_mut().ok_or("圖片暫存未就緒。")?)
}
#[tauri::command]
async fn begin_image_input(
    state: AppState<'_>,
    runtime_id: String,
    mime: String,
    size: usize,
) -> Result<String, String> {
    let s = state.inner().clone();
    blocking(move || {
        image_runtime(&s, &runtime_id)?;
        with_images(&s, |store| store.begin(&runtime_id, &mime, size))
    })
    .await
}
#[tauri::command]
async fn append_image_input(
    state: AppState<'_>,
    runtime_id: String,
    id: String,
    offset: usize,
    bytes: crate::image_input::ImageChunk,
) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || with_images(&s, |store| store.append(&runtime_id, &id, offset, &bytes.0)))
        .await
}
#[tauri::command]
async fn finish_image_input(
    state: AppState<'_>,
    runtime_id: String,
    id: String,
) -> Result<crate::image_input::StagedImage, String> {
    let s = state.inner().clone();
    blocking(move || with_images(&s, |store| store.finish(&runtime_id, &id))).await
}
#[tauri::command]
async fn retain_image_input(
    state: AppState<'_>,
    runtime_id: String,
    id: String,
) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || {
        image_runtime(&s, &runtime_id)?;
        with_images(&s, |store| store.retain(&runtime_id, &id))
    })
    .await
}
#[tauri::command]
async fn discard_image_input(
    state: AppState<'_>,
    runtime_id: String,
    id: String,
) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || with_images(&s, |store| store.discard(&runtime_id, &id))).await
}
fn file_runtime(s: &Service, runtime_id: &str) -> Result<(), String> {
    s.check_file_runtime(runtime_id)
}
fn with_files<T>(
    s: &Service,
    f: impl FnOnce(&mut crate::file_input::FileStaging) -> Result<T, String>,
) -> Result<T, String> {
    let mut store = s.file_staging.lock().map_err(|_| "檔案暫存鎖定失敗。")?;
    if store.is_none() {
        *store = Some(crate::file_input::FileStaging::open(&s.config.directory)?);
    }
    f(store.as_mut().ok_or("檔案暫存未就緒。")?)
}
#[tauri::command]
async fn begin_file_input(
    state: AppState<'_>,
    runtime_id: String,
    name: String,
    size: usize,
) -> Result<String, String> {
    let s = state.inner().clone();
    blocking(move || {
        file_runtime(&s, &runtime_id)?;
        with_files(&s, |store| store.begin(&runtime_id, &name, size))
    })
    .await
}
#[tauri::command]
async fn append_file_input(
    state: AppState<'_>,
    runtime_id: String,
    id: String,
    offset: usize,
    bytes: crate::file_input::FileChunk,
) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || with_files(&s, |store| store.append(&runtime_id, &id, offset, &bytes.0))).await
}
#[tauri::command]
async fn finish_file_input(
    state: AppState<'_>,
    runtime_id: String,
    id: String,
) -> Result<crate::file_input::StagedFile, String> {
    let s = state.inner().clone();
    blocking(move || with_files(&s, |store| store.finish(&runtime_id, &id))).await
}
#[tauri::command]
async fn retain_file_input(
    state: AppState<'_>,
    runtime_id: String,
    id: String,
) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || {
        file_runtime(&s, &runtime_id)?;
        with_files(&s, |store| store.retain(&runtime_id, &id))
    })
    .await
}
#[tauri::command]
async fn discard_file_input(
    state: AppState<'_>,
    runtime_id: String,
    id: String,
) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || with_files(&s, |store| store.discard(&runtime_id, &id))).await
}
#[tauri::command]
async fn write_runtime(
    state: AppState<'_>,
    runtime_id: String,
    data: String,
) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.broker()?.write(&runtime_id, &data)).await
}
#[tauri::command]
async fn resize_runtime(
    state: AppState<'_>,
    runtime_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.broker()?.resize(&runtime_id, cols, rows)).await
}
#[tauri::command]
fn ack_runtime(
    state: AppState<'_>,
    runtime_id: String,
    sequence: u64,
    attachment_id: String,
) -> Result<(), String> {
    state.broker()?.ack(&runtime_id, sequence, &attachment_id)
}
#[tauri::command]
async fn stop_runtime(state: AppState<'_>, runtime_id: String) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.broker()?.stop(&runtime_id)).await
}
#[tauri::command]
async fn list_runtimes(state: AppState<'_>) -> Result<Vec<RuntimeRecord>, String> {
    let s = state.inner().clone();
    blocking(move || s.broker()?.list()).await
}
#[tauri::command]
async fn attach_runtime(
    state: AppState<'_>,
    runtime_id: String,
    attachment_id: String,
    on_event: Channel<UiEvent>,
) -> Result<RuntimeInfo, String> {
    let s = state.inner().clone();
    blocking(move || {
        s.broker()?.attach(
            &runtime_id,
            attachment_id,
            Arc::new(move |event| on_event.send(event).map_err(|e| e.to_string())),
        )
    })
    .await
}
#[tauri::command]
fn detach_runtime(
    state: AppState<'_>,
    runtime_id: String,
    attachment_id: String,
) -> Result<(), String> {
    state.broker()?.detach(&runtime_id, &attachment_id);
    Ok(())
}
#[tauri::command]
async fn forget_runtime(state: AppState<'_>, runtime_id: String) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.broker()?.forget(&runtime_id)).await
}
#[tauri::command]
async fn close_application(app: tauri::AppHandle, state: AppState<'_>) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.shutdown()).await?;
    app.exit(0);
    Ok(())
}

// A native CloseWindow item consumes Cmd+W before the webview sees keydown.
// Keep the standard application/edit/window actions, but route Cmd+W to the UI.
#[cfg(target_os = "macos")]
fn workspace_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem as Item, Submenu};
    let package = app.package_info();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app
            .config()
            .bundle
            .publisher
            .clone()
            .map(|value| vec![value]),
        ..Default::default()
    };
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                &package.name,
                true,
                &[
                    &Item::about(app, None, Some(about))?,
                    &Item::separator(app)?,
                    &Item::services(app, None)?,
                    &Item::separator(app)?,
                    &Item::hide(app, None)?,
                    &Item::hide_others(app, None)?,
                    &Item::separator(app)?,
                    &Item::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&MenuItem::with_id(
                    app,
                    "workspace-close-tab",
                    "Close Tab",
                    true,
                    Some("Cmd+W"),
                )?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &Item::undo(app, None)?,
                    &Item::redo(app, None)?,
                    &Item::separator(app)?,
                    &Item::cut(app, None)?,
                    &Item::copy(app, None)?,
                    &Item::paste(app, None)?,
                    &Item::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "View", true, &[&Item::fullscreen(app, None)?])?,
            &Submenu::with_id_and_items(
                app,
                tauri::menu::WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[&Item::minimize(app, None)?, &Item::maximize(app, None)?],
            )?,
            &Submenu::with_id_and_items(app, tauri::menu::HELP_SUBMENU_ID, "Help", true, &[])?,
        ],
    )
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_menu(workspace_menu(app.handle())?)?;
            let directory = smoke_data_directory()?.unwrap_or(app.path().app_data_dir()?);
            let service = Service::open_desktop(directory).map_err(std::io::Error::other)?;
            app.manage(service.clone());
            service.begin_reconcile();
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "workspace-close-tab" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("workspace-close-tab-requested", ());
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Native events can arrive before the Ready/setup callback.
                let Some(state) = window.try_state::<Arc<Service>>() else {
                    return;
                };
                if !state.is_shutdown() {
                    api.prevent_close();
                    let _ = window.emit("app-close-requested", ());
                } else if let Err(error) = state.shutdown() {
                    api.prevent_close();
                    let _ = window.emit("app-close-error", error);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            frontend_diagnostic,
            bootstrap,
            detect_installations,
            detect_history_sources,
            detect_shells,
            save_settings,
            list_projects,
            list_workspace_files,
            resolve_terminal_file,
            search_workspace_files,
            read_workspace_file,
            inspect_workspace_file,
            read_workspace_file_chunk,
            read_workspace_image,
            git_request,
            git_hosting,
            add_project,
            create_project,
            update_project,
            query_sessions,
            trash_session,
            restore_session,
            prepare_session_os_trash,
            list_os_trashed_sessions,
            restore_os_trashed_session,
            forget_os_trashed_session,
            execute_session_os_trash,
            list_trashed_sessions,
            read_transcript,
            start_index,
            index_status,
            cancel_index,
            clear_index,
            save_workspace,
            preview_launch,
            launch_runtime,
            launch_fresh_runtime,
            launch_fresh_without_hooks,
            cancel_fresh_launch,
            attach_runtime,
            detach_runtime,
            forget_runtime,
            write_runtime,
            begin_file_input,
            append_file_input,
            finish_file_input,
            retain_file_input,
            discard_file_input,
            begin_image_input,
            append_image_input,
            finish_image_input,
            retain_image_input,
            discard_image_input,
            resize_runtime,
            ack_runtime,
            stop_runtime,
            list_runtimes,
            close_application
        ])
        .build(tauri::generate_context!())
        .expect("無法啟動 Session Bay");
    app.run(|app, event| {
        let Some(state) = service_for_event(&event, || {
            app.try_state::<Arc<Service>>()
                .map(|state| state.inner().clone())
        }) else {
            return;
        };
        match event {
            tauri::RunEvent::ExitRequested { api, .. } if !state.is_shutdown() => {
                api.prevent_exit();
                let _ = app.emit_to("main", "app-close-requested", ());
            }
            tauri::RunEvent::Exit => {
                let _ = state.shutdown();
            }
            _ => {}
        }
    });
}

// Native smoke must never read/write the signed-in runner's catalog or history.
// Windows Known Folders do not reliably honor USERPROFILE/APPDATA overrides.
// Accept an existing absolute directory only in explicit smoke mode; the runner
// seeds a complete settings.json with every external history source disabled.
fn smoke_data_directory() -> std::io::Result<Option<std::path::PathBuf>> {
    if std::env::var("SESSIONBAY_SMOKE").as_deref() != Ok("1") {
        return Ok(None);
    }
    let Some(path) = std::env::var_os("SESSIONBAY_SMOKE_APP_DATA") else {
        return Ok(None);
    };
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() || !path.is_dir() || !path.join("settings.json").is_file() {
        return Err(std::io::Error::other(
            "Smoke data directory must contain isolated settings",
        ));
    }
    let settings: Settings =
        serde_json::from_reader(std::fs::File::open(path.join("settings.json"))?)?;
    settings.validate().map_err(std::io::Error::other)?;
    if !settings.sources.is_empty() {
        return Err(std::io::Error::other(
            "Smoke data directory must have no external history sources",
        ));
    }
    Ok(Some(path))
}

// The runtime emits some native events before setup manages Service. Only exit
// events need it; missing state during startup/failed setup must never panic.
fn service_for_event(
    event: &tauri::RunEvent,
    state: impl FnOnce() -> Option<Arc<Service>>,
) -> Option<Arc<Service>> {
    match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => state(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_diagnostics_are_bounded_json_without_log_injection() {
        let line = diagnostic_line("error", &format!("failure\n{}", "界".repeat(3000))).unwrap();
        assert_eq!(line.lines().count(), 1);
        let value: serde_json::Value =
            serde_json::from_str(line.strip_prefix("SESSIONBAY_FRONTEND ").unwrap()).unwrap();
        assert_eq!(value["message"].as_str().unwrap().chars().count(), 2048);
        assert!(diagnostic_line("arbitrary", "ignored").is_err());
    }

    #[test]
    fn frontend_snapshots_accept_only_known_screens_and_themes() {
        for screen in [
            "projects",
            "directories",
            "providers",
            "launcher",
            "calendar",
        ] {
            for theme in ["dark", "light"] {
                let message = format!("{screen}-{theme}");
                let line = diagnostic_line("snapshot", &message).unwrap();
                let value: serde_json::Value =
                    serde_json::from_str(line.strip_prefix("SESSIONBAY_FRONTEND ").unwrap())
                        .unwrap();
                assert_eq!(
                    value,
                    serde_json::json!({ "phase": "snapshot", "message": message })
                );
                assert_eq!(line.lines().count(), 1);
            }
        }
        for message in [
            "",
            "projects",
            "projects-auto",
            "unknown-dark",
            "projects-dark\n",
            "../projects-dark",
        ] {
            assert!(diagnostic_line("snapshot", message).is_err());
        }
    }

    #[test]
    fn early_native_events_never_read_unmanaged_service() {
        for event in [tauri::RunEvent::Ready, tauri::RunEvent::Resumed] {
            assert!(service_for_event(&event, || panic!("state accessed before setup")).is_none());
        }
    }

    #[test]
    fn exit_before_service_setup_is_safe() {
        assert!(service_for_event(&tauri::RunEvent::Exit, || None).is_none());
    }
}
