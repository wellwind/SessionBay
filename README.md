# Session Bay

Session Bay 是以專案為中心、Agent 優先的本機開發工作台。它集中整理 Codex、Claude Code、Grok Build、Antigravity CLI 與 OpenCode 等受支援工具的歷史對話，讓開發者找到正確脈絡，在正確目錄接續工作，並透過分頁與分割面板同時使用 Agent 和普通 Terminal。

**Windows／macOS／Linux 原生支援正在驗證。** 本分支包含 Tauri／Rust 桌面程式、React 前端、唯讀歷史索引與真正的 PTY；完整 P0 與平台驗收狀態見[驗證紀錄](docs/mvp-validation.md)。

## 開發啟動

需要 Node.js 24 與 Rust（依 rust-toolchain.toml）。Windows 使用 MSVC Build Tools 與 WebView2；macOS 使用 Xcode Command Line Tools；Linux 需要 WebKitGTK 4.1 開發套件。原生驗收與 CLI 安裝限制見[三平台支援](docs/platform-support.md)。

```bash
npm ci
npm run dev
```

`npm run dev` 啟動完整桌面應用；`npm run dev:web` 僅顯示前端網頁預覽，不能操作本機歷史或 Terminal。完整安裝、測試、建置與疑難排解見[開發與試用](docs/development.md)。

```bash
npm run typecheck && npm run lint && npm test && npm run build
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
# 已具備平台桌面相依套件後：
npm run tauri -- build
```

## 核心使用流程

開啟預設「專案」首頁 → 選擇自己加入的專案 → 搜尋該目錄的歷史 Session → 預覽最後進度 → 接續工作。

「專案」管理自己明確加入的工作目錄；獨立的「所有目錄」頁保留所有有 Session 的目錄分組，包含未加入、失效路徑與未知目錄。兩頁都有總覽卡片與側欄清單，先選目錄才查看該組歷史，不以混合 Session 清單取代總覽。需要跨目錄找對話時，可明確進入全域搜尋。可以加入既有目錄、在指定父目錄下建立新資料夾，或從目錄／歷史預覽按「加入專案」。本機目錄欄位提供系統資料夾選擇器，也保留手動輸入；選取只更新草稿，仍需明確儲存。瀏覽器預覽維持文字輸入。

專案選擇會保留；從清單移出只取消加入與釘選，不刪歷史或檔案，也不結束工作區程序。已開啟的工作區在兩頁皆有入口，未加入專案也能切回。

同一個工作區可以並排執行 Codex、Claude Code、Grok Build、Antigravity CLI、OpenCode、開發伺服器或測試指令。Agent 優先代表預設以專案與工作脈絡組織介面，普通 Shell 仍是完整的一等功能。

也可從頂列「臨時 Terminal」直接在家目錄開啟預設 Shell，不必選取或新增專案；多分頁與重開附接沿用同一工作區／Runtime。操作及驗證邊界見[全域臨時 Terminal](docs/temporary-terminal.md)。

## 文件導覽

- [工作區檔案預覽](docs/workspace-file-preview.md)：唯讀目錄、文字限制及平台安全邊界。

| 文件 | 內容 |
| --- | --- |
| [產品企劃](docs/product-plan.md) | 定位、痛點、目標使用者、價值主張與驗證方式 |
| [產品功能規格](docs/product-spec.md) | MVP 功能、行為、例外情境與驗收條件 |
| [介面與操作規格](docs/ux-spec.md) | 專案、分頁、面板、搜尋與工作恢復流程 |
| [獨立主題與即時預覽](docs/theme-preview.md) | 快速切換、設定預覽／取消、色票與驗證限制 |
| [全工作台縮放](docs/terminal-font-zoom.md) | UI／Terminal 同步縮放、保存／預覽及待驗收範圍 |
| [桌面介面設計系統](docs/ui-design-system.md) | 全介面資訊架構、流程、語意主題、控制項與驗證標準 |
| [技術架構](docs/architecture.md) | Tauri、Rust、PTY、資料流、索引與效能設計 |
| [持續 Runtime](docs/persistent-runtime.md) | 背景 broker、同程序重新附接與原生待驗項目 |
| [OpenCode 整合](docs/opencode-integration.md) | 唯讀 SQLite 歷史、安全接續與版本限制 |
| [Terminal 工作列邊界回歸](docs/terminal-layout-regression.md) | xterm 尺寸契約、合成 browser 截圖與原生驗收限制 |
| [Terminal Shift＋Enter](docs/terminal-keyboard.md) | 統一 CSI-u 原位輸入、查核版本與相容性限制 |
| [批次整合驗證](docs/batch-integration-validation.md) | 修訂後來源、自動化證據與原生待驗項目 |
| [Agent 活動 hook 基礎](docs/agent-activity.md) | 純 observation adapters、尚未接通的 transport 與 opt-in 驗收界線 |
| [Agent 整合規格](docs/agent-integrations.md) | 工具偵測、歷史解析、目錄分組與 Session 接續 |
| [Antigravity CLI 歷史相容性](docs/antigravity-cli-history.md) | 持久化格式依據、唯讀安全、接續限制與 1.3.5 待驗條件 |
| [Agent 用量與分析規格](docs/usage-spec.md) | MVP 後的帳號額度總覽、Project／Agent／Session 用量與費用語意 |
| [Git 工作台規劃](docs/git-workbench-plan.md) | 尚未實作：多 repo、部分暫存、graph、衝突與 GitHub／自架 GitLab 的八個 PR 計畫 |
| [發行與更新規劃](docs/release-update-plan.md) | 尚未完成：試用、GitHub Releases／Homebrew／Snap、更新同意、資料復原與最新優先順序 |
| [開發路線圖](docs/roadmap.md) | 分階段交付、相依性與效能原型驗證 |
| [完整功能與開發任務](docs/development-tasks.md) | P0／P1／P2 功能清單、任務相依、完成條件與開工順序 |
| [工作區整理](docs/workspace-organization.md) | 分頁／面板／專案顯示名稱、排序與驗收限制 |
| [決策與待確認事項](docs/decisions.md) | 使用者已確定方向、建議方案與未定事項 |
| [三平台支援與驗收](docs/platform-support.md) | 原生平台前提、Windows ConPTY／路徑邊界、可重複驗收與未驗證項目 |
| [開發與試用](docs/development.md) | 實際安裝、啟動、測試、建置與資料邊界 |
| [MVP 驗收紀錄](docs/mvp-validation.md) | 可重複測試、平台結果、效能與未完成驗收 |
| [全域臨時 Terminal](docs/temporary-terminal.md) | 無專案 home Shell、舊 cwd 相容與驗證邊界 |
| [索引效能量測](docs/index-performance.md) | 1k／10k／長對話的可重複合成 before／after、資料安全與未解瓶頸 |
| [搜尋效能第二階段](docs/search-performance.md) | 獨立 10k 搜尋 profiling、候選密度策略與完整 raw before／after |
| [IPC 契約](docs/ipc-contract.md) | 前後端命令與資料模型 |
| [資料來源](docs/sources.md) | 技術事實的官方來源與適用限制 |
| [原始對話永久刪除調查](docs/permanent-deletion-investigation.md) | 功能未完成：provider 契約、架構缺口與後續路線 |
| [永久刪除安全分析](docs/permanent-deletion-safety-review.md) | 普通競態、外部 ABA、API 邊界與驗收前提 |
| [永久刪除合成探針](docs/permanent-deletion-probes.md) | 只使用暫存 marker DB 的可重現負面案例 |

## 目前範圍

本批包含原生資料夾選擇器、Windows 後端、持續 Runtime、OpenCode、索引熱路徑改善、獨立主題與命令面板選色、名稱／分頁排序、全工作台縮放、臨時 home Terminal 與原位 Shift＋Enter。Code Modern／Code 2026 各提供深／淺色 UI 和 Terminal 選項，原有十個色系仍保留。實測與未驗項目見[批次整合驗證](docs/batch-integration-validation.md)。

- Agent 啟動涵蓋 Codex CLI、Claude Code CLI、Grok Build、Antigravity CLI（`agy`）與 OpenCode；五者均有本機歷史 adapter。Antigravity 限 CLI 持久化格式，1.3.5 真實樣本與互動接續仍待驗證，詳見[相容性邊界](docs/antigravity-cli-history.md)。
- 預設專案首頁與獨立所有目錄頁保留分組總覽；選目錄後可跨工具搜尋該組歷史、預覽與恢復，掃描不自動加入專案。
- 設定固定顯示五個 Agent 的歷史能力與來源入口，不因是否啟動過而隱藏；可明確偵測官方已知來源位置並加入草稿，舊設定可明確新增 Grok／Antigravity CLI／OpenCode 來源，不自動修改保存的來源。
- 支援自選專案、顯示名稱、加入既有目錄與安全建立單一新資料夾；本次變更的驗證狀態見[驗證紀錄](docs/mvp-validation.md#2026-10-15-雙頁導覽來源入口與-macos-圖示修正)。
- 每工具可保存獨立啟動參數與明確勾選的高風險權限模式，預設關閉；保存後不逐次重複確認，啟動前可看後端產生的精確 argv。各工具 bypass／沙箱差異與本批驗證狀態見 [Agent 整合規格](docs/agent-integrations.md)及[變更紀錄](docs/mvp-validation.md#2026-10-15-agent-擴充與自訂參數變更紀錄)。
- 新增工作先選 Shell／Agent，再從統一工具清單選 Agent；安裝／版本可重新偵測，Shell 候選需明確加入且保留自訂 Profiles。
- 支援普通 Terminal 分頁，以及至少兩個可同時執行、可見的分割面板；搜尋快捷鍵維持目前目錄範圍，表單控制項提供一致焦點與鍵盤操作。
- MVP 後加入各 AI Agent 用量與帳號額度總覽，並依來源能力提供 Project／Agent／Session 用量分析。
- 本次採用 Tauri 2＋Rust＋React／TypeScript 前端＋xterm.js＋SQLite；平台驗收仍按驗證紀錄逐項完成。
- 歷史索引與基本操作在本機完成；既有 Agent 執行時仍依各工具的帳號、網路與權限設定運作。

## 核心驗收情境

隔了一週回到某個專案，即使忘記當時用了哪個 Agent，仍能找到正確對話、確認最後進度，並在正確目錄接著做。

OpenCode 的資料格式、啟動安全邊界與尚待實機驗證項目見 [OpenCode 整合與驗證](docs/opencode-integration.md)。

## 文件狀態

更新日期：2026-10-16。保留原始規劃與歷史 checkpoint；目前實作、實測結果與未達成目標分開標示。使用者已明確指定的需求與尚待決策事項，集中列於[決策與待確認事項](docs/decisions.md)。

名稱採用不代表商標或網域已取得；開源授權、商業模式與發行時程尚未決定。

## 試用後續待辦

2026-10-15 新增的 17 項未來需求集中在 [後續待辦](docs/future-backlog.md)，其中部分已有獨立實作與自動回歸；已驗結果及原生待驗項目分開列示，不因整合全部勾選。

- [持續執行與重新附接](docs/persistent-runtime.md)：獨立 broker、關閉介面保留程序、狀態恢復與原生待驗項目。

- [Terminal Shift＋Enter](docs/terminal-keyboard.md)：統一 CSI-u 原位輸入、查核版本與平台限制。

- [Agent 一般檔案拖放與貼上：範圍、限制及驗證狀態](docs/file-input.md)
- [Agent 圖片拖放與貼上：範圍、限制及驗證狀態](docs/image-input.md)

側欄瀏覽器回歸測試：`npm run test:sidebar`（需 Playwright Chromium；可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已安裝執行檔）。測試使用合成 bridge，不啟動原生 Shell 或讀取使用者資料；不等同原生 WebView 驗收。

- [Windows 安裝／解除安裝 CI](docs/windows-installer-smoke.md)：獨立 opt-in、固定 source SHA 的 x64 disposable runner 驗收。

- [Agent 檔案輸入合成驗收](docs/file-input-validation.md)：區分暫存、CLI 辨識與模型真實接收。

- [Caps Lock 中文組字候選修正](docs/capslock-ime.md)：交易隔離、合成回歸與尚待原生驗收的範圍。

- [Agent 活動 opt-in 傳輸與驗收邊界](docs/agent-activity-transport.md)

- [真實 Provider 狀態](docs/provider-hooks.md)：launch-local opt-in、Claude mod、撤銷與驗證界線。
- [Codex 原生狀態觀察器](docs/codex-state-observer.md)：互動 TUI、唯讀 app-server 與相容性限制。

- [工作區 Activity Bar 與內部功能擴充](docs/activity-bar.md)

- [原生終端活動訊號（OSC7501）](docs/native-terminal-status.md)：Codex／Grok／Antigravity 的明確來源狀態、信任界線與驗證範圍。
- [大型文字檔閱讀](docs/large-file-reading.md)：分級開啟、取消、有界 IPC 與分段。
