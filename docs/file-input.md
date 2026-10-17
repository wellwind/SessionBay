# Agent 一般檔案拖放與貼上

## 使用範圍

已聚焦且連線中的直接本機 Codex、Claude Code、Grok Build、OpenCode 面板接受使用者提供的檔案。拖放或系統剪貼簿的 File 入口接受任何副檔名／MIME，包括空檔、文字、PDF、SVG、壓縮檔、二進位。Session Bay 只保存 bytes，再貼入本機參照，不執行檔案、不顯示 SVG／HTML、不解壓縮，也不將一般檔案送入影像解碼。

一般文字貼上仍照原有行為；多行文字仍保留原本確認。工具列透過 Clipboard API 可取得的圖片可用自動名稱加入，瀏覽器若未提供 OS 檔案則不能假裝讀到了它；請用系統貼上或拖放實際檔案。資料夾（包括混合檔案與資料夾的一批）明確拒絕，不自動遞迴。有實際 File（或工具列讀到二進位剪貼簿內容）時，檔案優先，忽略附帶名稱／URL 等文字表示，不把它們送入終端；只有純文字才走原有文字貼上流程。拖到未聚焦的分割面板會先明確聚焦該面板，重新取得相同 runtime／lease 的有效目標後才開始；聚焦未成立或目標改變則不插入。

插入的參照並不代表 CLI 已讀取或模型能解析。Codex／Grok／OpenCode 使用 percent-encoded file URL，Claude 使用引用的絕對路徑。一般檔案路徑不是原生圖片附件的保證；內容是否理解、模型能力與外部 CLI 的權限提示由 Agent 決定。實際三平台與各 CLI 驗收尚待完成。

Shell、SSH／WSL、自訂外層包裝程式及 Antigravity 不在本次相容範圍。路由能力在啟動時捕捉，不靠之後可變的設定或面板標籤推論。對尚未提供能力欄位的相容舊背景程序，目前 app 可替真正新開、無 resume 身分的直接本機 Agent 保存可信啟動證明；既有工作階段沒有證明時仍維持未知，不停止 Agent 或主動重啟 broker。明確拒絕的能力不能由證明覆蓋。

## 限額與命名

- 單檔 0–10 MiB；一次 1–4 個檔案，總計最多 20 MiB。
- IPC 每段最多 64 KiB；後端同步驗證預期大小、分段順序與擁有者 runtime。
- 一般檔案 store 最多 512 MiB／2048 個上傳目錄，含空目錄與保留檔；沒有自動過期清除。已保留的舊圖片 store 有其原有獨立限額。
- 完整路徑與編碼後 file URL 路徑各最多 512 bytes；超長時明確失敗，不插入截斷路徑。
- 原始名稱最多 4096 UTF-8 bytes；安全 basename 最多 120 bytes。過長檔名保留最多 32-byte 的末段副檔名，其餘安全截短，UTF-8 不切在字元中間。
- 可用的 Unicode 名稱、空白與副檔名原樣保留。路徑分隔、控制與雙向控制字元、跨平台禁用字元／shell metacharacters 替換為底線，Windows 裝置保留名加底線，尾點／尾空白移除；空名使用 `file`。介面顯示每項改名。
- 每個檔案一個隨機唯一、owner-only 目錄，以 `create_new` 寫入安全 basename；同名檔不互相覆蓋。不可信名稱不拼接命令，完整路徑仍經引用／URL 編碼及長度驗證後才交終端。

暫存位於應用程式設定目錄下的 `file-input-v1`。持有 `staging.lock` 跨程序獨占鎖才能寫入；使用唯讀 metadata 重新計量保留量。Unix 目錄／檔案為 0700／0600，Windows 驗證 owner-only DACL；拒絕連結、替換與非預期項目。滿額訊息顯示實際位置。請先結束使用這些檔案的 Agent，僅手動移除確定不再用於接續對話的上傳目錄，勿刪 `staging.lock`。本次尚無容量管理 UI。

## 生命週期與輸入安全

所有檔案完成有界接收並檢查路徑後才開始插入。每個檔案先 retain，再呼叫 xterm paste；終端寫入結果不確定時保留，不誤刪可能已被 Agent 參照的檔案。未使用項目清理受身分／路徑 guard 保護，目錄替換時不刪除不明檔案。

面板、runtime、attachment lease、generation、焦點或輸入目標變動會取消尚未插入的檔案。準備期間使用者 Enter 照常送給終端，同時取消過期檔案輸入；不自動 Enter、不延後補送 Enter。一般文字與完整 bracketed multiline paste 不視為提交。仍不聲稱能推斷所有 CLI 自訂快捷鍵或自行切換的 prompt。

零插入失敗只顯示原因；已嘗試或已部分插入才提示檢查 Agent 輸入區，以免重複。

## 驗證界線

合成測試涵蓋任意 bytes／空檔、basename 清理與 Unicode、重名隔離、quota／跨程序鎖、保留重開、私人權限、連結／目錄替換、取消、Enter、部分插入、資料夾拒絕、File 附帶文字忽略及 drop 目標聚焦與相容錯誤分流。前端與 Rust 核心測試不等於 Windows／macOS 原生 WebView、OS 剪貼簿或真實 Agent 接收驗收；後者需另附證據。

### 2026-10-17 候選驗證紀錄

- 前端 typecheck、lint、production build 通過；全套已有 938 個 assertion 通過，兩個受共享 node_modules 真實來源路徑限制的 suite 已另以臨時、限定 xterm 來源 allow-list 驗證。追加後 file-input／terminal／terminal-ime／terminal-keyboard 合計 208 tests 通過；未修改產品 Vite 設定。
- Rust 核心 lib：150 tests 通過，兩個既有 broker socket 測試受執行環境 `Operation not permitted` 限制；不繞過 sandbox。一般檔案與能力分流新增測試皆通過。
- Linux desktop 全 target check／Clippy 通過；Windows GNU 全 target cross-check 通過，存在既有 test-only helper unused 警告。Cross-check 不等於 Windows 執行驗收。
- 獨立安全複核發現的 Unix 建目錄權限與 Windows hardlink count 已修正並複核；本段為一般檔案基底的驗證紀錄；下方 fresh-launch 修正另行驗證，仍沒有實際 macOS／真實 Agent 通過證據。

## 真正新開 Agent 與舊背景程序

新 Agent 使用單一 `launch_fresh_runtime` 呼叫。前端的 paneId 只作為一次請求的 idempotency intent，不是能力證明；backend 另產生不可預測的 pane UUID，凍結實際 LaunchSpec，拒絕任何 session／resume key，並在 dispatch 前保存一次性 intent。舊 broker 只接受原有 Launch／List／PTY 指令，沒有新增附件命令。

Launch 回應和 authoritative List 必須對上同一 broker generation、runtime UUID、backend pane UUID、kind、project/profile 和 canonical cwd；runtime 必須是新出現、沒有 resume 身分。已確認的 runtime 即使很快退出也會顯示，以保留啟動錯誤；只有仍 running 且沒有 exit code 者可授予檔案能力。若回應遺失，只用 List 恢復該 backend pane；同一 intent 不重送 Launch，也不能在 generation 改變後重播。未確認結果不會自動停止程序。前端採 backend 的 pane/runtime 身分再 attach；晚到的結果不覆蓋已切換的 split 或搶焦點，而由工作階段列表恢復。

只有凍結 LaunchSpec 通過既有直接本機路由檢查，且舊 broker 缺少能力資訊時，才保存 `launch-provenance-v1` 私有、原子、不可覆寫的記錄。JSON 僅含版本、generation/runtime/pane UUID、kind、cwd、project/profile，不含 executable、args、env、憑證或對話內容。重開 app 後每次開始暫存與 retain 插入前仍核對同 generation 的 live broker List；過期、退出、變更或未證實 resume 的 runtime 不授予能力。既有直接路由檢查依啟動 executable basename 與環境判斷，不能排除使用者把自訂 wrapper 命名為同名 executable。這是目前使用者私有資料的完整性防護，不是對同一 OS 使用者惡意程序的隔離保證。

Provenance 儲存最多 2048 項、16 MiB，每筆最多 16 KiB；一次性 launch intent 使用 timestamp＋UUID，最多保留十分鐘內的 128 筆。有效期間絕不因容量淘汰，過期請求一律拒絕，清除後也不能重播；app 生命週期內使用觀測時間高水位避免時鐘倒退復活舊請求。滿額或安全檢查失敗時不授權附件，不停止正在運作的 Agent。只有同 generation 的 live List 明確回報 exited 的證明會自動整理；不在列表、live、未知狀態、其他 generation 及非預期檔案全部保留，避免跨 app 過期列表刪除新證明。附件檔案不受此整理影響。Idempotency 保證限目前 backend 生命週期。重新開啟 app 不會自動重送未確認啟動，會從 live List 恢復工作階段；若需手動整理 provenance，只能在確認對應 runtime 不再使用後移除其記錄，不能刪除使用中的 lock 或 retained 附件。缺少證明的既有 Agent 可繼續正常工作。

### 原生拖放與剪貼簿驗收界線

Tauri 主視窗設定 `dragDropEnabled:false`，以 DOM `DataTransfer.files`／`ClipboardEvent.clipboardData.items.getAsFile()` 接收真正 File bytes；沒有 `onDragDropEvent` 的第二條原生 path 讀取入口。Tauri 設定說明要求 Windows HTML5 拖放採這個設定。工具列另使用 browser Clipboard API，只有平台實際提供的 File／圖片才可加入。

合成 DOM DataTransfer／clipboard fixtures 可以驗證 handler、焦點與能力 guards，無法證明 Finder／Explorer 或各 WebView 實際提供的 FileList/MIME/bytes。macOS／Windows 原生檔案拖入、系統複製檔案後貼上，以及實際 Codex／Claude 讀取參照仍需獨立實機驗收。已發布版本對 `.svg` 會在 begin IPC 之前拒絕格式；使用者看見能力錯誤的確切原生 payload 未取得，不能因此推斷他使用自訂 wrapper、舊 tab 或錯誤 MIME。

### Fresh-launch 整合驗證

2026-10-17：前端 39 suites／1011 tests、typecheck、lint、production build 通過；測試使用臨時限定 xterm 原始來源 allow-list，未改產品 Vite 設定。核心 Rust 174 tests 通過，2 個既有本機 socket 測試因環境 `Operation not permitted` 未執行；包含最後 explicit-exited-only cleanup 的雙 backend 過期快照回歸。Linux desktop all-targets check／Clippy、Windows GNU all-targets cross-check 通過（後者有既有 test helper unused warning，未執行 Windows 程式）。六個合成 browser fixture 完成列舉與型別檢查，尚待正常 CI browser 執行。合成測試證明舊 protocol-1 record 可由新直接 Codex／Claude launch 建立 proof、lost-response 不重發、重複 intent 不改凍結設定、快速 exit 不隱藏 runtime、explicit denial 優先。這些結果不等於使用者 Mac 或真實 CLI 已驗收。

整合 main `606e2c2`（PR28／29／30）後：40 suites／1033 前端 tests、typecheck、lint、production build 通過；Rust 來源與上述已驗證候選完全相同。原生 WebView／真實 CLI 驗收仍未完成。
