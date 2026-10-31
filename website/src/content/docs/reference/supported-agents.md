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
- OpenCode database schemas v1 and v2 are supported, verified on Linux with CLI 1.19.2 and 1.19.3. CLI 1.19.4 and 1.19.5 are accepted after a source review, because they change no database files. CLI 2.x is not supported yet. The older JSON storage and custom database names are not supported.
- Antigravity support covers the CLI only, not the Antigravity app or IDE. Compatibility with real CLI 1.3.5 history remains unverified; unknown or truncated formats show a warning.
- Desktop apps and IDE plugins of these agents are not covered.

Want another agent? [Open a feature request](https://github.com/wellwind/SessionBay/issues/new?template=feature_request.yml).
