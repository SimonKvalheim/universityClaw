import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const ingestion_jobs = sqliteTable('ingestion_jobs', {
  id: text('id').primaryKey(),
  source_path: text('source_path').notNull(),
  source_filename: text('source_filename').notNull(),
  status: text('status').default('pending'),
  extraction_path: text('extraction_path'),
  error: text('error'),
  created_at: text('created_at').default(sql`(datetime('now'))`),
  completed_at: text('completed_at'),
  updated_at: text('updated_at').default(sql`(datetime('now'))`),
  source_type: text('source_type').default('upload'),
  zotero_key: text('zotero_key'),
  zotero_metadata: text('zotero_metadata'),
  content_hash: text('content_hash'),
  retry_after: text('retry_after'),
  retry_count: integer('retry_count').default(0),
  promoted_paths: text('promoted_paths'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updated_at: text('updated_at').default(sql`(datetime('now'))`),
});

// Study system tables (must match src/db/schema/study.ts SQL columns exactly)

export const concepts = sqliteTable('concepts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  domain: text('domain'),
  subdomain: text('subdomain'),
  course: text('course'),
  vault_note_path: text('vault_note_path'),
  status: text('status').default('active'),
  mastery_L1: real('mastery_L1').default(0.0),
  mastery_L2: real('mastery_L2').default(0.0),
  mastery_L3: real('mastery_L3').default(0.0),
  mastery_L4: real('mastery_L4').default(0.0),
  mastery_L5: real('mastery_L5').default(0.0),
  mastery_L6: real('mastery_L6').default(0.0),
  mastery_overall: real('mastery_overall').default(0.0),
  bloom_ceiling: integer('bloom_ceiling').default(0),
  created_at: text('created_at').notNull(),
  last_activity_at: text('last_activity_at'),
});

export const learning_activities = sqliteTable('learning_activities', {
  id: text('id').primaryKey(),
  concept_id: text('concept_id').notNull(),
  activity_type: text('activity_type').notNull(),
  bloom_level: integer('bloom_level').notNull(),
  due_at: text('due_at').notNull(),
  mastery_state: text('mastery_state').default('new'),
  prompt: text('prompt').notNull(),
  reference_answer: text('reference_answer'),
  difficulty_estimate: integer('difficulty_estimate').default(5),
  card_type: text('card_type'),
  author: text('author').default('system'),
  source_note_path: text('source_note_path'),
  source_chunk_hash: text('source_chunk_hash'),
  generated_at: text('generated_at').notNull(),
  ease_factor: real('ease_factor').default(2.5),
  interval_days: integer('interval_days').default(1),
  repetitions: integer('repetitions').default(0),
  last_reviewed: text('last_reviewed'),
  last_quality: integer('last_quality'),
});

export const study_sessions = sqliteTable('study_sessions', {
  id: text('id').primaryKey(),
  started_at: text('started_at').notNull(),
  ended_at: text('ended_at'),
  session_type: text('session_type').notNull(),
  plan_id: text('plan_id'),
  pre_confidence: text('pre_confidence'),
  post_reflection: text('post_reflection'),
  calibration_score: real('calibration_score'),
  activities_completed: integer('activities_completed').default(0),
  total_time_ms: integer('total_time_ms'),
  surface: text('surface'),
});

export const activity_log = sqliteTable('activity_log', {
  id: text('id').primaryKey(),
  activity_id: text('activity_id').notNull(),
  concept_id: text('concept_id').notNull(),
  activity_type: text('activity_type').notNull(),
  bloom_level: integer('bloom_level').notNull(),
  quality: integer('quality').notNull(),
  response_text: text('response_text'),
  response_time_ms: integer('response_time_ms'),
  confidence_rating: integer('confidence_rating'),
  scaffolding_level: integer('scaffolding_level').default(0),
  evaluation_method: text('evaluation_method').default('self_rated'),
  ai_quality: integer('ai_quality'),
  ai_feedback: text('ai_feedback'),
  method_used: text('method_used'),
  surface: text('surface'),
  session_id: text('session_id'),
  reviewed_at: text('reviewed_at').notNull(),
});
