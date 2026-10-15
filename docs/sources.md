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
| Codex 用量介面 | [Codex App Server](https://learn.chatgpt.com/docs/app-server) | 帳號 rate limits、帳號摘要與 thread token 通知；需核對 CLI 版本及 auth mode |
| Codex 額度說明 | [Pricing](https://learn.chatgpt.com/docs/pricing) | 官方 usage dashboard 與 CLI `/status` 的人工查看入口 |
| Claude Code metrics | [Monitoring](https://code.claude.com/docs/en/monitoring-usage) | token／cost 與 Session 屬性；cost 為近似值，不等於實際帳務 |

## 用量工具的一手實作參考

查閱日期：2026-10-15。此處的 OpenUsage 指 `robinebers/openusage`，各工具實作不能代替供應商穩定 API 承諾。

| 主題 | 來源 | 適用內容 |
| --- | --- | --- |
| OpenUsage 功能 | [README](https://github.com/robinebers/openusage) | 額度窗口、credits、重置時間與本機花費估算的功能參考 |
| Claude 額度來源 | [Claude provider](https://github.com/robinebers/openusage/blob/main/docs/providers/claude.md) | 訂閱額度取得的實作參考；需另驗證授權與穩定性 |
| 本機額度互通 | [Local HTTP API](https://github.com/robinebers/openusage/blob/main/docs/local-http-api.md) | 可選的本機快照來源與 schema，不代表 Session 計量事件 |
| 費用估算 | [Model Pricing](https://github.com/robinebers/openusage/blob/main/docs/pricing.md) | token 與版本化價格推算金額的參考；不是 Session Bay 的已選價格來源 |

## 本機整合觀察

本次討論中曾以唯讀方式確認 Codex 與 Claude Code 執行檔存在，以及相關 JSONL 的位置與欄位名稱。沒有把對話正文、憑證或歷史檔案複製進本目錄。

Codex 的 sessions、archived_sessions 與 payload.cwd，以及 Claude Code 的 cwd、sessionId 等欄位，是本機版本的觀察結果。它們不能代替受支援版本矩陣與正式 fixture，來源 schema 仍需持續相容處理。

## 尚未形成實測結果的項目

Tauri 與 Electron 的資源差異、PTY 串流最大吞吐、中文搜尋策略、跨平台終端相容性，以及支援 agy 等其他工具的可行性，均需以對應原型或整合研究確認。

Session Bay 尚未實測用量來源的版本支援、歷史完整性、帳號歸屬、去重、價格規則或用量刷新效能；[用量規格](usage-spec.md)中的能力需以 fixtures 與受支援環境驗證。

Session Bay 名稱已由使用者選定。先前公開搜尋未找到明顯同名結果，不能據此保證商標、網域或所有套件名稱可用；本目錄不包含品牌權利查核結論。


## 本次 MVP 實作查核

查閱日期：2026-10-15。下列來源確認 API、依賴與參數；不代替原生平台或實際 CLI 版本測試。

| 主題 | 官方來源 | 本次用途與限制 |
| --- | --- | --- |
| Tauri 平台依賴 | [Prerequisites](https://v2.tauri.app/start/prerequisites/) | macOS Xcode CLT、Linux WebKitGTK 4.1；其他 distro 需另驗證 |
| Tauri 設定 | [Configuration](https://v2.tauri.app/reference/config/) | CSP、bundle、最低 macOS 版本 |
| PTY Unix 實作 | [portable-pty 0.9.0 Unix source](https://docs.rs/portable-pty/0.9.0/src/portable_pty/unix.rs.html) | setsid、controlling terminal、process group；Linux 已測、macOS 待原生驗證 |
| Codex 參數 | [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) | resume ID 與工作目錄選項；執行檔偵測不等於版本相容已通過 |
| Claude CLI | [CLI reference](https://code.claude.com/docs/en/cli-reference) | --resume 與 CLI 啟動參數 |
| Claude 設定 | [Settings](https://code.claude.com/docs/en/settings) | CLAUDE_CONFIG_DIR 來源選擇 |
| SQLite FTS5 | [Trigram tokenizer](https://sqlite.org/fts5.html#the_trigram_tokenizer) | detail=none compact index 只做候選，exact substring 驗證保留字串語意 |
| GitHub runner | [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) | Ubuntu 24.04、macOS 15 ARM64／Intel matrix；workflow 存在不等於執行成功 |

本次開發僅使用合成 fixtures／暫存資料，沒有存取或複製使用者原始對話。舊節的本機整合觀察屬原規劃文件背景，不是本次已執行的原生驗證。

## 原生 CI 差異調查

查閱日期：2026-10-15。以下用於解釋 CI 實測差異；不能取代最終 commit 的平台測試。

| 主題 | 一手來源 | 適用內容與限制 |
| --- | --- | --- |
| Darwin 退出與 waitid | [Apple XNU 11215.1.10 kern_exit.c](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/bsd/kern/kern_exit.c) | proc ref drain 到 SZOMB 間有過渡狀態；以 owned child 的 WNOWAIT 保留 ownership，不依賴 zombie 的 getsid |
| Darwin group signal | [Apple XNU 11215.1.10 kern_sig.c](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/bsd/kern/kern_sig.c) | killpg1 忽略 zombie，沒有可投遞成員時可能回 EPERM；不能因此忽略真正存活群組的權限錯誤 |
| Tauri setup 次序 | Cargo.lock 固定的官方 tauri 2.12.4 套件，src/app.rs 的 run callback／setup | Ready 才執行 setup；其他 native events 不得假設 managed Service 已存在 |
| CI artifact 權限 | [actions/upload-artifact v4](https://github.com/actions/upload-artifact/blob/v4/README.md#permission-loss) | 直接上傳目錄會失去 executable modes；macOS .app 先 tar，未簽章／未公證 |
| Headless WebKit graphics | [WebKit environment variables](https://trac.webkit.org/wiki/EnvironmentVariables)、[Tauri Xvfb blank-window report](https://github.com/tauri-apps/tauri/issues/15936) | CI-only accelerated compositing 關閉，用於無 GPU 的 Xvfb；不關閉 sandbox。第三輪純色 PNG 不能作 UI 可用證據，需 DOM／IPC／操作訊號加畫面複核 |
