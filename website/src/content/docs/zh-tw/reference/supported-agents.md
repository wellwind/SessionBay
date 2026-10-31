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
- OpenCode 歷史讀取支援 CLI 1.x 至 1.19.5，以及 CLI 2.2.x 至 2.2.5。v1 格式已在 Linux 以 CLI 1.19.2／1.19.3 驗證，1.19.4／1.19.5 則經原始碼審查。2.x 遷移格式已在 macOS 以官方 2.2.3 執行檔搭配合成資料驗證；原生 2.x 訊息片段使用依原始碼結構建立的合成資料測試，尚未執行模型對話驗證。遷移後的工作階段只列出一次，並使用 2.x 內容。系統通知、工具輸出與推理內容不會納入索引。較新或未審查版本仍標記為部分解析。即時狀態僅支援 CLI 1.x，尚未支援刪除 OpenCode 2.x 工作階段。不支援更早的 JSON 儲存格式或自訂資料庫名稱。
- Antigravity 只支援 CLI，不包含 Antigravity App 或 IDE。真實 CLI 1.3.5 歷史資料的相容性尚未驗證，未知或截斷的格式會顯示警告。
- 不包含這些 Agent 的桌面 App 或 IDE 外掛。

想支援其他 Agent？歡迎[提出功能需求](https://github.com/wellwind/SessionBay/issues/new?template=feature_request.yml)。
