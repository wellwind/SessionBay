# 搜尋效能第二階段：獨立量測

量測日期：2026-10-17。基底 `990ece9`；搜尋 diagnostics baseline 為 `188eaa2`，只加量測入口與 harness，沒有改搜尋策略。本次不重新宣稱索引或平台驗收完成，也不讀取真實使用者歷史。

## 方法與範圍

- 獨立 `search_benchmark prepare` 產生 10,000 個合成 Codex Session，各 40 則訊息，來源共 2,108,968,980 bytes。來源 SHA-256 為 `2b04e03f76005caa9016b33697d6b025704f9aa796339c3430bdbe6c5d2ccd09`；標題不含正文查詢詞。資料與 catalog 放在 checkout 的 ignored `artifacts/`，沒有使用 `/tmp` tmpfs，也不隨 PR 發布。
- `prepare` 的來源生成、唯讀完整性驗證與索引時間獨立紀錄；`run` 只查同一個既有 catalog。Before／After 使用同一 catalog，因此資料與 SQLite 頁面配置相同，沒有把重新索引的差異算成搜尋加速。
- Rust 1.99.0、release、Cargo.lock、bundled SQLite；Debian 13.6 x86_64、Linux 6.18.44、overlay filesystem。共享雲端機器無 CPU／I/O 獨占；同一工作的編譯與量測不重疊，其他工作仍可能造成干擾。
- 每 case 先跑一次 `firstQueryMs`，再跑 20 次 warm sample，保留每次總時間、phase 與記憶體。p50／p95 為排序後第 10／19 個值。所有次數皆驗證完整結果與順序相同，Before／After 另比對結果 SHA-256。
- 每次產品查詢都開新 SQLite connection；「warm」指同 case 已先查一次、OS page cache 不受控，**不是重用 connection／prepared statements**。`firstQueryMs` 也不等於冷磁碟。沒有清除 OS cache、假造 cold 數字或把 first-query 混入 warm 百分位。
- `search-profile` feature 的量測入口分成 connection、query planning、COUNT、分頁／metadata decoding、snippet 查詢與處理。一般 build 的 query 使用 no-op observer，不讀時鐘、不記錄 log、不改 IPC。
- RSS 是 Linux `/proc/self/status` 的 query 結束樣本；peak 是程序累積 `getrusage` 高水位，包含這個 run 的全部 case，並非每個 case 的獨立 heap peak。沒有量測 WebView、GPU 或 Agent 子程序。

## 安全與語意

搜尋仍使用同一 transaction snapshot、原本的文字比對、ASCII-only 大小寫摺疊、literal `%`／`_`／`\` escaping、Unicode、embedded NUL fallback、title OR body、hidden messages、所有 filters、`updated_at DESC,id ASC` 排序與 limit／offset 規則。FTS 仍只用來找候選，不以候選命中代替完整字串驗證。

原來源、parser、prefix hash、來源身份、transcript snapshot／stale 驗證、resume provenance 均維持。Codex 的列表搜尋不開原 transcript；讀取內容與重新 resume 的來源驗證是另外的既有流程。Antigravity 列表的 canonical-root provenance 檢查仍執行，不能用 Codex 合成結果推論它的所有 I/O 成本。

## 重現

```bash
cargo build --release --locked --manifest-path src-tauri/Cargo.toml \
  --no-default-features --features search-profile --example search_benchmark
mkdir -p artifacts/search-benchmark
# 請先確認至少 6 GiB 可用空間；prepare 拒絕覆寫既有目錄。
BIN=src-tauri/target/release/examples/search_benchmark
"$BIN" prepare "$PWD/artifacts/search-benchmark/dataset" 10000 > prepare.json
"$BIN" run "$PWD/artifacts/search-benchmark/dataset" 20 > result.json
```

保留 Before／After executable；在同一個 dataset 上依序 B1／A1／B2／A2，不同時跑量測或本工作的編譯。測試查詢含高命中識別字及大寫、2／4 字中文、低命中識別字、不存在詞、escaping、深分頁、200 筆頁面及 provider／project filters。這是 workload 的觀測結果，不是所有資料量、provider 或平台的速度保證。

## Profiling 證據與限制

原始 high-hit identifier 的 warm median：COUNT 1,422 ms、分頁 SQL／metadata 1,395 ms、snippet 2.15 ms、connection 0.35 ms；完整 p50／p95 為 2,856／4,271 ms。瓶頸不是 snippet。四字中文同樣走 broad FTS，COUNT／page 各約 924／915 ms；兩字中文的既有 EXISTS 路徑完整 p50 約 48 ms。

[Count-query plan 診斷](validation/search-20261017-query-plans.json) 使用同一 bundled SQLite，比較相同 COUNT 語意與實際 query plan。原策略每次 COUNT 的 read syscall bytes（`rchar` 差）約 2.215 GB；session-first candidate-aware EXISTS 約 118 MB。這是程序讀取計數，不是 physical disk bytes，也不是逐檔 trace；`read_bytes` 另列原始 JSON。測試容器拒絕 `strace` 的 `PTRACE_SETOPTIONS`，因此沒有宣稱完成 syscall path tracing 或 CPU flamegraph。來源唯讀由合成檔案完整性斷言與既有來源／stale 回歸驗證；Codex 不開原 transcript 的結論另以 query→session_row→snippet 程式路徑核對。

## 策略與取捨

對至少 1,025 個 FTS rowid 候選，改用 session-first candidate-aware EXISTS，在該 Session 第一筆完整命中後停止；訊息的 FTS membership、hidden 與原 literal predicate 都仍檢查。COUNT 和 page 仍各自執行完整查詢，沒有因省略總數、縮小範圍、改變排序或少做 provenance 而加速。CROSS JOIN 與既有 messages_file index 保持 file-first traversal。

少於 1,025 筆候選維持原 candidate-first 路徑；probe 在第 1,025 筆匹配 rowid 停止，不讀 message body。此門檻只是效能 heuristic，不是內容抽樣或結果上限，且底層 postings intersection 的工作量不受 1,025 限制。密集候選但完整字串不命中的工作量仍可能很慢，不承諾所有輸入低於一秒。

密集路徑的 rowid set 比原 Session ID set 大，因此可能增加暫存及 RSS；第一組程序 peak 由 8,896 KiB 增至 12,340 KiB，不主張節省記憶體。完全被 provider／project filter 排除的搜尋也需 probe，第一組 p95 約 0.8／0.7 ms → 1.9／1.9 ms，這是已觀測到的固定成本回歸，不能隱藏。

## 正確性覆蓋

新增 differential test 對 240 個多訊息 Session 與另一 provider，以不依賴 FTS 策略的 literal SQL 作 oracle，核對 total、完整排序和分頁；包含高／低／零命中、ASCII 大小寫、2／4 字中文、重音大小寫、百分比／底線／反斜線／引號、NUL 後文字、title-only、FTS 三字窗存在但完整字串不存在、hidden、child、archive、日期、provider／project filters、空白查詢、超大 offset 與 limit clamp。1,024→1,025 候選邊界另測完全相同結果。合成來源逐檔比對唯讀，改寫後搜尋保留既有 cached 語意，transcript 仍拒絕 stale 來源。

## 完整量測結果

同一 catalog 的執行順序為 B1 → A1 → B2 → A2；B1 較吵雜，沒有丟棄或以 B2 取代。表內每格為 p50／p95，單位 ms，warm 樣本各 20 次。

| Case | B1 | A1 | B2 | A2 |
| --- | ---: | ---: | ---: | ---: |
| identifier | 2856.47／4271.36 | 651.75／701.62 | 2408.72／2563.44 | 677.71／733.68 |
| 大寫 identifier | 2606.57／3096.98 | 659.83／697.68 | 2484.18／2635.69 | 651.52／668.28 |
| 中文（2 字） | 48.06／56.37 | 46.92／50.24 | 45.90／47.31 | 48.15／53.88 |
| 中文測試（4 字） | 1801.75／2273.48 | 174.28／190.76 | 1659.69／2069.19 | 178.32／188.49 |
| 低命中 unique_needle_0. | 17.75／21.00 | 11.70／13.27 | 10.92／11.70 | 10.91／13.34 |
| 不存在詞 | 11.60／17.23 | 10.25／11.06 | 10.20／11.10 | 10.01／10.61 |
| literal escaping（零命中） | 16.46／17.67 | 9.66／11.18 | 10.24／11.84 | 9.64／10.02 |
| identifier offset=9950 | 2542.50／2977.24 | 743.73／787.82 | 2429.79／2580.18 | 774.09／915.96 |
| identifier Codex、limit=200 | 3245.82／4118.48 | 721.47／768.97 | 2488.93／3028.86 | 739.35／836.46 |
| identifier Claude（filter 排除） | 0.71／0.80 | 1.58／1.88 | 0.44／0.50 | 1.66／1.97 |
| identifier 不存在 project | 0.66／0.72 | 1.56／1.86 | 0.41／0.50 | 1.68／1.99 |

在這兩組合成觀測中，高命中 identifier p95 由 4,271／2,563 ms 降至 702／734 ms；deep page 由 2,977／2,580 ms 降至 788／916 ms。四字中文也由秒級降至約 190 ms。這些 backend cases 的 warm p95 低於 1 秒，**不代表整體效能驗收完成**：沒有量測原生 UI 是否阻塞、真正冷磁碟、其他 provider 或私人來源。

不能把沒有改動策略的二字中文或 sparse query 的小差異歸因於本次改善。B2→A2 的二字中文 p95 47.31→53.88 ms、低命中 p95 11.70→13.34 ms，都變慢；probe 有固定成本，共享機器仍有波動。所有 case 四個 run 的完整結果 SHA-256、總數、回傳頁長度與順序相同；全部查詢後合成來源 SHA-256／bytes 亦完全相同。

### 記憶體

| Run | 最後 RSS（KiB） | 全 run peak（KiB） |
| --- | ---: | ---: |
| before | 8492 | 8896 |
| after | 10520 | 12340 |
| before-repeat | 8540 | 9600 |
| after-repeat | 9912 | 12544 |

不要把最後 RSS 與程序累積 peak 相減解讀為 heap allocation。新增 rowid 暫存集合有記憶體取捨；本次沒有承諾降低 RSS。

### 原始資料與環境

- [B1 全部 raw samples](validation/search-20261017-before-10000.json)／[A1](validation/search-20261017-after-10000.json)
- [B2 全部 raw samples](validation/search-20261017-before-repeat-10000.json)／[A2](validation/search-20261017-after-repeat-10000.json)
- [結果 hash、來源完整性及 phase 中位數比較](validation/search-20261017-comparison.json)
- [主機／編譯資訊](validation/search-20261017-host.json)、[B1 load snapshots](validation/search-20261017-baseline-load.txt)、[A1／B2／A2 每 5 秒 load／available memory](validation/search-20261017-interleaved-environment.json)

B1 的 load 記錄從查詢開始後才採樣，觀測 1-minute load 約 2.34–8.26；後三輪保留逐次系統快照。CPU load 不是查詢 CPU usage，也不能證明沒有背景干擾。任何加速比例都只描述這些已保存樣本。

## 驗證狀態與剩餘限制

- `cargo fmt --check`、`git diff --check` 通過。
- `cargo clippy --locked --offline --no-default-features --features search-profile --all-targets -- -D warnings` 通過。
- 核心／integration 測試共 **299 passed**。catalog 44 項全部通過，包含本次 dense differential 與 probe 邊界測試；Antigravity、OpenCode、Grok、來源設定、重寫、snapshot、provenance、PTY 等可執行測試通過。
- **完整 suite 沒有通過**：Unix socket／broker 在此 sandbox 回報 `Operation not permitted`。第一次 lib run 的 owner-only listener 測試被阻擋；後續明確排除此一測試以跑其餘 target。persistence target 另有 6 項因相同 broker 連線權限失敗，temporary_terminal 另 1 項失敗，合計 8 項仍需在允許本機 socket 的環境重跑。2 個 subprocess-only helper 在一般 run 顯示 ignored，沒有當作 passed；parent 測試會明確呼叫它們。
- 完整桌面 build、原生 WebView、macOS／Windows、真正冷磁碟與私人來源沒有驗證。核心查詢使用的持久 schema 仍為 3；與其他功能分支整合後須重新驗證 Trash 排除與 paused provider 保留的既有語意。

測試與 build 不與 A1／B2／A2 量測並行；環境限制不會被隱藏成綠色測試。此 PR 不修改 broker、權限設定、來源 parser 或 provenance 規則。
