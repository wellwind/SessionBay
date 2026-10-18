# 發行、更新與後續優先順序

更新：2026-10-18。狀態：**已確認規劃，以下新交付項目尚未完成**。本文件補足既有 REL 任務的發行與更新決策；不代表已有可下載版本、已上架套件或可用 updater。

## 發行對象與節奏

先供開發者本人與朋友試用，公開 GitHub Releases 為主要下載管道；同時規劃 Homebrew 與 Snap。公開下載不等同已選定開源授權或完成品牌／依賴授權審查，相關發行前事項仍需確認。

採人工挑選已驗證 commit、累積變更後發版；每次 main 合併不自動發布。保留 preview／stable 軌道，預設不讓 stable 使用者收到 preview；實際版本命名、套件 track 與對映在實作時明定。不同管道與架構可不同步，但各自顯示真實可用版本、來源 commit、已知限制與發布時間，不承諾同日全平台到齊。

目前開發／PR 合併門檻以 Linux 的相關測試、review 與功能證據為準；未驗 macOS／Windows 不假稱通過，也不再作所有功能 PR 的預設阻礙。**發行特定 OS／CPU 的產物仍須完成該目標安裝、啟動、升級與資料相容驗證**。Linux CI 通過不代表 ARM64、macOS 或 Windows 套件可發布。

## 安裝來源與更新責任

| 安裝來源 | 更新行為與責任 |
| --- | --- |
| GitHub Releases 直接下載 | 通知對應平台／架構／軌道的版本與變更；使用者按下載更新，每次安裝均明確同意。取消／稍後不安裝，不靜默取代程式或重啟工作。 |
| Homebrew | 告知該套件管道可用版本並交由套件管理器更新；應用內 updater 不覆蓋 Homebrew 管理的路徑。 |
| Snap | 告知該 Snap channel 的版本並交由 snapd；須揭露預設自動更新與 hold 狀態，不能承諾應用確認對話能攔截 snapd。 |
| 未知／開發建置 | 明確顯示來源未知或開發版，不猜測來源後原位覆蓋；提供受信任發行頁與人工安裝指引。 |

安裝來源必須可追溯且可診斷，不能只靠版本字串猜測。通知以該管道實際存在的版本為準；GitHub 新版尚未進入 Homebrew／Snap 時不顯示假可更新。檢查失敗、離線、簽章錯誤和暫無更新是不同狀態。

### Snap 的手動更新選擇

依 [Snap 官方更新說明](https://snapcraft.io/docs/how-to-guides/manage-snaps/manage-updates/)（2026-10-18 查閱），Store 安裝預設自動更新；snapd 2.58+ 可針對單一套件設定無期限 hold，再明確 targeted refresh。下列只是未來指南範本，套件名稱尚未核定，**本文件不執行設定**：

```bash
sudo snap refresh --hold=forever <實際套件名稱>
snap list <實際套件名稱>
sudo snap refresh <實際套件名稱>
```

指南須要求使用者確認單套件 hold 已生效，避免省略套件名稱而影響全系統。Targeted refresh 不受該 hold 阻擋；手動更新後仍檢查 hold 狀態。未設定 hold、版本不支援或偵測不到狀態時，產品明示「無法保證每次安裝前詢問」。保留 hold 也代表使用者需要主動安裝安全更新；Session Bay 不偷偷改系統 refresh 政策。直接本機安裝的測試 snap 與 Store 更新行為分開驗證。

## 平台與套件交付順序

- macOS 先 Apple Silicon。使用者目前沒有 Apple Developer 會員且暫不購買；初期是清楚標示未公證限制的測試包，不提供關閉 Gatekeeper／SIP 等系統安全防護的做法，也不假稱正式信任鏈已完成。
- Apple 平台簽章／公證與 updater 產物簽章是不同機制；未購買會員不能成為略過 updater 簽章驗證的理由。實作前定義金鑰保管、輪替與失敗行為；本規劃不生成或配置任何金鑰。
- Linux x64 與 ARM64 分別建置、安裝與驗證後發布；不可由交叉編譯成功推定原生桌面、PTY 與 CLI 整合通過。
- Snap 先產出可安裝測試包，完整 Release／Update 在後續交付。Confinement、宿主 Shell／Agent 執行、歷史路徑、背景 broker、圖示／desktop entry 與資料保存均是驗收重點；尚未選定或取得 Store 的 confinement 核准。
- Homebrew 的 tap／cask 分工與下載產物識別需確認，不假設已進入官方 cask。套件更新不得更改既有 Agent 登入或個人設定。
- Windows 安裝驗收另行追蹤，PR #46 不列入目前允許完成的 Linux 發行工作；未通過的 Windows 安裝不可寫成支援成果。

## 更新期間保護工作與資料

1. 更新前辨識已開 UI、broker 與 Agent 工作，列明將影響的範圍；Session Bay 不自動終止背景工作。可延後更新或讓使用者先自行結束需要停止的工作。
2. UI／broker 協定與版本相容性須有明確握手；不能偷偷重啟舊 broker 來解決不相容。若無法安全切換，阻擋安裝流程並提供可理解的下一步。
3. 更新前建立設定與資料庫的一致性備份，包含 migration 版本與來源 app 版本；活躍 SQLite 使用受支援一致性備份流程，不複製單一 DB 檔案而忽略 WAL。
4. 備份失敗、空間不足、簽章／checksum 失敗或 migration 不可安全執行時停止更新。保留原可用版本與可診斷失敗狀態，不標記成功。
5. 降版只在 schema／設定／broker 相容性已驗證時允許；不能以替換 binary 假裝完成資料復原。必要時從備份復原，先告知會失去哪些更新後資料，並取得確認。
6. 套件管理器更新需另驗其 process／資料生命周期；應用不能保證攔截外部管理器。因此 Snap hold 與管理器操作前提示是流程的一部分，不能靠 UI modal 取代。
7. 備份保留／清理、敏感資料權限與版本紀錄須可理解，不上傳對話或將秘密寫入發行 log。

## 可執行的工作包與驗收

- [ ] R1 Snap 可安裝測試包：固定 source SHA，標示測試版本與架構；在 Linux 環境實測安裝、啟動、Terminal／Agent、關窗重接及移除後資料政策；不等同已上架。
- [ ] R2 發版流程：人工觸發／選取版本與 commit，preview／stable，產物清單、checksum、變更紀錄及依賴授權；main 合併不自動發布。
- [ ] R3 直接下載更新：來源／軌道辨識、簽章驗證、下載中斷／重試／取消、每次安裝同意；確認不會自行終止執行中 Agent。
- [ ] R4 Homebrew／Snap 管道：各管道版本與通知一致；套件管理器專屬更新路徑；Snap 單套件 hold／手動 refresh／未 hold 揭露與版本限制均有測例。
- [ ] R5 備份與相容性：設定／DB 一致備份、schema migration、磁碟不足、失敗恢復、相容降版與不相容拒絕；不覆蓋使用者更新後資料。
- [ ] R6 逐目標發行驗收：Linux x64、Linux ARM64、macOS Apple Silicon 個別紀錄 OS、架構、版本、SHA、安裝／更新結果；未驗目標不列為已驗發行產物；預備建置只能標為內部候選，不能當成完成驗收。
- [ ] R7 試用指南：可信下載來源、未公證限制、安裝來源／更新方式、背景工作保護、備份復原與已知限制；不要求降低系統安全。

上述全未完成。PR／build／CI、可安裝測試包與已發布版本分開記錄。此文件授權範圍僅記錄規劃，不代表已授權建立商店帳號、支付會員、生成／配置憑證或上傳正式產物。

## 整體優先順序

以下為 2026-10-18 的最新工作順序，取代歷史章節中的排程優先文字；歷史驗收結果保持原樣。

1. 五工具真實 Agent 活動 hook：先收尾 Claude、Codex、OpenCode、Grok、Antigravity 的來源與 Runtime 綁定、啟用／撤銷及 Linux 驗證；真實登入模型回合尚未驗，不將 synthetic／CI 視為實際狀態已驗證。
2. 接著 Snap 可安裝測試包（R1），先能試用，不等待整套更新中心完工。
3. 同時收尾 Quick Open／共用可調寬 panel（#65）及大檔讀取（#66），大檔之後再做圖片預覽。這裡的圖片預覽不是已存在的 Agent 圖片輸入。
4. [Git 第一階段 G1–G4](git-workbench-plan.md#第一階段本機日常流程)：多 repo、部分暫存、commit／遠端、graph／blame；不重複定義 #58 的八個工作包。
5. 完整 Release／Update（R2–R7）。
6. 原始對話永久刪除：沿用[調查](permanent-deletion-investigation.md)與[安全分析](permanent-deletion-safety-review.md)，#55 的唯讀影響檢查不能當成刪除功能完成。
7. 遠端機器、獨立 Web 與[用量分析](usage-spec.md)：沿用[既有待辦](future-backlog.md)，另依安全／架構相依拆分。

2026-10-18 查核基線：#60 Monaco、#62 Reload Window、#63 輔助文案清理已合併；#55、#56、#61、#64、#65、#66 尚未合併。此段是時間點紀錄，後續狀態以各 PR 和驗收文件為準，不能用本段取代即時檢查。Windows #46 安裝驗收仍排除；真實 CLI／原生未驗證項目保留。
