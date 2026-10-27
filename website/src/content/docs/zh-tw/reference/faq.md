---
title: 常見問題
description: 常見問題與解法。
---

### macOS 說無法打開這個 App

預覽版尚未經過公證。請用**系統設定 → 隱私權與安全性 → 強制打開**，詳見[安裝](/SessionBay/zh-tw/guide/install/#第一次打開)。

### Agent 顯示「未偵測到」

macOS 的 App 看不到 Shell 的 `PATH`。請在**設定 → 來源與工具 → 執行檔路徑**填入絕對路徑，例如 `which claude` 的結果。

### 歷史是空的

檢查該 Agent 在**設定 → 來源與工具 → 歷史資料來源**的設定。按**偵測歷史來源**、儲存，然後等掃描完成。只支援由 Agent CLI 寫入的 Session。

### 專案搬到其他資料夾了

按專案路徑旁的**重新定位**。新程序會在新位置啟動，原始歷史不會被改寫。

### 關閉 Session Bay 會停止 Agent 嗎？

不會。Agent 與終端機會在背景繼續執行，重新打開 Session Bay 時自動附接回來。要結束請在面板上按**停止**。

### 可以切換成英文介面嗎？

可以，在**設定 → 外觀與預設值 → 語言**切換。

### 要到哪裡回報問題？

請[開 issue](https://github.com/wellwind/SessionBay/issues/new/choose)。請不要貼上真實對話或 token。
