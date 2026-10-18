# Terminal 檔案路徑連結

首版已實作，待獨立 review 與 Linux CI。使用者於 2026-10-18 將本項調整為優先交付；broker 後續與 Snap 保留暫停。沿用中央唯讀檔案 tab，不新增編輯或執行能力。

## 已實作互動

- macOS Cmd-click、其他平台 Ctrl-click 開啟；普通點選／拖曳保持選取。工具列「開啟終端檔案路徑」可鍵盤操作並帶入選取文字。
- 專案內明確絕對路徑可直接開啟；邊界不明的未加引號路徑先確認。相對路徑與裸檔名一律顯示候選，即使只有一筆也須選擇。
- 來源 pane／runtime／project 由後端 broker List 驗證。啟動 cwd 只標示候選提示，不能代表互動 shell 目前 cwd；未知或 root 外 cwd 不作解析授權。
- 支援引號、空白、Unicode、括號、常見診斷標點及 `file:line:column`。已開啟的檔案重用 tab；完整文字載入後有界定位，超出行欄範圍顯示調整提示。
- 正常／Zen 共用流程。取消、編輯輸入、導航、換專案、pane／runtime 改變及卸載會失效舊請求，晚到結果不得重開檔案或偷取焦點。

## 安全界線與首版限制

終端輸出一律不可信，解析不執行 shell、命令替換、檔案或 URL，不傳送至外部服務，也不新增長期輸出保存。既有 workspace root、descriptor-based inspect／chunk、symlink／hardlink／reparse、檔案身分與版本檢查繼續生效。解析後檔案版本改變會拒絕原讀取，須明確重新讀取；不寫入或建立檔案。

只支援有專案授權範圍的 Terminal。root 外、上層 `..`、home 展開、UNC／device、URL scheme、控制字元與命令字元拒絕。Windows drive 僅由原生 Windows 路徑語意處理；字串測試不代表 Windows 原生驗收。相對／裸檔名搜尋限單一專案，沿用既有最多 50 結果、20,000 entries、32 層與合作式時間預算；結果會重新 inspect，不掃描整台主機。

自動連結限不超過 320 cells 的完整未折行實體行，保守跳過底線／隱藏屬性區段，避免部分 OSC8 目標偽裝路徑；彩色文字仍支援。折行、底線文字或不確定格式可選取／手動輸入。OSC8 由內建高優先 provider 接管，僅顯示經控制字元清理且有界的真實目標，不開啟任何 scheme。一般 HTTP URL 不視為檔案。

大型檔保留既有確認／分段限制；分段閱讀不支援全檔行欄定位，圖片不套用行欄。找不到、目錄、非支援格式、權限錯誤與版本變更以可理解訊息處理。

## 驗證紀錄

- Mac：Rust core 596、desktop 600 通過，各 3 項 ignored；兩組 Clippy `-D warnings` 通過。
- Mac：前端全套、39 項 embedded hook contract、typecheck、lint、production build；Chrome 合成資料驗證正常深色／Zen 淺色、行欄、候選、重用、選取、鍵盤、OSC8 偽裝、導航失效與窄視窗。
- 額外 Mac 回歸：布局 4 項通過；既有 Files／focus-mode 測試的 Ctrl+F／Ctrl+P 快捷鍵情境失敗，在未修改 main 的同機對照亦重現。保留失敗紀錄，不將整組列為通過；Linux CI 另驗平台快捷鍵。
- Linux：由本 PR exact-head CI 驗證，結果見 PR。macOS 原生 WebView 與 Windows 原生互動尚未驗證；不以 Chrome 或字串測試替代。
- 所有本機後端測試使用隔離資料與假 Shell，未讀取真實對話或執行付費模型。

截圖：[正常模式](validation/terminal-file-links-normal.png)、[候選選擇](validation/terminal-file-links-candidates.png)、[Zen 模式](validation/terminal-file-links-zen.png)。

相關基礎：[分級文字閱讀](large-file-reading.md)、[圖片閱讀](file-image-preview.md)。
