import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte } from 'drizzle-orm';
import { getDb } from './index.js';
import * as schema from './schema/index.js';

type RecordArgs = {
  concept: string;
  chatJid: string;
  sourceTaskId?: string;
  surface?: 'text' | 'voice' | 'text+voice';
};

type RecordResult =
  | { ok: true; conceptId: string; title: string }
  | { ok: false; error: string };

function resolveConceptId(input: string): { id: string; title: string } | null {
  // Try lookup by id first (works for both UUID and non-UUID primary keys)
  const byId = getDb()
    .select({ id: schema.concepts.id, title: schema.concepts.title })
    .from(schema.concepts)
    .where(eq(schema.concepts.id, input))
    .get();
  if (byId) return byId;

  // Fall back to vault note path lookup
  const byPath = getDb()
    .select({ id: schema.concepts.id, title: schema.concepts.title })
    .from(schema.concepts)
    .where(eq(schema.concepts.vaultNotePath, input))
    .get();
  return byPath ?? null;
}

export function recordConceptDelivery(args: RecordArgs): RecordResult {
  const resolved = resolveConceptId(args.concept);
  if (!resolved) return { ok: false, error: `Concept not found: ${args.concept}` };
  getDb().insert(schema.deliveredConcepts).values({
    id: randomUUID(),
    conceptId: resolved.id,
    chatJid: args.chatJid,
    sourceTaskId: args.sourceTaskId ?? null,
    surface: args.surface ?? null,
    deliveredAt: new Date().toISOString(),
  }).run();
  return { ok: true, conceptId: resolved.id, title: resolved.title };
}

export type RecentDelivery = {
  conceptId: string;
  title: string;
  vaultNotePath: string | null;
  deliveredAt: string;
};

export function getRecentDeliveredConcepts(
  chatJid: string,
  days: number,
): RecentDelivery[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return getDb()
    .select({
      conceptId: schema.deliveredConcepts.conceptId,
      title: schema.concepts.title,
      vaultNotePath: schema.concepts.vaultNotePath,
      deliveredAt: schema.deliveredConcepts.deliveredAt,
    })
    .from(schema.deliveredConcepts)
    .innerJoin(
      schema.concepts,
      eq(schema.concepts.id, schema.deliveredConcepts.conceptId),
    )
    .where(
      and(
        eq(schema.deliveredConcepts.chatJid, chatJid),
        gte(schema.deliveredConcepts.deliveredAt, cutoff),
      ),
    )
    .orderBy(desc(schema.deliveredConcepts.deliveredAt))
    .all();
}
