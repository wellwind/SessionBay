---
title: Agent 狀態與通知
description: 知道 Agent 正在工作、等你回覆、已完成或失敗。
sidebar:
  order: 5
---

Session Bay 會在分頁、側欄與**全部工作區**顯示每個 Agent 的狀態：

| 狀態 | 意思 |
| --- | --- |
| 工作中 | Agent 正在執行步驟。 |
| 等待輸入／權限 | Agent 需要你回答。 |
| 已完成 | Agent 完成這一輪。 |
| 失敗 | Agent 回報錯誤。 |

狀態由 Agent 自己回報（活動 hooks、Codex app server 或終端狀態序列），Session Bay 不會從輸出文字去猜。如果 Agent 無法回報狀態，面板只會顯示程序是否在執行。

## 系統通知

當 Agent 需要你處理、而它的面板不在畫面上時，Session Bay 會發出 macOS 通知。點一下通知，Session Bay 就會回到前景並切到那個面板。

可以在**設定 → 外觀與預設值 → 系統通知**關閉。第一次使用時 macOS 也可能詢問是否允許通知。

## 活動 hooks

想取得 Claude Code 與 OpenCode 的即時狀態，請在**設定 → 來源與工具**為該 Agent 啟用**真實活動 hooks**。它只影響從 Session Bay 啟動的 Agent，不會修改 Agent 的全域設定。
