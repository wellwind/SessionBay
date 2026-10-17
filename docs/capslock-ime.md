# Caps Lock 中文組字候選修正

狀態：**舊候選原生驗收失敗；本版改採上游穩定版與公開鍵盤 hook。新版 macOS 原生驗收為 NOTRUN，使用者於 2026-10-17 明確要求「#49 不用 mac 驗證了，直接合併」，接受不做此驗收。合併仍須通過最新 exact-commit CI；不得將豁免標為原生 PASS 或宣稱實機已修好。**

## 已取得的原生證據

2026-10-17，候選 `e750ad1` 在真實 macOS 注音輸入 `5j/ jp6` 形成底線「中文」後，按 Caps Lock 仍向真 PTY 送出兩筆中文。後續 abc、Enter 及另一次中文 Enter 正常。該版與 `d116ae3` 的 IME 實作相同，均已否決。

trusted 事件順序為 CapsLock keydown（isComposing=true）、Unidentified keydown（isComposing=true）、deleteCompositionText beforeinput/input、insertFromComposition beforeinput/input、compositionend、CapsLock keyup。沒有 insertText。舊版依賴 pending finalizer 與 insertText 相遇的假設不符合這份原生證據。

原紀錄沒有 keyCode／which／code，也沒有內部 finalizer 時序。不能斷言實際 Unidentified 的 legacy code 是 0，或依兩次傳送間隔推定原因。回歸明確分別測試假設 0、229 與真按鍵碼 65：上游 6.0 原始路徑在 0 分支雙送、229 分支單送；這是來源層合成特徵，不是實機鍵碼的證明。

## 參照上游的選擇

- 升級並精確鎖定穩定 `@xterm/xterm 6.0.0`、Fit 0.11.0、Search 0.16.0；overview ruler 改用 6.0 公開選項。6.0 已包含上游 #5282 的 CapsLock keyCode 20 修正。
- VS Code 使用 xterm 與公開 attachCustomKeyEventHandler 分流快捷鍵，沒有自行改寫 composition finalizer。本版移除所有 private helper、交易 identity 與 timer 替換。
- 上游 **尚未合併**的 #6191 指出：isComposing=true 的 keydown 即使 legacy keyCode 不是 229，也不應提前 finalize。既有唯一公開 handler 在本地 composition 仍 active 且 keydown.isComposing 時回傳 false，讓後續原生 composition/input 完成文字提交。
- 這不是逐字移植 #6191：公開 hook 前 xterm 已設 `_keyDownSeen`，回傳 false 也略過 scroll-on-user-input 分支。hook 不 preventDefault、不 stopPropagation、不攔截 composition/input，也不自行送出 IME 文字。非組字 Enter、Ctrl+C、既有 Shift+Enter 與 app 快捷鍵維持原路徑。組字中若 Ctrl+C 本身也標為 isComposing=true，則交由 IME，不送 ETX，需原生驗證。
- 不使用任意延遲、相同文字去重或 PTY 過濾；連續相同中文必須都保留。6.0 的其他鍵盤變更（含移除部分隱含 Alt 箭頭映射）屬升級相容風險，需原生快捷鍵回歸。

## 自動化與原生驗收的區別

`src/terminal-ime.test.ts` 直接執行安裝的 CompositionHelper、CoreBrowserTerminal 鍵盤／input／blur 方法與官方鍵盤 evaluator，走與產品相同的公開 handler。涵蓋原生觀察到的事件順序、0／229／65 分支、composition Enter／Shift+Enter、普通 Enter／Shift+Enter／Ctrl+C、取消、相同提交、screen-reader 事件傳播與 blur。

`npm run test:ime` 使用實際發行 bundle 與 Chromium textarea，涵蓋雙送對照、0／229、重複提交、取消、blur、dispose 及 Enter／Shift+Enter／Ctrl+C。這些是合成 DOM 事件，不能替代真正中文輸入法。雲端本機 Chromium 受 sandbox socket 限制，未停用 sandbox；由既有 Linux lightweight CI 執行 bundle suite。Rust 與三平台 desktop matrix 結果另列。

**已知相位限制：** composing Enter／Shift+Enter 的 keydown 不送 CR／CSI；若瀏覽器另送 composing keypress(charCode=13)，既有上游路徑仍會送 CR。此合成特徵有測試，是否發生於原生 WKWebView 尚未確認，不能宣稱所有相位已通過。

### 雲端檢查（2026-10-17）

typecheck、ESLint、46 檔 1015 項 Vitest 與 production build 通過；其中 IME／keyboard focused 58 項。13 項 bundle 測試（含 Fit／Search 相容）與 4 項 layout 在 [CI 39045111951](https://github.com/wellwind/SessionBay/actions/runs/39045111951) 通過。該 run 後續因舊 5.5 repaint 測試預期 blank>0 而失敗：6.0 的同步分幀實際 blank=0。已更新為 6.0 驗證並加入未同步負對照；整套最終 CI 仍待確認。此數字不代表原生輸入法通過；本輪未改 Rust，未重跑 Rust／三平台 desktop matrix。

## 可選 Mac 驗收（使用者已豁免）

只在隔離的空白測試 terminal 使用非私密樣本文字，固定候選 exact SHA：

1. 真注音 `5j/ jp6` 形成底線「中文」，按 Caps Lock，確認 PTY 只收到一筆；再輸入 abc 與 Enter。
2. 另一次中文以 Enter 提交；連續相同中文兩次都保留。測取消、快速下一段、焦點切換。
3. 組字中的 Enter／Shift+Enter 與組字後普通 Enter／Shift+Enter／Ctrl+C、應用程式快捷鍵分開驗證。
4. 如失敗，保留 trusted、key／code／keyCode／which／isComposing、inputType、長度與事件順序，不推測未記錄欄位。不用重做已否決版本。

可選 [Web Inspector 事件診斷](diagnostics/capslock-event-trace.js) 只供隔離樣本文字測試；最多 256 筆，執行 `stopSessionBayImeTrace()` 後移除 listeners。記錄鍵碼可能揭示輸入按鍵，所以不可用在真實命令、Agent 提示詞或私密資料。沒有 Web Inspector 時不改系統權限。

## 官方依據

- [xterm 6.0 release](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)
- [已合併 #5282](https://github.com/xtermjs/xterm.js/pull/5282)
- [尚未合併 #6191](https://github.com/xtermjs/xterm.js/pull/6191)
- [CompositionHelper 6.0](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/browser/input/CompositionHelper.ts)
- [CoreBrowserTerminal 6.0](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/browser/CoreBrowserTerminal.ts)
- [VS Code terminalInstance](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts)

## 6.0 Fit 相容回歸

完整 CI 在 CSS zoom 50% 的 focus single→split→one 發現相同 pane 還原為 252 欄、初始 251 欄（rows 同為 76），同 SHA 重跑可再現；沒有放寬原 exact-size 驗證。xterm DOM renderer 以 round(canvasWidth)/cols 回推 cell 寬，FitAddon 再用此近似值計算欄數。安裝的 FitAddon 來源回歸以合成字寬 7.826、可用寬 1972 重現 221→251→252 的取整差異；此字寬為模型值，不是從原生 Mac 測得。

每次公開 fit() 後，用公開 proposeDimensions() 檢查一次，必要時同步再 fit()，然後才依原流程送 PTY resize。沒有私有 renderer 讀寫、timer 或無限收斂迴圈；某些字寬可能震盪，因此補償最多一次。保留尺寸上限及原有隱藏／attachment 守衛。真實 browser 的原 exact-size 回歸仍是驗證門檻。

此相容修正本地 typecheck／lint／47 檔 1019 項 Vitest／build 通過；原 focus exact-size browser case 待新 CI，尚不宣稱通過。
