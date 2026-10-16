# 獨立主題與即時預覽

## 使用方式

頂欄的「快速切換主題」提供介面模式、介面色系與獨立終端色票。每次選擇立即套用並儲存在本機，不需另按儲存；關閉選單保留選擇。寫入期間停止重複操作，仍可關閉選單。失敗回到上次儲存外觀並顯示錯誤，關閉選單後發生的失敗會用通知提示。

工作台設定 → 外觀與預設值會立即預覽整個介面及所有開啟的終端。取消、關閉或 Escape 後確認「捨棄變更」會還原；切換設定分類仍保留預覽。瀏覽器上一頁或元件卸載也移除預覽。儲存中不能取消或重複送出，失敗保留草稿／預覽以便重試。

UI 模式為深色、淺色或跟隨系統；10 個色系各有兩種模式，共 20 組。Terminal 有獨立的深／淺色各 10 組，不跟隨 UI 模式改變。色系為 Bay、Graphite、Ocean、Forest、Amber、Rose、Plum、Slate、Coffee、Sand。既有 Bay、Classic 終端色票另行保留，不算入新色票數量。

## 相容與行為契約

- settings version 1 保留；省略 themePalette 的舊設定採 Bay。合法但未知的色系／終端色票 ID 保留原值並暫用 Bay，介面標示 fallback，不重設其他設定。舊版程式降版讀取新增欄位不保證相容。
- 預覽只覆蓋外觀欄位。開啟設定期間若收到其他來源已儲存的設定，採新設定作為基準並捨棄舊草稿；取消不回寫過期快照。
- 設定開啟時停用頂欄快切；快速寫入期間停用設定入口，避免兩個編輯來源互相覆寫。
- 純外觀寫入可在背景索引中完成；任何非外觀變更仍受原有索引鎖保護。後端先完成原子檔案寫入才更新記憶體設定。
- 只換色不執行 terminal reset、fit、resize、focus、dispose 或 PTY launch/stop。所有開啟與隱藏面板共用目前預覽，終端內容／選取／游標狀態由既有 xterm 實例保留。
- 新色票與控制項使用 src/themes.ts 的共用 catalog／語意 tokens。自訂 CSS 與色票編輯器不在範圍內；不改寫使用者的既有字型、profiles、來源、Agent 參數或快捷鍵。

## 驗證（2026-10-16）

- TypeScript、ESLint、Vitest 全套、production build；新增 Settings 與 App 整合測試覆蓋立即預覽、反覆取消、Escape／關閉／Back、設定分類切換、成功保存後再次取消、延遲保存／重複送出／失敗重試、外部新基準、未知 ID。
- xterm mock 回歸檢查兩個面板（含隱藏面板）改色／回復使用同一實例，沒有重新啟動、重設、resize fit 或搶焦點。這不是原生 PTY 視覺驗收。
- 20 組 UI 色彩逐一檢查一般文字 4.5:1、必要控制邊界 3:1；20 組新 Terminal 色票檢查 16 個 ANSI 色／文字／游標相對背景及選取文字 4.5:1。原有 Bay／Classic 完整保留，不將其較低對比的 ANSI 色算作新色票通過。
- Rust 無 desktop features 全套核心／PTY 測試、fmt、Clippy。新增舊設定遷移、未知 ID roundtrip、非法 ID、索引中只保存外觀、寫入失敗不改記憶體測試。
- 尚未完成：原生 macOS／Windows／Linux WebView 截圖、實際操作時游標與選取畫面、系統亮暗切換及重開應用持久化的桌面實測。雲端瀏覽器未能連到工作區預覽伺服器；獨立 Chromium 的 sandbox socket／環境限制也未能完成截圖，沒有停用 sandbox 或拿 DOM 測試冒充視覺通過。

## 與其他獨立 PR 的合併

基於 main a609f04，不包含平台、原生資料夾對話框、持續 Runtime、OpenCode 或工作區日常操作 PR。SettingsPanel、App、TerminalPane、config.rs、service.rs 與文件可能重疊；合併時保留各自改動，重新跑相關回歸。此 PR 不合併、不發佈、不觸發完整三平台 CI。
