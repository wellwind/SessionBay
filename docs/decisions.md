# Session Bay 決策與待確認事項

此表區分使用者已確定的需求、目前建議方案與待決策事項，避免把討論中的選項當成已核定實作。基準日期為 2026-10-15。

## 2026-10-17 Terminal 內容重繪與有界輸出批次

- 問題範圍為 Agent 執行時 Terminal 內容閃爍；既有 xterm 實例生命週期、React UI 與主題切換不因此重寫。
- Broker client 僅合併同一 Poll 回應內、同 runtime 且 sequence 連續的 Output。保留所有位元組及順序，使用末端 sequence；Snapshot／Exit／Error／Disconnected 及 sequence 缺口均為批次邊界。每批維持 64 KiB 上限，不增加 Poll、等待計時器、重放保留量或 ANSI 緩衝。
- 原本逐事件的 lease／取消／30 秒 ACK 等待不變；前端必須等整批 xterm.write callback 完成才 ACK。1 MiB／128 frame 的 replay 上限、過期後 snapshot 重建、OSC 52 與查詢過濾均維持。
- 合成延遲模型每個 write／ACK 往返期間產生四個小 chunk，30 次 Poll：原逐 chunk 模型為 513 次 write 與 9 次 snapshot；批次模型為 30 次 write、0 次 snapshot。這是固定條件的單元模型，不是實際使用者效能或 macOS 視覺驗收。
- 真實 TerminalPane／xterm 的 Chrome fixture 分開觀察跨 write 的同步清除／重繪與同一批次 write；只記錄 reset、write、ACK、resize、render 與空白 render 計數，不擷取使用者輸入。CI 證據與原生桌面驗收需分別確認。
- xterm 5.5 尚未支援 DEC 2026；跨 Poll 的同步 repaint 仍可能閃爍。6.0 升級需獨立審查 Fit／Search addon、鍵盤與 IME 相容性，本次不升級、不加入私有 renderer hook。

## 2026-10-17 啟動時最大化

- 主視窗建立時預設最大化（`maximized: true`），不是全螢幕；保留一般視窗的還原／調整大小操作。原有 1440×940 還原尺寸與最小尺寸不變。
- 現行程式沒有持久化視窗狀態還原；此設定只作用於主視窗建立，不在使用期間強制重新最大化。原生各平台的實際視窗管理器行為仍需實機驗收。

## 2026-10-17 側欄收合與專案自訂排序

- 專案清單、所有目錄清單、開啟中的工作區可獨立收合，記住上次狀態；收合不關閉工作區或程序。
- 專案改為拖曳自訂順序，提供上／下移按鈕與 Alt＋上／下快捷鍵；移除所有置頂介面。首次載入依舊版置頂／活動順序遷移，後續新加入專案追加在末尾。
- 側欄偏好獨立存於本機 WebView localStorage，不與設定或工作區整份保存競爭；失敗需提示。保留舊版 pinned 資料以相容既有 catalog，不再提供寫入入口。移出、重掃與重新加入保留原位置；排序不更動名稱、檔案、執行中程序或所有目錄的探索排序。
- 主視窗關閉 Tauri 原生檔案拖放攔截（`dragDropEnabled: false`），讓 Windows WebView2 使用 HTML5 拖曳排序；目前沒有原生檔案拖放功能；原生目錄選擇仍使用獨立 dialog plugin，不受影響。此設定不承諾保留未來的原生 dropped-file 路徑 API；後續圖片拖入可明確處理使用者提供的 HTML5 File bytes。
- 本次只調整現有平面清單，不新增專案／工作區巢狀樹。

## 2026-10-16 原生目錄選擇器（獨立 PR）

- 本機目錄欄位使用 Tauri 2 官方 dialog plugin 的單選資料夾對話框：加入既有專案、建立專案的上層目錄、歷史來源根目錄、重新定位與啟動工作目錄。
- 保留可直接輸入的文字欄位，支援隱藏目錄及特殊路徑；選取只回填目前草稿，不自動儲存、建目錄、啟動或索引。取消與失敗保留草稿，後端原有驗證、canonicalization 與存取邊界仍為準。
- 主視窗僅授予 `dialog:allow-open` 與既有終端安全確認所需的 `dialog:allow-message`，不加入 filesystem、save 或 shell plugin 權限。瀏覽器預覽沒有原生選擇器時顯示提示並保留文字輸入；不實作遠端目錄瀏覽或 Web 檔案上傳。
- 官方 plugin 2.8.3 會將 `window.confirm` 改為 `Promise<boolean>`。多行貼上與停止程序一律經共用 async helper，只接受明確 `true`；取消、權限拒絕、例外與重疊請求均不執行。等待剪貼簿／確認期間鎖定重複操作，回覆後重新核對原 pane、runtime、啟動世代與可見性，避免晚到確認操作新終端。
- Shell Profile 目前沒有 cwd 欄位；Shell／Agent 執行檔欄位仍維持文字輸入，不把執行檔當成資料夾。
- 非同步選取結果在欄位編輯、模式切換、儲存鎖定或關閉／重新開啟後失效，避免覆蓋較新的草稿或重建已關閉的視窗。系統對話框取消後回到原欄位。
- dialog plugin 提供 macOS／Windows／Linux API；這不代表本 PR 完成 Windows 整體支援，三平台遷移使用另一個獨立 PR，原生選取驗收與編譯結果分別記錄。

官方依據：[Tauri Dialog](https://v2.tauri.app/plugin/dialog/)，查閱 2026-10-16。

## 2026-10-16 Code 配色與命令面板主題切換

- 使用者追加 Modern 與 2026 深／淺色兩組配色，介面與 Terminal 都提供對應選項；保留原有十個色系及所有 ID。名稱採 Code Modern、Code 2026，屬 Session Bay 的配色改編，不代表 VS Code 官方產品或合作關係。
- 官方來源固定到 Microsoft VS Code commit 3588843f05a21bfdeada83a9799d87f19de0fadd，讀取主題 include 鏈與 Terminal ANSI 預設值，保留 MIT 著作權與授權告知。側欄、編輯區、面板、分頁、控制項及焦點採語意對應；低對比文字、ANSI 色與必要邊界作可及性調整，明列差異而非宣稱像素一致。
- 命令面板提供獨立「切換介面主題」「切換 Terminal 主題」入口：搜尋名稱、鍵盤移動即預覽、Enter 套用保存、Escape／返回取消。與設定及快速切換的預覽擁有權互斥，延遲保存不可覆蓋後來設定或縮放。
- 保留既有設定立即預覽／取消還原、快速切換與 Terminal 實例生命週期；原生桌面視覺驗收仍需另行完成。

## 2026-10-15 工具登錄、啟動器與輸入操作一致性

本節記錄原功能批次；後續使用者追加的 Antigravity CLI 歷史、IME／快捷鍵與來源偵測依本文件後段決策執行，未來待辦仍不納入實作。

- `src/agent-manifest.json` 是內建 provider metadata 的共同來源，由 TypeScript 與 Rust 使用，統一名稱、標誌、預設執行檔、版本探測、來源能力及啟動參數模板。Rust parser 與工具專屬參數驗證仍為明確的型別實作；新增 manifest 條目不會自動產生 adapter，也不是動態外掛載入。
- 工具重新偵測更新執行檔／版本資訊，與歷史索引掃描分開。設定草稿需先保存再偵測，不把可執行檔存在等同歷史可讀或登入成功。
- 新增工作先選「普通 Shell」或「Agent」，Agent 再用帶標誌的登錄清單下拉選擇，避免每多一個工具就增加頂層按鈕。
- 搜尋快捷鍵在已選定專案／目錄時保留該組範圍；未選組時，明確按下跨目錄搜尋按鈕或快捷鍵才開啟全域搜尋，不能以此取代兩頁預設分組總覽；輸入框的外框焦點狀態一致。下拉選單、勾選框與日期欄位採一致樣式，保留標籤、鍵盤與可及性語意。
- Shell 重新偵測只讀取候選執行檔，由使用者明確加入 Profile 並保存；不覆寫既有自訂 Profiles 或預設 Profile，不導入其他 Terminal 的設定或 Shell rc 檔。
- 全新設定選用有效、絕對路徑且存在的 `$SHELL`；否則 macOS 用 `/bin/zsh`、Linux 用 `/bin/bash`，預設參數為 `[-l]`。Session Bay 不匯入 rc 設定；啟動後由該 Shell 依自身規則載入啟動檔。

這些新契約需與本批其他變更一起完成全套及三平台 exact-commit CI；文件記錄不代表已驗收。

## 2026-10-15 四 Agent 歷史來源入口一致性

四個 Agent 的歷史能力卡片固定顯示，不依是否已啟動、是否找到執行檔或目前有無來源而隱藏。執行檔、歷史 adapter、來源設定與索引健康是不同能力／狀態。

- 四工具提供各自來源設定；Antigravity 後續依使用者要求加入 CLI 防禦 reader，明示 1.3.5 真實樣本尚待驗證。新工作、手動 ID 與索引接續的能力分別回報。
- 舊設定只有 Codex／Claude 來源是保留使用者設定的升級結果，與是否曾開啟 Grok 無關。缺少 Grok 來源時提供設定入口，先建立可編輯草稿，由使用者填入絕對路徑並明確保存；不猜測使用者 home，不在升級時自動新增或索引新根目錄。
- 保留既有來源 ID、根目錄與 enabled 狀態，允許同一工具的多個不同來源；新增草稿不等於已保存或開始掃描。
- 前後端以共用 manifest 集中工具資訊；後端仍是內建、具型別的 Agent 分派與 adapter，並非動態外掛。未知工具／未驗證格式不因有啟動器就自動取得歷史能力。

本次與雙頁導覽、macOS 圖示合併驗證；先前 CI 不代表這些新行為已通過。

## 2026-10-15 macOS 圖示視覺尺寸修正

使用者回報 macOS `Cmd+Tab` 中 Session Bay 圖示比其他應用明顯偏大。原始 512×512 SVG 的實色圓角底板貼齊畫布四邊；本次只調整 macOS 傳統 ICNS 的視覺占比，不改品牌圖形或 Linux 圖示。

- 新增 macOS 專用向量來源 `src-tauri/icons/icon-macos.svg`，將原圖等比縮至 412×412，置中於 512×512 透明畫布，每邊留 50 px；等同 1024 畫布內 824 px 圖形、每邊 100 px。
- 此比例是 Session Bay 的視覺校正選擇，**不是 Apple 官方規定的 ICNS 留白數字**。Apple 現行文件強調視覺平衡、置中及新版 Icon Composer／圖示網格；其分層圖示規則不能直接當作傳統 ICNS 的固定安全邊界。[Apple App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons/)
- 使用 Tauri icon CLI 於暫存輸出目錄產生平台圖示，只更新 macOS 的 `icon.icns`；原 SVG、Linux PNG 與 Windows ICO 保留。產生步驟需有可重複腳本，避免日後用無留白原圖覆寫 ICNS。[Tauri App Icons](https://v2.tauri.app/develop/icons/)
- 驗證需包含 ICNS 各尺寸透明邊界與圖形一致性、Linux／ICO 檔案未變，以及 macOS 實際 `Cmd+Tab`／Dock 的視覺比較。檔案檢查與建置不能代替原生畫面驗收。

官方來源查閱日期：2026-10-15。此修正與下方新的雙頁導覽合併後須重新驗證，不能沿用先前提交的 CI 作為通過證據。

## 2026-10-15 新增 Agent 與每工具啟動選項

使用者追加 Grok Build、Antigravity CLI，以及每個 Agent 各自的自訂啟動參數；要求明確啟用後不必每次啟動重複確認危險模式。本節取代原先僅將 `agy` 列為候選、以及完全不提供跳過權限旗標的範圍描述。功能實作與最終驗證分開記錄。

| 項目 | 已決定的行為 | 邊界 |
| --- | --- | --- |
| Agent 種類 | `codex`、`claude`、`grok`、`antigravity`；預設執行檔分別為 `codex`、`claude`、`grok`、`agy` | 可自訂執行檔；不代管登入或儲存 API key |
| Grok Build | 新工作、指定 ID 接續，並加入唯讀本機歷史 adapter | 以官方原始碼的 `summary.json`＋`updates.jsonl` 為依據；實際 CLI 版本仍待驗收 |
| Antigravity CLI | 新工作、手動 ID；後續追加 CLI 唯讀歷史與受限制索引接續 | 已觀察持久化格式的防禦 reader；CLI 1.3.5 真實樣本／實機接續待驗證，不包含同品牌 App／IDE |
| 自訂參數 | 每個 Agent 保存獨立 `extraArgs: string[]` | 參數逐項傳入，不執行 Shell 字串；後端白名單與參數值驗證不可略過 |
| 危險選項 | 每個 Agent 的 `bypassPermissions` 預設 `false`，使用者閱讀警告後明確勾選並保存 | 此同意持久保存；後續啟動不重複彈出 Session Bay 確認，但 CLI 自身登入、信任、企業政策仍可能要求操作 |
| 權限預設與覆寫 | 勾選後使用工具專屬危險預設；明確自訂的權限模式優先，不再追加衝突的預設 | Grok 自動核准不等於停用沙箱；各工具語意分別說明，不能統一宣稱完全取消隔離 |
| 啟動預覽 | `preview_launch` 使用與真正啟動相同的後端計畫，顯示 executable、argv 與 cwd | 只做預檢，不建立 PTY／程序；cwd、資料來源與 Session 身份仍由應用管理 |
| 升級 | 舊設定缺少的新欄位補上各工具預設值、空參數與未勾選危險模式 | 不暗中替既有使用者啟用免確認模式 |

危險模式允許 Agent 在較少提示下執行指令及改寫檔案；Codex 的預設也會移除其沙箱限制。只應對信任的工作內容與環境啟用，Session Bay 不提供額外的執行安全沙箱。確切旗標、白名單及恢復邊界見 [Agent 整合規格](agent-integrations.md)，本批測試與待驗收項目見 [驗證紀錄](mvp-validation.md#2026-10-15-agent-擴充與自訂參數變更紀錄)。

## 2026-10-15 專案首頁與所有目錄導覽

使用者最新澄清：預設主頁應管理已加入的專案，另保留可查看所有 Session 相關目錄的獨立頁面。本節取代先前把「所有工作階段」做成跨目錄平面 Session 清單的導覽；所有目錄分組必須保留，`curated` 持久化／遷移、原始歷史與 Runtime 生命週期不變。

| 項目 | 已決定的行為 | 邊界 |
| --- | --- | --- |
| 專案（預設首頁） | 管理使用者明確加入的目錄，總覽卡片與側欄都只列 `curated: true` | 沒有歷史的自選專案也可見；掃描不自動加入 |
| 所有目錄（獨立頁面） | 列出 `sessionCount > 0` 的所有 catalog 目錄分組，不以 curated 篩選 | 包含未加入、已加入、失效及缺 cwd 的未知分組；選目錄後才看該組歷史 |
| 兩頁總覽 | 先呈現專案／目錄卡片及對應側欄清單，再選擇一組查看 Session | 兩頁均不得以混合多目錄的平面 Session 清單取代總覽；Agent／日期／封存／子代理篩選保留；全域搜尋只由明確入口開啟，不取代預設總覽 |
| 從目錄加入專案 | 在所有目錄選擇可用工作目錄後加入專案，歷史預覽也保留加入入口 | 只改 curated，不複製 Session、不啟動程序；不存在或未知目錄保留歷史但不能直接加入 |
| 加入專案 | 加入既有目錄，可指定顯示名稱；歷史預覽也可將已發現目錄加入專案 | 以完整絕對路徑輸入；尚無原生目錄選擇器；加入不啟動程序 |
| 建立新專案 | 在已存在的父目錄下建立單一新資料夾，並加入專案 | 父目錄須為絕對路徑；名稱只允許一個路徑元件，不覆寫既有項目、不補建祖先目錄 |
| 持久化與升級 | `Project.curated` 表示側欄會員資格；舊版手動加入或釘選的目錄升級時保留為自選專案 | 自動探索的其他目錄不升格；掃描不得覆寫使用者的選擇或名稱 |
| 移出專案 | 只取消自選資格與釘選 | 不刪除歷史、資料夾、索引、工作區或 Runtime，不終止程序 |
| 已開啟工作區 | 在專案與所有目錄兩頁皆保留可到達的入口 | 未加入或已移出專案的工作區仍能切回、操作及關閉；切換頁面不停止程序 |
| 啟動與重新定位 | 保留既有原始 cwd 與 launch override 規則 | 專案選擇或更名不改寫 transcript，不改變接續時的 cwd 判斷 |
| 本次驗證環境 | 只在隔離雲端使用合成歷史與暫存路徑 | 未接觸使用者真實電腦或 Agent 歷史；本次變更驗證結果另記，不沿用前一版 CI 作為通過證據 |

本次契約新增 `add_project({path, name?})`、`create_project({parentPath, name})`，並擴充 `update_project` 的 `curated` 與 `name`，保留既有 `pinned`、`launchPath`。完整契約見 [IPC 契約](ipc-contract.md)。

同次回饋另修正普通 Shell 的正常離開行為：只有原狀態為執行中或啟動中的 Shell 收到結束碼 `0`，才自動移除面板；移除最後一個面板時一併關閉該工作區分頁。Agent、非零結束碼、未知結束碼或錯誤仍保留診斷畫面；已退出或還原占位不重複觸發自動關閉。這不改變「移出專案不關閉程序」的邊界。

## 2026-10-15 MVP 實作決策更新

使用者要求先實作 MVP，並追加 **macOS 與 Linux 皆可使用**。本分支保留原始規格與待驗收項目，不把程式碼完成視為全部 P0 已通過。

| 項目 | 本次實作決策 | 限制 |
| --- | --- | --- |
| 平台 | macOS 12+、Linux；CI 基準 Ubuntu 24.04 x64、macOS 15 ARM64／Intel | 實際通過紀錄見驗證報告；其他發行版不預先承諾 |
| 桌面／資料 | Tauri 2、Rust、rusqlite bundled SQLite、portable-pty | Core 可單獨測試，不需要 WebView |
| 前端 | React 19、TypeScript、Vite、npm、xterm.js | 宣告式 UI、成熟測試工具鏈與獨立終端實例 |
| 版本 | npm 與 Cargo lockfiles、rust-toolchain.toml | 由 lockfiles 記錄實際依賴，不追逐最新版 |
| 來源恢復 | source ID 命名空間；CODEX_HOME／CLAUDE_CONFIG_DIR 指向選中來源；來源內／跨來源同 ID 的 CLI 恢復歧義阻擋 | 不複製／改寫 transcript，不聲稱可以附接外部程序 |
| 搜尋 | SQLite FTS5 compact trigram 候選＋參數化 literal substring 精確驗證；不足 3 字元回退掃描，英文 ASCII 不分大小寫 | 無詞幹或向量語意；效能須分資料規模量測 |
| 來源更新 | 完整行 byte offset，變更檔案前綴驗證；每 10 秒 reconcile | 定期補掃是 MVP 的監控方式，未宣稱逐事件 filesystem watcher |
| Session 顯示名稱 | 優先讀取來源名稱；Codex 使用所選 root 的 session_index.jsonl，Claude 自訂名稱優先於摘要；無名稱時略過已知初始化區塊尋找工作需求 | 名稱僅用於顯示／搜尋，恢復仍使用來源身份與 Session ID；不呼叫模型產生標題 |
| 終端生命週期 | 每面板獨立 PTY；切換僅隱藏；明確關閉仍執行的程序需確認並清理自有 Unix session 程序群；普通 Shell 正常退出按上方新增規則關閉面板 | Agent／異常退出保留診斷；刻意 setsid 脫離 session 的 daemon 不屬於可驗證的清理範圍 |
| 串流／安全 | raw bytes、有序序號、xterm callback ACK、有界輸出；OSC52 封鎖 | 慢消費超時會明確停止，不能無限緩衝 |
| 發行 | 先交付原始碼與未簽章開發建置；CI workflow 不自動公開 release | 簽章、公證、自動更新、授權／品牌決策仍獨立處理 |

操作、安裝與支援邊界見[開發與試用](development.md)，可重複驗證見[MVP 驗收紀錄](mvp-validation.md)。

## 已確定方向

| 項目 | 決定 | 依據 |
| --- | --- | --- |
| 產品名稱 | Session Bay | 使用者明確指定 |
| 產品方向 | Agent 優先，能整合本機 AI coding 工具的開發工作環境 | 使用者需求與後續功能討論 |
| 歷史管理 | 所有目錄保留不同工具的全部 Session 相關目錄分組，選目錄後查看歷史 | 使用者 2026-10-15 最新澄清 |
| 專案導覽 | 專案為預設首頁，只管理明確加入的目錄；所有目錄為另一頁，兩頁皆有分組總覽 | 使用者 2026-10-15 最新澄清 |
| Agent 擴充與參數 | 加入 Grok Build、Antigravity CLI；每工具自訂參數與持久危險模式 opt-in | 使用者 2026-10-15 追加需求，詳見上方能力與風險邊界 |
| 普通 Terminal | 可以開獨立分頁使用普通 Shell | 使用者明確確認需求 |
| 同畫面並行 | 能同時看到至少兩個正在執行的 Terminal | 使用者明確確認需求 |
| 客製化與完整度 | 介面容易客製化，朝功能完整的終端工作環境發展 | 初始需求 |
| 效能 | 選型需考慮資源消耗與互動效能 | 使用者明確提出 |
| Agent 用量 | 增加各 AI Agent 的用量瀏覽，參考 OpenUsage 類工具 | 使用者明確提出 |
| 用量分析維度 | 希望依 Project、AI Agent、Session 瀏覽；可用精度需以來源能力確認 | 使用者提出，細部分攤以可行性為條件 |
| 用量功能交付順序 | 整組用量功能放在 MVP 之後，列為 P1 | 使用者明確選擇 |
| 文件位置 | 本機 ~/Github/SessionBay | 使用者明確指定 |

## 建議方案

| 編號 | 方案 | 原因與取捨 |
| --- | --- | --- |
| D01 | 專案首頁管理自選目錄，所有目錄另頁保留完整歷史分組；Agent 是工作區內的工具 | 兩頁皆先顯示分組總覽，選組後進歷史，不回到混合 Session 平面清單 |
| D02 | Tauri 2＋Rust 後端 | 適合本機索引與程序管理；WebView 差異需驗證 |
| D03 | xterm.js＋跨平台 PTY | 沿用成熟終端核心，保留介面客製化 |
| D04 | Codex CLI、Claude Code CLI，依上方追加 Grok Build 與 Antigravity CLI | 啟動、歷史與恢復能力分開聲明，不承諾所有工具有相同 adapter 能力 |
| D05 | SQLite metadata 與全文索引 | 本機可重建、分頁與查詢容易控制 |
| D06 | 原始歷史唯讀 | 降低格式變動與來源損壞風險 |
| D07 | 首版完成搜尋、預覽、接續與雙面板 | 以完整工作流程驗證價值 |
| D08 | 首版關閉面板結束程序，切換分頁保留程序 | 先定義清楚生命週期，daemon 另行設計 |
| D09 | 設定與布局宣告式建模 | 易於客製化、驗證、保存與還原 |
| D10 | 用量分成帳號額度快照與可歸屬的用量事件 | 百分比、token、費用具有不同語意與聚合規則 |
| D11 | 用量以本機紀錄及受支援介面收集，按維度下鑽 | 沿用既有 Project／Session，缺少可靠身份時保留未歸屬 |

這些項目作為後續開發的提案基線，不等同使用者已逐項批准，也不表示已完成效能驗證。

## 待決策事項

下表保留原始提案；平台、框架、技術、來源恢復及 tokenizer 的本次選擇已由上方更新取代，CLI 版本與原生驗收仍待完成。

| 問題 | 目前選項或建議 | 最晚確認時點 |
| --- | --- | --- |
| 第一個平台 | 建議 macOS 原型；Windows、Linux 支援另排驗證 | 階段 0 開始前 |
| 前端框架 | TypeScript；Angular、React、Vue 或其他熟悉框架擇一 | 建立應用骨架前 |
| 正式技術選型 | Tauri 方案優先，保留原型失敗時調整空間 | 階段 0 結束 |
| 支援 CLI 版本 | 設定最低支援版本與 fixture 範圍 | adapter 實作前 |
| 多來源 resume | 使用正式可選來源能力或報告歧義 | 階段 2 前 |
| 搜尋 tokenizer | 中文短詞、識別字與 substring 策略實測後決定 | 階段 1 |
| 客製化深度 | 首版設定與主題；任意 CSS、外掛後續評估 | 階段 3 前 |
| 程序持續執行 | 是否需要退出應用後繼續執行 | P2 規劃前 |
| 摘要模型 | 本機或外部服務、費用與內容範圍 | P1 摘要實作前 |
| 發行方式 | 安裝包、簽章、自動更新與平台矩陣 | 公開試用前 |
| 授權與商業模式 | 尚未選擇開源授權或付費模式 | 對外公開前 |
| 品牌權利 | 名稱初篩不等於商標與網域可用 | 公開品牌與取得網域前 |
| 用量來源 | 評估官方介面、本機紀錄、選用本機 OTel，以及 OpenUsage 的本機輸出；不預設依賴 OpenUsage | P1 用量 adapter 實作前 |
| 用量憑證與帳號 | 確認支援的帳號／工作區、授權方式與唯讀取得能力；不改寫原工具登入資料 | P1 額度查詢實作前 |
| 用量可歸屬範圍 | 逐工具確認事件 ID、Session、cwd、帳號、時間與模型欄位；不足時不強行分攤 | P1 用量分析實作前 |
| 費用與用量保留 | 確認價格來源／生效版本、幣別、刷新與保留期間；訂閱費不自動分攤 | P1 用量分析實作前 |

## 容易混淆的邊界

- 偵測可執行檔，不等於讀得到歷史。
- 歷史 Session，不等於正在執行的 Runtime。
- 自動發現的目錄分組，不等於使用者已加入的側欄專案。
- 移出專案，不等於刪除資料或關閉已開啟的工作區。
- 程序停止，不等於任務完成。
- 還原布局，不等於保留或恢復活的程序。
- 恢復原 Agent，不等於完整轉移到另一個 Agent。
- 支援 CLI，不等於支援同品牌所有桌面、IDE 與雲端歷史。
- 發行體積較小，不等於所有場景的 CPU、記憶體與延遲都更低。
- 帳號額度窗口的「Session」，不等於歷史對話 Session；介面使用「短期額度」等明確名稱。
- token、帳號額度百分比、估算費用與實際帳單是不同指標；共享額度不按專案猜測拆分。
- Agent 工具、模型供應商與登入帳號是不同維度；目前登入帳號不代表歷史事件的帳號。

## 文件維護

需求改變時先更新決策狀態，再更新產品規格、架構與路線圖。功能驗收以 product-spec 為準；架構細節以 architecture 與 agent-integrations 為準。里程碑完成後加入實測結果與日期，不把規劃目標改寫成既成事實。

## 2026-10-15 試用後續需求

使用者要求先記錄為未來待辦，尚未安排本輪實作或完成驗收。共 17 項，見 [後續待辦](future-backlog.md)，涵蓋操作客製化、Agent 狀態、中文輸入、換行、持續工作狀態、索引效能、ADE 研究、OpenCode、工作區檔案瀏覽、UI／Terminal 獨立主題、不綁定 Project 的臨時 Terminal 、遠端機器管理及獨立 Web 客戶端。

其中退出應用後保留 Shell／Agent 工作狀態，是對首版「只還原布局占位」的後續需求；需另行設計程序持續與重新附接，不能將首版布局還原視為已滿足。第 09 項持續執行與重新附接已確定為下一階段最高優先；架構、工期與其餘項目的順序仍待規劃。此紀錄不授權合併開發分支或公開發布。


## 2026-10-15 最終介面改版與下一階段優先順序

- 使用者要求以 UI/UX Pro Max 指南重新設計現有功能，作為同一 PR 的最終版本；[介面設計系統](ui-design-system.md)記錄選擇、流程、主題與驗證方式。這不擴大為 13 項後續功能的實作。
- 使用者明確要求逐項勾選已完成的任務。清單改為依程式碼、自動化及實機證據審核；只有實作、仍缺指定人工／原工具驗證的項目保持未完成並記錄缺口，不整批勾選。
- **下一階段最高優先：介面退出後持續執行與重新附接**。關閉／退出 UI 後，已開啟的 Shell／Agent 繼續運行，回到 UI 可看到每個工作的真實狀態與累積輸出。使用者理解 OS 重新開機後程序不能繼續；此情況顯示中斷，不假裝存活。
- 此輪 PR 仍只恢復布局占位。背景程序架構（獨立 daemon、tmux 或其他方案）、本機 IPC 邊界、輸出保存與資源策略於下一階段評估；當時決定不啟動實作、不合併 PR 或公開發布。後續使用者驗收與合併授權見本文件最新紀錄，持續 Runtime 仍未實作。

上方「程序持續執行是否需要」與「所有試用回饋尚無優先順序」的歷史提案，由此決定取代；其他 12 項待辦仍未排定。

## 2026-10-15 最終驗證追加：IME、工作分頁與來源偵測

使用者在最終設計驗證期間明確追加以下同 PR 範圍，取代先前將全部 IME 修正留待後續的限制：

- macOS 中文組字途中 Caps Lock 的特定重複輸入路徑：已在鎖定的 xterm 5.5.0 原始 CompositionHelper 合成重現提前送出與 compositionend 再送出。僅透過公開 custom key handler 略過語意 CapsLock 的 xterm keydown 處理；不取消 OS 原生事件、不以文字去重。實機 macOS IME 驗收仍待進行，其他 IME／Shift+Enter 問題仍保留後續待辦。
- 目前目錄的工作分頁採 Chrome 式保留快捷鍵。macOS 主顯示 ⌘⇧[／⌘⇧]，亦支援 ⌘⌥←／→；兩平台 Ctrl+Tab／Ctrl+Shift+Tab，macOS ⌘1–8／⌘9 最後，Linux Ctrl+1–8／Ctrl+9 最後。只在有可定位工作分頁時於 capture 階段處理，組字與模態對話框不攔截，不傳送已處理的按鍵至 PTY。舊版下一面板預設 Mod+Shift+] 改為 Mod+Alt+ArrowDown，其他自訂值保留。
- 共用 registry 的「偵測歷史來源」只讀取該工具已知環境變數與 home 下的官方資料根目錄；可讀、缺少、權限不足與其他錯誤分開。Grok 的資料根與 sessions 子目錄分開檢查；找到來源僅產生候選，明確加入草稿並儲存後才生效，不覆寫自訂來源、不啟動工具、不遞迴尋找。Antigravity 未有已驗證 parser，偵測／加入入口維持不可用並解釋限制。
- 麵包屑按路由語意組成：首頁只有「Session Bay > 專案」，進入目錄後才加實際名稱；真實目錄名與分類相同仍保留，不做字串去重。所有目錄與全域搜尋亦有對應語意和導覽測試。
- 本輪 Linux 原生 smoke 實際捕捉 WebKit `navigator.language=C` 導致日曆例外。日期元件逐一驗證 BCP 47 偏好，略過無效 POSIX locale，最後使用介面語言 zh-TW；不改系統 locale 或測試繞過問題。

以上新增程式需以新 exact-SHA 三平台 CI 與原生畫面驗證，不沿用先前 bcd3bcc 的結果。

## 2026-10-15 未來主題組合紀錄

使用者新增未來需求：應用 UI 的 dark／light 各 10 種主題；Terminal 另有 dark／light 各 10 種，可獨立搭配。列入後續待辦第 14 項，維持未實作；不擴大本 PR 的功能，持續 Runtime 仍為下一階段最高優先。

同項追加：主畫面可快速切換；設定內立即預覽但儲存才持久化，取消還原進設定前的 UI／Terminal 主題。仍為未來功能紀錄。

## 2026-10-15 臨時 Terminal 需求紀錄

使用者新增未來需求：可隨時從全域入口開啟臨時 Terminal，cwd 預設為使用者家目錄，不需進入或加入任何 Project，也不自動建立 Project。列入後續待辦第 15 項，維持待規劃與實作；不擴大本輪實作或持續 Runtime 範圍，第 09 項持續執行與重新附接仍為下一階段最高優先。

## 2026-10-15 遠端機器需求紀錄

使用者新增未來需求：將其他遠端機器納入管理與控制對象，可查看其 Agents／Sessions 的歷史、狀態、輸出，並連回遠端工作進行操作。列入後續待辦第 16 項，維持待規劃與實作；需清楚區分本機／遠端及機器身分，避免誤操作。

連線方式、協定、身分驗證、權限與憑證安全尚待設計，未承諾特定方案；本次只記錄，不連線機器、不建立權限或持久憑證，也不擴大本輪實作。第 09 項持續執行與重新附接仍為下一階段最高優先。

## 2026-10-15 Web 客戶端需求紀錄

使用者明確要求將 Web 版加入未來需求規劃：提供獨立 browser client，可由一般瀏覽器查看與操作 Agents／Sessions，不以 Tauri 桌面內的 WebView 代替此需求。列入後續待辦第 17 項，維持待規劃與實作。

認證與授權、遠端機器及背景 Runtime 整合、斷線重連與重新附接需另行設計；尚未選定架構、協定或部署方式。本輪不實作或部署 Web 服務，也不建立存取權限或持久憑證。第 09 項持續執行與重新附接仍為下一階段最高優先。

## 2026-10-15 Antigravity CLI 歷史明確納入本輪

使用者要求 Antigravity 歷史在 PR #1 處理，並確認版本 1.3.5 是 CLI；本決定取代先前只支援新工作／手動 ID、歷史 unsupported 的範圍。App／IDE 與 App 匯入不在本次必要範圍。

採持久化 step 與 metadata 防禦 reader，來源／schema 證據與未完成的 1.3.5 實機驗收見 [Antigravity CLI 歷史](antigravity-cli-history.md)。備份只預覽；原生 CLI root 的索引接續仍需身份與 cwd 預檢。SQLite 僅讀應用私密暫存副本，不觸碰原始資料 sidecars。未知格式要顯示原因，不以空清單冒充成功。

新增的主題、臨時 Terminal、遠端管理與 Web 客戶端仍是未來待辦，合計 17 項；第 09 項持續 Runtime／重新附接維持下一階段最高優先。

## 2026-10-15 CI 省額度模式

使用者在 GitHub Annotations 確認帳務／支出限制後，同意本 PR 改為日常 Linux 輕量檢查，完整 macOS ARM64／Intel 與 Linux 打包、原生 smoke 改為手動驗收。本決定取代先前每次 PR 更新自動跑三平台的策略；當時未授權變更帳務、提高上限、合併或代為手動觸發。後續合併授權見下節，帳務與手動觸發限制不變。

- 自動 `light-checks.yml` 僅監聽本 repo 的 branch push，不另監聽 pull_request，避免同一提交重複執行；同 branch 新程式提交取消舊自動 run。
- 僅忽略根目錄 README.md 與 docs/ 直屬 Markdown。push 的兩點 diff 可在排程前略過一般純文件更新；程式、fixtures、scripts、skills、設定與 workflow 變更仍檢查。GitHub 大型 diff／逾時等例外不能承諾永遠零 run。
- Linux 輕量包含前端品質與 build、靜態視覺資產驗證、Rust fmt／無 desktop features 的核心 tests／Clippy；不安裝 GUI 套件、不 release 打包、不跑原生 smoke。
- 原 `ci.yml` 保留完整三平台流程，只接受 workflow_dispatch；不設會被日常 push 或另一個 pending run 取代的共用 concurrency group。
- push 檢查的是 branch head，不是 GitHub 合成的 PR merge commit；fork PR、只有 base branch 更新的相容性不由此自動覆蓋。被略過／尚未手動跑的驗收不是 passed，required-check 設定未改。
- 手動 workflow 的 UI 入口依 GitHub default-branch 規則；當時 main 尚無 workflow，不保證未合併 PR 可以派送。保留配置不等於已執行；後續使用者可另行授權合併，但不能只為了讓按鈕出現自行合併或觸發。操作與來源見 [開發與試用](development.md#ci-省額度模式)。

## 2026-10-15 使用者驗收與合併決定

使用者明確表示「ok, 驗收完成, 確保 PR 標題內容描述等都正確後就可以 merge 了」，並補充「噢，還要把完成的都勾起來」。本次接受已交付 PR 的功能與介面，授權校正描述、勾選實際完成項目後合併；不新增功能或將未完成的規劃改為完成。

已實作並有本機回歸的 UI／UX、工作分頁快捷鍵、來源候選偵測與 breadcrumb，依這次使用者驗收更新 ADD-13／17／18／20。完整三平台 CI、精確 macOS 圖示／IME 情境及 Antigravity CLI 1.3.5 磁碟樣本／互動接續沒有新增逐項證據，仍未勾選；原始任務完整條件與 17 項未來待辦不因合併自動完成。退出 UI 後持續執行／重新附接仍是下一階段最高優先。

## 2026-10-16 原生三平台與獨立 PR

使用者要求兩個獨立 PR：本 PR 處理 Windows／macOS／Linux 原生可用性；目錄選擇 dialog 另開 PR，不互相依賴，也不擴大為 17 項未來需求。

- 保留 Tauri 2、React、xterm.js、SQLite、唯讀歷史與現有 UI／索引架構；Windows 使用 portable-pty 的原生 ConPTY，Unix 的 session／process-group 清理保持原有安全邊界。
- Windows 最低目標為 Windows 10 1809（ConPTY）及 WebView2；本次驗收流程以 Windows x64 為主。macOS ARM64／Intel、Linux x64 仍各自驗收，跨編譯不等於原生通過。
- Windows 啟動不把不可信 cwd、Session ID 或參數拼成 Shell 字串。優先原生 `.exe`；僅有 `.cmd`／`.bat` 的安裝需提供明確診斷與原生安裝指引，不將檔案存在冒充可啟動。
- 歷史來源維持唯讀；Windows 使用檔案 handle 身分與 reparse-point 檢查，不能因移除 Unix 編譯限制而弱化來源替換／連結防護。
- 延續省額度模式：自動檢查仍只有 Linux 輕量流程，完整驗收仍是手動 workflow；本次只增加 Windows 原生驗收定義，不代為觸發、不調整帳務或停用 checks。
- 新 PR 維持 Draft，沒有合併、部署或發行授權；所有測試結果以此 PR 的實際執行證據記錄，缺少原生 Windows／macOS 證據時明確保留待驗。

- 2026-10-16 CI follow-up：JavaScript actions 與專案 Node 分開版本化。官方 Node 20 action runtime 移除後，兩份 workflows 改用 Node 24 的 checkout 7.0.1／setup-node 7.1.0／upload-artifact 7.0.2 完整 SHA。三 OS 完整 gate 需要同提交四個 jobs 成功；Linux lightweight 綠燈不替代平台驗收，不增加自動 matrix。

## 2026-10-16 關閉介面後繼續執行與重新附接

使用者將「關掉介面可以接回來、回來看每個已開狀態」列為最高優先，要求獨立 PR。這個決定取代先前「關閉程式停止所有 PTY、重開只還原 placeholder」的 MVP 行為；不是把舊 PID 存下來或重新執行相同指令。

- 以同一個已安裝執行檔的 headless broker 模式持有 Shell／Agent 的 PTY。桌面 UI 關閉、WebView 重載或渲染 channel 消失只取消 UI attachment；明確「停止」／「關閉面板」才停止受管程序。
- macOS／Linux 使用 owner-only Unix socket，Windows 使用拒絕遠端連入、限定目前使用者 SID 的 named pipe；不開 TCP listener、不建立登入啟動服務、不產生或保存憑證。單一 broker 以 OS 檔案鎖協調，不用 PID 存活猜測身分。
- Broker 在記憶體消費 PTY 輸出，保留有上限的 VT 畫面、200 行回捲與 replay；UI ACK 僅影響該 attachment，不能停止背景工作。每次附接用不同 lease，舊 ACK／detach 不能影響新視圖。
- 重開以 broker 的 runtime／pane／project metadata 為權威，保存的 layout 仍不接受 Runtime ID、PID、指令或 auto-start token。遺失 layout 的活躍面板會重建，不會悄悄藏起來。
- 程序已退出時保留最後畫面與 exit code。Broker 或作業系統重啟後，上次執行中的 metadata 改為 `interrupted`；不冒稱仍在執行、不採用舊 PID、不自動重啟 Shell／Agent。終端輸出不落盤，broker 重啟後無法還原舊畫面。
- 先疊在三平台 PR #3 的分支上，以避免複製或繞過 ConPTY／Unix 所有權實作。仍為獨立 Draft PR；完整 OS／WebView／實際 Agent 互動驗收未通過前不得宣告完成或 ready。

- 2026-10-16 macOS 啟動修正：interprocess 2.4.5 的 listener `.mode(0600)` 在 Darwin 回傳 `Unsupported`。macOS 改在已驗證的 0700 socket 目錄內 bind，再設定 socket 路徑為 0600；保留 peer UID 驗證與 broker 所有權鎖。Linux 維持 bind 前設定權限，Windows ACL 不變。

## 2026-10-16：全域臨時 Terminal（獨立日常體驗 PR）

- 使用者要求隨時開啟臨時 Terminal，預設家目錄，不必進入或新增任何專案。
- 採真正 `projectId: null` 的工作區分頁／面板；全域分頁另存 active selection，不把家目錄建立為 catalog project，也不建立 workspace-only 假專案。
- 啟動沿用設定中的預設 Shell Profile；只有 shell、無 project/session/resume 且未指定 cwd 時，由 Rust 取得並驗證本機家目錄。前端不推測 HOME／USERPROFILE，不傳入命令字串或任意環境變數。
- UI 關閉／重開沿用 persistent runtime broker 的 detach／attach；明確關閉面板仍只停止該面板的受管程序。此 PR 疊在 persistent runtime PR #7（其依賴平台 PR #3），不重複實作 broker。
- 範圍不含檔案瀏覽、遠端主機或 Web Terminal。原生跨平台驗證與 screenshot 限制需如實記錄。
- 相容既有無 project、但指定 cwd 的 Shell：broker 另存 `homeDirectory` 啟動語意，舊 metadata 缺欄位視為 false。只有新 home Terminal 重啟時省略 cwd；既有無專案 Shell 保留 broker 確認的 cwd，不將 null 身分誤當家目錄策略。

## 2026-10-16 OpenCode 獨立整合

使用者要求 OpenCode 與持續 Runtime、主題預覽、日常體驗、索引效能各自交付 PR。本 PR 僅新增第五個內建 provider，依賴原生三平台 PR #3 的執行檔解析與 Windows 安全唯讀 file handle；以該 branch 為 base，不重複修改 workflows。須先合併平台 PR，再重新指定 OpenCode 的 base 並驗證；本次不授權自動合併或發行。

- 依官方 v1.19.2 固定原始碼定義 SQLite v1 message/part 與 v2 session_message reader。fixtures 明示為合成的最小 schema，不冒充實際 CLI 磁碟擷取。
- source root 是含 opencode.db 的目錄；預設使用 XDG_DATA_HOME/opencode，未設定或無效時為 home/.local/share/opencode。Windows 也遵循 OpenCode 的 xdg-basedir 實作。
- 設定固定顯示 OpenCode 來源卡片、下拉選項與 O monogram；舊設定只補執行檔／空選項，不自動新增或改動已保存來源。
- source SQLite 永遠不直接交給 SQLite library。只複製受限 DB/WAL，檢查身分、大小、內容雜湊、WAL checksum 與完整性；在私人 copy 執行查詢。無 migration、登入或 auth.json 讀取。
- 新工作無額外權限旗標；接續精確使用 --session 與單獨 ID，使用 OPENCODE_DB 指向選定的資料庫。只有明確高風險選項啟用才加入官方 --auto，不覆寫 HOME、XDG 設定或憑證。
- 舊 JSON 儲存、任意名稱／channel DB、多數位於外部的遠端 server，以及未知未來版本不推測相容性。詳見 [OpenCode 整合與驗證](opencode-integration.md)。

## 2026-10-16 索引效能量測與低風險熱路徑改善

使用者要求索引速度獨立 PR。先以合成 1,000／10,000 Session 與多訊息長對話，分測空索引、未變更補掃、單檔追加、同大小重寫、搜尋 p95 與程序記憶體；不用真實私人歷史。量測為 backend release，來源剛生成，因此不宣稱冷磁碟／WebView／實機結果。

初步診斷找到 Codex canonical／fallback 重複訊息的 correlated SQL 平方掃描。改善採操作本機的 SQLite TEMP digest lookup，hash 只縮小候選，仍核對原文字與角色，不以 hash 相同直接隱藏訊息。連線要求 FILE 暫存與約 2 MiB page-cache 目標，並非全程序記憶體硬上限；不把整份對話保留在 Rust HashMap，也不新增持久 schema。另重用 message INSERT 與 checkpoint 查詢的 prepared statements。

原來源唯讀、來源與檔案身份、prefix hash、寫入前後校驗、重寫／compaction、取消與交易 rollback、stale／snapshot generation 均維持。同一 harness／環境的 before／after、全部核心回歸與未達標的高命中率搜尋見[索引效能量測](index-performance.md)；合成改善不等於使用者真實來源或全部效能驗收完成。
## 2026-10-16 獨立主題與即時預覽

- 本次獨立功能 PR 實作 UI 深／淺色各 10 種，Terminal 深／淺色各 10 種；兩者獨立選擇。既有 Bay／Classic 終端色票保留，不強制轉換。
- 設定內的外觀變更立即套用到整個工作台與所有開啟的 Terminal；只有儲存成功才持久化。取消、關閉、Escape 後確認捨棄、瀏覽器上一頁或元件卸載會移除預覽。儲存中暫停編輯與取消，避免已送出的寫入與回復互相競爭；儲存失敗保留預覽與草稿並顯示錯誤。
- 工具列的快速主題選單每次選擇立即預覽並儲存，關閉不回復；寫入失敗回到已儲存外觀並提示。寫入中禁止重複變更；設定視窗開啟時不開放快速切換，避免兩個編輯來源互相覆寫。
- 設定預覽只覆蓋外觀欄位，不改啟動命令／來源／工作區。若開啟期間收到外部已儲存設定，採用最新設定作為新基準，捨棄舊草稿，取消不回寫過期快照。
- 保留 settings version 1，新增可省略且有預設值的 themePalette；未知但格式合法的主題 ID 保留原值、顯示安全 fallback，不因新增主題導致整份設定回到預設。任意 CSS 或自訂色票編輯器不在本次範圍。
- Terminal 只更新 xterm options，不重建 xterm、不重新啟動 PTY、不重設畫面；純換色不做 fit／resize 或搶焦點。自動化與原生桌面視覺驗收分開記錄。

- 純外觀寫入可在索引期間完成；後端比對所有非外觀欄位，只有 theme／themePalette／terminalTheme／fontFamily／fontSize 可略過掃描鎖。其餘設定仍遵守原限制；寫入失敗不更新記憶體中的已儲存設定。

## 2026-10-16 日常體驗：Terminal 字級快捷鍵

此節為原始方案，已由下節「全工作台縮放取代僅 Terminal 快捷鍵」的使用者追加需求取代。

使用者授權日常體驗分成小型 PR。本組對應待辦 01，只調整全域 Terminal 字級，所有面板共用；不改介面文字或瀏覽器縮放，也不新增逐面板字級 schema。

- 以主題 PR 的 Appearance 預覽與設定保存機制為基礎，Cmd（macOS）／Ctrl（Linux）加 `=` 或 `+` 放大、`-` 縮小、`0` 還原設定預設 14 px。範圍沿用 9–32 px，每次 1 px。
- 工作區開啟時接受快捷鍵；一般輸入欄位、對話框與 IME 組字期間不處理。保留組合於 capture 階段攔截，避免送入 xterm／PTY；其餘按鍵維持原樣。
- 快捷鍵即時預覽並自動保存；快速連按合併等待中的最新值，寫入依序進行，不讓舊結果覆蓋新的預覽。失敗還原至上次確認保存值，顯示錯誤並允許重試。設定內字級編輯仍遵守預覽、儲存保留、取消捨棄還原。
- 更新既有 xterm options 與 fit／resize，不重建終端、不修改 runtime／PTY 生命週期。持續 Runtime PR 仍最高優先；原生驗收及與 Windows 設定驗證修正的整合回歸另行執行。
- Shift＋Enter 不併入本組；各工具及模式對 LF、Ctrl＋J、modified Enter 的語意不同，未確認時不能保證只換行而不送出。另立協定／模式驗收範圍，不直接對所有 PTY 送 LF。
## 2026-10-16 日常體驗：工作區整理獨立 PR

使用者授權日常體驗按規模拆成獨立 PR。本次涵蓋後續待辦第 02–05 項：分頁、面板及專案顯示名稱，以及同一專案內的分頁排序。第 09 項持續執行與重新附接仍最高優先；字型快捷鍵、Shift＋Enter、臨時 Terminal、OpenCode、主題及索引改善不併入本 PR。

- 名稱去除首尾空白，限 1–200 個 Unicode 字元、不可含控制字元；允許重複顯示名稱，保留路徑／位置作辨識。取消不寫入，儲存失敗保留草稿並可重試。
- 只改顯示資料，不修改資料夾、cwd、Project／Tab／Pane／Runtime ID、Session 關聯、程序或輸出。專案使用既有 name 更新 API；分頁與面板名稱沿用現有 workspace schema 保存。
- 拖曳只在 drop 時提交，同一專案內重排；Escape／拖曳取消不變更。聚焦分頁後以 Alt＋左右方向鍵提供鍵盤替代，順序直接影響既有數字分頁快捷鍵。
- 持續 Runtime PR 優先；若其先合併，此 PR 須 rebase 並重跑生命週期／保存驗證，不以自動合併代替整合檢查。原生 macOS／Linux 拖曳、焦點、視覺與重開驗收仍待執行，不能標成完成。

詳細驗收與範圍見 [工作區整理](workspace-organization.md)。

## 2026-10-16 工作區整理複查：對話框焦點與組字保護

重新命名對話框開啟期間，Terminal 延後執行的 focus 必須在實際回呼時檢查阻擋式對話框及焦點是否已轉移；仍保留正常工作區重新顯示的 Terminal focus 與尺寸重算，不改 PTY 生命週期或輸入協定。共用 Dialog 在子元素自動聚焦前記住 opener，關閉後只恢復仍存在、且不在即將移除對話框內的元素；名稱入口明確聚焦以涵蓋不會自動聚焦按鈕的瀏覽器。

Escape 在 IME 組字期間（包含 composition event、isComposing 與 keyCode 229 路徑）不取消草稿；組字結束後仍可正常取消，Tab／Shift＋Tab 維持原焦點循環。新增真實 DOM 輸入焦點及可取消 rAF 回歸，涵蓋未聚焦面板開啟重新命名、starting 轉 running、對話框關閉後的延遲 focus、鍵盤關閉與焦點返回。原生 WebView／實際 IME 驗收仍待執行。

## 2026-10-16 Shift＋Enter：回到 Terminal 原位輸入

使用者最新要求取代先前草稿視窗方案：Shift＋Enter 必須留在 Terminal，不開啟 modal。這不是 Tauri 的限制；目前 xterm 5.5 將 Enter 與 Shift＋Enter 都編碼為 CR，部分 CLI 因此無法區分。

- 只對已查核 decoder 的啟動工具預設送出 CSI-u `ESC [ 13 ; 2 u`，表示 Shift＋Enter；不送 LF／CR，不附加 Enter。Codex、Claude Code、OpenCode 的相容模式由共用 provider registry 宣告；Codex Windows 的 Console InputRecord 路徑尚未驗證，維持原生預設。這是一個按鍵的相容映射，不宣稱支援完整 Kitty 協定。
- Shell、Grok 與 Antigravity 未啟用預設映射。Shell 裡自行啟動 Agent 時可在該面板選擇 CSI-u；回到 Shell 時切回原生。預設只依啟動來源，不能代表實際前景程序或應用程式模式，不能保證任意應用程式都把此鍵解讀成換行。
- 模式顯示於面板，手動選擇只作用於目前 runtime，重新啟動後回到預設，同一 runtime 重新連線則保留。未知工具保留原生。沒有 output heuristics、磁碟設定、自動 CLI 啟動、全域 LF 或鍵盤協定宣告。
- 經既有 xterm input／有界輸入佇列傳遞；連線、快照、退出、焦點與對話框守衛仍適用。IME 組字及其他修飾鍵不攔截，CapsLock 修正保留。測試與原生 WebView／實際 CLI 驗收分開記錄。

- 獨立複查補上鍵盤焦點接管：只有 xterm textarea 真正取得焦點時同步 active pane，避免 Tab 進入非作用中面板後 Shift＋Enter 被安全守衛吞掉。搜尋、模式選單與 modal 輸入不接管 Terminal 焦點；對話框與隱藏面板守衛保留。


## 2026-10-16 修訂後的批次整合契約

- 保留各功能的獨立 PR 與歷史驗證紀錄；來源涵蓋五個 provider、唯讀索引、原生資料夾選擇器、背景 broker、null 專案臨時 Terminal、名稱與分頁順序。整合不改來源身份、Runtime 身份或啟動 token。
- Shift＋Enter 採原位按鍵相容方案，取代先前多行草稿視窗提案；支援工具使用明確的 CSI-u 編碼，其他工具及 Windows Codex 保留原生，面板可手動選模式。不能將 decoder 證據當作所有 CLI／平台都已驗收。
- 外觀新增 Code Modern／Code 2026 色票及命令面板主題選擇；整個工作台縮放與 Terminal 字型大小分開。主題預覽只擁有色彩欄位，取消不得回復較舊的 zoom 或 font；保存與原生縮放必須序列化並區分成功／失敗。
- 本段記錄整合要求，不宣稱修訂後最終樹已通過本機、Linux CI 或原生矩陣。現況文件與較早 checkpoint 分開，尚未驗證的 GUI／IME／真實 CLI 不因合併程式碼而勾選。


## 2026-10-16 全工作台縮放取代僅 Terminal 快捷鍵

使用者追加 Terminal 與介面一起放大縮小。原 PR 的 Cmd／Ctrl 加減與 0 改為整個原生 WebView 的頁面縮放；獨立 appZoom 設定預設 100%，範圍 50–200%，每次 10 個百分點，0 回到 100%。Terminal fontSize 仍是獨立基準字級，不額外乘上縮放比例。

沿用外觀的即時預覽／儲存／取消還原，縮放與主題共用序列化設定寫入；原生縮放套用失敗不得宣稱已保存。明確停用 WebView 內建 zoom hotkeys，只准 main window 使用 set-webview-zoom，避免第二個未保存的縮放來源。IME／一般輸入欄位與對話框內仍不處理快捷鍵，設定用百分比欄位操作。窄視窗允許捲動，避免放大後控制項無法到達。原生 WebView／實際鍵盤及 resize 仍需三平台驗收。

## 2026-10-16 命令選色器與工作台縮放整合

命令選色器、快速主題與縮放快捷鍵共用序列化外觀寫入佇列，合併等待中的窄欄位 patch；相同欄位採最後一次要求。每次呼叫取得自己的 Promise<boolean>，只有所要求的欄位確實保存才回傳 true，被後續同欄位要求取代回傳 false，寫入失敗會通知所有受影響呼叫。只有擁有 appZoom 的批次可要求原生縮放，命令主題預覽不擷取字型／縮放快照。設定完整編輯入口在寫入期間保持停用；命令選色器保留自己的取消、重試與世代檢查。


## 2026-10-17 Shift＋Enter：統一 CSI-u，移除模式介面

使用者明確要求 Shift＋Enter 預設使用 CSI-u（Agent 相容），不再特別顯示。此決策取代前述依 provider／平台選擇原生或 CSI-u，以及面板手動模式的設計。

- 所有 Terminal 面板一律將非組字中的 Shift＋Enter 編碼為 `ESC [ 13 ; 2 u`，包含 Shell、未知工具與 Windows Codex；不依啟動來源、作業系統或前景輸出猜測。
- 刪除面板的模式選單、按鍵說明、逐 runtime 覆寫狀態，以及只供舊預設使用的 provider keyboard metadata。沒有新增磁碟設定或模式保存，也不更動其他 provider 能力。
- 保留一般 Enter、其他修飾鍵、IME／CapsLock、keydown 單次傳送、焦點／modal／runtime／snapshot 守衛與既有有界輸入佇列；不追加 CR／LF，不回到 modal。
- 統一編碼是操作偏好，不是所有程式皆已支援的宣告。未支援的 Shell／CLI 可能忽略或顯示編碼，應用程式模式仍可能將 modified Enter 解讀為送出。Windows Console InputRecord、Grok 多行模式及其他尚未完成的原生驗收限制保留於文件。

## 2026-10-17：恢復普通 Shell 正常退出自動關閉

覆蓋持續 Runtime 決策中「所有已退出程序保留面板」的部分：只有 broker 已確認普通 Shell 以結束碼 0 退出，才忘記該 runtime 並移除面板；最後一個面板移除時關閉分頁。專案與全域臨時 Terminal 一致，背景分頁也適用。重新附接時已正常退出的 Shell 同樣清理；只有已儲存布局、沒有有效 runtime 的 placeholder 不清理。

Agent、非零／未知結束碼、失敗、斷線與 interrupted 保留。自動清理不發送 stop、不以 pane ID 批次處理其他 runtime；延遲清理回覆不能移除已重啟或替換的面板。Broker 清理失敗時保留面板並顯示錯誤，可由使用者明確關閉。

## 2026-10-17：macOS Cmd+W 只關閉目前工作分頁

Cmd+W 及 File → Close Tab 只處理目前顯示的工作區分頁，包含分割面板；執行中、啟動中或斷線的程序沿用一次關閉確認。其他專案／臨時分頁不受影響，最後一頁關閉仍保留視窗。歷史頁、無分頁、對話框及 IME 組字不觸發關閉；DOM keydown 自動重複忽略，原生與 DOM 重複請求在關閉處理中共用鎖。

macOS 明確提供標準應用程式／編輯／檢視／視窗選單，以 Close Tab 取代原生 CloseWindow 的 Cmd+W accelerator；Cmd+Q 與視窗紅色關閉鈕仍走既有離開流程。UI capture-phase 攔截同一組合鍵，避免傳入 PTY；原生選單事件共用相同防護。延遲查詢／停止完成後，以 runtime ID 與 startToken 檢查原目標，不能停止或移除替換後的工作。

驗證分開記錄：前端合成橋接測試及 Rust 格式檢查可在 Linux 執行；macOS 原生選單、Cmd+W、Cmd+Q、紅色關閉鈕與原生 IME 尚需 macOS CI／實機驗證。

確認關閉與應用程式最後一次布局儲存共用待完成清理邊界；分割面板部分忘記成功、部分失敗時，只從布局移除已完成清理的面板，失敗者保留。最終快照封存後不再開始新的關閉面板清理，避免重開後復活已刪除 runtime 的 placeholder。

## 2026-10-17：接續對話的新分頁名稱

從歷史／對話預覽接續工作時，新建分頁預設使用同一筆 Session.title；空白標題沿用原有 Agent 名稱。標題僅為顯示文字，去除首尾空白、將換行／控制字元換成空格，最多保留 200 個 Unicode 字元，與手動重新命名的限制一致。既有分頁接續、重新附接或後端判定同一 Runtime 時保留原名稱（包含手動命名）；分割面板不重新命名整個分頁。標題不參與路徑、命令參數或 Runtime 身分判斷。

## 2026-10-17：依 Agent 選擇設定

來源與工具改用可搜尋的 Agent 選擇器，只顯示選中 Agent 的執行檔、參數與歷史來源。切換選擇不執行偵測、不儲存，也不遺失其他 Agent 尚未儲存的修改。每個 Agent 保留個別歷史來源開關與多來源配置。

新增獨立 `agentEnabled` map，缺少欄位或 provider key 視為啟用，保留未知 provider key 以利版本往返。僅儲存設定後生效，停用不覆寫個別來源開關／執行檔／參數。停用阻止新啟動及新的接續程序、暫停該 provider 索引與背景 reconciliation；既有索引仍可瀏覽搜尋，現有 Runtime 可附接與繼續操作。重新啟用後恢復原有設定。明確清除／重建索引仍依使用者選擇執行，不因 provider 停用偷偷保留遭明確要求清除的索引。

預設 Agent 若停用，新的 Agent 工作改用 registry 中第一個已啟用 Agent；全部停用時顯示設定提示，Shell 仍可使用。Launcher 顯示停用狀態，不以 CLI 安裝狀態代替啟用偏好。原生三平台 UI／PTY 驗收與瀏覽器合成測試分開記錄。

## 2026-10-17：可復原的 Session 資源回收筒

第一階段僅管理 Session Bay 的歷史可見性。移入資源回收筒會隱藏一般歷史、搜尋與專案計數，保留原始 Agent 歷史與執行中的工作。獨立 tombstone 以既有 provider／source ID／external session ID 識別，保存來源與標題快照；重掃、重建索引與來源移除不會清除此使用者選擇。回收筒可逐筆還原；來源缺失或身分不符時保留項目並說明無法還原，不自動啟用來源。

原始歷史永久刪除列為後續獨立設計：須逐 provider 確認檔案與共用資料庫的刪除邊界、執行中 Agent 競爭、安全備份與不可復原影響，操作前必須再次明確確認。本階段不提供永久刪除 API 或按鈕。
## 2026-10-17：臨時 Terminal 與既有背景服務相容

更新 UI 不會替換仍擁有 PTY 的背景 broker。早期 protocol 1 的 Launch schema 會拒絕未知欄位，因此新 UI 傳入 `homeDirectory: true` 時，舊 broker 在解碼階段回覆 `Invalid runtime request`；不能用停止既有 Agent 或清除設定解決。

維持 protocol 1 的基本 Hello request，回覆加入可選 capabilities；只有明確宣告 `homeDirectory` 才傳此欄位。未宣告時僅省略政策欄位，保留 Rust 已解析並驗證的家目錄 cwd、`projectId: null`、Shell profile、其餘參數與 generation。不得失敗後重送 Launch，不建立假專案、不啟動第二個 broker、不終止現有程序。回覆的未知 capabilities 不代表已支援功能。

相容模式由 workspace 保留已知 home 政策，附上僅供比對的 `homePolicyRuntimeId`；只有 broker 回傳同一 runtime／pane、仍為無 session／resume 的全域 Shell 且未提供 home 政策時才沿用。此值不復原 runtimeId、不自動啟動或授予附接權限。現代 broker 明確 true／false 優先；未宣告 capability 的中間版本之 false 視為未知，因為新 client 為相容而省略了欄位。任何正向 true 仍保留。

限制：舊 broker 無法保存新政策；工作區尚未儲存、遺失或沒有對應身分時，只能恢復 broker 提供的明確 cwd，不猜測為家目錄政策。啟動時顯示相容模式說明。背景服務升級仍需使用者安排，不能為升級中斷工作。本批以固定舊 schema 的雙向相容回歸和合成 PTY 驗證；真實 macOS 混版執行仍待驗收。

## 2026-10-17：Agent 生命週期總覽

Agent 狀態以共享 provider registry 辨識，不把 Shell 或歷史 Session 數當成 Agent 數。側欄按專案彙總已開啟、存活、已結束、中斷等數量；全域工作階段獨立一組。同一 runtime ID 只計一次，尚無 runtime 的面板按 pane ID 計數。已開啟包含尚未啟動及保留的結束面板，關閉後不再計數；存活只包含已有 runtime 的 starting／running，不代表忙碌或等待輸入。停用 provider 不排除既有程序。

狀態來源限於 bootstrap 的 broker RuntimeRecord，以及現有 TerminalPane 的 launch／attach 回覆、exit／disconnected 事件。所有專案面板既有訂閱在背景保留，總覽只讀 workspace，不增加輪詢、程序探測或輸出分析。斷線不表示已結束，也不能聲稱仍存活；broker 復原的 interrupted 與斷線分開。重複 runtime 視圖使用保守狀態優先順序，終止狀態不被另一個舊的 running 視圖覆蓋。

目前介面沒有可靠的 Agent 工作活動結構化事件，所以執行中顯示「活動未知」，不從靜默、CPU、輸出文字推測忙碌／等待輸入。總覽不跨應用程式猜測或掃描其他程序。前端合成測試可驗證狀態與 UI；原生跨平台實機驗收另行記錄。

## 2026-10-17：Terminal 留白沿用終端背景

Terminal body 保留 FitAddon 外層 padding，背景直接取自同一個 terminalTheme resolver；明暗色與即時預覽／取消皆隨設定更新，未知色票沿用既有 fallback。工具列與 footer 仍用介面色系，不改其分隔線。這是純樣式更新，不重建 PTY、不 reset、不因顏色變更重新 fit。

## 2026-10-17：命令面板鍵盤選取

命令與專案共用單一可搜尋清單；搜尋欄保留焦點，↑／↓ 循環移動至可用項目，Enter 執行選取，Escape 沿用對話框關閉與焦點返回。搜尋變更選取第一個可用項目，停用項目與空結果不能執行；滑鼠指向同步選取，選取項自動捲入可見範圍。組字中的方向鍵、Enter／Escape 與 keyCode 229 不觸發命令。主題子清單維持既有即時預覽、返回取消與儲存語意。

## 2026-10-17 分頁拖曳事件修正

- 分頁排序改用 Pointer Events 與 pointer capture，避免依賴原生 WebView 的 HTML5 檔案拖放事件。只在分頁名稱按鈕開始，移動至少 5px 並於同一專案分頁範圍內放開才提交一次排序；Escape、失焦、pointercancel、capture 遺失與區域外放開均取消。
- 保留點擊選取、Alt 加左右鍵、原有 active／focused ID、其他專案位置與既有 workspace 保存管線；排序不更改 pane、runtime、PTY 或名稱。
- 真實 App 的瀏覽器回歸使用合成 bridge 與 Playwright 滑鼠拖曳，涵蓋保存與重新載入。Chrome 驗證不等於 macOS 原生 WebView 驗收，後者仍須在裝置上驗證。

## 2026-10-17：Agent 圖片輸入採持久本機 staging（實作待驗收）

使用者明確拖放／貼上 PNG、JPEG 才讀取 File bytes；以受限分塊 IPC 驗證並保存，再將單一圖片路徑經 xterm bracketed paste 插入，絕不自動送出。Codex、OpenCode、Grok 依固定版本來源提供 file URL adapter；Claude 使用官方文件的路徑參照；Antigravity 尚無已驗證路徑 adapter，暫停支援。保留舊 broker runtime record 相容性；無新增通用相容性 banner，也不重啟使用中的 Agent。

保留檔不因 detach、resume 或逾時刪除；總額 512 MiB 與檔案數上限採跨程序獨占鎖，鎖失敗停止新增圖片。滿額訊息指出實際目錄與手動清理前提，管理 UI 留待後續。安全界線、官方來源與未驗收平台見 [圖片輸入](image-input.md)。

## 2026-10-17：圖片準備期間保留手動 Enter，取消過期 prompt 目標

拖放／貼上本身不自動送出，但使用者按 Enter 仍立即交給終端。準備期間顯示進度；一般文字及完整 bracketed multiline paste 可繼續，標準 CR/LF 送出與 Ctrl+C/D/Z/反斜線中斷會取消尚未插入的圖片，避免晚到下一則訊息。自己的 image paste frame 不觸發取消，不緩衝或補送 Enter。此 guard 不宣稱辨識所有 CLI 自訂鍵位／自主 prompt 切換。

## 2026-10-17 工作區專注模式

- 專注模式為獨立、可逆的 UI 狀態，不切換作業系統全螢幕，不修改分割比例、面板最大化、側欄偏好或持久化 workspace。
- 專案／臨時 Terminal 可從分頁列進入；保留歷史、工作分頁、新增、面板工具列與明確退出入口。專案名稱按鈕暫時展開原有完整控制列與側欄，提供所有原有操作；總覽自動顯示完整導覽。
- 命令面板可進入／退出；快捷鍵預設空白，可於設定自行配置並套用衝突檢查。不攔截裸 Escape；系統全螢幕操作獨立。
- 相同 WorkspaceCanvas 與 TerminalPane 持續掛載，依 ResizeObserver 更新終端尺寸。索引進行／失敗、縮放失敗、目錄警告與面板錯誤保留可見。原生桌面驗收仍待完成。

## 2026-10-17 單面板滿版布局

作用中分頁的布局只有一個面板時，移除 canvas 外距、面板包裝內距與卡片邊框／圓角；一般與專注模式一致。判斷以該分頁布局為準，其他分頁仍掛載的面板不影響。分割布局（含暫時最大化）維持既有間距與分隔拖曳區，回到單面板自動滿版。保留終端文字內距、工具列、焦點標記與錯誤；不重建終端或更動 FitAddon／PTY 管線。

分割工具列的焦點標記保留固定布局空間，非焦點時隱藏視覺與輔助技術內容，避免 pointerdown 切換焦點造成按鈕換行、原點擊位置失效。合成 Chrome 200% CSS zoom 的真實滑鼠關閉操作發現此問題；不宣稱已重現於原生 WebView。

## 2026-10-17 搜尋效能第二階段：按候選密度選擇查詢

先以獨立 10k 合成搜尋量測確認 COUNT／分頁各自重跑 broad FTS 與全文驗證的成本；snippet 並非主瓶頸。對至少 1,025 筆 FTS 候選的查詢，改用 session-first EXISTS，透過既有 files／messages 索引走訪，在每個 Session 第一筆完整字串命中後停止。較少候選仍走原 candidate-first 策略，避免稀疏／不存在詞遍歷全部訊息。最多 1,025 筆的 FTS rowid probe 只決定執行策略，不截斷結果、不讀正文，也不改 exact predicate。

不新增持久 schema、不共用跨 query cache、不修改索引或來源驗證；所有 filters、排序、總數與 snippet 語意保持原樣。一般 query 沒有 profiling clock 或 log；量測入口僅由 search-profile feature 開啟。Before／After 共用同一既有合成 catalog，保留 raw samples、p50／p95、RSS 與共享環境噪音，詳見[搜尋效能第二階段](search-performance.md)。合成 backend 結果不代替真實來源、原生 UI 或跨平台驗收。

## 2026-10-17：不顯示例行版本相容提示

使用者明確要求不提示新舊版問題。移除啟動時的相容模式橫幅與其唯一用途的字串／helper；底層 Hello capability 協商、舊版 Launch 欄位省略及 home 政策恢復邏輯不變。真正的 broker 連線／請求失敗、設定與 workspace 讀取錯誤仍照原路徑回報。本決策取代上節「啟動時顯示相容模式說明」，不推定使用者實際執行的版本。

## 專案目錄內的工作區與活動狀態（2026-10-17）

- 專案父列保留歷史筆數，另列已開分頁與 Agent 數；展開顯示既有 tabs 的生命週期摘要，切換重用既有 focus 路徑，不重掛 Terminal。
- 取代側欄獨立 Agent 狀態與重複的所有工作區列表；臨時／未列出的工作區仍有獨立入口。
- 目前五個 provider 均只有 PTY 生命週期，無可信工作開始／完成訊號。running 顯示「已開啟 · 活動未知」，不以存活、輸出、輸入、靜默時間推定 busy／idle，不顯示假忙碌 spinner。
- 未來 provider event adapter 必須提供結構化、版本驗證的 task-start/task-end 與 runtime 身分／連線 generation／單調 sequence；只有同 generation 的有效 start 才可顯示 busy，配對 end 才可 idle。斷線、未知事件與程序結束清除活動證據；重新連線先 unknown。不能從歷史尾端猜目前狀態，不新增高頻輪詢，不自動修改全域 hooks、設定或權限。

### 新輸出提示，不代表忙碌（2026-10-17）

使用者同意：有新輸出時小點輕微脈動，停止輸出後淡回靜態；背景 tab 保留未讀點，切回可見工作後清除。啟動／重新附接短暫轉圈只表示連線；確定退出、失敗、中斷採固定圖示。不猜 busy／idle／等待輸入。

實作採 App 範圍的 ephemeral metadata store：pane、runtime、attachment lease、sequence、可見性與時間。只有目前租約且 snapshot 完成後實際繪製的新 output 會記活動；snapshot、重複 sequence、過期租約、結束／已移除 pane 不記。100ms 合併通知只更新小型 indicator，持續輸出僅延後 1.4s 衰減時間，不逐 chunk 重繪 App／sidebar；共用一個過期 timer，無新增輪詢或輸出正文副本。

只有目前工作區 tab 且視窗前景／頁面 visible 才視為已讀；同 tab 最大化暫遮住的 sibling panes 也一起視為已讀，正在看的 tab 不留未讀。history、其他 project/tab、背景視窗輸出留未讀；重新可見時清除。重連同 runtime 保留未讀，但不回放新輸出提示；新 runtime 清除舊 generation。關閉／App 卸載清理 metadata 與 timers。reduced-motion 停止 pulse／spin／淡出動畫。

## 2026-10-17：拖曳排序以實際項目讓位預覽

專案垂直排序與工作區分頁水平排序共用 Pointer Events 預覽。超過 5px 門檻後，來源項目沿排序軸跟隨指標，其餘項目以 transform 平滑讓位，取代插入 border 線；拖曳中不改 DOM 順序、不保存後端，放開才交回原有一次排序／持久化管線。Escape、失焦、capture 遺失、pointercancel、外部或遮擋區域放開均取消。量測使用未變形的位置，避免動畫中的項目反覆改變落點；捲動座標與裁切區域另外檢查。

依使用者要求移除專案列可見上／下移按鈕，保留拖曳把手及 Alt＋上／下鍵盤排序；分頁保留 Alt＋左／右、點擊、重新命名、關閉。減少動態效果偏好會停用讓位動畫，仍保留直接落點預覽。此變更不修改 pane／runtime 身分或保存失敗處理。

審查補充：拖曳跟手與可提交落點分離，經過項目間隙／無效區域仍跟隨指標，放開時重新驗證有效區域。該次拖曳僅訂閱裁切祖先的 scroll 事件，指標靜止時也補償位移；取消、放開與卸載清除訂閱。命中測試排除浮起來源，避免其遮住 sticky 控制而誤認落點。保存層維持原有 optimistic order＋錯誤提示，目前並無保存失敗自動 rollback；此變更沒有新增該保證。

## 2026-10-17：原始對話永久刪除仍未完成

本階段只交付契約調查、架構缺口與合成負面探針文件；不新增刪除按鈕、來源寫入或 provider capability。既有 SQLite path 來源不得人工配對 API 後直接永久刪除：相同 session ID／正文不能證明是同一份資料庫，事後發現刪錯副本無法復原。

下一步優先評估身分從建立時就是 endpoint 的新 API 型來源，或受管且能證明來源與 runtime 身分的 provider control transport。兩者都尚未實作；不得擅自改變既有 Agent 啟動架構、啟動 server 或建立憑證。本階段不引入大型自製 SQLite VFS。普通設定／受管程序競態與外部 namespace ABA 必須分別處理；不能把負面探針解讀成所有 SQLite adapter 都不可能。

永久執行仍須逐次明確確認、原子 idle／children 範圍保護、完整 cleanup、local-only routing、部分失敗及重掃防回流驗收。詳見[契約調查與路線](permanent-deletion-investigation.md)、[獨立安全分析](permanent-deletion-safety-review.md)與[合成探針](permanent-deletion-probes.md)。

## 2026-10-17：一致互動狀態與列表快速移入回收筒

將主操作高亮限制在單一完整點擊面；列表內次要操作只亮自己的範圍。選取狀態保持 accent 標記，hover 不覆蓋成一般列；鍵盤焦點在可捲動容器內採 inset outline，不增減 padding。繼續採緊湊桌面密度及既有 reduced-motion 規則，不變更工作區或 runtime。

Session 列新增同層刪除按鈕，hover／focus-within 顯示，無 hover 裝置常駐並預留寬度。動作沿用確認與可復原的資源回收筒，不刪來源、不終止執行；取消回原按鈕，完成後聚焦復原。Terminal 主題切換命令文案改為「切換 Terminal theme」。

專案頁標題旁以小鉛筆開啟重新命名；資源回收筒與移出／加入專案改圖示按鈕。保留 Terminal／新增工作文字按鈕及既有確認流程；移出採資料夾減號，並明示不刪對話、檔案或關閉程序。長名稱可換行，圖示固定尺寸不被壓縮。

## 2026-10-17：工具設定改為可搜尋下拉選擇

來源與工具以單一 editable combobox 取代常駐 Agent 按鈕。只顯示所選工具的「啟用與安裝狀態」、「啟動設定」、「歷史資料來源」；歷史區不再重複 CLI 狀態，保持安裝與索引診斷分離。選擇不保存、不偵測、不啟動，跨工具草稿保留至儲存或取消。清單限制高度並支援鍵盤、組字與無結果提示。
