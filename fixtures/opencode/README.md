# OpenCode synthetic fixtures

These are not CLI captures. Tests build SQLite databases (and WAL files) from `schema.sql` in a temporary directory. All text, IDs, paths and timestamps are synthetic. OpenCode was never run against real data or logins to produce them.

The schema follows OpenCode release v1.19.2 (commit `7901b7d325c34852caa84fc2c325f3a08dd7a473`). Only the columns the reader uses are kept:

- [SQLite tables](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/session/sql.ts): `session`, `message`, `part`, `session_message`.
- [v1 message types](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/schema/src/v1/session.ts) and [v2 event types](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/schema/src/session-message.ts).

Two kinds of fixture behave differently from the rest:

- **Negative tests** deliberately create broken data: missing fields, unknown versions, truncated JSON, corrupt SQLite or WAL files, duplicate sequence numbers, reverts and compaction. None of these are valid OpenCode data.
- **[cli-1.19.x-v1-only.sql](cli-1.19.x-v1-only.sql)** keeps the DDL and the shape of the JSON keys from a database written by the real CLI 1.19.2/1.19.3. Every value in it is synthetic. `session_message` is empty because the stable CLI only writes v1 rows.
