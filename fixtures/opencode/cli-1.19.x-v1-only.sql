-- De-identified structural capture of a real OpenCode CLI opencode.db written by
-- `opencode run` with 1.19.3 and then 1.19.2 on Linux (2026-10-19). Table and index
-- DDL is copied with whitespace normalized for the four tables the reader uses; other official tables are
-- omitted. Row JSON keeps the real key layout, but all IDs, paths, prompts, replies,
-- tool output and hashes are synthetic. session_message is intentionally empty: the
-- stable CLI wrote only the v1 message/part projection in both versions.
-- Minimal stand-in so the verbatim foreign keys resolve; the real project table has more columns.
CREATE TABLE `project` (`id` text PRIMARY KEY);
INSERT INTO `project` VALUES('global');
CREATE TABLE `message` (
 `id` text PRIMARY KEY,
 `session_id` text NOT NULL,
 `time_created` integer NOT NULL,
 `time_updated` integer NOT NULL,
 `data` text NOT NULL,
 CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
CREATE TABLE `part` (
 `id` text PRIMARY KEY,
 `message_id` text NOT NULL,
 `session_id` text NOT NULL,
 `time_created` integer NOT NULL,
 `time_updated` integer NOT NULL,
 `data` text NOT NULL,
 CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
CREATE TABLE `session` (
 `id` text PRIMARY KEY,
 `project_id` text NOT NULL,
 `workspace_id` text,
 `parent_id` text,
 `slug` text NOT NULL,
 `directory` text NOT NULL,
 `path` text,
 `title` text NOT NULL,
 `version` text NOT NULL,
 `share_url` text,
 `summary_additions` integer,
 `summary_deletions` integer,
 `summary_files` integer,
 `summary_diffs` text,
 `metadata` text,
 `cost` real DEFAULT 0 NOT NULL,
 `tokens_input` integer DEFAULT 0 NOT NULL,
 `tokens_output` integer DEFAULT 0 NOT NULL,
 `tokens_reasoning` integer DEFAULT 0 NOT NULL,
 `tokens_cache_read` integer DEFAULT 0 NOT NULL,
 `tokens_cache_write` integer DEFAULT 0 NOT NULL,
 `revert` text,
 `permission` text,
 `agent` text,
 `model` text,
 `time_created` integer NOT NULL,
 `time_updated` integer NOT NULL,
 `time_compacting` integer,
 `time_archived` integer,
 CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
CREATE TABLE `session_message` (
 `id` text PRIMARY KEY,
 `session_id` text NOT NULL,
 `type` text NOT NULL,
 `seq` integer NOT NULL,
 `time_created` integer NOT NULL,
 `time_updated` integer NOT NULL,
 `data` text NOT NULL,
 CONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);
CREATE INDEX `part_session_idx` ON `part` (`session_id`);
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);
CREATE INDEX `session_message_session_time_created_id_idx` ON `session_message` (`session_id`,`time_created`,`id`);
CREATE INDEX `session_message_session_type_seq_idx` ON `session_message` (`session_id`,`type`,`seq`);
CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`);
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);
CREATE INDEX `session_project_idx` ON `session` (`project_id`);
CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);
INSERT INTO `session`(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_cliSynthetic1193','global','synthetic-slug','/synthetic/cli demo','Synthetic CLI title 1.19.3','1.19.3',1792000000000,1792000010016);
INSERT INTO `message` VALUES('msg_cliUser0','ses_cliSynthetic1193',1792000000080,1792000000090,'{"role":"user","time":{"created":1792000000080},"agent":"build","model":{"providerID":"opencode","modelID":"synthetic-free"},"summary":{"diffs":[{"file":"index.js","patch":"synthetic","additions":1,"deletions":0,"status":"modified"}]}}');
INSERT INTO `part` VALUES('prt_cli0a','msg_cliUser0','ses_cliSynthetic1193',1792000000081,1792000000081,'{"type":"text","text":"Synthetic CLI question 1.19.3"}');
INSERT INTO `message` VALUES('msg_cliStep0','ses_cliSynthetic1193',1792000000100,1792000005000,'{"parentID":"msg_cliUser0","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/synthetic/cli demo","root":"/synthetic/cli demo"},"cost":0,"tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"synthetic-free","providerID":"opencode","time":{"created":1,"completed":2},"finish":"stop"}');
INSERT INTO `part` VALUES('prt_cli0b','msg_cliStep0','ses_cliSynthetic1193',1792000000101,1792000000101,'{"snapshot":"0000000000000000000000000000000000000000","type":"step-start"}');
INSERT INTO `part` VALUES('prt_cli0c','msg_cliStep0','ses_cliSynthetic1193',1792000000102,1792000004000,'{"type":"reasoning","text":"Synthetic hidden reasoning","time":{"start":1,"end":2}}');
INSERT INTO `part` VALUES('prt_cli0d','msg_cliStep0','ses_cliSynthetic1193',1792000000103,1792000004500,'{"type":"tool","tool":"edit","callID":"call_synthetic","state":{"status":"completed","input":{"filePath":"/synthetic/cli demo/index.js"},"output":"Synthetic tool output","metadata":{},"title":"index.js","time":{"start":1,"end":2}}}');
INSERT INTO `part` VALUES('prt_cli0e','msg_cliStep0','ses_cliSynthetic1193',1792000000104,1792000004600,'{"type":"patch","hash":"1111111111111111111111111111111111111111","files":["/synthetic/cli demo/index.js"]}');
INSERT INTO `part` VALUES('prt_cli0f','msg_cliStep0','ses_cliSynthetic1193',1792000000105,1792000004700,'{"reason":"tool-calls","snapshot":"1111111111111111111111111111111111111111","type":"step-finish","tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}');
INSERT INTO `message` VALUES('msg_cliReply0','ses_cliSynthetic1193',1792000006000,1792000010000,'{"parentID":"msg_cliUser0","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/synthetic/cli demo","root":"/synthetic/cli demo"},"cost":0,"tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"synthetic-free","providerID":"opencode","time":{"created":1,"completed":2},"finish":"stop"}');
INSERT INTO `part` VALUES('prt_cli0g','msg_cliReply0','ses_cliSynthetic1193',1792000006001,1792000009990,'{"type":"text","text":"Synthetic CLI answer 1.19.3","time":{"start":1792000006001,"end":1792000009990}}');
INSERT INTO `session`(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_cliSynthetic1192','global','synthetic-slug','/synthetic/cli demo','Synthetic CLI title 1.19.2','1.19.2',1792000100000,1792000110016);
INSERT INTO `message` VALUES('msg_cliUser1','ses_cliSynthetic1192',1792000100080,1792000100090,'{"role":"user","time":{"created":1792000100080},"agent":"build","model":{"providerID":"opencode","modelID":"synthetic-free"},"summary":{"diffs":[{"file":"index.js","patch":"synthetic","additions":1,"deletions":0,"status":"modified"}]}}');
INSERT INTO `part` VALUES('prt_cli1a','msg_cliUser1','ses_cliSynthetic1192',1792000100081,1792000100081,'{"type":"text","text":"Synthetic CLI question 1.19.2"}');
INSERT INTO `message` VALUES('msg_cliStep1','ses_cliSynthetic1192',1792000100100,1792000105000,'{"parentID":"msg_cliUser1","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/synthetic/cli demo","root":"/synthetic/cli demo"},"cost":0,"tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"synthetic-free","providerID":"opencode","time":{"created":1,"completed":2},"finish":"stop"}');
INSERT INTO `part` VALUES('prt_cli1b','msg_cliStep1','ses_cliSynthetic1192',1792000100101,1792000100101,'{"snapshot":"0000000000000000000000000000000000000000","type":"step-start"}');
INSERT INTO `part` VALUES('prt_cli1c','msg_cliStep1','ses_cliSynthetic1192',1792000100102,1792000104000,'{"type":"reasoning","text":"Synthetic hidden reasoning","time":{"start":1,"end":2}}');
INSERT INTO `part` VALUES('prt_cli1d','msg_cliStep1','ses_cliSynthetic1192',1792000100103,1792000104500,'{"type":"tool","tool":"edit","callID":"call_synthetic","state":{"status":"completed","input":{"filePath":"/synthetic/cli demo/index.js"},"output":"Synthetic tool output","metadata":{},"title":"index.js","time":{"start":1,"end":2}}}');
INSERT INTO `part` VALUES('prt_cli1e','msg_cliStep1','ses_cliSynthetic1192',1792000100104,1792000104600,'{"type":"patch","hash":"1111111111111111111111111111111111111111","files":["/synthetic/cli demo/index.js"]}');
INSERT INTO `part` VALUES('prt_cli1f','msg_cliStep1','ses_cliSynthetic1192',1792000100105,1792000104700,'{"reason":"tool-calls","snapshot":"1111111111111111111111111111111111111111","type":"step-finish","tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}');
INSERT INTO `message` VALUES('msg_cliReply1','ses_cliSynthetic1192',1792000106000,1792000110000,'{"parentID":"msg_cliUser1","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/synthetic/cli demo","root":"/synthetic/cli demo"},"cost":0,"tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"synthetic-free","providerID":"opencode","time":{"created":1,"completed":2},"finish":"stop"}');
INSERT INTO `part` VALUES('prt_cli1g','msg_cliReply1','ses_cliSynthetic1192',1792000106001,1792000109990,'{"type":"text","text":"Synthetic CLI answer 1.19.2","time":{"start":1792000106001,"end":1792000109990}}');
