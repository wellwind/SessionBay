# 真實 Provider hooks（明確啟用）

## 操作

設定 → 來源與工具 → 選擇 Codex 或 Claude →「啟用真實活動 hooks」→ 儲存。只套用後續由 SessionBay 啟動／恢復的程序；既有程序不會偷偷加裝。關閉並儲存會立即撤銷該 provider 現有回報，程序繼續執行。

目前註冊路徑為 macOS／Linux。Windows、Grok、Antigravity、OpenCode 沒有此版本的真實 launch-local bridge，保持 unknown，不借用 PTY output 推測。這不代表這些 provider 沒有 hooks。

- Claude：以 `--settings` 傳入純本次啟動 JSON；hooks 與原設定依 provider 規則合併。
- Codex：以 `-c hooks.<Event>=…` 傳入本次啟動定義，加入 `--no-daemon`，避免共享 app-server 遺失本次啟動的 ephemeral routing environment。
- 不寫入 `~/.claude`、`~/.codex`、專案設定、永久 token 或 PATH。
- Codex 預設需要 `/hooks` 檢查並信任所有 SessionBay command definitions；SessionBay 不添加 `--dangerously-bypass-hook-trust`。首次信任後須從 SessionBay 重開／恢復，讓之前被跳過的 SessionStart 重新完成綁定。
- 若 provider 管理政策停用 hooks 或該版本不支援參數，保持未知或明確顯示原 CLI 啟動錯誤，不降級成猜測狀態。

## 可以觀察什麼

| Provider event | SessionBay 顯示的事實 | 不宣稱 |
| --- | --- | --- |
| UserPromptSubmit | 收到新提示 | 已通過其他 gate hooks、持續運算 |
| PermissionRequest | 收到權限請求 | 一定需要人類核准 |
| Stop | 收到回合停止請求 | 回合已完成、idle |
| Claude Notification idle_prompt | 等待輸入通知 | 即時通知，provider 約 60 秒後才可能通知 |
| Claude Notification permission_prompt | 等待權限通知 | 即時通知，provider 約 6 秒後才可能通知 |
| Codex Interrupt / Claude StopFailure | 中斷／失敗回報 | 任意 exit code 等同模型失敗 |
| SessionEnd | Session 已回報結束 | 程序已退出 |
| owned runtime exit / IPC disconnect | 程序結束／斷線 | 先前活動仍可信 |

所有 observation 30 秒後過期；單一 generation 最多追蹤 128 個 prompt ID，超限保守關閉回報並須重開 pane；缺少可驗證 prompt／turn ID 的舊版本不顯示活動。未知不增加問號，原有程序生命週期仍可見。`/clear` 等可在同程序結束舊 Session，新的 parent SessionStart 會開啟新 generation；已退役的 Session ID 不重用，遇到同 ID 返回時需重開 pane。

## 邊界與驗證

命令僅包含 app-owned executable 與固定事件名稱；payload 由 stdin 讀取，原始輸入上限 4 MiB，選擇性反序列化先忽略提示、路徑、工具內容等欄位，縮減後不超過 64 KiB，再送既有 owner-authenticated IPC。輸入超量／解析失敗會撤銷該 launch 證據，不保留舊回合狀態。per-launch 路由只在程序 environment／broker memory；metadata、argv、log 不含 capability。app 關閉時 broker 仍能接收，runtime 結束、關閉設定、broker 重啟會撤銷。完整掌控同一 OS 使用者的程式不在隔離保證內。

`src-tauri/tests/provider_hooks.rs` 使用合成 provider driver 執行 production callback binary，測試 IPC → broker → subscriber、turn fence、SessionEnd 與撤銷；不等同真實 CLI。真正 native 驗收須在隔離資料目錄使用已安裝 binary，記錄版本與可用事件，不讀取真實歷史／憑證，不新增全域 hooks 或略過信任。

2026-10-18 cloud：Codex binary 0.159.2 可讀版本；實際 session 啟動在 hook 前遭環境 sandbox helper 拒絕。broker socket／PTY 測試在 cloud sandbox 也遭拒絕，尚待 CI／native 執行。不得把 compile-only 或合成 callback 驗證標示為真實 Agent 已驗證。
