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
- 支援 OpenCode 資料庫 schema v1 與 v2，已在 Linux 以 CLI 1.19.2 與 1.19.3 驗證。CLI 1.19.4 與 1.19.5 經原始碼審查確認未變更資料庫，因此也支援。尚未支援 CLI 2.x。不支援更早的 JSON 儲存格式或自訂資料庫名稱。
- Antigravity 只支援 CLI，不包含 Antigravity App 或 IDE。真實 CLI 1.3.5 歷史資料的相容性尚未驗證，未知或截斷的格式會顯示警告。
- 不包含這些 Agent 的桌面 App 或 IDE 外掛。

想支援其他 Agent？歡迎[提出功能需求](https://github.com/wellwind/SessionBay/issues/new?template=feature_request.yml)。
