# MVP IPC 契約

Implementation baseline 2026-10-15. All Rust structs use `#[serde(rename_all = "camelCase")]`; commands use snake_case, argument keys camelCase. Errors are user-readable strings. React + Vite + TypeScript; Tauri 2. xterm output bypasses React state.

## Data

- AgentKind: `codex` | `claude`
- HistorySource: `{ id: string, kind: AgentKind, root: string, enabled: boolean }` (root is CODEX_HOME / CLAUDE_CONFIG_DIR)
- Installation: `{ kind, executable: string | null, version: string | null, available: boolean, error: string | null }`
- SourceHealth: `{ sourceId: string, status: string, message: string | null, files: number }`
- Project: `{ id, name, path: string | null, launchPath: string | null, exists: boolean, pinned: boolean, sessionCount: number, updatedAt: string | null, agents: AgentKind[] }`
- Session: `{ id, sourceId, kind, externalId, projectId, title, cwd: string | null, updatedAt: string, timeSource: 'event' | 'mtime', archived: boolean, parentId: string | null, partial: boolean, snippet: string | null }`
- SessionQuery: `{ projectId?: string, kind?: AgentKind, query?: string, archived?: boolean, includeChildren?: boolean, after?: string, before?: string, offset?: number, limit?: number }`; date filters RFC3339; UI dates converted to local-day ISO bounds.
- SessionPage: `{ items: Session[], total: number }`
- TranscriptMessage: `{ role: string, text: string, timestamp: string | null, line: number }`
- TranscriptPage: `{ messages: TranscriptMessage[], hasMore: boolean, beforeLine: number | null, stale: boolean, warning: string | null }`
- IndexStatus: `{ revision: number, running: boolean, processed: number, total: number, cancelled: boolean, errors: string[], sources: SourceHealth[] }`
- ShellProfile: `{ id, name, executable, args: string[], env: Record<string,string> }`
- Settings: `{ version: 1, theme: 'dark' | 'light' | 'system', terminalTheme: 'bay' | 'classic', fontFamily: string, fontSize: number, defaultAgent: AgentKind, defaultProfileId: string, profiles: ShellProfile[], sources: HistorySource[], executables: { codex: string, claude: string }, shortcuts: Record<string,string>, onboardingComplete: boolean }`
- Bootstrap: `{ settings: Settings, projects: Project[], installations: Installation[], index: IndexStatus, workspace: unknown, warnings: string[] }`
- LaunchRequest: `{ paneId: string, kind: 'shell' | 'codex' | 'claude', projectId?: string, sessionId?: string, cwd?: string, profileId?: string, cols: number, rows: number }`.
- LaunchSpec (Rust only): `{ executable: String, args: Vec<String>, cwd: PathBuf, env: HashMap<String,String>, session_id: Option<String>, pane_id: String }`.
- RuntimeInfo: `{ id, paneId, sessionId: string | null, state: string, cwd: string, exitCode: number | null }`.
- TerminalEvent: tagged `type` enum `{type:'output',runtimeId,sequence:number,data:number[]}` | `{type:'exit',runtimeId,exitCode:number|null}` | `{type:'error',runtimeId,message:string}`. Uint8Array feeds xterm directly. Callback ACK after xterm write.

## Commands

- frontend_diagnostic({phase,message}) -> boolean: startup observer only; strict phases, 2,048-character messages, at most 32 single-line JSON stderr records. Returns false without logging unless the native process explicitly has SESSIONBAY_SMOKE=1. No filesystem paths, file writes, remote transport, or Agent launch; only an opt-in CI process can enable the safe DOM interaction probe.

- bootstrap() -> Bootstrap
- detect_installations() -> Installation[]
- save_settings({settings}) -> Settings (validate before write)
- list_projects() -> Project[]
- add_project({path}) -> Project
- update_project({projectId, pinned?: boolean, launchPath?: string}) -> Project
- query_sessions({query}) -> SessionPage
- read_transcript({sessionId,beforeLine?:number,limit?:number}) -> TranscriptPage
- start_index({rebuild:boolean}) -> IndexStatus (background start, single concurrent scan)
- index_status() -> IndexStatus
- cancel_index() -> ()
- clear_index() -> () (only own derived data, retains settings/projects)
- save_workspace({workspace:unknown}) -> () (bounded JSON, version 1)
- launch_runtime({request,onEvent:Channel<TerminalEvent>}) -> RuntimeInfo
- write_runtime({runtimeId,data:string}) -> ()
- resize_runtime({runtimeId,cols,rows}) -> ()
- ack_runtime({runtimeId,sequence:number}) -> ()
- stop_runtime({runtimeId}) -> ()
- list_runtimes() -> RuntimeInfo[]
- close_application() -> () (after UI active-program confirmation)

RuntimeManager API (module runtime.rs): `new()`, `launch(spec: LaunchSpec, cols: u16, rows:u16, emit: Arc<dyn Fn(TerminalEvent)->Result<(),String> + Send+Sync>) -> Result<RuntimeInfo,String>`, `write(id,&str)`, `resize(id,cols,rows)`, `ack(id,sequence:u64)`, `stop(id)`, `list() -> Vec<RuntimeInfo>`, `shutdown()`. Manager and handles Send + Sync for Tauri state. Commands only expose validated specs, never arbitrary shell concatenation. Existing active Session launch returns existing RuntimeInfo; frontend focuses existing pane without reattaching channel. Runtime types owned in runtime.rs, LaunchSpec in runtime.rs.

Catalog API (module catalog.rs; adapters.rs private implementation): `Catalog::open(path: &Path) -> Result<Self,String>`, `projects()`, `add_project(path:&str)`, `update_project(id:&str,pinned:Option<bool>,launch_path:Option<&str>)`, `query(&SessionQuery)`, `transcript(id:&str,before_line:Option<u64>,limit:usize)`, `session(id:&str)->Result<Session,String>`, `clear()`, `sync(sources:&[HistorySource], cancel:&AtomicBool, progress: impl Fn(IndexStatus))`. Catalog owns DB path, opens per method/scan for concurrency. Data models in models.rs owned by catalog implementer. Other definitions Settings/Profile/Bootstrap owned by integration implementer in config.rs. Catalog provides source root/file existence and uniqueness preflight as `resume_source(session_id: &str) -> Result<(Session, HistorySource),String>`.
