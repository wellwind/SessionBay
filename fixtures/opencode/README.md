# OpenCode 合成 fixtures

本目錄不是實際 CLI 擷取資料。測試以 schema.sql 在臨時目錄產生 SQLite／WAL，對話文字、ID、目錄、時間全為人工合成。未執行 OpenCode、登入、讀取 auth.json 或使用任何真實對話。

依據 2026-10-16 查閱的官方 release v1.19.2，固定 commit：7901b7d325c34852caa84fc2c325f3a08dd7a473。

- [SQLite table definitions](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/session/sql.ts)：session、message、part、session_message；schema.sql 只保留 reader 會使用的欄位，另含 time_created/time_updated 以符合儲存時間結構。其他官方欄位、外鍵與業務索引刻意省略，不宣稱可由 CLI 開啟這些 fixtures。
- [v1 user/assistant/text types](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/schema/src/v1/session.ts)：message.data 不含 id/sessionID；part.data 不含 id/sessionID/messageID。只使用 role、summary、text、synthetic、ignored 等 reader 所需欄位。
- [v2 event types](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/schema/src/session-message.ts)：session_message.type 在欄位中，data 不含 type/id；user.text、assistant.content 的 text/reasoning/tool，以及 compaction.summary。

測試刻意產生缺欄位、未知版本、截斷 JSON、損毀 SQLite／WAL、重複序號、revert、compaction 等失敗情境。這些異常是負面測試，不代表官方有效資料格式。

- [v2 reset migration](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/database/migration/20260622170816_reset_v2_session_state.ts) 會清除 v2 state，但不清除 legacy message/part。測試模擬 v2 全刪後仍有 v1 rows，確認 reader 不復原權威性不明的文字。v1-only 測試會移除 session_message table；這是 reader 的保守支援邊界，不宣稱所有官方版本都以此區分 projection。
