---
title: 常見問題
description: 常見問題與解法。
---

### macOS 說無法打開這個 App

預覽版尚未經過公證。請用**系統設定 → 隱私權與安全性 → 強制打開**，詳見[安裝](/SessionBay/zh-tw/guide/install/#第一次打開)。

### Agent 顯示「未偵測到」

Session Bay 會檢查 `PATH` 與常見安裝位置，包含 macOS 的版本管理器目錄。先試試**設定 → 來源與工具 → 重新偵測**；若仍找不到 CLI，請在**執行檔路徑**填入絕對路徑，例如在 Shell 執行 `which claude` 的結果。

### 終端機找不到 node 或 npm

0.3.0 會避免新終端機繼承啟動來源的 nvm 與 npm 工作階段狀態。修正前已啟動的 broker 會保留舊環境，直到重新啟動。關閉視窗不會重啟 broker；重新啟動 Mac 才會。也請確認 Shell Profile 有初始化版本管理器。

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
