---
title: 設定
description: Agent 與歷史來源、Shell Profile、外觀、語言與快捷鍵。
sidebar:
  order: 8
---

按頂列的齒輪圖示打開**設定**。

![設定對話框](../../../../assets/screenshots/zh-tw/settings.png)

## 來源與工具

每個 Agent 有自己的設定：

- **啟用**你用到的 Agent。停用的 Agent 會保留已索引的歷史，但不會掃描或啟動。
- **執行檔路徑**：Session Bay 會在常見的安裝位置尋找。macOS 的 App 不會繼承 Shell 的 `PATH`，找不到時請填絕對路徑。
- **參數與權限**：以 JSON 陣列填入額外啟動參數，例如 `["--model", "your-model"]`。略過權限確認的高風險模式預設關閉，必須逐一為 Agent 啟用。
- **歷史資料來源**：讀取歷史的資料夾。**偵測歷史來源**會檢查官方已知位置。

## Shell Profiles

設定新終端機使用的 Shell、參數與環境變數。

## 外觀與預設值

- **語言**：English、繁體中文，或跟隨系統語言。切換時會重新載入視窗，終端機會自動重新連線。
- 介面與終端主題、色系、字型，以及工作台縮放（<kbd>⌘</kbd><kbd>+</kbd>／<kbd>⌘</kbd><kbd>-</kbd>／<kbd>⌘</kbd><kbd>0</kbd>）。
- **新增工作**時預設的 Agent 與 Shell Profile，以及系統通知。

## 鍵盤快捷鍵

修改常用命令的快捷鍵。`Mod` 在 macOS 代表 <kbd>⌘</kbd>。
