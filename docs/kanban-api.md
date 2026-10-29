# Kanban catalog API

Issues #138–#141 provide catalog commands, the project board, task details/start
flow and the All boards overview. The UI consumes these commands through src/api.ts.

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

Schema version 8 adds optional auto-archive policy, worktree bindings and pending
launch associations. These tables also survive index rebuilds. Migrations are
local catalog changes; they never modify agent history.

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
- set_kanban_auto_archive(projectId, days?): null disables the policy; otherwise
  accept 1–36500 days. Board reads and reconciliation archive Done-stage cards
  whose task updatedAt is older than the threshold. Default: off. Restoring a task
  refreshes updatedAt, so it is not immediately archived again.
- bind_kanban_worktree(cardId, path): canonicalize and validate an existing linked
  worktree against the main curated project. A checkout cannot belong to two
  tasks. Session intake also recognizes cwd subdirectories of a bound checkout.

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

## Card details and start

Task details edit title/notes, resume individual sessions, split sessions, attach
explicitly selected project history and offer a keyboard-accessible merge target.
Pointer drops on the middle 40% of a card request a merge confirmation; its edges
retain ordering. The right-side task drawer retains explicit title/notes saving and discard
confirmation. The header contains Stage, task actions, then Close in DOM/tab order;
initial focus goes to the title. A single Save button after Notes saves both fields,
before the Sessions section. Save and start saves first and opens the existing launcher only
after a successful save. Its Stage selector provides a pointer alternative to
dragging; Position in the task actions menu also reorders without dragging. Done-stage tasks offer archive, delete with an explicit
Unsorted/detach choice, and recycling through one existing identity-checked
trash_session confirmation per visible session. No card action moves agent files
to the system trash. Archived tasks have a separate recoverable project view.

Start opens the existing New work launcher, with the task's bound worktree or
effective project folder. Agent/shell selection, launch preview, enablement,
permission settings and launch-local activity hooks remain owned by that flow.
An optional kanbanCardId travels with the launch request. Backend validation
checks the enabled project, archive state and canonical working directory.

A confirmed fresh agent launch records its runtime/card association and the
currently indexed source storage identity in the catalog, only when the provider\nhas one enabled source. Multiple sources require explicit history attachment. The broker retains
the first native providerSessionId received through its existing trusted
launch-local handshake. Reconciliation matches that identity plus source ID,
kind and storage root, preserving later explicit attachment/detachment choices,\nincluding when the transcript appears after the launch or
an index rebuild. It never selects the newest session merely by cwd/time.
Provider session rotations do not reassign subsequent conversations to the card.

Native terminal status alone does **not** establish a provider session identity.
In particular, reviewed native terminal-status routes (including recent Codex,
Grok and Antigravity), hooks-disabled launches and older brokers may not supply
the native handshake. Bound worktree intake still applies; otherwise the user
must select the session using **Attach from history** in task details. The
launcher explains this limitation. Plain shells have no indexed agent session.

Task text uses the file-input safety boundary: the connected, focused runtime
must enable bracketed paste; text goes through xterm and the bounded input queue
without an appended Enter. Terminal control bytes are removed. Typing first
cancels the pending insertion; reconnecting cannot replay a consumed paste.
While waiting, **Copy task text** provides an explicit clipboard fallback.
Pending text is never serialized into workspace.json. New worktree creation
reuses the existing Git worktree command, then binds its result in the catalog;
a failed binding retry does not recreate the checkout.

## Validation scope

Synthetic Rust tests cover commands, invalid/cross-project operations, ordering,
concurrent writers, migration from version 6, intake, parent relationships,
linked worktrees, recycle/restore, permanent removal and rebuild preservation.
TypeScript tests cover the explicit IPC command names/argument shapes. Project
board component tests cover translated rendering, filters, live activity, column
settings, accessible moves, task editing, merge/split, start/resume callbacks,
archive/restore, explicit history attachment and per-session recycling. Terminal
tests verify safe task paste and cancellation. Rust tests additionally cover
worktree bindings, launch/source identity and auto-archive/rebuild behavior. Synthetic browser fixtures cover project
navigation, pointer/keyboard moves and both-language layout audits. Browser checks
require a host that permits binding the Playwright development server ports.

## All boards overview

The shared ProjectBoard component reads list_kanban_boards() for the overview.
Only enabled boards belonging to curated projects are displayed, with archived
cards hidden. Columns are grouped by their stage into five fixed columns,
independent of project-specific names and ordering. Project identity uses the
existing palette and initials. Group by Project renders one swimlane per project
and shows its name once, with the same five stage columns. Project, text (title, notes and session titles),
agent and live needs-attention filters combine.

Overview moves resolve the card's owning board first, sort that board's columns
by position and select the first column for the target stage. The UI calls the
existing move_kanban_card command with that column's ID and the full destination
card count, including archived/filtered cards, to append the task. A missing stage
is ignored for pointer/keyboard moves and absent from the owning board’s drawer
column selector. There is no
cross-project destination or overview reorder command. Pointer drops over another
card change stage only; merging remains an explicit same-project details action
or a confirmed project-board drop. Shared details resolve the owning project for
history, start and worktree actions.

## Board activity and interaction

The Board activity is contributed through `createBoardActivity`; ActivityShell
continues to know only generic contribution IDs, labels, availability, badges,
shortcuts and panel renderers. Badge accessibility text uses a translated
`{{label}}: {{badge}}` template. Project availability and shortcut registration
remain the app owner's responsibility. Activity selection is retained in memory
per project and normal/Zen mode, not serialized into the workspace.

The app owns one `useKanbanBoards` instance for the current project and shares
it with the pinned Board tab and compact activity panel. The hook owns catalog
snapshots, live session identity/status matching, five-second polling, window
focus refresh, stale-read generations and the mutation lock. The All boards view
uses the same hook implementation with the list command. No IPC shapes change.

The compact panel groups active cards by column order, starts Done groups
collapsed, accepts whole-card pointer drops on collapsed headers, and offers
Todo quick-add. Alt+Up/Down reorders and Alt+Left/Right changes columns, using
catalog positions even when archived cards are hidden. Moves announce the same
translated message on both surfaces. Clicks open the shared accessible drawer.

The project toolbar combines search, a filter popover with removable chips,
needs-attention count, Board/Archived segmentation, overflow actions and New task.
The system Unsorted column is an inbox strip with Todo and Merge shortcuts.
Columns provide inline quick-add and Done columns initially show five cards.
Card drags use a four-pixel movement threshold and an explicit center-merge
preview. Drop/reorder animations last 180 ms and respect reduced motion.

Moves and manual archives offer one six-second Undo action. Undo reissues the
existing move command with the original column/position, or restores the archived
card; it is not a transaction history. Errors retain the board and allow retry.
Delete and merge retain confirmation and do not offer Undo. Board-local N and /
shortcuts ignore text fields, terminals and IME composition. Mod+Shift+K toggles
the Board activity through the regular configurable command/shortcut registry.

The drawer is 420 px wide at desktop sizes and full width below 1024 px. It reuses
Dialog's focus trap, Escape, IME handling and focus restoration with a transparent
backdrop. Worktree binding retries, delete disposition and identity-checked
per-session recycling retain their existing command paths and confirmations.

### Board scrolling

The board is constrained to the work area's height. Toolbar and compact inbox sit
above a shrinking grid; each column owns its vertical card scrolling. The inbox
has one header and a horizontal card row capped at 140 px overall. Project
swimlanes each use the available lane viewport and scroll their card lists
internally; the lane container scrolls between projects. The activity panel keeps
its header visible while its groups scroll.

Whole column bodies, empty hints and collapsed activity group headers remain drop
targets. The shared card drag hook auto-scrolls the innermost scrollable ancestor
on each axis within 48 px of a visible edge, with proportional speed. It
recalculates the drop target after scrolling without requiring another pointer
move. Drop, Escape, pointer cancellation/capture loss, blur, resize, data changes
and unmount stop the animation loop.
