# 持續執行與重新附接

## 使用方式

關閉 Session Bay 視窗或退出介面時，已開啟的 Shell／Agent 留在本機背景繼續執行。重新開啟時，所有保存分頁與面板會和 broker 的實際程序狀態對照；仍在執行的面板重新附接同一個 runtime，不重新執行啟動指令。若介面在布局保存前意外退出，broker 知道的面板仍會出現在還原工作區。

「停止」會結束該面板的受管程序；「關閉面板」仍會確認並停止該程序，再移除記錄。已完成的 Shell 面板不再因 exit code 0 自動消失，避免回來時找不到結果。

### 狀態含義

- `running`：broker 的原始受管程序仍活著。
- `stopping`／`unknown`：停止／清理尚未能確認，不可當成安全完成。
- `exited`／`failed`：程序完成或執行失敗，保留 exit code 與 broker 記憶體中的最後畫面。
- `disconnected`：這個 UI 無法讀取 broker／渲染已逾時。程序可能仍在背景，重連不能被替換成重新啟動。
- `interrupted`：broker 或電腦重新啟動後，上次的 live metadata 已失去原始程序所有權。只能由使用者明確決定重新啟動，不操作任何舊 PID。

若 broker 已崩潰或版本已變更，請重新開啟 Session Bay 取得新的 authoritative metadata；目前的「重連」只重試原 broker generation，不會暗中重新啟動 broker 或程序。

關機、重新開機、登出造成 OS 結束程序，或 broker 本身崩潰，不等於單純關閉介面。這些情況不能保證原程序延續。刻意脫離 Unix session／Windows console 的子程序，仍在原平台 runtime 已記錄的所有權邊界之外。

## 實作與安全邊界

桌面執行檔在建立 WebView 前辨識內部 broker 模式。Unix 子程序使用新 session 並將標準串流接到 null；Windows 使用 detached process／new process group。UI drop／exit 沒有 broker stop side effect。

- 同一資料目錄只有持有 OS 檔案鎖的 broker 可以建立 endpoint。鎖由 OS 回收，沒有依 PID 找回或殺掉其他程序的流程。
- Unix 的資料與 socket 子目錄為 0700，檔案／socket 為 0600；驗證 owner UID，拒絕符號連結與可被其他使用者存取的既有目錄／鎖。socket 放在依 canonical 資料目錄雜湊的短 `/tmp` 路徑，以符合 macOS 104-byte Unix socket 限制。
- Windows 目錄與 named pipe 使用目前 token user 的 SID、protected DACL；查核 owner／ACL，拒絕額外授權及 reparse directory／lock。Named pipe 使用本機名稱與 interprocess 的 remote-rejection 預設，不監聽網路。
- 每個連線先驗證 OS 身分／ACL，再傳送啟動資料；protocol generation 阻擋已重啟 broker 的舊請求。launch／write／stop 的不確定結果不自動重送。
- IPC 每個請求最多 1 MiB、回應最多 16 MiB；最多 64 個處理中的連線，讀寫 deadline 8 秒。PTY 輸入仍使用底層 256 KiB 上限。UI 每次只交付一個待 ACK frame，30 秒沒有渲染 ACK 只斷開這個 renderer。
- Broker 每個 terminal 保留最多 1 MiB／128 個 replay frame、200 行 scrollback，最多 32 個同時執行／128 個保留面板；尺寸上限 320×120。超出 replay 的 reader 重新取得 snapshot，顯示較舊輸出已省略。
- 超長 OSC／DCS 最多暫存 4 KiB 後捨棄；OSC 52 不傳送到 UI。UTF-8／escape 必須完整才進入畫面與 replay，避免重連邊界把半個字或控制序列當成新輸入。
- metadata 只存 runtime UUID、pane、專案、工具、工作目錄與狀態，不存 PID、啟動 argv、環境、終端輸入／輸出或認證資料。只有 metadata 改變時才原子更新；原始 Agent 歷史仍唯讀。

## 終端相容性

Broker 使用 vt100 重建 normal／alternate screen、游標、SGR 顏色、常用輸入模式及有限回捲。重連後仍由 xterm.js 互動；broker 會在無 UI 時回答基本 DA／DSR 游標查詢與 OSC 10／11／12 前景、背景、游標色查詢。顏色查詢目前回報固定 Bay 預設色盤，未與 UI 即時主題同步；不宣稱支援所有 terminal queries。

這不是完整 xterm 狀態序列化。Sixel／Kitty 圖片、特殊私有序列、hyperlink／完整 terminal feature negotiation，以及各家 Agent 的進階 TUI，仍需逐項原生驗收。保留畫面與回捲均有上限，不能當永久執行紀錄；broker 重啟後，已退出面板僅保留 metadata，沒有之前的輸出。

## 驗證與待驗

測試包含獨立 broker executable 與合成 Shell 的 client-drop／重開、同 runtime UUID、關閉 UI 期間輸出、再送輸入、lease 過期、明確 stop／forget、已完成畫面與 metadata interrupted。Windows 另有原生 named-pipe／ConPTY reconnect 與 ACL fixture；交叉編譯不表示這些已執行。

開發環境禁止 Unix socket：本機 E2E 回報 EPERM；提出合法的執行升級後，執行器在建立 sandbox 時失敗，測試未執行。這個限制不會被忽略／轉成 passed。自動 Linux checks 必須在同提交執行完整核心測試後，才能勾選 Linux broker E2E。

仍需手動驗收：macOS ARM64／Intel、Windows x64、Linux 桌面真實關窗與重開；Shell、Codex、Claude、Grok、Antigravity CLI 的進階 TUI；多 UI 同時 resize；UI 強制結束與 broker 強制結束；電腦重新開機後 interrupted 呈現。完整矩陣維持手動，不增加自動 CI 用量。原生 smoke 會在刪除自己的合成資料前，透過內部 `--sessionbay-runtime-broker-stop <appdata>` 明確關閉隔離 broker；此 helper 不使用 PID，也不會新建 broker。

### Protocol 1 的功能協商

Hello request 維持舊格式，Hello response 以可選 capabilities 宣告延伸功能。目前 `homeDirectory` 表示支援全域臨時 Shell 的家目錄政策 metadata。沒有此能力的既有 broker 可使用已由 Rust 解析好的明確家目錄 cwd 啟動；只省略未知政策欄位，保留 null project 與原 profile，不重送 Launch 或重啟任何既有程序。

相容模式的 home 政策由已儲存 workspace 的 `homePolicyRuntimeId` 與 broker 回傳 runtime ID 比對；該 token 不可用來附接或自動啟動。舊 broker 沒有政策資料、workspace 也遺失時，恢復的 Terminal 使用明確 cwd。協商與相容處理在背景進行，不因缺少 capability 顯示例行版本提示；真正的連線、啟動與資料讀取錯誤仍保留。現代 broker 回傳的政策優先。詳細相容邊界見 2026-10-17 決策。
