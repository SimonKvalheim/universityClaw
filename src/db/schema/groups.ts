import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const registered_groups = sqliteTable('registered_groups', {
  jid: text('jid').primaryKey(),
  name: text('name').notNull(),
  folder: text('folder').notNull().unique(),
  trigger_pattern: text('trigger_pattern').notNull(),
  added_at: text('added_at').notNull(),
  container_config: text('container_config'),
  requires_trigger: integer('requires_trigger').default(1),
  is_main: integer('is_main').default(0),
});

export const sessions = sqliteTable('sessions', {
  group_folder: text('group_folder').primaryKey(),
  session_id: text('session_id').notNull(),
});
