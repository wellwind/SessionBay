---
title: Agent 狀態與通知
description: 知道 Agent 正在工作、等你回覆、已完成或失敗。
sidebar:
  order: 5
---

Session Bay 會在分頁、側欄、**全部工作區**與附加的[看板任務](/SessionBay/zh-tw/guide/kanban/)顯示每個 Agent 的狀態：

| 狀態 | 意思 |
| --- | --- |
| 工作中 | Agent 正在執行步驟。 |
| 等待輸入／權限 | Agent 需要你回答。 |
| 已完成 | Agent 完成這一輪。 |
| 失敗 | Agent 回報錯誤。 |

狀態由 Agent 自己回報（Codex app server 或 OSC 7501 終端狀態序列），Session Bay 不會從輸出文字去猜。如果 Agent 無法回報狀態，面板只會顯示程序是否在執行。

### Shell 中任何程式的狀態

一般 Shell 面板也會讀取 [OSC 7501 程式狀態](https://superlogical.com/rex/docs/build/program-status)序列，因此腳本、建置工具，或你手動啟動的 Agent 都能回報自己的狀態：

```sh
printf '\e]7501;state=working\e\\'   # 工作中
printf '\e]7501;state=done\e\\'      # 完成；面板不在畫面上時會發出完成提醒
```

支援的狀態有 `idle`、`working`、`done`、`blocked`（可搭配 `kind=permission`、`question` 或 `auth`）、`error` 與 `clear`。程式結束前應回報 `done`、`error` 或 `clear`：Session Bay 看到的是面板的 Shell，而不是每個指令，所以工作中、等待與閒置狀態只會在 Shell 本身結束，或 Shell 以 OSC 133 提示標記（Shell 整合）顯示新提示字元時清除。完成與錯誤會保留到被取代為止。Shell 狀態只用於顯示，不會把面板連結到任何 Agent Session。

## 系統通知

當 Agent 等待輸入或權限、完成或失敗，而它的面板不在畫面上或視窗在背景時，Session Bay 會發出系統通知。點一下通知，Session Bay 就會回到前景並切到那個面板。每個面板的提醒之間有 5 秒冷卻。

可以在**設定 → 外觀與預設值 → 系統通知**關閉。第一次使用時 macOS 也可能詢問是否允許通知。

也可以獨立啟用**提醒音效**，預設關閉。音量與測試按鈕在同一區，詳見[音效設定與勿擾模式限制](/SessionBay/zh-tw/guide/settings/#提醒通知與音效)。

## 即時狀態

請在**設定 → 來源與工具**為各 Agent **啟用即時狀態**，原有的每個 Agent 設定值會保留。它只影響從 Session Bay 啟動的 Agent，不會修改 Agent 的全域設定。Claude Code 需要 **2.1.295 以上版本**；OpenCode 需要已審查的 **2.2.0–2.2.5**。不符合狀態版本門檻時仍會啟動，面板會清楚提示僅顯示程序狀態。已不再支援 OpenCode CLI 1.x。

Claude Code 與 OpenCode 改用 OSC 7501 終端回報。同一 runtime 從工作中轉為閒置時會發出一次完成提醒；開啟或重新連接面板時的初始閒置不會提醒。明確的 done/error 回報沿用現有處理方式。OpenCode 能回報權限與問題等待，但目前的 OSC 序列**無法回報失敗**。提醒沿用其他通知與音效的可見性規則及冷卻時間。

Claude 只保留 SessionStart hook 來識別原生 Session。OpenCode 不需 Session Bay 外掛或注入設定；終端 record ID 必須經歷史索引確認為 2.x Session、工作目錄相同，且建立時間晚於本次啟動，才會作為 Session 身分。自動附加看板可能因此等待索引完成。終端狀態僅供顯示，絕不授權任何動作。

Claude Code 2.1.316 的啟動 capability query 與結束 clear 已經離線驗證；正常工作、等待、完成及錯誤回報仍待真實 Session 驗證。OpenCode 的 OSC 狀態已由 2.2.3 原始碼確認；真實模型回合的端到端流程仍未驗證。
