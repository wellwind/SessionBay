# Caps Lock 中文組字候選修正

狀態：**合成路由候選；macOS 原生中文輸入法尚未驗收，不可據此宣稱已修好。**

## 已重現的原因

xterm 5.5.0 的 `CompositionHelper.keydown` 把 Caps Lock 當作一般按鍵，可能提前送出 preedit，再被 `compositionend` 送一次。main 已有語意 CapsLock custom key handler，保留 OS 事件但略過該次 xterm keydown。

只略過 keydown 仍可能雙送：`compositionend` 排入延後 finalizer，隨後 `input(insertText)` 又走 Terminal 的獨立輸入路徑。此候選針對 **CapsLock 所屬交易仍 pending，且 insertText 已在該交易 textarea 範圍內** 的序列，取消真正的 pending callback 並提交一次。

先前候選只將 `_isSendingComposition` 設為 false，已被兩個反例否決：

- 甲已同步送出，乙又在舊 callback 前結束，乙重新打開共享旗標，導致舊 callback 再送甲乙。
- 甲仍 pending，乙開始後由 Caps Lock 結束；只送乙並關閉共享旗標會把甲一起丟掉。

## 相容邊界與取捨

- 固定 `@xterm/xterm` 為精確 `5.5.0`；檢查 CompositionHelper 私有欄位形狀，不符合時保留原路徑。升級必須重新審查，不能移除測試後直接放寬版本。
- 用可取消、帶交易 identity 的 callback 取代原有 **0ms 事件傳播等待**，沒有增加任意防抖延遲。callback 與 pending identity 在送出文字之前清除，避免 reentrant blur 及舊 timer 復活。
- 這會替換所有 composition 的延後 finalizer，包括普通組字，才能避免前一筆普通交易與後一筆 CapsLock 交易互相覆蓋。下一次 compositionstart 的 capture 階段先提交上一筆，再讓 xterm 重設起始位置與 already-sent offset。
- 假設 compositionstart 發生於新 preedit 寫入 textarea 之前；這也符合 xterm 在此時記錄 start 的前提，但仍需原生 WKWebView 事件證據。
- 不比較前後提交內容，不去重 PTY 字串；合法連續相同中文、貼上與快捷鍵仍保留。Caps Lock 不 preventDefault，不取消 OS 輸入法切換；screen-reader input 保留事件傳播。
- dispose 只在 TerminalPane 即將 dispose terminal 時呼叫，取消未送 callback，不可當作 live terminal 的任意卸載介面。

## 驗證

- `npm test -- src/terminal-ime.test.ts --maxWorkers=2`：直接執行 lockfile 安裝的 CompositionHelper、Terminal keydown／keyup／keypress／input／blur 與官方 keyboard evaluator；除了單獨 handler 測試，另有完整 DOM 路由案例實際觸發 keyup 以更新 keyDownSeen。
- `npm run test:ime`：在實際發行的 xterm bundle、實際瀏覽器 textarea 上 dispatch 合成事件。包含現有 key guard 的雙送對照組、commit、連續相同提交、取消、blur、Enter、已送／未送交易重啟、普通組字重啟。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已安裝 Chromium。
- 以上均非 OS 注音／拼音注入。來源層測試另涵蓋 stale update end、already-sent offset、未知形狀、一般 Enter、螢幕閱讀器、韓文風格尾音 rollover 與 dispose。

### 本次雲端結果（2026-10-17）

- typecheck、ESLint、完整 Vitest **44 檔 1017 測試**、production build 通過；其中 IME **56 案**。整合最新 main `ce43370` 後再跑 typecheck／lint／**46 檔 1030 測試**／build 通過，IME 程式碼未變。
- Chromium bundle suite **未執行**：受限執行器禁止 Chromium 建立本機 socket；標準提升執行又遇到唯讀掛載錯誤。未停用 Chromium sandbox 或改動 OS 安全設定；保留腳本，並接入既有 Linux lightweight 的 sandbox Chrome 步驟；該 CI 結果仍待確認。
- 未改 Rust；沒有在本輪重跑 Rust、三平台 desktop matrix 或原生 IME。

## 尚待原生驗收

請在乾淨的合成 terminal 中使用非私密範例文字，記錄版本、輸入法及以下步驟，不在實際 Agent 提示詞或工作命令中測試：

1. 中文尚在底線／候選狀態時按 Caps Lock；確認已輸入內容沒有重複或遺失，英文後續輸入正常。
2. 以同一段中文連續輸入兩次，確認兩次都保留。
3. 取消 preedit、提交後立即 Enter、快速開始下一段、切走焦點再回來。
4. 如仍有問題，取得 keydown／keyup／compositionstart／compositionupdate／compositionend／beforeinput／input 的順序、inputType、isComposing、textarea 值長度及合成輸出。只有看到真正中文 preedit 才算重現；ASCII 自動輸入不能替代。

可選診斷：[只記錄事件中繼資料的 Web Inspector 腳本](diagnostics/capslock-event-trace.js)。只在合成空白 terminal 貼入，重現一次後執行 `stopSessionBayImeTrace()` 取回最多 256 筆並移除 listeners；不記錄文字、鍵碼、剪貼簿、PTY 內容，不變更產品原始碼或攔截事件。沒有可用 Web Inspector 時不必改系統權限，改記錄人工步驟與實際輸出。

**已知範圍限制：** insertText 先於 compositionend，或晚於 finalizer callback，均不在目前 pending-transaction 條件內；如果原生重現是這類順序，此候選不足以修復。不能用全域相同文字去重來掩蓋這個缺口。三平台桌面 CI、原生 IME 及使用者驗收與 Linux 合成測試分開記錄。

## 原始碼依據

2026-10-17 查閱與執行鎖定安裝來源：
- [CompositionHelper 5.5.0](https://github.com/xtermjs/xterm.js/blob/5.5.0/src/browser/input/CompositionHelper.ts)
- [Terminal 5.5.0](https://github.com/xtermjs/xterm.js/blob/5.5.0/src/browser/Terminal.ts)
- [Keyboard 5.5.0](https://github.com/xtermjs/xterm.js/blob/5.5.0/src/common/input/Keyboard.ts)
