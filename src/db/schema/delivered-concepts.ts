import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const deliveredConcepts = sqliteTable(
  'delivered_concepts',
  {
    id: text('id').primaryKey(),
    conceptId: text('concept_id').notNull(),
    chatJid: text('chat_jid').notNull(),
    sourceTaskId: text('source_task_id'),
    surface: text('surface'),
    deliveredAt: text('delivered_at').notNull(),
  },
  (t) => ({
    deliveredAtIdx: index('idx_delivered_at').on(t.deliveredAt),
    conceptIdx: index('idx_delivered_concept').on(t.conceptId, t.deliveredAt),
    chatIdx: index('idx_delivered_chat').on(t.chatJid, t.deliveredAt),
  }),
);
