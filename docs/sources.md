# Session Bay 技術資料來源

來源查閱日期為 2026-10-15。官方文件用於確認技術能力；產品定位、功能優先序與效能門檻是本專案的規劃提案。

## 官方文件

| 主題 | 來源 | 適用內容 |
| --- | --- | --- |
| Tauri 程序模型 | [Process Model](https://v2.tauri.app/concept/process-model/) | Core、WebView 與平台差異 |
| Tauri 串流傳輸 | [Calling the Frontend from Rust](https://v2.tauri.app/develop/calling-frontend/) | Events 限制與 Channels |
| xterm.js | [官方儲存庫](https://github.com/xtermjs/xterm.js) | 終端元件、addons 與可選 renderer |
| Rust PTY | [portable-pty 文件](https://docs.rs/portable-pty/latest/portable_pty/) | 跨平台 PTY 抽象 |
| Codex CLI | [OpenAI 官方 CLI 文件](https://learn.chatgpt.com/docs/codex/cli) | CLI 工作流程與恢復能力 |
| Claude Code Session | [Manage sessions](https://code.claude.com/docs/en/sessions) | transcript 位置、Session 恢復與不同介面範圍 |
| Claude Code 目錄 | [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory) | 本機紀錄與輸入歷史的用途 |
| SQLite 全文搜尋 | [FTS5 Extension](https://sqlite.org/fts5.html) | 全文索引與 tokenizer 選項 |

## 本機整合觀察

本次討論中曾以唯讀方式確認 Codex 與 Claude Code 執行檔存在，以及相關 JSONL 的位置與欄位名稱。沒有把對話正文、憑證或歷史檔案複製進本目錄。

Codex 的 sessions、archived_sessions 與 payload.cwd，以及 Claude Code 的 cwd、sessionId 等欄位，是本機版本的觀察結果。它們不能代替受支援版本矩陣與正式 fixture，來源 schema 仍需持續相容處理。

## 尚未形成實測結果的項目

Tauri 與 Electron 的資源差異、PTY 串流最大吞吐、中文搜尋策略、跨平台終端相容性，以及支援 agy 等其他工具的可行性，均需以對應原型或整合研究確認。

Session Bay 名稱已由使用者選定。先前公開搜尋未找到明顯同名結果，不能據此保證商標、網域或所有套件名稱可用；本目錄不包含品牌權利查核結論。
