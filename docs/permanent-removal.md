# 永久移除：唯讀檢查與剩餘安全工作

狀態：只實作來源影響檢查。永久移除（含原始 Agent 對話）尚未完成，沒有 purge IPC、確認權杖或刪除按鈕。原始歷史維持唯讀。

## 本次範圍

回收筒每筆「檢查來源」只傳 tombstone ID。後端在同一 catalog 讀取交易中查詢 snapshot、來源 kind／root／enabled、Session identity 及最多 200 個 indexed artifacts。來源不符或超過上限即拒絕；不接受任意檔案路徑。索引檔案只顯示相對來源路徑、索引大小與當下 metadata 比對結果。共享資料庫顯示為共享儲存，絕不把虛擬索引 key 當成可刪檔案。

路徑包含 symlink、檔案遺失、大小／修改時間／identity 改變或 Unix hardlink 時標示無法確認。非 Unix 尚無 portable hardlink 證據時也保守標示無法確認。回收筒既有 snapshot 不含移入時檔案雜湊；重新掃描後顯示目前索引，不能證明和移入時內容相同，介面固定顯示此限制。這些唯讀檢查不是安全刪除邊界：存在 TOCTOU，metadata 相符不證明 bytes 未變，來源仍可能在檢查後被替換；不產生可重播的執行權杖。沒有讀取對話內容，也沒有停止或啟動 Agent。

## Provider 共用邊界與下一步

所有 provider 經相同 inspection policy 回傳 blocker；目前皆不可執行。

- Codex：列出 indexed rollout；需先確認 provider 版本與完整關聯資料，包括其他索引／metadata 的清理或保留語意。
- Claude：列出 indexed JSONL；需處理主對話與 subagent 的關係，不能把單一檔案誤當完整對話。
- Grok：列出 indexed transcript；需原子協調對話與 metadata，並證明完整清除範圍。
- Antigravity：列出 indexed transcript（若有），標示共享 conversation_summaries.db；metadata-only 不虛構 transcript。下一步是經版本驗證的逐筆 metadata 交易與 transcript 一致性。
- OpenCode：虛擬檔案不顯示為實體路徑；標示 opencode.db 與 sidecars。下一步是經版本驗證的逐筆 SQLite 交易、外鍵及 WAL 一致性，禁止整個資料庫或 sidecar unlink。

先取得各 provider 官方清除 API 或可驗證的跨程序排他協定，才加入執行 adapter。應鎖定指定 Session 及相關 metadata，拒絕未知版本、未知關聯及 active／狀態不明的 Agent。Session Bay runtime 清單只能證明本 app 管理的程序；外部 CLI 不接受本 app 的 mutex、advisory lock 或 snapshot，不能用「本 app 沒在跑」推定安全。app-owned snapshot 只保護副本，不鎖住原始資料，因此不能解決執行安全。

執行前必須產生完整精確計畫（含 catalog 副本、搜尋索引、原始來源、子對話與共享 row），顯示影響與不可復原性，逐次明確確認。後端持有短效、單次 opaque plan ID，不接受 UI 回傳路徑作為授權。取得 provider 排他性後重新驗證內容雜湊、檔案 handle identity、根目錄與父目錄連結、來源配置、catalog revision、active 狀態與關聯集合；任何變化拒絕並重新預覽。需要 crash recovery／部分失敗策略，不能誤報成功或先移除 tombstone 讓資料重新出現。

## 驗證界線

測試只使用 fixtures 與臨時目錄，沒有接觸或刪除實際使用者歷史。UI 覆蓋讀取中關閉、失敗重試與返回；後端覆蓋來源重指、append、link、已還原 ID 與路徑拒絕。原生桌面外觀及 provider 真實清除均未驗收。
