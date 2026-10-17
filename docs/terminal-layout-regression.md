# Terminal 工作列邊界回歸

## 原因與修正

`@xterm/addon-fit` 0.10.0 以 terminal 父元素的 computed width／height 計算欄列，扣除 terminal 本身 padding 與 scrollbar，但不扣父元素 padding。原本 `.xterm-host` 是 `height: 100%` 的 border-box，另有上下 9px／左右 7px padding；因此欄列計算會多使用 18px 高／14px 寬，最後一列可能蓋到 footer 分隔線。

間距移到 `.terminal-body`，讓 host 的尺寸就是可供 xterm 使用的內容區。body 也裁切重新 fit 前的短暫 renderer overflow。沒有更改 terminal／PTY 的 resize、輸入、焦點、搜尋、scrollback 或連線程式碼。

## 可重複驗證

- `npm test`：已安裝 FitAddon 的尺寸契約，重現舊 host padding 過度分配，以及四組正常／緊湊 content-box 尺寸。
- `npx playwright install-deps chromium`，並確認已安裝正式 Google Chrome（CI 使用 runner 預裝版本）。
- `npm run test:layout`：sandbox-enabled Google Chrome，真正的 `TerminalPane` 與 xterm，完全合成 runtime snapshot。一般尺寸、緊湊面板、50% 與 200% CSS zoom；比較 renderer／body／footer 邊界，確認 terminal 與搜尋焦點，搜尋開關後重新 fit。Linux lightweight CI 執行並保存 `terminal-layout-evidence`。

Before／After 使用同一版 component、相同輸出、相同尺寸。Before 明確重新套回 main `3623504` 的兩條舊 padding／overflow 規則；不宣稱是整個舊版應用截圖。回歸會在指定尺寸附近最多增加 15px，找到受字元列取整影響、確實跨過 footer 的高度，再以相同高度驗證修正。

截圖含有 Google Chrome／synthetic runtime／CSS zoom 標示。CSS zoom 只是 browser layout 壓力測試，不等同原生 WebView `setZoom`，也不驗證任何原生 PTY、macOS、Windows 或 Linux WebKitGTK 的實際呈現。正式跨平台 UI 驗收仍待原生實機完成。

## 本次執行限制

雲端 executor 的本地 listener／Chromium socket 受 sandbox 限制；正常 preview escalation 因執行環境 mount 設定失敗，cloud browser 也不允許 `file://`。沒有關閉 sandbox、繞過 URL 規則或讀取使用者電腦。Browser 測試與截圖須由正常 Linux CI 執行；在其產出前不得宣稱視覺驗證通過。

### Ubuntu 24 CI browser 啟動

第一輪 CI 的 Playwright 下載版 headless shell 因 Ubuntu AppArmor user namespace 限制，於開啟頁面前失敗，沒有截圖。後續使用 Playwright 官方 `channel: chrome`，選擇 runner 預裝 `/opt/google/chrome/chrome`；保留 `chromiumSandbox: true`，不修改 AppArmor／sysctl，不使用 `--no-sandbox`。此正式 Chrome 路徑有 Ubuntu 既有政策支援，版本寫入 geometry.json。依據：[Chromium sandbox 文件](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)、[Playwright browser channels](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)、[GitHub Ubuntu 24 runner 軟體清單](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)。CI 也輸出實際 Chrome 命令路徑／resolved path／版本，不從 runner 文件推定實際啟動成功。
