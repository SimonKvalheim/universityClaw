CREATE TABLE `activity_concepts` (
	`activity_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`role` text DEFAULT 'related',
	PRIMARY KEY(`activity_id`, `concept_id`),
	FOREIGN KEY (`activity_id`) REFERENCES `learning_activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `activity_log` (
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
	FOREIGN KEY (`session_id`) REFERENCES `study_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_log_concept` ON `activity_log` (`concept_id`);--> statement-breakpoint
CREATE INDEX `idx_log_session` ON `activity_log` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_log_bloom` ON `activity_log` (`bloom_level`);--> statement-breakpoint
CREATE TABLE `concept_prerequisites` (
	`concept_id` text NOT NULL,
	`prerequisite_id` text NOT NULL,
	PRIMARY KEY(`concept_id`, `prerequisite_id`),
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prerequisite_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`domain` text,
	`subdomain` text,
	`course` text,
	`vault_note_path` text,
	`status` text DEFAULT 'active',
	`mastery_L1` real DEFAULT 0,
	`mastery_L2` real DEFAULT 0,
	`mastery_L3` real DEFAULT 0,
	`mastery_L4` real DEFAULT 0,
	`mastery_L5` real DEFAULT 0,
	`mastery_L6` real DEFAULT 0,
	`mastery_overall` real DEFAULT 0,
	`bloom_ceiling` integer DEFAULT 0,
	`created_at` text NOT NULL,
	`last_activity_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_concepts_domain` ON `concepts` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_concepts_status` ON `concepts` (`status`);--> statement-breakpoint
CREATE TABLE `learning_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`concept_id` text NOT NULL,
	`activity_type` text NOT NULL,
	`prompt` text NOT NULL,
	`reference_answer` text,
	`bloom_level` integer NOT NULL,
	`difficulty_estimate` integer DEFAULT 5,
	`card_type` text,
	`author` text DEFAULT 'system',
	`source_note_path` text,
	`source_chunk_hash` text,
	`generated_at` text NOT NULL,
	`ease_factor` real DEFAULT 2.5,
	`interval_days` integer DEFAULT 1,
	`repetitions` integer DEFAULT 0,
	`due_at` text NOT NULL,
	`last_reviewed` text,
	`last_quality` integer,
	`mastery_state` text DEFAULT 'new',
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_activities_due` ON `learning_activities` (`due_at`);--> statement-breakpoint
CREATE INDEX `idx_activities_concept` ON `learning_activities` (`concept_id`);--> statement-breakpoint
CREATE INDEX `idx_activities_type` ON `learning_activities` (`activity_type`);--> statement-breakpoint
CREATE TABLE `study_plan_concepts` (
	`plan_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`target_bloom` integer DEFAULT 6,
	`sort_order` integer DEFAULT 0,
	PRIMARY KEY(`plan_id`, `concept_id`),
	FOREIGN KEY (`plan_id`) REFERENCES `study_plans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `study_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`domain` text,
	`course` text,
	`strategy` text DEFAULT 'open' NOT NULL,
	`learning_objectives` text,
	`desired_outcomes` text,
	`implementation_intention` text,
	`obstacle` text,
	`study_schedule` text,
	`config` text,
	`checkpoint_interval_days` integer DEFAULT 14,
	`next_checkpoint_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`status` text DEFAULT 'active'
);
--> statement-breakpoint
CREATE TABLE `study_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`session_type` text NOT NULL,
	`plan_id` text,
	`pre_confidence` text,
	`post_reflection` text,
	`calibration_score` real,
	`activities_completed` integer DEFAULT 0,
	`total_time_ms` integer,
	`surface` text,
	FOREIGN KEY (`plan_id`) REFERENCES `study_plans`(`id`) ON UPDATE no action ON DELETE no action
);
