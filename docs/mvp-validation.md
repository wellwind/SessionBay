# MVP 實作與驗收紀錄

日期：2026-10-15。狀態：**P0 範圍的開發版本已實作；完整原生平台驗收尚未完成**。不能將本報告解讀成正式發布或兩個 OS 都已實機通過。

## 2026-10-15 自選專案導覽變更紀錄

本次需求將所有工作階段與左側自選專案分開，新增 curated 遷移與持久化、既有目錄加入、單層新資料夾建立、預覽加入及非破壞性移出；置頂保留為自選清單內的排序，未加入或移出專案的開啟工作區仍可到達。另修正普通 Shell 正常退出後移除面板／最後分頁，Agent 或異常退出仍保留診斷。

前一版遠端提交 `21f6cf0` 的 [CI run 38682505512](https://github.com/wellwind/SessionBay/actions/runs/38682505512) 已成功。這是本次變更之前的基線，不能作為本次程式碼或新導覽已驗證的證據。下方既有測試數字及平台結果也屬先前紀錄。

本次檢查點：導覽／Shell 於 Agent 擴充前有 159 個前端、9 個 curated backend 與 2 個 service focused 測試通過；這些是過程紀錄，不與最終總數相加。完成來源標題與開發啟動指令整合後的結果見下方本批驗證表。**最終提交的三平台 CI 仍待執行／確認，本地原生 UI smoke 受環境阻擋**；原始 P0／平台驗收勾選狀態不變。

先前文件檢查點的 `git diff --check` 與 45 個相對連結／章節錨點已通過；最新文件查核另列於本批紀錄。

本次需驗證的範圍：

- 新掃描不自動加入側欄；舊版手動加入／釘選升級為 curated，其餘保持未加入。
- 加入、名稱、置頂、移出在重開及重掃後維持；所有工作階段的原搜尋與預覽範圍不受影響。
- 既有目錄加入與 canonical 去重；建立只接受已存在的絕對父路徑與單一新名稱，不覆寫、不補建祖先；無效輸入、重複操作及取消均安全。
- 預覽加入不啟動程序；從未加入專案直接接續仍使用原始 cwd／既有 launch override，不隱含加入。
- 移出僅清 curated 與 pinned，檔案、歷史、索引、已開啟工作區及 Runtime 保留，且仍可切回工作區。
- Shell 從 starting／running 以結束碼 0 退出時移除 pane／最後 tab；Agent、非零／未知退出、錯誤、已退出及還原占位的診斷與狀態保留。

資料與環境邊界：隔離雲端的合成來源及暫存路徑；未存取使用者真實電腦或歷史。前端目前以絕對路徑欄位輸入，尚未提供原生目錄選擇器。本紀錄不代表新 Agent 種類／自訂參數或全部 P0 已完成。

## 2026-10-15 Agent 擴充與自訂參數變更紀錄

使用者追加 Grok Build、Antigravity CLI、每 Agent 自訂參數，以及明確啟用後不逐次重複確認的高風險權限模式。本批在既有導覽／Shell 修正上整合，與下方舊版測試數字及 `21f6cf0` 的成功 CI 分開記錄。

本批範圍：

- 四工具 executable／default Agent／設定與工作區種類；舊設定缺少新增欄位時補空參數及未勾選 opt-in，不改使用者已保存的來源清單。
- Grok Build 唯讀 summary／updates adapter、搜尋與預覽、rewind 及來源身份檢查；Antigravity CLI 僅新工作與手動 conversation ID 接續，歷史明確不支援。
- 後端 argv 白名單、值與長度限制、危險選項 opt-in、工具專屬預設與自訂權限模式優先；目錄、來源及 Session 身份仍受管理。
- `preview_launch` 與真正啟動共用計畫；手動 `resumeId`／索引 `sessionId` 互斥、Grok 多來源手動恢復歧義阻擋；預覽不執行程序。
- 風險警告與持久設定；保存一次後不重複增加 Session Bay 確認視窗，但不承諾略過 CLI 登入、信任或企業政策。

### 原生 CI 首輪修正

`ded2d69` 的 [run 38695015862](https://github.com/wellwind/SessionBay/actions/runs/38695015862) 在 macOS ARM64／Intel 通過前端與 Rust unit 檢查後，找出兩個新整合測試硬編碼 `/bin/true`，但 macOS 沒有該檔案。測試改用暫存目錄內自建的 `/bin/sh`＋`exit` no-op fixture，維持可執行檔驗證，不跳過 macOS 測試，也不更動產品啟動邏輯。

另以符號連結 TMPDIR 檢查路徑別名，發現既有 Runtime 測試直接比較未 canonicalize 的 cwd；斷言改與子程序的實際 canonical cwd 比較，保留 argv／env／退出碼的全部檢查。符號連結 TMPDIR 下完整 131 個 core 測試與獨立審查通過；一般 Linux 完整 134 個 desktop 測試、strict Clippy 亦通過。這些跨平台測試修正仍須由後續 exact-commit 三平台 CI 驗證，不能把 Linux 通過當成 macOS 已完成。

同一首輪的 Ubuntu 24.04 x64 已通過 230 前端／134 Rust、strict Clippy、`.deb` 與原生 DOM／IPC／設定及專案對話框 smoke；PNG 已複核繁中與新導覽正常。此證據只屬 `ded2d69`，不是後續修正提交的最終結果。

### 本批整合後驗證

下表為 2026-10-15 完成來源標題與開發指令整合後的工作樹檢查；不將舊 CI 或較早的 focused 數字加進總數，也不等同最終遠端提交已通過。

| 檢查 | 實際結果與證據邊界 |
| --- | --- |
| 前端 | 8 組、230／230 測試通過；TypeScript、ESLint 與 production build 通過（06:41 UTC 檢查點） |
| Rust 完整 Linux crate | `cargo test --manifest-path src-tauri/Cargo.toml --locked` 通過 134 個測試：40 unit、6 additional_agents、37 catalog、9 curated、19 Grok、21 Runtime、2 service；0 失敗 |
| Rust 無 GUI core | 來源標題整合後的獨立 `cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features` 全套 131 個測試通過；較早 125 個是先前檢查點，不累加。desktop 多出的 3 個測試另屬桌面整合 |
| 格式與靜態檢查 | rustfmt、headless 與完整 desktop all-target Clippy `-D warnings` 通過 |
| Linux 原生程式建置 | `cargo build` 成功；建置成功不代表視窗／互動已驗證，也不宣稱本批已重新產出安裝套件 |
| 本地原生 UI smoke | **受阻，未通過**。Xvfb 日誌回報 `Cannot establish any listening sockets`，無法建立顯示服務；應用隨後在 GTK 初始化時退出，未出現視窗。未以關閉 sandbox 或放寬 CSP 繞過，不能視為 UI 成功 |
| 三平台 CI | **新提交尚無成功證據**；Ubuntu 24.04 x64、macOS 15 ARM64／Intel 的 exact-commit build／smoke 待後續執行與結果確認 |
| 獨立審查 | 最終導覽／Agent／來源標題整合未發現阻擋問題；獨立重跑 additional_agents 6、catalog 37、Grok 19、adapter 7、launch_options 6、App 61 個 focused 測試通過。這些是重跑子集，不加進全套總數，也不替代原生驗收 |

本批回歸涵蓋四工具 argv／cwd／來源 env 替身斷言、設定遷移及持久化、危險選項 opt-in、受限自訂權限優先、啟動預覽／失敗／競態、手動與索引恢復去重、Grok metadata／缺檔／rewind，以及相鄰文字 chunk 合併後跨 chunk 的搜尋與預覽。Antigravity 不產生虛構可搜尋歷史。較早 10／17 個 Grok focused 結果由本次 19 個 Grok 回歸包含，不另行相加。

整合時保留使用者遠端變更：`0679b79` 的來源原生 Session 名稱、`eb2793a` 的 `npm run dev` 桌面啟動與 `dev:web` 分離，以及 `11233b8` 的 13 項[後續待辦](future-backlog.md)。該待辦本輪只保留文件，沒有實作或勾選完成；此紀錄也不代表已建立遠端合併 ancestry、合併 MVP 至 main 或完成新提交 CI。

尚未完成的真實 CLI／平台項目：各 CLI 支援版本矩陣、已登入帳號的新工作與指定對話接續、原生互動及權限提示。成功 spawn 或替身 argv 通過，不能宣稱真實對話已載入。僅使用隔離雲端的合成來源與暫存路徑，不讀取使用者真實電腦或已登入工具資料。

文件檢查已通過：本批 `git diff --check`、60 個相對連結／章節錨點、原始 143 項任務／9 項原生驗收勾選狀態不變，以及 13 項後續待辦維持未勾選。文件檢查不能替代功能測試。

## 環境與結果

| 項目 | 實際結果 |
| --- | --- |
| 開發環境 | 隔離雲端 Debian 13 x86_64，AMD EPYC 9V74 host，約 9.7 GiB 可見記憶體；非獨占效能機 |
| 工具鏈 | Node 24.19.0、npm 11.9.0、Rust 1.99.0；套件版本由兩個 lockfile 固定 |
| Linux 桌面依賴 | 官方 Debian 套件，GTK 3.24.49／WebKitGTK 2.54.0；解壓至工作區，未修改使用者電腦 |
| 前端 | TypeScript、ESLint、Vite production build 通過；6 組共 109 測試通過；完整 npm audit（含 dev dependencies）0 vulnerabilities |
| Rust 核心 | 28 unit＋34 catalog＋19 PTY＋1 service 整合，共 82 測試通過（Darwin 修正的 Linux 回歸） |
| 完整 Linux crate | 預設 desktop features 的 cargo test 85 測試通過（含 3 個桌面生命週期／診斷測試）；all-target Clippy `-D warnings` 與 native cargo build 通過 |
| Linux executable | debug executable 成功連結；Ubuntu 24.04 CI 已產出 release .deb 並啟動原生視窗；安裝流程未測，不宣稱跨 distro 通用 |
| macOS | 首輪 macOS 15 ARM64／Intel 原生編譯成功；CI 找出 Darwin zombie leader 的 session 查詢差異，已加入修正與回歸測試；最新平台結果請查下方 PR Checks |
| Native GUI／截圖 | 第三輪 Linux 程序／視窗 smoke 通過，但人工檢視 PNG 為純色，不能當作 UI 可用證據。已加入 pre-module 錯誤觀測、DOM＋IPC readiness、設定對話框操作、純色防護及 Xvfb graphics-only 修正；第四輪 DOM／操作與繪製通過，但 PNG 揭露缺少 CJK 字型；已加入 Ubuntu 字型依賴及 coverage 檢查，後續結果以 PR Checks／artifact 複核為準 |
| CI | 已啟動 Ubuntu 24.04 x64、macOS 15 ARM64／Intel 工作流程；首輪 Linux tests／Clippy／.deb bundle 通過，但 window smoke 找出 setup 前的 state 存取 panic，已加入防護與兩項回歸；兩 OS 另增隔離 HOME 的 DOM／bootstrap／設定對話框開關檢查。Linux 包含 Xvfb 原生視窗／截圖 smoke；建置與後續修正結果以 PR Checks 的 exact commit 為準 |
| 獨立程式審查 | 已通過修正後的資料唯讀、IPC、注入防護、程序所有權、關閉競態與布局恢復檢查；不等同平台驗收 |

遠端驗證：[Draft PR #1 與 Checks](https://github.com/wellwind/SessionBay/pull/1)、[首輪 native run](https://github.com/wellwind/SessionBay/actions/runs/38677233976)。本表記錄原生驗證修正提交前已觀察的結果，不預先宣稱後續 macOS 或 UI smoke 通過。

所有資料測試使用合成 fixture／暫存目錄，沒有讀取使用者真實 Agent 歷史。CLI 的測試替身只用於斷言 executable／argv／cwd／env，不宣稱已接上真實已登入工具。

## P0 對照

| 規格 | 已實作與自動驗證 | 尚待實機驗收 |
| --- | --- | --- |
| F01 偵測與來源 | 獨立 CLI／歷史狀態、自訂來源與 root、環境變數、版本探測逾時清理、錯誤隔離 | GUI 啟動 PATH、實際 CLI 版本矩陣 |
| F02 專案 | 跨 Agent canonical cwd 分組、搜尋排序釘選、手動目錄、失效目錄重定位、缺 cwd 未分類 | macOS 大小寫磁碟、真實 symbolic link／worktree 使用情境 |
| F03 Session 清單 | 分頁、日期／Agent／封存篩選、fallback 標題、子代理關係、mtime fallback 明示 | 真實歷史不同版本抽樣 |
| F04 搜尋預覽 | compact FTS5 候選＋literal 驗證，中文／ASCII／識別字、分頁 locator、stale 判斷、附件占位、純文字 | 原生 WebView 長列表與超長對話互動 |
| F05 恢復／新工作 | 來源與 cwd 預檢、獨立 argv、source env、同 Session 聚焦、程序退出與錯誤保留 | 真實 Codex／Claude 載入正確 Session；成功 spawn 只顯示待確認 |
| F06 普通 Terminal | 真實 PTY 輸入輸出、resize、獨立 cwd／Profile、搜尋、複製貼上 UI、退出狀態 | 兩 OS 的 IME、剪貼簿、互動提示、Vim、tmux |
| F07 分頁與面板 | 獨立 PTY、遞迴分割、拖曳比例、焦點／最大化、隱藏仍持續 ACK、明確關閉、受管程序清理 | 兩可見＋四背景的原生互動與輸入延遲 |
| F08 設定與保存 | 主題、字型、色票、快捷鍵衝突、Profiles、default Agent、原子寫入、占位還原不自動執行 | 真實關閉／Quit／重開，螢幕閱讀器與像素檢視 |
| F09 索引 | 完整行 checkpoint、append／truncate／replace／delete／archive、取消重建清除、schema migration、來源唯讀 | 大量真實來源、OS 權限／檔案事件差異；目前每 10 秒補掃 |

Service 整合測試涵蓋：同專案 Codex＋Claude 合成歷史 → 中文搜尋 → 預覽 → 真實 PTY 啟動替身確認恢復 argv／來源 env → 普通 Terminal → 原 transcript bytes 不變。它補足 backend 流程，仍不是 WebView／真實 Agent E2E。

## 本輪審查修正

- 面板在啟動中關閉的競態：採最新 runtime 狀態清理，卸載亦作防護。
- 重定位後重啟 Agent：使用最新 launch path，普通 Shell 的自選 cwd 保留。
- native close／Quit：先序列化並完成布局保存，再停止受管程序。
- bootstrap 失敗、損壞或較新布局：未改動時不以空布局覆寫原檔。
- 版本探測：逾時清理自有 session 子程序，避免留下 sleep 等後代。
- 來源刪除：移除搜尋內容，同時保留現有工作區導航；來源已失效的 Session 不允許恢復。
- Darwin zombie leader：以私有 OwnedChild 與 fresh waitid(WNOWAIT) 證明未回收的子程序所有權，不依賴 Darwin 對 zombie 失效的 getsid；ECHILD、live session mismatch 仍拒絕，對仍持有 child 但尚在退出中的短暫 ESRCH 只做有界重試，後代 process group 持續驗證成員。
- WebView 驗證：載入主模組前觀測 JS／CSP／資產錯誤，React 與 backend bootstrap 就緒後才跑 CI-only 設定對話框開關；正常啟動不自動操作。Bootstrap 可恢復失敗不鎖死 Retry。
- Darwin 空群組：發訊號前確認 live member；若最後成員退出造成 EPERM，必須 fresh 完整掃描證明已無 live member 才視為完成。真正權限、ownership 或列舉錯誤仍回報。
- Linux 繁中字型：原生截圖發現最小 Ubuntu 環境缺 CJK 字型，`.deb` 與 CI 加入官方 fonts-noto-cjk，CSS 明確 fallback 至 Noto Sans CJK TC，CI 檢查 zh-tw coverage。
- Darwin PTY 背壓關閉：session leader 退出時的 ttywait 仍需 master 排空；明確停止後保留每輪最多 16 KiB 非阻塞讀取並丟棄，不等待 ACK、不產生新 Output／credit，維持 3 秒期限。新增達到實際 credit exhaustion、忽略 HUP／TERM、Ctrl-S／XOFF 暫停的回歸；Darwin 停止時對自有 master 一次 TIOCSTART 恢復排空，不注入鍵盤輸入。
- 跨平台測試：預期 cwd 與產品同樣 canonicalize，避免 macOS /var → /private/var symlink 造成假失敗。

## 效能

使用 `src-tauri/examples/catalog_benchmark.rs`，release build、完全合成 JSONL。每類 query 暖機一次後量測 20 次，p95 採排序後第 19 個樣本。計時包含 SQLite 查詢與 Session 結果建立，不含 WebView／IPC 呈現。資料內容重複，不能代表所有真實歷史分布。

原始 JSON 與最後量測見 `validation/`。一般 1,000 Session 約 104 MiB 與壓力 10,000 Session 約 2.03 GiB 都測量；未通過的目標如實保留，不能以罕見詞很快宣稱所有搜尋達標。

最後結果（ms）：

| 資料規模 | 中文 p95 | 英文識別字 p95 | 大寫查詢 p95 | 罕見詞 p95 | 未命中 p95 | 初次索引 | 未變更補掃 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000／109,242,670 bytes | 29.3 | 51.0 | 64.4 | 2.4 | 1.1 | 2,199 | 15.4 |
| 10,000／2,180,456,670 bytes | 409.8 | 881.2 | 860.9 | 23.4 | 10.0 | 43,350 | 115.0 |

以上五種查詢在這組合成資料通過 roadmap 的 300 ms／1,000 ms backend warm-query 目標，沒有索引錯誤。包含 ASCII 不同大小寫的 common identifier；不能推論所有實際資料分布或 UI 已達標。雲端並非獨占環境，索引階段曾與短時間開發檢查重疊，因此不以索引耗時作跨產品比較。

尚未量測：UI 首次互動時間、端到端按鍵延遲、最大 PTY 穩定吞吐、完整程序樹／GPU 記憶體、兩 OS 的長時間 soak test。

## 試用前的原生驗收清單

以下需在乾淨、可操作圖形桌面的 macOS／Ubuntu 執行，記錄 OS、架構、WebView、CLI 版本；沒有執行的項目維持未勾選。

- [ ] 三個 CI runner 的 tests／Clippy／unsigned bundle 都成功
- [ ] 兩個 OS 啟動 app，來源預設與手動覆寫正確，取消掃描後仍能操作
- [ ] 實際 Codex／Claude 搜尋、預覽、恢復正確對話，工具缺失有修正入口
- [ ] 中文輸入、複製貼上、快捷鍵、Shell、Vim、tmux、互動式 CLI 正常
- [ ] 兩個可見面板與四個背景面板，resize／切換／最大化不重啟或丟輸出
- [ ] 關閉啟動中／執行中 pane、tab、window、Quit，程序樹無受管殘留
- [ ] 重開只有占位，明確操作才啟動；新版本／損壞布局不被無意覆寫
- [ ] 檔案追加、封存移動、來源消失在補掃後更新，既有 Terminal 不受影響
- [ ] 原生效能、資源使用與長時間壓力符合 roadmap 的校正後門檻

## 交付與邊界

包含可建置原始碼、lockfiles、合成 fixtures、自動測試、開發指南及 private-repo CI 設定。沒有發布、合併 main、簽章／公證、開啟自動更新或加入用量 P1 功能。macOS／Linux 的原生驗證與實際 CLI 相容矩陣仍是正式宣稱完整 P0 的必要條件。
