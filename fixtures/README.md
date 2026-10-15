# 合成歷史 fixtures

全部資料為人工建立的合成紀錄，不包含真實對話、憑證、使用者路徑或附件。日期與識別碼僅供測試。

- `codex/standard.jsonl`：`session_meta`、`response_item`、重複的 `event_msg`、中文／識別字、工具輸出。
- `claude/standard.jsonl`：`sessionId`／初始 `cwd`、字串與內容區塊、中文、附件占位及不納入搜尋的工具結果。
- `claude/subagent.jsonl`：保留 parent session 的子代理，預設不列為主工作。

格式基準為 docs/agent-integrations.md 所列本機 JSONL 觀察；未聲稱特定 CLI 發行版本已完成實機相容測試。測試另外在暫存目錄產生缺欄位、半行、壞行、未知事件、截斷、同 inode 改寫、替換、搬移、刪除、重複來源、取消及重新掃描資料。

主要 cwd 規則：Codex 優先 `session_meta.payload.cwd`，缺失才用第一個有效 `turn_context.cwd`；Claude 以第一則 user／assistant 訊息的有效 cwd 為起始工作目錄。後續 cwd 不改初始分組。缺失或非絕對 cwd 為未分類；來源原值仍保存。現存 symlink 透過 canonical path 合併；不轉換大小寫，不合併 repo／worktree。

搜尋規則：SQLite 參數化 `instr(lower(text), lower(query))`，提供字面子字串搜尋，支援中文單字／短詞與程式碼識別字；英文 ASCII 不分大小寫。`%`、`_`、引號沒有萬用字元／SQL 語意。沒有詞幹、模糊或非 ASCII 大小寫折疊。索引 title、user／assistant 的純文字區塊；工具、附件與 reasoning 只有預覽占位。長度至少三個 Unicode 字元時，先以 FTS5 trigram 選候選，再以相同 `instr` 精確比對；短詞維持子字串 fallback。schema v2 交易式 migration 重建既有資料的 trigram 索引，insert／update／delete triggers 與來源變更同交易提交。效能仍需以各平台實際資料量量測。

檔案追加只解析 checkpoint 後完整行；有變更時會串流驗證已完成前綴的 SHA-256，避免同 inode 改寫後追加造成過期索引。故追加解析量是新增行數，但前綴驗證 I/O 隨檔案大小增加。尾行即使是合法 JSON，只要尚無換行，仍留到下一次掃描。

預覽額外限制：每則訊息最多 64 KiB UTF-8 文字，超過會加上明確截短標示與 warning，仍可搜尋完整的受支援紀錄文字。每頁文字總量最多 1 MiB，超出以 beforeLine 分頁繼續；不會切斷 UTF-8 字元。超過 8 MiB 的單筆 JSONL 紀錄只顯示占位且不納入搜尋。

FTS5 技術依據：SQLite 官方 https://sqlite.org/fts5.html 的 trigram tokenizer、external-content triggers、rebuild 與 integrity-check（2026-10-15 查閱）。FTS5 使用 detail=none、columnsize=0；MATCH 候選查詢只由程式產生最多 32 個均勻抽樣、不重複、雙引號轉義的三字元項目 AND 組合，再對完整原查詢精確比對。使用者輸入保持參數化字面文字，不是 FTS 運算式。
