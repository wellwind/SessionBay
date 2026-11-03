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
- OpenCode supports CLI 2.x only, with reviewed history and live-state versions 2.2.0–2.2.5. History reads only `session_v2`, `session_message` and `session_part`. If `session_v2` is missing, a non-fatal source message asks you to open the database once with OpenCode 2.x to migrate it; Session Bay never migrates or writes history. Migrated sessions retaining reviewed original 1.x versions remain fully readable. Migration was verified with the official 2.2.3 binary on macOS using synthetic data. Native 2.x parts and OSC 7501 live status are covered by synthetic tests and source review; a real 2.x live-status/model run remains unverified. System notices, tools and reasoning are omitted; later or unreviewed history versions remain partial. OSC 7501 exposes working, permission and question waits. Working-to-idle raises completion attention; failures are no longer reported. No Session Bay plugin, inline config injection or standalone/server handling is required. Terminal record IDs only become session identity after catalog confirmation of a 2.x session with matching directory and creation time after launch. Cleanup reviews and exports all descendants before recursive deletion. Restore supports only 2.x exports; 1.x exports and records without a major stay listed but cannot be restored, and their files are preserved. Older JSON storage and custom database names are unsupported.
- Antigravity support covers the CLI only, not the Antigravity app or IDE. Compatibility with real CLI 1.3.5 history remains unverified; unknown or truncated formats show a warning.
- Desktop apps and IDE plugins of these agents are not covered.

Want another agent? [Open a feature request](https://github.com/wellwind/SessionBay/issues/new?template=feature_request.yml).

Claude Code live status requires **2.1.295 or later** and uses opt-in OSC 7501. Only a SessionStart identity hook remains; the state mod and waiting/permission hooks are removed. Older Claude versions show process state only with a clear notice. Claude Code 2.1.316's startup capability query and exit clear were verified offline; normal working/waiting/completion/error states remain unverified in a real session. All terminal status is display-only and never authorizes actions. Codex, Grok and Antigravity behavior, including the Codex app-server observer, is unchanged.
