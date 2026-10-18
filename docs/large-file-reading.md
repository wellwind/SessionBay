# 大型文字檔閱讀

中央 Files 不再拒絕大於 256 KiB 的文字檔。資料仍只讀，無寫檔能力。

## 介面

- 至 20 MiB：自動開啟，語法高亮／搜尋／選取／折疊。
- 20–64 MiB：先顯示大小，選擇「繼續開啟」使用純文字效能模式，或「分段閱讀」。
- 大於 64 MiB 或超過 300,000 行：每次最多約 1 MiB／300,000 行；上一段／下一段切換，搜尋與複製只含目前區段。
- 超長行：停用昂貴特性，僅繪製前 10,000 字元並提示；保留目前內容供選取／複製。
- 讀取時可取消；切換文件、返回 Terminal 或隱藏工作區也會取消並釋放 model。重新開啟先檢查 metadata，不使用過期版本。

## 邊界

預檢只看最多 64 KiB，後續逐塊以 strict UTF-8 decoder 與控制字元檢查確認全部已讀內容。每個 IPC 最多 256 KiB，不傳送巨型全文 JSON；只在 UI 組合受限文字。cache 只保留小檔，跨專案總量最多 8 MiB／64 筆，單檔最多 1 MiB（UTF-16 payload估算）。分段在 UTF-8 邊界銜接，版本改變時要求重新讀取，避免拼接不同檔案。

這不是無限載入承諾。Monaco model、JavaScript UTF-16 字串、IPC 的 number[]／JSON 與暫存 chunks 都會耗記憶體；大檔要確認，超大檔用視窗。仍拒絕目錄外路徑、符號連結、hardlink、Windows reparse、binary 與不支援編碼。

## 驗證

單元涵蓋取消、metadata、chunk bounds、UTF-8 分界、cache、過期回應、切檔與 model disposal；Rust 核心測試驗證真實檔案與公開 service 路徑。Linux Chromium dev／production 測 1 MiB、21 MiB opt-in、65 MiB 分段、慢速取消與 Terminal 身分。Linux Tauri WebKit 使用合成實體檔案，經真正 IPC 讀取 1 MiB／21 MiB，65 MiB 只讀一段，建立並釋放 model。各測試須依 PR CI 結果記錄，不把設計當成已通過。

macOS／Windows 原生尚未驗證，跨平台安全程式與 Windows compile 仍保留。
