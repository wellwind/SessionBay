# 工作區整理

日期：2026-10-16。範圍：後續待辦第 02–05 項的獨立日常體驗 PR，狀態為已實作待原生驗收。

## 操作

- 專案／目錄選取後，標頭「重新命名專案」修改顯示名稱；不重新命名實際目錄，也不改加入專案的狀態。
- 每個工作分頁旁的鉛筆重新命名分頁；終端工具列的鉛筆重新命名該面板。兩者各自獨立。
- 名稱去除首尾空白，最多 200 個 Unicode 字元；空白、超長與控制字元有明確錯誤。重複名稱允許，完整路徑與分頁位置協助辨識。長名稱可截短顯示，但輸入框與工具提示保留完整文字。
- 名稱對話框的取消、Escape 與背景點擊均不寫入。專案送出期間鎖定取消和重複送出，失敗保留草稿，成功才關閉。
- 拖曳分頁標題到另一分頁的左／右半部，插入該分頁之前／之後。指示線表達位置；只有 drop 寫入，Escape、移出或取消拖曳不變更。
- 聚焦分頁標題後按 Alt＋←／→ 移動；邊界不循環，組字期間不處理。螢幕閱讀器收到新位置。這只處理已聚焦的分頁按鍵，不攔截 Terminal 的輸入。
- 重排只在同一專案內進行，不移動其他專案的分頁；既有數字／前後分頁快捷鍵使用更新後的排列。

## 資料與生命週期

沿用 Workspace version 1、WorkspaceTab.name、Pane.title 及既有專案 name API。分頁與面板由原保存佇列及關閉前 flush 寫入；專案由 catalog 寫入。改名、重排不更動 ID、layout、cwd、runtimeId、startToken 或 Session 關聯，不呼叫 launch／stop，不以 React key 改名。

既有還原仍為安全布局占位；本 PR 不增加存活程序恢復。持續 Runtime PR 優先；合併它之後需 rebase 本 PR、保留其 reconcile／重新附接行為及 saved pane title，再重跑全部驗證。亦須檢查並行主題 PR 對 App／TerminalPane 的整合。

## 自動化驗證

- 本機 Linux 前端 typecheck、lint、Vitest（15 suites／421 tests）與 production build 通過。
- 新增純函式與 UI 測試：名稱邊界／Unicode、取消與失敗重試、連按與忙碌鎖定、跨專案隔離、drop 前不寫、Escape／dragend 取消、外部拖曳拒絕、鍵盤移動與邊界、數字快捷鍵、名稱與順序 serialization round-trip。
- App 整合測試：名稱與排序進入保存佇列、只送專案 name、不新增專案／目錄、未重建 workspace canvas。
- Terminal 模擬回歸：改名保留實例，沒有 stop／relaunch，原 runtime 仍可接收輸入。
- 焦點安全回歸：真實 textarea 焦點驗證未聚焦面板及 starting→running 的延遲 rAF 不會搶走名稱輸入框；即使先關閉對話框也保留 opener。共用 Dialog 涵蓋子元素 autoFocus、IME Escape 不丟草稿、Tab／Shift＋Tab 循環與正常 Escape 返回焦點；正常 Terminal 重新顯示仍可聚焦。
- Rust 核心／PTY 測試包含既有專案改名後的 membership、Session metadata、重啟／重建索引保留，以及真實 PTY 輸入／輸出／退出處理；此 PR 沒有 Rust 程式碼變更。
- 本機 Rust `--locked --no-default-features`：241 tests 通過；1 個隔離子程序 helper 預設 ignored，由父測試單獨執行。fmt、核心 Clippy、44 組語義色彩對比及 10 個圖示表示檢查通過；靜態資產檢查不是逐畫面驗收。

## 尚待驗收

- macOS／Linux 原生 WebView：滑鼠／觸控板拖曳與取消、Alt 方向鍵、IME、焦點返回、長名稱、縮窄視窗及深／淺色視覺。
- 真實 Shell／Agent 長時間輸出時改名／重排不丟輸出，以及實際退出重開後的名稱／順序。
- 此環境 Chromium 啟動受限（socket Operation not permitted；標準 sandbox escalation 啟動亦失敗），未取得可靠畫面截圖；DOM 測試及靜態色彩檢查不能替代原生視覺驗收。
- GitHub 完整桌面驗收 workflow 為手動觸發；尚未執行或受資費限制不算通過。本 PR 不自動合併或發布。
