# Windows 安裝／解除安裝 CI

獨立手動 workflow `windows-installer-smoke.yml` 只使用 `windows-2022` x64 runner；不改既有四平台 matrix，也不增加 push／PR 預設工作。必須填入完整小寫 40 字元 `source_sha` 並勾選 `confirm_disposable_install`。沒有勾選時 job 跳過，不能算通過。

Workflow 在 `harness` checkout 自身 workflow commit，在 `source` checkout 指定的官方 `wellwind/SessionBay` SHA。測試記錄兩者，使用該 source 的鎖檔、Rust toolchain、正式 `dev.sessionbay.desktop`／`Session Bay` 產品設定建置全新 NSIS；不下載第三方安裝包、不修改產品 ID。執行前請先審核指定 source 與 harness commit。來源 SHA 固定不代表已簽章或經安全審查。

## 範圍與保護

- 腳本預設拒絕本機執行，要求明確 switch、官方 repository、manual event、GitHub-hosted Windows x64 win22 與 opt-in 標記。這些防呆欄位可被刻意偽造，不是敵對環境的安全邊界，禁止在工作站或 self-hosted runner 偽造它們。
- 預檢既有 app data、產品登錄、程序、捷徑與 autostart；發現衝突就停止。要求已有 WebView2，不安裝系統相依、不提升權限或修改安全設定。
- `/S /NS /D=...` 安裝到本次 runner temp 的唯一目錄；比對 payload SHA256、x64 PE、版本與 currentUser 卸載登錄。NSIS x86 loader 與 x64 payload 分別記錄。`/NS` 抑制捷徑建立，因此只檢查捷徑沒有出現，**未驗證捷徑建立／刪除**；result 明列此覆蓋限制。
- 對**已安裝**執行檔呼叫指定 source 的 `ci-windows-smoke.ps1`：空 sources、合成設定、停用 Agent 路徑、dark/light window、frontend interaction／IPC 及 broker 清理。這是既有程式內建 smoke，不是人眼驗收或獨立 UI automation；不讀歷史或剪貼簿。
- 正常 `/S` 卸載，不用 `/UPDATE` 或 `_?=` 替代。launcher 結束後，用單一 60 秒 deadline 同時等待程式目錄、卸載登錄與捷徑均不存在，再做 final assertions 與程序檢查，並驗證新建合成 app-data sentinel 保留。NSIS 先刪目錄再清登錄，不能只等目錄消失。Timeout 保留最後觀察狀態，不強制終止或補刪產品。若殘留程序則拒絕卸載，以免 NSIS 強制終止工作。
- NSIS 預設保留 manufacturer preferences 與未勾選刪除的 app data；報告明列保留狀態，不將此宣稱為清除所有登錄／資料。測試不手動補刪失敗殘留，交由 hosted VM 回收。

## 執行與證據

由主對話／維護者 review、發布 workflow 後手動 dispatch；此文件與實作本身不代表已 dispatch 或通過。沒有 dispatch connector 時由維護者在 GitHub Actions 選此 workflow，提供已核准 source SHA 並勾選確認。

Artifact 包含 `result.json`（source/harness SHA、架構、版本、hash、各階段結果與錯誤）、正式 installer、generated NSIS 和 installed-binary native smoke logs。安裝前的拒絕會顯示於 job log；若未建立 result，不能視為 PASS。失敗仍上傳可取得證據。正常卸載的 launcher exit code 與檔案／登錄消失分開檢查，避免只等待自解壓父程序就誤判成功。

本機可安全執行 `pwsh -NoProfile -File scripts/test-windows-installer-guards.ps1`；只測防呆、合成 PE 檔，以及合成卸載完成訊號的順序、延遲、各訊號 timeout 診斷，不安裝任何東西。

## 限制與官方依據

查閱日期：2026-10-17。[GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 說明標準 Windows job 使用新 VM；`windows-2022` 為 x64，Windows 預設管理員且 UAC 關閉。此 workflow 不改其安全設定，也不能證明一般帳號、UAC／SmartScreen、簽章／信譽或 ARM64 體驗。官方另列 ARM64 runner，此流程沒有選用或驗收它。

[NSIS command line](https://nsis.sourceforge.io/Docs/Chapter3.html) 支援 installer／uninstaller `/S`；`/D` 必須最後、絕對路徑且不加引號。此流程保留預設 CRC 驗證。安裝模式亦參見 [Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/)。FB16 原有 app data 不受此流程影響。
