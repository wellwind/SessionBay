# Session Bay 開發路線圖

## 2026-10-18 發行與後續順序（最新）

已確認的試用／GitHub Releases、Homebrew／Snap、更新同意、資料備份與平台限制集中於[發行與更新規劃](release-update-plan.md)。本節的最新順序優先於下方歷史排程：先恢復雲端開發空間，Quick Open／共用 panel 已於 [#65](https://github.com/wellwind/SessionBay/pull/65) 合併；接著收尾藍點提示與 Monaco palette。使用者最新調整為優先交付 Terminal 檔案路徑連結，再恢復 broker 生命週期後續與 Snap 可安裝測試包。五工具 hook 已整合，真實登入模型回合由使用者自行驗證。此輪不插入 Git 等大型新功能；Git G1–G4、完整 Release／Update、永久刪除、遠端／Web／用量保留後續規劃，Git 的完整八階工作包仍沿用既有文件。

目前功能 PR 以相關 Linux 驗證及 review 作交付門檻；發行特定 OS／架構仍需該目標實測，未驗平台不假稱通過。Windows #46 不在此次交付內。

> 2026-10-16 實作更新：本次加入 Windows 原生支援；平台前提與待驗項目見[三平台支援](platform-support.md)。既有 macOS＋Linux P0 程式碼保留；以下仍保留規劃與驗收目標。實際通過項目、效能及未驗證平台見 [MVP 驗收紀錄](mvp-validation.md)，不能由檔案存在推定所有任務已完成。
以完整工作恢復流程分階段交付。以下是工作順序與驗收門檻提案，尚未估算工期或指定發行日期。

可執行的工作拆解見[完整功能與開發任務](development-tasks.md)，包含功能對照、任務 ID、前置相依與完成條件。任務相依優先於階段順序，設定與安全工作可依需求提前完成。

## 階段 0 技術與需求驗證

交付最小 Tauri 原型，包含一個 Shell、一個 Agent、PTY 往返、兩個可見分割面板，以及背景 JSONL 解析。先選開發平台與前端框架，再確認測試環境。

退出條件：中文輸入、resize、互動應用與兩面板執行可用；能量測 UI 延遲、IPC 吞吐、應用程序樹記憶體與背景索引影響。若 WebView 或 PTY 存在阻礙，先解決或重新評估框架。

需求面完成少量目標使用者訪談與工作恢復任務觀察，確認專案分組與對話預覽能降低操作成本。

## 階段 1 唯讀歷史瀏覽

交付 Codex、Claude Code adapters，並依 2026-10-15 追加 Grok Build 與 Antigravity CLI 防禦 adapter、工具與來源設定、目錄分組、SQLite migration、增量索引、分組後的 Session 清單、搜尋與預覽。依 2026-10-15 最新決策，專案為預設首頁，所有目錄為獨立頁；兩頁均以總覽卡片與側欄先選組，前者僅 curated，後者保留全部有 Session 的目錄（含未知／失效）。總覽不是平面混合 Session 清單。設定固定呈現五工具歷史能力卡片，舊設定可明確新增 Grok／Antigravity CLI 來源，不自動改寫既有來源；真實 CLI 發行版本驗收另列。

退出條件：跨工具找到正確對話；未知或損壞事件不造成整批失敗；取消、重掃、刪除來源與封存移動可正確處理。自選專案狀態跨重開及重建保留，舊版手動加入／釘選能正確遷移，未加入及移出專案的目錄仍在所有目錄頁，選組後可搜尋歷史。此階段可以獨立試用，但不稱為完整 MVP。

## 階段 2 工作恢復與新建

接上 Agent resume、新工作與普通 Terminal，完成 Runtime Manager、cwd 檢查、重複開啟處理、程序退出與錯誤回饋。追加 Grok Build 與 Antigravity CLI 啟動、各工具自訂 argv、持久的明確危險模式 opt-in 及共用後端計畫的啟動預覽。使用者後續將 Antigravity CLI 歷史明確納入 PR #1；防禦 reader 與真實 1.3.5 相容性驗收分開追蹤，不把未驗證資料版本列為完成。

專案入口提供加入既有目錄（可選顯示名稱）及在已存在絕對父路徑下建立單一新資料夾；預覽可明確加入目錄。本機目錄欄位已接入 Tauri 原生選擇器並保留手動輸入；原生平台互動驗收仍待完成。建立不得覆寫目標或補建祖先目錄，導覽變更不影響原始 cwd／重新定位規則。

退出條件：從歷史啟動正確工具與工作環境；有資料但工具不存在時能修正；失敗時能保留診斷與重試。以受支援 CLI 版本驗證新建與恢復。

## 階段 3 工作區與 MVP

交付多分頁、左右及上下分割、焦點切換、比例拖曳、暫時最大化、基本主題、字型、快捷鍵與布局保存。

退出條件：完成產品規格的 P0 驗收；至少兩個可見 Terminal 同時執行，背景索引與大量輸出不妨礙操作。移出專案不停止 Runtime，未加入或已移出的開啟工作區在兩頁均可從獨立入口切回。原階段 3 只恢復布局；本批以階段 4 的 broker 真實狀態重新附接，broker／OS 重啟仍標示 interrupted。

## 階段 4 介面退出後持續執行（下一階段最高優先）

2026-10-15 使用者明確指定：先完成本 PR 的介面改版，再優先實作離開 UI 仍能運作、回來可辨認每個工作的狀態。這階段先於其他 P1／用量功能。

規劃順序：

1. 已採同一 executable 的 headless broker，沿用 Unix／ConPTY PTY ownership；本機 IPC 權限、輸出上限及限制見[持續 Runtime](persistent-runtime.md)。
2. 定義 UI 連線與工作程序分離的生命週期、本機 IPC 授權、服務版本相容、明確停止與孤兒程序清理。
3. 定義累積輸出／scrollback 保留上限、cwd、分頁／面板、終端尺寸與前景程式狀態的重附接模型。
4. 驗證 UI 關窗／退出／崩潰後仍能執行；重新進入看見所有已開工作與真實狀態，不重複啟動。區分服務中斷與 Agent 執行失敗。
5. OS 重開後以中斷狀態呈現；使用者理解原程序不會繼續，不能把布局／歷史恢復誤稱活程序續跑。

退出條件：三平台完成多 Shell／Agent 工作的離開、背景輸出、重附接與明確停止驗證；無未知孤兒程序或無界輸出保存。詳見[後續待辦第 09 項](future-backlog.md#09-介面退出後持續執行與重新附接下一階段最高優先)。本批已有 broker 實作與合成回歸，原生三平台互動仍待驗收。

## 階段 5 工作脈絡加強

使用者已指定整組 Agent 用量功能在 MVP 後交付。P1 新增 F15 額度總覽與 F16 Project／Agent／Session 用量分析，先驗證來源、帳號身份及計量語意，再交付帳號額度與多維度分析；詳細任務為 USG-01–USG-20，見[任務清單](development-tasks.md#p1-agent-用量與分析)與[用量規格](usage-spec.md)。

用量退出條件：支援來源的額度、重置與資料時間可辨識；Project／Agent／Session 下鑽與去重結果一致；估算、實際帳務及未知資料分開。背景收集不能影響既有終端與搜尋。整組功能不阻擋階段 3 的 P0 驗收。

依試用結果選擇 Session 別名與手動標記、接續筆記、Repo 與 worktree 分組、可核對摘要、跨 Agent 交接，以及額外 Agent adapters。

摘要需有來源與修改能力；交接需預覽傳送內容。新增 Agent 前先確認資料與恢復能力，不只加入啟動按鈕。

## 階段 6 遠端與擴充

持續執行與重新附接已提升為階段 4。後續再評估遠端連線、外掛、同步與自動派工。每項另立需求與權限模型，避免改變既有本機資料邊界。

## 效能驗證提案

所有數字是尚待實測校正的工程目標，不是已達成的產品宣稱。正式測試固定硬體、OS、WebView、工具版本、release build 與輸出模式，記錄樣本數、p50 與 p95。

| 測試 | 測試資料與情境 | 暫定目標 |
| --- | --- | --- |
| 有索引啟動 | 既有索引，背景 reconcile 同時開始 | 首個可互動畫面 2 秒內 |
| 一般搜尋 | 約 1,000 個合成 Session，約 100 MiB 來源 | warm query p95 300 ms 內 |
| 壓力搜尋 | 約 10,000 個合成 Session，約 2 GiB 來源 | p95 1 秒內，UI 不阻塞 |
| 輸入互動 | 兩可見面板與四背景面板，固定速率輸出 | 合成 echo 情境的按鍵到可見結果 p95 50 ms 內 |
| 大量輸出 | 漸進提高 PTY 輸出量 | 找出最大穩定吞吐，不能靠丟棄輸出達標 |
| 長時間使用 | 多次開關面板、索引同步與持續輸出 | 程序與 handle 正確釋放，記憶體沒有持續無界成長 |

初次完整索引另量測總耗時、CPU、峰值記憶體與可取消性，不與有索引啟動混成同一數字。中文短詞、英文詞與程式碼識別字分別測量召回率與延遲。

2026-10-16 第一階段索引熱路徑改善及合成 1k／10k／長對話 before／after 見[索引效能量測](index-performance.md)。原生 UI、真實資料及 CPU profiling 尚待驗收，10k 高命中率識別字搜尋仍未達上述目標；不將這一輪局部改善視為全數完成。

記憶體分別報告 Session Bay Core、WebView 及 GPU 相關程序，以及 Agent 子程序；避免只取主程序的數字。不同平台無共同基線前不宣稱比 Electron 快多少。

## 必要驗證清單

- adapter fixtures：去識別事件、部分寫入、分支、封存與未知格式。
- 索引整合：追加、替換、截斷、刪除、重建與 migration。
- 專案導覽：掃描不自動加入、舊版手動／釘選遷移、加入／更名／移出持久化、重建後保留；專案預設首頁與所有目錄頁均有分組總覽，未知／失效分組保留，選組後查詢不受加入狀態影響。
- 專案建立：合成絕對路徑、單層名稱、既有目標／不存在父目錄／無效名稱拒絕，取消與失敗不誤建資料夾。
- Agent 擴充：五工具能力卡片固定可見、舊 Grok 缺來源的草稿／明確保存、來源狀態分離、五工具設定隔離與舊設定遷移、白名單／危險參數 opt-in、精確 argv 預覽與啟動一致、手動 ID／索引 ID 互斥與來源歧義阻擋。
- Grok 歷史：summary／stream 配對、cwd 身份核對、rewind、跨檔變更、缺檔／部分寫入、來源唯讀。
- Antigravity CLI 歷史：官方 transcript.jsonl 的防禦 reader、metadata 唯讀快照、rewind／compaction 重寫保護、未知格式警告及受限制接續；full-only 不復活正文。真實 CLI 1.3.5 樣本／互動接續與 App／IDE 能力不得由合成 fixtures 推論。
- Runtime 整合：啟動、輸入、resize、退出、關閉與子程序清理。
- UI 端到端：雙頁選目錄、目前目錄搜尋快捷鍵、預覽、兩段式 Shell／Agent 啟動器、接續、分割普通 Terminal；統一控制項與焦點可用。
- 工具登錄：共用 manifest 的前後端契約、安裝／版本重新偵測；內建 parser 與 argv 安全邊界不因 metadata 改動而放寬。
- Shell 設定：有效 `$SHELL`／平台 fallback、預設 `[-l]`、唯讀候選偵測與明確加入，保留自訂 Profiles／預設且不匯入 rc。
- 工作區保留：未加入歷史直接接續、執行中移出專案、切回已開啟工作區，不終止或遺失程序入口。
- Shell／Agent 退出：普通 Shell 結束碼 0 自動清理對應 runtime 與面板（含重附接、背景及臨時分頁）；新建／接續 Agent 正常退出同樣清理；異常／未知退出保留畫面。重附接不重跑原指令，明確關閉僅停止並移除指定 Runtime。
- 人工相容性：中文輸入法、快捷鍵、Vim、tmux 與 Agent 互動式畫面。
- macOS 圖示：專用留白向量、可重複 ICNS 產生、各尺寸 alpha 邊界與其他平台圖示不變；原生 Cmd+Tab／Dock 視覺比較另驗收。

## MVP 完成標準

產品規格 P0 全部有可重複的驗收結果；支援矩陣、已知限制與效能量測可供試用者查看。跨平台發布、程式簽章與自動更新依選定平台另排工作，不以本機可執行原型代替正式發行。

## 2026-10-15 試用回饋待排程

使用者要求先記錄的 17 項需求見 [後續待辦](future-backlog.md)。第 09 項持續工作狀態已提升為下一階段最高優先（階段 4），其餘順序與工期未定，均不自動加入本輪實作。持續工作狀態不能以階段 3 的布局占位還原視為完成；中文輸入、Shift＋Enter 與索引時間須先重現／量測再排修復。

## 最高優先：退出 UI 後持續執行

- [x] 獨立 broker／附接實作與個別功能 PR 同提交 Linux E2E。
- [ ] 最終整合樹未過濾 Linux socket E2E 與三平台原生互動驗收。不能將本機 socket 受限或 Windows 交叉編譯算成原生 passed。詳見[持續 Runtime](persistent-runtime.md)。

## 日常體驗：全域臨時 Terminal

- [x] 無專案 home Shell、null 分頁／面板、獨立選取、側欄找回與既有明確 cwd 相容的實作及單元回歸。
- [x] 原功能 PR 同提交 Linux broker E2E。
- [ ] 最終整合樹未過濾 Linux socket E2E 與原生三平台桌面驗收；不可將 socket 受限或交叉編譯算成原生通過。獨立 Draft PR 疊在持續 Runtime PR #7，詳見[驗證清單](temporary-terminal.md)。

## 2026-10-16 OpenCode 獨立 PR

第五 provider 的官方 SQLite v1/v2 reader、來源 UI、安全啟動／接續與合成回歸列為本 PR 交付；依賴原生平台 PR #3。舊 JSON 與任意 channel DB 不宣稱支援，真實 OpenCode 三平台接續仍待驗證，詳見 [OpenCode 整合與驗證](opencode-integration.md)。

### Shift＋Enter 原位輸入（取代未合併的 modal 方案）

- 2026-10-17 依使用者要求統一所有 Terminal 的單鍵 CSI-u 相容輸入，移除依 provider／平台選擇與面板模式介面；不偵測前景程式，無 LF／CR fallback。
- 自動化與原生驗收分開；完整 CLI、三平台 WebView／ConPTY、IME、tmux／SSH／WSL 尚待驗收，不能標成全工具通過。見 [版本與驗證清單](terminal-keyboard.md)。


### 外觀修訂與命令面板

保留既有十個色系，新增 Code Modern／Code 2026 深／淺色 UI 與 Terminal；命令面板可搜尋、鍵盤預覽、Enter 保存及 Escape 還原。全工作台 page zoom 使用獨立 appZoom，與主題共用序列化保存，不乘改 Terminal 基準字級。修訂後整合樹的自動化與原生待驗項目見[批次整合驗證](batch-integration-validation.md)。

- Agent 個別設定：可搜尋選擇器與啟用偏好、保留停用 provider 快取與現有 Runtime；前端 835 項自動化回歸通過，三平台原生操作及瀏覽器截圖驗收尚未完成。

### 2026-10-17：Session 可復原刪除

第一階段：Session Bay metadata tombstone、回收筒與還原；原始 Agent 歷史唯讀。第二階段仍待設計：依 provider 安全刪除原始歷史、共用資料庫與執行中 Agent 的競爭保護、刪除前逐次確認與不可復原影響。不得將第二階段列為已支援。

- [ ] 原始對話永久刪除：功能未完成。已整理[契約與架構缺口](permanent-deletion-investigation.md)及[合成負面探針](permanent-deletion-probes.md)，不代表功能驗收。既有 SQLite path 來源不人工配對 API 後執行刪除；下一步評估新 API 型來源或受管 provider transport，仍須解決 atomic idle／children／cleanup／remote routing。
### 臨時 Terminal 混版相容

- [x] 固定舊 protocol 1 schema 的未知欄位重現、雙向 Hello 相容、scope／generation 與 workspace 身分比對回歸。
- [ ] macOS 真實舊 broker 持續執行時更新 UI，驗證新臨時 Terminal、既有 Agent 重附接與重開工作區；不得停止原有程序。

### Agent 生命週期總覽

- [x] 共用 registry 辨識、Runtime 去重、專案／全域分組、停用不漏計及背景面板事件更新的實作與合成回歸。
- [ ] 原生三平台狀態顯示與重連實機驗收。
- [ ] 忙碌／等待輸入：等待可靠結構化 Agent 活動訊號；目前明確顯示活動未知。
- [x] 此候選的 826 項前端測試、typecheck、lint、production build；另含 actual-App Chrome 接受測試與截圖輸出，接入 CI。
- [ ] Chrome 接受測試實際執行與截圖檢視：雲端未安裝 Google Chrome；系統 Chromium 在 sandbox 因 socket 權限中止。未繞過 sandbox，需在 CI 完成。

命令面板主清單新增 ↑／↓ 循環選取、搜尋重設、停用跳過與 Enter 執行；沿用主題子清單預覽／取消。前端回歸涵蓋 IME、焦點、空結果與專案選取；原生 macOS 輸入法實機驗收仍待執行。

## 圖片輸入增量

- 本機 PNG／JPEG 拖放、系統／工具列貼上與安全 staging：實作待 CI 及獨立審查。
- 三平台原生 webview／CLI 驗收、Antigravity adapter 與保留圖片容量管理 UI：尚未完成。詳見 [圖片輸入](image-input.md)。

## 2026-10-17 側欄整理


### 專案目錄整合工作區（2026-10-17）

已實作專案父列展開 tabs、保留歷史 badge、生命週期摘要與切回既有 runtime；獨立 Agent 狀態大區移除。本段原始交付尚無 busy／idle；後續 #56／#61／#64 已整合版本限定的 provider 活動來源及狀態圖示，見下方整合進度。仍不能將存活／輸出當成工作中。使用者已選定的輸出提示另見下方。

已加入使用者同意的新輸出 pulse／背景未讀提示與短暫連線 spinner；這些不提供 Agent busy／idle 判定。後續 provider 活動來源與輸出提示分開驗收，真實已登入模型回合仍待使用者驗證。

專案清單以拖曳排序取代置頂，保留首次遷移順序，提供 Alt＋上／下鍵盤替代操作，不再顯示上／下移按鈕。專案／目錄清單、開啟中的工作區獨立收合並記住狀態；不更動執行中程序。前端測試與原生跨平台驗收分別記錄，不以瀏覽器測試取代原生驗收。

- 拖曳讓位預覽候選：transform-only 的專案／分頁排序與鍵盤等效；本地測試與真實 Chrome 動畫／保存證據分開記錄，macOS 原生 WebView 仍待實機驗收。


### 工作區專注模式

- [ ] 可逆收起外框、完整功能入口、常駐終端及尺寸更新的自動化驗證。
- [ ] macOS／Linux／Windows 真實桌面、原生全螢幕與多分頁下的視覺及輸入驗收。

## 一般檔案輸入增量

- 所有副檔名／MIME、空檔、保留安全名稱與目錄拒絕：候選實作，待獨立審查與 CI。
- 真實 CLI 解析、三平台 WebView／OS 剪貼簿與容量管理 UI 尚待驗收／實作，詳見[一般檔案輸入](file-input.md)。
### 工具設定下拉選擇

已實作可搜尋工具下拉與三區設定；單元回歸與瀏覽器合成腳本隨程式更新。原生 WebView、真實數十個 provider 與螢幕閱讀器實測仍待驗收。

### Windows installer 隔離驗收

- [x] 建立 [固定 SHA 的獨立手動 installer workflow](windows-installer-smoke.md) 與本機拒絕執行防呆。
- [ ] 在核准的 GitHub hosted x64 runner dispatch 並檢視 installed binary／uninstall evidence。
- [ ] ARM64 正式安裝包與一般使用者 UAC／SmartScreen 體驗另行驗收。


## 2026-10-17 Files 工作區候選

專案層 Files 側欄與共用唯讀分頁已列入獨立候選，不新增編輯器或 Runtime schema。合併門檻包含零 Terminal 瀏覽、預設隱藏檔、預覽／固定去重、正常／專注模式狀態、關閉／組字／拖曳隔離與原 Terminal 身分保留。GitHub Actions 已執行新版 Files 與正常／專注模式瀏覽器回歸並檢視合成資料截圖；原生驗收仍未執行，不能以瀏覽器紀錄替代。

## Session 清單漸進載入（2026-10-17）

已補跨批 catalog revision 協定、刪除／插入／排序／索引中變更及空尾頁回歸，並新增真實 SQLite 一萬筆 COUNT + OFFSET 量測。原生各平台視覺、總 heap 與大量訊息索引寫入成本仍屬後續驗收，不以 DOM 列數或讀取 benchmark 代替。

歷史與資源回收筒使用每批 40 筆查詢及固定列高虛擬捲動；畫面只掛載可見列、上下各 3 列與鍵盤焦點列。接近底部自動追加，並提供載入更多與重試操作。搜尋、篩選及排序切換隔離過期回應；最近 8 個查詢脈絡在元件存活期間保留載入資料，切換專案可返回原捲動位置。索引、刪除、還原導致資料更新時分批重讀已載範圍並保留畫面高度；不自動讀完整個資料庫。鍵盤方向鍵、Home／End（已載範圍）及雙向 Tab 支援跨虛擬列。驗證命令：`npx playwright test --config playwright.session-feed.config.ts`；合成 10,000 筆，不存取原始歷史。

## 永久移除（2026-10-17）

- [x] 回收筒逐筆唯讀來源影響檢查及 provider blocker，詳見 [安全界線](permanent-removal.md)。
- [ ] Provider 排他協定、完整關聯清理計畫與逐次確認後的永久移除；本次未開放任何來源刪除。

## Agent 活動 hooks 基礎（2026-10-17）

- [x] 五工具共享 registry 的純 observation adapters、synthetic replay／binding／turn／TTL 契約測試；transport 明確 `notImplemented`。
- [x] 工作分頁已知狀態移到名稱左側，未知不顯示問號，沒有輸出不顯示暗點；保留專案分頁與無障礙生命週期。
- [ ] 認證 hook transport、launch-local opt-in registration、有序／遺失事件與 broker reconnect。
- [ ] 真實 busy／idle／人類等待狀態與三平台各 CLI 驗收。

本輪不自動安裝 hook，不把 parser 基礎當 live 功能完成。退出條件與格式範圍見[活動 hook 基礎](agent-activity.md)。

### 活動 hook 傳輸增量

- 提供 opt-in ordered publisher、runtime 綁定、短期 capability、重連／expiry 與 App observation 傳遞；詳見 [範圍與驗收邊界](agent-activity-transport.md)。
- 此段為傳輸基礎的歷史範圍。後續 #56／#61／#64 已接上五工具來源與設定啟用／撤銷；#69 將 hooks 預設啟用，但保留既存明確 false 與平台能力限制。真實已登入模型回合及 macOS／Windows native QA 仍未完成，詳見下方整合進度。

## 2026-10-18 真實 hook bridge

Codex／Claude launch-local callback、broker 綁定、設定啟用／撤銷已實作；真實 CLI→native UI 驗收仍待實際版本證據，見 [provider-hooks](provider-hooks.md)。OpenCode 後續增量見下；Grok／Antigravity 已由 #64 接通版本限定的 Unix OSC7501 來源，真實已登入模型回合仍未驗。

### 原生狀態實作與驗收

- [x] Claude launch-local mod、Codex owned app-server read-only observer、source sequence／快照失效及 UI 進行中／等待／閒置圖示。
- [x] 設定關閉撤銷現有來源，保留 Agent 執行；不修改使用者全域 hooks 或 notify。
- [x] PR56 69e26df exact-head Linux CI；Claude 2.1.302 Linux 官方 plugin validate；Codex 0.159.2 Linux 官方 app-server initialize / 空 loaded-list（無模型請求）。
- [x] #56 → #61 → #64 已依序合併；[整合 main `dca4e6d6` Linux CI](https://github.com/wellwind/SessionBay/actions/runs/39096966750) 通過，後續 [main `148b2615` Linux CI](https://github.com/wellwind/SessionBay/actions/runs/39100959264) 也通過。
- [ ] 真實已登入 CLI 回合 Busy→Idle 與 GUI 驗收（無憑證的載入測試不等於回合驗收）。
- [ ] macOS／Windows 原生驗收；依目前交付範圍不作 Linux 合併門檻。
- [ ] Claude 回合內權限／輸入等待、Grok／Antigravity 及 Windows 的正式支援。

- 專案內右側 Activity Bar：左側保留專案／所有目錄，歷史 Sessions／Files 共用右側工具面板，中央內容獨立；typed contribution、延遲掛載與 overflow 為未來功能保留擴充點。Git 等其他功能待實作後才加入。

### OpenCode 原生活動增量（2026-10-18）

- [x] Unix launch-local plugin、保留 JSONC／argv／--pure、native root ancestry 驗證、單一有序來源與 broker TTL。
- [x] busy／retry／idle、pending permission／question 集合，來源錯誤降為 unknown，不把 error／idle 當成功。
- [x] 官方 OpenCode 1.19.3 Linux `--version` 與隔離 `debug config` plugin 載入／dispose，無登入／模型呼叫。
- [ ] 真實回合與等待狀態 E2E；無模型載入與合成 contracts 不取代此證據。
- [ ] macOS 原生 QA；Windows private staging、能力啟用及 native QA。

## 2026-10-18 Git 工作台（已確認規劃，尚未實作）

完整範圍、風險與驗收見 [Git 工作台功能規劃](git-workbench-plan.md)。以下為八個預計實作 PR，全部未完成；不影響上述既有任務狀態。

- [ ] G1 Git 基礎與多 repo。2026-10-21 已在 `feat/git-g1-foundation` 實作並通過本機 Linux 自動測試；尚未開 PR、未跑 CI、未原生驗收。
- [ ] G2 文字 Diff 與同檔部分 hunk／行暫存。
- [ ] G3 Commit、fetch／pull／push。
- [ ] G4 第一階段歷史 graph 與 blame。
- [ ] G5 分支、stash／reset／revert／tag 與安全復原。
- [ ] G6 應用內三方衝突解決及儲存。
- [ ] G7 GitHub／自架 GitLab 主機與帳號連線。
- [ ] G8 PR／MR 建立、review、CI 狀態與合併。

Worktree 管理與完整 CI logs／retry／cancel 後續另行規劃；非文字內容 diff 不在範圍內。既有 worktree 的正確 Git 探測與非文字變更／衝突處置仍在基礎範圍。

2026-10-18 已合併 [#65](https://github.com/wellwind/SessionBay/pull/65)：專案 Cmd+P 將已開分頁、未開 Sessions 預覽及有界遞迴檔名搜尋整合；右工具共用 resize 容器、可存取 tooltip 與自訂快捷鍵。[合併後 main `148b2615` Linux CI](https://github.com/wellwind/SessionBay/actions/runs/39100959264) 通過。macOS／Windows 原生互動未驗，不以交叉編譯代替。

## 真實活動訊號整合進度（2026-10-18）

Claude Mod、OpenCode plugin 與 Codex／Grok／Antigravity OSC7501 已接入 opt-in broker／UI；後三者明示終端來源信任。五工具全部串接與 Linux 驗證為整合門檻，不能用畫面推測替代。真實無登入啟動、合成回歸、模型回合與平台驗收分開追蹤，見 [原生終端活動訊號](native-terminal-status.md)。Windows 原生 hooks／OSC 的驗收仍未完成。

### Monaco 唯讀預覽

- [x] 實作延遲載入 Monaco、唯讀模型、全文搜尋／選取／折疊、每檔案 view state、本機 workers 與 CSP。
- [x] Linux 真實瀏覽器與 Tauri WebKit、review 通過，已合併 [#60](https://github.com/wellwind/SessionBay/pull/60)。
- [ ] macOS／Windows 原生 WebView 驗收（非此次 Linux 交付阻礙）。

## 大型文字檔閱讀

中央 Files 已實作 metadata 預檢與分塊讀取、取消、確認與分段模式；Linux dev／production browser、Tauri WebKit、Rust tests／Clippy 與 build 已在 [#66](https://github.com/wellwind/SessionBay/pull/66) 通過；尚未宣稱三平台原生驗收。詳見 [大檔閱讀](large-file-reading.md)。

## 檔案圖片閱讀

- [x] PNG／JPEG／GIF／VP8 有損 WebP／受限靜態 SVG 的中央 tab 預覽、縮放與資源有界處理，已合併 [#68](https://github.com/wellwind/SessionBay/pull/68)。
- [x] 最終 head `8dcc591` 的 [Linux browser／core CI](https://github.com/wellwind/SessionBay/actions/runs/39097805009) 與 [Tauri／WebKit smoke](https://github.com/wellwind/SessionBay/actions/runs/39097805078) 通過。
- [ ] macOS／Windows 原生驗收；不宣稱完整 WebP 或所有 SVG 支援。詳見 [圖片預覽](file-image-preview.md)。

## Broker 生命週期與單次無 hooks 啟動（分步實作）

先完成目前工作台修正、broker 生命週期與單次無 hooks 啟動，再製作 Snap 測試包；Git 等大型新功能不插隊。詳見 [安全升級與驗收計畫](broker-lifecycle-plan.md)。

- [ ] 持續 client lease、權威清理判定與無工作／無 client 延遲退出。
- [ ] 明確確認的「結束所有工作並退出」，部分清理失敗如實回報。
- [ ] 版本隔離 registry、完整 runtime owner routing、新工作切換與現代 broker drain。
- [ ] Legacy 限制、共用資料單 writer／schema 過渡、更新與 rollback 驗收。
- [x] #78 已合併：已知 preflight 未啟動後的單次無 hooks 按鈕，保留原參數且不重送 unknown outcome。

L1a 保守 runtime 證據記帳與原子 admission seal 已於 #82 合併，review 修正、本機 core／desktop 與 Linux CI 通過。L1b 本次接入協商式 UI lease 與 native owner，保守保留 legacy／失聯 pin，Mac core／desktop 測試與 Clippy 通過，Linux CI 與 review 已通過並於 #84 合併；兩者都不啟用 broker 自退。後續依序是完整 broker admission／idle timer 整合及 Stop all。上述完整生命週期仍未完成；不能將 runtime snapshot 或 List 空陣列當成停止服務的授權。

## Terminal 檔名點開 tab（首版待 review）

- [x] 首版連到中央檔案 tab，支援行欄定位、候選選擇與後端安全界線；啟動 cwd 僅作提示，相對路徑一律確認。
- [ ] 修飾鍵點選、OSC8／URL 區分、跨平台路徑及不可信輸出驗收。

依使用者最新指示優先交付，broker 後續與 Snap 暫停。Mac 合成驗證已通過，Linux CI／獨立 review 與原生跨平台驗收另列。完整範圍與安全界線見 [Terminal 檔案路徑連結](terminal-file-links.md)。

- Agent 面板活動文字：沿用可靠 hook／原生終端狀態、未知留白及生命週期優先；合成元件／瀏覽器回歸已加入，真實模型回合與跨平台原生驗收仍待執行。

### 工作區 UI 密度與 Zen 索引穩定性（候選）

分頁列固定控制、自動揭露選取項、兩類分頁樣式、Activity 分隔線與歷史 Undo toast 已有候選實作。Zen 保留固定高度狀態列，避免索引狀態插拔改變 Terminal 高度。新增窄版／縮放／主題／拖曳及索引幾何驗收；Ubuntu 主機記憶體不足，瀏覽器與原生桌面驗收仍待完成，不視為已通過。

### L1c 未使用 broker 退休候選

工作區 UI #86 已合併並通過 main CI，恢復 broker→Snap 順序。L1c 首版僅涵蓋明確從未嘗試工作的 lineage、完整 IPC admission、UI lease 與 30 秒 grace；任何工作嘗試或未知狀態保留 broker。候選實作與 focused tests 待獨立 review，尚未發布；Stop all／版本 routing／Snap 仍待後續。

### 左側專案導覽 resize（2026-10-19）

加入共用寬度偏好及可鍵盤操作的分隔線。單元／回歸與原生 WebKitGTK 合成畫面的驗證結果見交付報告；完整 Tauri backend／安裝版驗收不以 mock QA 代替。邊界與操作見 [左側專案導覽寬度](project-navigation-resize.md)。

### 左側導覽原生縮放範圍修正（待審查）

改依實際布局容器計算範圍，避免縮放後 viewport 小於畫布造成 min=max。完整 App 真實 mouse 與 aside 幾何回歸納入 focus-mode 測試組；原生 WebKit 與 macOS 實際症狀的驗證界線見交付報告，不以 Ubuntu 通過概括 macOS。

- 短視窗／高縮放候選：撤除外框 700×420 下限，以固定 tabs/status bar 及中央剩餘高度分配；增加專案／面板選項入口。Chromium、Ubuntu 原生 WebKit 與隔離 Tauri 的驗收結果分別記錄，尚未宣稱 macOS 驗收；白色殘影未重現，未加入推測修正。
