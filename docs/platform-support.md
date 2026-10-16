# 原生三平台支援與驗收

更新：2026-10-16。本 PR 是 Windows／macOS／Linux 原生相容性工作；原生目錄 dialog 屬另一獨立 PR。下列「支援設計」不等同已通過實機驗收，實際結果集中在文末。

## 平台前提

| 平台 | 開發與執行前提 | 本輪原生驗收目標 |
| --- | --- | --- |
| Windows | Windows 10 1809+／Windows 11、WebView2、Node 24、Rust MSVC、Visual Studio Desktop development with C++ | Windows x64；ConPTY、NSIS、原生 WebView |
| macOS | macOS 12+、Xcode Command Line Tools、Node 24、固定 Rust | Apple Silicon／Intel 分別驗收 |
| Linux | Ubuntu 24.04 x64 基準、WebKitGTK 4.1、C/C++ build tools、CJK 字型、圖形工作階段 | 核心／PTY、deb、原生 WebKitGTK |

ConPTY 要求 Windows 10 1809+；Tauri 本身較低的最低 Windows 版本不適用於此 app 的 Terminal 功能。Windows ARM64／其他 Linux 發行版未納入這次驗收承諾。Windows build 使用原生 MSVC；Linux 的 GNU cross-check 只能提供部分編譯證據，不能當安裝、MSVC、WebView 或 ConPTY 實機通過。

共同指令：

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --no-default-features --all-targets -- -D warnings
npm run tauri -- dev
```

具備當前 OS 桌面依賴後，再執行完整 `cargo test --locked`、desktop Clippy 與 `npm run tauri -- build`。`scripts/tauri.mjs` 在當前 Node 程序補入 Cargo bin，再直接載入 Tauri CLI；支援 Windows `Path` 大小寫、空白／中文與自訂 `CARGO_HOME`，不透過 Shell 包裝參數。

Windows 預設建立 current-user NSIS installer，避免額外的 MSI／VBScript 開發前提：

```powershell
npm run tauri -- build --bundles nsis
./scripts/ci-windows-smoke.ps1
```

安裝器僅為未簽章開發產物。沒有發布、簽章、公證、停用 SmartScreen 或變更安全設定；若系統警告阻擋，請由使用者檢查來源並自行決定，不在自動化中繞過。

## 原生程序與來源安全

- 共用 RuntimeManager、事件／ACK 契約、UI 與索引；Unix PTY 與 Windows ConPTY 在平台模組實作。
- Unix 保留 `waitid(WNOWAIT)` 的 owned-child 身分與整個 PTY session 的 job-control group 清理；不改為以可能被重用的 PID 猜測所有權。
- Windows 以原始 child HANDLE 觀察退出／終止，包含合法 exit code 259。ConPTY reader、writer、console closer 與 supervisor 分離；每條 queue 有上限。大量貼上、輸出背壓或未 ACK 時仍可要求停止，關閉 ConPTY 時繼續排空輸出。
- portable-pty 0.9 會要求初始游標位置。後端回覆該次 query，避免 UI 尚未附接或啟動即關閉時阻塞；後續程式自身的游標 query 仍送給 xterm。
- ConPTY 管理附接同一 console 的後代；刻意 detached／new-console 程序不在所有權範圍，對應 Unix 刻意 `setsid` 脫離 session 的限制。不宣稱支援跨 app 重附接或退出 UI 後持續執行。
- Windows 歷史讀取以唯讀 handle、檔案 volume＋128-bit ID 驗證；拒絕不可靠身分、device／reparse leaf。Antigravity 維持路徑佈局與 metadata／transcript 雙重檢查；原始 SQLite 仍只複製到私密暫存再讀，無來源寫入或 sidecars。
- home、預設 PowerShell／cmd、PATH／PATHEXT、使用者安裝目錄皆按 Windows 處理。既有 Unix Profiles 不自動改寫；從另一 OS 搬入設定後，失效執行檔需重新指定。

## CLI 相容性與限制

截至查閱日，四者官方均提供原生 Windows 版本：

| CLI | Windows 官方依據 | Session Bay 邊界 |
| --- | --- | --- |
| Codex | [Windows](https://developers.openai.com/codex/windows) | 使用官方 native binary；npm wrapper 不是任意 batch 執行授權 |
| Claude Code | [Setup](https://code.claude.com/docs/en/setup) | 遵循該版本的 PowerShell／Git Bash 前提 |
| Grok Build | [Overview](https://docs.x.ai/build/overview) | 官方 PowerShell 安裝，資料來源仍需與實際版本核對 |
| Antigravity CLI | [Installation](https://www.antigravity.google/docs/cli/install/) | `%LOCALAPPDATA%\agy\bin` native binary；1.3.5 歷史樣本／接續仍待驗 |

Windows 只找到 `.cmd`／`.bat` 時回傳明確診斷，請選原生 `.exe`。不拼接 cmd.exe 命令字串、不猜 npm wrapper 內部佈局，也不因檔案存在就顯示可啟動。executable、argv、cwd 分開傳入；版本探測仍使用固定 argv 與時間／輸出上限，去除 PTY 控制字元後才判斷非空版本。ConPTY 初始化前固定 process-local DLL search 到 application directory／System32，拒絕 CWD／PATH shadow DLL；失敗不啟動。

上游提供安裝方式不代表本 app 已驗證四工具的所有平台／版本。真實登入、新工作、手動／索引 resume、權限提示、中文 IME 與長時間互動必須逐一驗證。歷史 parser 的支援也不等於每個新上游 schema 都相容。

## 手動原生驗收

`.github/workflows/ci.yml` 僅由 `workflow_dispatch` 啟動，包含 Linux、macOS ARM64、macOS Intel、Windows x64。同一提交的四個 jobs 必須全部成功才算三 OS CI 通過。保留單一自動 Linux 輕量 workflow；本 PR 不手動執行、增加自動 paid matrix、修改帳務或 required checks。

Windows workflow 執行完整 Rust tests／Clippy、NSIS build，再以 `ci-windows-smoke.ps1` 檢查：

- dark／light 各一次，原生 window handle 存在且持續存活
- WebView `ready`、DOM interaction 與 backend IPC marker，無 frontend error
- 獨立暫存 app-data，預先保存空來源完整設定；不讀 runner 的真實 home 歷史
- stdout／stderr 同時排空，逾時必清理本次 app 及其 child tree

此 smoke 沒有執行 installer、沒有擷取／驗證像素，也沒有真實 Agent／Terminal 互動。ConPTY 另由 Windows 專屬 Rust synthetic fixture tests 檢查，不依賴安裝 Agent 或放寬 PowerShell policy。

原生人工驗收至少包含：

- [ ] Windows 10 1809+／Windows 11 安裝、啟動、移除；WebView2 缺失／已安裝情境
- [ ] 三平台 Shell 輸入、貼上、Unicode／中文 IME、resize、Ctrl+C、兩個可見 PTY
- [ ] 32 個 runtime 上限、duplicate launch、停止／退出、輸出背壓、阻塞貼上、child tree 清理
- [ ] 中文／空白／特殊字元專案路徑，Windows drive／UNC 路徑依實際磁碟與 ACL 驗證
- [ ] 四工具 native executable 偵測、版本、新工作／索引接續，缺執行檔與 batch-only 診斷
- [ ] 歷史檔替換、來源改向、metadata 不一致；未知格式明確警告，原始來源 hash 不變
- [ ] macOS ARM64／Intel 與 Linux 現有原生 smoke、圖示與既有平台回歸

## 本輪已執行與限制

Linux cloud：前端 401 個、Rust core 248 個測試，以及 typecheck／lint／build／fmt／strict Clippy 通過。正式 repo Windows GNU target 包含 Tauri desktop 的 all-target check／strict Clippy、bundled SQLite 與所有 core test executables 交叉連結通過；未執行 Windows 二進位檔。完整範圍見 [MVP 驗收紀錄](mvp-validation.md)。

此環境沒有 Windows／macOS 原生執行器，也沒有 WebKitGTK 開發套件。未執行的原生 MSVC／macOS／Linux desktop build、installer、WebView／ConPTY 及真實 CLI 驗收一律保持待驗；保留 Draft 不等於已可合併或發行。
