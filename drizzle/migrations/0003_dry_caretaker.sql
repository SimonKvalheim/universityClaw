CREATE TABLE `voice_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`persona` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`text_tokens_in` integer DEFAULT 0 NOT NULL,
	`text_tokens_out` integer DEFAULT 0 NOT NULL,
	`audio_tokens_in` integer DEFAULT 0 NOT NULL,
	`audio_tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_usd` real NOT NULL,
	`rates_version` text NOT NULL,
	`transcript_path` text,
	`artifacts` text
);
--> statement-breakpoint
CREATE INDEX `idx_voice_sessions_started` ON `voice_sessions` (`started_at`);