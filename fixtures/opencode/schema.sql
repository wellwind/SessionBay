-- Synthetic subset of OpenCode v1.19.2's official Drizzle tables, NOT a captured DB.
-- See README.md for exact provenance and omitted non-reader fields.
CREATE TABLE session (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL,
 title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL,
 time_updated INTEGER NOT NULL, parent_id TEXT, time_archived INTEGER, revert TEXT
);
CREATE TABLE message (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
 time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE part (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
 time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE session_message (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
 time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
 UNIQUE(session_id, seq)
);
CREATE INDEX message_session_idx ON message(session_id,time_created,id);
CREATE INDEX part_message_idx ON part(session_id,message_id,id);
CREATE INDEX session_message_session_idx ON session_message(session_id,seq);
