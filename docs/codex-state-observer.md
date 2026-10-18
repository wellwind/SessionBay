# Codex 原生狀態觀察器

本模組保留 Codex 原生互動 TUI。使用者的提示、信任選擇、授權與模型呼叫仍由 Codex 處理；Session Bay 只讀取這次啟動所擁有之 app-server 的執行狀態。

## 啟動與所有權

- `codex_state::prepare` 以 argv 包裝原始 executable，不拼接 Shell 指令，不改寫使用者／專案設定、`notify` 或 hooks。
- PTY 的 session leader helper 啟動前景 `codex app-server --listen unix://…`，再啟動原生 `codex --remote unix://…`。兩者與其未自行脫離的子程序都留在 Runtime 擁有的同一 PTY session。
- 全新 TUI 以明確 `--cd` 傳遞 Runtime 的原始工作目錄（若使用者已指定則保留），讓 remote 模式仍執行原生 directory-trust 檢查。
- Server 不使用 daemon 管理／復原模式；不接入既有共享 server。隨機臨時目錄建立時即限定 `0700`，連線前檢查實際 socket 類型、擁有者及無 group／other 權限。允許 Codex 自己發佈至受保護實體 socket 的 symlink。
- Server 子程序設定 `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED=1`。上游會套用一次性的 remote-control disabled 模式，避免已保存的遠端控制註冊讓其他用戶端加入本次觀察範圍；使用者設定不變。
- helper 持有兩個 Child handle，正常離開先終止／回收；Runtime 在 helper 結束、關閉或強制停止時負責整個已擁有的 PTY session。沒有任意 PID 收養、`setsid` 或另行脫離的服務。
- 僅儲存臨時 socket，不複製憑證、逐字稿、Codex 歷史或設定檔。異常強制殺除可能留下無服務的臨時 socket；下一次啟動使用全新的目錄，不重用舊 socket。

## 唯讀協定

Unix socket 上使用 WebSocket JSON-RPC，而非逐行 stdio JSON。

只允許以下 RPC：

1. `initialize` 與 `initialized`
2. `thread/loaded/list`，最多 64 個本 server 已載入的 thread
3. `thread/read`，指定已知 thread ID 並固定 `includeTurns:false`

不呼叫 start、resume、fork、turn、approval、登入或歷史讀取 API。不訂閱 item／對話串流，也不回答意外收到的授權請求。未使用的通知、preview、路徑、內容等欄位直接忽略，不加入 JSON value tree、不轉送 broker、不記錄至日誌。

初始化名稱使用上游明列為 non-originating 的 `codex_app_server_daemon`，title 標示 `Session Bay read-only observer`。此相容性選擇讓觀察器不搶先改變原生 TUI 的全域 originator／User-Agent 或 gateway 自動登入政策；不宣告任何特殊授權能力。這是對 Codex 版本相關內部契約的依賴，不能視為永久穩定 API。

## 身分、狀態與失敗處理

`thread.id` 用於 metadata RPC；`thread.sessionId` 才是傳給 broker 的 session-tree 身分，兩者可能不同。不以 hook session ID 猜測 thread ID。

只有完整、穩定載入集合中的唯一 root 可提供狀態。root 必須明確提供 `parentThreadId:null`、`forkedFromId:null` 及有效 ID；子 agent 不代替主 session。多 root、fork、缺少欄位、超過數量上限或取樣途中載入集合改變時，狀態為 unknown。這些情形不阻止使用者繼續操作 TUI；目前不宣稱已支援 fork／多 root 的前景選取。

每次更新都是重新讀取的狀態快照，取樣間隔 250 ms，加上 RPC 耗時：

- `active` 且無等待旗標：Busy
- `waitingOnApproval`：AwaitingPermission
- `waitingOnUserInput`：AwaitingInput
- 兩者同時存在：優先顯示 AwaitingPermission
- `idle`：Idle
- `systemError`：Failed
- `notLoaded`、未知狀態／旗標或缺失證據：Unknown

Idle 是「目前未執行 turn」，不代表任務成功完成。少於取樣間隔的狀態可能完全沒有被看見，不補造 Busy、完成或中斷事件。metadata 不包含可靠的目前 turn ID，因此 report 的 turn 固定為 null。

來源 sequence 在 clear、session 轉換與 observer 重連期間持續遞增，不因重連歸零。失去連線會立即嘗試使上一筆來源狀態失效，重連仍只指向原來擁有的 socket。broker 收不到新證據時另有 TTL 保護。暫時空的載入集合不永久封鎖下一次合法 root 綁定。

啟動等待有上限；所有 resume／fork 啟動一律走原生模式，因為 remote resume 會還原 server 保存的權限，無法保證保留原始 CLI override 語義；目前不支援 resume／fork live status。若 profile v2 無法安全套用到 app-server，或 server 在啟動 TUI 之前無法就緒，會以固定訊息說明 live status 不可用，並以完全原始 argv 啟動原生 TUI。`-p`／`--profile` 不被改寫成另一種設定語義。只要 TUI 已經啟動，就不自動重新啟動它，避免重送 prompt／重複模型呼叫。原本指定其他 `--remote` 的啟動不接管觀察。

## 驗證與限制

2026-10-18：

- 在空白、隔離的 HOME／CODEX_HOME 執行已安裝 `codex-cli 0.159.2` 的 version、help、schema generation。確認 Unix remote／listen、metadata 與狀態欄位；沒有登入、真實歷史或模型呼叫。
- Rust 合成測試涵蓋狀態 mapping、身分分離、subagent／fork／多 root、缺失欄位、快照 sequence、訊息私密欄位排除、argv／profile 保留、目錄權限與清除。
- 記憶體內 WebSocket 假 server 回應涵蓋真正的 RPC 編解碼、初始化、metadata-only request allowlist、載入集合變動、空集合後恢復、錯誤 ID、未請求的 approval、斷線及拒絕 mutating RPC。
- 雲端環境阻擋原生 Unix socket／PTY 實測。上述結果不等同於 macOS／Linux 原生 app-server＋TUI 端到端驗證；該驗收仍需在允許 socket／PTY 的環境進行。
- Windows 未提供觀察器支援。

## 官方技術依據

對照已安裝版本 `rust-v0.159.2`（commit `ff6aec96948b70d94983af2641a6b67c94faeff5`），查閱日期 2026-10-18：

- [CLI remote、listen 與 profile 限制](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/cli/src/main.rs)
- [Unix WebSocket 與 private socket](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server-transport/src/transport/unix_socket.rs)
- [Non-originating initialize 行為](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/initialize_processor.rs)
- [一次性停用 remote control](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server-transport/src/transport/remote_control/mod.rs)
- [Thread metadata 與 session-tree 身分](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs)
- [原生 remote TUI 的 trust 檢查](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/tui/src/lib.rs)
- [Thread start／resume 參數與權限還原語義](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/tui/src/app_server_session.rs)
- [Thread status 與 metadata read schema](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
