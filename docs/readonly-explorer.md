# 唯讀 Explorer 後續設計

基於已驗證 PR17 `8fca54c` 的獨立後續功能，不修改 Windows／Unix reader 或 IPC 契約。

- 工作區的 Agent 分頁維持原位；檔案分頁只存在檔案側欄內，標示「唯讀檔案」。開啟、切換或關閉檔案不操作 Terminal。
- 側欄與目錄樹可調寬；窄側欄改為上下配置，並可收合目錄以保留文字空間。沿用既有深淺色 token。
- 單擊替換唯一的預覽分頁；雙擊或固定按鈕保留分頁。最多 20 個檔案分頁；每個檔案保留捲動位置，內容僅依現有 IPC 讀取，重新整理才重新讀取。
- 目錄逐層展開與 200 entries 分頁，保留隱藏項目開關。方向鍵／Home／End 選取、左右展開收合、Enter 開啟；右鍵或 Shift+F10 顯示複製專案相對路徑。
- 檔案類型圖示、麵包屑、行號、基本語法高亮、Ctrl/Cmd+F 的字面值搜尋與上一筆／下一筆。搜尋不執行 regex；HTML／Markdown 永遠作為文字。
- 使用既有 React／lucide，無 Monaco 或新 npm 依賴。只渲染可視文字行與少量 overscan；後端 256 KiB 上限不變，高亮過長行退回文字。

實作集中於目錄／分頁／文字檢視元件與獨立 CSS，不修改全域 styles 與其他任務的目錄側欄。App 有一個必要的最小整合點：既有 capture 階段 Cmd+W 與 native menu 關閉要求，先將可見檔案側欄內的焦點路由到檔案分頁，以免誤關 Terminal 工作分頁。驗證包含 race、鍵盤、暫存／固定分頁、捲動、搜尋與惡意文字安全性，並以合成深淺色／窄視窗截圖檢查。

不提供磁碟編輯、儲存、重新命名、刪除或執行預覽；不宣稱與 VS Code 完全相同。現有 handle-relative、root 限制、拒絕 symlink／hardlink、binary／special 與讀取上限均沿用。

## 設計研究與取捨

已實際讀取 UI/UX Pro Max SKILL.md；雲端後續停用且本機無完整套件，因此從技能標示的公開來源 `nextlevelbuilder/ui-ux-pro-max-skill` 固定 commit `56ea9cf174ed86786187daa9de0e6247cb0747e4` 讀取 quick-reference、pro-rules，執行原始 search.py。研究工具留在本任務 tooling，不安裝到使用者技能。

| 實際查詢 | 命中與決策 |
| --- | --- |
| `focus not obscured --domain ux` | Focus Not Obscured Minimum／Enhanced；搜尋列佔實際版面、選單關閉回焦、最大化還原入口保持可見。 |
| `keyboard navigation tree tabs --domain ux` | Keyboard Navigation；目錄採 roving focus，檔案 tabs 支援方向鍵與 Home／End，所有圖示按鈕有文字名稱。 |
| `dragging movements --domain ux` | Dragging Movements；調寬提供鍵盤與寬度選單，分頁排序提供移前／移後按鈕，不只支援拖曳。 |
| `virtualized list state focus --stack react`，再縮小為 `list virtualization --stack react` | 沒有精確虛擬化指引；僅 stable keys／focus 結果可用。依 quick-reference 通用效能準則自行設計可視行渲染，不引用不存在的專屬方案。 |

沿用 `--panel`／`--surface`／`--border`／`--text`／`--muted`／`--accent`／`--accent-bg`，不換全站配色。選中使用背景與邊線，預覽另加斜體與「預覽」文字，固定另有圖釘，避免只靠顏色。主要文字 13px、程式碼 13px／20px 行高、控制項至少 28px（touch pointer 時增大），間距採 4／8px。低動態、無面板縮放動畫；程式碼顏色使用本地語意 token，分別檢查深淺色。

## 版面與焦點規格

- 初始維持既有側欄寬度，使用者可調寬；寬度不少於可操作空間、不遮蔽視窗。目錄與內容在容器足夠寬時並排；窄於 440px 時上下排列，目錄可收合，檔案分頁可水平捲動，整頁不產生橫向捲動。
- 最大化限制在 workspace-canvas-body，頂層工作 tabs 與退出／還原仍可見；不移動或重建 Terminal DOM。還原回原寬度，關閉側欄把空間交還 Terminal。
- Zen／focus 不新增全域事件或改寫模式；側欄在既有工作區內運作，切到 History 時沿用父層隱藏邏輯，隱藏側欄不得覆蓋其他頁面。
- 單擊替換唯一 preview；雙擊或固定按鈕轉成 pinned。點選既有 pinned 不降級。分頁關閉只釋放該文字快取，焦點落到相鄰檔案 tab 或目錄；沒有關閉 runtime 的 API 呼叫。
- 檔案區內 Ctrl／Cmd+F 開啟字面搜尋；Enter／Shift+Enter 找下一／上一筆。Ctrl／Cmd+W 只關目前檔案；Ctrl+PageUp／PageDown 切換檔案。這些事件不在 window 註冊，不攔截 Terminal 操作。
- Escape 分層處理：選單／搜尋 → 還原最大化 → 沿用父層收合檔案區並回入口。最大化時 Tab 不進入被覆蓋的 Terminal；關閉／還原不殺程序。
- 麵包屑呈現專案相對路徑，右鍵與 Shift+F10 的複製只寫 clipboard，不開啟檔案。clipboard 不可用時顯示可選取的路徑與明確失敗訊息。
- 20 個檔案上限按工作分頁各自計算；全部固定時拒絕新增並提示，不淘汰固定分頁。重新整理清除全部文字快取；讀取被拒絕時只顯示錯誤，不留下過期內容。
- 虛擬文字的畫面選取僅包含可見行；工具列另提供精確複製全文按鈕並明示限制。搜尋涵蓋全文，最多列出 10,000 筆，命中上限顯示加號；高亮只處理可視行的有限匹配。語法高亮為輕量詞法提示，並非完整語言 parser。

## 分段交付

1. 設計與範圍規格。
2. 目錄／檔案分頁／文字檢視與局部 CSS。
3. 合成鍵盤、競態、效能上限、深淺色／窄視窗與 Terminal 不重掛載回歸、獨立 review。
