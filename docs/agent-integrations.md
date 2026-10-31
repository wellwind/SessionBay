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

- **Claude Code**: the project folder name is a lossy encoding of the path, so the `cwd` recorded in the transcript wins. Subagent transcripts are linked to their parent session. Custom titles take priority over Claude's generated titles; the first meaningful prompt is a fallback. Current title and harness events are recognized rather than marking the session partially parsed. Activity reporting recovers at the next main turn after a lost report.
- **Codex**: archived sessions are indexed too. `history.jsonl` is input history, not a session list, and is ignored.
- **OpenCode**: reads CLI 1.x sessions through 1.19.5 and CLI 2.2.x sessions through 2.2.5. Linux CLI 1.19.2/1.19.3 runs verified the v1 format; 1.19.4/1.19.5 are accepted after source review. A synthetic database migrated by the official 2.2.3 binary on macOS verifies the 2.x migration format. Native 2.x `session_part` rows are covered by source-shaped synthetic tests, not a model run. Later or unreviewed versions stay metadata-only and partial. The older JSON storage and custom database names are not supported.
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


## OpenCode 1.x and 2.x reading contract

- The reader opens only a private, owner-only mirror of `opencode.db` and its WAL. It never opens the agent database through SQLite, migrates it, or writes agent history. Existing snapshot validation, cancellation and per-session limits apply to both generations.
- CLI 2.x stores sessions in `session_v2`. When an ID also exists in the retained v1 `session` table, `session_v2` wins for metadata and messages, including an empty transcript. IDs present only in `session` keep the existing v1 reading behavior. Migrated sessions retain their original 1.x version and use the same reviewed 1.x version gate.
- Messages come from `session_message` in sequence order. Assistant `session_part` rows, when present for that message, replace inline content in ordinal order; messages without parts keep their inline content. Only user and assistant text is indexed. System notices, tools, reasoning and compaction content are omitted. A NULL title uses Session Bay's existing untitled-session fallback. Active reverts remain metadata-only and partial.
- `READER_REVISION` is **4** (revision 3 accepted CLI 1.19.4/1.19.5). This forces existing catalog entries to be re-read even when the database is unchanged.
- **Live state remains limited to CLI 1.x.** Source review of v2.2.3 confirms that `packages/core/src/plugin/module.ts` requires a default `{ id, setup }` or `{ id, effect }` definition. `packages/plugin/src/promise/plugin.ts` and `promise/event.ts` expose a context and `event.subscribe`; events use `data` (`packages/schema/src/session-event.ts`), rather than the v1 hook factory, `chat.message` and `{ type, properties }` callbacks used by Session Bay. The existing live-state version gate therefore rejects 2.x before staging the v1 plugin. A separate v2 plugin integration and an end-to-end CLI 2.x live-state run remain unverified; history reading does not widen that gate.
- **Deleting OpenCode 2.x sessions is not supported yet.** This change does not alter export/import, system-trash or restore behavior. CLI 2.x moved export/import under `opencode session` and changed the export format; those operations require separate work (#166).

The storage contract was reviewed against the official v1.19.5 and v2.2.3 sources: `packages/core/src/session/sql.ts`, `session/history.ts`, `session/projector.ts`, `database/migration/`, `database/v1-migration.bun.ts`, and `packages/schema/src/session-message.ts`. See [fixture provenance](../fixtures/opencode/README.md).
