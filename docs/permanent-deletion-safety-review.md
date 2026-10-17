# SessionBay 永久刪除：獨立威脅模型審查

狀態：設計分析，功能未完成；不代表可開啟永久執行。2026-10-17。只使用新建暫存合成資料庫。沒有執行 Agent、讀取使用者原始對話、執行真實刪除或發布。

## 結論

舊的無 guard 探針不是所有 SQLite guard 方案不可能的證明。可維護的 stock-SQLite adapter 在明確的「協作來源／穩定檔案命名空間」契約下仍合理；沒有必要先建大型 VFS。它不能誠實保證在未協作的外部 root/DB/WAL/SHM 置換中仍不誤刪。這不是必須假設惡意同 UID 程序才出現的區別：外部 restore、人工搬移也可能打破該契約。

API 沒回傳 physical DB identity 只阻擋「以 API 證明已授權的既有檔案來源」這條配對路線，不代表直接 SQLite adapter 整體不可能。是否支援 adapter 還取決於原始 session、events、FTS、sidecar 等完整刪除契約，目前它們仍未完成，不應把路徑研究通過當作可發布。

## 威脅模型分層

1. 正常 SessionBay 設定變更、重複點擊、舊確認、受管 Agent 啟動：穩定 source UUID + 設定 generation + 確認 token 綁 trash operation/來源/刪除集合；跨程序 broker/settings 共用 maintenance lease。所有相關設定更新、launch、import/resume 都必須遵守。鎖要在穩定 coordinator 位置，不能跟著可替換來源根移動。舊 broker 沒能力則阻擋。
2. 正常 SQLite 並行 SQL writer：BEGIN IMMEDIATE 讓交易內計畫建立在已取得 write lock 的狀態，其他 writer 回 BUSY/等待。交易內重驗完整 schema、trigger、FK、migration、原始 session 身分和刪除 closure；與使用者確認的集合不同就 rollback 再確認。不能讓 BEGIN 後新發現 children 被默默納入。鎖只控制該 SQLite 實例；commit 後仍可能有活躍 Agent 重建內容，故還需要 managed runtime 停用/lease，而不能只依賴 SQL 鎖。
3. 外部 namespace 變更：NOFOLLOW、dev/ino、HAS_MOVED 可發現某些變更，並非 namespace pin。外部工具若只做 SQL 是第 2 類；若移動、覆寫、恢復 DB/sidecars 是第 3 類，不能聲稱 broker 已涵蓋。
4. 任意同 UID 惡意程序：不應當成本產品的全面安全邊界，該程序本可直接覆寫資料。若具體要求是「即使它換路徑，SessionBay 也不能誤刪另一 DB」，則仍需 handle-relative/VFS/OS namespace protection 或有真實 source identity 的可信 API；排除惡意程序不等於第 3 類誤操作已得到保證。

## 合成實驗與限制

腳本全都不接受使用者來源路徑，建立 TemporaryDirectory 後執行，已實際跑過：

- 基本 C API 探針：系統 libsqlite3 3.46.1 的 C API，OPEN_READWRITE|NOFOLLOW，沒有 CREATE。
- C API ABA 探針（可重現程式見[探針文件](permanent-deletion-probes.md)）：同上，初始化使用 PERSIST_WAL 留下原始 sidecars；guard 檢查來源目錄、DB、WAL、SHM 的 dev+ino、HAS_MOVED 及原始 marker。
- Python ABA 探針（同一探針文件）：Python SQLite 3.53.1，NO_CKPT_ON_CLOSE；Python wrapper 沒有 HAS_MOVED，不能宣稱這個版本實測過該 C API。

結果：

A. open→換 root→BEGIN：SELECT 可仍看到 original；無 guard DELETE 卻刪 replacement 同 ID。故只做 SQL fingerprint 不夠。
B. 同一交換，在 BEGIN 後、DELETE 前加入 root/main identity 與 HAS_MOVED：guard 阻擋，兩 DB marker 都留下。
C. BEGIN→換 root→guard：guard 同樣阻擋。
D. guard→換 root→DELETE：此特定測例刪 original，replacement 留下。這不是一般 race-safe 證明。
E. 真正 ABA：open(original)→換 root→BEGIN→目錄換回→guard→DELETE。3.46.1 的 root/main/WAL/SHM path identities 全相同、HAS_MOVED=0、SELECT original，guard 仍通過；close/read 後兩邊 marker 都消失。3.53.1 的 path/content guards 也通過，且禁 close checkpoint 時 original 留下、replacement 被刪。這是可重現的不該被刪的 DB 受影響案例，並非只以「可能有 ABA」泛稱。
F. 3.46.1 NOFOLLOW 拒絕祖先 symlink。

這些是 Linux 合成 marker DB 交錯測試，沒有驗證 Windows/macOS、全部 SQLite builds、任意 WAL-only replacement、crash/power loss、DB-in-place restore。不要將未測情境宣稱已安全。

## 候選最小實作前提（尚未採用或實作）

本次決策只保留研究，不開啟既有 path 來源寫入。若未來重新評估直接 adapter，須先選明確契約：首版可以只支援穩定 local filesystem + 完整已知 adapter + 來源維護期間無外部搬移/restore + 所有受管 writer/launch 受 lease 控制。若產品要求無條件防外部 ABA，就不要把此路線標為安全。

1. 唯讀 prepare 建立授權計畫：來源 ID/generation、實體目錄/main identity、完整 schema/migration digest、目標 session immutable identity、children/sidecar/event 清單與不可變計畫 hash。DB 的 mtime/data_version 不是永久身分；schema 或內容 hash 也無法區分同內容副本。唯讀 WAL 連線可能仍使用 shared memory，不應廣告成零檔案副作用。
2. 每次永久刪除明確確認後，取得穩定 maintenance lease；重驗來源 generation、已無受管 live session；依支援能力處理外部 writer，不能以 PID snapshot 證明不會再啟動。
3. 開既有 DB（不 CREATE、不讓任意 URI 選 VFS），NOFOLLOW，禁 extension/不信任未知 schema/trigger；採單一已測 SQLite library。開啟後盡早做 guard，BEGIN IMMEDIATE 後再做 identity/HAS_MOVED/schema/內容/closure guard，任何不符立即不執行 DELETE。HAS_MOVED 回 NOTFOUND 不能解讀成沒移動。
4. 同一交易精準刪原始 session＋事件／可重建索引，驗證限定 rows 消失、其他 sentinel 保留。來源成功後才 finalize 本地 catalog/tombstone。跨 DB 原子性不可假裝存在：需要最小無正文 operation journal 和可重試的 partial state。
5. 審核 read/open/begin/rollback/close 的副作用。NO_CKPT_ON_CLOSE 可降低 close 寫入，但不封所有路徑也不修復 ABA。不能隨意清共享 WAL/SHM 或 vacuum 其他 sessions。
6. 完成指定版本合成 failure/crash、重複 ID、多來源、children、sidecar、重掃與 resume 驗收，才決定哪些來源能開啟永久刪除。

若使用者不接受穩定 namespace 的前提，剩下必要工作是源頭提供可信來源繫結的刪除 API、可驗證的平台 handle/namespace 約束，或受測的 VFS。僅多放幾個 stat/HAS_MOVED 不會縮小最後一次檢查後的競態至零。

## 官方來源

- https://www.sqlite.org/c3ref/open.html ：NOFOLLOW 的檔名 symlink 限制；READWRITE 不含 CREATE 的語意。
- https://www.sqlite.org/c3ref/c_fcntl_begin_atomic_write.html ：HAS_MOVED 介面與 PERSIST_WAL；FILE_POINTER 不等於跨平台公開 native fd 保證。
- https://raw.githubusercontent.com/sqlite/sqlite/version-3.53.1/src/os_unix.c ：fileHasMoved 是當下 pathname/inode 比對，不是記錄歷次 rename 的 monotonic latch；不能檢出完整 ABA。
- https://www.sqlite.org/lang_transaction.html ：IMMEDIATE 立即嘗試 write transaction，writer 競爭可回 BUSY。
- https://www.sqlite.org/howtocorrupt.html ：活動 DB rename/unlink、錯配 journals、原生 fd close 破壞 POSIX 鎖的官方警告；直接額外開關主 DB FD 來 fstat 亦需注意。
- https://www.sqlite.org/wal.html ：WAL 是資料庫持久狀態的一部分，不是可隨便丟棄的快取。

## 補充：建議優先的新 API 型來源

這是比「使用者不要搬目錄」更可維護的架構方向，值得優先做設計與全合成 mock 驗證；本次沒有連任何真實 Agent，也沒有實作此功能。

來源的權威身分從建立時就是使用者明確設定的既有官方本機 API endpoint + routing scope + source UUID/generation。列表、內容、fingerprint、狀態和刪除一律走它。不要啟動 server、建立 hooks、掃 port 找服務、把 SQLite path 與 API 人工配對，也不要 fallback 到 CLI/直接 DB 寫入。既有 SQLite 匯入項目仍是不同來源；不能只因 session ID 相同便改記已刪。這明確避開 SessionBay 自己把主 DB 和別人的 WAL 配對的風險，並不聲稱 API 能證明任何 SQLite 的物理身分。

實作範圍建議：

- 限定使用者配置的 loopback literal endpoint，固定 origin、auth identity 與 directory/routing scope；拒 redirects，不使用環境 HTTP proxy 改送，參數由 typed client 產生。endpoint/scope/版本改變時取消舊確認，未知版本 fail closed。既有帳密只走既有授權機制，不為此建立 persistent grants。
- pinned official API capability 驗證；讀取內容與完整 children/pagination 並計算 fingerprint，綁短效一次性確認。source generation lock 防自己改設定、broker 防自己啟動同來源工作。
- dispatch 前重讀 fingerprint、children、活動狀態，變更即停止。一次性 token 在送出前消耗，timeout 記 outcome-unknown，先讀驗證再決定，不盲目重送 DELETE 或宣稱成功。
- API 刪除後驗證已授權 session/children 無法列出或讀取，再清 SessionBay catalog/FTS，留不含原文的防重匯身分與 operation state。不可把健康檢查失敗、401 或任意404當成功，需區分同一來源可連但特定 session 不存在。
- 保留永久刪除逐次明確確認；顯示它實際支援的 API 原始對話刪除語意，而不是不明示地改成只刪 SessionBay 索引。

### 對 OpenCode 1.19.2 的已核實限制

核實官方固定版本 7901b7d325c34852caa84fc2c325f3a08dd7a473 的唯讀原始碼：

1. groups/session.ts 215–225：DELETE 的輸入是 sessionID 與 WorkspaceRoutingQuery，未定義 conditional fingerprint/If-Match 等條件。
2. handlers/session.ts 178–181：直接呼叫 session.remove 後回 true；相對於 deleteMessage 的 assertNotBusy，remove handler 沒有相同 busy assertion。
3. session/session.ts 606–627：會取消背景工作、遞迴當時 children、publish Deleted、移除事件；catch 會 log。部分失敗未必轉成 API 失敗。
4. middleware/workspace-routing.ts：可依 session.workspaceID 決定 remote proxy；同檔 selectedWorkspaceID 優先使用 session 的 workspaceID。loopback 只描述第一跳，不證明刪除只在本機發生。首版應拒未知 workspace、sync owner、分享等超出已審契約的 session；不能只省略 workspace query 就當 local-only。

官方固定 commit 連結：
- https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts#L215-L225
- https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L178-L181
- https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/opencode/src/session/session.ts#L606-L627
- https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts

### 不可抹去的 race／完整性邊界

一次性確認、fingerprint、idle 重驗是有效客戶端減風險機制，不是伺服器內 atomic compare-and-delete。最後 GET 與 DELETE 間其他 client 仍能追加內容、啟動工作、建立 child，刪除可能包含確認後新增的內容或 child。短 TTL 只縮短窗口。broker 只管 SessionBay，無法鎖其他 TUI/API client。若硬性要求「只刪確認版本且絕不碰活動工作」，現有這個 API 沒能力履行，必須有伺服器支援的條件刪除/maintenance lease；不能把客戶端二次 GET 說成已解決。

GET session=404 也不足以證明 events/所有 sidecar 已不存在：上游 remove 在投影 session 刪除之後可能於後續 cleanup 失敗。API 型來源可合理採用官方 delete 語意作來源權威，但已知 partial-failure 和工具輸出完整性仍須另外界定驗收；不能把 API true 或 GET404 宣稱成所有原文物理掃除的證明。

因此建議：優先推進「新 API 型來源」的規格及 mock/fault-injection 測試，保留既有 SQLite 永久刪除關閉。對外承諾限定官方來源 API 的刪除能力，明列 unconditional race；若產品不可接受這個限制，就應要求上游 conditional-delete/receipt 能力，而非補一個大型本機 VFS來解決不同問題。
