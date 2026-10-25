# Session 移到系統垃圾桶

狀態：Codex、Claude Code、Grok、Antigravity 已實作；OpenCode 因 Session 存在共用 `opencode.db`，尚未支援。合成資料整合測試通過；macOS 真實 Agent 資料夾仍待使用者實測。

## 流程

1. Session 先移入 Session Bay 資源回收筒（只隱藏索引，不動檔案）。
2. 回收筒每筆的「移到系統垃圾桶…」只傳 tombstone ID。後端重用來源檢查，加上各 Agent 的附屬檔案規則，回傳逐項清單、保留不動的共享儲存與阻擋原因。
3. 沒有阻擋原因時，後端保存計畫並回傳單次使用的計畫 ID（10 分鐘有效）。使用者勾選確認後才能執行。
4. 執行時重新建立計畫；項目、大小、項目數或最新修改時間有任何差異就不移動任何檔案。
5. 逐項移到系統垃圾桶（macOS 使用 `NSFileManager`，不需 Finder 自動化權限）。只要有項目移出，就從索引與回收筒移除這個 Session；從系統垃圾桶放回後重新掃描即可再次出現。

## 各 Agent 範圍

| Agent | 移到垃圾桶 | 保留不動 |
| --- | --- | --- |
| Codex | 已索引 rollout、`browser/sessions/<ID>.toml`、`tui-thread-reference-capabilities/<ID>` | `state_*.sqlite`、`thread_history_*.sqlite`、`history.jsonl`、`session_index.jsonl` |
| Claude Code | 主對話 `projects/<專案>/<ID>.jsonl` 與同名資料夾（含 subagent）、`session-env/<ID>`、`file-history/<ID>`、`debug/<ID>.txt`、`todos/<ID>-*.json`；subagent Session 只移自己的檔案 | `history.jsonl` |
| Grok | 整個 `sessions/<工作目錄>/<ID>/` | `prompt_history.jsonl`、`session_search.sqlite`、`active_sessions.json` |
| Antigravity | `brain/<ID>/`、`conversations/<ID>.db{,-shm,-wal}`、`annotations/<ID>.pbtxt` | `conversation_summaries.db` |
| OpenCode | 尚未支援 | `opencode.db` |

共享儲存可能仍留有這個 Session 的片段（例如輸入歷史、摘要或狀態索引）；Agent 自己的 resume 清單可能仍顯示無法開啟的項目。

## 阻擋條件

- Session Bay 中仍有執行、停止中或狀態不明的工作使用這個 Session（Session ID 或 resume ID）。
- 任一項目在最近 2 分鐘內有寫入；Antigravity 另檢查 `presence/<ID>.lock`。
- Session ID 不是單純檔名字元（`[A-Za-z0-9._-]`，最多 128 字）。
- 路徑包含連結、離開來源根目錄、類型不符，或資料夾超過 20,000 個項目。
- 已索引檔案已變更、遺失；Grok／Antigravity 的檔案不在單一 Session 目錄中。

這些條件只能降低風險，不能排除 Session Bay 以外程序在檢查後寫入。永久刪除（不經系統垃圾桶）仍未開放，見[永久移除](permanent-removal.md)。

## 驗證

- `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --test os_trash`：四種 Agent 的合成資料搬移、共享儲存保留、執行中／最近寫入／確認後變更的阻擋與單次計畫。
- `npx vitest run src/recycle-bin.test.tsx`：確認勾選、阻擋狀態、失敗後重新檢查與過期回應。
