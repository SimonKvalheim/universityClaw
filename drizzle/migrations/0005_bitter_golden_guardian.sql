CREATE TABLE `delivered_concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`concept_id` text NOT NULL,
	`chat_jid` text NOT NULL,
	`source_task_id` text,
	`surface` text,
	`delivered_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_delivered_at` ON `delivered_concepts` (`delivered_at`);--> statement-breakpoint
CREATE INDEX `idx_delivered_concept` ON `delivered_concepts` (`concept_id`,`delivered_at`);--> statement-breakpoint
CREATE INDEX `idx_delivered_chat` ON `delivered_concepts` (`chat_jid`,`delivered_at`);