# 工作區 Activity Bar

## 使用方式

全域左側依序為歷史 Sessions、Files、專案。任一時刻只有一個相鄰側欄；再點已選功能即收合。專案功能保留原本專案與所有目錄導覽、總覽、可排序專案樹、工作分頁與狀態。功能切換不變更中央 Terminal／檔案；選取歷史列才開啟對話預覽。

初次開啟顯示專案功能。同次開啟期間，全域功能選取跨專案、正常與專注模式保留；歷史和 Files 的資料範圍隨所選專案更新。無專案的歷史入口使用全域搜尋；Files 提供選擇專案入口，不瀏覽 HOME。未顯示的已訪問側欄保持掛載，清單、目錄與文件狀態不因功能切換而重建。

功能列可用 Tab、Enter／Space 操作；上下鍵、Home／End 移動焦點。高度不足時顯示「更多功能」選單，保留所選功能標記與可用性。選單支援上下鍵、Home／End 及 Escape 返回入口。

## 新增內部功能

`src/components/ActivityShell.tsx` 提供 `ActivityContribution`；App 只組裝 contribution 清單，shell 不包含 Sessions、Files 或 Projects 的條件分支。

```tsx
const contribution: ActivityContribution = {
  id: 'example', // 穩定且唯一，不使用顯示名稱當 identity。
  label: '範例',
  icon: ExampleIcon,
  available: true,
  badge: 3,
  onActivate: () => prepareExampleContext(),
  renderSidebar: () => <ExampleSidebar projectId={selectedId} />,
};
```

將它加入 contributions 指定位置即可取得圖示、tooltip、選取與收合、鍵盤、延遲掛載與 overflow。renderer 只提供自己的側欄內容，不能自行建立另一份 Activity Bar，也不應在選取功能時停止／重啟 Runtime。`available` 用於真正不可用的功能；對可引導使用者補齊的前置條件，優先由側欄提供明確入口。badge 為選填，不以它取代可存取名稱。

含資料抓取與快取的功能自行管理資料生命週期；shell 保證首次開啟後側欄不因切換卸載。不要在 renderer 中依每次渲染產生新的元件型別或 key，避免破壞這項保證。History 與 Files 的中央內容仍由 App 持有，側欄使用穩定 portal host。

這是內部擴充點，沒有插件下載、動態程式執行、權限委派或外部 API。Git 尚未實作，介面不顯示空按鈕。合成第四功能的單元測試驗證擴充、lazy mount、狀態保留、badge、availability 及 overflow。

## 驗證界線

瀏覽器 fixture 使用合成專案與 Session，不讀取私人歷史。新增 UI 必須檢查 720／1200／1440 寬度、深淺主題、正常與專注模式、單側欄收合後的 Terminal 邊界，以及短高度篩選。瀏覽器驗證不能替代原生 WebView、實體 IME 或跨平台驗收。
