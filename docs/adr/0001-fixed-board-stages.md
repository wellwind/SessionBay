# 0001: Boards have four fixed stages and suggest unfiled sessions

Status: accepted

## Context

Boards in 0.3 and 0.4 let each project add, delete, reorder and re-stage columns. Every column also carried a stage so that **All boards** could group cards. Users had to learn two concepts (columns and stages), and moves in All boards went to "the first column of that stage in the owning project". That rule was documented but surprising.

Every new session in an enabled project also became an **Unsorted** card. Keeping the board useful meant triaging each one into Todo or merging it into a task. The merge appended the session title to the target's notes.

Planned MCP or skill access for agents (#169) is also simpler when a board has a known, small set of states.

## Decision

- Every board has exactly one column per stage: Unsorted, Todo, In progress, Review, Done, in that order. Columns can be renamed, nothing else.
- The create, delete, set-stage and reorder column commands are removed.
- Opening the catalog folds legacy boards onto this shape without a schema change, as described in [kanban-api.md](../kanban-api.md).
- Unsorted is shown as suggestions above the columns, not as a column. Filing a suggestion attaches its sessions to an existing task, or turns it into a Todo task. Dismissing detaches it and records the exclusion. Merging is no longer used for filing.
- Starting work on a Todo task moves it to In progress. This is the only automatic stage change, and it follows an explicit user action.

## Consequences

- Project boards and All boards render the same columns, so one component serves both, behind a scope switch.
- Custom column names and the extra split they provided are lost when legacy boards are folded. Their cards are kept, in order. Tags or labels may restore finer grouping later.
- Older 0.3/0.4 builds can still open the catalog, because the schema version is unchanged. They will see the folded columns.
- Intake semantics are unchanged in the catalog: new sessions still enter the Unsorted column. Only the presentation and the filing actions changed.
