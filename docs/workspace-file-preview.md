# 工作區檔案預覽

## 操作與範圍

在專案工作分頁右上選「檔案預覽」。左側 Terminal 持續執行，右側可展開目錄並選擇文字／程式碼檔案；沒有工作分頁時不顯示入口，臨時 Terminal 不提供 HOME 檔案瀏覽。

- 根目錄是 catalog 專案原始路徑，不是重新指定的啟動位置 launchPath。只存在於歷史的無本機路徑專案會顯示錯誤。
- 檔案樹一次只讀使用者展開的目錄；每頁 200 項，更多內容由「載入更多檔案」明確取得。node_modules 等不會自行展開。隱藏檔案預設不列出，可勾選顯示。
- 選取、展開、是否開啟面板各分頁獨立，關閉分頁會釋放；不寫入工作區設定，不保存檔案內容。重新整理會重讀目前選檔並重建目錄。
- Tab 可依序到達目錄／檔案／更多按鈕及內容；Enter／Space 操作按鈕，Esc 關閉側面板並回到入口。沒有自動將焦點送入 Terminal。
- 預覽使用可選取的純文字 `<pre><code>`，可捲動長行。HTML／Markdown 不渲染、不執行；沒有編輯、儲存、刪除或外部開啟。

## 安全與容量

後端從 Project ID 查 catalog，只接受受限的相對路徑。拒絕絕對路徑、父目錄、反斜線、Windows ADS／裝置名稱、控制字元及過長路徑。根目錄和各祖先不得為符號連結。檔案樹把符號連結、多重硬連結（一般檔案 nlink > 1）及特殊檔案列成不可開啟；不追蹤指向根內的連結。開啟後以 descriptor metadata 再確認一般檔案的連結數，拒絕可能與專案外路徑共用 inode 的別名。目錄不套用硬連結數限制。

Linux／macOS 使用 pinned directory descriptors 逐段 `openat(O_NOFOLLOW)`，列表使用同一 descriptor，檔案開啟後驗證一般檔案與大小。檔案只能讀至上限加一個偵測 byte；超過 256 KiB、二進位或無效 UTF-8 會顯示原因，不以猜測編碼損壞內容。目錄排序快照另限制 100,000 項與檔名總計 16 MiB，超過時明確報錯；翻頁期間目錄內容變動可重新整理。

Windows 目前明確停用此功能的後端讀取，因現有 helper 無法完整防止祖先 junction／reparse point 競態。這不是已完成 Windows 檔案預覽；待安全 handle-relative 實作與 Windows 原生測試後再開放。UI 會顯示目前平台不支援安全預覽，而非嘗試不安全的讀法。

## 驗證

- 前端合成測試涵蓋分頁獨立、Terminal 不卸載、Esc 焦點、延遲回覆不覆蓋新選擇、隱藏項目、明確翻頁、連結停用及讀取錯誤。
- Rust 使用合成暫存目錄驗證路徑、根目錄來源、symlink、特殊檔案與大小／文字限制；不讀取開發機的真實專案或使用者歷史。
- `npm run test:files` 使用真正 WorkspaceCanvas／TerminalPane／xterm，注入合成 API，於 1200／720 px 驗證並產生截圖。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已安裝 Chromium；不停用 sandbox。
- 此環境本機 Chromium 因 socket 權限無法啟動；視覺驗證留給正常 GitHub Linux CI。前端模擬不等於 Tauri、macOS 原生或 Windows 驗收。
