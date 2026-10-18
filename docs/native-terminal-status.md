# 原生終端活動訊號（OSC 7501）

## 範圍與信任

Codex 0.163.0 以上、Grok 1.0.52 以上、Antigravity 1.4.0 以上的 Unix 啟動可選用官方 OSC 7501。僅支援已檢查的同一 major；穩定版號不明時不猜測。Codex 較舊版本保留既有 app-server observer。Claude Mod 與 OpenCode plugin 保持原有路徑。

這是程式明確輸出的協定，不是畫面文字、PTY 靜默時間或輸出頻率推測。任何能寫入同一終端的程式也能產生報告，因此 UI 明示「終端回報」，不能把 app/id 當作已驗證的 Agent 身分，也不能用訊號自動接受權限或觸發其他操作。

Codex 原生路徑保留原 executable、args、cwd、resume/fork、profile 與權限設定。0.163.0 已有 working、idle、blocked，但沒有 done/error 或 blocked kind；只顯示實際收到的狀態，idle 不代表成功。之後版本若明確送出 done/error 才顯示完成／失敗。

Grok 不建立全域 hooks、不改 shared leader 設定。終端對官方能力查詢回覆固定支援清單。Antigravity 本次 child env 設 AGY_CLI_OSC7501=on 與 AGY_CLI_OSC7501_MESSAGES=brief；brief 仍可能包含 msg，接收端仍驗證後丟棄 msg/title，不保存或解讀文字。

## 生命週期與界線

- Settings 明確 opt-in；停用撤銷執行中與已完成的活動顯示，不終止 Agent。
- 僅 broker 消費本次 runtime 的原始 PTY bytes。畫面 snapshot/replay 不會重新產生狀態。獨立 capability `nativeTerminalStatusV1` 與 Poll opt-in 避免舊 client 收到無法反序列化的事件。
- 4096-byte 上限、分段 BEL/ST、RIS、CAN/SUB、base64/UTF-8/control validation；無效 id 不降級為 root。記錄最多 64 筆，遵守 subtree clear。
- 明確 root 優先；沒有 root 時只呈現唯一 top-level record，多個候選保持未知，不把 child 完成當作整個 Agent 完成。
- 協定沒有 heartbeat，狀態由後續報告／reset／process lifecycle 取代。UI 斷線會清除顯示；重新連線向 broker 取得目前記錄，沒有偽造 provider TTL 刷新。
- process exit 清除 working/blocked/idle，done/error 保留到撤銷、清除或 pane 結束；明確來源狀態與程序 exit code 分開。
- 版本探測用空 HOME/XDG、清空繼承環境及 app-owned RuntimeManager，沿用已驗證 waitable-child/session ownership 清理。正常 Agent 的環境不受影響。
- Windows native OSC 接收尚未驗收，這個 slice 不開啟 Windows capability。

## 已取得的 Linux 真實 binary 證據

2026-10-18，在空白測試目錄、空 HOME、無登入／prompt／模型呼叫下：

- 官方 Antigravity **1.4.2**：官方 manifest SHA-512 校驗成功。實際 forced 與 auto capability 模式均收到 `blocked/auth`，app=antigravity、BEL；清理時 idle，兩次 main child 均 exit 0 並 reap。不是 1.4.1 的實測。
- 官方 Codex **0.163.0**：私有 npm integrity 校驗安裝，`--no-daemon` PTY 到登入畫面即停止，沒有送出 OSC7501；登入前無法驗證 native 工作／閒置／等待。binary SHA-256 `399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215`，清理與 reap 通過；不把 source 契約當真實回合結果。
- 官方 Grok **1.0.62 (1474f9cbdd91)**：實際能力查詢及 `blocked/auth`，app=grok-build、ST。binary SHA-256 `2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa` 是本地重現記錄，不是 vendor checksum。
- Grok ad-hoc probe 的 descendant 清理驗證未完成：executor 缺少 `/proc/.../children`；命令與 PTY 已結束，未查到該私有 binary 的存活程序，但不能以此宣稱完整清理驗收。已停止重跑；正式程式使用原有 RuntimeManager，不採用該 probe 的臨時 reaper。
- 官方 Antigravity 1.4.2 已另外通過 production broker 測試：CLI→原始 PTY→OSC decoder→broker TerminalStatus→Authentication；撤銷清除狀態但 Agent 仍執行，再由 RuntimeManager 正常停止與回收。CI 以同一 immutable asset 與 SHA-512 重跑，runner environment 清空。
- 上述是真實 CLI startup 訊號，不是模型回合 Busy→Done、權限互動或 GUI 驗收。完整模型流程仍未驗，不得勾選。

## 官方與參考來源

查閱日期：2026-10-18。

- [Rex OSC7501 revision 0.4](https://www.superlogical.com/rex/docs/build/program-status)：wire grammar、limits、trust、lifetime。
- [Codex 0.163.0 emitter](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/terminal_program_status.rs)、[PR52725](https://github.com/openai/codex/pull/52725)：TTY、active chat、clear 與 coarse states。
- [Codex PR54114](https://github.com/openai/codex/pull/54114)：之後的 done/error/kind；不歸算為 0.163.0 已有能力。
- [Grok 官方 changelog](https://x.ai/changelog/build)：1.0.52 原生 OSC7501。公開 repo 舊快照早於此版本，不能用舊 source 的缺席否定新功能。
- [Antigravity 1.4.0 release](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.4.0)、[官方安裝](https://www.antigravity.google/docs/cli/install/)：功能版本與官方 binary。
- [Herdr integrations](https://herdr.dev/docs/integrations/)、[真正 upstream](https://github.com/herdrdev/herdr)：部分 hooks 只辨識 session，其他狀態仍 screen detection，不採用其推測。upstream Apache-2.0，舊 AGPL fork 不作程式來源。
- [Orca Grok reducer](https://github.com/stablyai/orca/blob/33e6785fe2c36730bc0dfcdf1db6208d471df833/src/shared/agent-hook-listener/providers/grok-events.ts)：MIT；其 Stop→done 不能證明 gate 已完成，且全域 hook 安裝不符本 slice 的 launch-local 目標。

本實作依公開協定事實獨立撰寫，沒有複製上述產品程式碼。
