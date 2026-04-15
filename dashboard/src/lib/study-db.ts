/**
 * Dashboard-side DB access for the study system.
 *
 * Reads/writes the concepts and learning_activities tables in the shared
 * SQLite database (store/messages.db). Follows the same pattern as
 * ingestion-db.ts: Drizzle ORM over better-sqlite3, snake_case columns
 * mapped to camelCase response interfaces.
 */

import { eq, and, lte, asc, desc, count, sql, inArray } from 'drizzle-orm';
import { getDb } from './db/index';
import { concepts, learning_activities } from './db/schema';

// ---------------------------------------------------------------------------
// Response interfaces (camelCase)
// ---------------------------------------------------------------------------

export interface ConceptSummary {
  id: string;
  title: string;
  domain: string | null;
  subdomain: string | null;
  course: string | null;
  vaultNotePath: string | null;
  status: string;
  masteryOverall: number;
  bloomCeiling: number;
  dueCount: number;
  createdAt: string;
  lastActivityAt: string | null;
}

export interface PendingGroup {
  domain: string | null;
  concepts: Array<{
    id: string;
    title: string;
    subdomain: string | null;
    createdAt: string;
  }>;
}

export interface ConceptStats {
  total: number;
  pending: number;
  active: number;
  domains: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ConceptRow = typeof concepts.$inferSelect;

function rowToSummary(row: ConceptRow, dueCount: number): ConceptSummary {
  return {
    id: row.id,
    title: row.title,
    domain: row.domain ?? null,
    subdomain: row.subdomain ?? null,
    course: row.course ?? null,
    vaultNotePath: row.vault_note_path ?? null,
    status: row.status ?? 'active',
    masteryOverall: row.mastery_overall ?? 0,
    bloomCeiling: row.bloom_ceiling ?? 0,
    dueCount,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Get all active concepts with their due activity counts.
 */
export function getActiveConcepts(): ConceptSummary[] {
  const db = getDb();

  const rows = db
    .select()
    .from(concepts)
    .where(eq(concepts.status, 'active'))
    .orderBy(desc(concepts.last_activity_at))
    .all();

  if (rows.length === 0) return [];

  const today = new Date().toISOString();

  const dueCounts = db
    .select({
      concept_id: learning_activities.concept_id,
      due_count: count(learning_activities.id),
    })
    .from(learning_activities)
    .where(lte(learning_activities.due_at, today))
    .groupBy(learning_activities.concept_id)
    .all();

  const dueMap = new Map<string, number>();
  for (const row of dueCounts) {
    dueMap.set(row.concept_id, row.due_count);
  }

  return rows.map((row) => rowToSummary(row, dueMap.get(row.id) ?? 0));
}

/**
 * Get pending concepts grouped by domain.
 */
export function getPendingConcepts(): PendingGroup[] {
  const db = getDb();

  const rows = db
    .select({
      id: concepts.id,
      title: concepts.title,
      domain: concepts.domain,
      subdomain: concepts.subdomain,
      created_at: concepts.created_at,
    })
    .from(concepts)
    .where(eq(concepts.status, 'pending'))
    .orderBy(asc(concepts.domain), asc(concepts.title))
    .all();

  // Group by domain in JS using a string sentinel for null domains
  const groupMap = new Map<string, PendingGroup>();
  for (const row of rows) {
    const domain = row.domain ?? null;
    const mapKey = domain ?? '\x00null';
    if (!groupMap.has(mapKey)) {
      groupMap.set(mapKey, { domain, concepts: [] });
    }
    groupMap.get(mapKey)!.concepts.push({
      id: row.id,
      title: row.title,
      subdomain: row.subdomain ?? null,
      createdAt: row.created_at,
    });
  }

  return Array.from(groupMap.values());
}

/**
 * Approve a list of concept IDs (pending → active). Returns count changed.
 */
export function approveConcepts(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();

  const result = db
    .update(concepts)
    .set({ status: 'active' })
    .where(and(inArray(concepts.id, ids), eq(concepts.status, 'pending')))
    .run();
  return result.changes;
}

/**
 * Approve all pending concepts in a domain. Returns the approved IDs.
 */
export function approveDomain(domain: string): string[] {
  const db = getDb();

  const pending = db
    .select({ id: concepts.id })
    .from(concepts)
    .where(and(eq(concepts.domain, domain), eq(concepts.status, 'pending')))
    .all();

  if (pending.length === 0) return [];

  const ids = pending.map((r) => r.id);
  approveConcepts(ids);
  return ids;
}

/**
 * Return aggregate counts: total concepts, pending, active, distinct domains.
 */
export function getConceptStats(): ConceptStats {
  const db = getDb();

  const statusCounts = db
    .select({
      status: concepts.status,
      cnt: count(concepts.id),
    })
    .from(concepts)
    .groupBy(concepts.status)
    .all();

  let total = 0;
  let pending = 0;
  let active = 0;
  for (const row of statusCounts) {
    const n = row.cnt;
    total += n;
    if (row.status === 'pending') pending = n;
    if (row.status === 'active') active = n;
  }

  const domainRow = db
    .select({ domains: sql<number>`count(distinct ${concepts.domain})` })
    .from(concepts)
    .where(eq(concepts.status, 'active'))
    .get();

  const domains = domainRow?.domains ?? 0;

  return { total, pending, active, domains };
}
