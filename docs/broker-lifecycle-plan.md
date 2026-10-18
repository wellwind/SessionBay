# Broker 生命週期與安全升級計畫

狀態：使用者已確認產品方向，F1 已實作並記錄本機驗證，其餘新增功能尚未實作／驗收。#69 的啟動錯誤分類與 hooks 預設啟用已合併；不代表此計畫已完成。

## 已確認行為

- 關閉視窗只關閉介面。任何存活的 Shell／Agent 都保留；activity idle、等待輸入／權限不代表程序已結束。
- 沒有任何存活工作，也沒有介面 client 時，短暫等待後自動退出 broker。
- 提供「結束所有工作並退出」，明確確認後才停止 Agent、Shell 與 broker。
- 更新後新工作交給新版 broker；既有工作仍由原 broker 持有，直到其工作結束後退出。
- 不移轉活 PTY 的 owner、不以 PID 猜測接管、不自動重送結果不明的 Launch。
- 先完成目前工作台修正、broker 生命週期與單次無 hooks 啟動，再製作 Snap 測試包；不在此插入 Git 工作台等大型功能。

## 現況與缺口

目前 GUI 關閉保存 workspace 並 detach renderer，broker 繼續持有 PTY。broker 使用固定 `runtime-broker-v1` endpoint 與 OS ownership lock，沒有閒置自退、持續 UI lease、版本 registry 或 drain 協定。250 ms accept timeout 只供維護，不能當自退計時；MAX_CLIENTS 是進行中的 IPC 數量，不能代表有幾個 UI。

目前內部 Shutdown 能要求受管工作停止，但 GUI 尚無上述確認入口。runtime 的 failed 狀態也可能伴隨 ownership lost／cleanup error，不能單靠 List 的非 running 狀態判斷可安全退出。

#69 在送出 Launch IPC 前辨識舊 broker 缺少活動能力，明確回報未啟動；它不自動 fallback、不停止舊工作，也沒有新增第二個 broker owner。

## L1：單 broker 的安全生命週期

- [ ] 協商式 UI client lease，涵蓋正常關閉、reload、crash 與逾期。
- [ ] RuntimeManager 提供「無活工作且終止／清理已驗證」的權威判定。
- [ ] 零有效 lease、零活工作、零 in-flight Launch／清理才開始延遲退出。
- [ ] starting、stopping、unknown、ownership lost、cleanup error 均阻擋自退；activity 狀態完全不參與。
- [ ] 計時到期與新 Launch admission 使用同一同步界線，先重驗條件再關閉入口；新 client／Launch 取消計時。
- [ ] 「結束所有工作並退出」確認流程，先停止 admission，再清理受管程序；部分失敗明確回報，不假稱全停。

### L1 拆分與目前邊界

- L1a（本次）：RuntimeManager 正向清理證據、`quiescence()` snapshot 與原子 `try_close_if_quiescent()` admission seal；只對隔離工作測試，不啟用 broker 自退。本機測試通過，Linux CI 與獨立 review 待確認。
- L1b：協商式 UI lease 的 acquire／renew／release、crash／reload／過期與 legacy 退路。
- L1c：broker 整段 Launch admission、歷史 owner 不確定性、lease 與 grace timer 的同步邊界，再啟用安全自退。RuntimeManager 的 snapshot 不能代替這些證明，舊 UI／broker 不因一次 List 空而退出。
- L1d：Stop all 的使用者確認、admission 關閉及部分清理失敗回報。

L1a 本次的正向平台證據限 Unix；Windows 工作完成後仍保持未確認，待平台證據與原生驗收另補。L1a 的不確定性在記錄淘汰後保留；因目前 spawn rollback 無正向結果，任何平台 spawn 錯誤均保守禁止該 manager 的 idle seal。正常手動啟動不因此停用。尚未決定 lease／grace 時限，也未接入 production idle-exit caller，以上 L1 整體驗收不得勾選完成。

### L1a 本機驗證（2026-10-18，Apple Silicon macOS）

- Rust 1.99、`--locked --offline`：core 575 passed／3 ignored，desktop feature 579 passed／3 ignored；兩種 feature 的 all-targets Clippy（`-D warnings`）及 rustfmt check 通過。
- 新增五項 proof／poison／淘汰／Launch race 單元測試、三項隔離假 Shell 整合測試及一項隔離 broker 不自退回歸。Exit callback 用明確 gate 保持未完成；Launch race 使用 registry lock 與 channel 排序，不依賴猜測程序速度。
- 真實 idle prompt 在 seal 被拒絕後仍可輸入；已 reaped／清理完成且 supervisor 完成後才可 seal。spawn 失敗後 List 空仍為未確認，正常手動啟動仍可使用。
- 使用專用 `/private/tmp/sessionbay-l1-tests` 與 #78 worktree 的既有 target，低並行、關閉 debug symbols／incremental。先前 exec transport disconnected 與 crates.io sandbox DNS 失敗均未列為通過；恢復連線後使用現有 sparse cache 離線完整重跑，未安裝工具、未啟動模型或讀取真實歷史。
- 僅控制測試 broker／假程序；production broker 自退、UI lease、Stop all、Windows 原生證據與 L2–L4 都未驗收，不能因此勾選完整 L1 完成。

## L2：版本隔離與 owner routing

- [ ] 每個 broker 使用不可變 build identity 對應的獨立 endpoint、lock、metadata；generation 區分同版的每次執行。
- [ ] Registry 僅作發現索引，以獨立 OS lock 和原子更新保護；不能當程序所有權證明。
- [ ] 每個 runtime 保存 owner reference（instance、generation、runtime ID）；Attach、Write、Resize、Stop、Forget、activity、檔案能力皆回原 owner。
- [ ] 透過 owner-authenticated IPC 驗證 endpoint／generation；socket 無回應但 lock 仍被持有時保留未知，不能判死。
- [ ] 重複 pane/runtime ID、部分 broker 失聯及並發 GUI 啟動均不覆蓋其他 owner 的工作。
- [ ] Broker 只寫自己的 runtime metadata；共享 workspace／settings／catalog 的 writer 與 schema 策略須在多版本啟用前定義。

## L3：新工作切換與 drain

- [ ] 驗證新版 broker 能力後，原子切換新工作的目標。
- [ ] Launch intent 在第一次送出前固定 owner；遺失回覆只向同一 owner 查證，不切到另一個 broker 再啟動。
- [ ] Resume 若已在舊 broker 存活，仍 focus／attach 原 runtime，不建立第二份 session。
- [ ] 支援新協定的舊 broker 拒收新工作但維持既有互動；工作與 lease 清空後依 L1 退出。
- [ ] 更新保留舊 broker／hook helper 需要的 executable；退休清理可驗證後才移除。

## L4：Legacy 與資料遷移

已執行中的舊二進位不會自動學會 registry、lease 或 drain。新版可使用已知舊 endpoint 與相容協定讀取／路由，但不能替它宣稱新能力。

- [ ] Legacy 缺少原子 drain 與 client lease 時，不因一次 List 空就自動 Shutdown；舊 UI 可能同時 Launch。
- [ ] 未知協定、無法驗證 owner、清理不明或 IPC timeout 都保持保守狀態，不 kill、不重送。
- [ ] 舊 UI 不認識新鎖，不能宣稱兩代 UI 可安全共寫 settings.json／workspace.json／catalog.sqlite。需明確單 writer 過渡或隔離 schema store。
- [ ] 不新增長期 terminal 輸出保存作為退出捷徑；metadata 不能恢復已失去的 PTY 所有權。
- [ ] 更新中斷、rollback、可執行檔保留與 Windows 檔案鎖另行驗證；Linux 正確交付，不將其他平台未驗寫成通過。

## F1：明確單次無 hooks 啟動

這是獨立於版本升級的短期操作，已實作；Mac 合成測試通過，Linux CI 與獨立 review 待確認。

- [x] 只在 typed「舊 broker 缺 hooks 能力」的本地 preflight 拒絕後，提供「本次不啟用活動回報，繼續啟動」與取消。
- [x] Backend 保存有界、具原始期限的 rejected intent、broker generation、完整原 request／LaunchSpec。重複原請求不重新規劃。
- [x] 明確確認只移除本次 spec 的 hooks opt-in，其餘 executable、argv、cwd、env、權限旗標與產生的 pane ID 完全不變，不儲存長期偏好。
- [x] 同一 fresh mutex 下由 rejected 透過 admission CAS 原子轉成 send-once attempt；取消不等待 fresh／catalog／settings 鎖，能在 consume 前贏得競爭。雙擊、Enter＋click、兩種命令競爭最多送一次 Launch。
- [x] unknown outcome 不再提供繼續啟動；只查證／恢復原 owner 的既有結果。新錯誤不得重新產生可重送狀態。
- [x] 過期、generation 改變、影響啟動的設定變更、導航／關閉／取消使原操作失效，不偷偷採用新參數。UI 確認送出後仍保留 intent 至 IPC 結束；取消截止點是後端 consume，consume 後不停止或重送 Agent。
- [x] 首版僅限 fresh 新 Agent。既有 resume 照原本 focus／attach；需要啟動程序的歷史／手動 resume 暫保留明確錯誤，不能清除 resume identity 冒充 fresh。
- [x] 不加 legacy wire 欄位，不呼叫 stop／forget／revoke，不修改全域 hooks；無活動來源維持 unknown。

### F1 驗證紀錄（2026-10-18，Apple Silicon macOS）

- `npm run typecheck && npm run lint && npm test && npm run build`：61 個前端檔案、1,418 項測試與 39 項離線 plugin contracts 通過。
- Rust 1.99：完整 desktop crate 測試 559 passed／3 ignored，`cargo fmt --check`、`cargo clippy --locked --all-targets -- -D warnings` 通過。測試使用獨立 `/private/tmp/sessionbay-f1-tests`，低並行及關閉 debug symbols／incremental；Unix socket 測試須在 sandbox 外執行。最初 sandbox／符號連結暫存路徑／高並行結果不列為通過。
- Chrome 原生鍵盤確認測試 2 passed，合成 IPC 驗證 Escape 取消、Enter＋click 最多一次確認、不儲存設定、不停止既有工作，以及確認框不會使 launchContext 自我失效。[確認框截圖](validation/f1-hook-skip-confirmation.png) 已人工檢視。
- 後端假 broker 測試驗證原 request／完整 canonical spec 僅移除 hooks opt-in、雙命令競爭、unknown 不重送，以及取消／設定版本／catalog revision／期限／generation／參數變更失效。catalog 確認使用 SQLite immediate reservation，與 writers 排序；設定寫入使用 fresh→settings 鎖序。
- `npm run tauri -- build --debug --bundles app` 初版與取消修正後的未簽章 macOS app 均建置成功。初版使用既有 `ci-macos-smoke.sh`（僅改指向 debug bundle），空 HOME／合成深色／合成淺色三種原生 WebView DOM／IPC 情境通過。取消修正後重跑停在 mounted，等不到需兩個 animation frames 的 ready marker 而逾時；未回報 crash／bootstrap error，原因未確認。LaunchServices 前景診斷以 `-10810` 失敗，未修改安全設定或申請 automation 權限；不能把初版 smoke 當作取消修正後通過。此原生 smoke 不含 F1 特定按鈕、像素、IME 或真實 CLI 回合驗收；F1 互動以 Chrome＋後端假 broker 測試驗證。
- 獨立 review 的取消時序 finding 已補修：確認中的 UI ref 保留至 IPC 結束，取消使用獨立 admission CAS；外部 catalog writer／等待 fresh 的 barrier 測試及 UI 導航／關閉／reload／unmount gate 測試通過，consume 後的晚到取消不停止或重送。
- 未執行真實模型回合或讀取使用者歷史；Linux 交 exact-head CI，修正後仍待獨立覆核與主對話合併。其他 L1–L4 驗收仍未完成。

## 驗收門檻

全部項目目前未驗，完成後才勾選：

- [ ] idle Agent／shell prompt／權限等待在 GUI 關閉後繼續存活；重新開啟接回同一 runtime。
- [ ] 零工作零 client 延遲退出；到期同時 Launch／lease refresh 不誤退。
- [ ] cleanup error／lost ownership／不確定狀態阻止自退。
- [ ] 確認 Stop all 正常成功與部分失敗均有正確結果；取消不停止程序。
- [ ] 兩個 GUI 並發啟動只建立所需 owner；升級新舊並存、跨 owner resume、unknown legacy 安全。
- [ ] Launch lost reply、跨 broker 切換、重複 intent 不產生第二份程序。
- [ ] 單次無 hooks 精確保留 argv/cwd/permission，明確 false 設定與全域設定不變。
- [ ] 單次操作取消／過期／導航／設定變更與晚到回覆不重新開啟視窗、不偷取焦點。
- [ ] 更新中斷／rollback／retirement 不覆寫其他 broker 的 metadata 或共用資料。
- [ ] Linux tests、真實瀏覽器與必要程序驗證；模型回合與 Mac／Windows 驗收另列證據。

原始碼現況：`src-tauri/src/broker.rs`、`broker/client.rs`、`broker/transport.rs`、`runtime/unix.rs`、`fresh_launch.rs`、`service.rs`。本文件僅記錄已批准方向與待辦，不代表程式已新增這些能力。
