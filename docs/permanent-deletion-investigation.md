# 本機原始 Session 永久刪除：契約核實

狀態：docs-only 調查候選。永久刪除功能未完成，尚未實作或開啟任何來源寫入功能。2026-10-17。

需求是逐筆永久移除資源回收筒項目及它對應的本機 Agent 原始對話；不包含默默刪除雲端對話、刷新登入、清除工作區或磁碟安全抹除。每次執行都需要獨立明確確認。

## 已驗證基準

- 文件交付基底：SessionBay `3a69b5799c59bcf8355a1b4fa3277b3175a33f14`；初次程式調查基底為 `9f95f8598bc9126b38300f216bb33a9f330f66b0`。
- OpenCode v1.19.2：`7901b7d325c34852caa84fc2c325f3a08dd7a473`。
- Grok Build 官方 main 核實快照：`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`。
- 所有研究均未執行 Agent，未讀取或刪除使用者真實對話。

## OpenCode

官方有 [session delete CLI](https://opencode.ai/docs/cli/#delete) 與 [DELETE /session/:id](https://docs.opencode.ai/docs/server/#sessions)，但不直接用 CLI 作刪除 adapter：啟動流程、版本相依的插件及資料遷移副作用需要隔離，CLI 成功狀態也不能代替實際資料驗證。

### v1.19.2 的資料庫契約

[完整 fresh DDL](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/database/schema.gen.ts) 包含下列表：

account、account_state、control_account、credential、data_migration、event、event_sequence、message、part、permission、project、project_directory、session、session_context_epoch、session_input、session_message、session_share、todo、workspace。

另有 migration 執行器建立的 migration 表。必須驗證完整 schema 和 migration 集合；session.version 不是可靠的 schema 版本。現有 SessionBay reader fixture 刻意省略大量欄位與外鍵，不能作刪除實作依據。

- message、todo、session_share、session_message、session_input、session_context_epoch 的 session 外鍵會 cascade。
- part.message_id 會 cascade；part.session_id 沒有外鍵。
- session.parent_id 沒有外鍵，不能假設 child 隨 parent 自動刪除。
- event.aggregate_id 只連 event_sequence.aggregate_id，不連 session。

官方 [remove](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/opencode/src/session/session.ts#L606-L627) 遞迴處理 children、發布 Deleted，然後刪事件 aggregate。[Deleted projector](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/session/projector.ts#L257-L259) 刪 session；[events.remove](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/event.ts#L514-L523) 清除對應 event_sequence 與 event。

因此只刪 session 不完整：event.data 可能保留正文，事件重播也可能重建狀態。離線 adapter 必須在同一交易精準處理 session 與事件 aggregate，並驗證關聯列均已消失；不可清掉共用 DB、WAL 或 SHM。

### 不能忽略的檔案

- 舊版可能留下 storage/session_diff/<ID>.json。
- 非 Git 的 plans 在資料根，Git 專案的 plan 可在工作區 .opencode/plans。
- [tool-output-store](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/tool-output-store.ts#L116-L172) 把完整工具正文寫入 tool-output/tool_<generatedID>，檔名沒有 session ID。
- [snapshot](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/snapshot.ts#L90-L140) 是 project 共享儲存，不可整個刪除以處理單一 session。

可研究的首版子集是完整已驗證 schema、純 DB、無 children、無分享／同步 owner／workspace，以及沒有額外原始正文儲存的 leaf session。目前尚未證明這個子集的完整檔案排除契約，不能當作已支援。

## Grok Build

官方 [CLI reference](https://docs.x.ai/build/cli/reference) 提供 grok sessions delete，但[實作](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/sessions_cmd.rs) 會嘗試刷新驗證狀態；已登入且非 ZDR 時會先刪遠端，且沒有 local-only 旗標。不符合本需求的本機來源範圍。

[本機 storage adapter](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/jsonl/mod.rs) 使用 sessions/<encoded-cwd>/<session-id>/，但其完整對話可能包含 chat_history、updates、summary、工具輸出及其他 sidecar。不能只刪已索引的 updates.jsonl。

[正式刪除流程](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/persistence.rs) 除了移除對話目錄，還清除 [shared FTS cache](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-session-search/src/fts.rs)。預設 cache 路徑是 sessions/session_search.sqlite，可能有 journal-mode 相依的實際路徑。獨立 child 目錄、重複來源候選及部分失敗必須另行處理。

## 實作開啟條件

1. 來源 adapter 的完整契約、支援版本、未知欄位／sidecar 的 fail-closed 規則。
2. 可在寫入期間綁定來源及 DB/WAL/SHM 身分的路徑保護；canonicalize 加事後 stamp 不能自行證明寫入安全。
3. 共享 broker 對 launch 與刪除序列化；舊 broker 無 capability 就阻擋，不能為此重啟現有 Agent。
4. 確認綁定特定 Trash operation、來源與刪除計畫；失效／變更後要求重新確認。
5. 保留不含正文及恢復快照的最小永久身分；重掃在匯入前阻擋對應內容寫回 catalog/FTS。
6. 用合成資料驗證子對話、重複 ID、來源替換、symlink/reparse、活躍 writer、失敗／crash recovery、直接 transcript/resume 入口。
7. 完成獨立安全審查後才發布。

尚未執行功能測試，因目前沒有開啟永久刪除功能。外部未受管 CLI、匯出／備份、工作區產物及 SQLite 物理殘留不能被宣稱一併消除。

## 合成來源替換負面探針

可重現程式與結果見[合成負面探針](permanent-deletion-probes.md)。只在新的暫存目錄產生 marker DB，不接受真實來源路徑，也不執行 Agent。

2026-10-17，Python 3.12.14／SQLite 3.53.1：connection 開啟後、BEGIN IMMEDIATE 之前換根，UPDATE 成功，卻改到 replacement 的可見資料；BEGIN 之後換根則修改原本來源。此結果不是安全寫入驗收，而是證明事前路徑檢查不夠的負面案例，不能據後兩個案例推論所有競態安全。

本次不實作大型 VFS。穩定 namespace 前提下的 stock-SQLite adapter 仍可研究；若要求防止任意外部路徑 ABA，則一般字串路徑 connection 與 stat／HAS_MOVED 檢查不能自行提供完整身分約束。SQLite [WAL 文件](https://www.sqlite.org/wal.html) 與 [close-time checkpoint 設定](https://www.sqlite.org/c3ref/c_dbconfig_defensive.html) 也顯示需要處理連線開關的來源寫入副作用。

補充 v1.19.2：[share/session.ts](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/opencode/src/share/session.ts) 已停用新分享，unshare 只清本機連結；不可把舊版遠端 unshare 行為當作此版本事實。舊分享／遺留資料的來源完整性仍需另驗。

## 已採決策與可維護路線

既有 SQLite path 來源維持唯讀。OpenCode [`/path` handler](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts) 回傳 home、state、config、worktree、directory，沒有 data root、DB 路徑或實體身分；即使兩份資料庫的 session ID、內容與 fingerprint 全相同，也不能把手動配對的 API 當作選取檔案來源的權威。不得先刪再用本機 DB 檢查發現其實刪了另一份副本。

### 選項一：新增 API 型來源（優先評估，尚未核准實作）

來源建立時的權威就是使用者明確指定的既有 endpoint＋routing scope＋source UUID/generation；列表、正文、狀態及刪除全部走同一來源。不掃 port、不自動啟動 server、不建立憑證、不轉換既有 SQLite 匯入項目的身分。設定相同 session ID 不能讓另一個 path 來源被標為已刪。

成本為中等：新增來源模型、typed HTTP client、認證與路由邊界、API 匯入／查詢與故障測試；不必維護平台檔案寫入 VFS。但現有 OpenCode API 沒有 atomic compare-and-delete／idle lease，會遞迴當時 children，cleanup 可部分失敗，loopback workspace routing 也可能轉遠端。因此新來源本身不是永久執行已可交付的證明；若不能滿足逐次確認的精確集合和活動保護，仍需上游能力或停用該執行能力。

### 選項二：受管 provider control transport（較高成本）

由 provider 端明確回報穩定來源身分、routing scope 與 capability，提供綁來源／版本的 maintenance lease、原子 idle 檢查、精確 children closure 和條件刪除；可驗證 receipt 應涵蓋主存儲、事件／搜尋索引與對話正文 sidecar。SessionBay 的 broker 必須與設定、launch、import/resume 共用穩定協調鎖，舊 broker 缺 capability 就阻擋，不為刪除重啟現有 Agent。

成本為高：provider 協作或上游改動、版本協商、跨程序 lease／crash recovery、平台與升級測試。受管啟動方式、既有程序遷移和任何持久授權都要另做產品設計與明確同意，不能擅自改使用者現在的啟動架構。

### 範圍與確認介面

刪除目標是該來源的原始 session／對話主存儲、會使歷史重現的索引，以及 Agent 仍能讀回的該對話正文（含相關 tool-output）。不承諾磁碟安全抹除、OS cache、外部備份或刪除無關的獨立工作區 artifact。確認要分別列出實際刪除集合與保留內容、來源與 endpoint／routing、children、不可復原影響；集合或來源改變須重新確認。

最小永久隱藏身分不保留 title、cwd、正文或可恢復 snapshot；匯入前即擋回流，還要清 SessionBay 的 files/messages/FTS 與阻擋直接 transcript/resume 入口。它只保證對同一已識別來源身分的 SessionBay 重掃行為，不能保證外部 Agent 不會產生不同身分的新歷史。跨來源刪除與 catalog finalize 沒有天然原子性，需無正文 operation journal，timeout／部分失敗標示 outcome unknown，不能盲目重送。

## 待實作的非破壞性 prepare／能力測試

本階段只有文件及合成負面探針，沒有產品 prepare command、mock HTTP client 或能力檢查實作。下一階段應先驗證：

- 既有 path 來源＋人工 endpoint 配對一律不產生可執行刪除計畫。
- 新 API 來源 generation／routing／auth identity／版本變更，使一次性短效確認失效；拒 redirect、環境代理與非批准 origin。
- 缺 atomic idle／conditional closure／local-only routing／cleanup receipt 能力時，明確回報不足；不把二次 GET、true、一般 404 或健康檢查失敗當完整成功。
- managed broker lease 與設定／launch 競態測試，分開外部未受管 client／namespace 競態；無法完全偵測所有外部程序。
- 全合成 mock：children 增加、writer、遠端 workspace、401、timeout、cleanup 部分失敗、舊 broker、token 重放、重掃與 partial recovery；不接觸真實 Agent。

獨立分析及普通競態與 ABA 的分層見[安全分析](permanent-deletion-safety-review.md)。
