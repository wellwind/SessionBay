# OpenCode 整合與驗證

## 支援邊界

2026-10-16 查閱官方最新 release v1.19.2，固定 source commit 7901b7d325c34852caa84fc2c325f3a08dd7a473。此處為原始碼契約與合成資料驗證；未安裝／執行真實 OpenCode，也未驗證帳號登入或模型服務。

第五個內建 provider 涵蓋執行檔探測、單獨 --version 探測、來源卡片與篩選、新工作、索引 Session 接續、手動 ses_ ID、歷史標題／cwd／搜尋／分頁預覽。使用共用 monogram fallback O，沒有捏造品牌圖示。

## 資料與版本

- 來源 root 是含 opencode.db 的目錄。預設是有效絕對 XDG_DATA_HOME 加上 opencode；否則 home/.local/share/opencode。此規則依官方 xdg-basedir 路徑而非自行改成 Windows AppData。
- 讀取 session、message、part，以及存在時的 session_message。單一 Session 有 v2 rows 時只取 v2，不重複混入舊 v1 投影。v1 僅在 session_message table 不存在時讀取；有 v2 table、該 Session 無 v2 rows 但仍有 v1 rows 的混合狀態，無法證明投影權威性，因此 metadata-only partial 並禁止索引接續。官方 v2 reset migration 可能留下 v1 rows，不能把它們當成現行對話復原。這也表示部分合法混合／舊歷史尚未支援，不假設 CLI 一定會遷移。
- 只索引 user 與 assistant 的 text。tool、reasoning、shell、synthetic、ignored、summary／compaction 內容不進全文搜尋；已刪除資料於重新索引後移除。
- 目前可接受 session.version 的正式 1.x 格式至 1.19.2，且必須吻合實際欄位；這不等同每個歷史版本都經實機驗證。未知版號、JSON 缺欄位／損毀或 active revert 會呈現 partial，省略不可靠內容並禁止索引接續。active revert 保守只呈 metadata，避免復原使用者已隱藏文字。
- 舊 storage/session JSON 目錄只提供尚未支援警告，絕不由 Session Bay 遷移。自訂 OPENCODE_DB 檔名／channel DB 尚無自動列舉；來源支援範圍限定 opencode.db。遠端 server attach 不在此 PR 範圍。

## 唯讀與來源身份

原始 DB、WAL、journal 只以唯讀、非 symlink／reparse 的普通檔案開啟。Unix 使用 device/inode，Windows 實作使用平台 PR 的 volume/128-bit file identity 與唯讀 no-reparse handle；Windows 路徑已 cross-compile，但原生安全／執行測試仍未完成。SQLite library 只收到私人暫存 copy，避免 read-only SQLite 仍產生 shm 等 sidecar。檢查來源 before/after 的檔案身分、大小、時間與內容 hash；非空 rollback journal、截斷 WAL、checksum／schema／integrity 不符時保留已提交索引並回報來源錯誤。此保留不代表可預覽／接續：每次預覽與冷接續都重新驗證快照。

所有 source ID、Session ID、db 身分與 snapshot token 分開保存。相同 native ID 在不同啟用來源時阻擋冷接續。已活躍的同來源 runtime 依 DB 實體身分與 provider-qualified key 聚焦，正常 DB 追加不重開程序；runtime key 也固定包含啟動時的 DB 實體身分，即使同路徑換檔後重新索引，也不會冒充舊 runtime。手動接續同樣要求來源 DB 已存在且可安全取得身分。

界限：DB/WAL 各最多 512 MiB，合計 768 MiB；最多 50,000 Sessions、每 Session 100,000 messages、每 v1 message 10,000 parts，單段 JSON 8 MiB、總搜尋文字 32 MiB。超限會明確錯誤，不悄悄只索引前半。預覽每頁至多 200 messages／1 MiB，每則 64 KiB。完整快照與完整性檢查以正確性優先；大型資料庫的差分索引留待專門效能工作。

## 啟動與安裝

- 偵測 PATH 與已知 fallback，包括官方 installer 的 ~/.opencode/bin；也能指定絕對 executable。
- Windows 沿用平台 PR 的原生 .exe/.com 與 PATHEXT 安全解析；不把 .cmd/.bat 拼成 Shell command。官方 Windows 安裝指引可用 [OpenCode Windows](https://opencode.ai/docs/windows/)。npm shim 使用者需指定實際 native executable。
- 新工作：opencode，cwd 作獨立程序欄位。
- 接續：opencode --session ses_ID；不使用 --continue 猜最近 Session、不 fork、不任意開 server。
- OPENCODE_DB 固定指向選定 root/opencode.db，防止程序繼承其他 DB override；設定／credentials 仍由 OpenCode 自己管理，未把備份來源的 auth.json 複製或讀取。
- 白名單只含 --model/-m、--agent、--pure、--auto。--auto 必須明確啟用危險選項，其餘未審核 alias／config／network／identity 選項一律拒絕。舊 CLI 不支援新旗標時仍可能由 CLI 回報錯誤，找到 executable 不保證相容或登入。

## 驗證紀錄

本 PR 疊在平台 PR #3，以下結果須以 OpenCode 最終提交重新檢查。合成 fixtures 的來源說明見 [fixtures README](../fixtures/opencode/README.md)。

- Rust：兩種 SQLite projections、標題／cwd、FTS、分頁、compaction、revert、未知版號、壞 JSON／DB／WAL、取消、唯讀 source bytes、換檔／symlink、重複來源、預覽與啟動 argv、危險旗標 opt-in、同來源 manual/indexed live dedup。
- UI：第五 provider 的既有設定卡片／下拉篩選／icon fallback、設定升級與 safe defaults；保留原有 smoke 回歸。
- 真實 OpenCode CLI、三平台互動接續、Windows ConPTY 與原生 macOS UI 尚待驗收。Linux synthetic stub 成功不能替代它們。
- 沒有修改 workflow、手動啟動完整 CI、merge、deploy 或 release。

### 本機執行結果（2026-10-16）

- 通過：npm typecheck、lint、410 個 Vitest tests 與 production build。
- 通過：完整無 desktop features 的 Rust tests（261 passed、0 failed、1 intentionally ignored）、rustfmt，以及 Linux all-targets Clippy（-D warnings）。
- 通過：Windows GNU target 的 all-targets cross-check／Clippy（-D warnings）；這不是 Windows 原生執行。
- 通過：44 組靜態 UI contrast 與現有 macOS icon representation 檢查。
- 截圖／原生視覺驗收未完成：executor Chromium 的 socket 建立受 sandbox 限制，獨立 cloud browser 無法連到該 executor 的 localhost。未把 DOM 測試冒充原生畫面驗收。

### Review 回歸

- 同路徑 DB 換檔後重新索引，不得返回舊 runtime；舊 pane 明確拒絕，新 pane 與手動接續共用新 DB identity key。正常追加仍可聚焦原 runtime。
- v2 rows 全刪但 v1 殘留時，不恢復舊搜尋／預覽文字，呈 metadata-only partial 並禁止索引接續。
- Windows snapshot entry 使用平台專用 readonly/no-reparse/FileIdInfo 路徑；修正後已重跑 Windows GNU all-targets Clippy，仍未宣稱原生執行通過。
