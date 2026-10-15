# Antigravity CLI 歷史相容性

更新：2026-10-15。使用者確認使用 **CLI 1.3.5**；本 PR 的對象是 `agy`，不包含同品牌 App／IDE 歷史或 App 匯入。防禦 reader 已加入程式，完整回歸與原生驗收結果以 [MVP 驗證紀錄](mvp-validation.md) 為準。**尚無使用者 CLI 1.3.5 的去識別磁碟樣本，不宣稱已完成該版本實機相容性驗證。**

## 來源與證據

- [官方 hooks](https://antigravity.google/docs/hooks) 說明 CLI root `~/.gemini/antigravity-cli`，對話 transcript 位於 `brain/<conversation UUID>/.system_generated/logs/transcript.jsonl`。這只確認位置，不構成穩定 row schema。
- [官方 issue #618](https://github.com/google-antigravity/antigravity-cli/issues/618) 的公開持久化 capture（標記版本 1.1.3）與 [issue #1022](https://github.com/google-antigravity/antigravity-cli/issues/1022) 的 1.2.2 row 片段確認 `step_index`、`source`、`type`、`status`、`created_at` 及 `content`。前者刻意回報損壞資料，不是乾淨的相容性 golden fixture。
- [社群維護的版本化 reader](https://github.com/lefos13/paseo-plugin-antigravity-cli/blob/9732a84dac308717004b8e70d0be592eaa8052ea/server/sessions.ts) 提供 `conversation_summaries.db` 表格／欄位觀察；其 [持久化 step reader](https://github.com/lefos13/paseo-plugin-antigravity-cli/blob/9732a84dac308717004b8e70d0be592eaa8052ea/server/subagents.ts) 與 fixtures 是實作證據，**不是 Google 保證**。該專案聲稱支援到 1.3.5，不代表每份磁碟 fixture 都由 1.3.5 產生；1.3.5 stdout compact fixture 也不能代替持久化格式。
- [官方 changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md) 說明 compact／rewind 會影響歷史。採完整重建策略，不假定 transcript 只追加。

測試只使用自行編寫的合成資料，保留觀察到的欄位與關係，不提交公開 capture 中的真實對話、工具內容或帳號資料。沒有執行第三方 plugin，也沒有讀取使用者真實 Agent 歷史。

## 可讀取內容與降級

- 設定以同一四工具流程提供「偵測歷史來源 → 加入草稿 → 儲存 → 掃描」。偵測只檢查官方 CLI root 與 `brain`，不執行 Agent，不搜尋整顆磁碟，不自動加入來源。升級保留原 sources，沒有自動索引新 root。
- 正文只讀官方 `transcript.jsonl`。`transcript_full.jsonl` 可能保留已撤銷／清除的舊內容，因此**不自動讀取或混合 full 正文**；只有 full 時仍可列出 UUID／既有 DB metadata，但預覽明示內容不可用。清空衍生索引後也不以 full 重建舊文字，`full` 名稱不代表完整且仍有效的歷史。
- 按 `step_index` 顯示已知文字；只將 `USER_EXPLICIT/USER_INPUT` 與 `MODEL/PLANNER_RESPONSE` 的文字納入搜尋與預覽。MODEL 亦可能是工具結果，不能單憑 source 推定 assistant。推理、工具參數／輸出、checkpoint 等不索引為對話文字。
- 僅拆除已知完整外層 USER_REQUEST／ADDITIONAL_METADATA 包裝；一般使用者文字、內嵌標籤與空白保留。未知 schema、壞行、缺時間、truncated_fields 與衝突重複 index 以 partial／warning 呈現，不把無法解析誤報成完整空對話。
- 完全相同的重複 step 去重；同 index 衝突保守隔離。官方 transcript 中可辨識的 CLEARED 不顯示舊文字，未知同 index row 也隔離，避免以較舊已知 row 填回。檔案追加、縮短、重寫及 metadata 改變都重新評估，過期預覽提示重新索引；UI 同 ID 刷新與分頁有 generation guard，以及涵蓋整份索引快照的 opaque snapshotId。背景掃描沒有改變內容時保留已載入較早頁與捲動位置；改寫舊頁即使最新頁未變也會重新載入，不混接不同快照。
- metadata 只取原生 title、workspace file URI、更新時間與 parent ID；無 metadata 時標題退回可辨識的 ID／來源文字，cwd 保持未知，不從工具指令或任意 prose 猜工作目錄。多個工作目錄不能擅選一個。
- 排序優先採 DB `last_modified_time`，進入 catalog 時統一為 UTC 毫秒；缺少該值才依已知事件時間／檔案 mtime 降級，不把字串格式差異當成活動先後。
- 只有 metadata、缺 transcript 的對話可列出，但明示內容不可用並禁用索引接續；不能以 DB 的 preview 欄位假造完整對話。

## 原始資料唯讀

SQLite 只開啟應用自有私密暫存副本，**不把來源 DB 路徑交給 SQLite**。這避免 readonly WAL 連線在來源旁建立 sidecars；來源 DB／WAL 在複製前後驗證身份及內容，變動或無法形成穩定快照時保留既有衍生索引並顯示警告，不對來源 checkpoint／修復。

合法 WAL reset 留下舊世代尾端時，只將私密副本裁剪至最後驗證 commit，並顯示警告；原檔保持完整且不變。同世代 checksum 損毀、不完整 frame、hot journal 或讀取中變動皆拒絕更新並保留既有索引。錯誤文字最多 2048 bytes，metadata 警告最多 100 筆加省略摘要。

上限：transcript 128 MiB、單 JSONL row 8 MiB；brain 列舉最多 100,000 個 entry／深度 4；DB 與 WAL 各 128 MiB、快照合計 256 MiB；metadata 最多 50,000 列／32 MiB 輸出。預覽每則 64 KiB、每頁 1 MiB／200 則。取消掃描會停止後續工作；上限不是對網路檔案系統 wall-clock 延遲的保證。[SQLite readonly WAL 文件](https://www.sqlite.org/wal.html#read_only_databases) 與 [immutable 參數警告](https://www.sqlite.org/uri.html#uriimmutable) 說明為何不能用 immutable 宣稱正在被 CLI 改寫的來源永遠不變。

## 接續邊界

[官方接續形式](https://antigravity.google/docs/cli/commands/resume/) 是 `agy --conversation <id>`。executable、argv、cwd 分開傳遞，不組合 Shell 指令。

- 索引接續限 canonical root 等於目前 HOME 下的原生 CLI store，且 UUID／來源／檔案與 metadata 身份通過檢查。備份 root 只供讀取，不改 HOME、不虛構來源環境變數。帶 parent ID 的子代理直接接續未經驗證，也會說明需開啟父對話。
- `Session.resumeDisabledReason` 表示該筆為何僅能預覽；UI 顯示原因並禁用接續，backend 仍於預檢與實際啟動獨立強制檢查。
- 原記錄 cwd 缺失或路徑不可用時，使用者須明確選擇接續目錄；原始 cwd 與重新定位值分開顯示，不修改 Agent 歷史。
- 手動輸入 ID 不建立虛構 catalog 關聯；原 CLI 是否存在該對話、登入狀態與真正恢復結果仍由原 CLI 決定。磁碟 RUNNING 狀態也不等於目前仍有存活程序。

## 尚待版本驗收

以 CLI 1.3.5 建立無敏感內容的測試對話，保留欄位名／型別／ID 關係並替換路徑與正文。至少核對 user／assistant、多輪、工具、title／cwd、parent、compact 前後、缺失／半寫入及實際 `--conversation` 接續；不需要分享憑證或完整私人 brain。若當前版本格式不同，保留可用 metadata 並明確提示不支援的欄位，不能靠猜測吞掉內容。
