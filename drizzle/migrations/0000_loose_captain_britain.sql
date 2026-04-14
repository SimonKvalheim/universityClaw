CREATE TABLE IF NOT EXISTS `chats` (
	`jid` text PRIMARY KEY NOT NULL,
	`name` text,
	`last_message_time` text,
	`channel` text,
	`is_group` integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
	`id` text NOT NULL,
	`chat_jid` text,
	`sender` text,
	`sender_name` text,
	`content` text,
	`timestamp` text,
	`is_from_me` integer,
	`is_bot_message` integer DEFAULT 0,
	PRIMARY KEY(`id`, `chat_jid`),
	FOREIGN KEY (`chat_jid`) REFERENCES `chats`(`jid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_timestamp` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `citation_edges` (
	`source_slug` text NOT NULL,
	`target_slug` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`source_slug`, `target_slug`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_citation_target` ON `citation_edges` (`target_slug`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `registered_groups` (
	`jid` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`folder` text NOT NULL,
	`trigger_pattern` text NOT NULL,
	`added_at` text NOT NULL,
	`container_config` text,
	`requires_trigger` integer DEFAULT 1,
	`is_main` integer DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `registered_groups_folder_unique` ON `registered_groups` (`folder`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`group_folder` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ingestion_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_path` text NOT NULL,
	`source_filename` text NOT NULL,
	`status` text DEFAULT 'pending',
	`extraction_path` text,
	`error` text,
	`created_at` text DEFAULT (datetime('now')),
	`completed_at` text,
	`updated_at` text DEFAULT (datetime('now')),
	`source_type` text DEFAULT 'upload',
	`zotero_key` text,
	`zotero_metadata` text,
	`content_hash` text,
	`retry_after` text,
	`retry_count` integer DEFAULT 0,
	`promoted_paths` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ingestion_jobs_status` ON `ingestion_jobs` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ingestion_jobs_source_path` ON `ingestion_jobs` (`source_path`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ingestion_jobs_hash` ON `ingestion_jobs` (`content_hash`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rag_index_tracker` (
	`vault_path` text PRIMARY KEY NOT NULL,
	`doc_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`indexed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rag_tracker_doc_id` ON `rag_index_tracker` (`doc_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `router_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `zotero_sync` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`group_folder` text NOT NULL,
	`chat_jid` text NOT NULL,
	`prompt` text NOT NULL,
	`schedule_type` text NOT NULL,
	`schedule_value` text NOT NULL,
	`next_run` text,
	`last_run` text,
	`last_result` text,
	`status` text DEFAULT 'active',
	`created_at` text NOT NULL,
	`context_mode` text DEFAULT 'isolated',
	`script` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_next_run` ON `scheduled_tasks` (`next_run`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_status` ON `scheduled_tasks` (`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_run_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`run_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`error` text,
	FOREIGN KEY (`task_id`) REFERENCES `scheduled_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_run_logs` ON `task_run_logs` (`task_id`,`run_at`);