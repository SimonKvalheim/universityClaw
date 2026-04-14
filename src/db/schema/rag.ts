import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const rag_index_tracker = sqliteTable(
  'rag_index_tracker',
  {
    vault_path: text('vault_path').primaryKey(),
    doc_id: text('doc_id').notNull(),
    content_hash: text('content_hash').notNull(),
    indexed_at: text('indexed_at').notNull(),
  },
  (table) => ({
    idx_rag_tracker_doc_id: index('idx_rag_tracker_doc_id').on(table.doc_id),
  }),
);
