# MVP IPC 契約

Implementation baseline 2026-10-15. All Rust structs use `#[serde(rename_all = "camelCase")]`; commands use snake_case, argument keys camelCase. Errors are user-readable strings. React + Vite + TypeScript; Tauri 2. xterm output bypasses React state.

2026-10-15 最新追加：以下加入統一歷史來源候選偵測；本批三平台 exact-commit CI 仍待執行／確認。較早提交的成功不代表新增 IPC 已通過原生驗證。本機 09:24 UTC 最新檢查點：frontend 380／380、core 176、desktop 180 與 strict checks 通過；最新原生 CI 尚待確認。

## Data

- AgentKind: `codex` | `claude` | `grok` | `antigravity`
- HistorySource: `{ id: string, kind: AgentKind, root: string, enabled: boolean }` (root is CODEX_HOME / CLAUDE_CONFIG_DIR / GROK_HOME, or the Antigravity CLI store directory)
- HistorySourceCandidate: `{ kind: AgentKind, root: string, status: 'found' | 'missing' | 'permissionDenied' | 'checkFailed', configured: boolean, configuredSourceIds: string[], message: string | null }`; `found` means a readable directory, not that sessions were found. `configuredSourceIds` identifies matching saved sources, including canonical aliases; at most 32 IDs.
- HistorySourceDiscovery: `{ kind: AgentKind, supported: boolean, candidates: HistorySourceCandidate[], message: string | null }`; unsupported history returns `supported: false`, an empty candidate list, and an explanation.
- Installation: `{ kind, executable: string | null, version: string | null, available: boolean, status: 'missing' | 'available' | 'versionCheckFailed', loginStatus: 'unknown', error: string | null }`; `available` indicates executable discovery, not login or a successful version probe.
- SourceHealth: `{ sourceId: string, status: string, message: string | null, files: number }`
- Project: `{ id, name, path: string | null, launchPath: string | null, exists: boolean, curated: boolean, pinned: boolean, sessionCount: number, updatedAt: string | null, agents: AgentKind[] }`; `curated` is explicit user-selected Projects membership, independent of discovered Session grouping and open workspaces.
- Session: `{ id, sourceId, kind, externalId, projectId, title, cwd: string | null, updatedAt: string, timeSource: 'event' | 'mtime', archived: boolean, parentId: string | null, partial: boolean, snippet: string | null, resumeDisabledReason: string | null }`
- SessionQuery: `{ projectId?: string, kind?: AgentKind, query?: string, archived?: boolean, includeChildren?: boolean, after?: string, before?: string, offset?: number, limit?: number }`; date filters RFC3339; UI dates converted to local-day ISO bounds.
- SessionPage: `{ items: Session[], total: number }`
- TranscriptMessage: `{ role: string, text: string, timestamp: string | null, line: number }`
- TranscriptPage: `{ snapshotId: string | null, messages: TranscriptMessage[], hasMore: boolean, beforeLine: number | null, stale: boolean, warning: string | null }`
- IndexStatus: `{ revision: number, running: boolean, processed: number, total: number, cancelled: boolean, errors: string[], sources: SourceHealth[] }`
- ShellProfile: `{ id, name, executable, args: string[], env: Record<string,string> }`
- ShellCandidate: `{ name: string, executable: string }`; executable preserves the first discovered absolute invocation path. Canonical targets are used only for deduplication and saved-profile exclusion, so an invocation alias such as `sh` is not silently replaced by its target.
- AgentLaunchOptions: `{ extraArgs: string[], bypassPermissions: boolean }`; default empty/false independently per kind.
- Settings: `{ version: 1, theme: 'dark' | 'light' | 'system', terminalTheme: 'bay' | 'classic', fontFamily: string, fontSize: number, defaultAgent: AgentKind, defaultProfileId: string, profiles: ShellProfile[], sources: HistorySource[], executables: Record<AgentKind,string>, agentOptions: Record<AgentKind,AgentLaunchOptions>, shortcuts: Record<string,string>, onboardingComplete: boolean }`
- Bootstrap: `{ settings: Settings, projects: Project[], installations: Installation[], index: IndexStatus, workspace: unknown, warnings: string[] }`
- LaunchRequest: `{ paneId: string, kind: 'shell' | AgentKind, projectId?: string, sessionId?: string, resumeId?: string, cwd?: string, profileId?: string, cols: number, rows: number }`.
- LaunchPreview: `{ executable: string, args: string[], cwd: string }`; does not include environment variables, secrets or a Runtime ID.
- LaunchSpec (Rust only): `{ executable: String, args: Vec<String>, cwd: PathBuf, env: HashMap<String,String>, session_id: Option<String>, resume_key: Option<String>, pane_id: String }`; resume_key is internal only and never becomes a public catalog Session ID.
- RuntimeInfo: `{ id, paneId, sessionId: string | null, state: string, cwd: string, exitCode: number | null }`.
- TerminalEvent: tagged `type` enum `{type:'output',runtimeId,sequence:number,data:number[]}` | `{type:'exit',runtimeId,exitCode:number|null}` | `{type:'error',runtimeId,message:string}`. Uint8Array feeds xterm directly. Callback ACK after xterm write.

## Commands

- frontend_diagnostic({phase,message}) -> boolean: opt-in startup／native UI smoke diagnostics; phases are `observer`, `module-loaded`, `mounted`, `ready`, `interaction`, `error`, `snapshot`. Messages are bounded to 2,048 characters, with at most 32 single-line JSON stderr records. Returns false without logging unless the native process explicitly has SESSIONBAY_SMOKE=1. No filesystem-path argument, file writes, remote transport, or Agent launch. Snapshot messages accept only `projects-dark`, `directories-dark`, `providers-dark`, `launcher-dark`, `calendar-dark` and their `-light` equivalents; unknown identifiers are rejected. A snapshot marker identifies the UI state for external capture; it does not capture an image or prove painted pixels. Existing ready／interaction／error checks remain required.

- bootstrap() -> Bootstrap
- detect_installations() -> Installation[] (uses saved settings and provider-specific version argv; not a history scan or login check)
- detect_history_sources({kind: AgentKind}) -> HistorySourceDiscovery (read-only, bounded known-root checks; never adds sources or starts indexing)
- detect_shells() -> ShellCandidate[] (read-only discovery; no arguments, process launch or settings write)
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

## Provider 與 Shell 偵測語意

- `src/agent-manifest.json` 是 TypeScript／Rust 的共同內建 metadata；不是 IPC 注入的外掛設定。parser、危險參數驗證與來源身份仍由型別實作控制。
- `detect_history_sources` 只讀該 provider 在 manifest 中指定的來源環境變數與 HOME 預設資料根目錄：`CODEX_HOME`／`.codex`、`CLAUDE_CONFIG_DIR`／`.claude`、`GROK_HOME`／`.grok`；Antigravity 僅 `.gemini/antigravity-cli`，沒有來源環境變數 override。最多兩個候選根目錄，環境來源優先、canonical 去重；不搜尋 PATH／整顆磁碟、不遞迴、不讀對話檔案、不執行 CLI 或讀取其他工具的環境變數。僅確認目錄存在、型別與能否開啟讀取；缺少、無權限與其他失敗分開回報。root 必須為絕對 UTF-8 路徑、最多 4096 bytes、無控制字元；無效路徑回 `checkFailed`。
- 存在的候選 `root` 回 canonical 路徑；無效、過長、含控制字元或非 UTF-8 的輸入只回固定且有界的來源說明 placeholder，不把不可信原值完整傳入 IPC。`configured` 只比較同工具的已儲存來源，包含停用來源，以 canonical alias 判斷是否重複；`configuredSourceIds` 提供匹配的保存 ID。UI 以這些 ID 對照草稿中是否仍保留同一個原保存 root，避免使用者已移除／改路徑卻無法重新加入候選；尚未保存的新候選另外以 root 去重。已儲存來源快照最多 32 筆，不改任何 id、root、enabled、名稱或其他設定。UI 明確選擇新增草稿後才由使用者保存；偵測成功不自動啟用、保存或索引。
- `found` 只代表來源根目錄可讀，空目錄仍是合法候選。Grok 另由 manifest `history.probeDirectory: 'sessions'` 有界檢查 `root/sessions`，但候選 root 始終為 `GROK_HOME`／`.grok`；子目錄缺少、無權限或無法檢查以 `message` 說明，不把來源 root 改成 sessions，也不列出其中內容。根目錄可讀時仍回 `found`，可由使用者明確加入。
- Antigravity CLI 回 `supported: true`，以 `probeDirectory: brain` 檢查官方 CLI root；不檢查 App／IDE，不用 stdout／最近 ID cache 取代歷史。未知持久化格式與版本驗收邊界見 [CLI 歷史相容性](antigravity-cli-history.md)。
- `Installation.available` 只表示找到可執行檔。找不到時為 `available: false`、`status: 'missing'`，附上錯誤；bootstrap 只檢查路徑，找到時為 `available: true`、`status: 'available'`、`version: null`、`error: null`，不代表版本已檢查。`detect_installations` 使用共同 manifest 的版本 argv；成功填入 `version`，失敗／逾時則保持 `available: true`，改為 `status: 'versionCheckFailed'` 並附上 `error`。不得把版本失敗誤報為找不到執行檔。
- 版本探測只傳工具的 `--version`（Grok 為 `version`），不用自訂 argv 或高風險旗標；cwd 為 `/`，不套用選取來源／專案環境。單次期限 2 秒、收集輸出最多 4096 bytes，逾時停止所管理程序。`loginStatus` 固定為 `unknown`，不得把路徑或版本探測成功標成已登入。
- `detect_shells` 讀取有上限的 OS shell 清單、目前絕對 `$SHELL` 與絕對 PATH／標準 bin 位置中的已知 shell 名稱；只做檔案 metadata 探索、canonical 去重，不執行候選、不讀 rc 或歷史，不寫設定。候選保留首次找到的絕對路徑拼法，canonical 路徑只用於身份比較。
- 偵測先取得已儲存 Profiles 的唯讀快照，排除其 canonical 執行檔目標；例如已保存 `/bin/bash`，不會再把同目標的 `/usr/bin/bash` 當新候選。已儲存的 bare command 依真正啟動的順序解析：絕對 PATH 位置優先，接著 home 的 `.local/bin`、`.cargo/bin`，再走標準 fallback 位置。只比較已儲存設定；UI 另外避免重複加入同一路徑的未儲存候選。
- 探索上限：OS 清單 64 KiB／128 行，PATH 64 KiB，標準與 PATH 合計最多 32 個目錄項目、256 個候選路徑 probe、64 個結果。已儲存命令解析另有限制：32 個 executable 字串、每個 bare command 最多 128 個搜尋目錄項目、總計 1024 個有快取的路徑 probe，不占用候選的 256 次額度。若已儲存命令解析因上限而不完整，保守回傳空清單，避免推薦可能重複的 Profile；空清單表示「沒有新的 Shell 可加入」，不表示這台電腦沒有 Shell。
- 候選由 UI 明確加入 Profile 草稿，再以 `save_settings` 保存；偵測不修改既有 id、名稱、參數、環境變數、執行檔拼法或 `defaultProfileId`。新增候選使用空參數與空環境，使用者可自行編輯。
- 全新設定選有效且存在的絕對 `$SHELL`，否則 macOS `/bin/zsh`、Linux `/bin/bash`，預設 args `["-l"]`。不匯入 Terminal Profiles／rc；實際啟動檔由 Shell 自身處理。

## Agent 選項與啟動計畫

- 設定版本保留 `1`。缺少 `executables.grok`／`antigravity`／`opencode` 時補為 `grok`／`agy`／`opencode`；缺少或部分缺少 `agentOptions` 時逐工具／欄位補為 `extraArgs: []`、`bypassPermissions: false`。原來源清單不覆寫；只有全新預設設定依 registry 加入五工具來源，包含 `grok-default`（`GROK_HOME` 或 `~/.grok`）、`antigravity-default`（`~/.gemini/antigravity-cli`）及 `opencode-default`（有效 `XDG_DATA_HOME/opencode`，否則 `~/.local/share/opencode`）。
- `extraArgs` 是逐項 argv，最多 64 個非空字串，每個最多 8192 bytes 且無 NUL；不做 Shell split、變數展開、去引號或命令替換。帶值選項可用相鄰元素或 `--flag=value`；布林 switch 不接受 `=value`。
- 儲存設定及啟動計畫都透過 `launch_options.rs` 驗證工具專屬白名單、參數數量與已知權限值。cwd、Session 身份、來源與 config／remote override、任意子命令、位置參數及 `--` 不對自訂參數開放；錯誤包含可接受的選項。
- `bypassPermissions` 是持久的明確 opt-in，預設 false；需同意的旗標／權限值仍在後端強制檢查。true 且沒有明確權限模式時追加該工具預設；明確 Codex sandbox／approval 模式、Claude permission mode、受限工具 allow／deny／額外目錄政策或工具自己的 bypass 旗標會抑制重複預設。Grok sandbox 與 auto-approve 分開處理。詳見 [整合規格](agent-integrations.md#每個-agent-的自訂參數與危險模式)。
- `resumeId` 接受 Grok／Antigravity／OpenCode 的手動外部 ID，不能同時帶 `sessionId`。長度 1–256 個 ASCII 字元，首字元為英數字，其餘只可為英數字、`-`、`_`、`.`；不接受空白、路徑、選項注入或自動選最近一次的快捷寫法。OpenCode 另外強制原生 `ses_` Session ID 格式；其來源限定與 DB 身分檢查見[OpenCode 整合](opencode-integration.md)。
- 索引 `sessionId` 保持 catalog 身份與原有來源／歧義檢查；手動 `resumeId` 不建立 catalog 關聯，也不填入公開 `RuntimeInfo.sessionId`；Runtime 另外以工具、canonical 有效來源 root 與外部 ID 的私有 key 去重。同來源 Grok 手動與索引恢復互相去重；Antigravity 以 CLI 的資料 root 區分工具身份。Grok 手動恢復若有多個已啟用 Grok 來源會拒絕歧義。Antigravity 索引恢復只接受目前 HOME 的 canonical 原生 CLI root、可信 UUID 與仍一致的檔案／metadata；備份與缺 transcript 的記錄回 resumeDisabledReason，backend 仍強制拒絕，不虛構來源環境變數或改 HOME。
- 恢復 argv 依工具為 `resume <id>`（Codex）、`--resume <id>`（Claude／Grok）、`--conversation <id>`（Antigravity）與 `--session <id>`（OpenCode）；其後加入已驗證自訂參數及必要預設。Codex 最後加入應用管理的 `--cd <cwd>`，其餘以獨立 cwd 啟動；受支援歷史來源使用各自的來源環境變數。
- `preview_launch` 與真正啟動共用 `plan_launch`，會檢查工具、目錄、設定與來源，只回傳 executable／args／cwd。預覽不 spawn，真正啟動時重新預檢；CLI 自有設定仍可能影響實際權限，因此 argv 預覽不是有效權限或成功恢復的保證。

## 自選專案語意與驗證

- Bootstrap 的 `projects` 與 `list_projects()` 保留完整目錄分組。「專案」預設頁的卡片／側欄以 `curated: true` 篩選；「所有目錄」頁以 `sessionCount > 0` 篩選，包含已加入、未加入、未知及失效目錄。已開啟工作區在兩頁皆可到達，不受這兩種投影限制。
- 兩頁未選組時顯示總覽，不查詢混合 Session 清單；選組後以 `SessionQuery.projectId` 查詢該組歷史，既有文字、Agent、日期、封存及子代理篩選維持原語意。明確開啟全域搜尋時省略 `projectId` 查詢跨目錄結果，但不是兩頁的預設總覽 UI；`curated` 不新增為隱含搜尋條件。此導覽澄清不需要新增 IPC 或變更 catalog migration。
- 自動探索、重掃與重建不自動加入 Projects。升級時僅把舊版手動加入或釘選專案遷移為 curated，其餘預設 false；此回填不可在日後掃描重複執行。
- 路徑輸入必須是絕對路徑，前端提供原生目錄選擇器，選取只更新草稿；後端仍驗證路徑。`add_project` 要求存在且為目錄；不建立輸入路徑。
- `create_project` 的父目錄必須已存在且為目錄；`name` 不得為空、`.`、`..`、絕對路徑或多個路徑元件。只建立一個新資料夾，不覆寫任何既有目標，也不建立祖先目錄；錯誤由後端回報，不能僅依賴前端驗證。
- `name` 是 Session Bay 的顯示名稱；修改名稱不重新命名磁碟目錄。建立時 `name` 同時作為新資料夾名稱與初始顯示名稱。
- `update_project({projectId, curated: false})` 只取消加入與釘選，不刪任何來源、Session、索引、檔案、工作區或 Runtime，不修改 cwd／launch override。重新加入同一目錄仍使用原 Project 身份。
- 這些命令不啟動程序。Session 恢復及新工作繼續使用既有 cwd 與重新定位規則；直接恢復未加入專案的歷史不自動改變 curated。
- `pinned` 對應 UI 的「置頂」，只調整自選清單排序；取消置頂不取消 curated。

## 受管程序退出事件的前端行為

`TerminalEvent.exit` 保留結束碼並將面板更新為 exited／failed。Shell 與直接啟動的新建／接續 Agent 確認 exited、結束碼 `0` 且沒有錯誤時，只 forget 已完成的 Runtime，核對 Runtime ID／啟動世代後移除該面板，最後面板才關 tab；其他退出保留診斷。Shell 內 Agent 返回不會產生 Shell 的 exit event。UI 退出僅 detach；明確關閉執行中面板才 stop／forget 對應 Runtime。移出專案不產生 exit event、不呼叫 `stop_runtime`。

## Antigravity CLI 歷史追加

`Session.resumeDisabledReason` 是 nullable 的逐筆能力原因，適用所有 provider；非空表示可預覽但不可直接索引接續，UI 同時顯示原因與 disabled 狀態。backend preflight 不信任 UI 狀態；手動 ID 沿用不同入口，不虛構 catalog 關聯。

`TranscriptPage.warning` 與 `stale` 可同時存在，UI 不以通用 stale 字樣遮掉來源原因；翻頁保留已有警告。`snapshotId` 是同一已索引來源快照的 opaque token，各頁相同，任何已索引內容變更時改變；stale 回應為 null。不得由 token 推測路徑或內容。索引 revision 改變時，同一 Session ID 也會重新讀取；只有背景刷新且非空 snapshotId 與最新頁內容均未改變，才保留已載入的較早頁和捲動位置。手動刷新、背景刷新缺少 token、快照變更或已知 token 不同的跨快照翻頁皆重新載入；舊分頁回應不能混入新 generation。TypeScript 欄位可省略，以容納舊測試／IPC fixture，缺少時採保守重載。來源格式、metadata 私密快照及 compaction 重建語意見 [CLI 歷史專章](antigravity-cli-history.md)。

## 全域臨時 Terminal

- `LaunchRequest` 未新增可注入的 home／env 欄位。只有 shell 且 projectId/sessionId/resumeId/cwd 皆省略時，Rust 決定並驗證 home；其他啟動保持原驗證。
- broker `RuntimeRecord.homeDirectory: boolean` 由 Rust 依啟動請求推導並持久化，舊 metadata 缺欄位為 false。projectId 仍為 null；明確 cwd 的舊無專案 Shell 不會改為 home 策略。
- Workspace version 1 的 pane/tab `projectId` 接受明確 null；全域選取另存 `activeTemporaryTabId`。pane 保存 homeDirectory，但 Runtime ID／PID／startToken 仍不接受；broker reconcile 覆蓋策略與 cwd。
