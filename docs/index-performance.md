# 索引效能：合成生命週期量測

量測日期：2026-10-16。範圍是獨立索引效能 PR，沒有讀取真實使用者歷史，也不以此完成所有效能或平台驗收。

## 改善內容與安全邊界

1. 重用 message INSERT／upsert 與 checkpoint SELECT 的 prepared statements，避免每個訊息／檔案反覆編譯同一 SQL。
2. Codex 同時記錄 event_msg fallback 與 response_item canonical 時，原去重 SQL 對每個 fallback 掃描該檔 canonical 訊息。改成每個檔案建立 SQLite TEMP digest／role 候選索引，再以原文字、角色及 file ID 精確確認；SHA-256 相同本身不會使訊息隱藏。
3. 沒有 fallback 的檔案直接略過去重寫入。TEMP 只存 digest、rowid、role、fallback，逐列讀取文字，不將整份對話留在 Rust HashMap，也不加入持久 schema。連線要求 FILE 暫存與約 2 MiB page-cache 目標，並非整個程序的記憶體硬上限。編譯期設定仍可能影響 TEMP 儲存，見[官方依據](sources.md#索引效能與暫存候選索引)。

來源檔案唯讀；既有身份、prefix hash、前後 metadata、改寫、compaction、取消／rollback 與 stale snapshot 檢查不變。取消時該檔交易回滾；TEMP 候選不跨檔使用。沒有跳過解析、取樣來源正文或縮小搜尋範圍來取得速度。

## 環境與方法

- Before：`a609f04101604501895186f14dad9ad77d44989c` 的產品程式，加上本次相同 benchmark harness。After：本 PR 的 `catalog.rs`；核心變更僅上述熱路徑，沒有修改搜尋 SQL。
- Debian 13.6 x86_64、Linux 6.18.44；環境回報 AMD EPYC 9V74、9 logical CPUs、約 9.7 GiB memory，overlay filesystem。共用雲端環境，沒有 CPU／I/O 獨占或固定頻率保證。
- Rust 1.99.0、release profile、Cargo.lock，rusqlite 0.37.0／bundled SQLite 3.50.2。編譯與量測分開、各 benchmark 依序執行，沒有同時執行本工作的編譯。
- 每個程序產生全新合成來源及空 catalog。`coldIndex` 指空索引第一次掃描；來源剛寫入，**不是 OS 冷 page cache／冷磁碟**。資料生成與來源 SHA-256 完整性檢查不計入 phase 耗時。
- 每組量測空索引一次、未變更補掃三次、單檔追加一次、同大小重寫一次。補掃表列三次中位數；其餘是單次 wall time。10k 另做一組 before／after 重複量測，保留全部結果，不挑較快樣本。
- 每次搜尋先 warm 一次，再取 20 個樣本；p50／p95 為排序後第 10／19 個值。Session title 固定為不包含查詢詞的中性標題，以免標題命中掩蓋正文搜尋成本。
- RSS 是 `/proc/self/status` phase 結束時的樣本；peak 是 `getrusage(RUSAGE_SELF)` 的程序累積高水位，包含 fixture 生成及改寫 buffer。兩個介面的記帳／取樣可能不同，不能拿它們推導精確 heap allocation。沒有量測 WebView、GPU、Agent 子程序或 UI 回應。

## 資料集

三組皆為合成 Codex JSONL；沒有以此推論其他 adapter 的效能。

| 資料集 | Session 數 | 每 Session 邏輯訊息 | 實際來源 | 特性 |
| --- | ---: | ---: | ---: | --- |
| 一般 | 1,000 | 20 | 100.59 MiB | user／assistant 交替，中文與程式碼識別字 |
| 壓力 | 10,000 | 40 | 2,011.27 MiB | 同上；總共 400,000 則正文 |
| 長對話 | 1 | 2,000 | 39.57 MiB | 每則各有一份 fallback 與 canonical，4,000 筆來源訊息 |

原始 JSON 保留實際 bytes 與固定檔名＋內容的 SHA-256。Before／after 每組 digest 相同；測試斷言掃描未變更來源、追加 sentinel 可搜尋、同大小改寫後舊 sentinel 不可搜尋，以及可見訊息數不因 fallback 雙份而增加。

## 結果

第一組空索引：1k 由 4.20 秒降至 3.04 秒，10k 由 79.84 秒降至 65.69 秒。10k 重複組為 70.47→59.25 秒。長對話追加一則由 8.42 秒降至 0.145 秒；這是合成資料觀測，非所有來源的速度保證。

### 索引生命週期

單位 ms；未變更補掃為三次中位數，其餘每組各一次。改善為 `(before - after) / before`，負值代表變慢。

| 資料集 | Phase | Before | After | 耗時減少 |
| --- | --- | ---: | ---: | ---: |
| 1k | 空索引 | 4,204.778 | 3,038.781 | 27.7% |
| 1k | 未變更補掃 | 21.601 | 13.672 | 36.7% |
| 1k | 單檔追加 | 39.452 | 13.978 | 64.6% |
| 1k | 同大小重寫 | 28.336 | 18.560 | 34.5% |
| 10k 第一組 | 空索引 | 79,835.461 | 65,686.259 | 17.7% |
| 10k 第一組 | 未變更補掃 | 224.327 | 167.520 | 25.3% |
| 10k 第一組 | 單檔追加 | 223.377 | 157.528 | 29.5% |
| 10k 第一組 | 同大小重寫 | 208.793 | 155.695 | 25.4% |
| 長對話 | 空索引 | 8,187.287 | 1,038.629 | 87.3% |
| 長對話 | 未變更補掃 | 0.462 | 0.856 | -85.2% |
| 長對話 | 單檔追加 | 8,418.166 | 144.809 | 98.3% |
| 長對話 | 同大小重寫 | 11,156.518 | 1,732.752 | 84.5% |
| 10k 重複組 | 空索引 | 70,468.007 | 59,248.856 | 15.9% |
| 10k 重複組 | 未變更補掃 | 207.503 | 160.243 | 22.8% |
| 10k 重複組 | 單檔追加 | 246.251 | 168.169 | 31.7% |
| 10k 重複組 | 同大小重寫 | 206.862 | 163.645 | 20.9% |

### 搜尋 p95

每組每 query 20 次 warm 樣本；單位 ms。各組皆維持完整 Session 結果數。

| 資料集 | Query | Before | After |
| --- | --- | ---: | ---: |
| 1k | `中文` | 13.390 | 4.856 |
| 1k | `session_bay_identifier` | 177.792 | 217.285 |
| 1k | `SESSION_BAY_IDENTIFIER` | 145.334 | 152.287 |
| 1k | `unique_needle_0.` | 15.094 | 9.866 |
| 1k | `no_match_exists` | 1.552 | 1.704 |
| 10k 第一組 | `中文` | 51.223 | 50.892 |
| 10k 第一組 | `session_bay_identifier` | 2,918.893 | 5,274.128 |
| 10k 第一組 | `SESSION_BAY_IDENTIFIER` | 3,515.921 | 2,824.878 |
| 10k 第一組 | `unique_needle_0.` | 14.194 | 15.503 |
| 10k 第一組 | `no_match_exists` | 10.501 | 13.598 |
| 長對話 | `中文` | 0.498 | 0.946 |
| 長對話 | `session_bay_identifier` | 38.884 | 29.759 |
| 長對話 | `SESSION_BAY_IDENTIFIER` | 29.469 | 36.146 |
| 長對話 | `unique_needle_0.` | 27.987 | 27.278 |
| 長對話 | `no_match_exists` | 1.159 | 1.202 |
| 10k 重複組 | `中文` | 45.433 | 52.481 |
| 10k 重複組 | `session_bay_identifier` | 2,593.904 | 2,573.904 |
| 10k 重複組 | `SESSION_BAY_IDENTIFIER` | 2,791.673 | 2,804.558 |
| 10k 重複組 | `unique_needle_0.` | 16.729 | 15.953 |
| 10k 重複組 | `no_match_exists` | 12.545 | 11.106 |

10k 小寫 identifier 第一組 p95 **2,918.9→5,274.1 ms，觀測到變慢**；重複組為 2,593.9→2,573.9 ms。不能以第二組取代第一組，也不能只因搜尋 SQL 未改就排除回歸。共用環境下兩組不足以分離排程、I/O、cache 與資料庫布局影響；後續仍需隔離環境 profiling。兩組均未達 1 秒目標。

### 記憶體

單位 MiB，欄位為 Before→After。RSS 是當時樣本，peak 是程序累積高水位，不能直接互相相減。

| 資料集 | 空索引結束 RSS | 空索引結束 peak | 全流程 peak |
| --- | ---: | ---: | ---: |
| 1k | 7.16→7.29 | 7.02→7.24 | 7.02→7.24 |
| 10k 第一組 | 16.57→16.70 | 17.48→17.77 | 18.63→18.93 |
| 長對話 | 6.16→6.32 | 6.15→6.79 | 85.28→85.48 |
| 10k 重複組 | 16.60→16.67 | 17.64→17.71 | 18.80→18.87 |

長對話全流程 peak 包含 benchmark 用字串執行同大小 rewrite 的暫存 buffer；不是純索引器的 heap 峰值。這次沒有主張降低記憶體，也沒有以主程序數字代替整個桌面應用。

### 原始資料

- 1k：[Before](validation/index-20261016-before-1000.json)／[After](validation/index-20261016-after-1000.json)
- 10k 第一組：[Before](validation/index-20261016-before-10000.json)／[After](validation/index-20261016-after-10000.json)
- 長對話：[Before](validation/index-20261016-before-large.json)／[After](validation/index-20261016-after-large.json)
- 10k 重複組：[Before](validation/index-20261016-before-repeat-10000.json)／[After](validation/index-20261016-after-repeat-10000.json)

## 尚未解決與驗收限制

- 10k 高命中率英文／識別字搜尋仍超過路線圖 p95 1 秒的工程目標；此次沒有修改查詢策略。數字有明顯波動，不能宣稱搜尋無回歸或已達標。
- 一檔長對話的未變更重掃是次毫秒等級，設定 TEMP connection 的固定成本與排程雜訊可大於相對改善；原始結果完整列出。
- 合成資料只證明這些工作量的瓶頸與改善；不代表所有 Agent、真實私人來源、SSD 或各平台都相同比例加速。尚缺原生 UI、CPU profiling、真正冷磁碟與使用者資料量驗收。
- 增量追加仍依原規則驗證完整既有 prefix，沒有用較弱的 metadata 捷徑代替安全檢查。極大檔案仍可能有線性 I/O；未知格式、超大行與來源競態仍依原錯誤／partial 行為處理。
- 第 10 項[後續待辦](future-backlog.md#10-索引時間優化)維持未完成；既有 P0／平台驗收狀態不因這份 benchmark 改變。

## 正確性與重現

新增測試覆蓋大量 fallback／canonical、大小寫與角色、空字串、跨來源／檔案、追加後隱藏狀態、重寫後解除舊隱藏、來源唯讀、FTS integrity、強制 digest 碰撞及取消交易後重試。既有 rewrite／compaction、來源 race、checkpoint／snapshot 與 generation 測試一併執行。

本機結果：`cargo fmt --check`、核心 tests **245 passed、1 ignored**、Clippy all-targets `-D warnings` 通過。Ignored 是既有 Antigravity 隔離 HOME 子程序 helper，由它的 parent test 明確呼叫，沒有把 default run 的 ignored 當 passed。未跑完整桌面或三平台手動 CI，沒有修改帳務設定。

在兩個獨立 checkout 使用相同的 [benchmark](../src-tauri/examples/index_lifecycle_benchmark.rs)，Before checkout 先複製該 harness，再分別建置。不要用一般 debug build 比較，也不要同時跑兩個 benchmark。

```bash
cargo build --release --locked --manifest-path src-tauri/Cargo.toml \
  --no-default-features --example index_lifecycle_benchmark

# TMPDIR 請選擇至少 8 GiB 可用空間的磁碟目錄；不要使用小型 tmpfs。
mkdir -p artifacts/index-benchmark/tmp
export TMPDIR="$PWD/artifacts/index-benchmark/tmp"
BIN=src-tauri/target/release/examples/index_lifecycle_benchmark
"$BIN" 1000 100 20 > result-1000.json
"$BIN" 10000 200 40 > result-10000.json
"$BIN" 1 20000 2000 duplicates > result-large.json
```

本次使用獨立 `CARGO_TARGET_DIR`，並保存 before／after release executable 後才修改程式。可用 `sourceSha256`、`sourceBytes` 與語意斷言核對相同輸入；報告中的小數是觀測值，非保證效能。

## 後續搜尋量測

上述 2026-10-16 搜尋結果與未達標紀錄保持不變。獨立的 [2026-10-17 搜尋第二階段](search-performance.md) 針對 COUNT／分頁候選驗證做 profiling 與改善，搜尋與索引時間分開，不能用後續較快樣本覆蓋本報告的波動與限制。
