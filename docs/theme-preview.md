# 獨立主題與即時預覽

## 使用方式

頂欄的「快速切換主題」提供介面模式、介面色系與獨立終端色票。每次選擇立即套用並儲存在本機，不需另按儲存；關閉選單保留選擇。寫入期間停止重複操作，仍可關閉選單。失敗回到上次儲存外觀並顯示錯誤，關閉選單後發生的失敗會用通知提示。

工作台設定 → 外觀與預設值會立即預覽整個介面及所有開啟的終端。取消、關閉或 Escape 後確認「捨棄變更」會還原；切換設定分類仍保留預覽。瀏覽器上一頁或元件卸載也移除預覽。儲存中不能取消或重複送出，失敗保留草稿／預覽以便重試。

UI 模式為深色、淺色或跟隨系統；12 個色系各有兩種模式，共 24 組。Terminal 有獨立的深／淺色各 12 組，不跟隨 UI 模式改變。原有 Bay、Graphite、Ocean、Forest、Amber、Rose、Plum、Slate、Coffee、Sand 完整保留，追加 Code Modern、Code 2026。既有 Bay、Classic 終端色票另行保留，不算入這 24 組。

命令面板另有「切換介面主題」「切換 Terminal 主題」：搜尋名稱後以方向鍵預覽，Enter 才保存；Escape、關閉或返回命令清單只移除預覽，不寫入設定。介面選項明列深／淺色，Terminal 選項獨立選擇。保存失敗還原到最新已保存外觀，保留目前選項與錯誤供 Enter 重試；這與設定編輯草稿失敗時保留草稿預覽的行為不同。重新移動選項可以再次預覽。

## Monaco 文字預覽

Files 的 Monaco 文字預覽同步目前介面模式與色系，含設定／命令面板即時預覽及取消還原；Terminal 色票仍獨立。背景、文字、行號、選取、搜尋與小工具使用共用 UI tokens；語法配色是 Session Bay 語意色改編，不是 VS Code TextMate 主題完整移植。語法／行號／括號在文件與選取背景維持至少 4.5:1。換色只更新 Monaco theme，不重建模型、不變更捲動、選取或焦點。

新增 24 組純函式對比測試、屬性變更／還原／卸載觀察器測試，以及 Vite dev／production 真實 Monaco 原實例與選取保留截圖測試。此次結果以對應 PR 的 Linux CI 為準；原生 macOS／Windows／Linux WebView 尚未實測。

## Code Modern／Code 2026 來源與差異

兩個名稱代表 Session Bay 的配色改編，不宣稱與 Microsoft／VS Code 有官方合作或完全相同的 UI。固定上游 [commit 3588843f05a21bfdeada83a9799d87f19de0fadd](https://github.com/microsoft/vscode/tree/3588843f05a21bfdeada83a9799d87f19de0fadd)，查閱日期 2026-10-16，不在執行時下載主題。

- [dark_modern.json](https://github.com/microsoft/vscode/blob/3588843f05a21bfdeada83a9799d87f19de0fadd/extensions/theme-defaults/themes/dark_modern.json) → dark_plus.json → dark_vs.json；light_modern.json → light_plus.json → light_vs.json。2026-dark.json／2026-light.json 再繼承對應 Modern；不是只讀最上層的顏色。
- src/theme-sources/code-palettes.json 保存所用語意色的已解析 include 結果與來源 SHA。編輯區、側欄、面板、標題列、分頁、輸入底色、主按鈕採對應上游語意值；CSS 僅作用於這兩個色系。主按鈕填色與可閱讀連結色分開，不再用同一 accent 同時擔任所有角色。
- Terminal 背景依 terminal.background 或 panel.background，文字／游標採 terminal 對應欄位。16 色 ANSI 採同一 SHA 的 [terminalColorRegistry.ts](https://github.com/microsoft/vscode/blob/3588843f05a21bfdeada83a9799d87f19de0fadd/src/vs/workbench/contrib/terminal/common/terminalColorRegistry.ts) 預設，不把 editor tokenColors 誤當 Terminal ANSI。未指定選取背景時依 [editorColors.ts](https://github.com/microsoft/vscode/blob/3588843f05a21bfdeada83a9799d87f19de0fadd/src/vs/platform/theme/common/colors/editorColors.ts) 的深／淺色預設。
- 刻意差異：透明色先對實際底色合成；一般文字／ANSI／選取文字不足 4.5:1、控制邊界／焦點不足 3:1 時，以最小步進往同模式可讀方向調整。Code 2026 淺色 placeholder #999999、深色 #555555，以及部分 ANSI 色／輸入框邊線因此不逐色照抄。已有足夠對比的來源值保持原色，裝飾分隔線保留上游低對比值。視覺目標是可辨識的配色語意，不是像素重製或語法上色主題。
- Microsoft MIT 著作權與授權全文見 [VSCode-LICENSE.txt](../public/third-party/VSCode-LICENSE.txt)，隨 public assets 複製至 production dist，供桌面發行包保留。

## 相容與行為契約

- settings version 1 保留；省略 themePalette 的舊設定採 Bay。合法但未知的色系／終端色票 ID 保留原值並暫用 Bay，介面標示 fallback，不重設其他設定。舊版程式降版讀取新增欄位不保證相容。
- 預覽只覆蓋外觀欄位。開啟設定期間若收到其他來源已儲存的設定，採新設定作為基準並捨棄舊草稿；取消不回寫過期快照。
- 設定開啟時停用頂欄快切；快速寫入期間停用設定入口，避免兩個編輯來源互相覆寫。
- 命令面板主題預覽使用獨立且僅含 theme／themePalette 或 terminalTheme 的覆蓋層；不擷取或還原完整 Settings。設定／快切擁有預覽時不另開命令選色器；取消不覆寫其後已保存的字型、縮放或其他欄位。
- 純外觀寫入可在背景索引中完成；任何非外觀變更仍受原有索引鎖保護。後端先完成原子檔案寫入才更新記憶體設定。
- 只換色不執行 terminal reset、fit、resize、focus、dispose 或 PTY launch/stop。所有開啟與隱藏面板共用目前預覽，終端內容／選取／游標狀態由既有 xterm 實例保留。
- 新色票與控制項使用 src/themes.ts 的共用 catalog／語意 tokens。自訂 CSS 與色票編輯器不在範圍內；不改寫使用者的既有字型、profiles、來源、Agent 參數或快捷鍵。

## 驗證（2026-10-16）

- TypeScript、ESLint、Vitest 全套、production build；新增 Settings 與 App 整合測試覆蓋立即預覽、反覆取消、Escape／關閉／Back、設定分類切換、成功保存後再次取消、延遲保存／重複送出／失敗重試、外部新基準、未知 ID。
- xterm mock 回歸檢查兩個面板（含隱藏面板）改色／回復使用同一實例，沒有重新啟動、重設、resize fit 或搶焦點。這不是原生 PTY 視覺驗收。
- 24 組 UI 色彩逐一檢查一般文字 4.5:1、必要控制邊界 3:1；24 組 Terminal 色票檢查 16 個 ANSI 色／文字／游標相對背景及選取文字 4.5:1。Code 色系額外檢查官方語意值對應、必要調整、獨立主按鈕／焦點／分頁對比、四組設定預覽取消及保存。原有 Bay／Classic 完整保留，不將其較低對比的 ANSI 色算作新色票通過。
- Rust 無 desktop features 全套核心／PTY 測試、fmt、Clippy。新增舊設定遷移、未知 ID roundtrip、非法 ID、索引中只保存外觀、寫入失敗不改記憶體測試。
- 尚未完成：原生 macOS／Windows／Linux WebView 截圖、實際操作時游標與選取畫面、系統亮暗切換及重開應用持久化的桌面實測。雲端瀏覽器未能連到工作區預覽伺服器；獨立 Chromium 的 sandbox socket／環境限制也未能完成截圖，沒有停用 sandbox 或拿 DOM 測試冒充視覺通過。

## 與其他獨立 PR 的合併

基於 main a609f04，不包含平台、原生資料夾對話框、持續 Runtime、OpenCode 或工作區日常操作 PR。SettingsPanel、App、TerminalPane、config.rs、service.rs 與文件可能重疊；合併時保留各自改動，重新跑相關回歸。此 PR 不合併、不發佈、不觸發完整三平台 CI。
