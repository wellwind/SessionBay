# Terminal Shift＋Enter

## 使用方式

自 2026-10-17 起，依使用者選擇，所有 Terminal 的 Shift＋Enter 一律使用 CSI-u（Agent 相容），傳送 `ESC [ 13 ; 2 u`，保留 Shift 修飾鍵。包含 Shell、所有內建 Agent、未知工具及 Windows Codex，不需要先選模式，也不從啟動來源或前景輸出推測。

輸入留在 Terminal，不開啟草稿視窗，面板不顯示模式選單或按鍵說明。一般 Enter 與貼上行為不變；重連、重新啟動及重開介面後仍使用同一編碼。沒有新增設定、保存逐 runtime 模式，或改動 Shell／Agent 的設定檔。

CSI-u 編碼一致，不代表任意 Shell／CLI 都能將它解讀為換行。未支援的程式可能忽略或顯示部分編碼；應用程式的模式、自訂 keymap 仍決定實際動作。Windows Codex 的 Console InputRecord 路徑尚未驗證，Grok 多行模式也可能將此鍵當送出。下列版本證據與限制仍適用。

## 行為與安全邊界

- 只攔截沒有 Ctrl／Alt／Meta 的 Shift＋Enter。只在 keydown 送一次，keypress／keyup 不再送；按住重複按鍵依每次 keydown 傳送一個 modified key。
- 送出的是按鍵編碼，沒有 LF／CR，也不額外送 Enter。這不是「任意程式都不會送出」的保證；例如 Grok 的官方多行模式故意把 Shift＋Enter 當送出。
- IME composition、isComposing 不攔截；CapsLock 的既有修正保留。組字外的 keyCode 229 只略過 xterm 的 textarea diff（不取消原生事件），由 `TerminalImeCommitGuard` 以 compositionend／input 的 data 送出一次，見 [decisions](decisions.md)。一般 Enter、其他修飾鍵、貼上與 bracketed paste 不改寫。
- 相容按鍵經公開的 xterm.input API 和既有有界輸入佇列，沒有直接繞過 API 寫 PTY。必須是可見且聚焦的面板與 Terminal 輸入框，snapshot 完成且目標 runtime 存活、已連線；開著阻擋式對話框、退出或連線中斷時不送。
- Shift＋Enter 保留給 Terminal 輸入，不可設為全域工作區動作。沒有 LF／CR fallback 或額外的 Enter；未支援 CSI-u 的程式不會自動改用其他編碼。

## 已查核版本

查閱日期：2026-10-16。下列證據是 decoder／keymap 範圍，不是完整 CLI 或原生桌面驗收。輸入向量、commit 與 artifact hash 存於 [fixture](../fixtures/keyboard/shift-enter.json)；不含對話、憑證、原生執行檔或第三方專有原始碼。

| 工具 | 證據 | 相容性證據與限制 |
| --- | --- | --- |
| Codex 0.163.0 | [鎖定的 crossterm Unix decoder](https://github.com/openai-oss-forks/crossterm/blob/ed1cdab335221515706178d68495bba2aed1924f/src/event/sys/unix/parse.rs#L550-L668) 接受未協商的 CSI-u；[預設 keymap](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/tui/src/keymap.rs#L1690-L1710) 區分 submit／newline | Unix decoder 已查核；[Windows](https://github.com/openai-oss-forks/crossterm/blob/ed1cdab335221515706178d68495bba2aed1924f/src/terminal/sys/windows.rs#L71-L77) 用 Console InputRecord、回報不支援 enhancement，不能沿用 Unix 證據 |
| Claude Code 2.1.301 | [官方 Linux 發行檔](https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.301.tgz) 靜態抽取的純 decoder 與 prompt 分支獨立執行：CSI-u 解成 Shift＋Enter，插入換行且 submit 次數為 0 | decoder 已查核；未啟動完整 CLI，未驗收其他平台實際傳輸。官方 [Terminal 設定](https://code.claude.com/docs/en/terminal-config) 亦列出 Shift＋Enter |
| OpenCode 1.19.3／OpenTUI 0.4.5 | [應用程式 parser 設定](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/tui/src/app.tsx#L168-L188) 與 [decoder](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/lib/parse.keypress-kitty.ts#L304-L441) 接受未協商 CSI-u；純 parser 與逐 byte streaming 測試通過 | decoder 已查核；[官方鍵盤文件](https://opencode.ai/docs/keybinds/#shiftenter) 提供同一編碼的 Terminal mapping |
| Antigravity CLI 1.3.5 | [官方提示輸入文件](https://antigravity.google/docs/cli/prompting) 說明 Shift＋Enter 換行；[版本紀錄](https://github.com/google-antigravity/antigravity-cli/blob/89081f72e10a98c3689f34b1af7261f43136ab5d/CHANGELOG.md) 可連到 Bubble Tea dependency decoder 證據 | 尚未確認專有應用的實際 decoder 整合。查閱時最新已為 1.4.0，不把 1.3.5 誤標最新 |
| Grok Build | [官方快捷鍵](https://docs.x.ai/build/keyboard-shortcuts)、[Terminal 支援](https://docs.x.ai/build/cli/terminal-support) | decoder 未固定驗證；一般模式 Shift＋Enter 換行，多行模式卻是送出 |

## 為什麼不直接開啟完整 Kitty 協定

目前安裝 xterm 5.5 的 keyboard evaluator 將 Enter 與 Shift＋Enter 都送為 CR，自動化直接載入該 dependency 原始碼驗證。這是 emulator 編碼差異，不是 Tauri 必須使用 modal。

[Kitty 協定](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) 與 [xterm modifyOtherKeys](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) 包含能力查詢、旗標、事件類型及 normal／alternate screen 的模式堆疊，不能混為單一 keybinding。Kitty legacy 模式的 Shift＋Enter 也是 CR；本次是明確的 CSI-u 相容按鍵，不宣告支援 Kitty、不回答能力查詢，也不改其他鍵。

完整協定支援還需協調 broker 的 query ownership、DA 回覆順序與 snapshot/reset 的 keyboard state。只升級 xterm 或只回答 CSI ?u 會讓 CLI 誤以為其他 enhancement 都已支援。本次不改 broker、協定協商或套件版本。

tmux／SSH／WSL 等額外傳輸可能攔截或轉碼。[tmux 3.6a 手冊](https://github.com/tmux/tmux/blob/3.6a/tmux.1) 的 extended-keys 與 extended-keys-format 會影響結果；不擅自改使用者設定，不把直接 decoder 的通過當作這些組合也通過。

## 驗證清單

自動化涵蓋 macOS／Linux／Windows 上所有內建 Agent、Shell 與未知工具的統一編碼，以及無模式介面、keydown／keypress／keyup、repeat、Enter／修飾鍵、IME／CapsLock、一般／bracketed paste、連線／snapshot／退出、聚焦／modal、同 runtime 重連、重新啟動與更換 attachment 的輸入目標守衛。

待原生驗收：macOS WKWebView、Linux WebKitGTK、Windows ConPTY、完整 CLI 一般／自訂 keymap、實際 IME、Shell→Agent→Shell、tmux／SSH／WSL，以及 Grok 一般／多行模式。沒有登入供應商、讀私人歷史或發出付費 Agent 請求。
