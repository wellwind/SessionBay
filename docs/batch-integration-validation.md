# 2026-10-16 批次整合驗證

這份紀錄區分本機整合、自動測試與原生驗收；各功能文件中的較早 checkpoint 保留為歷史，不代表最新合併樹已經在所有平台執行。

## 功能與受測來源

- 原生資料夾：#2，修正版本機來源 `e1662932`；全域 async confirmation 以 strict `true` 才允許，取消／拒絕／重疊 fail closed。
- 三平台後端：#3 `a48dca31`；Windows 原生測試仍需實機執行。
- 獨立 UI／Terminal 主題：#4 `a70e14d4`。
- 分頁／面板／專案改名與排序：#5 `dd1d468a`；包含 modal 焦點與 IME 修正。
- OpenCode：#6 `18d7043a`；唯讀 SQLite、來源與 DB 身分限定接續。
- 持續 Runtime：#7 `ff2f596b`；UI detach，broker 保留活程序與有界畫面。
- 索引熱路徑：#8 `f3ff1f96`；[原始量測](index-performance.md)的搜尋退步與限制保留。
- Terminal 字級：#9 `6619baf2`；與主題共用序列化外觀保存。
- 全域臨時 Terminal：#10 `1e9e8f5f`；真正 null project、home 啟動策略與舊 explicit cwd 相容。
- 多行草稿：本機來源 `11b29945`；明確確認貼上，同 attachment／runtime／草稿世代才可操作。

## 本機整合結果

受測程式碼與測試 snapshot：`9e20df888e8e92e8ac64840566caeebaf675cc25`，tree `ad2592a30b3fa64d5f658c7b75696ac43cf8c597`。後續文件修訂不改動程式碼、依賴或 workflows。執行環境為隔離 Linux 開發環境；fixtures 都是合成資料。

- [x] TypeScript、ESLint、694 個前端測試（23 suites）、production build。
- [x] Rust fmt；Linux no-desktop all-target Clippy，`-D warnings`。
- [x] Rust 核心可執行部分 289 passed、2 個既有 ignored、7 個明確 filtered；這不是完整 Rust pass。
- [x] Windows GNU full-desktop all-target strict Clippy 交叉檢查，非原生 Windows 執行。
- [x] 44 組語意對比、10 個 macOS 圖示表示靜態檢查。
- [x] 跨功能回歸：null 分頁選取／改名／重排／保存不產生假專案，也不停止或重啟 Runtime。
- [x] 真實草稿 textarea 與 App listeners 的 Linux／Mac 鍵盤模型：分頁／字級快捷鍵及 Ctrl+Tab 不穿透；IME Escape 不關閉，組字結束後 Escape 取消且重開保留文字。
- [x] 獨立複查確認 Dialog opener／IME／顯式 focus restore、延遲終端 focus、async confirmation 與 broker attachment 守門完整。

Unix socket 受開發 sandbox 的 `Operation not permitted` 限制。六個 persistence parent tests 與一個全域臨時 Terminal broker test 不計入本機 passed，測試原碼沒有新增 ignore 或放寬。一般 Linux push workflow 必須在最終整合提交重新執行全部核心測試，不能借用 #7／#10 較早單獨綠燈替代。

## 仍待完成

- [ ] 最終整合提交的正常 Linux push CI，含未過濾 socket／subprocess E2E。
- [ ] 手動完整三 OS／四 runner matrix（Linux、macOS ARM64／Intel、Windows x64）；未執行不算通過。
- [ ] 原生 WebView：資料夾 dialog、鍵盤／IME／焦點／拖曳／窄視窗、主題與實際終端 resize／選取。
- [ ] 三平台實際關窗／重開與真實 Shell／Agent 進階 TUI；OpenCode 真實登入與接續。
- [ ] 真實來源、原生 UI／CPU profiling、冷磁碟與跨平台索引驗收；10k 搜尋目標仍未全數達成。

沒有把 DOM mock、靜態圖示檢查或交叉編譯當作原生 GUI 驗收；未執行付費 CLI、讀取私人歷史或修改原始 Agent store。
