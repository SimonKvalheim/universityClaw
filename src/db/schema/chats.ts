import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const chats = sqliteTable('chats', {
  jid: text('jid').primaryKey(),
  name: text('name'),
  last_message_time: text('last_message_time'),
  channel: text('channel'),
  is_group: integer('is_group').default(0),
});

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').notNull(),
    chat_jid: text('chat_jid').notNull().references(() => chats.jid),
    sender: text('sender'),
    sender_name: text('sender_name'),
    content: text('content'),
    timestamp: text('timestamp'),
    is_from_me: integer('is_from_me'),
    is_bot_message: integer('is_bot_message').default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.chat_jid] }),
    idx_timestamp: index('idx_timestamp').on(table.timestamp),
  }),
);
