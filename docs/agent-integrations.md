# Session Bay Agent 整合規格

每個 Agent 透過 adapter 提供工具偵測、歷史列舉、對話解析與啟動規格。各家沒有可假定通用的本機歷史格式，支援範圍必須明列。

## 首批與候選範圍

| 工具 | 規劃狀態 | 範圍 |
| --- | --- | --- |
| Codex CLI | 建議 MVP | 本機可讀 Session、預覽、新建與恢復 |
| Claude Code CLI | 建議 MVP | 本機可讀 Session、預覽、新建與恢復 |
| agy | 後續候選 | 先研究其正式歷史格式與恢復能力 |
| Gemini CLI、OpenCode、Aider 等 | 後續候選 | 個別研究與能力聲明，不預先承諾支援 |
| 各工具桌面版、IDE 與雲端紀錄 | 分別評估 | 不因 CLI 支援就假定全數涵蓋 |

agy 曾用於命名發想，其歷史儲存整合尚未研究。執行過工具不等於具備穩定的歷史 adapter。

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

工具偵測考慮桌面 GUI 與互動式 Shell 的 PATH 差異。版本查詢有 timeout，使用者可手動指定執行檔；登入、金鑰與權限交由原 CLI 管理。

## Codex 本機來源

本次本機 metadata 觀察顯示，預設資料根目錄下有 sessions 與 archived_sessions 的 JSONL，Session metadata 包含 payload.cwd 與識別欄位。實作須尊重 CODEX_HOME 與使用者指定來源。

這些檔案路徑與欄位屬於版本相關的整合觀察，不視為穩定公開 API。需要以實際支援版本的去識別 fixture 驗證，容忍未知事件、缺失欄位與封存移動。不要只用 history.jsonl 作為完整 Session 清單。

啟動與恢復以 CLI 能力為準；基本恢復形式為 `codex resume <session-id>`。實作前以安裝版本的 help 核對參數與工作目錄行為。[Codex 官方 CLI 文件](https://learn.chatgpt.com/docs/codex/cli)

## Claude Code 本機來源

官方文件說明 CLI transcript 預設保存於 `~/.claude/projects/<project>/<session-id>.jsonl`。本次本機欄位觀察確認事件中可有 cwd、sessionId、timestamp 與 gitBranch；需尊重 CLAUDE_CONFIG_DIR 與自訂來源。[Claude Code Session 文件](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)

project 資料夾名稱可能來自路徑編碼，但編碼不保證可逆；優先使用紀錄內 cwd。需要處理子代理、分支、Session 搬移與不同事件格式。

`history.jsonl` 與 transcript 用途不同，前者支援輸入歷史回溯，不能直接代替對話解析。[Claude Code 目錄說明](https://code.claude.com/docs/en/claude-directory)

基本恢復形式為 `claude --resume <session-id>`。跨目錄解析、重複 ID 與背景 Session 行為依版本與原工具規則處理；不手動改寫 transcript 來強迫恢復。[Claude Code 恢復文件](https://code.claude.com/docs/en/sessions)

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
