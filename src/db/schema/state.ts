import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const router_state = sqliteTable('router_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updated_at: text('updated_at').default(sql`(datetime('now'))`),
});

export const zotero_sync = sqliteTable('zotero_sync', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
