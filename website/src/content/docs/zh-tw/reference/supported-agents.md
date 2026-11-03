---
title: 支援的 Agent
description: Session Bay 支援哪些 Agent、從哪裡讀取歷史，以及如何接續 Session。
---

| Agent | 執行檔 | 歷史讀取位置 | 接續方式 |
| --- | --- | --- | --- |
| Claude Code | `claude` | `~/.claude`（或 `$CLAUDE_CONFIG_DIR`） | `claude --resume <id>` |
| Codex CLI | `codex` | `~/.codex`（或 `$CODEX_HOME`） | `codex resume <id>` |
| OpenCode | `opencode` | `~/.local/share/opencode` | `opencode --session <id>` |
| Grok Build | `grok` | `~/.grok`（或 `$GROK_HOME`） | `grok --resume <id>` |
| Antigravity CLI | `agy` | `~/.gemini/antigravity-cli` | `agy --conversation <id>` |

- 歷史格式屬於各 Agent 的內部實作，版本更新時可能改變。無法辨識的格式會讓該 Session 顯示為「解析不完整」，不會讓整個索引失敗。
- OpenCode 僅支援 CLI 2.x，歷史讀取與即時狀態的已審查版本為 2.2.0 至 2.2.5。歷史只讀取 `session_v2`、`session_message` 和 `session_part`。缺少 `session_v2` 時，來源會顯示非致命提示，請使用 OpenCode 2.x 開啟資料庫一次以遷移；Session Bay 絕不遷移或寫入歷史。遷移後保留已審查 1.x 原始版本的工作階段仍可完整讀取。遷移格式已在 macOS 以官方 2.2.3 執行檔搭配合成資料驗證。原生 2.x 片段與 OSC 7501 即時狀態已透過合成測試及原始碼審查，真實 2.x 即時狀態／模型對話尚未驗證。系統通知、工具與推理內容不納入索引；較新或未審查的歷史版本仍標記為部分解析。OSC 7501 提供工作中、權限與問題等待；工作中轉為閒置會發出完成提醒，不再回報失敗。不需 Session Bay 外掛、inline config 注入或 standalone/server 參數處理。終端 record ID 必須經索引確認為 2.x Session、目錄相同且建立時間晚於本次啟動，才會作為 Session 身分。清理會先列出並匯出所有後代，再遞迴刪除。只支援還原 2.x 匯出檔；1.x 匯出檔與未記錄主版本的紀錄仍會列出，但無法還原，檔案會保留。不支援更早的 JSON 儲存格式或自訂資料庫名稱。
- Antigravity 只支援 CLI，不包含 Antigravity App 或 IDE。真實 CLI 1.3.5 歷史資料的相容性尚未驗證，未知或截斷的格式會顯示警告。
- 不包含這些 Agent 的桌面 App 或 IDE 外掛。

想支援其他 Agent？歡迎[提出功能需求](https://github.com/wellwind/SessionBay/issues/new?template=feature_request.yml)。
Claude Code 即時狀態需要 **2.1.295 以上版本**，透過每個 Agent 的設定啟用 OSC 7501。只保留 SessionStart 身分 hook，移除狀態 mod 與等待／權限 hooks。較舊版本僅顯示程序狀態並清楚提示。Claude Code 2.1.316 的啟動 capability query 與結束 clear 已離線驗證；正常工作、等待、完成與錯誤狀態仍待真實 Session 驗證。所有終端狀態僅供顯示，絕不授權任何動作。Codex、Grok 與 Antigravity 行為維持原樣，包括 Codex app-server observer。
