# 工作區檔案預覽

## 操作與範圍

在專案工作分頁的分頁列選「檔案預覽」。左側 Terminal 持續執行，右側可展開目錄並選擇文字／程式碼檔案；沒有工作分頁時不顯示入口，臨時 Terminal 不提供 HOME 檔案瀏覽。

- 根目錄是 catalog 專案原始路徑，不是重新指定的啟動位置 launchPath。只存在於歷史的無本機路徑專案會顯示錯誤。
- 檔案樹一次只讀使用者展開的目錄；每頁 200 項，更多內容由「載入更多檔案」明確取得。node_modules 等不會自行展開。隱藏檔案預設不列出，可勾選顯示。
- 選取、展開、是否開啟面板各分頁獨立，關閉分頁會釋放；不寫入工作區設定，不保存檔案內容。重新整理會重讀目前選檔並重建目錄。
- Tab 可依序到達目錄／檔案／更多按鈕及內容；Enter／Space 操作按鈕，Esc 關閉側面板並回到入口。沒有自動將焦點送入 Terminal。
- 預覽使用可選取的純文字 `<pre><code>`，可捲動長行。HTML／Markdown 不渲染、不執行；沒有編輯、儲存、刪除或外部開啟。

## 安全與容量

後端從 Project ID 查 catalog，只接受受限的相對路徑。拒絕絕對路徑、父目錄、反斜線、Windows ADS／裝置名稱、控制字元及過長路徑。根目錄和各祖先不得為符號連結。檔案樹把符號連結、多重硬連結（一般檔案 nlink > 1）及特殊檔案列成不可開啟；不追蹤指向根內的連結。開啟後以 descriptor metadata 再確認一般檔案的連結數，拒絕可能與專案外路徑共用 inode 的別名。目錄不套用硬連結數限制。

Linux／macOS 使用 pinned directory descriptors 逐段 `openat(O_NOFOLLOW)`，列表使用同一 descriptor，檔案開啟後驗證一般檔案與大小。檔案只能讀至上限加一個偵測 byte；超過 256 KiB、二進位或無效 UTF-8 會顯示原因，不以猜測編碼損壞內容。目錄排序快照另限制 100,000 項與檔名總計 16 MiB，超過時明確報錯；翻頁期間目錄內容變動可重新整理。

Windows 使用 `NtCreateFile(RootDirectory)` 單元件相對開啟及 `FILE_OPEN_REPARSE_POINT`，從磁碟根到專案祖先與子目錄均不追蹤重新解析點。目錄列舉以 `GetFileInformationByHandleEx` 操作同一 handle；文字讀取前後查核一般檔案與硬連結數。磁碟必須為本機固定磁碟，已開啟的磁碟根 handle 必須解析為 volume root；UNC、網路磁碟及 SUBST 子目錄別名拒絕。開啟後只共享讀取，不共享寫入／刪除；已有衝突 handle 時安全失敗，使用者可稍後重新整理。點號隱藏檔規則、分頁與容量限制和 Unix 相同。

## 驗證

- 前端合成測試涵蓋分頁獨立、Terminal 不卸載、Esc 焦點、延遲回覆不覆蓋新選擇、隱藏項目、明確翻頁、連結停用及讀取錯誤。
- Rust 使用合成暫存目錄驗證路徑、根目錄來源、symlink、特殊檔案與大小／文字限制；不讀取開發機的真實專案或使用者歷史。
- `npm run test:files` 使用真正 WorkspaceCanvas／TerminalPane／xterm，注入合成 API，於 1200／720 px 驗證並產生截圖。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已安裝 Chromium；不停用 sandbox。
- 2026-10-17 Windows ARM64：前端 819 測試、typecheck、lint、build 與 sandbox 開啟的 headless Edge 1200／720 px 合成瀏覽器測試通過。這些測試不等於 Tauri native GUI 或 macOS／Linux 驗收。
- Windows 後端合成 fixture 涵蓋 junction 葉節點／祖先／專案根、多重硬連結、路徑驗證、根 handle 別名檢查、替換／寫入鎖定、UTF-8／二進位／256 KiB、分頁、原始 catalog 根與多批次原生列舉。檔案 symlink 建立因錯誤 1314（缺少權限）未執行，不變更 OS 設定；junction fixture 必跑。

## Windows native 檔案預覽自測

`scripts/ci-windows-smoke.ps1 -Binary <已建置的執行檔> -Files` 可在實際 Tauri WebView 中使用正式 IPC 驗證合成工作目錄。它沿用 opt-in smoke 與隔離 app-data 設定，所有歷史來源為空、Agent executable 指向不存在的 fixture 路徑；僅啟動隔離 PowerShell，沒有執行 Agent。

自測透過 React DOM 操作新增合成專案、開啟工作區與檔案側欄，驗證列檔、UTF-8／markup 原樣顯示、非法路徑／binary／hardlink／超限內容拒絕，以及 Escape 回焦、已初始化 xterm 的身分維持。runner 比對所有 fixture 檔案前後 SHA256，並等待原生視窗與已驗證 broker 清理完成。`-Files` 是獨立開關，目前 CI 未預設啟用。

這是原生 WebView 的程式化 DOM／IPC 自測，不等同實體鍵盤滑鼠、IME、跨平台或安裝程式驗收。file symlink fixture 仍受 Windows 1314 權限限制，沒有為測試變更 OS 安全設定。

## 最新 main 整合

檔案入口放在既有工作區分頁列，保留單面板滿版與專注模式；歷史頁不顯示入口。分割拖曳以 Terminal surface 的實際大小計算，預覽側欄不會改變拖曳比例基準。Terminal 的活動可見性、圖片輸入、分頁排序、Trash、來源設定與工具啟用語意沿用 main。
