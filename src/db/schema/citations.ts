import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const citation_edges = sqliteTable(
  'citation_edges',
  {
    source_slug: text('source_slug').notNull(),
    target_slug: text('target_slug').notNull(),
    created_at: text('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.source_slug, table.target_slug] }),
    idx_citation_target: index('idx_citation_target').on(table.target_slug),
  }),
);
