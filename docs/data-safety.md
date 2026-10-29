# Data safety

## What Session Bay reads and writes

- **Agent history is read-only.** Adapters only open history files and databases for reading. OpenCode's SQLite database is copied and validated before it is read.
- **Session Bay's own data** lives in the app data directory (`~/Library/Application Support/dev.fullstackladder.sessionbay` on macOS, `~/.local/share/dev.fullstackladder.sessionbay` on Linux):
  - `catalog.sqlite`, indexed conversations and Session Bay's own project, board, task, note, session-link and recycle-bin data;
  - `settings.json`;
  - `workspace.json`, the open tabs and layout.

  The directory is `0700` and the files are `0600`. The index contains conversation text, so treat it as private.
- **Local history processing.** Indexing, search and preview never contact a model provider or any server. Git operations contact your configured remotes, and pull requests use the GitHub or GitLab hosts you add. Agents you launch still use the network according to their own settings.
- **Update checks** fetch the public release list from `api.github.com` at startup and once a day, without any identifying data beyond the app version in the User-Agent. They can be turned off in Settings, and nothing is ever installed automatically.
- Transcripts are rendered as plain text, so HTML never runs and remote images are never fetched. The OSC 52 clipboard escape sequence is blocked in terminals.
- Settings are stored in plain text. Do not put passwords or API keys in custom arguments or environment variables.

## Boards and catalog upgrades

Boards, columns, tasks, notes, session links, worktree bindings and auto-archive settings are stored only in the catalog. Index rebuilds preserve them; deleting the catalog loses them. Board operations never rewrite agent history or project files. Creating a worktree from a task uses the existing Git worktree operation. Starting work inserts task text into the terminal without sending it; the user reviews it before pressing Enter.

Recycling an attached session hides it from its task while keeping the association for restore. A confirmed missing session or a move to the system trash removes its link but keeps the task. Deleting or archiving a task does not delete agent history.

0.3.0 migrates the local catalog to schema v8. After that upgrade, 0.2.0 cannot open it. This migration never modifies agent history.

## Development profile

Development uses the separate `dev.fullstackladder.sessionbay.dev` folder and broker. Its first launch, and the confirmed **Import from Session Bay** action in Settings, read only production settings and curated project metadata. Index rows, boards, workspace layout, recycle bin and Git host tokens are not imported. Production is never modified; the previous app identity is not migrated.

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
