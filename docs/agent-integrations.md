# Session Bay Agent 整合規格

每個 Agent 透過 adapter 提供工具偵測、歷史列舉、對話解析與啟動規格。各家沒有可假定通用的本機歷史格式，支援範圍必須明列。

## Agent 能力矩陣

2026-10-15 需求追加 Grok Build、Antigravity CLI 與每工具啟動選項；本表描述本批實作範圍，不等於真實 CLI 或原生平台驗收已通過。結果見 [驗證紀錄](mvp-validation.md#2026-10-15-agent-擴充與自訂參數變更紀錄)。

| 工具／kind | 預設執行檔 | 歷史搜尋與預覽 | 新工作／恢復 |
| --- | --- | --- | --- |
| Codex CLI／`codex` | `codex` | 支援既有本機 JSONL adapter | 新工作、索引 Session 恢復 |
| Claude Code CLI／`claude` | `claude` | 支援既有本機 JSONL adapter | 新工作、索引 Session 恢復 |
| Grok Build／`grok` | `grok` | 本批新增唯讀 summary／updates adapter | 新工作、索引 Session 或手動 ID 恢復 |
| Antigravity CLI／`antigravity` | `agy` | **尚不支援**，不提供該工具的歷史來源設定 | 新工作、手動 conversation ID 恢復 |
| Gemini CLI、OpenCode、Aider 等 | 未整合 | 個別研究 | 後續候選 |
| 各工具桌面版、IDE 與雲端紀錄 | 分別評估 | 不因 CLI 支援就假定涵蓋 | 不自動附接外部程序 |

工具名稱、可執行檔與模型供應商不同。此處 Grok 指 xAI 的 Grok Build CLI；Antigravity 指 `agy` CLI，並非同品牌 App 或 IDE 的通用歷史整合。

## Adapter 能力契約

```ts
interface AgentAdapter {
  kind: string;
  detectInstallations(): Promise<Installation[]>;
  discoverSources(): Promise<HistorySource[]>;
  scanChanges(source: HistorySource, cursor?: ScanCursor): AsyncIterable<SourceChange>;
  readTranscript(ref: TranscriptRef, cursor?: string): Promise<TranscriptPage>;
  planLaunch(request: LaunchRequest): Promise<LaunchSpec>;
}

interface LaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
```

此為邊界示意，未列型別在實作時補齊。adapter 產生啟動規格，Runtime Manager 才實際執行。能力欄位分別表示是否支援歷史、預覽、resume、fork 與 attach，不以單一 supported 布林值概括。

工具偵測考慮桌面 GUI 與互動式 Shell 的 PATH 差異。Grok 版本探測使用 `version`，其餘使用 `--version`，不帶自訂參數或危險旗標。版本查詢有 timeout，使用者可手動指定執行檔；登入、金鑰與權限交由原 CLI 管理。

## Codex 本機來源

本次本機 metadata 觀察顯示，預設資料根目錄下有 sessions 與 archived_sessions 的 JSONL，Session metadata 包含 payload.cwd 與識別欄位。實作須尊重 CODEX_HOME 與使用者指定來源。

這些檔案路徑與欄位屬於版本相關的整合觀察，不視為穩定公開 API。需要以實際支援版本的去識別 fixture 驗證，容忍未知事件、缺失欄位與封存移動。不要只用 history.jsonl 作為完整 Session 清單。

啟動與恢復以 CLI 能力為準；基本恢復形式為 `codex resume <session-id>`。實作前以安裝版本的 help 核對參數與工作目錄行為。[Codex 官方 CLI 文件](https://learn.chatgpt.com/docs/codex/cli)

## Claude Code 本機來源

官方文件說明 CLI transcript 預設保存於 `~/.claude/projects/<project>/<session-id>.jsonl`。本次本機欄位觀察確認事件中可有 cwd、sessionId、timestamp 與 gitBranch；需尊重 CLAUDE_CONFIG_DIR 與自訂來源。[Claude Code Session 文件](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)

project 資料夾名稱可能來自路徑編碼，但編碼不保證可逆；優先使用紀錄內 cwd。需要處理子代理、分支、Session 搬移與不同事件格式。

`history.jsonl` 與 transcript 用途不同，前者支援輸入歷史回溯，不能直接代替對話解析。[Claude Code 目錄說明](https://code.claude.com/docs/en/claude-directory)

基本恢復形式為 `claude --resume <session-id>`。跨目錄解析、重複 ID 與背景 Session 行為依版本與原工具規則處理；不手動改寫 transcript 來強迫恢復。[Claude Code 恢復文件](https://code.claude.com/docs/en/sessions)

## Grok Build 本機來源

預設資料 root 尊重 `GROK_HOME`，否則為 `~/.grok`。本批 adapter 依官方原始碼讀取 `sessions/<encoded-cwd>/<session-id>/summary.json` 與 `updates.jsonl`：summary 提供身份及 cwd，updates 的 ACP 訊息 chunk 提供對話文字；支援的 rewind marker 撤銷相應後續訊息，避免已撤回內容仍出現在搜尋／預覽。目錄編碼不能代替可信 cwd，未知或不完整資料依 partial／錯誤狀態呈現。[官方 session 原始碼](https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-shell/src/session)

實作只將支援的 user／agent 文字 chunk 納入搜尋／預覽，不索引工具輸出、推理或附件，也不把 `chat_history`／feedback 當作另一份對話。同一邏輯訊息的相鄰文字 chunk 會合併，保留跨 chunk 的詞句搜尋及完整預覽；批次更新索引，避免每個 token 重建整段 FTS。訊息角色／非文字事件與 rewind 邊界分開處理，空 chunk 不切斷詞句。標題優先取 `generated_title`，活動時間優先取 `last_active_at`；支援的 legacy raw ACP 與 Unix 秒數 envelope 另有合成測試。summary cwd 與目錄解碼或 hashed 目錄的 `.cwd` 核對，衝突時不顯示衝突正文且阻擋恢復。僅有 summary 的列可顯示，但缺少 stream 不可恢復；summary／`.cwd` 改變須刷新，刷新前 stale 預覽／恢復被阻擋。

這是版本相關的儲存實作，並非穩定公開 transcript API。不解析登入資料，不修改來源。恢復為 `grok --resume <id>`，cwd 獨立設定；索引來源以 `GROK_HOME` 傳入。手動 ID 不建立虛構 catalog Session；同工具、canonical 來源及外部 ID 的執行中恢復仍會去重，包含同來源 Grok 手動／索引兩種入口。多個已啟用 Grok 來源時拒絕手動恢復歧義，應改選索引 Session 或僅啟用目標來源。[Grok CLI reference](https://docs.x.ai/build/cli/reference)

## Antigravity CLI 的明確邊界

啟動執行檔為 `agy`，指定對話使用 `agy --conversation <id>`。新增工作可留空 ID；有 ID 時交由原 CLI 載入。手動 ID 與 catalog 的 `sessionId` 不同，不保證本機存在、已登入帳號可讀或成功恢復。[官方 resume 文件](https://antigravity.google/docs/cli/commands/resume/)

官方 hooks 文件提供 `transcriptPath`，也區分 CLI、App 與 IDE 的資料位置；但這不足以確認 transcript 事件 schema、分支與完整恢復語意。本批不據此聲稱已支援 Antigravity 歷史索引、搜尋、預覽或桌面／IDE 整合，亦不讀取其憑證。[官方 hooks 文件](https://antigravity.google/docs/hooks)

## 每個 Agent 的自訂參數與危險模式

`Settings.agentOptions` 以四個 kind 分別保存 `{ extraArgs: string[], bypassPermissions: boolean }`。舊設定缺少選項時補為空陣列與 `false`；新增執行檔欄位補成 `grok`／`agy`，不變更使用者既有權限選擇或已保存的來源清單；既有設定需自行新增 Grok 來源，全新設定才預置 `grok-default`。

設定中的參數使用 JSON 字串陣列，例如 `["--model", "your-model-id"]`；每個元素就是一個 argv，含空白的值仍是一個元素，不需要 Shell 引號。最多 64 個非空參數，每項最多 8 KiB，不允許 NUL。模型 ID 需依安裝的 CLI 與帳號能力選擇。

後端採工具專屬白名單，檢查 switch／帶值參數及已知權限值；未知參數、任意子命令、位置參數、工作目錄、來源、Session ID 與 config override 均不能繞過啟動計畫。這不是可任意填入整條 Shell 命令的欄位；完整白名單以 `src-tauri/src/launch_options.rs` 的 `supported_options` 為準，驗證錯誤也會列出可用選項。常用選項包括四工具的 `--model`、Claude／Grok／Antigravity 的 `--effort`，以及各工具自己的權限／沙箱選項。

危險選項必須先明確勾選該 Agent 的高風險選項。預設不追加跳過權限旗標，不會只因填入 `--yolo` 就繞過同意；原 CLI 自己的設定仍可能影響實際權限，Session Bay 不強制覆蓋它。勾選並保存一次後，之後啟動沿用，Session Bay 不再逐次彈出確認；啟動器仍標示風險。CLI 登入、工作區信任或管理政策可能另外要求操作。

| Agent | 沒有明確自訂權限模式時追加的預設 | 實際意義 |
| --- | --- | --- |
| Codex | `--dangerously-bypass-approvals-and-sandbox` | 取消 CLI 審批與沙箱；`--yolo` 是同義旗標 |
| Claude Code | `--dangerously-skip-permissions` | 使用 CLI 的略過權限模式；不承諾略過所有外部政策 |
| Grok Build | `--always-approve` | 自動核准工具；`--yolo` 同義，**沙箱是獨立設定** |
| Antigravity CLI | `--dangerously-skip-permissions` | 自動核准工具權限請求；不宣稱等同 Codex 的移除沙箱 |

旗標依據：[Codex](https://learn.chatgpt.com/docs/developer-commands?surface=cli)、[Claude](https://code.claude.com/docs/en/cli-reference)、[Grok](https://docs.x.ai/build/cli/reference)、[Antigravity](https://antigravity.google/docs/cli/headless/)。不同工具的危險模式不能互換解讀。

自訂明確權限模式優先：例如勾選後為 Codex 指定 `["--ask-for-approval", "never", "--sandbox", "workspace-write"]`，不再自動追加全域 bypass；Claude 的 `--permission-mode plan`、allow／deny 工具清單等明確受限設定也不被全域 bypass 預設覆蓋。危險旗標、放寬權限／額外可寫目錄等仍需 opt-in。Grok 的 `--sandbox` 本身不取代 auto-approve 設定；Antigravity 的 `--sandbox` 可與其權限模式分開指定。取消勾選後，若陣列仍有需同意的選項，保存會被拒絕，需同時移除或調整。

`preview_launch` 與 `launch_runtime` 共用後端 `plan_launch`，預覽回傳 executable、精確 argv 與 cwd，不啟動程序，也不回傳環境變數或憑證。真正啟動會再做預檢；來源與 cwd 在其間改變仍可能使啟動失敗。執行使用獨立 executable、argv、cwd 與受管 env，絕不把顯示文字送進 Shell 解析。設定明文保存於本機，參數欄位不應放入金鑰、密碼或 token。

## 統一 metadata

### Session 顯示名稱

名稱與唯一 ID 分開。Codex 額外唯讀解析所選資料 root 的 `session_index.jsonl`，以 `id` 對應 `thread_name`，有可比較的 `updated_at` 時採較新名稱；這些欄位是版本相關格式，需用 fixtures 驗證。名稱檔變更會獨立同步，即使 transcript 沒變也能更新，移除名稱後回退至 transcript 的標題或工作需求。

Claude 的 `custom-title`／`customTitle` 優先於 `summary`。兩工具均在無來源名稱時尋找首則實際工作需求：略過已知開頭的 AGENTS.md 指令、環境上下文與中斷通知。此規則只影響備援標題，不刪改對話或搜尋內容，也不透過模型產生名稱。parser 版本升級後，既有索引會在掃描時重新解析。

每個來源的名稱獨立對應，不跨 root 合併同 ID。恢復流程仍傳入 Session ID；同名對話不因名稱而被誤認為同一工作。工具命名能力見 [Codex 官方命令](https://learn.chatgpt.com/docs/developer-commands)與 [Claude Code Session 文件](https://code.claude.com/docs/en/sessions)。

### 一般欄位

每個 Session 保存外部 ID、agent kind、來源 ID、原始 cwd、分組目錄、標題、開始與最後活動時間、封存狀態、父 Session 關係與來源 locator。

欄位缺失時保留 null 與明確 fallback。來源缺失不等於空對話；metadata 可讀、正文部分可讀與完整可讀應分開表示。壓縮後 transcript 不保證保留所有原始上下文。

## 目錄分組規則

1. 保存原始 cwd，不因正規化而丟失來源資訊。
2. MVP 以有效且可辨認的工作目錄作為專案分組基礎。
3. 目錄存在時可使用 canonical path 作輔助身份；失效路徑保留原始 key。
4. 大小寫規則需依實際檔案系統處理，不全域轉小寫。
5. symbolic link 指向同一位置時允許合併呈現，但保留別名與原始啟動路徑。
6. Repo、子目錄與 worktree 的合併列為 P1；同 Repo 不代表同一工作環境。
7. 若對話中途換目錄，保留時間脈絡。分組採明確的主要 cwd 規則，啟動 cwd 由 adapter 恢復行為決定，不能任選第一筆或最後一筆。
8. 使用者重新定位只建立 Session Bay 的 launch override，不移動或修改原紀錄。
9. 目錄分組只用於 catalog 身份與歷史查詢，不自動加入左側專案；`curated` 由使用者選擇維護。所有工作階段保留未加入目錄的歷史。
10. 加入、移出與更名不改原始 cwd、恢復參數或來源資料；直接接續未加入專案的 Session 也不隱含加入。

## Session 與程序關聯

由 Session Bay 啟動且取得可靠 ID 的 Session 才能標示為已關聯。對新 Session，可使用工具公開事件、正式 hook 或其他可驗證訊號；只以「目錄相同且剛產生檔案」配對可能誤認並行工作。

未確認時顯示「未關聯」。普通 Terminal 手動開 Agent 不自動轉型。PID、檔案 mtime、程序名稱與 prompt 文字都不足以單獨證明某個歷史 Session 正在執行。

跨工具的 resume 是恢復原工具保存的對話；跨 Agent 交接是產生另一份可檢視的上下文材料。兩者使用不同操作與資料模型。

## 相容性與資料品質

建立去識別 fixture，覆蓋標準 Session、無標題、缺 cwd、半行 JSONL、壞行、未知事件、截斷、替換、封存、子代理、分支、重複來源與多語言內容。

解析器版本升級時能重建索引，不要求使用者修改原工具資料庫。來源資料在外部被刪除後，清理本機衍生索引，避免造成已刪對話仍被永久搜尋的落差。

## MVP 後的用量整合能力

P1 為各 adapter 增加獨立的用量能力聲明，區分帳號額度、歷史 token、即時 token、請求數、來源回報金額及費用估算；歷史可讀不代表每個指標都可取得。

來源評估需記錄支援版本、auth mode、帳號／工作區身份、事件 ID、Session 關聯、時間粒度與 delta／累計語意。Codex 優先評估官方 App Server 與本機紀錄；Claude Code 評估本機紀錄及選用本機 OTel，訂閱額度另驗證受支援來源。OpenUsage 的本機輸出可列為候選額度來源，不視為 Session 事件來源。

usage 解析保留來源 locator 與 token 包含關係。resume、fork、子代理與重複來源必須有去重 fixtures；缺少帳號或 Session 身份時輸出未歸屬，不用目前登入狀態回填歷史。新增工具時沿用同一能力矩陣與降級規則。

完整指標與資料邊界見[用量規格](usage-spec.md)。本節不要求修改原工具的 transcript、設定或憑證。

## 支援限制

只能顯示存在、可讀且格式受支援的本機紀錄。雲端限定、其他帳號、其他裝置、已清除或未保存的歷史不自動涵蓋。工具更新若改變格式，個別 adapter 可降級顯示 metadata，不影響其他 Agent 與普通 Terminal。
