# 全工作台縮放

日期：2026-10-16。後續待辦 01 的獨立日常體驗 PR，依賴主題即時預覽。使用者追加介面與 Terminal 一起縮放，因此取代原本僅調整終端字級的快捷鍵方案；文件路徑保留以維持既有連結。已實作，原生驗收仍待完成。

## 操作與範圍

- macOS 用 Cmd，Windows／Linux 用 Ctrl：加 `=` 或 `+` 放大，加 `-` 縮小，加 `0` 還原 **100%**。每次 10 個百分點，範圍 50–200%。沒有開啟 Terminal、停留在歷史頁面時也可操作。
- 原生 WebView page zoom 同時縮放介面、圖示與所有終端；不使用 CSS transform 或額外乘上 xterm fontSize。設定的「終端字型大小」仍為獨立基準字級，字型／主題保持獨立。
- 狀態列顯示原生 API 已成功套用的百分比；等待時顯示套用中／儲存中。原生縮放失敗與磁碟保存失敗均顯示錯誤，不宣稱失敗的倍率已保存；還原原生倍率若失敗，保留顯示實際套用值與錯誤。可按還原重試。
- 一般輸入／搜尋欄位、contenteditable、對話框及 IME 組字期間不處理快捷鍵；xterm 的隱藏輸入 textarea 可用。保留按鍵在 capture 階段攔截，上下界也不送進 PTY。支援按鍵事件的語意 `+`／`=`，不把非美式鍵盤任意實體鍵當成加號。
- 外觀設定提供「工作台縮放」百分比及「還原工作台縮放 100%」。立即預覽，儲存保留；取消並捨棄回到進設定前已保存的主題、終端字級與倍率。無效數值不送入原生預覽。
- 窄／矮視窗允許工作台捲動，Settings 在短視窗也可捲動到內容與取消／儲存。這是避免放大後裁切控制項的布局處理，仍需實際平台畫面驗收。

## 保存與生命週期

`appZoom` 是 Settings v1 的新增百分比欄位；舊檔缺少此欄位時預設 100。前後端驗證整數及 50–200 範圍；與主題共同列為索引中可保存的純外觀欄位，不放寬其他設定限制。

主題與倍率共用 Appearance 的窄欄位序列化／合併等待寫入，避免彼此覆寫。每次呼叫保留自己的 Promise<boolean> 結果；相同欄位被後來的要求取代回傳 false，真正保存才回傳 true，失敗會通知所有受影響呼叫。命令選色器仍有獨立預覽及世代檢查；只保存主題不會要求原生縮放。原生 setZoom 另有序列化／合併等待預覽，避免快速切換、取消及錯誤還原留下舊倍率；保存前必須確認原生套用成功。應待儲存完成才關閉程式，強制結束或未完成寫入不宣稱保存成功。

僅 main window 新增 `core:webview:allow-set-webview-zoom`；明確停用原生 `zoomHotkeysEnabled`，避免 WebView2 或 Tauri polyfill 成為第二個縮放來源。原生套用後排入動畫幀通知，現有可見 Terminal 重新 fit／resize；保留 ResizeObserver、DPR 追蹤與隱藏面板重新顯示後的 fit，不改 runtime IDs、PTY 啟停或輸出。

## 驗證與整合

本機 Linux：typecheck、lint、17 suites／497 tests、production build 通過；Rust `--locked --no-default-features` 核心 248 tests、fmt、Clippy 通過（另 1 個隔離子程序 helper 預設 ignored，由父測試執行）。44 組語義對比與 10 個圖示表示靜態檢查通過。

回歸涵蓋快捷鍵／界線／IME、沒有 Terminal 的歷史畫面、舊設定遷移、重開讀取、原生 IPC factor、快速連按與序列化、原生失敗不保存、磁碟失敗還原以及還原原生失敗時顯示實際倍率、Settings 預覽／取消／reset、非法數值、主題與倍率連續操作、Terminal fit／隱藏面板恢復且不重啟／不改基準字級。

待原生 macOS／Linux／Windows 驗收：50／100／200% 在預設及最小視窗的布局與捲動、游標／選取對齊、真實 Shell／Agent 輸出時 resize、不同螢幕 DPI、美式／非美式及數字鍵盤、IME、OS 熱鍵衝突、Settings 捲到底部後 Cancel／捨棄確認仍可到達，以及關閉重開。此環境 Chromium 仍以 socket `Operation not permitted` 失敗；GTK／WebKitGTK desktop build 依賴也未備齊，沒有以 DOM 或靜態檢查代替原生成功。

已整合 PR4 `bc5aef77` 的新主題／命令選單，回歸含命令選色器保存中關閉後連按縮放、失敗回復、後續 Terminal 主題保存不覆寫倍率／字型、延遲原生縮放與 Settings 取消。獨立複查未見 blocker。持續 Runtime 與其他並行 PR 合併後仍須重跑整合回歸；只接收新版 Appearance 的窄 patch，不以舊 Settings 覆寫 appZoom。完整平台 workflow 需另行手動驗收，不自動合併。Shift＋Enter 與 CLI 輸入協定不在此變更。

官方來源與平台限制見 [技術來源](sources.md#全工作台原生縮放2026-10-16)。
