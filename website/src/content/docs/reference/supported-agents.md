---
title: Supported agents
description: Which agents Session Bay supports, where their history is read from and how sessions are resumed.
---

| Agent | Executable | History is read from | Resume |
| --- | --- | --- | --- |
| Claude Code | `claude` | `~/.claude` (or `$CLAUDE_CONFIG_DIR`) | `claude --resume <id>` |
| Codex CLI | `codex` | `~/.codex` (or `$CODEX_HOME`) | `codex resume <id>` |
| OpenCode | `opencode` | `~/.local/share/opencode` | `opencode --session <id>` |
| Grok Build | `grok` | `~/.grok` (or `$GROK_HOME`) | `grok --resume <id>` |
| Antigravity CLI | `agy` | `~/.gemini/antigravity-cli` | `agy --conversation <id>` |

- History formats are internal to each agent and can change between versions. When a format is not recognized, those sessions show as partially parsed instead of failing the whole index.
- OpenCode 1.19.x databases are supported; the older JSON storage is not.
- Antigravity support covers the CLI only, not the Antigravity app or IDE.
- Desktop apps and IDE plugins of these agents are not covered.

Want another agent? [Open a feature request](https://github.com/wellwind/SessionBay/issues/new?template=feature_request.yml).
