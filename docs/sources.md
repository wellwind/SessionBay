# Session Bay 技術資料來源

來源查閱日期為 2026-10-15。官方文件用於確認技術能力；產品定位、功能優先序與效能門檻是本專案的規劃提案。

## 官方文件

| 主題 | 來源 | 適用內容 |
| --- | --- | --- |
| Tauri 原生對話框 | [Dialog plugin](https://v2.tauri.app/plugin/dialog/)／[JavaScript API](https://v2.tauri.app/reference/javascript/dialog/) | 2026-10-16 查閱；單一資料夾選擇、取消回傳 null、macOS／Windows／Linux 支援及 `dialog:allow-open`／安全確認用 `dialog:allow-message` 權限；不代表整個應用已通過各平台驗收 |
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

## Windows 原生支援（2026-10-16）

查閱日期：2026-10-16；來源描述上游 API／安裝支援，不作為 Session Bay 原生驗收結果。

- [Microsoft：建立 ConPTY session](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)：獨立 I/O threads、初始 cursor handshake 與 attached-child teardown。
- [Microsoft：ClosePseudoConsole](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole)：Windows 10 1809 起提供；舊版本關閉須持續排空輸出，不能在 reader 本身等待關閉。
- [portable-pty 0.9 原始碼](https://docs.rs/crate/portable-pty/0.9.0/source/src/win/conpty.rs)：本地 lockfile 使用 0.9.0；另外核對 `psuedocon.rs` 的 cursor flag 與 child HANDLE 行為，不將 API 表面跨平台視為 lifecycle 已驗。
- [Microsoft：GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandleex) 與 [FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)：volume／128-bit ID 可識別檔案替換；時間戳不能代替身分。
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) 與 [Windows installer](https://v2.tauri.app/distribute/windows-installer/)：MSVC、WebView2、NSIS／MSI 差異；本 PR 使用 current-user NSIS，沒有替使用者安裝／發布。
- 四個 CLI 的 Windows 官方安裝依據與限制集中於[三平台支援](platform-support.md#cli-相容性與限制)。

### 2026-10-16 GitHub Actions Node 24

- [Node 20 removal](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/)：2026-09-23 已移除，專案 Node 與 action runtime 不同。
- [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)、[setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)、[upload-artifact v7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2)：以 release tag 的 Git ref SHA 與 action.yml 核對 Node 24，並閱讀移轉限制。現有設定未使用 registry-url／always-auth／unsafe PR checkout，不受這些新增限制影響。

## 2026-10-16 持續 Runtime

- [interprocess 2.4.5 local sockets](https://docs.rs/interprocess/2.4.5/interprocess/local_socket/index.html)：Unix socket／Windows named pipe 抽象、peer credentials；實作仍需 private directory／SID ACL，不能把本機名稱當身分驗證。
- [Windows named pipe listener options](https://docs.rs/interprocess/2.4.5/interprocess/os/windows/named_pipe/struct.PipeListenerOptions.html)：remote acceptance 預設 false，first-instance 與 security descriptor 行為以固定 lockfile 版本核對。
- [vt100 0.16.2 Screen](https://docs.rs/vt100/0.16.2/vt100/struct.Screen.html)：有界 terminal state、formatted screen 與 input modes；不代表完整 xterm／所有 Agent TUI 相容。
- [interprocess 2.4.5 Unix listener mode](https://docs.rs/interprocess/2.4.5/interprocess/os/unix/local_socket/trait.ListenerOptionsExt.html)：2026-10-16 核對本機 lockfile 對應原始碼；`.mode()` 在 bind 前執行 `fchmod`，不支援時回傳 `Unsupported`。本機 macOS 已重現；改用 0700 父目錄保護 bind 後的 0600 設定，其他平台未因此宣稱完成驗收。

## OpenCode（查閱 2026-10-16）

- [CLI 官方選項](https://opencode.ai/docs/cli/) 與 [Windows 原生安裝](https://opencode.ai/docs/windows/)：--version、--session、--auto 與平台安裝；文件會更新，不代表實機驗證。
- [v1.19.2 release](https://github.com/anomalyco/opencode/releases/tag/v1.19.2)：本次固定參照版本。
- [SQLite schema](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/session/sql.ts)、[v1 types](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/schema/src/v1/session.ts)、[v2 types](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/schema/src/session-message.ts)：reader 與獨立合成 fixture 欄位依據，非穩定外部 API 保證。
- [Global XDG paths](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/global.ts)、[DB override](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/database/database.ts)、[TUI argv](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/opencode/src/cli/cmd/tui.ts)、[global --pure](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/opencode/src/index.ts)：路徑、精確來源與權限選項依據。

- OpenCode v2 reset 與原生讀取權威性（2026-10-16，固定 v1.19.2 source）：[reset migration](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/database/migration/20260622170816_reset_v2_session_state.ts)、[V2Session reader](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/session.ts)、[v2 experimental specification](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/specs/v2/session.md)。v2 state reset 不代表 v1 rows 仍屬現行 transcript；無權威標記的混合狀態採 metadata-only partial，不自動 fallback。

## 索引效能與暫存候選索引

查閱日期：2026-10-16。實測與限制見[索引效能量測](index-performance.md)。

- [SQLite temp_store](https://www.sqlite.org/pragma.html#pragma_temp_store)：連線要求 FILE 暫存儲存；編譯期 `SQLITE_TEMP_STORE` 仍可影響行為，不將 pragma 當所有發行環境的硬性保證。
- [SQLite cache_size](https://www.sqlite.org/pragma.html#pragma_cache_size)：負值以 KiB 指定建議 page-cache 大小；本次 TEMP 設為約 2 MiB，並非程序總記憶體上限。
- [SQLite temporary files](https://www.sqlite.org/tempfiles.html)：TEMP table／index 屬連線本機暫存，可能先由 page cache 承載；不把它加入持久 schema，也不額外複製對話正文。
## 原生確認的非同步相容性

2026-10-16 查核官方 [tauri-plugin-dialog 2.8.3 crate](https://crates.io/crates/tauri-plugin-dialog/2.8.3) 的 `src/init-iife.js` 與 `permissions/autogenerated/commands/message.toml`：初始化將 `window.confirm` 覆寫為 Promise，透過 `plugin:dialog|message` 的 `OkCancel` 結果判斷；需要 `dialog:allow-message`。測試保存未改寫的 initializer 與 MIT 授權，SHA-256 及用途見 [`src/test/fixtures/README.md`](../src/test/fixtures/README.md)。不得將 Promise 的 truthiness 當使用者同意，也不以全域同步 shim 掩蓋 API 變化。

### 2026-10-16 Shift＋Enter decoder 查核

[Terminal 按鍵研究與版本清單](terminal-keyboard.md) 收錄 Codex 0.163.0、Claude Code 2.1.301、OpenCode 1.19.3／OpenTUI 0.4.5 的 pinned 官方來源及 fixture hash，並區分 Antigravity 1.3.5 與 Grok 的文件／dependency 證據限制。CSI-u 是本次明確 keybinding，不等於完整 Kitty 支援；原生平台及完整 CLI 驗收未完成。

## 全工作台原生縮放（2026-10-16）

以本 PR lockfile 的 Tauri 2.12.4、tauri-runtime-wry 2.12.2、Wry 0.57.0 與 xterm 5.5.0 查核；文件與原始碼不是實機驗收。

- [Tauri setZoom](https://v2.tauri.app/reference/javascript/api/namespacewebview/#setzoom) 與 [核心權限](https://v2.tauri.app/reference/acl/core-permissions/#webview)：使用目前 WebView 的 page zoom，1 代表 100%；需明確授權 allow-set-webview-zoom，core:default 不包含此 setter。
- [Tauri window configuration](https://v2.tauri.app/reference/config/#windowconfig)：zoomHotkeysEnabled 在 Windows 控制 WebView2 zoom controls，macOS／Linux 會注入另套倍率與範圍的 polyfill；本 PR 明確設 false，由可保存的單一快捷鍵處理器負責。
- [Wry 0.57 macOS](https://github.com/tauri-apps/wry/blob/wry-v0.57.0/src/wkwebview/mod.rs)、[Linux](https://github.com/tauri-apps/wry/blob/wry-v0.57.0/src/webkitgtk/mod.rs)、[Windows](https://github.com/tauri-apps/wry/blob/wry-v0.57.0/src/webview2/mod.rs)：分別使用 WKWebView pageZoom（macOS 11+）、WebKitGTK zoom level 與 WebView2 ZoomFactor；專案最低 macOS 12 符合 API 條件。
- [WebKitGTK zoom-text-only](https://webkitgtk.org/reference/webkit2gtk/stable/property.Settings.zoom-text-only.html)：預設 false，正常頁面縮放包含內容與文字。
- [WebView2 ZoomFactor](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller?view=webview2-1.0.3537.50#get_zoomfactor)：倍率會影響頁面布局；host 設定值也是原生 Ctrl+0 的預設，故本應用自行處理明確的 100% reset。
- [xterm 5.5 CoreBrowserService](https://github.com/xtermjs/xterm.js/blob/5.5.0/src/browser/services/CoreBrowserService.ts)：既有 DPR／resize 追蹤保留；不可把 DPR 當作已保存的 appZoom。
- [MDN CSS zoom](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/zoom)：CSS zoom 與 transform scale 的布局語意不同；本 PR 使用原生 page zoom，未以 transform 模擬，並補縮小 CSS viewport 後的可達性。

## Code 配色來源（2026-10-16）

- Microsoft VS Code 固定 commit 3588843f05a21bfdeada83a9799d87f19de0fadd 的 [default themes](https://github.com/microsoft/vscode/tree/3588843f05a21bfdeada83a9799d87f19de0fadd/extensions/theme-defaults/themes)：Modern 與 2026 深／淺色及完整 include 鏈的語意配色。
- 同一版本的 [Terminal color registry](https://github.com/microsoft/vscode/blob/3588843f05a21bfdeada83a9799d87f19de0fadd/src/vs/workbench/contrib/terminal/common/terminalColorRegistry.ts) 與 [editor selection defaults](https://github.com/microsoft/vscode/blob/3588843f05a21bfdeada83a9799d87f19de0fadd/src/vs/platform/theme/common/colors/editorColors.ts)：未被主題覆蓋的 ANSI／選取色來源。
- [MIT license](https://github.com/microsoft/vscode/blob/3588843f05a21bfdeada83a9799d87f19de0fadd/LICENSE.txt) 隨 public/third-party/VSCode-LICENSE.txt 保留。適用範圍、可及性調整與非官方合作聲明見 [主題說明](theme-preview.md)。
- [Windows Owner of a New Object](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object)、[CreateFileW security attributes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)：2026-10-16 核對新物件 owner 來自 TokenOwner、非父目錄 owner；明確 security descriptor 只套用新檔，既有檔不得藉 OPEN_ALWAYS 改權限。用於 Windows broker lock 原子建立修正，原生結果另行驗證。
- [GitHub 手動執行 workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[workflow_dispatch inputs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs)：2026-10-16 核對 default branch 須有 workflow、可指定 branch/ref 與有預設值的 choice input。Windows 單列驗收仍須核對實際 run 的 head SHA 與 job 清單，不能只憑本機矩陣展開就宣稱已執行。
- [PowerShell NativeCommandProcessor v7.5.4](https://github.com/PowerShell/PowerShell/blob/v7.5.4/src/System.Management.Automation/engine/NativeCommandProcessor.cs#L638-L652)、[Engine WG 對 GUI 非同步執行的說明](https://github.com/PowerShell/PowerShell/issues/26455)、[Process.Kill](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill)：2026-10-17 核對 GUI-subsystem 原生命令的背景執行／結束碼規則，以及 WaitForExit 不代表所有被 Kill(true) 的後代都已退出。用於 smoke 清理同步與只停止自有程序的修正；Windows 原生重跑結果另行記錄。
- [PowerShell Start-Process Windows implementation](https://github.com/PowerShell/PowerShell/blob/v7.5.4/src/Microsoft.PowerShell.Commands.Management/commands/management/Process.cs#L2349-L2355)、[Windows standard-handle redirection](https://github.com/PowerShell/PowerShell/blob/v7.5.4/src/Microsoft.PowerShell.Commands.Management/commands/management/Process.cs#L2446-L2466)、[Pipe Handle Inheritance](https://learn.microsoft.com/en-us/windows/win32/ipc/pipe-handle-inheritance)：2026-10-17 核對 Windows Start-Process 的 output/error redirection 直接使用 File.OpenHandle，與必須等所有 write handles 關閉才到 EOF 的匿名 pipe 不同。用於 synthetic UI 記錄擷取；broker 停止／state 清除仍獨立驗證，不由 log 讀取成功推定。

- Tauri 2.12.4 Menu 預設原始碼與 PredefinedMenuItem（查閱 2026-10-17）：https://github.com/tauri-apps/tauri/blob/tauri-v2.12.4/crates/tauri/src/menu/menu.rs 、https://github.com/tauri-apps/tauri/blob/tauri-v2.12.4/crates/tauri/src/menu/predefined.rs 。macOS 預設 File／Window 含 CloseWindow，單靠 WebView keydown 不能取代原生 accelerator；本次使用自訂 Close Tab 選單事件。文件／原始碼查核不代表原生 macOS 驗收。

## Windows 工作區安全檔案預覽（2026-10-17）

- [NtCreateFile / ZwCreateFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwcreatefile)：RootDirectory 相對名稱、FILE_OPEN 與 FILE_OPEN_REPARSE_POINT；使用者模式透過 ntdll NtCreateFile。
- [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)：共享模式與開啟 reparse object；只共享讀取可能因現有寫入 handle 失敗。
- [GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)：以已開啟 handle 的 GUID volume path 拒絕子目錄磁碟別名，查詢失敗則拒絕。
- [GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandleex)：handle 上的目錄列舉及 FILE_STANDARD_INFO 硬連結數；不依賴檢查後重開完整路徑。
## 圖片輸入來源（2026-10-17）

固定官方來源 commit、版本與適用限制集中於 [圖片輸入來源](image-input.md#固定來源2026-10-17-查閱)。

## Terminal 同步重繪（2026-10-17）

- [xterm 6.0.0 release](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)：DEC 2026 synchronized output 為 6.0 新增功能；目前 5.5 安裝來源沒有此 mode 分支。
- [6.0 InputHandler](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/InputHandler.ts) 與 [RenderService](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/browser/services/RenderService.ts)：同步模式由 parser 與 renderer 協作，不宜以任意延遲或無上限 ANSI 字串緩衝代替。此次只調整既有 Poll 回應的傳輸批次，未升級依賴；來源查核不代表使用者問題已在原生 WebView 解決。

## 搜尋候選密度與查詢計畫（2026-10-17）

- [SQLite optimizer overview](https://www.sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join)：CROSS JOIN 固定左側迴圈在前；本次配合既有 messages_file index，避免 dense candidate-aware EXISTS 對每個 Session 重掃全體候選。實際 bundled SQLite query plan 另存於搜尋報告，不把 planner 選擇視為所有 SQLite 版本的效能保證。
- [SQLite FTS5 trigram tokenizer](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)：FTS trigram 用來縮小候選，本產品仍以原 literal predicate 驗證正文，保留 ASCII 大小寫、標點與多語語意。候選密度 probe 不修改 FTS 資料，也不縮小完整結果集。

### 活動事件查證（2026-10-17）
- [Codex protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)：TurnStartedEvent、TurnCompleteEvent、SessionConfiguredEvent。main 會變動；需正式版本驗證才可成為支援能力，不能假設 PTY 輸出提供相同事件。
- [Codex rollout recorder](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs)：追加與 flush 為持久化機制，不是與本機 PTY 綁定的活動 API。
- [OpenCode Server](https://docs.opencode.ai/docs/server/)：既有 HTTP server 的事件與 session API；SessionBay 未建立該 server 的身分與連線，不自動啟動。

## 原始對話永久刪除調查（2026-10-17）

- OpenCode v1.19.2 固定 commit `7901b7d325c34852caa84fc2c325f3a08dd7a473`，Grok Build 固定 commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`：官方契約、資料表、sidecar 與 CLI 限制的逐項來源見[調查](permanent-deletion-investigation.md)。不能套用到未知版本或視為已完成刪除 adapter。
- SQLite NOFOLLOW／HAS_MOVED／WAL／transaction 的官方依據見[安全分析](permanent-deletion-safety-review.md#官方來源)；Linux SQLite 3.46.1 和 3.53.1 的[合成負面探針](permanent-deletion-probes.md)不代表跨平台功能驗收。

## Windows ConPTY 關閉與測試隔離（2026-10-17）

- [Microsoft ClosePseudoConsole](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole)：24H2 起關閉 API 立即返回；輸出 reader 仍需排空到 EOF。實作讓輸入在初始 handshake 完成後釋放，輸出維持獨立排空。
- [Microsoft TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)：外部終止為非同步操作，應等待原始 process handle；對已終止程序重送可能取得 access denied。
- [Rust 1.99 libtest terminfo searcher](https://github.com/rust-lang/rust/blob/1.99.0/library/test/src/term/terminfo/searcher.rs)：TERMINFO、TERMINFO_DIRS 與預設 home／系統目錄的搜尋規則。Windows acceptance fixtures 明確限制搜尋到本次合成目錄，不依賴主機的終端資料庫。

## Windows installer 隔離驗收（2026-10-17 查閱）

- [GitHub hosted runner 規格與權限](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)：Windows disposable VM、x64／ARM64 labels 與管理員／UAC 預設。
- [GitHub runner 環境變數](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)：RUNNER_ENVIRONMENT 等執行環境防呆訊號。
- [NSIS command line](https://nsis.sourceforge.io/Docs/Chapter3.html)：正式 installer／uninstaller silent 參數及安裝路徑語法。
- [Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/)：currentUser NSIS 與 WebView2 封裝行為。適用範圍與限制見 [測試說明](windows-installer-smoke.md)。

### 檔案輸入真實接收核對（2026-10-17）

[檔案輸入驗收](file-input-validation.md)列出固定 Codex 0.163、OpenCode 1.19.3 與 Grok source、Claude 官方路徑工作流程及適用限制。staging 與 PTY bytes 不能替代 CLI composer 辨識與模型接收證據；尚未宣稱 Mac 驗收通過。
