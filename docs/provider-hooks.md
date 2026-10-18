# 真實 Provider 狀態（明確啟用）

## 操作與支援範圍

設定 → 來源與工具 → Codex／Claude →「啟用真實活動 hooks」→ 儲存。只套用後續由 SessionBay 啟動／恢復的程序。關閉並儲存會立即撤銷該 provider 現有回報，Agent 繼續執行。初始、來源不可信或失聯時保持未知，不以 PTY 輸出猜測。

目前為 macOS／Linux。Windows、Grok、Antigravity、OpenCode 尚未接上這個正式 launch-local bridge；這不代表它們沒有原生 hooks。

### Claude Code >= 2.1.287

本次啟動以 `--plugin-dir` 載入最小 mod，觀察現有互動流程的主回合：

- `turn.start`：回合進行中。
- `turn.complete`：依結果回報閒置、中斷或失敗。只有相符主回合能結束目前狀態，子 agent 不覆寫主回合。
- `session.end`、重新載入、來源錯誤：未知；不從啟動成功推斷閒置。

「工作中」指主回合進行中，不等於模型持續運算。本來源目前不能區分回合內的權限／輸入等待。mod 每五秒重送由原生生命周期維護的狀態，並確認目前 Session；單純程序存活不會產生工作中。既有管理政策、mod 信任及禁止 sideload 仍生效，SessionBay 不繞過。

### Codex

本次 PTY 擁有一個 private Unix app-server，原生互動介面以 `--remote` 連入。唯讀 observer 僅做 initialize、thread/loaded/list、thread/read(includeTurns:false)，不呼叫 thread/start、thread/resume 或 turn/start，不會為狀態另送模型請求。

provider status 決定工作中、等待輸入、等待權限、閒置／錯誤。只接受可識別的單一 root；多 root、子 agent、載入競態、來源識別不明及通訊錯誤均保持未知。使用 session-tree ID 綁定，不把 thread ID 當成同一識別。

不覆寫使用者原有 hooks 或 notify。不能安全保留 profile 設定的模式及不相容 app-server 版本保留原生使用流程並明確提示不提供狀態；任何已啟動 TUI 的回合不會自動重送。詳見 `codex-state-observer.md`。

## UI 與生命週期

轉動圖示表示 provider 回報的進行中回合；手掌／對話圖示表示 authoritative 權限／輸入等待；勾號表示閒置。PTY 新輸出亮點、未讀輸出與程序斷線／退出仍各自獨立。

每個來源回報嚴格遞增序號；新 root Session 旋轉 UI generation。來源接管後，舊 gateable callback 不得覆寫。每份來源快照有效 30 秒，沒有新來源證據不續期；明確失聯會嘗試立即回報未知；IPC 本身不可達時最遲30秒過期。程序退出、撤銷或 broker 重啟清除狀態。UI 不增加猜測性的問號。

## 隱私與撤銷

只傳遞 Session／回合識別、序號與狀態。Claude mod 不讀取提示、答案、工具內容或對話檔案。Codex metadata response 的非必要欄位在反序列化時跳過，不取得 turns／訊息內容，不保存原始回應。

不寫入全域／專案設定、PATH 或永久憑證。Claude plugin 存於 app-owned private temporary directory，僅含固定模組；路由在程序環境及 broker memory，metadata／log 不保存 capability。關閉設定、程序退出或啟動失敗清除 app-owned plugin。app UI 關閉時 broker 仍能接收；完整控制同一 OS 使用者的程式不在隔離保證內。

## 低階 command-hook 測試路徑

保留獨立的 launch-local command-hook driver 測試 callback binary → owner-authenticated IPC → broker → subscriber。它只把 UserPromptSubmit、PermissionRequest、Stop、Notification 等標為「最近收到」事件，Stop 不是完成，Notification 不是即時狀態。

callback 原始 stdin 上限 4 MiB，忽略私密欄位後才送 IPC。格式錯誤撤銷證據；合法但錯 session／陳舊 callback 被拒絕，不撤銷有效 parent。Classic Claude SessionStart 在 startup／resume／clear 可背景執行，不能當作所有 callback 的同步 barrier；正式 live route 使用原生來源直接註冊。低階路徑最多追蹤 128 個 prompt ID，超限要求重開；正式狀態來源不使用該限制。

## 驗證紀錄

2026-10-18 native 已安裝 Codex 0.163.0、Claude 2.1.302。版本確認不等同 lifecycle 驗收。首輪 production callback/socket/subscriber 合成 driver 2/3 通過，找出錯 session 拒絕時誤撤銷 parent 的問題，已修並增加 regression，等待 exact-head CI/native 重跑。真正 provider turn 與 GUI 驗收仍進行中，不能把合成 callback 測試說成真實 Agent 已通過。

官方來源：
- https://code.claude.com/docs/en/plugins/mods/overview
- https://code.claude.com/docs/en/plugins/mods/create
- https://code.claude.com/docs/en/plugins/mods/events
- https://code.claude.com/docs/en/plugins/mods/api
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/developer-commands?surface=cli

### 隔離 GUI 驗收

使用固定 build／bundle 身分，不為每一步重新安裝。先在 app-owned QA 目錄建立完整 `settings.json`，`sources: []`，指定已安裝的 executable，`agentHooks: {codex:true,claude:true}`，`onboardingComplete:true`，不從原 app settings 複製任何來源。以 `SESSIONBAY_SMOKE=1 SESSIONBAY_SMOKE_MANUAL=1 SESSIONBAY_SMOKE_APP_DATA=<絕對 QA 資料目錄>` 啟動 bundle executable。這會驗證空白來源並使用隔離 catalog，但不自動點 UI；保留原 HOME 讓 provider 自行使用既有登入，不由測試讀取或複製 credential。Provider 自己仍會讀取通常的全域設定／個人指示，因此不能宣稱該部分完全空白。不要加 `--bare`、清空 CODEX_HOME 或複製 auth files。

先跑合成測試及 Claude plugin validate，不送 prompt。經明確授權後，從空白測試工作目錄新建各工具 pane，各只送一次「只回覆 OK，不讀寫檔案、不執行工具」。記錄 provider 版本、可見工作中／閒置圖示和 tooltips；沒有看到就記錄未驗證，不重複呼叫模型。若要求登入、信任或額外權限，依允許範圍停下，不自動接受。
