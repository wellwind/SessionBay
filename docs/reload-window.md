# 重新載入視窗

- 命令面板搜尋 `Reload Window` 或「重新載入視窗」並執行。
- 等待工作區保存完成後重新載入 UI；啟動時沿用 bootstrap/reconcileRuntimes 接回既有 broker。
- 保存失敗顯示「重新載入已取消」，可修復儲存問題後重試。
- 模組錯誤／React 未捕捉錯誤的畫面也有重新載入按鈕，避免依賴已壞掉的命令面板。
- 不增加預設 reload 快捷鍵，避免搶走 Terminal 的 Ctrl+R 等按鍵。

## 驗收

1. 開啟持續輸出或長時間執行的 Agent，記下 runtime ID／PID。
2. 更名／調整分頁後立即執行 Reload Window，確認布局保存且 runtime ID／PID 不變，輸出可繼續接收。
3. 模擬 save_workspace 失敗，確認不重載、顯示失敗，再重試。
4. 模組載入失敗時確認 fallback 按鈕仍可用；不產生 close、stop 或 launch 呼叫。

自動測試驗證保存順序、失敗取消／重試、命令中英文搜尋與 fallback。macOS／Windows 真機與使用者 Agent 工作未於本變更驗證。
