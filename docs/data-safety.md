# Data safety

## What Session Bay reads and writes

- **Agent history is read-only.** Adapters only open history files and databases for reading. OpenCode's SQLite database is copied and validated before it is read.
- **Session Bay's own data** lives in the app data directory (`~/Library/Application Support/dev.sessionbay.desktop` on macOS, `~/.local/share/dev.sessionbay.desktop` on Linux):
  - `catalog.sqlite`, the search index;
  - `settings.json`;
  - `workspace.json`, the open tabs and layout.

  The directory is `0700` and the files are `0600`. The index contains conversation text, so treat it as private.
- **Nothing leaves your machine.** Indexing, search and preview never contact a model provider or any server. Agents you launch still use the network according to their own settings.
- **Update checks** fetch the public release list from `api.github.com` at startup and once a day, without any identifying data beyond the app version in the User-Agent. They can be turned off in Settings, and nothing is ever installed automatically.
- Transcripts are rendered as plain text, so HTML never runs and remote images are never fetched. The OSC 52 clipboard escape sequence is blocked in terminals.
- Settings are stored in plain text. Do not put passwords or API keys in custom arguments or environment variables.

## Deleting sessions

Deleting a session is a two-step process.

### 1. Recycle bin

**Delete** hides the session in Session Bay's recycle bin. No agent files change, and you can undo it at any time.

### 2. Move to system trash

From the delete dialog or the recycle bin, **Move to system trash…** opens a review of exactly what will move:

- every file and folder that belongs to the session;
- shared storage that will be left untouched;
- any reason the move is blocked.

You confirm the list, and Session Bay then re-checks every item right before moving it. If anything changed since the review (size, item count or modification time), nothing is moved.

| Agent | Moved to trash | Left untouched (shared) |
| --- | --- | --- |
| Claude Code | `projects/<project>/<id>.jsonl` and its folder (subagents), `session-env/<id>`, `file-history/<id>`, `debug/<id>.txt`, `todos/<id>-*.json` | `history.jsonl` |
| Codex | the rollout file, `browser/sessions/<id>.toml`, `tui-thread-reference-capabilities/<id>` | `state_*.sqlite`, `thread_history_*.sqlite`, `history.jsonl`, `session_index.jsonl` |
| Grok Build | `sessions/<cwd>/<id>/` | `prompt_history.jsonl`, `session_search.sqlite`, `active_sessions.json` |
| Antigravity CLI | `brain/<id>/`, `conversations/<id>.db*`, `annotations/<id>.pbtxt` | `conversation_summaries.db` |
| OpenCode | a JSON export made with `opencode export <id>`; the session itself is removed with `opencode session delete <id>` | the rest of `opencode.db` |

Shared storage (input history, summaries, search indexes) may still mention the session.

**OpenCode.** Session Bay never writes OpenCode's database. It runs the official CLI instead:

1. It exports the session and verifies that the export's ID matches.
2. Only then does it delete the session.
3. Restoring the session runs `opencode import` in the original working directory.

**Blocked when:**

- the session is running in Session Bay;
- any of its files was written in the last two minutes, or an Antigravity presence lock is held;
- a path is a link or leaves the history root;
- the ID contains anything other than `[A-Za-z0-9._-]`.

These checks reduce the risk but cannot rule out another program writing after the check.

### Restoring

The system trash names items by session ID, so they are hard to recognize there. Session Bay keeps a record of every move: title, agent, original path and trash location.

- **Recycle bin → Moved to system trash** lists those records.
- **Restore** moves items back to their original paths. It never overwrites an existing file.
- Once the system trash is emptied, the files are gone for good.

On macOS, Finder's **Put Back** is not guaranteed to work for these items; use **Restore** in Session Bay instead.

## Reporting a security issue

See [SECURITY.md](../SECURITY.md).
