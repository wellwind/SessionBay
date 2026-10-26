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

- **Claude Code**: the project folder name is a lossy encoding of the path, so the `cwd` recorded in the transcript wins. Subagent transcripts are linked to their parent session.
- **Codex**: archived sessions are indexed too. `history.jsonl` is input history, not a session list, and is ignored.
- **OpenCode**: SQLite schema v1 and v2 (OpenCode 1.19.x) are supported. The older JSON storage is not.
- **Grok Build**: only user and agent text is indexed; tool output and reasoning are not. Rewind markers remove the messages they undo.
- **Antigravity**: only the CLI is covered, not the Antigravity app or IDE.

Other agents (Gemini CLI, Aider, …) are not integrated yet. Adding one means adding an entry to `src/agent-manifest.json`, a Rust adapter, launch validation and contract tests.

## History sources

**Settings → Agents** always lists all five agents, whether or not they are installed.

- Each history source has its own ID. Two sources that resolve to the same folder for the same agent are rejected, and sessions from different sources are never merged.
- "Detect sources" proposes the known locations as a draft. Nothing is indexed until you save.
- Executable detection runs `--version` (`version` for Grok) with a timeout. Finding an executable does not prove you are logged in.

## Removing sessions

Deleting a session in Session Bay first hides it in the recycle bin; no files are touched. Moving a session to the system trash is a separate, reviewed step. See [Data safety](data-safety.md).
