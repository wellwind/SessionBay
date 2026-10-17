# Session Bay 開發路線圖

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

已實作專案父列展開 tabs、保留歷史 badge、生命週期摘要與切回既有 runtime；獨立 Agent 狀態大區移除。busy／idle 與代表工作中的 spinner 尚未完成，等待可靠 provider control/event transport；不能將存活／輸出當成工作中。使用者已選定的輸出提示另見下方。

已加入使用者同意的新輸出 pulse／背景未讀提示與短暫連線 spinner；這些不提供 Agent busy／idle 判定。該能力仍等待可靠 provider 事件，與輸出提示分開驗收。

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


## Session 清單漸進載入（2026-10-17）

已補跨批 catalog revision 協定、刪除／插入／排序／索引中變更及空尾頁回歸，並新增真實 SQLite 一萬筆 COUNT + OFFSET 量測。原生各平台視覺、總 heap 與大量訊息索引寫入成本仍屬後續驗收，不以 DOM 列數或讀取 benchmark 代替。

歷史與資源回收筒使用每批 40 筆查詢及固定列高虛擬捲動；畫面只掛載可見列、上下各 3 列與鍵盤焦點列。接近底部自動追加，並提供載入更多與重試操作。搜尋、篩選及排序切換隔離過期回應；最近 8 個查詢脈絡在元件存活期間保留載入資料，切換專案可返回原捲動位置。索引、刪除、還原導致資料更新時分批重讀已載範圍並保留畫面高度；不自動讀完整個資料庫。鍵盤方向鍵、Home／End（已載範圍）及雙向 Tab 支援跨虛擬列。驗證命令：`npx playwright test --config playwright.session-feed.config.ts`；合成 10,000 筆，不存取原始歷史。

## Agent 活動 hooks 基礎（2026-10-17）

- [x] 五工具共享 registry 的純 observation adapters、synthetic replay／binding／turn／TTL 契約測試；transport 明確 `notImplemented`。
- [x] 工作分頁已知狀態移到名稱左側，未知不顯示問號，沒有輸出不顯示暗點；保留專案分頁與無障礙生命週期。
- [ ] 認證 hook transport、launch-local opt-in registration、有序／遺失事件與 broker reconnect。
- [ ] 真實 busy／idle／人類等待狀態與三平台各 CLI 驗收。

本輪不自動安裝 hook，不把 parser 基礎當 live 功能完成。退出條件與格式範圍見[活動 hook 基礎](agent-activity.md)。

### 活動 hook 傳輸增量

- 提供 opt-in ordered publisher、runtime 綁定、短期 capability、重連／expiry 與 App observation 傳遞；詳見 [範圍與驗收邊界](agent-activity-transport.md)。
- 尚未完成：真實 provider causal bridge、使用者 opt-in 安裝／撤銷流程及三平台 native QA。一般 Agent 啟動仍無自動 hooks。
