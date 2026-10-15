# MVP 實作與驗收紀錄

日期：2026-10-15。狀態：**P0 範圍的開發版本已實作；完整原生平台驗收尚未完成**。不能將本報告解讀成正式發布或兩個 OS 都已實機通過。

## 環境與結果

| 項目 | 實際結果 |
| --- | --- |
| 開發環境 | 隔離雲端 Debian 13 x86_64，AMD EPYC 9V74 host，約 9.7 GiB 可見記憶體；非獨占效能機 |
| 工具鏈 | Node 24.19.0、npm 11.9.0、Rust 1.99.0；套件版本由兩個 lockfile 固定 |
| Linux 桌面依賴 | 官方 Debian 套件，GTK 3.24.49／WebKitGTK 2.54.0；解壓至工作區，未修改使用者電腦 |
| 前端 | TypeScript、ESLint、Vite production build 通過；5 組共 98 測試通過；完整 npm audit（含 dev dependencies）0 vulnerabilities |
| Rust 核心 | 24 unit＋34 catalog＋17 PTY＋1 service 整合，共 76 測試通過（Darwin 修正的 Linux 回歸） |
| 完整 Linux crate | 預設 desktop features 的 cargo test 78 測試通過（含 2 個桌面生命週期測試）；all-target Clippy `-D warnings` 與 native cargo build 通過 |
| Linux executable | 真正 x86_64 ELF debug executable 已成功連結；未視為可跨 distro 發布的安裝包 |
| macOS | 首輪 macOS 15 ARM64／Intel 原生編譯成功；CI 找出 Darwin zombie leader 的 session 查詢差異，已加入修正與回歸測試；最新平台結果請查下方 PR Checks |
| Native GUI／截圖 | 未驗證；此環境 Chromium／圖形沙箱受限，未停用沙箱繞過，也未提供假截圖 |
| CI | 已啟動 Ubuntu 24.04 x64、macOS 15 ARM64／Intel 工作流程；首輪 Linux tests／Clippy／.deb bundle 通過，但 window smoke 找出 setup 前的 state 存取 panic，已加入防護與兩項回歸；macOS 另增隔離 HOME 的 20 秒啟動存活檢查。Linux 包含 Xvfb 原生視窗／截圖 smoke；建置與後續修正結果以 PR Checks 的 exact commit 為準 |
| 獨立程式審查 | 已通過修正後的資料唯讀、IPC、注入防護、程序所有權、關閉競態與布局恢復檢查；不等同平台驗收 |

遠端驗證：[Draft PR #1 與 Checks](https://github.com/wellwind/SessionBay/pull/1)、[首輪 native run](https://github.com/wellwind/SessionBay/actions/runs/38677233976)。本表記錄 Darwin 修正提交前已觀察的結果，不預先宣稱修正後 macOS 或 bundle 通過。

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
