# Synthetic history fixtures

Every record here was written by hand. There are no real conversations, credentials, user paths or attachments. Dates and IDs exist only for tests. Some fixtures contain Chinese text on purpose, to cover CJK search.

- `codex/standard.jsonl`: `session_meta`, `response_item`, duplicate `event_msg`, CJK text, identifiers and tool output.
- `claude/standard.jsonl`: `sessionId` and initial `cwd`, string and content-block messages, an attachment placeholder, and a tool result that is not searchable.
- `claude/subagent.jsonl`: a subagent linked to its parent session. It is not listed as a top-level session.

Tests also generate edge cases in temporary directories:

- missing fields, partial and broken lines, unknown events;
- truncation, same-inode rewrites, replacement and moves;
- deletion, duplicate sources, cancellation and rescans.

## Rules these fixtures pin down

- **Working directory**:
  - Codex prefers `session_meta.payload.cwd`, then the first valid `turn_context.cwd`.
  - Claude uses the cwd of the first user or assistant message.
  - A missing or relative cwd makes the session unclassified.
  - Symlinks are merged through their canonical path.
- **Search** is a literal substring match. It is case-insensitive for ASCII, and `%`, `_` and quotes are not wildcards.
  - Queries of three or more characters first pick candidates with the FTS5 trigram index (`detail=none`), then verify each one with `instr`.
- **Incremental parsing** only reads complete lines after the checkpoint. On change, it verifies the SHA-256 of the already-parsed prefix.
- **Preview limits**:
  - 64 KiB per message;
  - 1 MiB per page;
  - records over 8 MiB show a placeholder and are not indexed.

Antigravity and Grok tests build their data in a temporary `HOME` inside the Rust tests rather than using files here.
