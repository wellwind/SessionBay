# Repository Guidelines

## 專案結構與文件分工

Session Bay 是以專案為中心、Agent 優先的本機開發工作台，目前有 macOS／Linux MVP 實作；原始規格保留，未通過的驗收不得標為完成。

- `README.md`：產品簡介、目前範圍與文件導覽。
- `docs/product-plan.md`、`docs/product-spec.md`：產品定位、功能與驗收條件。
- `docs/ux-spec.md`：介面與操作流程。
- `docs/architecture.md`、`docs/agent-integrations.md`：架構提案、資料與整合邊界。
- `docs/decisions.md`、`docs/roadmap.md`、`docs/sources.md`：決策狀態、交付順序與技術依據。

需求變更時，先更新 `docs/decisions.md`，再同步相關規格與路線圖；新增文件時補上 README 導覽。

## 建置、測試與開發指令

實際模組：`src/` 是 React／TypeScript UI；`src-tauri/src/` 是 Rust catalog、adapters、config、service、runtime 與 Tauri IPC。`fixtures/` 全為合成資料。

- `npm ci`：按 lockfile 安裝依賴。
- `npm run tauri -- dev`：啟動完整桌面應用。
- `npm run typecheck && npm run lint && npm test && npm run build`：前端品質檢查。
- `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features`：不需 GUI 的 Rust 核心／PTY 測試。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`：有桌面依賴時的完整 crate 測試。
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check` 與 `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`。
- `npm run tauri -- build`：當前平台未簽章建置；不能在 Linux 宣稱已驗證 macOS。

文件檢查：

- `rg --files`：列出檔案，確認文件位置。
- `rg -n '待決策|尚未|提案' README.md docs/`：查找未定事項與規劃限制。

目前已採用 Tauri 2、Rust、React／TypeScript、xterm.js 與 SQLite。技術變更需同步更新實際安裝、啟動、建置與測試指令。

## 撰寫風格與命名慣例

文件使用繁體中文、簡短段落與 Markdown 標題；檔名沿用小寫 kebab-case，例如 `agent-integrations.md`。連結使用相對路徑，程式碼區塊標示語言。TypeScript 範例沿用兩空格縮排，程式碼註解使用英文。

Rust 使用 rustfmt 與 Clippy；前端使用 ESLint 與 TypeScript 嚴格檢查。清楚區分已確定需求、建議方案與實測結果；新增技術依據時，在 `docs/sources.md` 記錄官方來源、查閱日期與適用限制。

## 驗證與測試指引

前端使用 Vitest／Testing Library，測試與模組一起放在 `src/*.test.ts(x)`；Rust 使用 unit tests 與 `src-tauri/tests/` 整合測試。尚未設定覆蓋率門檻。文件修改後確認相對連結可用，並核對產品規格、架構與路線圖是否一致。

持續依 `docs/roadmap.md` 維護去識別 adapter fixtures、索引與 Runtime 整合測試，以及工作恢復流程的端到端測試；功能驗收以 `docs/product-spec.md` 的 P0 條件為準。效能報告須附環境、版本與量測日期。

## Commit 與 Pull Request 指引

在 feature branch 開發，不直接修改 main；使用簡短、具體的提交訊息，例如 `docs: clarify session resume behavior`，每次提交聚焦單一變更。

PR 應說明目的、影響文件、驗證方式與未定事項；有相關 issue 時附上連結。介面變更附截圖，架構變更說明取捨並更新決策文件。

## 資料安全與整合邊界

原始 Agent 歷史維持唯讀。範例與 fixtures 使用合成或去識別資料；勿提交憑證、真實對話或本機索引。啟動程序使用 executable、args 與 cwd 分別傳入，避免將不可信內容組成 Shell 指令。

## UI／UX 設計技能

涉及介面結構、視覺設計、互動、響應式版面或可用性／無障礙檢查時，先讀 [UI UX Pro Max](.agents/skills/ui-ux-pro-max/SKILL.md)，按任務選擇 domain 或實際 stack 搜尋。SessionBay 目前 UI 使用 React／TypeScript，先核對依賴與既有 `docs/ux-spec.md`、`docs/ui-design-system.md`；搜尋建議不能覆蓋專案規格。純後端工作不需載入。

來源、MIT 授權、本地路徑、驗證限制與更新方式見 [技能來源說明](.agents/skills/ui-ux-pro-max/UPSTREAM.md)。`--persist` 只用於任務需要的 repo 內輸出；先讀既有設計文件，`--force` 覆寫須明確授權。
