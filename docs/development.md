# Session Bay 開發與試用

本機優先的 macOS／Linux 工作台。需要你原先已安裝並登入的 Codex CLI 或 Claude Code；即使未安裝 Agent，普通 Shell 與已存在的歷史仍可分開使用。

## 平台與工具

- macOS 最低建置目標設定為 12+（尚待原生驗收）；Apple Silicon 與 Intel 分開建置。安裝 Xcode Command Line Tools：`xcode-select --install`。
- Linux 以 Ubuntu 24.04 x64 作 CI／打包基準；開發驗證環境另見驗收紀錄。需要圖形工作階段（X11 或 Wayland）及 WebKitGTK 4.1。
- Node.js 24／npm；Rust 使用根目錄 `rust-toolchain.toml` 固定版本。第一次 Cargo 執行會由 rustup 取得工具鏈。
- Git clone 後在 repo 根目錄執行，不需要修改 Agent 的資料庫或登入設定。

Ubuntu 24.04 桌面相依套件：

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev librsvg2-dev patchelf
```

其他發行版請對照 [Tauri 官方 prerequisites](https://v2.tauri.app/start/prerequisites/)。不能把任意 Linux distro 視為已驗證。

## 啟動與打包

```bash
npm ci
npm run tauri -- dev

# 當前平台的開發產物
npm run tauri -- build
# Linux 僅建立 deb
npm run tauri -- build --bundles deb
# macOS 僅建立 app bundle
npm run tauri -- build --bundles app
```

產物在 `src-tauri/target/release/bundle/`。未簽章／未公證開發產物不等同公開發行，勿停用系統安全檢查來安裝來源不明的檔案。自行從可信原始碼建置適合這一階段試用。

`npm run dev` 只啟動前端網頁預覽；畫面會明確提示沒有桌面 Runtime，不生成假 Sessions 或假 Terminal。

## 第一次使用

1. 開啟「設定與資料來源」。確認 Codex／Claude 可執行檔及資料根目錄，然後啟用索引。
2. 預設來源尊重 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`；否則為 `~/.codex`、`~/.claude`。欄位輸入完整絕對路徑，資料根目錄包含 `sessions`／`archived_sessions` 或 `projects`。
3. 每個來源有獨立 ID。同一 Agent 的相同 canonical root 不可重複；不同來源同名 Session 不會被合併。
4. 選擇專案，或用「所有 Session」搜尋。中文以連續子字串匹配；英文 ASCII 不分大小寫，`%`、`_` 不當 SQL wildcard；不提供模糊或語意搜尋。3 字元以上使用 compact trigram 候選索引再精確驗證，不足 3 字元掃描匹配。
5. 點選對話只預覽，不啟動 CLI。接續時才會啟動原工具，沿用 CLI 權限及登入流程。
6. 新增 Terminal 或左右／上下分割，兩邊各自有 PTY。切換分頁不結束程序；關閉面板／退出應用需確認結束受管程序。
7. 重開只恢復布局占位，點「重新開啟」才執行。普通 Terminal 中手動啟動 Agent 不自動與歷史關聯。

## 來源與相容性

- Codex：解析 `session_meta`、`response_item` 與支援的 `event_msg` JSONL，啟動使用 `codex resume <id> --cd <cwd>`；資料 root 透過 `CODEX_HOME` 傳入。
- Claude Code：解析 `projects` 內的 user／assistant transcript JSONL，保留 parent／子代理關係；啟動使用 `claude --resume <id>`，獨立 cwd 與 `CLAUDE_CONFIG_DIR`。
- CLI 格式不是本專案保證穩定的公開資料 API。實際版本相容性與尚未驗證項目列於驗收紀錄，不能把合成 fixture 通過等同真實版本已驗證。
- 成功 spawn 只表示「已啟動，待確認 Session」，不表示原工具已載入正確對話。外部已啟動的程序狀態未知，不會被自動附接或關閉。
- 同來源多個 transcript 同 ID、跨來源同 ID 造成 CLI 歧義、來源遺失或身分衝突時，恢復會被阻擋；先修正資料來源後重新索引。
- 目前不提供 fork 副本、雲端／IDE 歷史、daemon 附接、用量分析、外掛或同步。

## 本機資料與隱私

Session Bay 的索引與設定只寫自己的 app data directory，identifier 為 `dev.sessionbay.desktop`：

- macOS：通常 `~/Library/Application Support/dev.sessionbay.desktop/`
- Linux：通常 `$XDG_DATA_HOME/dev.sessionbay.desktop/`，未設定時 `~/.local/share/dev.sessionbay.desktop/`

實際位置由 Tauri platform path 決定。包含 `catalog.sqlite`、`settings.json`、`workspace.json`；目錄權限 0700、設定／索引 0600。SQLite、WAL 與索引可能包含對話內容，請當成私人資料，勿提交版控或分享。

搜尋／預覽不連接模型服務。Agent／Shell 程序啟動後仍依原本權限與設定使用網路、讀寫工作檔與自己的歷史。Session Bay 不管理 CLI 登入憑證，不加入跳過權限旗標。Shell Profile 的自訂環境變數會以明文保存在本機設定檔，請勿在此填入密碼／API key，應交由原工具管理。

- 清除索引只清除可重建衍生資料，保留設定及手動專案，不修改來源。
- 移除／停用來源後重新索引會同步清理該來源的衍生內容。
- 所有 transcript 以純文字呈現，不執行 HTML 或自動抓取遠端圖片。終端 OSC52 剪貼簿控制序列被封鎖。
- 面板關閉以應用擁有的 Unix session／process groups 為清理範圍；刻意自行 daemonize 的程序另有生命週期，不假裝能可靠收回。
- Leader 由單一 worker 持有並延後 reap，以保留其 PID；後代 job-control group 在發訊號前重新檢查 session 成員。Unix 的成員查詢與 group signal 並非原子操作，對刻意競速改換群組的同使用者惡意程序仍有 check/use 競態；這不是執行不可信程式的安全沙箱。

## 檢查與測試

```bash
npm run typecheck
npm run lint
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --no-default-features --all-targets -- -D warnings
# 有桌面依賴的機器，去掉 --no-default-features 重新測試與檢查
```

合成索引基準（不讀真實歷史）：

```bash
cargo run --release --manifest-path src-tauri/Cargo.toml \
  --no-default-features --example catalog_benchmark -- 1000 100
```

第一個參數為 Session 數，第二個為每個 Session 的近似 KiB。結果含實際來源 bytes、索引耗時、未變更補掃、20 次查詢 p50／p95；不是 WebView 互動或整體記憶體量測。

`.github/workflows/ci.yml` 會檢查 Ubuntu 24.04、macOS 15 ARM64／Intel，並保存未簽章 artifact，不建立公開 release。macOS `.app` 先封裝成 `.tar.gz` 以保留 executable permissions／symlinks；下載 artifact ZIP 後還需解開內層 tar。Linux 保存 `.deb`。Linux job 額外在空白暫存 HOME 的 Xvfb 啟動原生視窗並擷取 PNG，沒有停用 WebKit sandbox；這是視窗 smoke，不取代互動式驗收。Private repo Actions 可能消耗帳號額度；只有實際 workflow run 成功才表示該平台通過。

Artifact 封裝依據：[actions/upload-artifact v4 的 permission-loss 限制](https://github.com/actions/upload-artifact/blob/v4/README.md#permission-loss)。

## 疑難排解

- 找不到 CLI：在設定填可執行檔絕對路徑。桌面 GUI 的 PATH 可能和 terminal 不同；本應用另搜尋 Homebrew、`~/.local/bin`、`~/.cargo/bin` 等常見位置。
- 有歷史沒工具：仍可搜尋預覽，指定工具後才能接續。
- 工具有但無歷史：加入專案並開新工作即可；不存在的預設來源不會當成整批失敗。
- 專案移動：使用「重新定位」，保留原始 cwd／transcript，不改寫歷史。
- 索引中修改設定：先取消索引，等狀態完成後再保存。取消不清空已完成 checkpoint，手動更新可重新開始。
- 對話標示已變更：重新掃描後再預覽，避免拿舊 byte locator 讀取新檔案。
- 設定／布局損壞：使用預設值並顯示警告，原檔保留；修復後再手動保存。較新 schema 不會被開啟／未變更退出自動覆寫；在恢復後改動布局或明確保存設定會建立目前支援版本，請先保留原檔備份。
- PTY 超過 30 秒未收到前端消費 ACK：停止該程序並報錯，防止失控輸出累積；正常背景分頁仍會解析與 ACK。
- Linux 缺 WebKit／GTK：安裝上面的官方 distro 套件；不要停用系統沙箱來繞過啟動錯誤。
