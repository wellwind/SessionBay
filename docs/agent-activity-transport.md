# Agent 活動傳輸：明確啟用的 ordered bridge

2026-10-18 更新：Codex／Claude 的 launch-local 真實 hook 註冊與撤銷實作見 [provider-hooks](provider-hooks.md)。以下保留 #54 ordered transport 的原始範圍與驗證邊界。

## 本輪範圍

在 [#53 observation 基礎](agent-activity.md) 上接通現有 broker → subscription → TerminalPane → 左側狀態圖示。共享 registry 的 `activity.transport=orderedBridgeOptIn` 表示程式 API 可用；**所有真實 Agent 啟動仍預設不啟用、沒有自動 hook 安裝，也沒有已完成的真實 CLI 整合宣稱。**

此輪只在合成、app-owned 測試啟用 publisher；沒有修改使用者 Agent 設定、永久憑證、網路規則或權限。一般啟動與未設定的 provider 不顯示推測活動。

## 安全與順序邊界

沿用既有 Unix owner-only directory/socket + peer UID、Windows named-pipe ACL/peer 檢查，沒有另一個 socket／TCP listener。publisher 的短期 capability 只屬於單一 runtime/stream/generation，存於記憶體、不寫 workspace/session metadata、argv、log 或 URL。這不宣稱能防禦已完整控制同一 OS 使用者的攻擊者；現有 broker 也以同一使用者為信任邊界。

明確啟用 publisher 需已知活 runtime、provider 與 provider session ID。輸入只能走單一 ordered bridge，不為真實並行 hooks 自動建立因果順序。錯誤身份、舊 capability／generation、replay／gap、格式／大小／速率違規不能更新別的 runtime 或復活過期證據。stream 關閉、broker/runtime 結束與重新啟用各自撤銷舊觀察。

真實 Codex／Claude／Grok／Antigravity 的 hook callback 可能平行、gateable 或延遲，仍需明確的 provider-specific causal bridge 才能啟用；不可把任意到達順序編號就宣稱可靠。OpenCode v1 session.status 較直接，但仍須驗證安裝版本、session ancestry 與 source stream。官方格式限制沿用 [技術來源](sources.md#2026-10-17-agent-活動-hooks)。

publisher 透過 `BrokerClient::open_ordered_activity_publisher(runtime_id, provider, provider_session_id)` 明確開啟，取得不可 clone 的 stream handle；`publish(registered_event, payload)` 依序送出，drop／close 撤銷。每個原始 payload 最多 64 KiB、每秒最多 120 事件；partial frame 有 deadline。publisher 最多佔用 32 個連線槽，與既有 64 槽上限分開限制，保留控制請求容量。

## App wire 與生命週期

`agentActivity` 事件使用 runtimeId、generation、revision、observation 和 validForMs，不使用 terminal output sequence。Poll 有新增能力協商與 opt-in；舊 broker/client 不會收到不認識的 event。App 不向 PTY ACK 這些事件，也不把它們送進 xterm、當作新輸出或標記未讀。

broker 提供剩餘有效時間，UI 使用 monotonic time：重複 revision 不延長 TTL，重新附接只接受剩餘期限，過期回到 unknown。UI 綁定當前 attachment lease/runtime，拒絕舊 generation/revision；中斷／退出立即清除，之後 queued callback 不能復活。UI 的 retired generation fence 有界，超過上限保守隱藏直到重新附接，不丟掉 fence 猜測。

tooltip 以「Agent 最近回報：…」描述觀察，不宣稱目前持續狀態。Stop 是「收到回合停止請求」，PermissionRequest 是「收到權限請求」，不是 idle 或等待人類。OpenCode busy/idle/retry 仍以有期限的 provider 回報呈現。狀態圖示維持名稱左側；未知與未配置不加問號。

## 合成端到端驗證

- Rust：實際 owner-authenticated socket 的 publisher → broker → client subscriber；另測錯誤路由、replay/gap、expiry、stream close/reconnect、runtime exit 與舊 client。
- 共享 `fixtures/agent-activity/busy-event.json`：Rust serde 與 UI 使用相同 wire；不含真實 Session 或對話。
- actual-App browser：同一 wire 進入 TerminalPane，確認專案／workspace 分頁左側圖示、TTL、Stop 不變 idle、generation fence、disconnect 不復活，且無 PTY output／unread 副作用。
- 這些測試分別覆蓋 socket backend 與 actual-App 前端 seam；**不是同一個真實 CLI→原生 WebView 的驗收**。真實 hooks 與三平台 native QA 仍待明確 opt-in 後完成。
