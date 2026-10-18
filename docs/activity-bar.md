# 工作區 Activity Bar

## 使用方式

左側固定保留專案／所有目錄導覽、總覽、專案樹與開啟工作狀態。專案是主要入口；進入專案後，最右側顯示 44px 工具列，依序為歷史 Sessions、Files。專案與工具不在同一層切換。

工具面板在功能列左側展開，一次只顯示一個；再點已選功能即收合並釋放全部面板寬度。圖示只切換面板，選取 Session 或檔案才更新中央內容。總覽、所有工作階段搜尋與臨時 Terminal 不顯示專案工具，也不保留右側空間；全域歷史使用原本中央搜尋介面。

同次開啟期間，各專案保留中央檔案／Terminal／歷史檢視，以及各自正常／專注模式的工具選取。首次進入沒有工作分頁的專案預設開啟歷史；已有工作分頁則顯示 Terminal，工具收合。專注模式隱藏左側導航，右側工具預設收合，可明確展開；切回正常模式恢復正常工具狀態，中央工作不變。已訪問工具保留掛載，歷史的篩選、選取與分頁快取按專案保存。

功能列可用 Tab、Enter／Space 操作；上下鍵、Home／End 移動焦點。高度不足時顯示「更多功能」選單，保留所選功能標記與可用性。選單支援上下鍵、Home／End 及 Escape 返回入口。

## 新增內部功能

`src/components/ActivityShell.tsx` 提供 `ActivityContribution`；App 只組裝 contribution 清單，shell 不包含 任何功能 ID 的條件分支。

```tsx
const contribution: ActivityContribution = {
  id: 'example', // 穩定且唯一，不使用顯示名稱當 identity。
  label: '範例',
  icon: ExampleIcon,
  available: true,
  badge: 3,
  onActivate: () => prepareExampleContext(),
  renderSidebar: () => <ExampleSidebar projectId={current.id} />,
};
```

將它加入 contributions 指定位置即可取得圖示、tooltip、選取與收合、鍵盤、延遲掛載與 overflow。renderer 只提供自己的側欄內容，不能自行建立另一份 Activity Bar，也不應在選取功能時停止／重啟 Runtime。`available` 用於真正不可用的功能；對可引導使用者補齊的前置條件，優先由側欄提供明確入口。badge 為選填，不以它取代可存取名稱。

含資料抓取與快取的功能自行管理資料生命週期；shell 保證首次開啟後側欄不因切換卸載。不要在 renderer 中依每次渲染產生新的元件型別或 key，避免破壞這項保證。History 與 Files 的中央內容仍由 App 持有，側欄使用穩定 portal host。

這是內部擴充點，沒有插件下載、動態程式執行、權限委派或外部 API。Git 尚未實作，介面不顯示空按鈕。合成第四功能的單元測試驗證擴充、lazy mount、狀態保留、badge、availability 及 overflow。

## 驗證界線

瀏覽器 fixture 使用合成專案與 Session，不讀取私人歷史。新增 UI 必須檢查 720／1200／1440 寬度、深淺主題、正常與專注模式、左導航／右工具收合後的 Terminal 邊界與總覽零空白佔位，以及短高度篩選。瀏覽器驗證不能替代原生 WebView、實體 IME 或跨平台驗收。
