# 終端多行草稿

## 使用方式

1. 在已連接、執行中的終端按 Shift+Enter，或點「多行草稿」。
2. 在獨立編輯框輸入；Enter 與 Shift+Enter 只換行，不會傳到 PTY。框內沒有送出快捷鍵，Ctrl+Enter 也不送出。
3. 檢查貼上目標、文字及末尾換行，點「確認貼上…」，閱讀風險後再次確認。
4. 內容經原有 xterm.paste 與有界輸入佇列傳送；不額外附加 Enter。是否執行或開始 Agent turn 由前景程式決定。

這個框不讀取或取代 CLI 已有的輸入 buffer；貼上會加入 CLI 當前輸入位置。多行文字和末尾換行即使沒有另外按 Enter，也可能立刻執行指令。xterm 沿用既有換行正規化與 bracketed-paste 模式；原始草稿不 trim、不補換行。控制字元（Tab、CR、LF 除外）不允許貼上，避免破壞 bracketed-paste 邊界；內容仍留在編輯框供修正。

## 草稿與目標生命週期

- 每個面板獨立保存一份記憶體草稿。取消、Escape、切換面板或導覽只關閉編輯框，不送出，原文字保留。
- 草稿不落盤，不寫入 Session／設定；關閉面板或應用程式後消失。不能把背景 runtime 可恢復誤認為草稿也能恢復。
- 草稿記住建立時的 attachment、Runtime ID 與啟動世代。重新附接即使是同一 Runtime ID，也不自動授權舊稿貼上。
- 目標失效時，舊稿可重新打開並手動複製文字，但貼上按鈕停用。確認「另開目前終端草稿」才會清除舊稿並建立新目標。
- 每次貼上都需確認；成功也保留草稿並提醒重複貼上會重複輸入。傳送中防止重複點擊；失敗時不自動重試，可能已送出部分內容，應先檢查終端。
- 非同步確認期間編輯框唯讀、貼上與另開按鈕停用；取消、重新開啟、導覽、文字或目標變更會使舊確認失效。原生取消、拒絕或確認服務失敗一律不授權操作。
- 已確認並開始傳送的輸入無法撤回。關閉編輯框不撤銷已開始的貼上。

## 鍵盤與焦點

Shift+Enter 保留給此本機操作；設定不允許另一個工作區命令占用它。一般 Enter、Ctrl／Alt／Meta 修飾鍵保留原有語意。中文組字、keyCode 229、Caps Lock 不觸發草稿；組字 Escape 不關閉框。

沿用共用 Dialog 的鍵盤循環、Escape 及標籤；終端延後執行的 requestAnimationFrame 在 modal 存在或焦點已移動時不能搶焦點。xterm 的鍵盤 hook 在 modal 存在時拒絕按鍵，但不關閉 stdin 或攔截 parser 回應，避免改變終端協定。

## 為何不全域送 LF

- xterm 5.5.0 與已發布的 6.0.0 都將 Shift+Enter 編成 CR；穩定版升級本身不能解決。
- 隔離 PTY 的 Bash 5.2.37、zsh 5.9 實測中，LF 可以直接執行完整命令。
- Grok 一般模式的 Shift+Enter 是換行，multiline 模式卻是送出；Claude／OpenCode 可自訂按鍵。成功傳遞修飾鍵不代表能保證所有工具／模式換行。

此功能適用於 Session Bay 的本機編輯框，不聲稱已支援所有工具的原生 Shift+Enter。沒有修改 Shell rc、Agent keymap、登入、權限旗標或 broker 協定。

## 驗證與待驗收

自動回歸涵蓋：開啟／編輯／取消不寫 PTY、原文字與末尾換行、明確目標確認、一般 Enter／修飾鍵、IME／Caps Lock、modal 焦點、延後 clipboard 讀取、重複點擊、失敗保留、重新啟動／相同 Runtime 重新附接、導覽／面板切換、UTF-8 上限與控制字元。測試直接執行 lockfile 中 xterm 5.5.0 的 Keyboard／Clipboard 程式，確認不更改原 Enter 編碼或 bracketed-paste 行為。

尚未完成 macOS WKWebView、Windows WebView2／ConPTY、Linux WebKitGTK 的真實 GUI／輸入法／Agent 驗收。開發環境 Chromium 因 Unix socket EPERM 無法啟動，沒有使用 --no-sandbox 或繞過限制；因此沒有原生截圖或視覺通過聲明。原生驗收應測試兩個面板各有草稿、正在組字時開關框、停止／重接／關閉工作、真實多行與末尾換行貼上；只使用合成內容並確認明示風險。
