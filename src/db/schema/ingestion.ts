import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const ingestion_jobs = sqliteTable(
  'ingestion_jobs',
  {
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
  },
  (table) => ({
    idx_ingestion_jobs_status: index('idx_ingestion_jobs_status').on(
      table.status,
    ),
    idx_ingestion_jobs_source_path: index('idx_ingestion_jobs_source_path').on(
      table.source_path,
    ),
    idx_ingestion_jobs_hash: index('idx_ingestion_jobs_hash').on(
      table.content_hash,
    ),
  }),
);
