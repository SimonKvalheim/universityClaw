import { and, asc, eq, gte } from 'drizzle-orm';
import { getDb } from './index.js';
import * as schema from './schema/index.js';

export function getMessagesSinceIncludingBot(
  chatJid: string,
  since: string,
  limit?: number,
) {
  const q = getDb()
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.chat_jid, chatJid),
        gte(schema.messages.timestamp, since),
      ),
    )
    .orderBy(asc(schema.messages.timestamp));
  return limit ? q.limit(limit).all() : q.all();
}
