# 2026-10-16 批次整合驗證

這份紀錄區分本機整合、自動測試與原生驗收。較早 checkpoint 保留為歷史；需求變更後，舊樹的綠燈不代表最新功能已通過原生驗收。

## 最新功能與受測來源

| PR | 內容 | 受測來源 |
| --- | --- | --- |
| #2 | 原生資料夾與非同步、fail-closed 確認 | `c170f87100e15f8180e2d2bf12ac5be0cc136f62` |
| #3 | 三平台後端與 smoke driver 清理／非同步 readiness | `05d19673ad415f38c08e3da78e48701c3e5e10fe` |
| #4 | 原有十組主題保留，Code Modern／2026 與命令選單預覽 | `bc5aef77d98276c8bcaacc8ef85dbaadcc2dbf9c` |
| #5 | 分頁／面板／專案改名排序、modal 焦點與 IME 修正 | `dd1d468a0b998984923c5d04bc8f6a1e365608ab` |
| #6 | OpenCode 唯讀 SQLite、來源身分限制與 canonical fixture | `a37dc641e5c2abe2331367032a9e398f549b5065` |
| #7 | 持續 Runtime、attachment lease 與 Darwin 私有 listener 修正 | `69801aceece9b3cab6159a7cc99456e851f0f4ee` |
| #8 | 索引熱路徑；整合時另保留 Windows fixture cwd 修正 | `f3ff1f96bed131eb82ef7a0f75a3e5a21bd083fa` |
| #9 | UI＋Terminal 全工作台縮放、窄欄位外觀保存 queue | `ae76ae140808cd34608a2b9808562c85ff94b180` |
| #10 | null-project 全域 Terminal、home 策略與 canonical fixture | `6236ef31bb45021488b895db585d8235d7b60bf4` |
| #11 修訂 | 原位 Shift+Enter、provider 鍵盤能力與面板選項 | 本機已審來源 `bbde4908ddf136dfa9aec384289100b39e47adc4` |

#11 的舊遠端 modal 草稿不是最終需求，這棵整合樹已移除該提案；本表不宣稱新版 #11 已獨立發布或合併。#9 已包含新版 #4。全部主題共 24 個 UI／26 個 Terminal 選項，並保留既有色值。

## 最新本機整合結果

程式與測試 snapshot：`b25ac0f1f85b6976af713def4ccb2395abcf67da`，tree `ea527034fb679d0be45cb5120cef1377400c4737`。獨立 production review 使用 `059a79e918a2924be8d9b9c90660ad55facbb607`；兩者僅差兩行測試 callback 的 ESLint 清理，沒有行為或斷言改變。之後的文件提交不改程式、依賴或 workflows。

- [x] TypeScript、ESLint、746 個前端測試（26 suites）、production build。
- [x] Rust fmt；locked no-desktop all-target Clippy，`-D warnings`。
- [x] 本機 Rust 293 passed、2 個既有 ignored helpers、8 個明確 filtered；不是完整 Rust pass。
- [x] 44 組語意對比與 10 個 macOS 圖示表示靜態檢查。
- [x] 獨立 focused review：271 個受影響測試及 3 個額外交互案例通過。
- [x] 真實 App／WorkspaceCanvas／TerminalPane 邊界測試涵蓋 Linux／Mac 鍵盤模型：縮放保存、Shift+Enter 序列化寫入、IME、命令主題預覽與 Escape rollback、不重啟 Runtime。
- [x] 獨立額外案例確認延遲 zoom／fit 不搶改名焦點、modal 阻擋數字／縮放／Shift+Enter，及延遲原生縮放期間兩次 inline 寫入仍依序。
- [x] 狹窄 theme-only 預覽不恢復舊 zoom／字級；每次外觀保存等待自己的布林結果，失敗不誤關閉 picker。
- [x] 非同步確認保留同 attachment identity／lease、runtime／pane／startToken 與 visible／focused 世代檢查。

交互測試僅 mock 原生 bridge、xterm render/input 邊界與 history 顯示；不是原生 GUI 或真實 Agent 的驗收。使用合成 fixtures，沒有讀取私人歷史。

### 本機 socket 限制

開發 sandbox 的 Unix socket bind 回傳 `Operation not permitted`。以下八個測試未計入本機 passed，測試原碼沒有新增 ignore 或放寬：

- `private_listener_connects_and_authenticates_with_owner_only_permissions`
- `broker_process_crash_leaves_interrupted_records_and_never_adopts_a_pid`
- `restored_running_metadata_is_interrupted_without_adopting_saved_pid`
- `stale_detach_lease_cannot_cancel_replacement_attachment`
- `completed_output_survives_ui_reopen_and_metadata_never_reexecutes_after_broker_restart`
- `closing_the_entire_ui_process_preserves_the_broker`
- `detached_process_keeps_identity_output_and_interactive_input_after_ui_client_drops`
- `global_terminals_reopen_same_broker_ids_and_explicit_close_keeps_the_other_runtime`

最終整合提交的正常 Linux push CI 必須不過濾地執行這些測試，不能借用較早版本的綠燈。

## 歷史 checkpoint

| Snapshot | 當時證據與適用限制 |
| --- | --- |
| `9e20df8`／tree `ad2592a3` | 舊 modal 需求；694 frontend、289 local Rust，7 個 socket cases filtered，另有 Windows GNU 交叉檢查。 |
| `973c104`／tree `ec0cfc42` | [Linux CI 38909214737](https://github.com/wellwind/SessionBay/actions/runs/38909214737)：694 frontend、296 Rust 與 subprocess fixture；仍為舊 UI 需求。 |
| `d5f0a99`／tree `60f9780b` | [Linux CI 38911192823](https://github.com/wellwind/SessionBay/actions/runs/38911192823)：695 frontend、296 Rust 與 subprocess fixture；含 smoke timeout／清理修正。 |
| `fb1cf56`／tree `e9d03201` | [Linux CI 38915296436](https://github.com/wellwind/SessionBay/actions/runs/38915296436)：696 frontend、298 Rust 與 subprocess fixture，主測試 0 filtered，八個 socket cases 全過；尚無新版主題／整體 zoom／inline Shift+Enter。 |

較早完整原生矩陣曾發現 Intel smoke harness timeout、macOS canonical path、Windows fixture cwd，以及 Linux smoke readiness 競態。對應修正與 Darwin listener 修正已保留；修正提交通過 Linux 不等於原生四 runner 全部通過。

## 仍待完成

- [ ] 最新整合提交的正常 Linux push CI，含全部 socket／subprocess E2E。
- [ ] 最新整合提交的完整三 OS／四 runner matrix：Linux、macOS ARM64／Intel、Windows x64。
- [ ] 原生 WebView：資料夾 dialog、鍵盤／IME／焦點／拖曳／窄視窗、主題預覽、UI zoom 與終端 resize／選取。
- [ ] 三平台實際關窗／重開、真實 Shell／Agent 進階 TUI；inline Shift+Enter 與 OpenCode 真實登入／接續。
- [ ] 真實來源、原生 CPU profiling、冷磁碟與跨平台索引驗收；[原始效能量測](index-performance.md)的搜尋退步與限制保留。
- [ ] 各 PR 維持可審範圍、逐一同步與通過 CI 後合併；最終 main tree 核對。

沒有把 DOM mock、靜態檢查、交叉編譯或舊版 CI 當作新版原生驗收。未執行付費 CLI、讀取私人歷史或修改原始 Agent store。未簽章打包與自動 smoke 也不取代全部人工視覺／真實 Agent 驗收。
