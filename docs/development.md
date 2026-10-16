# Session Bay 開發與試用

本機優先的 macOS／Linux 工作台。可啟動你原先已安裝並登入的 Codex CLI、Claude Code、Grok Build 或 Antigravity CLI（`agy`）；即使未安裝 Agent，普通 Shell 與已存在的歷史仍可分開使用。

## 平台與工具

- macOS 最低建置目標設定為 12+（尚待原生驗收）；Apple Silicon 與 Intel 分開建置。安裝 Xcode Command Line Tools：`xcode-select --install`。
- Linux 以 Ubuntu 24.04 x64 作 CI／打包基準；開發驗證環境另見驗收紀錄。需要圖形工作階段（X11 或 Wayland）及 WebKitGTK 4.1。
- Node.js 24／npm；Rust 使用根目錄 `rust-toolchain.toml` 固定版本。第一次 Cargo 執行會由 rustup 取得工具鏈。
- `npm run tauri` 會在目前支援的 macOS／Linux 上，將 `${CARGO_HOME:-$HOME/.cargo}/bin` 放到子程序 PATH 前端，使用 rustup 的專案工具鏈；此設定僅作用於該次指令。
- Git clone 後在 repo 根目錄執行，不需要修改 Agent 的資料庫或登入設定。

Ubuntu 24.04 桌面相依套件：

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev librsvg2-dev patchelf fonts-noto-cjk
```

繁體中文介面需要 CJK 字型。Ubuntu 24.04 的 CI 與 `.deb` 安裝相依套件包含官方 `fonts-noto-cjk`，介面使用本機 `Noto Sans CJK TC` fallback，不下載網路字型。請用 `sudo apt install ./Session\ Bay_0.1.0_amd64.deb` 安裝可信建置的套件，讓 apt 一併處理字型與 WebKitGTK 等相依套件；直接解壓或單獨啟動 binary 不會安裝相依套件。Tauri 會保留預設桌面相依套件並加入額外的 `deb.depends`，見 [官方 Debian 打包說明](https://v2.tauri.app/distribute/debian/) 與 [Ubuntu Noto CJK 套件](https://packages.ubuntu.com/source/noble/fonts-noto-cjk)。

其他發行版請對照 [Tauri 官方 prerequisites](https://v2.tauri.app/start/prerequisites/)。不能把任意 Linux distro 視為已驗證。

## 啟動與打包

```bash
npm ci
npm run dev

# 當前平台的開發產物
npm run tauri -- build
# Linux 僅建立 deb
npm run tauri -- build --bundles deb
# macOS 僅建立 app bundle
npm run tauri -- build --bundles app
```

產物在 `src-tauri/target/release/bundle/`。未簽章／未公證開發產物不等同公開發行，勿停用系統安全檢查來安裝來源不明的檔案。自行從可信原始碼建置適合這一階段試用。

`npm run dev` 會執行 `npm run tauri -- dev`，並由 Tauri 呼叫 `npm run dev:web` 啟動前端。

`npm run dev:web` 只啟動前端網頁預覽；畫面會明確提示沒有桌面 Runtime，不生成假 Sessions 或假 Terminal。

## macOS 圖示維護

macOS 使用 `src-tauri/icons/icon-macos.svg` 與 `icon.icns`：原圖等比縮至 412×412，置中於 512×512 透明畫布。這是改善 Cmd+Tab／Dock 視覺占比的專案選擇，不是 Apple 規定的 ICNS 留白比例。原始 `icon.svg`、Linux PNG 與 Windows ICO 維持原設計。

安裝既有 npm dependencies 並備妥 Python 3 後，在 repo 根目錄執行：

```bash
node scripts/generate-macos-icon.mjs
python3 scripts/validate-macos-icon.py src-tauri/icons/icon.icns
# 選用：將前後比較 PNG 存在 repo 外的絕對路徑
node scripts/generate-macos-icon.mjs --preview-dir /tmp/sessionbay-icon-preview
```

腳本由原始 SVG 派生 macOS 向量，使用已安裝的 Tauri icon CLI 輸出至暫存目錄，驗證 ICNS 後只複製 macOS 檔案；SHA-256 比對確認其他圖示資產不變。不要直接對預設 icons 目錄重建全平台圖示，以免覆寫各平台設計。獨立 validator 檢查各尺寸 alpha 邊界；它與建置通過都不能代替 macOS 實際 Cmd+Tab／Dock 視覺比較。

官方依據與適用限制見[圖示決策](decisions.md#2026-10-15-macos-圖示視覺尺寸修正)及[資料來源](sources.md#macos-圖示與產生流程)。

## 第一次使用

1. 開啟「設定與資料來源」。四 Agent 的能力卡片固定可見，與是否啟動過或找到執行檔無關；四工具可設定資料根目錄後啟用索引；Antigravity 只涵蓋 CLI，來源預設 ~/.gemini/antigravity-cli，App／IDE 不混用。舊設定以「偵測歷史來源」明確加入後保存。
2. 全新設定的預設來源尊重 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`GROK_HOME`；否則為 `~/.codex`、`~/.claude`、`~/.grok`。升級保留既有來源清單；若缺少 Grok，使用卡片設定入口新增草稿，填入絕對路徑並明確保存，不會猜測 home 或自動新增索引根目錄。欄位輸入完整絕對路徑，依工具包含 `sessions`／`archived_sessions`、`projects` 或 Grok 的 `sessions`。
3. 每個來源有獨立 ID。同一 Agent 的相同 canonical root 不可重複；不同來源同名 Session 不會被合併。
4. 預設開啟「專案」總覽，管理自己加入的目錄；切到「所有目錄」可看所有有 Session 的分組，包含未知或失效路徑。兩頁都有卡片與側欄，選擇一組後才搜尋該目錄歷史；掃描不自動加入專案，總覽不混列各目錄的 Session。中文以連續子字串匹配；英文 ASCII 不分大小寫，`%`、`_` 不當 SQL wildcard；不提供模糊或語意搜尋。3 字元以上使用 compact trigram 候選索引再精確驗證，不足 3 字元掃描匹配。
5. 點選對話只預覽，不啟動 CLI。接續時才會啟動原工具，沿用 CLI 權限及登入流程。
6. 新增 Terminal 或左右／上下分割，兩邊各自有 PTY。切換分頁不結束程序；關閉面板／退出應用需確認結束受管程序。
7. 重開只恢復布局占位，點「重新開啟」才執行。普通 Terminal 中手動啟動 Agent 不自動與歷史關聯。

普通 Shell 執行 `exit` 且以結束碼 `0` 正常離開時，面板會自動關閉；若是最後一個面板，該工作區分頁也會關閉。Agent、非零／未知結束碼與錯誤保留診斷畫面；重開後的布局占位不因此自動移除。

## 管理自己的專案清單

- **加入既有目錄**：填入已存在的絕對路徑，可另填顯示名稱；相同 canonical 目錄沿用同一專案。沒有歷史也能加入後開始新工作。
- **建立新專案**：填入已存在父目錄的絕對路徑及一個新資料夾名稱。只建立該層資料夾；目標已存在、父目錄不存在或名稱含多層路徑時會報錯，不覆寫、不遞迴建立。
- **從歷史加入**：在所有目錄選擇分組，從目錄或對話預覽對可用目錄按「加入專案」。加入不啟動 CLI；直接接續也不自動加入專案。
- **移出專案**：僅取消清單會員資格與釘選；原目錄、歷史、搜尋結果及執行中程序均保留。未加入或移出的已開啟工作區在兩頁仍有獨立入口。
- **置頂**：保留 `pinned` 作為自選專案內的排序偏好；取消置頂不會移出專案。
- **保存與升級**：加入狀態、名稱及釘選保存在自有 catalog；舊版手動加入或釘選項會保留為自選專案，其餘有 Session 的掃描目錄仍可在所有目錄找到。

此版尚無原生目錄選擇器，請輸入完整絕對路徑，不使用 `~` 或相對路徑。專案更名只改顯示名稱；搬移後請用原有「重新定位」，仍保留原始 cwd／transcript。

本次變更在隔離雲端使用合成資料與暫存路徑驗證，不存取使用者真實電腦或 Agent 歷史。具體測試結果與尚待驗收範圍見[變更紀錄](mvp-validation.md#2026-10-15-雙頁導覽來源入口與-macos-圖示修正)。

## 工具與 Shell 重新偵測

設定中的 Agent「重新偵測」使用已保存的執行檔設定取得安裝／版本資訊；修改後先保存。這不會讀取歷史，歷史來源的「重新掃描」是另一個動作。工具與能力清單由前後端共用的 `src/agent-manifest.json` 定義，仍需內建 parser 才能支援歷史。

新增工作先選普通 Shell 或 Agent，再以帶標誌的下拉清單選 Agent。搜尋 Session 預設快捷鍵為 macOS `Cmd+Shift+F`／Linux `Ctrl+Shift+F`，已有選定目錄時保留其範圍；未選目錄時，主動使用此快捷鍵或全域搜尋按鈕可查跨目錄對話。兩頁預設仍呈現目錄分組總覽。

全新 Shell Profile 使用有效、已存在的絕對 `$SHELL`，否則 macOS 選 `/bin/zsh`、Linux 選 `/bin/bash`，預設 args 為 `["-l"]`。這不是匯入 Terminal.app／iTerm 等應用的 Profile，也不複製 `.zshrc`／`.bashrc`；啟動後由 Shell 自行載入適用啟動檔。

Shell「重新偵測」只列候選，由你選擇加入 Profile 並保存，保留既有自訂 Profiles、參數、環境變數及預設項。不需為了更新候選清單重設整份設定。

## 自訂 Agent 啟動參數

在「設定與資料來源」中，四個 Agent 都有獨立執行檔與參數設定。參數填 JSON 字串陣列，例如 `["--model", "your-model-id"]`，不要填整條命令或 Shell 引號。選項只接受後端支援的白名單；目錄、來源與 Session ID 由應用管理。設定會明文保存在本機，請勿填入密碼、API key 或 token。

如需減少工具的權限提示，閱讀風險說明後明確勾選該 Agent 的高風險選項並保存。它預設關閉，勾選後跨重開沿用，不必每次在 Session Bay 重複確認；CLI 自身登入、工作區信任或政策仍可能要求操作。Codex 的預設會同時取消審批與沙箱；Grok 的預設只自動核准工具，沙箱另行設定。各工具實際旗標與自訂權限模式優先規則見 [Agent 整合規格](agent-integrations.md#每個-agent-的自訂參數與危險模式)。

新增工作選擇 Agent 後，查看後端產生的 executable、argv 陣列與 cwd 預覽；預檢失敗需先修正。Grok／Antigravity 可以手動填入原工具的 ID 接續；留空開始新工作。手動輸入 Antigravity ID 不會建立虛構 catalog 紀錄，實際載入結果以原 CLI 為準；由索引接續另驗證原生來源與對話身份。預覽不執行命令，啟動時會重新檢查。

## Session 名稱

已命名的 Session 優先顯示原工具名稱；Codex 從設定來源 root 的 `session_index.jsonl` 讀取名稱，Claude 從 transcript 的自訂標題或摘要讀取。沒有名稱時，使用首則實際工作需求，略過已知的初始化指令與環境區塊；原始對話仍可完整預覽與搜尋。

在支援版本的 Codex／Claude Code 內可用 `/rename 修正登入流程` 命名。回到 Session Bay 按「更新索引」即可反映，不需重新建立整份索引。更新 parser 後第一次掃描會重新解析舊 checkpoint，可能比一般增量更新久；後續恢復增量處理。Session Bay 只讀取名稱，不修改原工具的歷史或名稱檔。詳見 [Codex 命令](https://learn.chatgpt.com/docs/developer-commands)與 [Claude Code 命名說明](https://code.claude.com/docs/en/sessions#name-your-sessions)。

## 來源與相容性

- Codex：解析 `session_meta`、`response_item` 與支援的 `event_msg` JSONL，啟動使用 `codex resume <id> --cd <cwd>`；資料 root 透過 `CODEX_HOME` 傳入。
- Claude Code：解析 `projects` 內的 user／assistant transcript JSONL，保留 parent／子代理關係；啟動使用 `claude --resume <id>`，獨立 cwd 與 `CLAUDE_CONFIG_DIR`。
- Grok Build：唯讀解析 `sessions/<encoded-cwd>/<session-id>/summary.json` 與 `updates.jsonl` 的支援訊息／rewind 事件；使用 `grok --resume <id>`、獨立 cwd 與選中來源的 `GROK_HOME`。
- Antigravity CLI：使用 `agy` 新建或 `agy --conversation <id>` 接續；支援 CLI metadata／持久化 transcript 的防禦讀取與預覽。備份來源只讀、缺 cwd 需明確選擇；1.3.5 實際資料仍待驗證，不涵蓋 App／IDE。見[相容性說明](antigravity-cli-history.md)。
- CLI 格式不是本專案保證穩定的公開資料 API。實際版本相容性與尚未驗證項目列於驗收紀錄，不能把合成 fixture 通過等同真實版本已驗證。
- 成功 spawn 只表示「已啟動，待確認 Session」，不表示原工具已載入正確對話。外部已啟動的程序狀態未知，不會被自動附接或關閉。
- 同來源多個 transcript 同 ID、跨來源同 ID 造成 CLI 歧義、來源遺失或身分衝突時，恢復會被阻擋；先修正資料來源後重新索引。
- 目前不提供 fork 副本、雲端／IDE 歷史、daemon 附接、用量分析、外掛或同步。

## 本機資料與隱私

Session Bay 的索引與設定寫入自己的 app data directory，identifier 為 `dev.sessionbay.desktop`。使用者明確執行「建立新專案」時，另在指定父目錄下建立一個新資料夾；加入既有目錄與移出專案不更動工作檔：

- macOS：通常 `~/Library/Application Support/dev.sessionbay.desktop/`
- Linux：通常 `$XDG_DATA_HOME/dev.sessionbay.desktop/`，未設定時 `~/.local/share/dev.sessionbay.desktop/`

實際位置由 Tauri platform path 決定。包含 `catalog.sqlite`、`settings.json`、`workspace.json`；目錄權限 0700、設定／索引 0600。SQLite、WAL 與索引可能包含對話內容，請當成私人資料，勿提交版控或分享。

搜尋／預覽不連接模型服務。Agent／Shell 程序啟動後仍依原本權限與設定使用網路、讀寫工作檔與自己的歷史。Session Bay 不管理 CLI 登入憑證；只有使用者對該 Agent 明確啟用高風險選項後，才容許需要同意的參數並按設定加入工具專屬預設。預設不追加 bypass，但不覆寫 CLI 自己既有的權限設定。Shell Profile 的自訂環境變數會以明文保存在本機設定檔，請勿在此填入密碼／API key，應交由原工具管理。

- 清除索引只清除可重建衍生資料，保留設定及自選專案的加入狀態、名稱、釘選與重新定位，不修改來源。移出專案不會清除索引。
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

較完整的多訊息／生命週期基準使用 `index_lifecycle_benchmark`，參數依序為 Session 數、每個 Session 近似 KiB、訊息數，可加 `duplicates` 產生 Codex fallback／canonical 雙份紀錄。它分測空索引、三次未變更補掃、單檔追加、同大小重寫與五類搜尋，並檢查來源內容及可見訊息數。大型資料請把 `TMPDIR` 指向空間充足的磁碟，而非小型 tmpfs；建議至少預留 8 GiB。

```bash
cargo run --release --locked --manifest-path src-tauri/Cargo.toml \
  --no-default-features --example index_lifecycle_benchmark -- 1000 100 20
```

同環境 before／after、10k／長對話指令、記憶體欄位與尚未達標的搜尋情境見[索引效能量測](index-performance.md)。這些資料不能代替使用者真實來源與原生 UI 驗收。

## CI 省額度模式

日常自動檢查由 `.github/workflows/light-checks.yml` 執行：本 repo 的 branch push 只跑一個 Ubuntu 24.04 job，不同時監聽 pull_request。結果仍附在同 repo PR 的 commit 上；同 branch 較新的程式提交會取消較舊的自動檢查。它驗證 branch head，不是合成 merge commit；fork PR 或只有 base branch 更新的整合相容性需另外安排，不假裝已覆蓋。

輕量工作包含 `npm ci`、typecheck／lint／前端 tests／build、兩個 Python 靜態 validator、Rust fmt 與 `--locked --no-default-features` 的核心 tests／Clippy。不安裝桌面 GUI 相依套件，不執行 Tauri release build、macOS runner 或原生 smoke；首次 Rust 工具鏈／依賴下載仍會使用時間，輕量不代表免費或完整桌面驗收。

自動 push 的 `paths-ignore` 僅包含 `README.md` 和 `docs/*.md`。一般僅修改這些文件時，在配置 runner 前略過；`docs/` 內其他格式／更深路徑、scripts、fixtures、skills、設定、workflow 都不忽略。GitHub 對大量 commits、diff 逾時或檔案列表上限有特殊規則，不能保證每種大型變更都零 run。純文件被略過不會產生新的通過證據；若把這個檢查設成 required，缺少 check 可能讓合併保持 pending。此 PR 不改 branch protection 或 required checks。

完整驗收保留在原 `.github/workflows/ci.yml`，名稱為 **Desktop acceptance (manual)**，只接受 `workflow_dispatch`，不由 push／PR 自動執行。它沒有會被日常檢查或另一個 pending run 取代的 concurrency group；手動觸發會使用三個 runner，請只在需要桌面交付／驗收時由有權限的人明確操作，不要連續重複派送。

GitHub 的 **Run workflow** UI 要求工作流程檔已在 default branch。2026-10-15 本次合併授權前的唯讀檢查確認 main 尚無 `.github/workflows`，當時不能保證未合併 PR 已有手動按鈕或 API／CLI 可派送。流程檔正常納入 default branch 後，仍須帳務可用並明確選擇目標 branch/ref，才執行完整驗收。使用者後續已接受 PR 並授權合併；不會因此代為觸發完整流程、調整帳務或提高額度。

目前 Annotations 已確認 Billing & plans 的帳務／spending limit 限制。這表示工作未開始，並非測試通過或程式測試失敗；新的 Linux workflow 仍可能因同一限制無法啟動。未跑的三平台打包／原生 smoke 維持待驗收，不能用 Linux 核心通過替代。

官方行為與限制：[Git diff 與 path filters](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#git-diff-comparisons)、[手動執行 workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[Concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

### 完整手動驗收產物

`.github/workflows/ci.yml` 手動執行時會檢查 Ubuntu 24.04、macOS 15 ARM64／Intel，並保存未簽章 artifact，不建立公開 release。macOS `.app` 先封裝成 `.tar.gz` 以保留 executable permissions／symlinks；下載 artifact ZIP 後還需解開內層 tar。Linux 保存 `.deb`。兩 OS 的 smoke 使用空白暫存 HOME、明確的 SESSIONBAY_SMOKE=1，等待 React DOM、backend bootstrap 與實際設定對話框開關／重開的訊號；啟動前模組錯誤、CSP 違規與未處理例外會使測試失敗。Linux Xvfb 無 GPU，僅在 CI 設 WEBKIT_DISABLE_COMPOSITING_MODE=1 使用軟體合成，沒有停用 WebKit sandbox 或放寬 CSP。Linux 再擷取 PNG 並拒絕純色畫面，仍需人工檢視截圖。macOS 不申請螢幕錄製／Accessibility 權限，DOM 操作通過也不宣稱已驗證畫面像素。這些 smoke 不取代 IME／真實 CLI／完整終端互動驗收。Private repo Actions 可能消耗帳號額度；只有實際 workflow run 成功才表示該平台通過。

Artifact 封裝依據：[actions/upload-artifact v4 的 permission-loss 限制](https://github.com/actions/upload-artifact/blob/v4/README.md#permission-loss)。

## 疑難排解

- Tauri CLI 在 `interface/rust.rs` 出現 `Option::unwrap()` panic：先檢查 `rustc -vV` 是否正常輸出 `host:`。本機曾遇到 PATH 選到缺少 LLVM 動態函式庫的 Homebrew Rust，導致 Tauri 取得空輸出；專案 npm 指令已優先選取 rustup。若仍失敗，檢查 `CARGO_HOME` 與 rustup 安裝，確認可取得 `rust-toolchain.toml` 指定版本。Rust 安裝方式見 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#rust)。
- 找不到 CLI：在設定填可執行檔絕對路徑。桌面 GUI 的 PATH 可能和 terminal 不同；本應用另搜尋 Homebrew、`~/.local/bin`、`~/.cargo/bin` 等常見位置。
- 參數保存失敗：確認格式為 JSON 字串陣列，使用支援選項，並分開傳入參數和值；需同意的權限選項必須先勾選。取消勾選時要一併移除仍需同意的參數。
- 舊設定只有 Codex／Claude 來源：升級刻意保留來源，與是否啟動過其他 Agent 無關。在 Grok 卡片建立來源草稿、填入絕對路徑並保存；原來源的 ID、root 與 enabled 不會因此改變。
- Antigravity 沒有歷史清單：先確認資料來自 CLI，不是 App／IDE；舊設定需偵測或新增 ~/.gemini/antigravity-cli 來源並儲存／掃描。查看來源錯誤、未知 schema 與截斷警告；找到執行檔不證明來源可讀或已登入。
- 有歷史沒工具：仍可搜尋預覽，指定工具後才能接續。
- 工具有但無歷史：加入專案並開新工作即可；不存在的預設來源不會當成整批失敗。
- 有歷史但左側專案空白：這是完整歷史與自選專案分開的預期行為；切到所有目錄、選組後加入，或用新增入口加入既有目錄／建立新專案。
- 新專案建立失敗：確認父目錄存在、使用絕對路徑且有寫入權限，名稱只含一層，目標尚不存在；既有資料夾請改用「加入既有目錄」。
- 專案移動：使用「重新定位」，保留原始 cwd／transcript，不改寫歷史。
- 索引中修改設定：先取消索引，等狀態完成後再保存。取消不清空已完成 checkpoint，手動更新可重新開始。
- 對話標示已變更：重新掃描後再預覽，避免拿舊 byte locator 讀取新檔案。
- 設定／布局損壞：使用預設值並顯示警告，原檔保留；修復後再手動保存。較新 schema 不會被開啟／未變更退出自動覆寫；在恢復後改動布局或明確保存設定會建立目前支援版本，請先保留原檔備份。
- PTY 超過 30 秒未收到前端消費 ACK：停止該程序並報錯，防止失控輸出累積；正常背景分頁仍會解析與 ACK。
- Linux 缺 WebKit／GTK：安裝上面的官方 distro 套件；不要停用系統沙箱來繞過啟動錯誤。
