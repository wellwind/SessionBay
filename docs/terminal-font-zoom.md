# Terminal 字級快捷鍵

日期：2026-10-16。後續待辦 01 的獨立日常體驗 PR，stack 在主題即時預覽 PR；已實作待原生驗收。

## 操作與範圍

- 目前顯示工作區時，macOS 用 Cmd，Linux 用 Ctrl：加 `=` 或 `+` 放大，加 `-` 縮小，加 `0` 還原 **14 px**。支援鍵盤送出的語意 `+`（含數字鍵盤），不把非美式鍵盤的任意實體位置強當成 `+`。
- 每次 1 px，限 9–32 px；作用於全部終端（包括隱藏面板及後續新面板）。介面字級與瀏覽器縮放不變。
- 立即套用並保存；狀態列顯示大小與儲存中。連按會合併等待寫入的最新值，所有寫入序列化。失敗還原上次成功保存值、清除未保存的等待變更並提示錯誤，可再次操作。應待儲存完成才關閉程式；未完成的寫入、強制結束與異常退出不宣稱保存成功。
- 一般輸入／搜尋欄位、contenteditable、對話框及 IME 組字期間不處理快捷鍵；xterm 的隱藏輸入 textarea 可用。攔截發生在 PTY 輸入之前，上下界無變更的保留按鍵也不傳入終端。
- 設定的字級欄位預覽全部終端；儲存保留，取消並捨棄回到進設定前已保存的字級。主題與字級共用 Appearance 保存機制，避免兩者競爭覆寫。

## 驗證與整合

本機 Linux 已通過 typecheck、lint、15 suites／443 tests、production build；Rust locked／no-default-features 核心 246 tests、fmt、Clippy 通過（另 1 個隔離子程序 helper 預設 ignored，由父測試執行）。44 組語義對比與 10 個圖示表示靜態檢查通過。

純函式覆蓋兩平台、plus／equal／數字鍵盤、範圍、reset、IME、按鍵透傳與保留快捷鍵衝突。App 測試覆蓋快速連按、序列化寫入、錯誤回復、設定預覽／取消／保存、主題保存與 zoom 連續操作、原有 workspace 身分與生命週期保持。Terminal 測試確認 font options、可見面板 fit／resize、隱藏面板回到前景後 resize、輸入輸出續行，不 reset／relaunch／dispose。

本 PR 依賴主題 PR 的 Appearance。持續 Runtime 仍優先；合併及 rebase 後須重跑設定／生命週期整合。Windows 的設定路徑驗證由獨立平台 PR 處理，本組不重複修改。

待原生 macOS／Linux 驗收：美式／非美式鍵盤、數字鍵盤、IME、作業系統快捷鍵衝突、真實 Shell／Agent 輸出時 resize、隱藏面板恢復、設定取消與實際重開。此環境 Chromium 啟動受限，未取得可靠新截圖；DOM 與靜態檢查不當作原生畫面驗收。完整三平台 workflow 需另行手動驗收，不自動合併。

Shift＋Enter 保留獨立待辦；本 PR 不變更 Enter、LF、Ctrl＋J 或任何 CLI 輸入協定。
