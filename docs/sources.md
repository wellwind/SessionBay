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

## macOS 圖示與產生流程

查閱日期：2026-10-15。Apple 現行文件著重新版分層圖示與 Icon Composer；不能直接推導傳統 ICNS 的固定留白比例。

| 主題 | 官方來源 | 適用內容與限制 |
| --- | --- | --- |
| Apple 圖示設計 | [App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons/)、[Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass) | 視覺平衡、新版圖示網格與分層流程；未以此聲稱 Apple 規定 824／1024 的傳統 ICNS 外形尺寸 |
| Tauri 圖示 CLI | [App Icons](https://v2.tauri.app/develop/icons/) | 方形透明 PNG／SVG 輸入、可指定輸出目錄、macOS ICNS／Windows ICO／Linux PNG 與 bundle.icon；本專案只從暫存產物更新 ICNS |

412／512（等同 824／1024）是本次 macOS 視覺校正選擇，原圖等比置中而不修改品牌圖形。檔案 alpha 邊界可自動檢查，與其他應用在 Cmd+Tab／Dock 的視覺比較仍須原生驗收。

## Session 命名來源

2026-10-15 查閱 [Codex 官方命令](https://learn.chatgpt.com/docs/developer-commands)與 [Claude Code Session 命名](https://code.claude.com/docs/en/sessions#name-your-sessions)，確認兩工具均提供 `/rename`。Codex [App Server](https://learn.chatgpt.com/docs/app-server)另提供 thread 名稱欄位與名稱更新能力。

本機 Codex 名稱 sidecar 的欄位觀察為 `id`、`thread_name`、`updated_at`；沒有將實際名稱或對話複製進 repo。此為版本相關格式，不視為穩定公開 API；本次支援以合成 fixtures 驗證。Claude 自訂標題與摘要的優先順序亦有合成回歸案例。

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

Tauri 與 Electron 的資源差異、PTY 串流最大吞吐、中文搜尋策略、跨平台終端相容性，以及額外工具的完整相容性，均需以對應原型或整合研究確認。Grok Build／Antigravity CLI 的本次官方資料查核見下節，不能代替真實 CLI 驗收。

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
| Darwin PTY 退出排空 | [Apple XNU kern_exit.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_exit.c#L2132-L2140)、[tty.c ttywait](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/tty.c#L1683-L1729) | session leader 退出會等待 tty 輸出清空；明確停止時仍以固定大小非阻塞讀取丟棄剩餘輸出，不等待前端 ACK；自然退出維持既有輸出順序 |
| Darwin Ctrl-S／XOFF | [Apple XNU tty.c TIOCSTART](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/tty.c#L1376-L1382)、[tty_dev.c master read](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/tty_dev.c#L919-L928) | TTSTOP 會讓 master read 無法排空；停止時對自有 master 一次 TIOCSTART 恢復輸出，不注入按鍵，正常執行不改動 flow control |
| Ubuntu CJK 與 Debian dependencies | [Ubuntu noble fonts-noto-cjk](https://packages.ubuntu.com/source/noble/fonts-noto-cjk)、[Tauri Debian packaging](https://v2.tauri.app/distribute/debian/) | 繁中 UI 使用本機 Noto Sans CJK TC；deb.depends 加入字型並保留 Tauri 預設依賴，CI 驗證 zh-tw coverage；不使用網路字型 |

## 新增 Agent 與啟動權限查核

查閱日期：2026-10-15。僅以官方文件與 xAI 官方儲存庫確認介面，未讀取真實使用者歷史；上游 `main` 的儲存格式是版本觀察，不是穩定 schema 承諾。

| 主題 | 官方來源 | 本次用途與限制 |
| --- | --- | --- |
| Grok Build CLI | [CLI reference](https://docs.x.ai/build/cli/reference) | `grok`、指定 ID resume、模型／effort、auto-approve 與 aliases；自動核准不代表沙箱關閉 |
| Grok 沙箱 | [Sandbox](https://docs.x.ai/build/features/sandbox) | 沙箱是獨立能力；本應用仍以精確 argv 及 CLI 實際設定為準 |
| Grok 本機儲存 | [Persistence](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/persistence.rs)、[Storage](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/storage/mod.rs) | summary／updates、ACP chunks 與 rewind；只解析支援事件，不把未知格式當完整歷史 |
| Antigravity 恢復 | [Resume](https://antigravity.google/docs/cli/commands/resume/) | `agy --conversation <id>`，CLI 新建與手動恢復；不據此聲稱可搜尋本機歷史 |
| Antigravity 權限 | [Headless mode](https://antigravity.google/docs/cli/headless/) | `--dangerously-skip-permissions` 自動核准工具，sandbox 另列；文件不代替互動 CLI 版本驗收 |
| Antigravity 歷史位置 | [Hooks](https://antigravity.google/docs/hooks) | `transcriptPath` 與 CLI／App／IDE 不同資料位置；未驗證 transcript 事件 schema，故本批不建歷史 adapter |
| Codex 危險模式 | [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) | bypass／yolo 同時略過審批與沙箱；自訂權限模式語意須依 CLI 版本 |
| Claude 權限選項 | [CLI reference](https://code.claude.com/docs/en/cli-reference) | skip-permissions／permission-mode；不概括承諾略過外部管理限制 |

本應用接受的自訂參數是較窄的已審查白名單，並非供應商 CLI 全部 flags。啟動與預覽共用實作的驗證結果、focused 檢查與尚待完成的全套／平台測試，見 [本批變更紀錄](mvp-validation.md#2026-10-15-agent-擴充與自訂參數變更紀錄)。


## 介面設計參考（2026-10-15）

- [UI/UX Pro Max 官方來源](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/56ea9cf174ed86786187daa9de0e6247cb0747e4)：使用者指定的 MIT 設計指南。已套用經產品／平台判斷的研究流程，沒有直接採用不適合桌面工作台的行銷頁與遠端字型建議。
- [Session Bay 介面設計系統](ui-design-system.md)：本次重新設計的流程、語意 tokens、明確保留的功能邊界與逐項驗證依據。

## 輸入與工作分頁修正（2026-10-15）

- [xterm.js CompositionHelper 原始碼](https://github.com/xtermjs/xterm.js/blob/master/src/browser/input/CompositionHelper.ts)：本輪測試讀取 lockfile 鎖定的 xterm 5.5.0 實作，重現 Caps Lock 提前 finalize 後 compositionend 重送；合成事件不代替真實 macOS 輸入法驗收。
- [Chrome 鍵盤快捷鍵](https://support.google.com/chrome/answer/157179?co=GENIE.Platform%3DDesktop&hl=en)：使用者指定的工作分頁操作參考；應用保留鍵、組字與模態對話框邊界見 UX 規格，不宣稱攔截所有 OS 全域快捷鍵。

## Antigravity CLI 持久化格式補充（2026-10-15）

本輪後續取得公開持久化 row 與版本化 metadata reader 證據，取代上表當時「本批不建歷史 adapter」的暫定範圍。完整來源、原始 capture 版本／社群實作的證據強度、SQLite 唯讀設計及尚缺的 1.3.5 驗收，見 [Antigravity CLI 歷史相容性](antigravity-cli-history.md)。不把官方路徑文件、stdout stream-json 或社群聲稱的版本範圍當穩定 schema 保證。

## CI 省額度模式

查閱日期：2026-10-15。自動檢查只用 branch push，手動保留完整三平台；沒有變更帳務或 required checks。

- [GitHub workflow syntax：Git diff comparisons](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#git-diff-comparisons)：push 兩點與 PR 三點 diff、路徑篩選與大型 diff 例外。
- [GitHub：Manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)：default-branch 要求與 branch/ref 選擇；未合併時不能保證派送可用。
- [GitHub：Control workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)：同群 queued run 的取代語意；完整手動流程不共用自動取消群組。
- [GitHub：Status checks](https://docs.github.com/en/pull-requests/reference/status-checks)：未跑／略過不能作為本專案實際平台驗收證據。
- [actionlint v1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12)：本機以官方 release digest 核對後檢查 workflow 語法與 expressions；沒有新增第三方 CI action。
