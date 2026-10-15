# Session Bay 完整功能與開發任務

> 2026-10-15 實作更新：本次包含 macOS＋Linux 的 P0 程式碼；以下仍保留規劃與驗收目標。實際通過項目、效能及未驗證平台見 [MVP 驗收紀錄](mvp-validation.md)，不能由檔案存在推定所有任務已完成。
原始規劃整理日期：2026-10-15；以下保留原始 143 個穩定 ID，並依使用者最新要求逐項更新已完成狀態；部分實作或缺少必要驗收者仍未勾選。依最新澄清，交付主線為「專案首頁／所有目錄總覽 → 選目錄 → 找歷史 → 預覽 → 接續 Agent → 分割普通 Terminal」；完成 P0 才構成完整 MVP。

功能與驗收依據為[產品規格](product-spec.md)、[介面規格](ux-spec.md)、[架構](architecture.md)、[Agent 整合規格](agent-integrations.md)、[用量規格](usage-spec.md)及[路線圖](roadmap.md)。技術組合與未定選項沿用[決策文件](decisions.md)的狀態，任務拆解不代表已核定選型或新增產品承諾。

## 2026-10-15 最新需求補充紀錄

10:16 UTC 已推程式提交 `1475f19d83f4d5218fcaae1be71bb9109a7bd71a`，保留 main `e5b85ddb` 的 17 項待辦 ancestry。本機 398 個前端、241 個 core／245 個 desktop、typecheck／lint／build、兩種 features strict Clippy／fmt 與最後 3.92 MiB Linux bundle 全部通過。該 SHA 的 [CI run 38719056271](https://github.com/wellwind/SessionBay/actions/runs/38719056271) 三平台均在任何 step 開始前 failure，逐一確認 steps 為空，未重跑；原因待 GitHub annotations，不算程式測試結果。真實 CLI 1.3.5 樣本、原生畫面與人工操作仍待驗收。

最新追加的統一「偵測歷史來源」、分頁／面板快捷鍵、特定 CapsLock 組字修正、Antigravity 完整歷史與 breadcrumb 修正，另列 ADD-16–ADD-20；本批完整回歸與 exact-commit CI 尚待完成，Antigravity 已確認為 CLI 1.3.5，已實作已觀察格式的防禦 reader；真實 1.3.5 磁碟樣本與原生驗收仍待確認。下方 324／157 個測試與 `bcd3bcc` 提交不包含這些追加變更，不能據此提前勾選新增驗收。

最新使用者澄清由[雙頁導覽、來源入口與圖示紀錄](mvp-validation.md#2026-10-15-雙頁導覽來源入口與-macos-圖示修正)單獨驗證，不沿用下方前一批 230 個前端／134 個 desktop 測試或 `f6a9e1d` CI 作為本批通過證據。

| 範圍 | 本次要求 | 目前證據與待辦 |
| --- | --- | --- |
| 專案與所有目錄 | 專案是預設首頁且僅 curated；所有目錄為獨立頁且包含所有有 Session 的分組；兩頁有卡片／側欄，選組後才顯示歷史 | App／History 導覽與過期結果回歸通過；未知／失效／未加入分組保留。最終 native smoke 與 exact-commit CI 待確認 |
| 工作區可到達 | 兩頁保留已開啟工作區入口；加入狀態／遷移、原始 cwd 與 Runtime 不變 | App／workspace／service 回歸已覆蓋跨頁、移出、背景面板保留及所選目錄查詢 |
| 四 Agent 來源設定 | 固定四張能力卡片；啟動與歷史能力分開；舊設定可新增 Grok 草稿、輸入絕對路徑並保存，Antigravity CLI 同樣有明確來源流程，版本驗收另列 | 不猜 home、不自動變更既有來源或索引新根目錄；新舊設定／多來源／取消回歸通過 |
| 工具登錄與安裝 | 前後端共用 manifest、內建 typed parser／安全驗證；安裝／版本重新偵測與索引分離 | 共同 manifest、typed parser 與安全驗證回歸通過；版本失敗／缺失／未知登入分開，未知格式不自動獲得 adapter |
| 操作一致性 | 搜尋快捷鍵維持所選目錄、焦點外框與可及性控制項、Shell／Agent 兩段式啟動器與標誌下拉 | 前端最終 324／324、typecheck／lint／build 及 controls 33 個焦點／鍵盤回歸通過；native smoke 待 exact-commit CI 確認 |
| Shell 候選 | 唯讀重新偵測、明確加入／保存，保留自訂 Profiles 與預設；全新 `$SHELL`／平台 fallback＋`[-l]`，不匯入 rc | Shell 14 個 focused 回歸及新舊設定測試通過；包含已存 aliases 排除與設定 bytes 不變 |
| macOS 圖示 | 原圖 412／512 置中、外緣透明；可重複產生 macOS ICNS，不覆寫其他平台圖示 | 10 個 representations validator 通過、舊版被拒絕、兩次產生 byte-identical、7 個既有資產雜湊不變；原生 Cmd+Tab／Dock 視覺驗收待完成 |

此批未實作 [17 項後續待辦](future-backlog.md)。原先凍結勾選狀態的限制已由使用者要求「把已完成的 check list 都勾選」取代，最新逐項稽核見下節。圖示比例是專案視覺選擇，不宣稱 Apple 官方規定。文件 diff 與 64 個相對連結／章節錨點檢查通過；此文件檢查屬更新勾選前的歷史檢查點，不代表最新稽核數。

## 2026-10-15 本次需求工作紀錄

本節保留雙頁導覽澄清前的自選專案、Shell 正常退出修正與追加 Agent／參數整合紀錄，當時未更動原始 143 項狀態；最新勾選以本次逐項稽核為準，不把整批直接標為完成。整合後已通過的自動測試與仍待完成的原生／CI 項目分開記錄，詳見[本批驗證紀錄](mvp-validation.md#本批整合後驗證)。

| 範圍 | 本次要求與完成證據 | 目前驗證狀態 |
| --- | --- | --- |
| 自選專案狀態 | 新增 curated；只遷移舊版手動／釘選項；重開、補掃、重建保留選擇及名稱 | 納入 134 個 Rust 回歸，含 9 個 curated 測試 |
| 導覽與歷史 | 所有工作階段涵蓋未加入項；專案區僅 curated；置頂只改排序；已開啟工作區獨立可到達 | 納入 230 個前端回歸；原生 smoke 待 CI |
| 加入與建立 | 既有絕對目錄＋可選名稱；已存在父目錄＋單層新名稱；預覽加入；無原生目錄選擇器 | 合成路徑與 UI 自動回歸通過；真實目錄互動待原生驗收 |
| 非破壞性移出 | 只清 curated／pinned，保留歷史、索引、檔案、工作區與 Runtime；不改 cwd／重新定位 | 回歸包含持久化與工作區保留，審查修正已納入 |
| Shell 正常退出 | 僅 starting／running Shell 結束碼 0 移除 pane；最後 pane 移除 tab；Agent／異常退出保留診斷 | 成功／異常／Agent／還原占位前端回歸通過 |

追加工作依 [Agent 擴充決策](decisions.md#2026-10-15-新增-agent-與每工具啟動選項)追蹤：

| 範圍 | 本次要求與證據 | 目前驗證狀態 |
| --- | --- | --- |
| 四 Agent 設定 | 加入 Grok Build／Antigravity CLI，執行檔預設與既有設定遷移 | 納入整合後前端 230／Rust desktop 134 個測試 |
| Grok 歷史 | 官方 summary＋updates、cwd／身份核對、rewind、唯讀、stale 降級及相鄰文字 chunk 合併 | 19 個 Grok 測試通過，已含於 134 個 Rust 測試；真實格式版本待驗收 |
| Antigravity CLI | 新工作／手動 ID、唯讀 CLI 歷史與受限制索引接續；無 App／IDE 宣稱 | 合成 reader／metadata／啟動替身及 UI 回歸；真實 CLI 1.3.5 磁碟樣本與已登入接續待驗收 |
| 每工具參數 | JSON argv、白名單、受管身份／來源／cwd 防覆寫、危險 opt-in 及明確受限權限優先 | 安全拒絕、遷移及精確 argv 回歸通過；CLI 實際權限政策仍由工具決定 |
| 精確啟動預覽 | 共用後端計畫、預覽不 spawn、變更後重新預檢、手動／索引 ID 分離及恢復去重 | 預覽、實際 argv、失敗／競態與來源去重回歸通過 |
| 使用者遠端變更保留 | 原生 Session 名稱、`npm run dev` 桌面啟動／`dev:web` 分離、13 項後續待辦文件 | 來源標題回歸已納入；後續待辦未實作，遠端 ancestry 與新提交 CI 尚待確認 |

整合後前端 8 組 230 個測試、TypeScript、ESLint、production build，以及 Rust 無 GUI core 131 個／完整 Linux crate 134 個測試、rustfmt、兩種 features 的嚴格 Clippy、原生程式建置已通過。最終獨立審查未發現阻擋問題，focused 重跑通過；這些子集不加進全套總數，也不替代原生驗收。導覽／Shell 早期的 159 個前端與 focused 檢查是歷史檢查點，不與最終總數累加。

本地原生 UI smoke 因 Xvfb 無法建立 listening socket 而受阻，沒有視窗成功證據；未修改 sandbox／CSP，後續需確認三平台 CI 的 exact commit 結果。新 CI 尚未通過，不將舊成功 CI、已建置程式或自動測試等同完整 P0／真實 CLI 驗收。

本次僅使用隔離雲端的合成歷史與暫存目錄，不讀取使用者電腦或真實 Agent 歷史。原始勾選在該歷史檢查點保持不變；最新狀態以本次稽核為準。[13 項後續待辦](future-backlog.md)也維持未來待辦，不併入本輪實作。

## 2026-10-15 完成狀態逐項稽核

依使用者最新要求，只有滿足本列完成條件且有程式／文件／測試證據的項目才勾選；前置任務未驗收不會被下游局部實作倒推為完成。原生、真實 CLI、效能及正式發行要求不以合成測試替代。

- 原始任務：**143 項，77 已完成、66 未完成**；各列最後一欄提供證據或未完成原因。範本中的 3 個 checkbox 不是實際任務，不計數。
- 追加需求另列 ADD-01–ADD-20，與原始 ID 分開計數；與原始功能有交集，不加總為獨立功能數。
- 來源偵測／快捷鍵／breadcrumb 最新檢查點 frontend 13 檔 380／380、typecheck／lint／build 通過；Rust bounds／saved-ID 修正後通過 176 個 headless／180 個 desktop 測試、雙 features all-target strict Clippy／fmt，breadcrumb 前的 Linux release `.deb` 重建成功（約 3.86 MiB）；追加 breadcrumb 後前端全套也通過，完整原生 bundle 以新 exact-commit CI 為準。上一個 174 core／178 desktop 檢查點不含最後兩個 edge regressions。最新 exact-commit 三 runner CI 以 [驗收紀錄](mvp-validation.md) 為準，不沿用舊提交。
- 明確未完成：CLI 發行版本矩陣、filesystem watcher、renderer fallback、直接 Session Palette 快切、OS／Shell 快捷鍵保留組合檢查、終端控制序列專門安全案例、原生 IME／螢幕閱讀器／完整效能及長時間壓力。這些不阻止記錄已完成的局部實作，也不能被隱藏。
- [17 項後續待辦](future-backlog.md)保持未完成；持續執行／重連僅升級下一階段優先級，本輪沒有 daemon 或重開後繼續執行的實作。

| 狀態 | 追加 ID | 本輪交付 | 證據／限制 |
| --- | --- | --- | --- |
| [x] | ADD-01 | 自選專案遷移、名稱／置頂／加入建立／非破壞性移出 | curated_projects 9、service 2 與 App 回歸；來源／cwd／執行中工作保留 |
| [x] | ADD-02 | 專案首頁＋所有目錄總覽與工作區跨頁可到達 | App 導覽／scoped query／競態與 History resultKey 測試；未知、失效、未加入目錄保留 |
| [x] | ADD-03 | 普通 Shell 正常退出移除 pane／最後 tab | App／Terminal／workspace 退出、重複事件、Agent／異常保留回歸 |
| [x] | ADD-04 | 四 Agent 設定與安全升級 | additional_agents 8 與 Settings 回歸；舊 sources／args／opt-in 不重設 |
| [x] | ADD-05 | Grok 唯讀歷史與相鄰 chunks／rewind | Grok 19 個回歸，跨 chunk 搜尋／預覽、增量追加、身份衝突／缺檔；真實 CLI 版本另待驗收 |
| [x] | ADD-06 | Antigravity 新工作／手動 ID 與歷史限制 | 精確 argv／manual ID 測試；後續追加的 CLI 歷史另列 ADD-19，不以原啟動測試代替 |
| [x] | ADD-07 | 自訂 argv、持久風險 opt-in、明確權限優先 | launch_options 6 與 additional_agents／Settings 回歸；不重複額外確認、不擴大 scoped permission |
| [x] | ADD-08 | 精確啟動預覽與來源 qualified 恢復去重 | preview 不 spawn；manual／indexed、來源 root／inode 變更與並行去重回歸 |
| [x] | ADD-09 | 四張來源能力卡片與舊設定 Grok 新增入口 | Settings 新舊來源、多來源、取消、未設定／缺失／停用與逐工具能力回歸 |
| [x] | ADD-10 | 前後端共同 provider registry 與真實偵測語意 | providers 3、config／additional_agents 探測回歸；版本失敗不等同 missing，登入固定 unknown |
| [x] | ADD-11 | 唯讀 Shell 候選與已存 Profile canonical 排除 | shells 14 個回歸；不執行／不讀 rc／不覆寫 settings，候選與 saved-resolution 均有界 |
| [x] | ADD-12 | macOS 專用 ICNS 留白與可重現腳本 | 10 representations 透明邊界、兩次 byte-identical、7 個原資產雜湊保護；非 Cmd+Tab 人工驗收 |
| [ ] | ADD-13 | 完整 UI／UX 重設與新控制項 | tokens／卡片與清單／設定 details／兩段啟動器已實作，最終 frontend 324／324 與 build 通過；等 native 畫面複核後再勾選 |
| [ ] | ADD-14 | 最新提交手動三 runner checks／unsigned bundle／native smoke | 省額度模式保留手動完整驗收；帳務限制尚未解除、最新 exact commit 尚未通過，Linux 輕量或舊提交成功不能代替 |
| [ ] | ADD-15 | macOS Cmd+Tab／Dock 實際視覺比較 | 檔案 alpha／預覽與 build 已驗證；尚無使用者 Mac 原生畫面證據 |
| [ ] | ADD-16 | CapsLock 切換輸入法的特定重複組字修正 | 已加入 xterm key handler 與合成組字回歸；真實 macOS 輸入法／CapsLock 操作仍待驗收，不能由合成事件宣稱已完成 |
| [ ] | ADD-17 | Chrome-style 工作區分頁快捷鍵 | 目前目錄的數字選頁／雙向循環、IME 與對話框保護、保留鍵攔截及舊 pane 預設遷移已實作；包含於 377 個前端回歸，本批 exact-commit CI 尚待確認 |
| [ ] | ADD-18 | 官方已知歷史來源候選偵測 | 共用 provider metadata、有界唯讀檢查、canonical alias 與保存 ID 比對、明確加入草稿；22 個 Rust 整合測試與 377 個前端全套通過，含輸出上限／saved-ID 草稿去重；180 個 desktop 全套也通過；本批 exact-commit CI 待完成 |
| [ ] | ADD-19 | Antigravity CLI 歷史列表、內容預覽與正確接續 | 使用者確認 CLI 1.3.5；防禦 step／metadata reader、私密 DB 快照、唯讀備份與重寫保護正在驗證。App／IDE 不在必要範圍；實際 1.3.5 磁碟樣本及互動接續仍待驗收，不能以 unsupported 卡片或社群版本宣稱代替 |
| [ ] | ADD-20 | Breadcrumb 反映實際導覽與專案名稱 | leaf 使用實際 current.name，首頁只顯示一次分類，全域搜尋有明確 leaf；真專案名稱恰為「專案」仍允許合法同名。3 個 App 回歸已納入 380／380 前端全套，typecheck／lint／build 通過；原生新 CI 待確認 |

追加需求目前 **20 項，12 已完成、8 未完成**。原始 9 項原生驗收另列於 [試用前清單](mvp-validation.md#試用前的原生驗收清單)，不與本表重複累計。

## 完整功能範圍

| 功能 | 優先級 | 交付內容 | 對應任務群組 |
| --- | --- | --- | --- |
| F01 工具與來源 | P0 | 四 Agent 偵測與固定能力卡片；四者有各自歷史 adapter；舊設定明確新增缺少的 Grok／Antigravity CLI 來源，格式及可接續狀態分開 | PRE、ADP、SET |
| F02 專案管理 | P0 | 專案首頁／所有目錄雙頁分組總覽、搜尋、置頂、加入既有目錄、建立新資料夾、非破壞性移出、未知／失效路徑處理 | CAT |
| F03 Session 清單 | P0 | 所選目錄的跨 Agent 歷史、排序、分頁、篩選、封存與分支標示 | ADP、CAT |
| F04 搜尋與預覽 | P0 | 所選目錄／明確全域搜尋、中文與識別字、命中片段、分段對話預覽 | FIND、SEC |
| F05 接續與新工作 | P0 | 原 Agent resume、新建、啟動檢查、重複開啟與失敗恢復 | ADP、RUN |
| F06 普通 Terminal | P0 | Shell Profiles、輸入法、複製貼上、捲動、搜尋、resize、退出畫面 | RUN、TERM、SET |
| F07 分頁與面板 | P0 | 多工作區、左右／上下分割、比例、焦點、最大化、背景執行與關閉 | WS、RUN |
| F08 客製化與保存 | P0 | 亮暗主題、終端色票、字型、快捷鍵、預設 Agent、每工具 argv／危險 opt-in、布局占位還原 | SET、WS |
| F09 索引與錯誤恢復 | P0 | 增量解析、監控補掃、取消、重掃、重建、來源清理與隔離錯誤 | DATA、IDX |
| 操作入口與可及性 | P0 | Command Palette、快速切換、鍵盤流程、焦點提示與必要畫面狀態 | WS、SET、QA |
| 本機安全與品質 | P0 | 唯讀來源、安全程序啟動、內容防護、相容性、效能與診斷 | SEC、QA |
| F10 工作脈絡 | P1 | 別名、手動狀態、接續筆記 | CTX |
| F11 Repo 分組 | P1 | repository、子目錄與 worktree 關聯，保留各自 cwd | CTX |
| F12 摘要與交接 | P1 | 可核對摘要、來源連結、內容預覽與跨 Agent 交接 | CTX |
| 其他 Agent 與搜尋擴充 | P1 候選 | 逐一評估 adapter，選用工具輸出索引 | CTX |
| F15 Agent 用量與額度總覽 | P1 | 帳號／工作區的額度、剩餘量、重置時間、來源與刷新 | USG |
| F16 多維度用量分析 | P1 | Project／Agent／Session／模型／日期下鑽，token、可用請求數與費用語意 | USG |
| F13 持續執行 | P2 候選 | daemon、斷線重連、重新附接、輸出保留與版本協商 | EXT |
| F14 派工與擴充 | P2 候選 | 自動派工、外掛、跨機同步 | EXT |
| 其他終端能力 | 待研究 | 遠端 SSH、Shell integration、圖片與進階鍵盤協定、任意 CSS | EXT |
| 發行與維護 | 發行前 | 安裝包、平台矩陣、簽章、更新策略、授權與使用文件 | REL |

P0 的來源與索引在本機運作；Agent 自身仍沿用原工具的帳號、網路與權限。使用者已指定整組 F15、F16 在 MVP 後的 P1 交付，P0 範圍不變；其他 P1 的順序依試用結果安排。P2 與其他候選功能先定義範圍，再決定是否實作。雲端限定歷史、已刪紀錄復原、完整 IDE 與企業治理不屬於目前開發範圍。

## 任務使用方式

共 143 項任務，分為 18 個群組；其中新增 USG-01–USG-20 共 20 項 P1 用量任務。以下數量是目前拆解層級，候選功能通過研究後還需補實作子任務。

| 範圍 | 任務數 | 排程原則 |
| --- | --- | --- |
| P0 決策、原型、功能與驗收 | 96 | 完成完整 MVP 所需 |
| 發行前交付 | 6 | 依選定平台與發布方式執行 |
| P1 用量、工作脈絡與整合擴充 | 29 | 用量已指定 MVP 後交付，其他範圍依試用結果確認 |
| P2 與待研究功能 | 12 | 先定義範圍，再排條件式實作 |

每列可建立一張 issue。「完成條件」是最低驗收要求，仍須滿足上游規格；「前置任務」列出直接相依，其餘依賴可向前追溯。`—` 表示沒有任務相依；`待範圍決策` 表示實作受研究結果約束。

- 狀態：`[ ]` 未完成，`[x]` 完成；進行中或受阻時，於對應 issue 記錄原因與負責人。
- 完成時附程式／文件變更、適用的測試或人工驗收結果；效能附環境、版本、日期與樣本數。
- 尚未估算工期；完成 PRE 與 SPIKE 後，再依選型、團隊與支援平台估算。表格順序不代表可以跳過相依任務。
- 新發現的工作新增穩定 ID，不重新編號；需求變更先更新決策與規格，再調整清單。

## P0 前置決策與需求驗證

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | PRE-01 | 確認首個原型平台與支援邊界 | 記錄 OS、架構、Shell、WebView 與開發環境；macOS 仍為建議 | — | [決策](decisions.md#2026-10-15-mvp-實作決策更新)、[開發環境](development.md)與 lockfiles 已定案；不等同 SPIKE 的人工／效能門檻通過。 |
| [x] | PRE-02 | 選擇前端框架與套件管理工具 | 比較候選並記錄選擇、版本與重現方式 | — | [決策](decisions.md#2026-10-15-mvp-實作決策更新)、[開發環境](development.md)與 lockfiles 已定案；不等同 SPIKE 的人工／效能門檻通過。 |
| [x] | PRE-03 | 完成正式技術選型決策 | 依原型結果確認或調整桌面框架、PTY、資料庫存取與 worker 方案 | SPIKE-05 | [決策](decisions.md#2026-10-15-mvp-實作決策更新)、[開發環境](development.md)與 lockfiles 已定案；不等同 SPIKE 的人工／效能門檻通過。 |
| [ ] | PRE-04 | 定義 CLI 支援版本與能力矩陣 | 分列歷史、預覽、resume、fork、attach；以安裝版本 help 及 fixture 核對 | PRE-01 | 能力邊界已文件化；尚無實際安裝 CLI 發行版本／help／fork／attach 相容矩陣。 |
| [x] | PRE-05 | 定義多來源 Session 恢復策略 | 同 ID 多來源時，能指定正確來源或明確阻擋歧義；禁止猜測 | PRE-04 | service.rs 的來源／檔案身份預檢；catalog／additional_agents 測試覆蓋重複 ID、多來源及 root 變更拒絕。 |
| [ ] | PRE-06 | 驗證工作恢復需求與介面流程 | 完成少量訪談與找回任務觀察，記錄耗時、找錯率及預覽不足處 | — | 尚無受試者恢復任務的耗時、找錯率或訪談觀察紀錄。 |
| [x] | PRE-07 | 確認首版客製化與命令範圍 | 明列設定項、命令、快捷鍵限制及後續能力，更新決策與 UX | PRE-06 | [決策](decisions.md)、[UX](ux-spec.md)、Settings 與 commands.ts 明定首版設定／命令邊界。 |

## P0 工程骨架

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | BASE-01 | 建立可執行桌面原型骨架 | 開發環境可啟動視窗與前後端呼叫；候選選型可替換 | PRE-01、PRE-02 | Tauri desktop.rs／main.rs、React 啟動與 IPC 已有先前 native DOM smoke；本批 exact-commit CI 另列。 |
| [x] | BASE-02 | 定義原型 IPC 與共用型別 | Commands、串流、runtime ID、錯誤及取消契約可往返 | BASE-01 | [IPC 契約](ipc-contract.md)、models／providers／adapters／catalog／service／runtime／config 與 workspace.ts 分層；API／整合測試通過。 |
| [x] | BASE-03 | 建立程式格式與靜態檢查 | 設定前端／Rust 對應工具，列出實際執行指令 | BASE-01 | package.json、Cargo.toml、Vitest、rustfmt／Clippy 與合成 fixtures／測試入口已落地並實跑。 |
| [x] | BASE-04 | 建立測試與 fixture 基礎 | 可執行單元、整合與 UI 測試入口；fixtures 不含真實敏感資料 | BASE-01 | package.json、Cargo.toml、Vitest、rustfmt／Clippy 與合成 fixtures／測試入口已落地並實跑。 |
| [x] | BASE-05 | 建立持續整合與貢獻流程 | 版本固定、乾淨環境可檢查與建置；更新 README、AGENTS 與忽略規則 | BASE-03、BASE-04 | light-checks.yml 單 Linux 自動檢查、ci.yml 手動三 runner、lockfiles、rust-toolchain.toml、AGENTS／README／忽略規則齊備；最新提交結果另列，不沿用舊 CI。 |
| [x] | BASE-06 | 整理正式模組與契約 | 分離 adapters、catalog、indexer、runtime、workspace、storage；契約依選型定案 | PRE-03、BASE-02 | [IPC 契約](ipc-contract.md)、models／providers／adapters／catalog／service／runtime／config 與 workspace.ts 分層；API／整合測試通過。 |

## P0 技術原型與選型門檻

原型可使用最小實作與合成資料；通過原型不等於正式模組已完成。

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | SPIKE-01 | 打通 PTY 到 xterm 往返 | Shell 輸入、輸出、resize、退出可用；UTF-8 與控制序列不損壞 | BASE-02 | runtime.rs 真實 PTY 輸入／resize／退出／raw UTF-8 測試，加 terminal.test.tsx 的 xterm callback ACK／bytes 測試；原生 IME 仍屬 SPIKE-03。 |
| [ ] | SPIKE-02 | 驗證雙面板與背景解析並行 | 兩個獨立 PTY 同時可見，背景 JSONL 解析時仍可操作 | SPIKE-01 | 獨立雙 PTY 與查詢／索引併行各有自動測試；缺兩個可見原生面板同時背景解析的互動驗收。 |
| [ ] | SPIKE-03 | 驗證終端相容性與 renderer | 中文輸入法、互動 CLI、Vim 與適用平台 tmux 可用；驗證 renderer fallback | SPIKE-02、PRE-04 | 尚無兩 OS 的 IME、真實互動 CLI、Vim／tmux 與 renderer fallback 矩陣。 |
| [ ] | SPIKE-04 | 建立效能量測原型 | 可量測輸入延遲、IPC 吞吐與 Core／WebView／GPU 資源，Agent 另列 | SPIKE-02 | 僅 catalog benchmark；未建立端到端輸入延遲、穩定 IPC 吞吐與 Core／WebView／GPU 資源量測。 |
| [ ] | SPIKE-05 | 評審原型並決定繼續或調整 | 記錄相容性阻礙、量測結果、改善項與選型結論 | SPIKE-03、SPIKE-04 | 選型已記錄，但 SPIKE-03／04 相容性與完整效能門檻尚未驗收，不能宣稱原型評審完成。 |

## P0 Agent 偵測與資料適配

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | ADP-01 | 實作 adapter 介面與能力模型 | 工具、來源、解析、LaunchSpec 分離；未知格式有降級結果 | BASE-06、PRE-04 | providers.rs 消費共同 manifest、型別 parser 分派、service LaunchSpec 邊界；未知／不一致條目與降級測試。 |
| [x] | ADP-02 | 實作工具與版本偵測 | 處理 GUI PATH 差異、timeout、手動 executable；不存在不阻擋 Terminal | ADP-01 | config.rs 路徑 fallback／手動 executable、2 秒／4096-byte version probe；available／missing／versionCheckFailed 回歸。 |
| [x] | ADP-03 | 實作來源探索與健康檢查 | 支援環境變數與自訂多來源；工具可用與歷史可讀分開顯示 | ADP-02 | catalog discover／SourceHealth 與設定來源卡片；missing／empty／disabled／error／unsupported、多來源與環境 root 測試。 |
| [ ] | ADP-04 | 實作 Codex 歷史解析 | 支援已定版本的 sessions／archived_sessions、metadata、cwd、對話與關係 | ADP-03、ADP-08 | Codex／Claude parser、名稱、cwd、archive／child 等合成回歸已通過；完成條件要求的「已定 CLI 發行版本」仍待 PRE-04。 |
| [ ] | ADP-05 | 實作 Claude Code 歷史解析 | 支援已定版本的 transcript、cwd、分支與子代理；不反解資料夾猜 cwd | ADP-03、ADP-08 | Codex／Claude parser、名稱、cwd、archive／child 等合成回歸已通過；完成條件要求的「已定 CLI 發行版本」仍待 PRE-04。 |
| [x] | ADP-06 | 統一 Session 與訊息模型 | 保存來源 locator、外部 ID、時間、封存、父子關係；缺值與 fallback 明確 | ADP-04、ADP-05 | models.rs／catalog locator 保存身份、時間、關係與 fallback；catalog 39 個回歸包含缺 cwd／mtime／partial。 |
| [x] | ADP-07 | 實作兩工具的啟動計畫 | 新建／resume 輸出 executable、args、cwd、env；來源歧義可回報 | ADP-01、PRE-05 | service plan_launch／preview_launch 及 additional_agents／service 替身逐項核對 executable／argv／cwd／env。 |
| [ ] | ADP-08 | 建立版本化 adapter fixtures | 覆蓋缺欄位、半行、壞行、未知事件、封存、分支、重複 ID 與多語言 | BASE-04、PRE-04 | fixtures／暫存測試已覆蓋列舉異常；fixtures/README.md 明示未綁定已驗收 CLI 發行版本，版本化條件未完成。 |
| [x] | ADP-09 | 驗證降級與支援範圍提示 | 不支援正文仍可保留有效 metadata；明列本機可讀範圍及版本限制 | ADP-06 | metadata／placeholder／partial／unsupported 降級與 UI 提示有 catalog／Grok／History／Settings 回歸；版本限制明列。 |

## P0 儲存與資料契約

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | DATA-01 | 建立應用資料目錄與資料庫連線 | 索引、設定與筆記使用自有路徑，來源不被寫入 | BASE-06 | config 自有目錄與原子 JSON、catalog schema v3／FTS migration、models／workspace 版本；筆記仍屬未實作 CTX，不虛構資料表。 |
| [x] | DATA-02 | 建立 schema 與 migration | 覆蓋 Installation、Source、Project、Session、TranscriptSource、MessageIndex、Workspace | DATA-01、ADP-01 | config 自有目錄與原子 JSON、catalog schema v3／FTS migration、models／workspace 版本；筆記仍屬未實作 CTX，不虛構資料表。 |
| [x] | DATA-03 | 實作身份與來源映射 | 以 agent、source、external ID 識別；來源搬移可追蹤，歧義不強行合併 | DATA-02、PRE-05 | source＋kind＋external ID、canonical directory aliases／resume provenance；來源搬移、同 ID 多來源及 symlink 回歸。 |
| [x] | DATA-04 | 實作查詢與交易介面 | 分頁有穩定排序；查詢參數化，批次寫入可回復 | DATA-02 | catalog 參數化查詢／穩定排序／交易；分頁、交易 rollback、FTS 一致性測試。 |
| [x] | DATA-05 | 選擇中文與識別字搜尋策略 | 比較 tokenizer、trigram 與短詞 fallback，記錄召回及延遲 | DATA-02、ADP-08 | [fixtures 說明](../fixtures/README.md)與[效能紀錄](mvp-validation.md#效能)：compact trigram＋literal 驗證／短詞 fallback，中文與識別字召回案例及 p50／p95。 |
| [x] | DATA-06 | 建立全文索引與同步交易 | metadata、索引新增／更新／刪除一致；短查詢有受限 fallback | DATA-04、DATA-05 | schema／parser 版本與 FTS triggers／rebuild；空庫、v1／v2 升級、失敗交易、重開、清除／重建保留設定與 curated 回歸。 |
| [x] | DATA-07 | 實作索引重建與版本管理 | parser／schema 升級可重建；保留自有設定、筆記與來源檔 | DATA-03、DATA-06 | schema／parser 版本與 FTS triggers／rebuild；空庫、v1／v2 升級、失敗交易、重開、清除／重建保留設定與 curated 回歸。 |
| [x] | DATA-08 | 驗證 migration 與寫入中斷恢復 | 空庫、舊版、失敗交易與重啟均有可重複測試；錯誤可診斷 | DATA-07、BASE-04 | schema／parser 版本與 FTS triggers／rebuild；空庫、v1／v2 升級、失敗交易、重開、清除／重建保留設定與 curated 回歸。 |

## P0 增量索引與來源生命週期

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | IDX-01 | 實作初始掃描與背景工作排程 | 啟動先讀既有索引；限制 worker、開檔數與批次，不阻擋 UI | ADP-06、DATA-04 | service 單掃描排程與 catalog 完整行 offset／prefix hash／inode／archive reconciliation；catalog 與 Grok 生命週期測試。 |
| [x] | IDX-02 | 實作追加與完整行 offset | 按 byte offset 增量解析，半行不提交，重讀不重複索引 | IDX-01、DATA-06 | service 單掃描排程與 catalog 完整行 offset／prefix hash／inode／archive reconciliation；catalog 與 Grok 生命週期測試。 |
| [x] | IDX-03 | 處理截斷、替換與 rotation | 偵測檔案身份變化，撤銷舊索引再解析，無過期搜尋結果 | IDX-02、DATA-03 | service 單掃描排程與 catalog 完整行 offset／prefix hash／inode／archive reconciliation；catalog 與 Grok 生命週期測試。 |
| [x] | IDX-04 | 處理刪除與封存搬移 | 同步來源映射、主表與全文索引，保留正確封存／分支關係 | IDX-03 | service 單掃描排程與 catalog 完整行 offset／prefix hash／inode／archive reconciliation；catalog 與 Grok 生命週期測試。 |
| [ ] | IDX-05 | 整合 watcher 與 reconcile | 合併通知；啟動與定期補掃可修正遺失事件 | IDX-04 | 已依 MVP 決策實作啟動與每 10 秒 reconcile；沒有 filesystem watcher 或通知合併，原任務完整條件未完成。 |
| [x] | IDX-06 | 實作進度、取消與來源錯誤隔離 | 顯示階段與數量；取消保留一致 checkpoint，單一錯誤不阻擋其他來源 | IDX-02 | index_status 輪詢可觀察進度／健康／錯誤，取消 checkpoint／重掃／重建／clear 與來源隔離均有回歸；未聲稱逐事件 watcher。 |
| [x] | IDX-07 | 實作重掃、取消索引與清除功能 | 明確區分重掃／重建／移除來源；清理衍生資料但不刪原歷史 | IDX-05、IDX-06、DATA-07 | index_status 輪詢可觀察進度／健康／錯誤，取消 checkpoint／重掃／重建／clear 與來源隔離均有回歸；未聲稱逐事件 watcher。 |
| [x] | IDX-08 | 實作狀態事件與診斷 | UI 可訂閱來源健康、索引階段、解析不完整及可重試錯誤 | IDX-06、BASE-06 | index_status 輪詢可觀察進度／健康／錯誤，取消 checkpoint／重掃／重建／clear 與來源隔離均有回歸；未聲稱逐事件 watcher。 |
| [x] | IDX-09 | 建立索引生命週期整合測試 | 覆蓋追加、半行、壞行、截斷、替換、刪除、封存、取消與補掃 | IDX-07、IDX-08、BASE-04 | index_status 輪詢可觀察進度／健康／錯誤，取消 checkpoint／重掃／重建／clear 與來源隔離均有回歸；未聲稱逐事件 watcher。 |

## P0 專案與歷史清單

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | CAT-01 | 實作 cwd 正規化與分組 | 保留原 cwd；處理 symlink、檔案系統大小寫、失效路徑、缺 cwd 與中途換目錄 | ADP-06、DATA-03 | canonical path／directory aliases 保留原 cwd，不全域轉小寫；缺 cwd、失效、symlink／中途 cwd 變更合成回歸。macOS 大小寫磁碟另待原生驗收。 |
| [x] | CAT-02 | 實作專案查詢與本機設定 | curated／名稱／置頂持久化、舊手動／釘選遷移；加入既有目錄、單層建立及非破壞性移出 | CAT-01、DATA-04 | curated_projects 9 個與 service 2 個測試：會員／名稱／置頂遷移持久化、加入／建立／移出、launch override 與來源唯讀。 |
| [x] | CAT-03 | 建立專案側欄與導覽 | 專案首頁僅 curated、所有目錄保留全部有 Session 分組；兩頁卡片與側欄先選組再看歷史，已開啟工作區皆可到達 | CAT-02 | App／DirectoryOverview 雙頁總覽、scoped history、工作區保留、未知與失效分組；App 對應導覽與競態回歸。 |
| [x] | CAT-04 | 實作路徑重新定位 | launch override 不改來源 cwd／transcript；失效歷史仍可瀏覽 | CAT-02 | curated_projects 9 個與 service 2 個測試：會員／名稱／置頂遷移持久化、加入／建立／移出、launch override 與來源唯讀。 |
| [x] | CAT-05 | 實作 Session 清單查詢 | 穩定分頁；專案、Agent、日期、封存篩選；標題與時間 fallback 明確 | CAT-01、DATA-04、IDX-02 | catalog 穩定查詢與 History 篩選／關係／時間提示；History 保留同組視圖狀態並以 resultKey 阻擋換組過期結果。 |
| [x] | CAT-06 | 建立 Session 清單介面 | 顯示關係與解析狀態；子代理不混成主工作，切換視圖保留選取及篩選 | CAT-03、CAT-05、IDX-08 | catalog 穩定查詢與 History 篩選／關係／時間提示；History 保留同組視圖狀態並以 resultKey 阻擋換組過期結果。 |

## P0 搜尋與對話預覽

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | FIND-01 | 實作搜尋查詢與分頁 | 標題、使用者訊息、Agent 回覆可跨工具／專案查詢，回傳 locator 與命中片段 | DATA-06、CAT-05 | catalog 搜尋／locator／snippet；History／App 測試包含目錄與明確全域查詢、快捷鍵範圍及取消舊請求。 |
| [x] | FIND-02 | 建立目錄內與明確全域搜尋介面 | 先選目錄或主動進全域搜尋，再顯示篩選與命中；快捷鍵保留已選目錄，過期請求不覆蓋新結果 | FIND-01 | catalog 搜尋／locator／snippet；History／App 測試包含目錄與明確全域查詢、快捷鍵範圍及取消舊請求。 |
| [x] | FIND-03 | 實作 transcript 分段讀取 | 優先最近對話與最後需求，按需展開早期訊息，長檔不全量載入 | ADP-06、DATA-03 | 按 locator 分段、64 KiB 訊息／1 MiB 頁面、純文字與附件占位；catalog／History 分頁及不可信內容回歸。 |
| [x] | FIND-04 | 建立安全對話預覽 | 顯示角色、時間、內容及占位；附件、壓縮與未知事件不假裝完整 | FIND-03、SEC-03 | 按 locator 分段、64 KiB 訊息／1 MiB 頁面、純文字與附件占位；catalog／History 分頁及不可信內容回歸。 |
| [x] | FIND-05 | 處理索引與來源內容變更 | 偵測來源已變更或刪除；可重新載入，保留有效選取與清楚提示 | FIND-02、FIND-04、IDX-05 | stale／來源變更／刪除提示、重讀；中文／ASCII／識別字／特殊字元與來源 bytes 不變，service／Grok 合成流程不呼叫模型。 |
| [x] | FIND-06 | 驗證搜尋召回與唯讀流程 | 中文短詞、英文、識別字有案例；選取／搜尋／預覽不啟動 Agent 或呼叫模型 | FIND-05、BASE-04 | stale／來源變更／刪除提示、重讀；中文／ASCII／識別字／特殊字元與來源 bytes 不變，service／Grok 合成流程不呼叫模型。 |

## P0 Runtime 與工作恢復

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | RUN-01 | 建立 Runtime Manager 與狀態機 | 管理 PTY、子程序與 starting／running／exited／failed／unknown；不依 UI mount 決定生死 | BASE-06 | RuntimeManager 擁有 PTY／程序，獨立 argv／cwd／env、raw bytes／sequence／ACK／credit；21 個 runtime 回歸與 terminal queue 測試。 |
| [x] | RUN-02 | 實作安全啟動、輸入與 resize | executable、args、cwd、受控 env 分離；權限沿用原 CLI，退出碼可取得 | RUN-01、SEC-02 | RuntimeManager 擁有 PTY／程序，獨立 argv／cwd／env、raw bytes／sequence／ACK／credit；21 個 runtime 回歸與 terminal queue 測試。 |
| [x] | RUN-03 | 實作有序輸出與背壓 | runtime ID、序號、批次與消費額度可追蹤；UTF-8／控制序列完整，緩衝有上限 | RUN-02、SPIKE-04 | RuntimeManager 擁有 PTY／程序，獨立 argv／cwd／env、raw bytes／sequence／ACK／credit；21 個 runtime 回歸與 terminal queue 測試。 |
| [x] | RUN-04 | 實作啟動前檢查與修復流程 | 缺工具、失效 cwd、來源遺失、版本與多來源歧義可辨識並修復 | ADP-07、CAT-04、RUN-02 | service preflight、精確 argv、來源 qualified resume key／原子去重、UI 待確認／失敗重試；additional_agents 8、service／App／Terminal 回歸。真實 CLI 載入仍待 QA-02。 |
| [x] | RUN-05 | 接上 Agent 新建與 resume | 正確工具、來源與 cwd 啟動；成功啟動但未確認歷史時明確提示 | RUN-04、RUN-03 | service preflight、精確 argv、來源 qualified resume key／原子去重、UI 待確認／失敗重試；additional_agents 8、service／App／Terminal 回歸。真實 CLI 載入仍待 QA-02。 |
| [x] | RUN-06 | 實作 Session 與 Runtime 關聯 | 可靠 ID 才關聯；同受管 Session 聚焦既有面板，副本需明確操作及工具支援 | RUN-05 | service preflight、精確 argv、來源 qualified resume key／原子去重、UI 待確認／失敗重試；additional_agents 8、service／App／Terminal 回歸。真實 CLI 載入仍待 QA-02。 |
| [x] | RUN-07 | 實作失敗診斷與重試 | CLI 錯誤可查看、修正設定後重試或改開新工作；外部程序未知時不任意中止 | RUN-06 | service preflight、精確 argv、來源 qualified resume key／原子去重、UI 待確認／失敗重試；additional_agents 8、service／App／Terminal 回歸。真實 CLI 載入仍待 QA-02。 |
| [x] | RUN-08 | 實作關閉與應用退出清理 | 列出受影響面板並確認；受管程序樹清理、有超時策略；取消退出保留工作 | RUN-03 | 有界停止與 Unix session 所有權／後代清理、啟動關閉競態／退出取消／保存失敗回歸；刻意 setsid 脫離者不宣稱受管。 |
| [x] | RUN-09 | 建立 Runtime 整合測試 | 覆蓋新建、resume、輸入、resize、歧義、錯誤、退出及子程序清理 | RUN-07、RUN-08、BASE-04 | 有界停止與 Unix session 所有權／後代清理、啟動關閉競態／退出取消／保存失敗回歸；刻意 setsid 脫離者不宣稱受管。 |

## P0 普通 Terminal

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | TERM-01 | 建立 xterm 面板與生命週期 | 實例直接接收串流；退出保留最後畫面與結束碼，重開有清楚入口 | RUN-03 | TerminalPane 實例／串流／啟動／診斷與 profile／cwd；依最新需求，正常 Shell exit 0 移除 pane，Agent／異常退出保留畫面。 |
| [x] | TERM-02 | 實作 Shell 啟動與目錄選擇 | 專案、其他 cwd 及 Profile 可用；無 Agent 安裝時仍能操作 | TERM-01、SET-02 | TerminalPane 實例／串流／啟動／診斷與 profile／cwd；依最新需求，正常 Shell exit 0 移除 pane，Agent／異常退出保留畫面。 |
| [ ] | TERM-03 | 實作輸入、複製貼上與捲動 | 中文組字、選取、剪貼簿、長輸出捲動與終端內搜尋可用 | TERM-01、SEC-04 | 輸入佇列、clipboard UI、scrollback 與 SearchAddon 已實作；中文組字、OS 剪貼簿與長輸出原生互動尚未驗收。 |
| [ ] | TERM-04 | 實作 fit、resize 與 renderer fallback | 實際字元尺寸對應 PTY 行列；高負載與 renderer 切換不破壞輸出 | TERM-03、SPIKE-03 | FitAddon／ResizeObserver／PTY resize 已實作；未建立 renderer 切換／fallback 與高負載原生驗證。 |
| [x] | TERM-05 | 驗證普通面板的狀態邊界 | 手動執行 Agent 不自動轉型；不依 prompt 推測 cwd，不預設廣播輸入 | TERM-02、RUN-06 | Pane.kind 與 cwd 由啟動請求決定，不解析 prompt／程序名稱轉型；每 pane 有獨立輸入佇列與 runtime ID。 |

## P0 工作區與面板操作

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | WS-01 | 建立工作區模型與主畫面 | Project → tab → pane；歷史與工作區切換保留狀態，面板顯示工具與 cwd | BASE-06、CAT-03、TERM-01 | workspace.ts／WorkspaceCanvas／TerminalPane 與 App 回歸：獨立 tabs、遞迴分割、比例鍵盤／拖曳、焦點／最大化、隱藏保留與關閉競態。 |
| [x] | WS-02 | 實作分頁新增、選取與背景保留 | 專案工作區隔離；切換／隱藏不重啟程序，輸出持續解析且有界 | WS-01、RUN-03 | workspace.ts／WorkspaceCanvas／TerminalPane 與 App 回歸：獨立 tabs、遞迴分割、比例鍵盤／拖曳、焦點／最大化、隱藏保留與關閉競態。 |
| [x] | WS-03 | 實作水平與垂直分割 | 至少兩個面板可見且各自執行 PTY；新增可選 Agent 或 Shell | WS-02、RUN-05、TERM-02 | workspace.ts／WorkspaceCanvas／TerminalPane 與 App 回歸：獨立 tabs、遞迴分割、比例鍵盤／拖曳、焦點／最大化、隱藏保留與關閉競態。 |
| [x] | WS-04 | 實作比例拖曳、焦點與最大化 | resize 正確；焦點不只用色彩；最大化可回原布局，鍵盤可操作 | WS-03、TERM-04 | workspace.ts／WorkspaceCanvas／TerminalPane 與 App 回歸：獨立 tabs、遞迴分割、比例鍵盤／拖曳、焦點／最大化、隱藏保留與關閉競態。 |
| [x] | WS-05 | 接上面板關閉與程序退出 UI | 執行中關閉須確認；退出後可檢視畫面、重新開 Shell 或接續 Agent | WS-04、RUN-08 | workspace.ts／WorkspaceCanvas／TerminalPane 與 App 回歸：獨立 tabs、遞迴分割、比例鍵盤／拖曳、焦點／最大化、隱藏保留與關閉競態。 |
| [ ] | WS-06 | 建立命令註冊與快速入口 | 按鈕、選單、快捷鍵共用 command registry；Palette 與專案／Session 快切可用 | WS-05、PRE-07、CAT-06、FIND-02 | command registry／快捷鍵／Palette 與專案快切已實作；Palette 尚無直接 Session 快切結果，原任務完整條件未完成。 |
| [x] | WS-07 | 實作布局保存與占位恢復 | 版本化保存 tabs／split／比例；重開不附接舊 PID、不自動重跑任意指令 | WS-05、SET-01 | workspace 序列化剝除 runtime／start token；還原占位、損壞／新版本布局不無意覆寫與 native-close 保存順序回歸。 |

## P0 設定與必要畫面狀態

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | SET-01 | 建立版本化設定儲存與驗證 | 預設值、格式驗證、升級與損壞 fallback 可用；不破壞原 Agent 設定 | DATA-01、PRE-07 | config 原子保存／驗證／遷移與 Settings／workspace 回歸；Profiles、cwd／env、預設工具、主題／色票／字型均保存。 |
| [x] | SET-02 | 實作 Shell Profiles 與預設 Agent | 可設定 executable、args、cwd／env 及工具偏好；無效設定可定位 | SET-01、ADP-02 | config 原子保存／驗證／遷移與 Settings／workspace 回歸；Profiles、cwd／env、預設工具、主題／色票／字型均保存。 |
| [x] | SET-03 | 實作主題、色票與字型 | UI tokens 與 xterm 色票一致，亮暗／大小／對比可調並保存 | SET-01、TERM-01 | config 原子保存／驗證／遷移與 Settings／workspace 回歸；Profiles、cwd／env、預設工具、主題／色票／字型均保存。 |
| [ ] | SET-04 | 實作快捷鍵設定與衝突提示 | 避開已知 Shell／OS 衝突，焦點路由正確；設定可保存及還原 | SET-01、WS-06 | 自訂保存、重設、應用內快捷鍵衝突與 IME／modal 路由已有測試；尚無已知 OS／Shell 保留組合的完整衝突檢查。 |
| [x] | SET-05 | 建立首次啟動與來源設定介面 | 顯示偵測來源，修改路徑後可開始／取消索引；無工具、無歷史有入口 | SET-01、ADP-03、IDX-07、TERM-02 | Settings 首次設定／來源啟停／掃描與缺工具／空白／錯誤／不支援提示；Settings、History、App 回歸。 |
| [x] | SET-06 | 補齊錯誤、空白與降級狀態 | 索引中、無結果、失效目錄、不支援格式、恢復失敗、未知關聯皆有下一步 | SET-05、CAT-06、FIND-05、RUN-07 | Settings 首次設定／來源啟停／掃描與缺工具／空白／錯誤／不支援提示；Settings、History、App 回歸。 |

## P0 本機資料安全

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | SEC-01 | 建立資料存取與唯讀邊界 | 索引／設定僅寫自有目錄；本機敏感檔限制權限，歷史存取有唯讀測試 | DATA-01、BASE-04 | 私有設定權限、來源唯讀與注入回歸；後端 argv／路徑／身份驗證、CSP 與純文字 transcript，不自動載入 HTML／外部資源。 |
| [x] | SEC-02 | 限制 IPC 與程序啟動權限 | 驗證參數、面板擁有權與檔案路徑；不把標題／路徑拼入 Shell 指令 | BASE-06 | 私有設定權限、來源唯讀與注入回歸；後端 argv／路徑／身份驗證、CSP 與純文字 transcript，不自動載入 HTML／外部資源。 |
| [x] | SEC-03 | 防護 transcript Markdown 與連結 | 禁用任意 HTML 執行及自動外部資源；不可信連結有明確開啟行為 | BASE-06 | 私有設定權限、來源唯讀與注入回歸；後端 argv／路徑／身份驗證、CSP 與純文字 transcript，不自動載入 HTML／外部資源。 |
| [ ] | SEC-04 | 定義並實作終端剪貼簿等控制政策 | 控制序列不能任意讀寫檔案或取得執行權限；適用功能有驗證案例 | SPIKE-03、SEC-02 | TerminalPane 已攔截 OSC52、未啟用任意連結／檔案外掛；尚缺控制序列政策的專門安全回歸及原生 clipboard 驗收。 |
| [x] | SEC-05 | 實作去識別診斷與清理驗證 | 診斷預設排除正文／憑證；刪除來源與快取同步清除衍生內容 | SEC-01、IDX-07、RUN-07 | 診斷不輸出 transcript 正文；來源移除／clear／FTS cascade 清理及失效來源恢復拒絕有 catalog／service 測試。 |

## P0 整體品質與 MVP 驗收

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | QA-01 | 建立功能驗收對照表 | F01–F09 與 UX 狀態逐項連到任務、案例、結果及已知限制 | PRE-07、BASE-04 | [P0 對照](mvp-validation.md#p0-對照)、本表逐任務證據及未完成原因，區分自動回歸、真實 CLI 與原生驗收。 |
| [ ] | QA-02 | 驗證跨工具工作恢復 E2E | 從專案搜尋、預覽、resume 到分割 Terminal 執行指令，兩工具均通過 | RUN-09、WS-06、FIND-06、SET-06 | service 替身串接搜尋→預覽→resume→Shell 通過；尚非真實已登入 Codex／Claude 的 WebView E2E。 |
| [x] | QA-03 | 驗證例外與重開流程 | 覆蓋缺工具、缺目錄、來源刪除、未知格式、重複 Session、退出取消與布局恢復 | QA-02、IDX-09、WS-07、DATA-08 | App／Terminal／workspace／catalog 自動回歸覆蓋所列例外、退出取消與占位恢復；原生人工流程仍另列。 |
| [ ] | QA-04 | 驗證鍵盤與可及性 | 搜尋、預覽、接續、分割全程可用鍵盤；焦點順序、對比與螢幕閱讀器有結果 | WS-06、SET-03、SET-04、SET-06 | 鍵盤／焦點／portal／calendar 回歸及 44 組語意對比檢查已通過；尚無螢幕閱讀器與完整原生流程驗收。 |
| [ ] | QA-05 | 完成目標平台人工終端相容測試 | Shell、兩 CLI、互動提示、中文輸入、Vim 與適用平台 tmux 有版本化結果 | TERM-04、TERM-05、SET-04 | 尚無兩 OS 的真實 CLI、互動提示、中文輸入、Vim／tmux 版本化人工結果。 |
| [ ] | QA-06 | 執行啟動、索引與搜尋基準 | 分測既有索引啟動、完整索引、1,000／10,000 Session；報告召回、p50／p95、CPU 與峰值記憶體 | IDX-09、FIND-06、SPIKE-04 | [1,000](validation/catalog-1000.json)／[10,000](validation/catalog-10000.json) 合成索引搜尋 p50／p95 已有結果；缺啟動、CPU／峰值記憶體與 WebView 全鏈量測。 |
| [ ] | QA-07 | 執行串流壓力與長時間測試 | 兩可見＋四背景面板、背景索引、反覆開關；無輸出亂序、丟棄或無界資源成長 | RUN-09、WS-05、QA-06 | 有背壓／中斷／大量輸入的有界回歸；缺兩可見＋四背景、背景索引與長時間 soak 的完整實測。 |
| [ ] | QA-08 | 完成 MVP 評審與試用驗證 | P0 驗收可重複，安全與相容性阻礙已解決；觀察恢復成功率與使用者能否辨識狀態 | QA-01、QA-03、QA-04、QA-05、QA-07、SEC-05、PRE-06 | 原生／真實 CLI／完整效能與使用者恢復成功率尚未完成，不宣稱完整 P0 驗收。 |

效能先沿用路線圖的暫定目標：既有索引啟動 2 秒內、一般搜尋 p95 300 ms 內、壓力搜尋 p95 1 秒內、合成 echo 輸入 p95 50 ms 內。正式門檻依固定環境實測校正，不以丟棄輸出達標；量測需涵蓋 WebView／GPU，並將 Agent 子程序獨立列出。

## 發行前交付與維護

此組是公開試用／發行的前置工作，與本機 MVP 功能驗收分開追蹤；未選擇的平台及更新策略不預設實作。

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [x] | REL-01 | 確認發行平台與公開範圍 | 記錄支援矩陣、安裝方式、簽章／更新策略及試用限制 | PRE-03、PRE-04 | [開發指南](development.md)、決策明定 macOS／Linux、未簽章開發建置、無自動公開 release／更新及試用限制。 |
| [ ] | REL-02 | 完成授權與品牌發行前決策 | 選擇授權、檢查依賴授權，確認品牌權利與適用商業模式；不預設付費或網域採購 | REL-01 | 尚未選擇專案授權、完成依賴授權／品牌權利與商業模式決策。 |
| [ ] | REL-03 | 建立安裝包與平台建置 | 選定平台可重現建置；乾淨環境安裝、啟動、資料路徑與移除行為有驗證 | REL-01、BASE-05、QA-08 | 可產生未簽章 .app／.deb，先前 CI 有建置／啟動；未完成乾淨環境安裝／移除及本批最終平台驗收。 |
| [ ] | REL-04 | 完成選定平台的簽章與更新方案 | 依平台完成必要簽章／公證；若採自動更新，驗證來源、失敗恢復及資料相容 | REL-03 | 未實作簽章／公證／自動更新；本批僅未簽章開發產物。 |
| [x] | REL-05 | 撰寫使用、維護與疑難排解文件 | 包含來源設定、支援版本、恢復限制、重建索引、診斷與已知問題 | QA-08、REL-01 | [開發與試用](development.md)、[整合限制](agent-integrations.md)、IPC／驗收紀錄涵蓋設定、重建與診斷；支援 CLI 版本尚待建立並已明示。 |
| [ ] | REL-06 | 執行發行驗收並準備發布產物 | 安裝／升級 smoke test、版本紀錄、授權與使用文件齊備；發行產物及已知限制可供檢查 | REL-02、REL-04、REL-05 | 安裝／升級、授權及正式發行要求未完成；PR 不等同發布。 |

## P1 Agent 用量與分析

整組在 MVP 之後開始交付，USG-01 以 QA-08 為前置，不增加 P0 驗收相依。先完成 USG-01–USG-06、USG-14、USG-15 的額度總覽路徑，再完成本機事件與多維度分析；兩條路徑均需 USG-19、USG-20 驗收。詳細語意見[用量規格](usage-spec.md)。

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [ ] | USG-01 | 驗證來源與版本能力矩陣 | 兩首批工具分列額度、歷史／即時 token、請求數、金額、auth mode；比較官方、本機及 OpenUsage 候選來源 | QA-08、PRE-04、BASE-06 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-02 | 定義用量契約與驗證資料 | 定義窗口／事件、delta／累計、欄位包含關係與資料完整性；建立對應版本的去識別 fixtures | USG-01、BASE-04 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-03 | 實作帳號與用量來源設定 | provider／帳號／工作區身份可靠；來源可啟停，憑證使用安全儲存引用且不改原 CLI 登入資料 | USG-02、SET-01、SEC-01 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-04 | 建立用量 schema 與 migration | 分離額度快照、事件、計量、價格與聚合；升級及失敗交易可恢復，未知欄位可保存 | USG-02、DATA-08 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-05 | 實作 Codex 額度 collector | 使用已驗證介面與登入模式取得窗口／重置／來源時間；不支援模式降級，不向 PTY 注入命令 | USG-03、USG-04 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-06 | 實作 Claude Code 額度 collector | 使用評估通過的來源，分開訂閱額度與 token metrics；權限不足／無來源明確提示 | USG-03、USG-04 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-07 | 實作 Codex 歷史與即時 usage 讀取 | 按能力解析 usage，保留 request／thread／source 身份與原始語意；半行與重讀可恢復 | USG-04、ADP-04、IDX-02 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-08 | 實作 Claude Code 歷史 usage 讀取 | 解析可用 usage 欄位與模型／Session／事件時間，未知或缺少欄位不填零 | USG-04、ADP-05、IDX-02 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-09 | 實作選用本機 metrics 收集 | 依能力決策加入本機 OTel；由使用者啟用、只接收白名單欄位，不改全域設定、不收正文 | USG-03、USG-04、RUN-02、SEC-02 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-10 | 實作計量正規化與跨來源去重 | 累計、重播、resume、fork、子代理及重試有案例；cache／reasoning 不重複加總，衝突可追溯 | USG-07、USG-08 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-11 | 實作用量維度歸屬 | 可連到 Project／Agent／Session／provider／model／account；身份不足保持未歸屬，不按目前登入猜歷史 | USG-10、CAT-01、RUN-06 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-12 | 實作版本化價格與費用計算 | 明列估算／來源回報／帳務、幣別、生效價格；未知價格保留 token，訂閱月費不分攤 | USG-10 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-13 | 實作多維度聚合與查詢 | 日期與時區邊界明確；Project × Agent、Session、模型篩選一致，包含未歸屬／未定價範圍 | USG-11、USG-12 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-14 | 實作刷新、快取與錯誤隔離 | 背景／手動刷新去重，timeout、退避、取消、離線、過期及帳號切換可測，不阻擋 Terminal | USG-05、USG-06、IDX-06 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-15 | 建立全域 Agent 額度總覽 | 按 Agent／帳號顯示窗口、剩餘量、重置及更新狀態；共享額度與未知值可辨識 | USG-14、WS-06、SET-05 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-16 | 建立全域與專案用量分析 | 支援日期／Project／Agent／模型交叉篩選、趨勢及表格，下鑽前後保留條件 | USG-13、USG-15、CAT-06 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-17 | 建立 Session 用量明細 | 顯示 token 類別、請求、模型、費用性質、來源與完整性；可返回對話核對，不觸發 Agent | USG-16、FIND-04 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-18 | 實作用量保留、來源移除與重建 | 定義保留期間；刪除／截斷／重新分組時事件與聚合一致，清除不改原歷史或自有筆記 | USG-13、USG-14、IDX-07、SEC-05 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-19 | 建立計量與來源生命週期回歸測試 | 驗證 fixtures、累計修正、多帳號、重複來源、時區、未知價格、來源刪除；選用 metrics 啟用時納入去重測試 | USG-10、USG-11、USG-12、USG-18、USG-09 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |
| [ ] | USG-20 | 完成用量 E2E、可及性與效能驗收 | 兩工具額度與 Project → Agent → Session 可瀏覽；缺資料可降級，鍵盤／表格可用，背景收集不破壞既有效能 | USG-15、USG-17、USG-19、QA-07 | MVP 後的 P1 用量工作，尚未實作；能力／授權來源須另行驗證。 |

USG-09 的 OTel 為可選收集途徑；若能力評估決定不採用，記錄理由及替代來源，USG-19 仍須驗證已選途徑的去重與隱私邊界。只有帳號快照的來源不承諾 Session 細分；F16 的可用程度與缺漏必須在 UI 呈現。

## P1 工作脈絡與整合擴充

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [ ] | CTX-01 | 依試用結果確認 P1 範圍與順序 | 定義筆記、狀態、Repo、摘要、交接及候選 adapter 的驗收，不加入未決能力 | QA-08 | P1 後續範圍，尚未實作本列完整功能與驗收。 |
| [ ] | CTX-02 | 實作 Session 別名與手動狀態 | 自有 metadata 可編輯／搜尋；手動任務狀態與 Runtime 狀態分開 | CTX-01、DATA-02 | P1 後續範圍，尚未實作本列完整功能與驗收。 |
| [ ] | CTX-03 | 實作接續筆記 | Session／專案筆記可保存、修改、清除，恢復前可查看且不改原歷史 | CTX-02 | P1 後續範圍，尚未實作本列完整功能與驗收。 |
| [ ] | CTX-04 | 實作 Repo、子目錄與 worktree 分組 | 分組可辨識不同 worktree，原 cwd 與啟動目錄保持獨立；規則有案例 | CTX-01、CAT-01 | P1 後續範圍，尚未實作本列完整功能與驗收。 |
| [ ] | CTX-05 | 定義摘要模型與內容傳送規則 | 確認本機／外部、費用、來源範圍、遮蔽與啟用方式，更新決策文件 | CTX-01、SEC-05 | P1 後續範圍，尚未實作本列完整功能與驗收。 |
| [ ] | CTX-06 | 實作可核對的工作摘要 | 顯示來源、時間與模型，能修改／重生；過期或不完整摘要可辨識 | CTX-05、FIND-04、CTX-03 | P1 後續範圍，尚未實作本列完整功能與驗收。 |
| [ ] | CTX-07 | 實作可預覽的跨 Agent 交接 | 可選對話、檔案與下一步，預覽／編輯後明確傳送；不宣稱轉移模型內部狀態 | CTX-06、ADP-07 | P1 後續範圍，尚未實作本列完整功能與驗收。 |
| [ ] | CTX-08 | 評估並加入額外 Agent adapters | 逐一研究 agy、Gemini CLI、OpenCode、Aider 等候選；選定者有能力矩陣、fixtures、啟動驗收 | CTX-01、ADP-09、RUN-09 | P1 工作脈絡任務未完整交付；追加 Grok／Antigravity 的局部整合不代表本列全部能力與驗收完成。 |
| [ ] | CTX-09 | 評估並實作選用工具輸出索引 | 依需求決定是否納入；可控制範圍，驗證噪音、容量與延遲並回歸搜尋 | CTX-01、DATA-06、QA-06 | P1 後續範圍，尚未實作本列完整功能與驗收。 |

CTX-02–CTX-09 的完成均須附相應資料／流程回歸結果；摘要與交接另外驗證未啟用或取消時不傳送內容。CTX-08 中每個獲選工具再開獨立子任務，不把所有候選視為首版承諾。

## P2 持續執行與待研究功能

以下先交付範圍決策與權限模型；標示「條件式」的實作只有在對應研究決定納入後才排程。未納入者記錄理由並移出當期範圍，不標為已實作。

| 狀態 | ID | 開發任務 | 完成條件 | 前置任務 | 稽核證據／未完成原因 |
| --- | --- | --- | --- | --- | --- |
| [ ] | EXT-01 | 研究退出後持續執行需求與架構 | 比較 daemon／外部 multiplexer，定義認證、擁有權、輸出保留、停止與升級行為 | QA-08 | 後續研究／實作，尚未完成；UI 離開後持續執行與重連已提升為下一階段最高優先，未在本輪實作。 |
| [ ] | EXT-02 | 條件式實作獨立 Session daemon | UI 退出後受管程序可依設定存活；本機 IPC 驗證身份且能明確停止 | EXT-01、待範圍決策 | 後續研究／實作，尚未完成；UI 離開後持續執行與重連已提升為下一階段最高優先，未在本輪實作。 |
| [ ] | EXT-03 | 條件式實作重新附接與輸出恢復 | UI 重啟、通道斷線、daemon 重啟與版本不合有測試；不以舊 PID 判定身份 | EXT-02 | 後續研究／實作，尚未完成；UI 離開後持續執行與重連已提升為下一階段最高優先，未在本輪實作。 |
| [ ] | EXT-04 | 定義自動派工與權限模型 | 定義任務來源、可執行範圍、確認、取消、併發、重試與失敗處理 | CTX-01 | 後續條件式研究／實作，尚未完成，不能以本輪 UI／內建 registry 視為外掛或 daemon。 |
| [ ] | EXT-05 | 條件式實作自動派工流程 | 依核定範圍排程與監看，多 Agent 狀態可追蹤，取消及失敗不遺留失控程序 | EXT-04、RUN-09、待範圍決策 | 後續條件式研究／實作，尚未完成，不能以本輪 UI／內建 registry 視為外掛或 daemon。 |
| [ ] | EXT-06 | 定義外掛與任意樣式擴充邊界 | 區分主題、CSS 與程式外掛，定義 API、權限、隔離、相容及停用 | PRE-07、SEC-02 | 後續條件式研究／實作，尚未完成，不能以本輪 UI／內建 registry 視為外掛或 daemon。 |
| [ ] | EXT-07 | 條件式實作外掛與樣式擴充 | 選定能力可載入、驗證及停用；失敗不影響核心工作區，權限邊界有測試 | EXT-06、待範圍決策 | 後續條件式研究／實作，尚未完成，不能以本輪 UI／內建 registry 視為外掛或 daemon。 |
| [ ] | EXT-08 | 定義同步資料與安全模型 | 區分布局、筆記、索引與原歷史，定義授權、加密、衝突、刪除及跨機路徑 | CTX-01、SEC-05 | 後續條件式研究／實作，尚未完成，不能以本輪 UI／內建 registry 視為外掛或 daemon。 |
| [ ] | EXT-09 | 條件式實作跨機同步 | 僅同步明確納入資料，離線與衝突可恢復，刪除語意與權限可驗證 | EXT-08、待範圍決策 | 後續條件式研究／實作，尚未完成，不能以本輪 UI／內建 registry 視為外掛或 daemon。 |
| [ ] | EXT-10 | 研究並條件式實作遠端 SSH | 先定義遠端歷史／終端範圍、主機信任與憑證政策；納入後驗證連線及中斷恢復 | QA-08、待範圍決策 | 後續條件式研究／實作，尚未完成，不能以本輪 UI／內建 registry 視為外掛或 daemon。 |
| [ ] | EXT-11 | 研究並條件式實作 Shell integration | 定義受支援 Shell 與可信 cwd／命令事件；納入後驗證安裝、停用與降級 | TERM-05、待範圍決策 | 後續條件式研究／實作，尚未完成，不能以本輪 UI／內建 registry 視為外掛或 daemon。 |
| [ ] | EXT-12 | 研究並條件式實作進階終端協定 | 依需求選圖片／鍵盤協定，逐項定義資源限制、相容性與 fallback 後驗收 | QA-05、SEC-04、待範圍決策 | 後續條件式研究／實作，尚未完成，不能以本輪 UI／內建 registry 視為外掛或 daemon。 |

EXT-10–EXT-12 若通過研究，需先補產品與安全規格，再按連線、解析、UI、錯誤恢復及測試拆成子任務，才進入實作。

## 里程碑與建議開工順序

| 里程碑 | 主要任務 | 退出條件 |
| --- | --- | --- |
| M0 技術與需求驗證 | PRE、BASE、SPIKE | 原型雙面板與背景解析可用，完成平台、框架及正式選型決策 |
| M1 唯讀歷史瀏覽 | ADP、DATA、IDX、CAT、FIND；SEC 與 SET 的相關前置任務 | 跨工具分組、搜尋與預覽可用，索引生命週期及安全邊界通過驗證 |
| M2 工作恢復與 Shell | RUN、TERM；SET-01／02 | 兩工具新建／resume、普通 Shell、錯誤修復與程序清理通過驗證 |
| M3 工作區與完整 MVP | WS、SET、SEC、QA | 雙面板、客製化、布局恢復及 P0 全部驗收完成 |
| 發行準備 | REL | 選定平台的安裝、簽章／更新策略、文件與授權要求滿足 |
| M4 用量與工作脈絡加強 | USG、CTX | 用量 F15／F16 完成來源與分析驗收，其他 P1 依試用排序交付 |
| M5 持續執行與擴充 | EXT | 僅交付範圍決策後納入的功能，權限與失敗情境均通過驗證 |

先做 PRE-01、PRE-02、PRE-06，平台確認後接 PRE-04；完成平台與前端選擇後建立 BASE-01／02，再打通 SPIKE-01。原型評審後才確立正式技術方案。各里程碑可提前處理後續所需的設定或安全前置任務，正式相依以任務表為準。

## 單一任務 issue 範本

```markdown
## 任務

ID：RUN-03
優先級：P0
目標：實作有序 PTY 輸出與背壓。
前置：RUN-02、SPIKE-04
規格：docs/architecture.md 的 PTY 輸出路徑

## 交付與驗收

- [ ] 實作 runtime ID、序號、批次及消費額度。
- [ ] UTF-8、控制序列與輸出順序保持完整。
- [ ] 慢消費與斷線時緩衝有上限，清理可驗證。

## 驗證紀錄

填寫測試指令、環境／版本、結果與已知限制。
```

