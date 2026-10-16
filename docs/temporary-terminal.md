# 全域臨時 Terminal

## 操作與範圍

從頂列「臨時 Terminal」或命令面板「開啟臨時 Terminal（家目錄）」可直接開啟。即使沒有任何專案，也可使用。普通 Terminal 快捷鍵在總覽／臨時工作區開啟 home Shell；在專案內仍保留原本的專案啟動器。

- 沿用設定中的預設 Shell Profile、參數與環境設定，不新增另一套設定。
- 每次可新增獨立分頁，支援現有分割與分頁快捷鍵。側欄「開啟中的工作區」可從專案或所有目錄頁切回。
- 分頁、面板與 Runtime 的 project 身分皆為 null；不把家目錄加入 catalog，不建立 workspace-only 假專案。
- 關閉介面只 detach。重開從 broker 找回同一 Runtime 與畫面；明確關閉面板只停止／移除該 Runtime。沒有 broker 可附接時只還原占位或 interrupted 狀態，不自動重啟。

## 家目錄與舊版相容

前端省略 project/session/resume/cwd，由 Rust 透過 `dirs::home_dir()` 取得本機家目錄，要求絕對、存在且為目錄，失敗時明確報錯。此解析發生在套用 Shell Profile 的 HOME／USERPROFILE 之前；WebView 不能提供任意環境來替代解析。設定中的 Profile 執行檔與 argv 仍按既有平台驗證。

家目錄是程序最初 cwd；使用者 Shell 啟動檔仍可能自行切換目錄。Session Bay 不讀寫 rc、不強制覆寫 Shell 自己的行為。

`projectId: null` 不代表必須從家目錄重啟。舊有 workspace-only Shell 也可能沒有 catalog project，但具有明確 cwd。broker 的 `homeDirectory` 欄位另存啟動策略，舊 manifest 缺欄位預設 false。reconcile 以 broker 策略覆蓋保存 layout；新 home Terminal 明確重新啟動時再次由 Rust 取得家目錄，舊 explicit-cwd Shell 維持 broker 確認的路徑。

這是 PR #7 持續 Runtime 上的獨立變更，其下依賴 PR #3 三平台支援。合併依序為 #3 → #7 → 本 PR，前兩者合併後再協調調整 base；不複製 broker／平台實作。若仍運行不認識新 home 啟動欄位的舊 broker，新 home 啟動會明確失敗而不重啟既有程序；應先明確結束舊 sessions 再更新 broker。

## 驗證清單

- 自動前端：空專案直接開啟、預設 Profile、多分頁／快捷鍵、切頁找回、null 布局還原、無假專案、broker 恢復、只關閉目標 Runtime。
- 自動 Rust：家目錄驗證、Profile HOME／USERPROFILE 不改初始 cwd、真實合成 Shell 讀取自身 cwd、catalog 保持空白、舊 metadata 策略相容。
- Broker E2E：兩個合成 Shell，關閉 client 後重新連線保留同一 ID，輸入仍到同一程序，關閉其中一個後另一個仍執行。正常 Linux CI 執行；本機受 Unix socket sandbox 限制，不能把本機未執行的 E2E 算成 passed。
- 待原生驗收：Windows ConPTY、macOS 與 Linux 桌面 WebView 的頂列／窄視窗／鍵盤／真實 Shell 啟動檔。Windows 交叉編譯不代替原生通過。當前環境 Chromium socket 啟動亦受限，尚無新的原生截圖。

不包含檔案瀏覽、SSH、遠端主機、Web Terminal 或使用者歷史／憑證。合成測試不執行付費 Agent。
