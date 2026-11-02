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
- OpenCode supports CLI 2.x only, with reviewed history and live-state versions 2.2.0–2.2.5. History reads only `session_v2`, `session_message` and `session_part`. If `session_v2` is missing, a non-fatal source message asks you to open the database once with OpenCode 2.x to migrate it; Session Bay never migrates or writes history. Migrated sessions retaining reviewed original 1.x versions remain fully readable. Migration was verified with the official 2.2.3 binary on macOS using synthetic data. Native 2.x parts and the unchanged 2.x live-state plugin are covered by synthetic contracts and source review; a real 2.x live-state/model run remains unverified. System notices, tools and reasoning are omitted; later or unreviewed history versions remain partial. The 2.x plugin exposes permissions and execution failure/interruption, but no question waiting events. Cleanup reviews and exports all descendants before recursive deletion. Restore supports only 2.x exports; 1.x exports and records without a major stay listed but cannot be restored, and their files are preserved. Older JSON storage and custom database names are unsupported.
- Antigravity support covers the CLI only, not the Antigravity app or IDE. Compatibility with real CLI 1.3.5 history remains unverified; unknown or truncated formats show a warning.
- Desktop apps and IDE plugins of these agents are not covered.

Want another agent? [Open a feature request](https://github.com/wellwind/SessionBay/issues/new?template=feature_request.yml).
