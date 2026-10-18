# 真實 Provider 狀態（明確啟用）

## 操作與支援範圍

設定 → 來源與工具 → Codex／Claude／OpenCode →「啟用真實活動 hooks」→ 儲存。只套用後續由 SessionBay 啟動／恢復的程序。關閉並儲存會立即撤銷該 provider 現有回報，Agent 繼續執行。初始、來源不可信或失聯時保持未知，不以 PTY 輸出猜測。

目前正式來源限 Unix；Linux 為本輪檢查環境，macOS 原生 QA 仍待補。Windows、Grok、Antigravity 尚未接上這個正式 launch-local bridge；這不代表它們沒有原生 hooks。

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

### OpenCode >=1.19.2,<2（stable）

使用 child-only `OPENCODE_CONFIG_CONTENT` 載入 owner-private 暫存 `.mjs` 的絕對 file URI，不修改使用者／專案設定、原始 argv、HOME、既有 plugin 或 trust。既有 inline JSONC 保留原文，只插入 plugin；不能安全解析時拒絕 instrumentation，不捨棄設定。`--pure`／`OPENCODE_PURE` 仍停用 plugins，因此需關閉活動回報或自行移除該旗標，SessionBay 不替換它。版本 probe 只執行 `--version`，有3秒／8KiB上限，使用一次性 private HOME／XDG，不攜帶 provider credential 或 inline config；正式 Agent 的 HOME／XDG 保持原值。

- 新工作：只在 `chat.message` 後透過現有 provider client 的 `session.get` 驗證相同 native ID、啟動目錄與無 parentID，然後綁定 root。恢復工作先驗證原生 `ses_` ID。初始仍未知，不從程序存活或 status map 缺項猜測閒置。
- 原生 `session.status`：busy 工作中、retry 重試中、idle 閒置。idle 不是成功保證；背景 child／其他 root 的 status 不覆寫目前 root。新 root 必須再次由 causal chat 綁定，不能由第一個 status 自動切換。
- `permission.asked/replied` 與 `question.asked/replied/rejected`：以各 request ID 維護有界 pending 集合；最後一個相符請求解除後回到先前原生狀態。多個權限／問題同時存在時優先顯示權限等待。
- `session.error` 不是可靠的最終失敗事件，降為未知；隨後 idle 不冒充成功，需新的 busy/retry 才恢復連續觀察。刪除 Session、dispose、來源 schema 不符、metadata/helper 1秒逾時、queue 超限、來源項目排隊超過5秒或 IPC 失敗停止刷新，最遲30秒 lease 過期。

只保留 identifiers／狀態。SDK metadata 回應不保存，事件不讀 prompt、問題文字、答案、tool input、錯誤內容或 transcript。單一 process-local launch registry 防止 plugin 重載／多 instance 重設序號；僅接受啟動目錄的 instance。重新載入後保守未知，重開 pane 才重新建立來源。多目錄或未透過 causal chat 的 foreground 切換不宣稱已追蹤。

2026-10-18 Linux 以官方 npm `opencode-linux-x64@1.19.3` 固定 artifact 驗證 `--version`，並在全新 private HOME／XDG 與空白工作目錄執行 `debug config`：exit 0、stderr 0，sentinel wrapper 確認未改動的正式 plugin 註冊 chat.message／event／dispose 並完成 dispose。官方啟動依賴 `@opencode-ai/plugin@1.19.3` 以 `--ignore-scripts` 安裝於隔離 QA config；不讀寫使用者設定。未登入、未送 prompt、未呼叫模型。這只證明原生載入／卸載，Node 合成 host、合成 helper argv 與 Rust config／broker contracts 也不等同真實回合 E2E。1.19.2／1.19.3 為原始碼審閱版本；未來1.x仍需 schema 相容，2.x與 prerelease 拒絕。Windows owner-private staging／native QA 尚未完成，能力維持關閉。

### 重現 OpenCode 無模型載入驗證

先在獨立測試 prefix 安裝固定官方 `opencode-linux-x64@1.19.3` 與 `@opencode-ai/plugin@1.19.3`，皆使用 npm `--ignore-scripts --no-audit --no-fund --save-exact`。兩者使用不同 prefix；不要安裝到使用者 provider config。執行：

```sh
OPENCODE_BINARY=/absolute/private-binary/node_modules/opencode-linux-x64/bin/opencode \
OPENCODE_PLUGIN_DEPENDENCIES=/absolute/private-plugin-prefix \
node scripts/test-opencode-plugin-runtime.mjs
```

Runner 不執行安裝；明確檢查已安裝 package／lock 版本，建立 owner-private 暫存 HOME／XDG／空白 workspace，以不帶 auth／proxy／使用者設定的環境執行官方 `--version` 和 `debug config`。provider 的 dependency check 使用預先安裝的官方依賴並設定 npm offline／ignore-scripts。只輸出 loaded／disposed、hook 名稱與零 state reports 摘要，不輸出完整 config 或原始 stderr；有10／30秒 timeout 並清除自己建立的目錄。此流程已加入 Linux CI，官方套件安裝是獨立、可見的步驟。

## UI 與生命週期

轉動圖示表示 provider 回報的進行中回合；手掌／對話圖示表示 authoritative 權限／輸入等待；勾號表示閒置。PTY 新輸出亮點、未讀輸出與程序斷線／退出仍各自獨立。

每個來源回報嚴格遞增序號；新 root Session 旋轉 UI generation。來源接管後，舊 gateable callback 不得覆寫。每份來源快照有效 30 秒，沒有新來源證據不續期；明確失聯會嘗試立即回報未知；IPC 本身不可達時最遲30秒過期。程序退出、撤銷或 broker 重啟清除狀態。UI 不增加猜測性的問號。

## 隱私與撤銷

只傳遞 Session／回合識別、序號與狀態。Claude mod 不讀取提示、答案、工具內容或對話檔案。Codex metadata response 的非必要欄位在反序列化時跳過，不取得 turns／訊息內容，不保存原始回應。

不寫入全域／專案設定、PATH 或永久憑證。Claude／OpenCode plugin 存於 app-owned private temporary directory，僅含固定模組；路由在程序環境及 broker memory，metadata／log 不保存 capability。關閉設定、程序退出或啟動失敗清除 app-owned plugin。app UI 關閉時 broker 仍能接收；完整控制同一 OS 使用者的程式不在隔離保證內。

## 低階 command-hook 測試路徑

保留獨立的 launch-local command-hook driver 測試 callback binary → owner-authenticated IPC → broker → subscriber。它只把 UserPromptSubmit、PermissionRequest、Stop、Notification 等標為「最近收到」事件，Stop 不是完成，Notification 不是即時狀態。

callback 原始 stdin 上限 4 MiB，忽略私密欄位後才送 IPC。格式錯誤撤銷證據；合法但錯 session／陳舊 callback 被拒絕，不撤銷有效 parent。Classic Claude SessionStart 在 startup／resume／clear 可背景執行，不能當作所有 callback 的同步 barrier；正式 live route 使用原生來源直接註冊。低階路徑最多追蹤 128 個 prompt ID，超限要求重開；正式狀態來源不使用該限制。

## 驗證紀錄

2026-10-18 驗證分層（不把合成事件當作真實 Agent 回合）：

- PR56 `69e26df` Linux CI 全過：1206 個前端測試、13 個 Claude contract 測試、238 個 Rust library 測試與整合／browser suites。
- macOS production callback/socket/subscriber 合成 driver 修正後 4/4 通過；Claude 2.1.302 實際 plugin validate 通過。GUI 尚未完成，未送出驗收 prompt。
- Linux 官方 Claude Code 2.1.302，在獨立空 HOME/config 及工作目錄中實際執行 plugin validate 通過，辨識所有四個 lifecycle handlers；官方 npm 私有安裝、停用安裝 scripts，不讀取既有憑證。
- Linux 官方 Claude 2.1.302 plugin test runtime 8/8 通過：真正 compiler/runtime 驅動合成事件，process.run 已 stub，沒有真實 session、模型或 broker 呼叫。可用 `CLAUDE_BINARY=/absolute/path/to/claude node scripts/test-claude-plugin-runtime.mjs` 重跑；Linux CI 固定官方 npm 2.1.302 並停用安裝 scripts。
- Linux 官方 Codex 0.159.2 實際 app-server stdio initialize、thread/loaded/list 通過，空 Session list、正常退出；未送模型請求。這確認協定啟動，尚未證明原生 TUI 的回合狀態。
- 真實 CLI 回合 Busy→Idle 與 GUI 驗收仍未完成。Linux 無模型載入測試不等同真實回合驗收；需要另行準備可用登入／額度，不能複製其他裝置憑證。macOS／Windows 未原生驗收如實保留，依目前交付範圍不作 Linux 合併門檻。

### 後續正式來源與平台缺口

- Claude Windows：既有 broker 已有 owner-only named-pipe；仍需 bounded native version probe、Windows absolute helper path、owner-only plugin staging DACL 與實機 `.exe` callback 驗收。不能只移除 `cfg(unix)` 就宣稱支援。
- Codex Windows：官方0.159.2實際 `--help` 已確認 TUI `--remote`／`--remote-auth-token-env` 與 server `--ws-auth capability-token`／`--ws-token-sha256`。可再設計 owned loopback WebSocket、每次啟動的記憶體內 token 與 Job lifecycle；此路徑尚未實作或驗收，不能視為 Windows 已支援。
- Codex resume／fork／profile：目前保留原生 launch、活動未知。官方 command hooks 可跨平台，SessionStart 支援 resume／root fork，但 Stop 可續跑、notify 在 post-turn compaction 前發出，均不能當最終完成。需另一個官方狀態來源及 foreground activation epoch；不可把 fork-parent ID 當新 root ID，也不可假定換 session 必有 SessionEnd。
- OpenCode：Unix 正式來源已實作，細節與固定1.19.3無模型 runner 見上方；真實互動回合／等待及 macOS／Windows 原生驗收仍待補。不得把 loader 與合成 contracts 當模型回合 E2E。
- Antigravity >=1.4.0：官方 `AGY_CLI_OSC7501=on`／`AGY_CLI_OSC7501_MESSAGES=brief` 可發送 structured 狀態，不需修改全域設定。但 PTY 內其他程式可偽造來源，且協定沒有 heartbeat，必須另訂「terminal-reported」信任及生命週期；不混為 owner-authenticated hook。
- Grok：官方 `--plugin-dir` 僅對 `agent --no-leader … stdio` 生效，leader 會忽略，GROK_CONFIG overlay 也排除 hooks/plugins。既有互動 TUI 尚無已驗證透明 launch-local 注入，應另做 ACP/native-state 設計，不暗改 GROK_HOME 或全域設定。

驗收需分開列：官方二進位載入、官方 runtime 的合成事件、helper→broker→subscriber 合成傳輸、真正 Agent 回合及 GUI。Linux 通過不等於 Windows/macOS 已驗。

來源：
- https://opencode.ai/docs/config/
- https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/plugin/index.ts
- https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/session/status.ts
- https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/session/turn.rs
- https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/hook_runtime.rs
- https://github.com/google-antigravity/antigravity-cli/blob/86a5bdda81a063d707ac4ab87fb72f7dfe30ab67/CHANGELOG.md
- https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/09-plugins.md

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
