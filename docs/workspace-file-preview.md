# 工作區檔案預覽

## 操作與範圍

進入 catalog 專案後，可從工作區右側 Activity Bar 的第二個圖示開啟 Files 側欄，無需先開 Terminal／Agent。第一個圖示為歷史 Sessions，再點目前功能可收合；正常與專注模式皆可使用。選檔後主工作區顯示獨立的唯讀檔案 tab，原 Terminal 持續執行、保留元件與 Runtime，只暫時隱藏；點原工作分頁即可切回。臨時 Terminal 不提供 HOME 檔案瀏覽。

- 根目錄是 catalog 專案原始路徑，不是重新指定的啟動位置 launchPath。只存在於歷史的無本機路徑專案會顯示錯誤。
- 檔案樹一次只讀使用者展開的目錄；每頁 200 項，更多內容由「載入更多檔案」明確取得。node_modules 等不會自行展開。隱藏檔案預設列出，沒有額外勾選列。
- 單擊替換未固定的預覽 tab，雙擊固定，同專案相對路徑去重；上限 20 檔。每專案保留獨立目錄、開檔、快取及捲動位置，切換工作分頁、側欄與專注模式不清除。關閉 tab 釋放該檔快取；不持久化檔案內容，重開應用不恢復檔案 tabs。
- 檔案 tabs 與 Runtime tabs 共用一列，但各自在自身群組內排序。檔案圖示與斜體預覽名稱可區別，雙擊檔案 tab 可固定；Alt＋左右方向鍵或拖曳可重排。拖曳只帶無路徑的內部 MIME，不能變成 Terminal 輸入。
- Cmd／Ctrl＋數字、Ctrl＋PageUp／PageDown 等既有工作分頁捷徑包含檔案。Cmd＋W／原生關閉目前分頁在檔案檢視只關檔案，不影響 Runtime；Ctrl＋W 在檔案檢視亦適用，Terminal 原有 Ctrl＋W 不改。組字與對話框會阻擋關閉。
- 目錄內 Esc 收合側欄並回 Files 開關；不關文件。目錄分隔線可拖曳、方向鍵調整，Home／End 到寬度上下限；不提供額外寬度選單。無圓角與額外最大化層。
- 預覽使用可選取的純文字 `<pre><code>`，可搜尋及捲動長行。HTML／Markdown 不渲染、不執行；沒有編輯、儲存、刪除或外部開啟。

## 安全與容量

後端從 Project ID 查 catalog，只接受受限的相對路徑。拒絕絕對路徑、父目錄、反斜線、Windows ADS／裝置名稱、控制字元及過長路徑。根目錄和各祖先不得為符號連結。檔案樹把符號連結、多重硬連結（一般檔案 nlink > 1）及特殊檔案列成不可開啟；不追蹤指向根內的連結。開啟後以 descriptor metadata 再確認一般檔案的連結數，拒絕可能與專案外路徑共用 inode 的別名。目錄不套用硬連結數限制。

Linux／macOS 使用 pinned directory descriptors 逐段 `openat(O_NOFOLLOW)`，列表使用同一 descriptor，檔案開啟後驗證一般檔案與大小。檔案只能讀至上限加一個偵測 byte；超過 256 KiB、二進位或無效 UTF-8 會顯示原因，不以猜測編碼損壞內容。目錄排序快照另限制 100,000 項與檔名總計 16 MiB，超過時明確報錯；翻頁期間目錄內容變動可重新整理。

Windows 使用 `NtCreateFile(RootDirectory)` 單元件相對開啟及 `FILE_OPEN_REPARSE_POINT`，從磁碟根到專案祖先與子目錄均不追蹤重新解析點。目錄列舉以 `GetFileInformationByHandleEx` 操作同一 handle；文字讀取前後查核一般檔案與硬連結數。磁碟必須為本機固定磁碟，已開啟的磁碟根 handle 必須解析為 volume root；UNC、網路磁碟及 SUBST 子目錄別名拒絕。開啟後只共享讀取，不共享寫入／刪除；已有衝突 handle 時安全失敗，使用者可稍後重新整理。點號隱藏檔規則、分頁與容量限制和 Unix 相同。

## 驗證

- 前端合成測試涵蓋專案獨立、零 Terminal 瀏覽、共用分頁捷徑、Terminal 不卸載、Esc 焦點、延遲回覆不覆蓋新選擇、隱藏項目、明確翻頁、連結停用及讀取錯誤。
- Rust 使用合成暫存目錄驗證路徑、根目錄來源、symlink、特殊檔案與大小／文字限制；不讀取開發機的真實專案或使用者歷史。
- `npm run test:files` 使用真正 App／WorkspaceCanvas／TerminalPane／xterm，注入合成 API，於 1200／720 px 驗證並產生截圖。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已安裝 Chromium；不停用 sandbox。
- 2026-10-17 Windows ARM64：前端 819 測試、typecheck、lint、build 與 sandbox 開啟的 headless Edge 1200／720 px 合成瀏覽器測試通過。這些測試不等於 Tauri native GUI 或 macOS／Linux 驗收。
- Windows 後端合成 fixture 涵蓋 junction 葉節點／祖先／專案根、多重硬連結、路徑驗證、根 handle 別名檢查、替換／寫入鎖定、UTF-8／二進位／256 KiB、分頁、原始 catalog 根與多批次原生列舉。檔案 symlink 建立因錯誤 1314（缺少權限）未執行，不變更 OS 設定；junction fixture 必跑。

## Windows native 檔案預覽自測

`scripts/ci-windows-smoke.ps1 -Binary <已建置的執行檔> -Files` 可在實際 Tauri WebView 中使用正式 IPC 驗證合成工作目錄。它沿用 opt-in smoke 與隔離 app-data 設定，所有歷史來源為空、Agent executable 指向不存在的 fixture 路徑；僅啟動隔離 PowerShell，沒有執行 Agent。

自測透過 React DOM 操作新增合成專案、開啟工作區與檔案側欄，驗證列檔、UTF-8／markup 原樣顯示、非法路徑／binary／hardlink／超限內容拒絕，以及 Escape 回焦、已初始化 xterm 的身分維持。runner 比對所有 fixture 檔案前後 SHA256，並等待原生視窗與已驗證 broker 清理完成。`-Files` 是獨立開關，目前 CI 未預設啟用。

這是原生 WebView 的程式化 DOM／IPC 自測，不等同實體鍵盤滑鼠、IME、跨平台或安裝程式驗收。file symlink fixture 仍受 Windows 1314 權限限制，沒有為測試變更 OS 安全設定。

## 最新 main 整合

Files 文件、history 對話預覽與 workspace 是中央並列顯示狀態，獨立於 Activity Bar 的側欄選擇。App 擁有各專案 Files 的存續與共用 hosts；WorkspaceCanvas 僅保有 Terminal surface，檔案元件用 portal 放入同列 tabs、右側樹與主文件區，不以 portal 重新掛載 Terminal。分割拖曳仍以 Terminal surface 實際大小計算。

Files 重整未改 Rust、IPC、權限、檔案根或 Runtime schema。2026-10-17 GitHub Actions 已通過新版 Files 8 項及專注模式 16 項瀏覽器回歸，並實際檢視正常／專注模式、深淺主題、窄寬視窗與零 Runtime 截圖；本機雲端 Chromium 啟動限制未繞過。上述瀏覽器及 Windows 舊版通過紀錄不代表重整版已完成原生驗收。整合 Session 清單漸進載入後仍須重新通過完整 CI。
