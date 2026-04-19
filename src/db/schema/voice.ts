import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

// ====================================================================
// Voice Sessions — live voice chat cost tracking
// ====================================================================

export const voiceSessions = sqliteTable(
  'voice_sessions',
  {
    id: text('id').primaryKey(),
    persona: text('persona').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    textTokensIn: integer('text_tokens_in').notNull().default(0),
    textTokensOut: integer('text_tokens_out').notNull().default(0),
    audioTokensIn: integer('audio_tokens_in').notNull().default(0),
    audioTokensOut: integer('audio_tokens_out').notNull().default(0),
    costUsd: real('cost_usd').notNull(),
    ratesVersion: text('rates_version').notNull(),
    transcriptPath: text('transcript_path'),
    artifacts: text('artifacts'),
  },
  (table) => ({
    startedAtIdx: index('idx_voice_sessions_started').on(table.startedAt),
  }),
);

export type VoiceSession = typeof voiceSessions.$inferSelect;
export type NewVoiceSession = typeof voiceSessions.$inferInsert;
