# Agent integrations

Session Bay reads each agent's local history **read-only** and resumes sessions by launching the agent's own CLI. Agents keep their own login, network and permission settings.

The storage formats below are implementation details of each agent, not stable public APIs. Adapters tolerate unknown events and missing fields; when a format changes, the affected sessions show as partial instead of failing the whole index.

| Agent | Executable | Default history root | Resume |
| --- | --- | --- | --- |
| Claude Code | `claude` | `$CLAUDE_CONFIG_DIR` or `~/.claude` (`projects/<project>/<id>.jsonl`) | `claude --resume <id>` |
| Codex CLI | `codex` | `$CODEX_HOME` or `~/.codex` (`sessions/`, `archived_sessions/`) | `codex resume <id>` |
| OpenCode | `opencode` | `~/.local/share/opencode` (`opencode.db`, opened read-only) | `opencode --session <id>` |
| Grok Build | `grok` | `$GROK_HOME` or `~/.grok` (`sessions/<cwd>/<id>/`) | `grok --resume <id>` |
| Antigravity CLI | `agy` | `~/.gemini/antigravity-cli` | `agy --conversation <id>` |

Notes:

- **Claude Code**: the project folder name is a lossy encoding of the path, so the `cwd` recorded in the transcript wins. Subagent transcripts are linked to their parent session. Custom titles take priority over Claude's generated titles; the first meaningful prompt is a fallback. Current title and harness events are recognized rather than marking the session partially parsed. Live status now uses OSC 7501; see the verification limits below.
- **Codex**: archived sessions are indexed too. `history.jsonl` is input history, not a session list, and is ignored.
- **OpenCode**: supports CLI 2.x only, with reviewed history versions 2.2.0–2.2.5. Only `session_v2`, `session_message` and `session_part` are read. A database without `session_v2` shows a non-fatal source message asking you to open it once with OpenCode 2.x, which migrates 1.x sessions; Session Bay never migrates or writes it. Migrated rows retaining reviewed 1.x producer versions remain fully readable from the 2.x tables. A synthetic database migrated by the official 2.2.3 binary on macOS verifies the migration format. Native 2.x parts use source-shaped synthetic tests, not a model run. Later or unreviewed versions stay metadata-only and partial. Older JSON storage and custom database names are not supported.
- **Grok Build**: only user and agent text is indexed; tool output and reasoning are not. Rewind markers remove the messages they undo.
- **Antigravity**: only the CLI is covered, not the Antigravity app or IDE. Real CLI 1.3.5 history compatibility remains unverified.

Other agents (Gemini CLI, Aider, …) are not integrated yet. Adding one means adding an entry to `src/agent-manifest.json`, a Rust adapter, launch validation and contract tests.

## History sources

**Settings → Sources and tools** always lists all five agents, whether or not they are installed.

- Each history source has its own ID. Two sources that resolve to the same folder for the same agent are rejected, and sessions from different sources are never merged.
- **Detect history sources** proposes the known locations as a draft. Nothing is indexed until you save.
- Executable detection runs `--version` (`version` for Grok) with a timeout. Finding an executable does not prove you are logged in.
- On macOS, executable lookup checks `PATH`, common user install locations and nvm, fnm, volta, mise, asdf and bun directories. **Detect again** refreshes the result; an absolute executable path can override lookup.

## Removing sessions

Deleting a session in Session Bay first hides it in the recycle bin; no files are touched. Moving a session to the system trash is a separate, reviewed step. See [Data safety](data-safety.md).


## OpenCode 2.x reading contract

- The reader opens only a private, owner-only mirror of `opencode.db` and its WAL. It never opens the agent database through SQLite, migrates it, or writes agent history. Existing snapshot validation, cancellation and per-session limits apply to 2.x history.
- Only `session_v2` supplies session metadata. Retained `session`, `message` and `part` tables, and the old 1.x `session_message` projection, are never read. Migrated sessions retain their original producer version; reviewed 1.x versions are accepted only as content already migrated into `session_v2`. IDs present only in the retained 1.x tables are omitted.
- Messages come from `session_message` in sequence order. Assistant `session_part` rows, when present for that message, replace inline content in ordinal order; messages without parts keep their inline content. Only user and assistant text is indexed. System notices, tools, reasoning and compaction content are omitted. A NULL title uses Session Bay's existing untitled-session fallback. Active reverts remain metadata-only and partial.
- `READER_REVISION` is **6**, forcing existing catalog entries to be re-read even when the database is unchanged.
- **Live status uses OSC 7501 only for reviewed CLI 2.2.0–2.2.5**, under the existing per-agent opt-in. The broker answers the capability query for these launches. Other versions show process state only, with a clear status-version message. No Session Bay state plugin/package is installed, no `OPENCODE_CONFIG_CONTENT` is injected, and native `--standalone`/`--server` arguments are left untouched.
- Official 2.2.3 `packages/tui/src/context/program-status.ts` and `session-tabs.tsx` emit a root summary and pending-session records: working, blocked/permission, blocked/question, and idle when nothing is pending. They never emit done/error. A working-to-idle transition raises completion attention; initial idle stays quiet. OpenCode gains question waits and no longer reports failures in Session Bay.
- An OSC record ID is an unauthenticated hint, never direct session identity. The service accepts it as provider_session_id only after the catalog confirms one OpenCode 2.x session with that ID, matching canonical cwd, and creation time strictly after launch start. Multiple matching pending sessions or duplicate source identities remain unbound. The indexed reader retains producer version and creation time; reader revision **6** refreshes older metadata. Status itself stays display-only and never authorizes an action.
- **Cleanup requires a 2.x CLI.** It uses `session export`, recursively enumerates and reviews every descendant from the validated read-only mirror, verifies every export, and then calls `session delete` once for the selected root. Restore uses `session import --directory <original cwd>`. Export records carry their producing CLI major; 1.x exports and older records without a major remain listed but cannot be restored. Their files are preserved without movement, conversion or rewriting. See [data safety](data-safety.md).
- **Verification limits:** synthetic Rust tests cover version gates, broker negotiation, native launch preservation, catalog identity correlation, cleanup and restore. OSC emission was reviewed in official v2.2.3 source. A real CLI 2.x end-to-end live-status/model run remains unverified; acceptance of 2.2.0–2.2.5 is a reviewed compatibility gate, not binary testing on every patch or platform.

The storage contract was reviewed against the official v1.19.5 and v2.2.3 sources: `packages/core/src/session/sql.ts`, `session/history.ts`, `session/projector.ts`, `database/migration/`, `database/v1-migration.bun.ts`, and `packages/schema/src/session-message.ts`. See [fixture provenance](../fixtures/opencode/README.md).


## Claude Code live status and identity

Claude Code >= 2.1.295 uses opt-in OSC 7501, with the same broker capability reply as Codex/Grok/Antigravity. Below that minimum, launches show process state only with a clear notice. The state mod and waiting/permission hooks are removed. A launch-local SessionStart command hook supplies only native session identity for Kanban auto-attach and resume/running-session checks; it does not replace or publish terminal status. No user/global configuration is edited.

Terminal working-to-idle raises completion attention once per transition in the same runtime/generation. Initial idle stays quiet; explicit done/error keep their existing behavior. All OSC status is terminal-reported, display-only, and cannot authorize actions. Claude Code 2.1.316 was observed sending the capability query at startup and clear on exit in an isolated PTY with networking blocked. Its normal idle/working/done/error and blocked permission/question/auth behavior has not been verified in a real session; those states are not claimed as observed binary behavior.
