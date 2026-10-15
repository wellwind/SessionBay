# MVP IPC 契約

Implementation baseline 2026-10-15. All Rust structs use `#[serde(rename_all = "camelCase")]`; commands use snake_case, argument keys camelCase. Errors are user-readable strings. React + Vite + TypeScript; Tauri 2. xterm output bypasses React state.

2026-10-15 自選專案變更：以下加入 `curated`、專案名稱及建立資料夾契約。本次變更的驗證仍待記錄；舊版本通過的 CI 不代表此契約已驗收。

## Data

- AgentKind: `codex` | `claude` | `grok` | `antigravity`
- HistorySource: `{ id: string, kind: AgentKind, root: string, enabled: boolean }` (root is CODEX_HOME / CLAUDE_CONFIG_DIR / GROK_HOME; Antigravity history is unsupported)
- Installation: `{ kind, executable: string | null, version: string | null, available: boolean, error: string | null }`
- SourceHealth: `{ sourceId: string, status: string, message: string | null, files: number }`
- Project: `{ id, name, path: string | null, launchPath: string | null, exists: boolean, curated: boolean, pinned: boolean, sessionCount: number, updatedAt: string | null, agents: AgentKind[] }`; `curated` is explicit user-selected Projects membership, independent of discovered Session grouping and open workspaces.
- Session: `{ id, sourceId, kind, externalId, projectId, title, cwd: string | null, updatedAt: string, timeSource: 'event' | 'mtime', archived: boolean, parentId: string | null, partial: boolean, snippet: string | null }`
- SessionQuery: `{ projectId?: string, kind?: AgentKind, query?: string, archived?: boolean, includeChildren?: boolean, after?: string, before?: string, offset?: number, limit?: number }`; date filters RFC3339; UI dates converted to local-day ISO bounds.
- SessionPage: `{ items: Session[], total: number }`
- TranscriptMessage: `{ role: string, text: string, timestamp: string | null, line: number }`
- TranscriptPage: `{ messages: TranscriptMessage[], hasMore: boolean, beforeLine: number | null, stale: boolean, warning: string | null }`
- IndexStatus: `{ revision: number, running: boolean, processed: number, total: number, cancelled: boolean, errors: string[], sources: SourceHealth[] }`
- ShellProfile: `{ id, name, executable, args: string[], env: Record<string,string> }`
- AgentLaunchOptions: `{ extraArgs: string[], bypassPermissions: boolean }`; default empty/false independently per kind.
- Settings: `{ version: 1, theme: 'dark' | 'light' | 'system', terminalTheme: 'bay' | 'classic', fontFamily: string, fontSize: number, defaultAgent: AgentKind, defaultProfileId: string, profiles: ShellProfile[], sources: HistorySource[], executables: Record<AgentKind,string>, agentOptions: Record<AgentKind,AgentLaunchOptions>, shortcuts: Record<string,string>, onboardingComplete: boolean }`
- Bootstrap: `{ settings: Settings, projects: Project[], installations: Installation[], index: IndexStatus, workspace: unknown, warnings: string[] }`
- LaunchRequest: `{ paneId: string, kind: 'shell' | AgentKind, projectId?: string, sessionId?: string, resumeId?: string, cwd?: string, profileId?: string, cols: number, rows: number }`.
- LaunchPreview: `{ executable: string, args: string[], cwd: string }`; does not include environment variables, secrets or a Runtime ID.
- LaunchSpec (Rust only): `{ executable: String, args: Vec<String>, cwd: PathBuf, env: HashMap<String,String>, session_id: Option<String>, resume_key: Option<String>, pane_id: String }`; resume_key is internal only and never becomes a public catalog Session ID.
- RuntimeInfo: `{ id, paneId, sessionId: string | null, state: string, cwd: string, exitCode: number | null }`.
- TerminalEvent: tagged `type` enum `{type:'output',runtimeId,sequence:number,data:number[]}` | `{type:'exit',runtimeId,exitCode:number|null}` | `{type:'error',runtimeId,message:string}`. Uint8Array feeds xterm directly. Callback ACK after xterm write.

## Commands

- frontend_diagnostic({phase,message}) -> boolean: startup observer only; strict phases, 2,048-character messages, at most 32 single-line JSON stderr records. Returns false without logging unless the native process explicitly has SESSIONBAY_SMOKE=1. No filesystem paths, file writes, remote transport, or Agent launch; only an opt-in CI process can enable the safe DOM interaction probe.

- bootstrap() -> Bootstrap
- detect_installations() -> Installation[]
- save_settings({settings}) -> Settings (validate before write)
- list_projects() -> Project[] (complete catalog groups; frontend Projects filters `curated`, not Session queries)
- add_project({path, name?: string}) -> Project (existing absolute directory; optional display name; marks `curated: true`; canonical duplicates reuse the same Project)
- create_project({parentPath, name}) -> Project (existing absolute parent directory plus one new folder-name component; creates a single directory and marks it curated)
- update_project({projectId, pinned?: boolean, launchPath?: string, curated?: boolean, name?: string}) -> Project (omitted fields preserve their existing values; `curated: false` also clears pinned)
- query_sessions({query}) -> SessionPage
- read_transcript({sessionId,beforeLine?:number,limit?:number}) -> TranscriptPage
- start_index({rebuild:boolean}) -> IndexStatus (background start, single concurrent scan)
- index_status() -> IndexStatus
- cancel_index() -> ()
- clear_index() -> () (only own derived data, retains settings and curated Project membership/name/pin/launch override)
- save_workspace({workspace:unknown}) -> () (bounded JSON, version 1)
- preview_launch({request}) -> LaunchPreview (same validated plan as launch; no PTY or process)
- launch_runtime({request,onEvent:Channel<TerminalEvent>}) -> RuntimeInfo
- write_runtime({runtimeId,data:string}) -> ()
- resize_runtime({runtimeId,cols,rows}) -> ()
- ack_runtime({runtimeId,sequence:number}) -> ()
- stop_runtime({runtimeId}) -> ()
- list_runtimes() -> RuntimeInfo[]
- close_application() -> () (after UI active-program confirmation)

RuntimeManager API (module runtime.rs): `new()`, `launch(spec: LaunchSpec, cols: u16, rows:u16, emit: Arc<dyn Fn(TerminalEvent)->Result<(),String> + Send+Sync>) -> Result<RuntimeInfo,String>`, `write(id,&str)`, `resize(id,cols,rows)`, `ack(id,sequence:u64)`, `stop(id)`, `list() -> Vec<RuntimeInfo>`, `shutdown()`. Manager and handles Send + Sync for Tauri state. Commands only expose validated specs, never arbitrary shell concatenation. Existing active Session launch returns existing RuntimeInfo; frontend focuses existing pane without reattaching channel. Runtime types owned in runtime.rs, LaunchSpec in runtime.rs.

Catalog API (module catalog.rs; adapters.rs private implementation): `Catalog::open(path: &Path) -> Result<Self,String>`, `projects()`, project addition/creation/update methods matching the commands above, `query(&SessionQuery)`, `transcript(id:&str,before_line:Option<u64>,limit:usize)`, `session(id:&str)->Result<Session,String>`, `clear()`, `sync(sources:&[HistorySource], cancel:&AtomicBool, progress: impl Fn(IndexStatus))`. Catalog owns DB path, opens per method/scan for concurrency. Data models in models.rs owned by catalog implementer. Other definitions Settings/Profile/Bootstrap owned by integration implementer in config.rs. Catalog provides source root/file existence and uniqueness preflight as `resume_source(session_id: &str) -> Result<(Session, HistorySource),String>`.

## Agent 選項與啟動計畫

- 設定版本保留 `1`。缺少 `executables.grok`／`antigravity` 時補為 `grok`／`agy`；缺少或部分缺少 `agentOptions` 時逐工具／欄位補為 `extraArgs: []`、`bypassPermissions: false`。原來源清單不覆寫；只有全新預設設定加入 `grok-default`（`GROK_HOME` 或 `~/.grok`）。
- `extraArgs` 是逐項 argv，最多 64 個非空字串，每個最多 8192 bytes 且無 NUL；不做 Shell split、變數展開、去引號或命令替換。帶值選項可用相鄰元素或 `--flag=value`；布林 switch 不接受 `=value`。
- 儲存設定及啟動計畫都透過 `launch_options.rs` 驗證工具專屬白名單、參數數量與已知權限值。cwd、Session 身份、來源與 config／remote override、任意子命令、位置參數及 `--` 不對自訂參數開放；錯誤包含可接受的選項。
- `bypassPermissions` 是持久的明確 opt-in，預設 false；需同意的旗標／權限值仍在後端強制檢查。true 且沒有明確權限模式時追加該工具預設；明確 Codex sandbox／approval 模式、Claude permission mode、受限工具 allow／deny／額外目錄政策或工具自己的 bypass 旗標會抑制重複預設。Grok sandbox 與 auto-approve 分開處理。詳見 [整合規格](agent-integrations.md#每個-agent-的自訂參數與危險模式)。
- `resumeId` 只接受 Grok／Antigravity 的手動外部 ID，不能同時帶 `sessionId`。長度 1–256 個 ASCII 字元，首字元為英數字，其餘只可為英數字、`-`、`_`、`.`；不接受空白、路徑、選項注入或自動選最近一次的快捷寫法。
- 索引 `sessionId` 保持 catalog 身份與原有來源／歧義檢查；手動 `resumeId` 不建立 catalog 關聯，也不填入公開 `RuntimeInfo.sessionId`；Runtime 另外以工具、canonical 有效來源 root 與外部 ID 的私有 key 去重。同來源 Grok 手動與索引恢復互相去重；Antigravity 以 CLI 的資料 root 區分工具身份。Grok 手動恢復若有多個已啟用 Grok 來源會拒絕歧義。Antigravity 不支援索引恢復，也不虛構來源環境變數。
- 恢復 argv 依工具為 `resume <id>`（Codex）、`--resume <id>`（Claude／Grok）、`--conversation <id>`（Antigravity）；其後加入已驗證自訂參數及必要預設。Codex 最後加入應用管理的 `--cd <cwd>`，其餘以獨立 cwd 啟動；受支援歷史來源使用各自的來源環境變數。
- `preview_launch` 與真正啟動共用 `plan_launch`，會檢查工具、目錄、設定與來源，只回傳 executable／args／cwd。預覽不 spawn，真正啟動時重新預檢；CLI 自有設定仍可能影響實際權限，因此 argv 預覽不是有效權限或成功恢復的保證。

## 自選專案語意與驗證

- Bootstrap 的 `projects` 與 `list_projects()` 都保留未加入的目錄分組，供歷史預覽、Session 關聯與已開啟工作區使用。左側 Projects 只顯示 `curated: true`；工作區導覽不受此篩選限制。
- 所有工作階段以省略 `SessionQuery.projectId` 查詢完整範圍，既有文字、Agent、日期、封存及子代理篩選維持原語意。`curated` 不新增為隱含搜尋條件。
- 自動探索、重掃與重建不自動加入 Projects。升級時僅把舊版手動加入或釘選專案遷移為 curated，其餘預設 false；此回填不可在日後掃描重複執行。
- 路徑輸入必須是絕對路徑，前端目前沒有原生目錄選擇器。`add_project` 要求存在且為目錄；不建立輸入路徑。
- `create_project` 的父目錄必須已存在且為目錄；`name` 不得為空、`.`、`..`、絕對路徑或多個路徑元件。只建立一個新資料夾，不覆寫任何既有目標，也不建立祖先目錄；錯誤由後端回報，不能僅依賴前端驗證。
- `name` 是 Session Bay 的顯示名稱；修改名稱不重新命名磁碟目錄。建立時 `name` 同時作為新資料夾名稱與初始顯示名稱。
- `update_project({projectId, curated: false})` 只取消加入與釘選，不刪任何來源、Session、索引、檔案、工作區或 Runtime，不修改 cwd／launch override。重新加入同一目錄仍使用原 Project 身份。
- 這些命令不啟動程序。Session 恢復及新工作繼續使用既有 cwd 與重新定位規則；直接恢復未加入專案的歷史不自動改變 curated。
- `pinned` 對應 UI 的「置頂」，只調整自選清單排序；取消置頂不取消 curated。

## Shell 退出事件的前端行為

`TerminalEvent.exit` 的結構不變。前端只有在普通 Shell pane 原為 `starting`／`running` 且 `exitCode === 0` 時自動移除該 pane；最後一個 pane 移除時同步移除所屬 tab。Agent、非零／null 結束碼與 error 保留診斷；已退出或布局還原占位不重複觸發。移出專案不產生 exit event、不呼叫 `stop_runtime`。
