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
});
