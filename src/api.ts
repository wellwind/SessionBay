import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invoke, isTauri, Channel } from '@tauri-apps/api/core';
import type {
  KanbanBoard, KanbanCard, KanbanColumn, KanbanStage, KanbanSessionDisposition,
  WorkspaceFilePage,
  TerminalFileResolution,
  WorkspaceFileSearch,
  WorkspaceFilePreview,
  WorkspaceFileInfo,
  WorkspaceFileChunk,
  AgentKind,
  HistorySourceDiscovery,
  Bootstrap,
  IndexStatus,
  Installation,
  LaunchRequest,
  LaunchPreview,
  Project,
  RuntimeInfo,
  RuntimeRecord,
  SessionPage,
  SessionQuery,
  ShellCandidate,
  Settings,
  TerminalEvent,
  TranscriptPage,
  TrashPage,
  OsTrashPlan, OsTrashResult, OsTrashedSession, UpdateInfo,
} from './types';
import { t } from './i18n';
export const isDesktop = () => isTauri();
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error(t('The desktop runtime is not connected. Open this in the Session Bay desktop app.'));
  return invoke<T>(command, args);
}
// Explicit pane-close waits for its outstanding launch before querying the broker.
// UI/window detach deliberately never waits for or cancels these launches.
const pendingLaunches = new Map<string, Set<Promise<RuntimeInfo>>>();
export const api = {
  beginFile: (runtimeId: string, name: string, size: number) => call<string>('begin_file_input', { runtimeId, name, size }),
  appendFile: (runtimeId: string, id: string, offset: number, bytes: number[]) => call<void>('append_file_input', { runtimeId, id, offset, bytes }),
  finishFile: (runtimeId: string, id: string) => call<{ id: string; path: string; originalName: string; name: string }>('finish_file_input', { runtimeId, id }),
  retainFile: (runtimeId: string, id: string) => call<void>('retain_file_input', { runtimeId, id }),
  discardFile: (runtimeId: string, id: string) => call<void>('discard_file_input', { runtimeId, id }),
  beginImage: (runtimeId: string, mime: string, size: number) => call<string>('begin_image_input', { runtimeId, mime, size }),
  appendImage: (runtimeId: string, id: string, offset: number, bytes: number[]) => call<void>('append_image_input', { runtimeId, id, offset, bytes }),
  finishImage: (runtimeId: string, id: string) => call<{ id: string; path: string }>('finish_image_input', { runtimeId, id }),
  retainImage: (runtimeId: string, id: string) => call<void>('retain_image_input', { runtimeId, id }),
  discardImage: (runtimeId: string, id: string) => call<void>('discard_image_input', { runtimeId, id }),
  setWorkspaceZoom: async (percent: number): Promise<void> => {
    if (!isDesktop()) throw new Error(t('Workbench zoom requires the desktop runtime.'));
    await getCurrentWebview().setZoom(percent / 100);
  },
  bootstrap: () => call<Bootstrap>('bootstrap'),
  importProductionProfile: () => call<Settings>('import_production_profile'),
  detect: () => call<Installation[]>('detect_installations'),
  detectShells: () => call<ShellCandidate[]>('detect_shells'),
  detectHistorySources: (kind: AgentKind) => call<HistorySourceDiscovery>('detect_history_sources', { kind }),
  saveSettings: (settings: Settings) => call<Settings>('save_settings', { settings }),
  resolveTerminalFile: (projectId: string, paneId: string, runtimeId: string, path: string) =>
    call<TerminalFileResolution>('resolve_terminal_file', { projectId, paneId, runtimeId, path }),
  listWorkspaceFiles: (projectId: string, path: string, offset = 0, showHidden = false) =>
    call<WorkspaceFilePage>('list_workspace_files', { projectId, path, offset, showHidden }),
  searchWorkspaceFiles: (projectId: string, query: string) =>
    call<WorkspaceFileSearch>('search_workspace_files', { projectId, query }),
  readWorkspaceFile: (projectId: string, path: string) =>
    call<WorkspaceFilePreview>('read_workspace_file', { projectId, path }),
  inspectWorkspaceFile: (projectId: string, path: string) =>
    call<WorkspaceFileInfo>('inspect_workspace_file', { projectId, path }),
  readWorkspaceImage: (projectId: string, path: string, version: string) =>
    call<ArrayBuffer>('read_workspace_image', { projectId, path, version }),
  readWorkspaceFileChunk: (projectId: string, path: string, version: string, offset: number, maxBytes: number) =>
    call<WorkspaceFileChunk>('read_workspace_file_chunk', { projectId, path, version, offset, maxBytes }),
  setKanbanAutoArchive: (projectId: string, days: number | null) => call<void>('set_kanban_auto_archive', { projectId, days }),
  bindKanbanWorktree: (cardId: string, path: string) => call<void>('bind_kanban_worktree', { cardId, path }),
  kanbanBoard: (projectId: string) => call<KanbanBoard | null>('kanban_board', { projectId }),
  listKanbanBoards: () => call<KanbanBoard[]>('list_kanban_boards'),
  setKanbanBoardEnabled: (projectId: string, enabled: boolean) => call<KanbanBoard>('set_kanban_board_enabled', { projectId, enabled }),
  createKanbanColumn: (projectId: string, name: string, stage?: KanbanStage) => call<KanbanColumn>('create_kanban_column', { projectId, name, stage }),
  renameKanbanColumn: (columnId: string, name: string) => call<KanbanColumn>('rename_kanban_column', { columnId, name }),
  setKanbanColumnStage: (columnId: string, stage: KanbanStage) => call<KanbanColumn>('set_kanban_column_stage', { columnId, stage }),
  reorderKanbanColumns: (projectId: string, columnIds: string[]) => call<void>('reorder_kanban_columns', { projectId, columnIds }),
  deleteKanbanColumn: (columnId: string, targetColumnId: string) => call<void>('delete_kanban_column', { columnId, targetColumnId }),
  createKanbanCard: (columnId: string, title: string, notes: string) => call<KanbanCard>('create_kanban_card', { columnId, title, notes }),
  editKanbanCard: (cardId: string, title: string, notes: string) => call<KanbanCard>('edit_kanban_card', { cardId, title, notes }),
  moveKanbanCard: (cardId: string, columnId: string, position: number) => call<KanbanCard>('move_kanban_card', { cardId, columnId, position }),
  archiveKanbanCard: (cardId: string, archived: boolean) => call<KanbanCard>('archive_kanban_card', { cardId, archived }),
  deleteKanbanCard: (cardId: string, sessions: KanbanSessionDisposition) => call<void>('delete_kanban_card', { cardId, sessions }),
  attachKanbanSession: (cardId: string, sessionId: string) => call<KanbanCard>('attach_kanban_session', { cardId, sessionId }),
  detachKanbanSession: (cardId: string, sessionId: string) => call<KanbanCard>('detach_kanban_session', { cardId, sessionId }),
  mergeKanbanCards: (sourceCardId: string, targetCardId: string) => call<KanbanCard>('merge_kanban_cards', { sourceCardId, targetCardId }),
  splitKanbanSession: (cardId: string, sessionId: string) => call<KanbanCard>('split_kanban_session', { cardId, sessionId }),
  addKanbanSession: (sessionId: string) => call<KanbanCard>('add_kanban_session', { sessionId }),
  kanbanSessionCard: (sessionId: string) => call<KanbanCard | null>('kanban_session_card', { sessionId }),
  projects: () => call<Project[]>('list_projects'),
  addProject: (path: string, name?: string) => call<Project>('add_project', { path, name }),
  createProject: (parentPath: string, name: string) => call<Project>('create_project', { parentPath, name }),
  updateProject: (projectId: string, values: { launchPath?: string; curated?: boolean; name?: string }) =>
    call<Project>('update_project', { projectId, ...values }),
  sessions: (query: SessionQuery) => call<SessionPage>('query_sessions', { query }),
  trashSession: (sessionId: string, expectedIdentity: string) => call<string>('trash_session', { sessionId, expectedIdentity }),
  prepareSessionOsTrash: (trashId: string) => call<OsTrashPlan>('prepare_session_os_trash', { trashId }),
  executeSessionOsTrash: (planId: string) => call<OsTrashResult>('execute_session_os_trash', { planId }),
  osTrashed: () => call<OsTrashedSession[]>('list_os_trashed_sessions'),
  restoreOsTrashed: (id: string) => call<OsTrashResult>('restore_os_trashed_session', { id }),
  forgetOsTrashed: (id: string) => call<void>('forget_os_trashed_session', { id }),
  restoreSession: (sessionId: string) => call<void>('restore_session', { sessionId }),
  trash: (offset = 0, limit = 40) => call<TrashPage>('list_trashed_sessions', { offset, limit }),
  transcript: (sessionId: string, beforeLine?: number) =>
    call<TranscriptPage>('read_transcript', { sessionId, beforeLine, limit: 40 }),
  scan: (rebuild = false) => call<IndexStatus>('start_index', { rebuild }),
  index: () => call<IndexStatus>('index_status'),
  cancelScan: () => call<void>('cancel_index'),
  clearIndex: () => call<void>('clear_index'),
  saveWorkspace: (workspace: unknown) => call<void>('save_workspace', { workspace }),
  preview: (request: LaunchRequest) => call<LaunchPreview>('preview_launch', { request }),
  // The request pane ID is an idempotency intent key. Only the returned pane ID
  // identifies the detached, backend-owned runtime to attach in the workspace.
  launchFresh: (request: LaunchRequest): Promise<RuntimeInfo> => call<RuntimeInfo>('launch_fresh_runtime', { request }),
  launchFreshWithoutHooks: (request: LaunchRequest): Promise<RuntimeInfo> => call<RuntimeInfo>('launch_fresh_without_hooks', { request }),
  cancelFresh: (intent: string) => call<void>('cancel_fresh_launch', { intent }),
  launch: (request: LaunchRequest, onMessage: (event: TerminalEvent) => void, attachmentId: string) => {
    const onEvent = new Channel<TerminalEvent>();
    onEvent.onmessage = onMessage;
    const pending = Promise.resolve().then(() => call<RuntimeInfo>('launch_runtime', { request, onEvent, attachmentId }));
    const launches = pendingLaunches.get(request.paneId) ?? new Set<Promise<RuntimeInfo>>();
    launches.add(pending);
    pendingLaunches.set(request.paneId, launches);
    const remove = () => {
      launches.delete(pending);
      if (!launches.size) pendingLaunches.delete(request.paneId);
    };
    void pending.then(remove, remove);
    return pending;
  },
  settleLaunches: async (paneIds: string[]) => {
    while (true) {
      const pending = paneIds.flatMap((id) => [...(pendingLaunches.get(id) ?? [])]);
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  },
  attach: (runtimeId: string, onMessage: (event: TerminalEvent) => void, attachmentId: string) => {
    const onEvent = new Channel<TerminalEvent>();
    onEvent.onmessage = onMessage;
    return call<RuntimeInfo>('attach_runtime', { runtimeId, onEvent, attachmentId });
  },
  detach: (runtimeId: string, attachmentId: string) => call<void>('detach_runtime', { runtimeId, attachmentId }),
  forget: (runtimeId: string) => call<void>('forget_runtime', { runtimeId }),
  write: (runtimeId: string, data: string) => call<void>('write_runtime', { runtimeId, data }),
  resize: (runtimeId: string, cols: number, rows: number) =>
    call<void>('resize_runtime', { runtimeId, cols, rows }),
  ack: (runtimeId: string, sequence: number, attachmentId: string) => call<void>('ack_runtime', { runtimeId, sequence, attachmentId }),
  stop: (runtimeId: string) => call<void>('stop_runtime', { runtimeId }),
  runtimes: () => call<RuntimeRecord[]>('list_runtimes'),
  close: () => call<void>('close_application'),
  notify: (title: string, body: string, target?: string, suppressSound = false) => call<void>('show_notification', { title, body, target, suppressSound }),
  attentionSoundMuted: () => call<boolean>('attention_sound_muted'),
  checkForUpdate: () => call<UpdateInfo | null>('check_for_update'),
  openReleasePage: (url: string) => call<void>('open_release_page', { url }),
};
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
