# Repository Guidelines

## 專案結構與文件分工

Session Bay 是以專案為中心、Agent 優先的本機開發工作台，目前處於規劃階段，尚無可執行應用、原始碼、測試或資產目錄。

- `README.md`：產品簡介、目前範圍與文件導覽。
- `docs/product-plan.md`、`docs/product-spec.md`：產品定位、功能與驗收條件。
- `docs/ux-spec.md`：介面與操作流程。
- `docs/architecture.md`、`docs/agent-integrations.md`：架構提案、資料與整合邊界。
- `docs/decisions.md`、`docs/roadmap.md`、`docs/sources.md`：決策狀態、交付順序與技術依據。

需求變更時，先更新 `docs/decisions.md`，再同步相關規格與路線圖；新增文件時補上 README 導覽。

## 建置、測試與開發指令

目前沒有套件清單、建置腳本或開發伺服器，尚無可執行的 build、test 或 dev 指令。可使用以下指令檢查文件：

- `rg --files`：列出檔案，確認文件位置。
- `rg -n '待決策|尚未|提案' README.md docs/`：查找未定事項與規劃限制。

Tauri 2、Rust、TypeScript、xterm.js 與 SQLite 皆為候選方案。建立應用骨架時，須同步記錄實際安裝、啟動、建置與測試指令。

## 撰寫風格與命名慣例

文件使用繁體中文、簡短段落與 Markdown 標題；檔名沿用小寫 kebab-case，例如 `agent-integrations.md`。連結使用相對路徑，程式碼區塊標示語言。TypeScript 範例沿用兩空格縮排，程式碼註解使用英文。

目前未設定 formatter 或 linter。清楚區分已確定需求、建議方案與實測結果；新增技術依據時，在 `docs/sources.md` 記錄官方來源、查閱日期與適用限制。

## 驗證與測試指引

目前沒有測試框架、測試命名規範或覆蓋率門檻。文件修改後，預覽 Markdown、確認相對連結可用，並核對產品規格、架構與路線圖是否一致。

開始實作後，依 `docs/roadmap.md` 建立去識別 adapter fixtures、索引與 Runtime 整合測試，以及工作恢復流程的端到端測試；功能驗收以 `docs/product-spec.md` 的 P0 條件為準。效能報告須附環境、版本與量測日期。

## Commit 與 Pull Request 指引

目前目錄未初始化 Git，無法歸納既有提交慣例。初始化後建議使用簡短、具體的訊息，例如 `docs: clarify session resume behavior`，每次提交聚焦單一變更。

PR 應說明目的、影響文件、驗證方式與未定事項；有相關 issue 時附上連結。介面變更附截圖，架構變更說明取捨並更新決策文件。

## 資料安全與整合邊界

原始 Agent 歷史維持唯讀。範例與 fixtures 使用合成或去識別資料；勿提交憑證、真實對話或本機索引。啟動程序使用 executable、args 與 cwd 分別傳入，避免將不可信內容組成 Shell 指令。
