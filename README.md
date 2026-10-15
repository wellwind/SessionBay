# Session Bay

Session Bay 是以專案為中心、Agent 優先的本機開發工作台。它集中整理 Codex、Claude Code 等工具的歷史對話，讓開發者找到正確脈絡，在正確目錄接續工作，並透過分頁與分割面板同時使用 Agent 和普通 Terminal。

**macOS＋Linux 的第一版 MVP 已進入實作與驗證。** 本分支包含 Tauri／Rust 桌面程式、React 前端、唯讀歷史索引與真正的 PTY；完整 P0 與平台驗收狀態見[驗證紀錄](docs/mvp-validation.md)。

## 開發啟動

需要 Node.js 24、Rust（依 rust-toolchain.toml）、macOS Xcode Command Line Tools；Linux 另需 WebKitGTK 4.1 開發套件。

```bash
npm ci
npm run tauri -- dev
```

前端單獨 `npm run dev` 只顯示網頁預覽，不能操作本機歷史或 Terminal。完整安裝、測試、建置與疑難排解見[開發與試用](docs/development.md)。

```bash
npm run typecheck && npm run lint && npm test && npm run build
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
# 已具備平台桌面相依套件後：
npm run tauri -- build
```

## 核心使用流程

選擇專案 → 找到歷史 Session → 預覽最後進度 → 接續工作。

同一個工作區可以並排執行 Codex、Claude Code、開發伺服器或測試指令。Agent 優先代表預設以專案與工作脈絡組織介面，普通 Shell 仍是完整的一等功能。

## 文件導覽

| 文件 | 內容 |
| --- | --- |
| [產品企劃](docs/product-plan.md) | 定位、痛點、目標使用者、價值主張與驗證方式 |
| [產品功能規格](docs/product-spec.md) | MVP 功能、行為、例外情境與驗收條件 |
| [介面與操作規格](docs/ux-spec.md) | 專案、分頁、面板、搜尋與工作恢復流程 |
| [技術架構](docs/architecture.md) | Tauri、Rust、PTY、資料流、索引與效能設計 |
| [Agent 整合規格](docs/agent-integrations.md) | 工具偵測、歷史解析、目錄分組與 Session 接續 |
| [Agent 用量與分析規格](docs/usage-spec.md) | MVP 後的帳號額度總覽、Project／Agent／Session 用量與費用語意 |
| [開發路線圖](docs/roadmap.md) | 分階段交付、相依性與效能原型驗證 |
| [完整功能與開發任務](docs/development-tasks.md) | P0／P1／P2 功能清單、任務相依、完成條件與開工順序 |
| [決策與待確認事項](docs/decisions.md) | 使用者已確定方向、建議方案與未定事項 |
| [開發與試用](docs/development.md) | 實際安裝、啟動、測試、建置與資料邊界 |
| [MVP 驗收紀錄](docs/mvp-validation.md) | 可重複測試、平台結果、效能與未完成驗收 |
| [IPC 契約](docs/ipc-contract.md) | 前後端命令與資料模型 |
| [資料來源](docs/sources.md) | 技術事實的官方來源與適用限制 |

## 目前範圍

- 首批 Agent 整合以 Codex CLI、Claude Code CLI 為建議範圍。
- 支援依工作目錄分組、跨工具搜尋、對話預覽與恢復 Session。
- 支援普通 Terminal 分頁，以及至少兩個可同時執行、可見的分割面板。
- MVP 後加入各 AI Agent 用量與帳號額度總覽，並依來源能力提供 Project／Agent／Session 用量分析。
- 本次採用 Tauri 2＋Rust＋React／TypeScript 前端＋xterm.js＋SQLite；平台驗收仍按驗證紀錄逐項完成。
- 歷史索引與基本操作在本機完成；既有 Agent 執行時仍依各工具的帳號、網路與權限設定運作。

## 核心驗收情境

隔了一週回到某個專案，即使忘記當時用了哪個 Agent，仍能找到正確對話、確認最後進度，並在正確目錄接著做。

## 文件狀態

整理日期：2026-10-15。文件中的 MVP 切分、架構與效能數字是開發提案；使用者已明確指定的需求與尚待決策事項，集中列於[決策與待確認事項](docs/decisions.md)。

名稱採用不代表商標或網域已取得；開源授權、商業模式與發行時程尚未決定。

