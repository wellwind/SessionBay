# OpenCode synthetic fixtures

All text, IDs, paths and timestamps are synthetic. Tests build SQLite databases (and WAL files) in temporary directories. The subset schema is authored from source; the CLI fixtures below were generated with official binaries in an isolated HOME and XDG directories, without real history or logins.

The schema follows OpenCode release v1.19.2 (commit `7901b7d325c34852caa84fc2c325f3a08dd7a473`). Only the columns the reader uses are kept:

- [SQLite tables](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/core/src/session/sql.ts): `session`, `message`, `part`, `session_message`.
- [v1 message types](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/schema/src/v1/session.ts) and [v2 event types](https://github.com/anomalyco/opencode/blob/7901b7d325c34852caa84fc2c325f3a08dd7a473/packages/schema/src/session-message.ts).

Fixture provenance:

- **Negative tests** deliberately create broken data: missing fields, unknown versions, truncated JSON, corrupt SQLite or WAL files, duplicate sequence numbers, reverts and compaction. None of these are valid OpenCode data.
- **[cli-1.19.x-v1-only.sql](cli-1.19.x-v1-only.sql)** keeps the DDL and the shape of the JSON keys from a database written by the real CLI 1.19.2/1.19.3. Every value in it is synthetic. `session_message` is empty because the stable CLI only writes v1 rows.

- **[cli-2.2.3-migrated-from-1.19.5.sql](cli-2.2.3-migrated-from-1.19.5.sql)** is a SQL dump after the official macOS arm64 CLI 2.2.3 migrated a synthetic CLI 1.19.5 database seeded from `cli-1.19.x-v1-only.sql`. The official 1.19.5 and 2.2.3 binaries were run in an isolated HOME and XDG directories; release archive digests matched GitHub releases. The v1 tables remain, while `session_v2` and `session_message` contain the same session IDs and original 1.x versions. `session_message` includes 2.x system notices. `session_part` is empty. This verifies migration, not native 2.x model-generated message parts.
- **[export-cli-1.19.5.json](export-cli-1.19.5.json)** and **[export-cli-2.2.3.json](export-cli-2.2.3.json)** are real export outputs from those isolated synthetic runs. They document the incompatible 1.x/2.x export formats for reference; the reader tests do not use them. Export/import and 2.x deletion support are outside this change.
- Native 2.x rows added by `src-tauri/tests/opencode.rs` are hand-authored synthetic data based on the v2.2.3 sources (`packages/core/src/session/sql.ts`, `session/history.ts`, `session/projector.ts`, and `packages/schema/src/session-message.ts`). They cover `session_part` precedence and ordering, inline fallback, version gates, NULL titles and safety limits. They are not native model-run captures.
