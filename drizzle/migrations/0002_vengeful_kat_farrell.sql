PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`activity_type` text NOT NULL,
	`bloom_level` integer NOT NULL,
	`quality` integer NOT NULL,
	`response_text` text,
	`response_time_ms` integer,
	`confidence_rating` integer,
	`scaffolding_level` integer DEFAULT 0,
	`evaluation_method` text DEFAULT 'self_rated',
	`ai_quality` integer,
	`ai_feedback` text,
	`method_used` text,
	`surface` text,
	`session_id` text,
	`reviewed_at` text NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `learning_activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `study_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_activity_log`("id", "activity_id", "concept_id", "activity_type", "bloom_level", "quality", "response_text", "response_time_ms", "confidence_rating", "scaffolding_level", "evaluation_method", "ai_quality", "ai_feedback", "method_used", "surface", "session_id", "reviewed_at") SELECT "id", "activity_id", "concept_id", "activity_type", "bloom_level", "quality", "response_text", "response_time_ms", "confidence_rating", "scaffolding_level", "evaluation_method", "ai_quality", "ai_feedback", "method_used", "surface", "session_id", "reviewed_at" FROM `activity_log`;--> statement-breakpoint
DROP TABLE `activity_log`;--> statement-breakpoint
ALTER TABLE `__new_activity_log` RENAME TO `activity_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_log_concept` ON `activity_log` (`concept_id`);--> statement-breakpoint
CREATE INDEX `idx_log_session` ON `activity_log` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_log_bloom` ON `activity_log` (`bloom_level`);