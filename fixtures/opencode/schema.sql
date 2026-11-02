-- Synthetic reader subset of the reviewed OpenCode 2.2.3 tables.
-- See README.md for provenance; no captured user history.
CREATE TABLE session_v2 (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL,
 title TEXT, version TEXT NOT NULL, time_created INTEGER NOT NULL,
 time_updated INTEGER NOT NULL, parent_id TEXT, time_archived INTEGER, revert TEXT
);
CREATE TABLE session_message (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
 time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
 UNIQUE(session_id, seq)
);
CREATE TABLE session_part (
 message_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 type TEXT NOT NULL, call_id TEXT, time_created INTEGER NOT NULL,
 time_updated INTEGER NOT NULL, data TEXT NOT NULL,
 PRIMARY KEY(message_id, ordinal)
);
CREATE INDEX session_message_session_idx ON session_message(session_id,seq);
CREATE INDEX session_part_session_idx ON session_part(session_id,message_id,ordinal);
