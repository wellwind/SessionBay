# Session Bay 桌面介面設計系統

日期：2026-10-15。狀態：本次全介面改版的實作指引；本文件本身不代表實機驗收完成。功能邊界以 [產品規格](product-spec.md)、[UX 規格](ux-spec.md) 與 [後續待辦](future-backlog.md) 為準。

## 1. 設計方向與判斷依據

目標是長時間使用的本機開發工作台：先辨認工作位置，再閱讀歷史或進入仍在執行的工作。使用冷灰藍底色、低飽和綠色主操作、清楚的層級與緊湊但可點擊的控制項。視覺重心留給目錄名稱、工作階段內容與終端輸出。

- **安靜且可掃讀**：不用首頁巨幅標語、統計儀表、漸層玻璃卡片或進場動畫。主色用於目前位置、選取與主要操作；紅色只用於錯誤／破壞性操作。
- **位置與狀態分開**：「專案」是使用者挑選的目錄清單；「所有目錄」是歷史所在目錄的總覽；「開啟中的工作區」是仍可回到的工作位置。三者不能用同一種徽章含糊表示。
- **一個區域，一個主操作**：總覽的主操作是加入／建立專案；歷史預覽是接續該工作階段；終端是目前面板。其他操作保持次要層級。
- **實際能力優先**：清楚區分 CLI 可啟動、歷史可索引、可預覽、可接續、手動 ID 接續及登入狀態未知；不能將程序存活畫成 Agent 正在思考。

### 研究與適用性

已閱讀安裝的 UI/UX Pro Max 設計指南及 `pro-rules`、相關 `quick-reference`；程式碼確認技術為 React 19、Tauri 2、原生 CSS。設計查詢採 variance 3、motion 2、density 8。以下保留經判斷適用的結論，沒有直接套用完整自動輸出。

| 查詢 | 結果與採用方式 |
| --- | --- |
| `desktop developer productivity workbench --design-system` | Minimalism / Swiss 的一致網格與留白適合；Product Demo / Features 的行銷頁架構不適合。 |
| `developer tools desktop dashboard --design-system`，縮小範圍重試 | Developer Tool / IDE 的冷灰底色適合；FAQ / Documentation Landing 仍非工作台。沒有找到可直接採用的版面模式，以下 IA 依實際產品流程與一般桌面設計原則制定。 |
| `focus accessible keyboard controls --stack react` | 採用語意控制項、模態焦點管理與關閉後焦點返回；測試以可存取角色與名稱操作。 |
| `sidebar navigation hierarchy --domain ux`，再以 `nav-hierarchy primary secondary` 重試 | 回傳多為麵包屑／標題層級，沒有精確命中兩頁工作台導覽；不新增多層麵包屑，使用指南的清楚主次層級原則。 |
| `focus not obscured --domain ux` | 精確命中焦點不被遮蔽，適用於捲動設定面板、固定頁尾與 popover。 |
| `developer tools productivity --domain color` | Developer Tool / IDE 配色可作起點；以下顏色已重新搭配並計算對比。 |

未採用：Google Fonts 遠端載入、GSAP 捲動揭露、行銷轉換區塊、手機底部導覽及一律禁止淺色模式。產品保留既有主題設定、離線可用性與桌面資訊密度。原生手機的 44pt 建議不能直接等同桌面 WebView 的所有元件規格。

## 2. 必須維持的功能契約

1. 預設開啟「專案」，只列 `curated` 群組；已有歷史但尚未加入的目錄不得自動變成專案。空專案頁仍可通往所有目錄或加入／建立對話框。
2. 「所有目錄」列有工作階段的群組，包含路徑失效與未記錄 cwd 的群組。總覽不是混合的全域工作階段清單；不預先發出無群組範圍的歷史查詢。
3. 切換頁面清除目前群組選取與群組搜尋；不終止、重建或卸載仍在執行的工作區。開啟中的工作區在兩頁均可抵達。
4. 從專案移出，只改變清單成員資格；不刪除目錄、歷史、工作區或程序。在專案頁且沒有目前 runtime 時返回專案總覽；在所有目錄頁保持群組選取。
5. 原始 cwd 與另設的啟動位置分開顯示。啟動位置優先序維持明確 relocation、該工作階段／面板 cwd、群組路徑，不能以過期群組路徑覆蓋原工作位置。
6. 新增／建立成功後，即使刷新失敗，重試也不能再次建立目錄或重複變更。送出期間鎖住相關操作，錯誤與重試文字應反映實際階段。
7. 啟動仍使用後端提供的 executable、args、cwd 預覽與原有檢查。Shell／Agent 分流只減少選擇負擔，不繞過預覽、未安裝阻擋或高風險參數提醒。
8. Shell 成功退出只移除符合條件的面板及最後空分頁；其他分頁／分割、失敗、非零退出、Agent 與還原占位均保留。版面調整不能改動此生命週期。
9. 原工具歷史唯讀；重開應用目前只還原布局／占位，不能寫成恢復存活程序。

## 3. 資訊架構與共用框架

### 桌面骨架

- 頂欄 68px：品牌／側欄切換、兩個主要導覽頁籤、右側全域操作。頁籤只出現一次；不要在側欄再複製同層「專案／所有目錄」選擇。
- 側欄建議 240px，可在 224–264px 間適配：上方是本頁群組搜尋，中間是本頁群組，下方獨立標題「開啟中的工作區」。設定入口與索引狀態位於穩定位置。
- 內容標頭約 72–88px：一個 h1、必要的簡短說明／原路徑、右側操作。沒有選取時 h1 為「專案」或「所有目錄」，選取後是群組名稱。避免 h1 與下方同義 h2 疊成兩個巨大的頁首。
- 頁面邊距 24px，緊湊區域 16px。總覽與歷史各自捲動；終端維持完整可計算的高度。狀態列約 24px，沒有新狀態時不反覆跳動。
- 1280×800 與 1440×900 是主要檢視尺寸；1024×768 檢查側欄收合、設定捲動、按鈕換行。窄視窗優先收合次要欄，不把工作台硬改成手機導覽。

### 導覽語意

主要頁面維持 `tablist`「導覽頁面」、`tab` 與選取狀態；側欄群組是有名稱的 `nav`。群組與開啟工作區的同名項目必須有不同區段標題與可辨識的輔助資訊。卡片整體主區域可選取，成員資格按鈕是平行的獨立控制，不嵌套在主按鈕內。

目前頁面／群組的選取使用淡主色底與明確文字，不只用一條細色線。hover 與 selected 必須可分辨；鍵盤焦點再加獨立外框。

### 主要流程

| 起點 | 操作與結果 | 視覺／焦點重點 |
| --- | --- | --- |
| 空專案頁 | 從所有目錄挑選，或加入既有目錄／建立新目錄 | 說明只是尚未挑選，不寫成「沒有歷史」。 |
| 所有目錄 | 選群組 → scoped 歷史 → 預覽 → 接續 | 群組名稱與完整 cwd 持續可見；接續按鈕對應目前預覽。 |
| 未分類／失效目錄 | 選群組 → 加入專案 → 必要時選可用啟動位置 | 原始來源保留；新啟動位置獨立標示。 |
| 專案總覽 | 加入／建立 → 成功後選取新專案 | 空白專案沒有歷史仍可開始工作；取消不改資料。 |
| 目前終端 | 切頁／移出專案 → 從開啟工作區返回 | 輸出、面板與程序持續存在，不播放重新載入動畫。 |
| 所有目錄的明確搜尋入口 | 搜尋所有工作階段 → 返回目錄總覽 | 明示跨目錄範圍；不能取代預設目錄總覽。 |

## 4. 色彩與語意 tokens

沿用既有 CSS 變數名稱以降低整合風險；新增 `--control-border` 與 `--on-accent` 等用途明確的變數。元件不可自行選一組未定義的灰色。

| Token | 深色 | 淺色 | 用途 |
| --- | --- | --- | --- |
| `--bg` | `#10171C` | `#F3F6F7` | 應用底色 |
| `--sidebar` | `#121D23` | `#EAF0F2` | 導覽區 |
| `--panel` | `#172229` | `#FFFFFF` | 卡片、主要內容、popover |
| `--surface` | `#1D2B33` | `#EEF3F5` | 輸入區／次要區塊 |
| `--surface-hover` | `#253640` | `#E1EBEF` | hover |
| `--border` | `#344851` | `#CDD9DF` | 裝飾分隔線 |
| `--control-border` | `#627985` | `#788C98` | 必須辨認的輸入／checkbox 邊界 |
| `--text` | `#ECF3F5` | `#142C36` | 主要文字 |
| `--muted` | `#A8BAC4` | `#4A6470` | 描述、路徑、次要文字 |
| `--subtle` | `#8FA3AF` | `#5B7480` | 面板底上的低優先文字；淺色 hover 底勿使用 |
| `--accent` | `#7DD9B4` | `#0C7058` | 主操作、選取、焦點 |
| `--accent-strong` | `#9CE8CC` | `#085B48` | 主操作 hover |
| `--accent-bg` | `#1C3A33` | `#DDEFE8` | 淡色選取底 |
| `--on-accent` | `#10251E` | `#FFFFFF` | 實色主按鈕／選取日期上的字 |
| `--danger` | `#FFB0AD` | `#A9333B` | 錯誤文字／危險操作 |
| `--danger-bg` | `#3C2428` | `#FCEAEC` | 錯誤區 |
| `--warning` | `#EDCA82` | `#805B12` | 失效路徑、高風險設定 |
| `--warning-bg` | `#372F1C` | `#FFF3D6` | 提醒區 |

### 對比驗算

使用 sRGB 相對亮度公式計算純色組合；數值不是實機截圖量測，透明度／疊色／字重仍須另驗。

| 前景／背景 | 深色 | 淺色 |
| --- | ---: | ---: |
| text／panel | 14.42:1 | 14.55:1 |
| muted／panel | 8.08:1 | 6.27:1 |
| muted／surface-hover | 6.24:1 | 5.18:1 |
| accent／panel | 9.60:1 | 6.04:1 |
| on-accent／accent | 9.54:1 | 6.04:1 |
| control-border／surface | 3.18:1 | 3.13:1 |
| danger／danger-bg | 8.18:1 | 5.62:1 |
| warning／warning-bg | 8.43:1 | 5.56:1 |

正文／重要小字目標至少 4.5:1。較淡 `--border` 只用於裝飾分隔，不能取代欄位辨識所需的邊界。主色背景上的字用 `--on-accent`，不要假設 `--bg` 在兩種主題都正確。警告需有圖示或文字，不單靠顏色。

## 5. 字體、尺寸與動態

### 本機字體

```css
--font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", "Noto Sans CJK TC", sans-serif;
--font-mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
```

不新增遠端字體請求。保留終端既有自訂字體與大小設定；不要用 UI 字體規則覆蓋 xterm。中文標題使用系統無襯線，路徑、ID、argv、程式碼用等寬。

| 層級 | 大小／行高 | 重量／用途 |
| --- | --- | --- |
| 頁面標題 | 24px／1.3 | 600；不過度加粗 |
| 區段標題 | 18–20px／1.4 | 600 |
| 卡片／表單標籤 | 14px／1.45 | 500–600 |
| 正文／控制項 | 14px／1.5 | 400–500 |
| 描述／狀態／路徑 | 12–13px／1.5 | 400；重要資訊不壓到 10px |
| 對話內容 | 14px／1.65 | 舒適閱讀；約 65–75 字元的段落寬度 |

間距採 4、8、12、16、24、32px。控制項圓角 6px、卡片 10px、對話框 14px。卡片使用邊界與底色分層，只有 popover／dialog 需要陰影；一般 row 不加陰影。

桌面欄位／按鈕高 36px，圖示按鈕 32px，日曆日期 32px。checkbox 圖形 16–18px，但整個文字 label 至少 32px 高並可點擊。這是產品的緊湊桌面規格；觸控／粗指標情境可放大至 44px。WCAG 2.2 AA 的 target-size 最小規則是 24 CSS px 或符合間距等例外，不等於所有桌面控制都必須 44px。[官方說明](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)

hover／focus 色彩轉換約 120ms，popover 約 160ms。不要動畫化終端尺寸、重排歷史列或延後可互動時間。`prefers-reduced-motion: reduce` 停用非必要轉場；狀態正確比動畫完整更重要。

## 6. 各頁實作規格

### A. 專案總覽

- 標頭：「專案」、一句「你加入的工作目錄」、主按鈕「加入／建立專案」。下方不要再放同一個主按鈕。
- 卡片最小約 280px、間距 16px，依內容寬度排 2–3 欄。順序是名稱、完整路徑／換行、工作階段數、來源 Agent、最近活動。資料不足顯示「尚無歷史」，不補假統計。
- 成員資格控制放卡片底部低權重區。「移出專案」不是刪除按鈕，不使用垃圾桶或全紅卡片；以提示說明檔案、歷史、程序仍保留。
- 空狀態只有短標題、說明與有效入口；群組搜尋無結果使用「沒有符合的專案」，不要混用真正空資料文案。

### B. 所有目錄總覽

- 標頭：「所有目錄」、清楚標示依原工作目錄分組。卡片沿用同一結構，成員資格標示為「已加入專案／尚未加入專案」。
- 失效目錄用 warning 圖示與「目錄不存在」文字；未記錄 cwd 用「未分類・未記錄工作目錄」。兩者仍可選取並查看歷史。
- 跨目錄搜尋維持明確的次要入口。進入後標明範圍並提供「返回目錄總覽」；不要讓空白搜尋自動鋪滿所有工作階段。

### C. 群組歷史與預覽

- 標頭維持群組名稱與完整原路徑；已設定 relocation 時加獨立「啟動位置」。加入／移出專案是次要操作。
- 搜尋列統一 `.search-field`，Agent／排序用 Select，日期用 DatePicker。密度過高時將既有日期條件收在可展開的篩選區，不增加未有後端支援的新條件。
- 歷史清單寬約 360–420px 或內容的 35–40%，預覽取得剩餘空間。列高依文字約 84–96px；顯示兩行內標題／摘要、來源與時間。選取、hover、focus 分開。
- 預覽先顯示標題、來源、完整 cwd／ID，再顯示對話。接續是該預覽的主要操作；下載、刪除、未實作的內容編輯不能以灰按鈕暗示已規劃完成。
- 保留分頁、debounce 與非同步 race guard。重新查詢時不要閃空整個工作台；錯誤提供既有可行重試，未知來源能力顯示清楚原因。

### D. 工作區與終端

- 分頁列約 32–36px，面板工具列保持低對比；目前面板以清楚邊框表示。主操作不遮住終端輸入列。
- 分割區域的尺寸由現有布局管理。頁面切換、側欄搜尋與選取卡片不能以 React key 變更重建工作區。React 的元件位置／identity 會影響 state 保存，需保持既有 runtime 容器穩定。[官方說明](https://react.dev/learn/preserving-and-resetting-state)
- 開啟中與已退出／失敗文字只能表達可靠 runtime 狀態，不新增「思考中」「等待輸入」推測。成功 Shell 自動關閉依功能契約執行；失敗輸出留在原位置供查看。

### E. 開始工作與加入專案對話框

- 啟動對話框約 560px：先選 Shell／Agent；Shell 顯示 profile，Agent 顯示帶識別圖示的工具選單與適用的手動接續 ID。cwd 始終明確。
- 後端實際 executable、逐個 args 與 cwd 用等寬預覽；不要將預覽描繪成可直接複製且一定等價的未轉義 Shell 指令。預覽載入／錯誤、CLI 未安裝時主按鈕不可啟動。
- 高風險參數在主按鈕附近有警告，不只藏在設定。選項值／說明很長時選單可換行，觸發器維持穩定寬度。
- 加入專案對話框約 520px：既有目錄＋可選名稱，或父目錄＋新名稱；保持單一送出區與取消。成功但更新清單失敗時顯示「已完成，重試更新清單」語意，不能再讓使用者按出第二次建立。

### F. 設定

- 桌面寬度上限約 1040px，與視窗邊緣至少 24px；左側分類約 184px，右側內容捲動，保存／取消區固定但不能遮住最後欄位。
- 四類維持資料來源、Shell Profiles、外觀、快捷鍵。分類切換不丟草稿；驗證失敗轉到相應分類並聚焦欄位，錯誤緊鄰輸入。
- CLI 區和歷史來源區分開。Codex、Claude、Grok、Antigravity 的來源能力均有可見說明；不支援索引不等於不能啟動。偵測不宣稱已登入。
- Shell 偵測候選與已保存 profile 分開；加入候選只改草稿，不能覆蓋既有自訂參數／環境變數。再次偵測有局部忙碌狀態。
- 高風險權限選項使用原生 checkbox、文字說明與 warning 背景。所有 Select、輸入與行動按鈕同步遵守保存時的鎖定；portal 選單不能繞過 disabled fieldset。

## 7. 鍵盤、焦點與可存取性

### 共用控制項契約

- Select 保持 combobox 的焦點，透過 `aria-activedescendant` 對應 option；方向鍵跳過 disabled、Home／End、文字快速定位、Enter／Space 確認、Escape 不變更值而關閉。選取與焦點不能混成同一狀態。[APG Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
- DatePicker 顯示在地日期，輸入／保存是嚴格有效的 ISO 本地日期。日曆有可讀月份、星期與完整日期名稱；方向鍵移日／週，Home／End 移到週首尾，PageUp／Down 換月，Shift 搭配換年；有清除與今天。不得經 UTC 轉換造成前後一天漂移。此互動以元件實作與測試為準，參考 [APG 日期選擇器](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog/)。
- Checkbox 保持原生 input，Space 切換、label 可點、disabled 不變值；樣式不能移除語意。搜尋框圖示不取代可存取名稱。
- Select 選單焦點保留觸發器；日曆使用 roving day focus，Escape 返回原觸發器。點外側關閉不能搶走新點擊目標的焦點。
- 子 popover 先處理 Escape 並阻止傳遞，第一個 Escape 關子層、第二個才關父對話框。Tab 不落進已隱藏的選項，父 dialog 的 focus trap 必須與 portal 相容。

### 視覺焦點與讀屏

焦點外框至少 2px，加 2px 偏移；周邊需要留空避免被 overflow 裁掉。對捲動容器設定適當 scroll padding，焦點欄位／日曆日期應完全可見。WCAG 2.2 的 Focus Not Obscured Minimum（AA）要求不被作者內容完全遮住；本產品以完全可見作較佳設計目標，不把它誤稱 AA 的逐字要求。[官方說明](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)

圖示按鈕一律有名稱，純裝飾圖示 `aria-hidden`。h1／h2／h3 順序代表資訊層級，不為了字大小跳級。載入／儲存結果可用簡短 status，錯誤用可辨識文字；不要將每一行終端輸出放到全域 live region。開啟／關閉對話框維持合理的初始焦點與返回焦點。終端焦點中不得以全域字元快捷鍵攔截正常輸入。

## 8. 實作順序與驗收

1. 先落實語意色彩與字體，再重整 App 框架／DirectoryOverview；不要以增加陰影代替層級整理。
2. 將 History、Settings、Launcher 的控制項統一到同一組 tokens、Select、DatePicker、checkbox、search-field；確認淺色主按鈕使用 `--on-accent`。
3. 核對空狀態、載入、刷新失敗、失效目錄、未分類、CLI 不可用、高風險、已退出與占位狀態，而非只截有資料的漂亮畫面。
4. 重新執行 TypeScript、lint、全部前端測試、build。控制項現有 32 個自動化測例涵蓋鍵盤、禁用、動態選項、巢狀 Escape、日期有效性與正負時區；測試通過不等於原生 WebView／讀屏器驗收。

### 必拍／必操作的檢查矩陣

- 深／淺色，各拍：空專案、有專案卡片、所有目錄含未分類／失效、歷史與預覽、開啟終端、啟動 Shell／Agent、設定來源與長選單、日曆。
- 1280×800、1440×900、1024×768；200% 縮放或等效可讀性檢查。長中文名稱、長 cwd、多來源、0／1／多工作階段不截斷關鍵行動。
- 只用鍵盤完整走一次：頁面 → 群組 → 搜尋／篩選 → 預覽 → 啟動 → 取消 → 返回；另測 dialog 內 Select／DatePicker 的 Escape 與 Tab。
- 開啟程序後切頁、移出專案、搜尋、開設定，確認工作區仍可抵達且程序未重啟；成功 Shell 與失敗／Agent 退出行為分別檢查。
- 清單成員資格重載後持久保存；刷新失敗重試不重複 mutation；沒有互動時不自動新增／建立／保存。
- macOS VoiceOver 與實際 WKWebView、Linux WebView 的 popover／focus／字體須各自記錄實測證據。未跑的平台寫「待驗收」，不能以 jsdom 結果宣稱整體 WCAG 合規。

## 9. 本次明確不納入

本次是既有功能的整體 UI／UX 改版，不將 [17 項後續待辦](future-backlog.md) 偷渡為完成：文字縮放熱鍵、分頁改名、面板改名、分頁拖曳、專案改名、Agent 忙碌／等待與專案 Agent 數、其他 IME 問題、Shift＋Enter 多行、重開應用程序重新附接、索引效能優化、Herdr／Orca 比較研究、OpenCode、檔案瀏覽／預覽，以及後續追加的獨立 UI／Terminal 主題、臨時家目錄 Terminal、遠端管理與 Web 客戶端。新專案的初始可選名稱不等於既有專案重新命名。使用者之後明確追加的 CapsLock 特定組字重複路徑、Chrome 式工作分頁快捷鍵及來源候選偵測已納入本 PR；CapsLock 僅有合成事件回歸，真實 macOS IME 驗收仍待完成。

## 10. 官方參考與限制

查閱日期：2026-10-15。APG 是互動設計參考，範例不是可直接宣告全面相容的產品認證；W3C Understanding 文件用於解釋對應成功準則。色彩與版面值是本產品設計建議。

- [WAI-ARIA APG：Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
- [WAI-ARIA APG：Date Picker Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog/)
- [WCAG 2.2：Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [WCAG 2.2：Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
- [React：Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state)

新增本文件後，交付整合者應同步 README 文件導覽與來源索引；本文件沒有自行改寫其他文件的驗收狀態。

## 互動狀態補充（2026-10-17）

`src/interaction-states.css` 集中互動規則，元件原有 CSS 負責尺寸。主要選取面與次要動作為同層 button，避免巢狀互動。選取透過持續 accent 底色／邊線及 aria-current 表達；hover 使用獨立狀態色，不改幾何。focus-visible 使用內縮 2px outline，避免被列表／tabs overflow 裁切。disabled／aria-disabled 不產生一般 hover 回饋。

Session 列右側保留 32px 圖示動作；桌面 hover 或列內鍵盤焦點顯示，觸控常駐。確認、失敗重試與回收筒語意沿用現有流程。按刪除不會選取另一個 Session 或接續工作。

驗證：`npm run test:interactions` 在正常 sandbox-supported Chrome 執行深淺主題的實際 hover、focus、取消／完成刪除與觸控／reduced-motion，輸出 `test-results/interactions` 截圖。此雲端 shell 因 Unix socket 限制無法啟動 Chromium，提權執行亦因環境唯讀 mount 失敗；沒有關閉 Chromium sandbox。瀏覽器視覺結果待 Linux CI，不以靜態 JSX 或 mock 圖片代替實測。

追加專案 header：標題旁 pencil，工具列 trash／folder-minus 圖示與 Terminal／新增工作文字操作。Playwright 另包含 1000px 長名稱版的深淺色 bounds／鍵盤取消測試與兩張截圖，總計預期 14 張；仍待 CI 真實瀏覽器執行。

刪除後的 Undo 焦點屬於當次刪除流程：父層 refresh 尚未完成時，任何新 focus、pointer 或 keyboard 操作會撤銷待執行的焦點回復；已有另一個 modal 時亦不接管焦點。僅在沒有新操作且焦點仍在原 trigger／body 時聚焦 Undo。

Code Modern／Code2026 保留原 tab active／inactive／hover 配色，但高 specificity 的 tab hover 僅由主選取按鈕命中，rename／close 只亮自身並保留父 tab 選取底色與頂端邊線。Code palette 的列表／tab 鍵盤焦點保留 code-focus 色，改為 inset，避免被捲動容器裁切。新增兩套 Code palette × 深淺色的 computed-style 瀏覽器回歸（含未選取／已選取、三個 hover 命中區及鍵盤焦點），追加 12 張預期截圖，共 26 張、9 個 browser tests；結果仍待 Linux CI，不以 token 對比檢查代替瀏覽器驗證。
