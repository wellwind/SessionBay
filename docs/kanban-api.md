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

0.3.0 opens catalogs at schema v8; 0.2.0 cannot open them after the upgrade.

Only curated projects can enable a board. Disabling preserves all its data and
stops intake and edits. Re-enabling does not backfill sessions from the disabled
period. Removing a project from the curated list hides its board from the
overview and suspends mutations/intake; re-adding the project restores access.

Every board has exactly one column per stage, in the fixed order Unsorted, Todo,
In progress, Review and Done (see [ADR 0001](adr/0001-fixed-board-stages.md)). A
null column name uses its stable defaultName translation key in the current
interface language. Renaming stores a literal name; it is the only column edit.
Unsorted holds intake and is shown as suggestions rather than a column.

Opening the catalog folds boards with extra columns onto this shape in one
transaction: for each stage the system column survives, then the default column,
then the earliest custom one. Cards from the other columns are appended in their
previous order without touching updatedAt, a missing stage gets a default column,
and positions follow stage order. Canonical boards are not written, so opening
does not bump the catalog revision. Custom column names are not preserved. The
schema version is unchanged, so 0.3/0.4 builds can still open the catalog.

## Commands and read models

Public Catalog methods in src-tauri/src/kanban.rs are independent of Tauri, so a
future MCP adapter can call the same commands. Each mutation uses an immediate
SQLite transaction: validation and all dependent moves commit or roll back
together. Tauri exposes separate snake_case endpoints; src/api.ts supplies typed
camelCase wrappers.

- kanban_board(projectId): nullable board, including archived cards.
- list_kanban_boards(): enabled boards belonging to curated projects.
- set_kanban_board_enabled(projectId, enabled): preserves existing content.
- rename_kanban_column(columnId, name).
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

The right-side task drawer edits title and notes, resumes individual sessions,
splits sessions, attaches explicitly selected project history (filterable, up
to 100 recent sessions) and offers a keyboard-accessible merge target. Title and
notes save automatically 600 ms after the last edit through edit_kanban_card,
outside the board-wide mutation lock so typing never disables controls. Saves are
serialized; closing the drawer, continuing or starting flushes a pending save
first and stays open with a retry when it fails. There is no Save button and no
discard prompt. The header contains Stage, task actions, then Close in DOM/tab
order; initial focus goes to the title.

The primary action is **Continue with <agent>** (resume the latest attached
session) when that session can resume, with **Start a new session** in its menu;
otherwise it is **Start work**. Starting a task in Todo or Unsorted first moves it
to In progress through move_kanban_card, with Undo. This user-initiated move is the
only automatic stage change. Done-stage tasks offer archive, delete with an
explicit suggest-again/detach choice, and recycling through one identity-checked
trash_session confirmation per visible session. No card action moves agent files
to the system trash. Pointer drops never merge; merging is a confirmed
same-project action from the task menu.

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

The shared ProjectBoard component renders a single project or every enabled board
of a curated project (list_kanban_boards()) with the same four stage columns. A
scope menu switches between all projects and one project's board; the app owns
that navigation. Archived cards are hidden outside the archived view. Project
identity uses the existing palette and initials. Group by Project renders one
swimlane per project. Text (title, notes and session titles), agent and live
needs-attention filters combine and also apply to suggestions.

Moves resolve the card's owning board and its single column for the target stage,
and call move_kanban_card with a position from that column's full catalog order,
including archived and filtered cards. Dropping on another project's card changes
only the stage and appends. There is no cross-project move. Shared details resolve
the owning project for history, start and worktree actions; New task asks for the
project.

## Board interaction

Unsorted cards render as a collapsible suggestions list above the columns. **Add
to task…** attaches each session to the chosen task with attach_kanban_session,
then deletes the empty source card with the detach disposition, so the target
keeps its title and notes. **Make it a task** moves the card to Todo. **Dismiss**
deletes it with detach, which records the exclusion; **Dismiss all** confirms
first. Rows fold out over 180 ms before the catalog change.

Cards show agent icons, the last update and, only for working, input or error
states, a live status chip. Needs attention appears in the toolbar only while a
task needs input or reports an error. Done columns initially show five cards and
link to the archived view. Columns provide inline quick-add.

Alt+Up/Down reorders and Alt+Left/Right changes stage, using catalog positions
even when archived cards are hidden. Card drags use a four-pixel movement
threshold. Moves and manual archives offer one six-second Undo that reissues the
original move or restores the archived card; it is not a transaction history.
Errors retain the board and allow retry. Board-local N and / shortcuts ignore text
fields, terminals and IME composition.

Motion follows Animate UI's timing tokens in CSS: cards and focus rows enter with
`@starting-style` on ease-out (220 ms), reorders use a 220 ms FLIP on the same
curve, press feedback scales cards to 0.985, the drawer slides in on the soft
ease-out (360 ms) and the Undo toast lands with a slight overshoot. Insertion lines
use box-shadow so drops never shift layout. Under reduced motion transforms are
removed and only fades remain.

## Focus panel

The Focus activity is contributed through `createBoardActivity`; ActivityShell
continues to know only generic contribution IDs, labels, availability, badges,
shortcuts and panel renderers. It lists Needs you (tasks with an input, permission
or error session), In progress (In progress stage, or a working session), and the
first three Todo tasks with Start, plus Todo quick-add and a link to pending
suggestions. Go to terminal focuses the pane already showing the session through
the app; otherwise it resumes. A start that resolves after the project changed is
dropped. The badge counts active tasks that need attention. Mod+Shift+K toggles
the panel through the regular command/shortcut registry. The full board opens from
the panel's Open board button or the Open board palette command; the project tab
bar has no Board entry, so the tab strip keeps its full width.

The app owns one `useKanbanBoards` instance for the current project and shares it
with the board and the Focus panel. The hook owns catalog snapshots, live session
identity/status matching, five-second polling, window focus refresh, stale-read
generations, the mutation lock and the autosave path.

The drawer is 440 px wide at desktop sizes and full width below 1024 px. It reuses
Dialog's focus trap, Escape, IME handling and focus restoration with a transparent
backdrop.

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
