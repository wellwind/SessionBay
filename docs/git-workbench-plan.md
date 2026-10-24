# Git 工作台功能規劃

更新：2026-10-24。狀態：**G1–G8 功能已實作，本機自動測試通過；尚未 review、CI 與三平台原生驗收**。八個工作包已拆成堆疊分支（見[實作狀態](#實作狀態2026-10-24)），尚未開 PR，並非現有 PR 編號。

## 產品目標與已確認範圍

在 Session Bay 內完成日常 Git 工作與 GitHub／自架 GitLab 的 PR／MR 流程。以專案為入口，使用專案右側 Activity Bar 的 Git 工具、共用可調寬面板及中央檢視分頁；正常／Zen Mode 皆可使用。參考 VS Code 的變更與暫存流程、GitLens 的 blame／歷史脈絡、GitKraken 的分支圖可讀性；這些是體驗方向，不承諾完整複製外部產品。

- 只有有效 Git 工作目錄才顯示可操作 Git 功能；不因看見名為 .git 的資料夾就假定有效。
- 一個 Session Bay 專案可管理多個 repository，每項操作清楚顯示目前 repo、branch、remote 與目標。
- 文字 diff 支援不同比較來源、並排／行內檢視，以及同一檔案部分區塊與部分行暫存。
- 歷史 graph 與 blame 納入第一階段，不延後成純進階功能。
- 常用 stage／unstage、commit、fetch／pull／push、branch、stash、reset、revert、merge 與 tag。
- 衝突在 Session Bay 內以三方檢視及可儲存結果解決；不能只提供外部工具連結。
- GitHub 與自架 GitLab：建立、檢視、留言、review／核准與合併 PR／MR，依平台實際能力顯示。
- CI 第一版提供狀態與原平台連結；完整 logs、retry、cancel 留待後續。
- 不做圖片、PDF 或其他非文字內容 diff。仍需顯示非文字檔案變更與衝突，並可安全處理整檔版本、刪除及重新命名。
- 正確認識既有 worktree 是基礎要求；新增、移除、整理 worktree 的管理介面是後續階段。
- 一般 push 不自動推送所有 tag；tag 推送要明確選取。

## 專案、repo 與操作脈絡

Git 探測需辨識一般 .git 目錄、指向實際 gitdir 的 .git 檔案、linked worktree，以及從 repo 子目錄開啟的專案。使用 Git 回報的 worktree root、gitdir、common dir 建立身分；canonical path 與平台路徑規則須一致。裸 repo、損壞 gitdir、沒有 Git 執行檔與非 repo 各有明確狀態，不提供會失敗或操作錯誤範圍的按鈕。

多 repo 使用明確選擇器及個別狀態摘要，不能將不同 repo 的 staged 檔案混入同一次 commit。探索採有界、可取消方式；巢狀 repo／submodule 需辨識邊界，不把內部 .git 當一般檔案遞迴掃描，也不偷偷操作 submodule。支援的 submodule 操作另行定義；無支援時清楚顯示。

切換 repo 不切換既有 Agent cwd、不重啟 Terminal。中央 diff／graph／PR 分頁以 repo 身分及比較來源識別，避免相同檔名、branch 或 PR 編號互撞。工具面板共用尺寸與鍵盤規則，tooltip 說明用途和實際快捷鍵。

## Diff 與部分暫存契約

### 比較來源

- 工作目錄對 index（未暫存）。
- index 對 HEAD（已暫存）。
- 工作目錄對 HEAD（整體未提交差異）。
- 單一 commit 對指定 parent；merge commit 明確選 parent。
- 任選 commit／branch／tag 比較；直接兩端與 merge-base 比較明確區別。
- PR／MR 使用 provider 的 base／head／diff version，不拿本機 HEAD 代替。
- 檔案歷史與 blame 可跳至對應 commit／檔案 diff。

### 顯示與互動

並排、行內切換；字詞變更提示、上下個變更、搜尋及忽略空白檢視選項。語法高亮沿用可共用的文字檢視引擎；Monaco 是候選，不是本次已選定依賴。大檔／超長行／大量變更需有界載入及可取消，超限明確告知，不靜默截斷後仍允許不完整 patch 寫入。

暫存最小單位包含完整檔案、hunk 與使用者選取的變更行；同一 hunk 內兩組修改必須能分開加入不同 commit。Unstage 同樣支援部分範圍；不以整檔 stage 假冒部分暫存。純顯示設定（如忽略空白）不能改變實際 patch 位元組。

先驗證選取來源版本與 index／工作檔快照，再套用精確 patch。遇外部編輯、Agent 寫入或 index 改變，拒絕過期操作並重新載入供重新選取，不以模糊位置套用到別段。新增／刪除行、檔案末尾無換行、CRLF／LF、Unicode、rename 與檔案模式變更需有測試。二進位／不支援編碼不提供部分行操作。

## 提交、遠端與 tag

- Commit 預覽列出 index 中將提交的實際內容、repo、branch 與訊息；不自動加入未選取變更。
- Fetch、pull、push 分開，pull 明確顯示 merge／rebase 策略；初次 upstream 設定及分支推送目的地須可確認。
- 支援 detached HEAD、unborn branch、behind／ahead／diverged、protected branch、拒絕推送、認證失敗與離線狀態。
- 保留原 Git hooks、簽章與 SSH／credential helper 行為；不默默略過 hook 或關閉驗證。互動認證失敗須在應用內清楚回饋。
- Tag 清單、查看指向與訊息、建立 lightweight／annotated tag、選取推送及明確刪除。簽章 tag 的能力依環境顯示，不宣稱未驗證支援。
- 本機 tag 與遠端 tag 分開操作。刪除或移動已發布 tag 須額外確認影響；不得讓一般 push 變成 push --tags。
- 操作完成以實際 Git 結果與刷新後狀態確認；失敗不顯示成功，不無條件自動重送可能已生效的網路寫入。

## Graph、blame 與分支

第一階段提供可捲動歷史 graph、branch／tag 標記、commit 詳情、作者與時間、搜尋／篩選，以及檔案 blame 導覽；資料分批載入。第一版不必具備拖拉重寫歷史，不能以純 commit 文字清單宣稱 graph 完成。

分支建立、切換、比較與刪除都顯示 repo 脈絡。工作目錄有未提交變更、branch 被其他 worktree 使用、合併尚未結束等情境不得強行切換。後續 rebase／cherry-pick 等擴充須沿用相同操作與衝突模型，不因使用者要求常用 Git 操作而默默增加自動歷史重寫。

## 安全復原與 Agent 併發

危險操作先顯示影響範圍，再確認；一般操作維持低摩擦。Reset 區分 soft／mixed／hard，revert 說明建立反向 commit，不把兩者混成「復原」。Discard、hard reset、branch／tag 刪除、stash drop／clear、force push 等不可藏在普通確認文案。

復原點必須精確說明能保存哪些狀態：HEAD／refs、index、工作檔及 untracked 是否涵蓋，容量／保留期限與排除項目。只記錄舊 commit SHA 不等於能還原未提交內容。備份或安全前置檢查失敗時停止破壞操作；無法保證還原的動作明確揭露，不承諾全能 Undo。復原也不得無提示覆蓋之後新增的修改。

Session Bay 自身的寫入使用 repo／common-dir 適當範圍序列化；Git index.lock 等外部鎖尊重原 Git 行為，不自動刪鎖。Agent 活動提示只作輔助，idle 不代表檔案不會再變：寫入前仍須重新驗證 HEAD、index、相關檔案與操作狀態。UI 不能宣稱能鎖住外部 Agent／編輯器；偵測競態時停止並刷新。不可為了 Git 操作自動終止 Agent。

執行檔、argv、cwd 分離，路徑及 refs 不拼接 shell 字串；保護特殊檔名、以 - 開頭的參數、symlink 路徑、Windows 路徑與非 UTF-8 檔名。日誌不得包含 token、認證 remote URL 或敏感 diff 全文。

## 內建衝突解決

以 base、ours、theirs 與可編輯 result 呈現三方脈絡，提供採用單側／組合及手動編輯、儲存、明確標記 resolved；來源名稱以當前 merge／rebase／revert 實際語意顯示，避免一律把 ours 當「我的最新修改」。

衝突解決是獨立寫檔能力，不是現有唯讀 Files 預覽已可編輯的宣稱。寫入前核對檔案與 index conflict stages，採安全寫入並保留錯誤恢復；外部同時修改不可被覆蓋。尚未儲存或仍有未解決衝突時不能假稱完成或自動 merge。

新增／新增、修改／刪除、重新命名／刪除及非文字衝突需提供整檔版本選擇、保留／刪除／重新命名等明確結果與確認。非文字檔不顯示虛假文字 diff。衝突後可 continue／abort，並清楚說明 abort 對當前修改的影響。

## GitHub 與自架 GitLab

採 provider adapter 加上「主機 + 帳號」身分模型；自架 GitLab 支援使用者設定 instance URL，不能硬編碼 gitlab.com。Repo remote 與 API host 的映射要可檢查／修正，支援 SSH 別名、port、子群組與多 remote，不能只靠 hostname 猜帳號。相同主機多帳號、不同主機同名 repo 的憑證與快取必須隔離。

在 Session Bay 內提供連線狀態、帳號選擇、PR／MR 清單／詳情、建立、文字 diff、逐行討論、review／核准及合併；平台能力、版本與權限差異需可辨識，不做假的一致按鈕。PR／MR review 與 merge 綁定當時的 head SHA／diff version；遠端內容更新時重新確認，避免核准或合併未看過的新內容。

認證方案依平台支援選擇，使用作業系統憑證儲存或受支援既有憑證流程，不能將 secret 存入一般明文設定、log 或 URL。登入可能需系統瀏覽器完成 SSO／OAuth 後返回；核心 Git／review 工作仍在 Session Bay。自架 host 的網路／VPN、企業 CA／proxy、SSO 與 GitLab 版本是待實機驗證條件；不預設停用 TLS 驗證，也不為連線自動改系統安全設定。

第一版 CI 顯示 pending／running／success／failure／cancelled／unknown、來源時間與原平台連結；非即時資料須標示。完整 CI log、retry、cancel 暫不包含。

## 八個實作 PR 與依賴

以下勾選框代表完整交付（含 review、CI、原生驗收），目前仍未勾選；功能實作狀態見[實作狀態](#實作狀態2026-10-24)。文件 PR 不算其中一個實作 PR。每個工作包均需獨立 review、exact-commit CI、相應三平台驗收證據與可追溯 checklist。

### 第一階段：本機日常流程

- [ ] G1 Git 基礎與多 repo
  - 有效探測、身分／能力契約、repo selector、狀態刷新、Activity Bar contribution。
  - 驗收：無 repo 不出現可操作 Git 工具；.git file、子目錄、linked worktree、兩個同名 repo 正確隔離；掃描可取消，外部修改會刷新。
- [ ] G2 Diff 與部分暫存（依賴 G1）
  - 文字比較來源、並排／行內、部分 hunk／行 stage 與 unstage。
  - 驗收：同檔同 hunk 的兩項修改只暫存所選一項；反向取消後其他 staged 內容不變；過期快照拒絕寫入；非文字只顯示變更資訊。
- [ ] G3 Commit 與遠端操作（依賴 G1、G2）
  - Commit、fetch、pull、push、upstream 與錯誤／認證回饋。
  - 驗收：commit 只含 index 所選內容；兩 repo 不混寫；推送不自動帶全部 tag；拒絕／離線不假成功；原 hooks／簽章失敗可理解。
- [ ] G4 歷史圖與 blame（依賴 G1，可與 G2／G3 平行）
  - Graph、branch／tag 標記、commit／檔案歷史與 blame 導覽。
  - 驗收：分叉／合併歷史線正確；任選比較與 parent 語意正確；長歷史分批載入、不阻塞 Agent Terminal。

### 第二階段：分支、復原與衝突

- [ ] G5 分支與復原（依賴 G1、G2、G3）
  - Branch、stash、reset、revert、tag 與危險操作確認／復原點。
  - 驗收：dirty tree、不完整備份、untracked、stash conflict、detached HEAD、其他 worktree 佔用分支皆有安全行為；確認取消零變更；tag 遠端刪除與普通 push 分離。
- [ ] G6 合併與衝突（依賴 G2、G5）
  - Merge、內建三方 result 編輯／儲存、標記 resolved、continue／abort、非文字與重新命名／新增刪除衝突處置。
  - 驗收：文字與非文字衝突均可在應用內完成選擇；不能把未儲存 result 當 resolved；Agent 同時改檔時停止覆寫；abort 及操作失敗可恢復並正確呈現 Git 狀態。

### 第三階段：遠端協作

- [ ] G7 主機與帳號連線（依賴 G1；不需等待所有本機 UI）
  - GitHub／自架 GitLab adapters、多主機／多帳號、remote 映射與安全認證。
  - 驗收：不同 host／account／repo 不串憑證或快取；token 不出現在一般設定與 log；無權限、失效登入、私有網路／CA 問題可診斷；列明實測 GitLab 版本。
- [ ] G8 PR／MR（依賴 G2、G3、G7；本機衝突流程銜接 G6）
  - 建立、diff、逐行留言、review／核准、CI 狀態與合併。
  - 驗收：私有 GitHub 與自架 GitLab 真實測試 repo 完整走一輪；不同權限遵守平台限制；遠端 head 更新使舊 review／merge 預覽失效；CI 狀態未知不假稱通過；可從主機連線返回原工作區。

## 共通完成條件與人工驗收

- [ ] 三平台測試矩陣：Windows（路徑／CRLF／credential helper）、macOS（原生鍵盤／IME／安全儲存）、Linux（WebView／credential helper）。
- [x] 只用合成 repo 與經允許的測試 remote；不拿使用者工作目錄測 reset／force push／刪 tag。（自動測試全部使用 tempdir 合成 repo、本機 bare remote 與 loopback mock）
- [ ] 自動測試比對操作前後 HEAD、index、工作檔 bytes、refs；失敗／取消／重複點擊與外部修改均覆蓋。（已有：過期快照、外部修改、確認過期、備份失敗與並發重複暫存的前後比對；尚缺網路操作中途取消的自動測試）
- [ ] Terminal／Agent 身分與持續執行不因開 Git panel、diff、graph 或切 repo 而重啟。（jsdom 測試涵蓋開關 Git 面板不重掛 Terminal；原生未驗）
- [ ] Keyboard、focus、tooltip、一般／Zen、狹窄視窗、共用 panel resize、長路徑及長分支名稱通過。
- [ ] 大量 repo／檔案／commit／diff 的時間與記憶體量測附版本及硬體；尚未量測不宣稱效能無虞。（已有後端時間量測，缺記憶體與前端量測）
- [x] 說明功能已實作、CI 通過、原生驗收通過三種不同狀態；只有證據足夠才勾選。（見實作狀態表）

## 實作狀態（2026-10-24）

「功能已實作」「CI 通過」「原生驗收通過」是三種不同狀態；下表只有第一欄成立。工程決策見 [決策紀錄](decisions.md)。

| 工作包 | 分支（依序堆疊） | 功能已實作 | 本機自動測試 | CI | 原生驗收 |
| --- | --- | --- | --- | --- | --- |
| G1 | `feat/git-g1-foundation` | 是 | Rust `git_foundation`、Vitest | 未執行 | 未執行 |
| G2 | `feat/git-g2-diff-staging` | 是 | `git_staging`、`git-diff.test.tsx` | 未執行 | 未執行 |
| G3 | `feat/git-g3-commit-remote` | 是 | `git_remote`、`git-remote.test.tsx` | 未執行 | 未執行 |
| G4 | `feat/git-g4-history` | 是 | `git_history`、`git-history.test.tsx` | 未執行 | 未執行 |
| G5 | `feat/git-g5-branches-recovery` | 是 | `git_safety`、`git-safety.test.tsx` | 未執行 | 未執行 |
| G6 | `feat/git-g6-merge-conflicts` | 是 | `git_conflicts`、`git-conflicts.test.tsx` | 未執行 | 未執行 |
| G7 | `feat/git-g7-hosts` | 是 | `git_hosts`（loopback mock）、`git-hosts.test.tsx` | 未執行 | 未執行 |
| G8 | `feat/git-g8-pull-requests` | 是 | `git_pulls`（loopback mock）、`git-pulls.test.tsx` | 未執行 | 未執行 |

測試環境：macOS 26.4.1、Apple M1 Max、Git 2.55.0、Rust 1.99.0；只用合成 repo、本機 bare remote 與 loopback HTTP mock，不碰使用者 repo 或真實帳號。

已知缺口（不得勾選對應驗收）：

- **G7／G8 真實主機**：未對私有 GitHub repo 與自架 GitLab 實測；mock 只驗證 Session Bay 送出的請求與錯誤對應。GitLab 只以 16.11／17.11 回應格式的 mock 測試，**尚無實測版本**。企業 CA、proxy、VPN、SSO 只有錯誤訊息路徑，未實機驗證。
- **三平台**：只在 macOS 執行 Rust／前端測試；Windows（路徑、CRLF、credential manager）與 Linux（WebView、libsecret）未執行。
- **UI 原生驗收**：鍵盤、焦點、tooltip、Zen Mode、狹窄視窗與長名稱只有 jsdom 層級測試，未在桌面 WebView 實際操作或截圖。
- **效能**：下列為後端單次量測，未含前端渲染與記憶體；未在大型真實 repo 量測。

效能量測（2026-10-24，release build，`cargo test --release --no-default-features --test git_performance -- --ignored --nocapture`；合成 repo：20,000 commits、5,000 個 untracked 檔、10,000 行檔案）：

| 操作 | 時間 |
| --- | --- |
| 探索 repository | 161 ms |
| status（5,000 untracked） | 44 ms |
| log 第一頁（200 筆）／offset 10,000 | 62 ms／44 ms |
| diff 10,000 行檔案 | 32 ms |
| blame 10,000 行檔案 | 29 ms |
| 檔案歷史（100 筆） | 45 ms |
| refs 清單 | 59 ms |

## 後續與尚待技術確認

Worktree 管理、完整 CI log／retry／cancel、進階 rebase／cherry-pick 操作介面與更多 hosting providers 後續另拆。非文字內容 diff 明確不在範圍內。

最低 Git 版本、文字／三方編輯引擎、資料量限制與復原點策略已於 2026-10-24 決定（見[決策紀錄](decisions.md)）。最低可支援的 GitLab 版本仍待真實 instance 驗證；不得把未測試的平台能力寫成已驗證。
