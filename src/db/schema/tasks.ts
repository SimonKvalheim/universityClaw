import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const scheduled_tasks = sqliteTable(
  'scheduled_tasks',
  {
    id: text('id').primaryKey(),
    group_folder: text('group_folder').notNull(),
    chat_jid: text('chat_jid').notNull(),
    prompt: text('prompt').notNull(),
    schedule_type: text('schedule_type').notNull(),
    schedule_value: text('schedule_value').notNull(),
    next_run: text('next_run'),
    last_run: text('last_run'),
    last_result: text('last_result'),
    status: text('status').default('active'),
    created_at: text('created_at').notNull(),
    context_mode: text('context_mode').default('isolated'),
    script: text('script'),
  },
  (table) => ({
    idx_next_run: index('idx_next_run').on(table.next_run),
    idx_status: index('idx_status').on(table.status),
  }),
);

export const task_run_logs = sqliteTable(
  'task_run_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    task_id: text('task_id')
      .notNull()
      .references(() => scheduled_tasks.id),
    run_at: text('run_at').notNull(),
    duration_ms: integer('duration_ms').notNull(),
    status: text('status').notNull(),
    result: text('result'),
    error: text('error'),
  },
  (table) => ({
    idx_task_run_logs: index('idx_task_run_logs').on(table.task_id, table.run_at),
  }),
);
