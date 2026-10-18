# 單一 Agent 設定版面

- 搜尋 Agent 的圖示、文字與箭頭共用外層表面，內層 input 保持透明且不另畫 focus ring。CSS reset 的優先序必須高於 Code theme 的通用 input 規則。
- 已選 Agent 的啟動設定、歷史來源各使用完整內容寬度，不保留舊版多 Agent grid 的空白第二欄。
- 移除這兩區多餘外層卡片；來源仍保留自己的操作區。
- 「目前：」標籤不拆字；長執行檔路徑在可用寬度內換行。
- 移除 hooks 兩段重複長說明；保留 checkbox、錯誤與不支援狀態，不變更 hooks 啟用／權限行為。完整機制仍見 agent-activity 文件。

Browser 回歸使用合成設定與路徑，涵蓋深／淺色、Bay／Code Modern／Code 2026、idle／hover／focus／disabled，以及寬／窄視窗；不使用使用者截圖或真實來源資料。
