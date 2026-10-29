# Kanban catalog API

Issue #138 provides storage and commands. The project board (#139) consumes these
commands through src/api.ts. Card details/start flow, worktree-to-card bindings,
auto-archive policy and All boards UI follow in #140–#141.

## Ownership and migration

Schema version 7 adds boards, ordered columns, ordered cards, session links,
session observation/exclusion metadata and pending resume requests to the local
SQLite catalog. No project folder, agent history or agent configuration is
modified. Session links reference
cards, but deliberately do not reference the rebuildable sessions or sources
tables. Clearing/rebuilding the index preserves tasks, column settings, archived
state, session associations and explicit exclusions. Reads join links to current
source storage identities so replacing a source root cannot reveal unrelated
history under a reused source ID.

Only curated projects can enable a board. Disabling preserves all its data and
stops intake and edits. Re-enabling does not backfill sessions from the disabled
period. Removing a project from the curated list hides its board from the
overview and suspends mutations/intake; re-adding the project restores access.

A new board has Unsorted, Todo, In progress, Review and Done columns. A null column
name uses its stable defaultName translation key in the current interface
language. Renaming stores a literal name. Unsorted and Done are system roles:
they can be renamed/reordered, but cannot be deleted or assigned another stage.
Other columns default to doing and can use any stage.

## Commands and read models

Public Catalog methods in src-tauri/src/kanban.rs are independent of Tauri, so a
future MCP adapter can call the same commands. Each mutation uses an immediate
SQLite transaction: validation and all dependent moves commit or roll back
together. Tauri exposes separate snake_case endpoints; src/api.ts supplies typed
camelCase wrappers.

- kanban_board(projectId): nullable board, including archived cards.
- list_kanban_boards(): enabled boards belonging to curated projects.
- set_kanban_board_enabled(projectId, enabled): preserves existing content.
- create_kanban_column(projectId, name, stage?): append a column.
- rename_kanban_column(columnId, name).
- set_kanban_column_stage(columnId, stage).
- reorder_kanban_columns(projectId, columnIds): every column exactly once.
- delete_kanban_column(columnId, targetColumnId): append all cards, including
  archived cards, to the chosen column before removing the source.
- create_kanban_card(columnId, title, notes): append an empty task.
- edit_kanban_card(cardId, title, notes).
- move_kanban_card(cardId, columnId, position): zero-based insertion index in the
  destination after excluding the moving card. Archived cards share this order.
- archive_kanban_card(cardId, archived): archive or restore without changing sessions.
- delete_kanban_card(cardId, sessions): unsorted returns sessions to new Unsorted
  cards, grouping attached parent/child families together; detach leaves them off
  the board. Neither modifies history.
- attach_kanban_session(cardId, sessionId): reassign within the owning project.
- detach_kanban_session(cardId, sessionId): preserve the empty task and remember
  the explicit exclusion across scans/rebuilds.
- merge_kanban_cards(sourceCardId, targetCardId): move all links (including hidden
  recycled sessions), retain the target title unless empty, append the source
  title/notes to target notes, then remove the source task.
- split_kanban_session(cardId, sessionId): create a card immediately after its
  source, using the session title; automatic descendants follow their parent.
- add_kanban_session(sessionId): manually include indexed older history; idempotent
  when already attached.
- kanban_session_card(sessionId): resolve the current task for a running session.

Stage values are unsorted, todo, doing, review and done. Projects cannot be changed
by card moves, column deletion, merge or attachment. Titles may be empty for
planning; render an empty title as translated Untitled task. The first attached
session fills an empty title. User names are limited to 500 characters without
control characters; notes allow Markdown/plain text up to 1 MiB.

Board snapshots contain current Session objects and optional worktree branch
metadata. Live activity remains owned by the existing activity/runtime services;
consumers combine those signals by session identity rather than persisting
transient status on cards. Archived cards are included for a recoverable archived
view. Recycled sessions are omitted, while their association remains intact and
reappears upon restore. No automatic stage movement occurs.

## Intake and lifecycle

After reconciliation, previously unobserved sessions in enabled projects enter
Unsorted. The earliest indexed event timestamp prevents imported older history
from entering as new. Sources without event timestamps fall back to first
observation, because their creation time cannot be established reliably. Existing
history is recorded as observed before enabling a board. Successful indexed
resumes explicitly request intake; manual provider IDs can queue a request before
their transcript is indexed. Observed older history with fresh event activity
also enters the board as resumed work, except for explicitly detached sessions.
Launch preview does not mutate the board.

Children use the nearest attached ancestor's board even without cwd. New child
sessions join their parent's task regardless of discovery order. Automatic child
links follow explicit parent attachment and splitting; explicit child
attachments/exclusions remain user choices. Git read commands resolve linked
worktrees to their main checkout's project and record the branch at attachment.
Historical session cwd/project identity remains unchanged.

Recycle-bin visibility uses the current source storage identity. Permanent
system-trash moves or confirmed missing sessions detach links and leave empty
tasks. Missing or unreadable source roots retain associations until a successful
scan can confirm absence. Confirmed source removal/replacement detaches its
links. Index clear itself never detaches.

## Validation scope

Synthetic Rust tests cover commands, invalid/cross-project operations, ordering,
concurrent writers, migration from version 6, intake, parent relationships,
linked worktrees, recycle/restore, permanent removal and rebuild preservation.
TypeScript tests cover the explicit IPC command names/argument shapes. Project
board component tests cover translated rendering, filters, live activity, column
settings and accessible moves. Synthetic browser fixtures cover project
navigation, pointer/keyboard moves and both-language layout audits. Browser checks
require a host that permits binding the Playwright development server ports.
