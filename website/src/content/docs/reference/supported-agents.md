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
- OpenCode history reading supports CLI 1.x through 1.19.5 and CLI 2.2.x through 2.2.5. The v1 format was verified on Linux with CLI 1.19.2/1.19.3; 1.19.4/1.19.5 were reviewed from source. The 2.x migration was verified with the official 2.2.3 binary on macOS using synthetic data; native 2.x message parts are tested against source-shaped synthetic rows, without a model run. Migrated sessions appear once, using the 2.x content. System notices, tool output and reasoning are omitted. Later or unreviewed versions remain partial. Live state supports stable CLI 1.x from 1.19.2 and reviewed 2.2.0–2.2.5 through separate launch-local plugins; the 2.x API is source-checked against 2.2.3 and covered by synthetic contracts, while a real 2.x live-state/model run remains unverified. The 2.x native events expose permissions and execution failure/interruption, but no question waiting events. Cleanup on 2.x reviews and exports all descendants before recursive deletion. Restore requires the exporting CLI major version; formats are never converted. The older JSON storage and custom database names are not supported.
- Antigravity support covers the CLI only, not the Antigravity app or IDE. Compatibility with real CLI 1.3.5 history remains unverified; unknown or truncated formats show a warning.
- Desktop apps and IDE plugins of these agents are not covered.

Want another agent? [Open a feature request](https://github.com/wellwind/SessionBay/issues/new?template=feature_request.yml).
