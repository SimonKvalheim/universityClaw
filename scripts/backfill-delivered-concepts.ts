#!/usr/bin/env tsx
import { eq, and } from 'drizzle-orm';
import { initDatabase, getDb } from '../src/db/index.js';
import * as schema from '../src/db/schema/index.js';
import { recordConceptDelivery } from '../src/db/delivered-concepts.js';

initDatabase();

const CONCEPT_PATH_RE = /concepts\/[a-z0-9-]+\.md/g;
const TELEGRAM_MAIN_JID = process.env.TELEGRAM_MAIN_JID;
if (!TELEGRAM_MAIN_JID) {
  console.error('Set TELEGRAM_MAIN_JID env var to the main chat jid.');
  process.exit(1);
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function alreadyHaveRow(conceptId: string, chatJid: string, day: string): boolean {
  const dayStart = `${day}T00:00:00.000Z`;
  const dayEnd = `${day}T23:59:59.999Z`;
  const existing = getDb()
    .select({ id: schema.deliveredConcepts.id, at: schema.deliveredConcepts.deliveredAt })
    .from(schema.deliveredConcepts)
    .where(
      and(
        eq(schema.deliveredConcepts.conceptId, conceptId),
        eq(schema.deliveredConcepts.chatJid, chatJid),
      ),
    )
    .all()
    .find((r) => r.at >= dayStart && r.at <= dayEnd);
  return !!existing;
}

const runs = getDb().select().from(schema.task_run_logs).all();
let attempted = 0,
  inserted = 0,
  skipped = 0;

for (const run of runs) {
  if (run.status !== 'success' || !run.result) continue;
  const matches = run.result.match(CONCEPT_PATH_RE);
  if (!matches) continue;
  for (const path of new Set(matches)) {
    attempted++;
    const concept = getDb()
      .select({ id: schema.concepts.id })
      .from(schema.concepts)
      .where(eq(schema.concepts.vaultNotePath, path))
      .get();
    if (!concept) {
      skipped++;
      continue;
    }
    if (alreadyHaveRow(concept.id, TELEGRAM_MAIN_JID, dayKey(run.run_at))) {
      skipped++;
      continue;
    }
    const res = recordConceptDelivery({
      concept: path,
      chatJid: TELEGRAM_MAIN_JID,
      sourceTaskId: run.task_id,
      surface: 'text+voice',
      deliveredAt: run.run_at,
    });
    if (res.ok) inserted++;
    else skipped++;
  }
}

console.log(`Backfill: attempted=${attempted} inserted=${inserted} skipped=${skipped}.`);
process.exit(0);
