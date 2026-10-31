-- Synthetic OpenCode database after CLI 2.2.3 migrated a CLI 1.19.5 database.
-- Generated in an isolated HOME from fixtures/opencode/cli-1.19.x-v1-only.sql; no real history.
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE `project` (
          `id` text PRIMARY KEY,
          `worktree` text NOT NULL,
          `vcs` text,
          `name` text,
          `icon_url` text,
          `icon_url_override` text,
          `icon_color` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_initialized` integer,
          `sandboxes` text NOT NULL,
          `commands` text
        , `time_active` integer DEFAULT 0 NOT NULL, `time_archived` integer);
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
CREATE TABLE `session_v2` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `workspace_id` text,
          `parent_id` text,
          `fork_session_id` text,
          `fork_boundary` text,
          `slug` text NOT NULL,
          `directory` text NOT NULL,
          `path` text,
          `title` text,
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
          `time_suspended` integer, `resume_attempts` integer DEFAULT 0 NOT NULL, `time_idle` integer, `time_viewed` integer, `idle_outcome` text, `time_busy` integer,
          CONSTRAINT `fk_session_v2_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
CREATE TABLE IF NOT EXISTS "session_message" (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `type` text NOT NULL,
          `seq` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_session_message_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);
CREATE TABLE `session_part` (
          `message_id` text NOT NULL,
          `session_id` text NOT NULL,
          `ordinal` integer NOT NULL,
          `type` text NOT NULL,
          `call_id` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `session_part_pk` PRIMARY KEY(`message_id`, `ordinal`),
          CONSTRAINT `fk_session_part_message_id_session_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `session_message`(`id`) ON DELETE CASCADE,
          CONSTRAINT `fk_session_part_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
INSERT INTO project VALUES('global','/',NULL,NULL,NULL,NULL,NULL,1792000000000,1793433192608,NULL,'[]',NULL,1793433192608,NULL);
INSERT INTO session VALUES('ses_cliSynthetic1193','global',NULL,NULL,'synthetic-slug','/synthetic/cli demo',NULL,'Synthetic CLI title 1.19.5','1.19.5',NULL,NULL,NULL,NULL,NULL,NULL,0.0,0,0,0,0,0,NULL,NULL,NULL,NULL,1792000000000,1792000010016,NULL,NULL);
INSERT INTO session VALUES('ses_cliSynthetic1192','global',NULL,NULL,'synthetic-slug','/synthetic/cli demo',NULL,'Synthetic CLI title 1.19.2','1.19.2',NULL,NULL,NULL,NULL,NULL,NULL,0.0,0,0,0,0,0,NULL,NULL,NULL,NULL,1792000100000,1792000110016,NULL,NULL);
INSERT INTO message VALUES('msg_cliUser0','ses_cliSynthetic1193',1792000000080,1792000000090,'{"role":"user","time":{"created":1792000000080},"agent":"build","model":{"providerID":"opencode","modelID":"synthetic-free"},"summary":{"diffs":[{"file":"index.js","patch":"synthetic","additions":1,"deletions":0,"status":"modified"}]}}');
INSERT INTO message VALUES('msg_cliStep0','ses_cliSynthetic1193',1792000000100,1792000005000,'{"parentID":"msg_cliUser0","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/synthetic/cli demo","root":"/synthetic/cli demo"},"cost":0,"tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"synthetic-free","providerID":"opencode","time":{"created":1,"completed":2},"finish":"stop"}');
INSERT INTO message VALUES('msg_cliReply0','ses_cliSynthetic1193',1792000006000,1792000010000,'{"parentID":"msg_cliUser0","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/synthetic/cli demo","root":"/synthetic/cli demo"},"cost":0,"tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"synthetic-free","providerID":"opencode","time":{"created":1,"completed":2},"finish":"stop"}');
INSERT INTO message VALUES('msg_cliUser1','ses_cliSynthetic1192',1792000100080,1792000100090,'{"role":"user","time":{"created":1792000100080},"agent":"build","model":{"providerID":"opencode","modelID":"synthetic-free"},"summary":{"diffs":[{"file":"index.js","patch":"synthetic","additions":1,"deletions":0,"status":"modified"}]}}');
INSERT INTO message VALUES('msg_cliStep1','ses_cliSynthetic1192',1792000100100,1792000105000,'{"parentID":"msg_cliUser1","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/synthetic/cli demo","root":"/synthetic/cli demo"},"cost":0,"tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"synthetic-free","providerID":"opencode","time":{"created":1,"completed":2},"finish":"stop"}');
INSERT INTO message VALUES('msg_cliReply1','ses_cliSynthetic1192',1792000106000,1792000110000,'{"parentID":"msg_cliUser1","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/synthetic/cli demo","root":"/synthetic/cli demo"},"cost":0,"tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"synthetic-free","providerID":"opencode","time":{"created":1,"completed":2},"finish":"stop"}');
INSERT INTO part VALUES('prt_cli0a','msg_cliUser0','ses_cliSynthetic1193',1792000000081,1792000000081,'{"type":"text","text":"Synthetic CLI question 1.19.5"}');
INSERT INTO part VALUES('prt_cli0b','msg_cliStep0','ses_cliSynthetic1193',1792000000101,1792000000101,'{"snapshot":"0000000000000000000000000000000000000000","type":"step-start"}');
INSERT INTO part VALUES('prt_cli0c','msg_cliStep0','ses_cliSynthetic1193',1792000000102,1792000004000,'{"type":"reasoning","text":"Synthetic hidden reasoning","time":{"start":1,"end":2}}');
INSERT INTO part VALUES('prt_cli0d','msg_cliStep0','ses_cliSynthetic1193',1792000000103,1792000004500,'{"type":"tool","tool":"edit","callID":"call_synthetic","state":{"status":"completed","input":{"filePath":"/synthetic/cli demo/index.js"},"output":"Synthetic tool output","metadata":{},"title":"index.js","time":{"start":1,"end":2}}}');
INSERT INTO part VALUES('prt_cli0e','msg_cliStep0','ses_cliSynthetic1193',1792000000104,1792000004600,'{"type":"patch","hash":"1111111111111111111111111111111111111111","files":["/synthetic/cli demo/index.js"]}');
INSERT INTO part VALUES('prt_cli0f','msg_cliStep0','ses_cliSynthetic1193',1792000000105,1792000004700,'{"reason":"tool-calls","snapshot":"1111111111111111111111111111111111111111","type":"step-finish","tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}');
INSERT INTO part VALUES('prt_cli0g','msg_cliReply0','ses_cliSynthetic1193',1792000006001,1792000009990,'{"type":"text","text":"Synthetic CLI answer 1.19.5","time":{"start":1792000006001,"end":1792000009990}}');
INSERT INTO part VALUES('prt_cli1a','msg_cliUser1','ses_cliSynthetic1192',1792000100081,1792000100081,'{"type":"text","text":"Synthetic CLI question 1.19.2"}');
INSERT INTO part VALUES('prt_cli1b','msg_cliStep1','ses_cliSynthetic1192',1792000100101,1792000100101,'{"snapshot":"0000000000000000000000000000000000000000","type":"step-start"}');
INSERT INTO part VALUES('prt_cli1c','msg_cliStep1','ses_cliSynthetic1192',1792000100102,1792000104000,'{"type":"reasoning","text":"Synthetic hidden reasoning","time":{"start":1,"end":2}}');
INSERT INTO part VALUES('prt_cli1d','msg_cliStep1','ses_cliSynthetic1192',1792000100103,1792000104500,'{"type":"tool","tool":"edit","callID":"call_synthetic","state":{"status":"completed","input":{"filePath":"/synthetic/cli demo/index.js"},"output":"Synthetic tool output","metadata":{},"title":"index.js","time":{"start":1,"end":2}}}');
INSERT INTO part VALUES('prt_cli1e','msg_cliStep1','ses_cliSynthetic1192',1792000100104,1792000104600,'{"type":"patch","hash":"1111111111111111111111111111111111111111","files":["/synthetic/cli demo/index.js"]}');
INSERT INTO part VALUES('prt_cli1f','msg_cliStep1','ses_cliSynthetic1192',1792000100105,1792000104700,'{"reason":"tool-calls","snapshot":"1111111111111111111111111111111111111111","type":"step-finish","tokens":{"total":10,"input":6,"output":4,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}');
INSERT INTO part VALUES('prt_cli1g','msg_cliReply1','ses_cliSynthetic1192',1792000106001,1792000109990,'{"type":"text","text":"Synthetic CLI answer 1.19.2","time":{"start":1792000106001,"end":1792000109990}}');
INSERT INTO session_v2 VALUES('ses_cliSynthetic1193','global',NULL,NULL,NULL,NULL,'synthetic-slug','/synthetic/cli demo',NULL,'Synthetic CLI title 1.19.5','1.19.5',NULL,NULL,NULL,NULL,NULL,NULL,0.0,12,8,0,0,0,NULL,NULL,'build','{"id":"synthetic-free","providerID":"opencode","variant":"default"}',1792000000000,1792000010016,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL);
INSERT INTO session_v2 VALUES('ses_cliSynthetic1192','global',NULL,NULL,NULL,NULL,'synthetic-slug','/synthetic/cli demo',NULL,'Synthetic CLI title 1.19.2','1.19.2',NULL,NULL,NULL,NULL,NULL,NULL,0.0,12,8,0,0,0,NULL,NULL,'build','{"id":"synthetic-free","providerID":"opencode","variant":"default"}',1792000100000,1792000110016,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL);
INSERT INTO session_message VALUES('msg_cliUser0','ses_cliSynthetic1193','user',0,1792000000080,1792000000090,'{"text":"Synthetic CLI question 1.19.5","time":{"created":1792000000080}}');
INSERT INTO session_message VALUES('msg_cliStep0','ses_cliSynthetic1193','assistant',1,1792000000100,1792000005000,'{"agent":"build","model":{"providerID":"opencode","id":"synthetic-free","variant":"default"},"content":[{"type":"reasoning","text":"Synthetic hidden reasoning","time":{"created":1,"completed":2}},{"type":"tool","id":"call_synthetic","name":"edit","state":{"status":"completed","input":{"filePath":"/synthetic/cli demo/index.js"},"content":[{"type":"text","text":"Synthetic tool output"}],"metadata":{}},"time":{"created":1,"completed":2}}],"snapshot":{"start":"0000000000000000000000000000000000000000","end":"1111111111111111111111111111111111111111","files":["/synthetic/cli demo/index.js"]},"finish":"stop","cost":0,"tokens":{"input":6,"output":4,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1792000000100,"completed":1792000005000}}');
INSERT INTO session_message VALUES('msg_cliReply0','ses_cliSynthetic1193','assistant',2,1792000006000,1792000010000,'{"agent":"build","model":{"providerID":"opencode","id":"synthetic-free","variant":"default"},"content":[{"type":"text","text":"Synthetic CLI answer 1.19.5"}],"finish":"stop","cost":0,"tokens":{"input":6,"output":4,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1792000006000,"completed":1792000010000}}');
INSERT INTO session_message VALUES('msg_cliReply0SOxMF8VJlR2n3W','ses_cliSynthetic1193','system',3,1792000006000,1792000010000,'{"text":"The available tools have changed.\n\nThe `edit` tool now takes `path` instead of `filePath`.","time":{"created":1792000006000}}');
INSERT INTO session_message VALUES('msg_cliUser1','ses_cliSynthetic1192','user',0,1792000100080,1792000100090,'{"text":"Synthetic CLI question 1.19.2","time":{"created":1792000100080}}');
INSERT INTO session_message VALUES('msg_cliStep1','ses_cliSynthetic1192','assistant',1,1792000100100,1792000105000,'{"agent":"build","model":{"providerID":"opencode","id":"synthetic-free","variant":"default"},"content":[{"type":"reasoning","text":"Synthetic hidden reasoning","time":{"created":1,"completed":2}},{"type":"tool","id":"call_synthetic","name":"edit","state":{"status":"completed","input":{"filePath":"/synthetic/cli demo/index.js"},"content":[{"type":"text","text":"Synthetic tool output"}],"metadata":{}},"time":{"created":1,"completed":2}}],"snapshot":{"start":"0000000000000000000000000000000000000000","end":"1111111111111111111111111111111111111111","files":["/synthetic/cli demo/index.js"]},"finish":"stop","cost":0,"tokens":{"input":6,"output":4,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1792000100100,"completed":1792000105000}}');
INSERT INTO session_message VALUES('msg_cliReply1','ses_cliSynthetic1192','assistant',2,1792000106000,1792000110000,'{"agent":"build","model":{"providerID":"opencode","id":"synthetic-free","variant":"default"},"content":[{"type":"text","text":"Synthetic CLI answer 1.19.2"}],"finish":"stop","cost":0,"tokens":{"input":6,"output":4,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1792000106000,"completed":1792000110000}}');
INSERT INTO session_message VALUES('msg_cliReply161yUHay89JKSH1','ses_cliSynthetic1192','system',3,1792000106000,1792000110000,'{"text":"The available tools have changed.\n\nThe `edit` tool now takes `path` instead of `filePath`.","time":{"created":1792000106000}}');
COMMIT;
