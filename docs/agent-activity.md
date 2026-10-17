# Agent 活動 hook 基礎

## 目前交付與未交付

2026-10-17 的候選只提供 `agent_activity` 純函式 adapter、短期記憶體 observation reducer、共享 provider registry 契約，以及未知活動圖示清理。所有 provider 的 `activity.transport` 都是 `notImplemented`。**沒有 production 事件入口，也沒有真實 Agent busy／idle 顯示。** PTY 輸出與程序存活不能替代 hook。

不修改 `~/.claude`、`~/.codex`、Grok／Antigravity／OpenCode 設定，不新增執行命令、socket、HTTP listener 或 credential。測試全為合成資料。UI 只把已存在的生命週期／輸出提示放到分頁名稱左側，移除問號與未亮的輸出點；無障礙 description 繼續提供生命週期。

## Adapter 契約

每個 adapter 由同一份 `src/agent-manifest.json` 指定，Rust 驗證 provider 與 adapter 配對，TypeScript 明確標示 transport 尚未實作。

| Provider | 此輪接受的身份與格式 | 已正規化觀察 |
| --- | --- | --- |
| Codex | `hook_event_name`、`session_id`、可選 `turn_id` | prompt submitted、tool pending/finished、permission requested、stop requested、interrupted、session ended |
| Claude Code | `hook_event_name`、`session_id`、可選 `prompt_id` | prompt/tool/permission/stop、StopFailure、session ended |
| Grok Build | PascalCase alias `hook_event_name`、`sessionId`、可選 `promptId` | prompt/tool/stop、session ended；Notification 的 `notificationType=permission_prompt` |
| Antigravity CLI | 由可信 registration 提供 event name，payload 的 `conversationId` | invocation started/ended、tool pending/finished、stop requested |
| OpenCode | v1 `type` + `properties.sessionID` + `properties.status.type` | `session.status` 的 busy／idle／retry observations |

Grok 原生 `hookEventName` 是 snake_case；此輪明確只接受官方提供的 PascalCase alias，不猜測欄位大小寫。OpenCode v2 開發版本的 `data` envelope 不與 v1 混讀，兩欄同時存在也拒絕；v1 此輪只解析 session.status，未涵蓋所有 plugin events。Antigravity 沒有已確認的 permission/input-wait 或 parent-child 路由欄位，不能猜測補上。

這些是**曾發生的 observation**，不是持續的 Agent 狀態。四種 CLI 的 Stop 都可被 gate 繼續：Antigravity 即使 `fullyIdle=true` 也不能當最終 idle。PostInvocation 只代表一輪 model invocation；PostToolUse 只代表工具結束。PermissionRequest 可能被另一個 hook 自動決定，不能直接顯示「等待你」。未知事件／未知 OpenCode status 清空舊 observation，不延續假工作中。

輸入最多 64 KiB；無效 JSON、缺少身份、控制字元、錯誤 registration、版本衝突均拒絕。身份限 512 bytes，不保留 prompt、tool input、paths、transcript 或 permission reason。Claude/Codex 的 agent_id／Subagent 事件與 Grok child markers 不更新父 session。OpenCode child session 有不同 sessionID，靠精確 binding 隔離，不能從 status 本身推導 ancestry。

## Reducer 與安全界線

- 一個 tracker 綁定 runtime ID、launch generation、provider、provider session ID；**binding 相等不代表身分認證**。
- 輸入 sequence 必須由已認證且有序的未來傳輸提供；從 1 開始，duplicate／replay 不更新，gap 清空 observation 並關閉該 generation，必須重新驗證與同步；下一個 callback 不能恢復信任。
- 新 prompt 的 opaque turn/prompt ID 取代舊 ID；舊 turn callback 不蓋掉新 turn。缺少應有的 turn ID 時保守清空，不依字串排序推斷新舊。最多記住 128 個 turn ID；重複 prompt 不重開舊 turn，也不延長 freshness；超過容量時關閉 generation，不能丟掉 replay fence 繼續猜測。
- observation 使用主機 monotonic time，30 秒後只回到 unknown，絕不推斷 idle。此 TTL 是保守顯示有效期，並非 provider 心跳承諾。
- 斷線、可信來源解析失敗需由未來 transport 呼叫 invalidate；runtime exit 呼叫 close，關閉後不能復活；SessionEnd 也封鎖同 generation 的後續 callbacks，只保留該 observation 至 TTL，不宣稱 PTY 已退出。重連建立新 generation，舊 observation 不保存至 workspace/catalog。
- 目前 reducer 不能證明 async hook 的原始因果順序；並行 callback 的抵達順序不是 provider 序列。它不處理這個尚未解決的 transport 問題，也不宣稱 source ID／binding 能防偽造。

## 下一階段退出條件（尚未實作）

1. 為每個已驗證 CLI 版本設計 opt-in launch-local registration，不修改全域設定；任何必須建立持續存取／修改真實設定的流程另行明確確認。
2. Broker 擁有每次啟動的短期 capability 與安全 IPC，嚴格限制 peer、runtime/session/root-child 路由、大小、速率及生命週期；不把 secret 放在 argv／log／URL。不提供跨使用者 listener。
3. 提供可信事件順序／turn 邊界、重複／遺失／舊 callback 驗證，處理 hook 並行、繼續 Stop、auto-approval 與快速連續 prompts；無法確認時維持 unknown。
4. Broker snapshot/reconnect 加入能力協商與新 generation；exit／transport loss 不被舊回覆覆蓋。UI 只投影已確認能力，不啟用問號或推測 spinner。
5. 合成端到端測試通過後，在 opt-in 真實 CLI 及 macOS／Linux／Windows native WebView 驗證。Parser 測試、瀏覽器截圖、CI 不能冒充原生 hook 驗收。

官方來源與版本限制見 [技術來源](sources.md#2026-10-17-agent-活動-hooks)。

## 驗證記錄

- 本地 typecheck、ESLint、production build 通過；52 個前端檔案、1,174 個測試通過。
- Rust 核心 library 195 個測試通過（含 13 個活動 hook/reducer 測試）；兩個既有 socket/broker 測試先實際遇到 sandbox `EPERM`，最後重跑明確排除，並非完整 Rust suite 通過。
- `cargo fmt --check` 與 no-default-features、all-targets Clippy `-D warnings` 通過。
- 系統 Chromium 保持 sandbox 啟用；啟動因 Unix socket `Operation not permitted` 中止，六項瀏覽器驗收未能執行，沒有本地截圖。保留更新後的 existing agent-status Playwright 接受測試，由 exact-commit Linux CI 取得 UI 證據。
- 真實 provider hooks、desktop build、macOS／Windows native QA 未執行；本輪未更動任何真實 Agent 設定。


首輪 exact-commit CI（a0d5f7e）已通過六項 Agent-status browser acceptance，1200／1000px 截圖已檢視：已知狀態在名稱左側，未知不畫問號。Tab reorder 舊測試把 screen-reader-only description 納入完整 textContent 比較，因此改為驗證實際 `.workspace-tab-name`；名稱、accessible name/description 與拖曳保存流程分開驗證。完整 CI 仍以最後 head 的結果為準。
