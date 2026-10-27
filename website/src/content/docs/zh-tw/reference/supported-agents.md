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
- 支援 OpenCode 1.19.x 的資料庫，不支援更早的 JSON 儲存格式。
- Antigravity 只支援 CLI，不包含 Antigravity App 或 IDE。
- 不包含這些 Agent 的桌面 App 或 IDE 外掛。

想支援其他 Agent？歡迎[提出功能需求](https://github.com/wellwind/SessionBay/issues/new?template=feature_request.yml)。
