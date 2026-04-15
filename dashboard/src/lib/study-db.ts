/**
 * Dashboard-side DB access for the study system.
 *
 * Reads/writes the concepts and learning_activities tables in the shared
 * SQLite database (store/messages.db). Follows the same pattern as
 * ingestion-db.ts: Drizzle ORM over better-sqlite3, snake_case columns
 * mapped to camelCase response interfaces.
 */

import { eq, and, lte, asc, desc, count, sql, inArray, isNull } from 'drizzle-orm';
import { getDb } from './db/index';
import { concepts, learning_activities, study_sessions, activity_log } from './db/schema';
import {
  sm2,
  computeDueDate,
  computeMastery,
  computeBloomCeiling,
  computeOverallMastery,
  type BloomLevel,
  type MasteryActivityInput,
} from './study-algorithms';

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
  masteryL1: number;
  masteryL2: number;
  masteryL3: number;
  masteryL4: number;
  masteryL5: number;
  masteryL6: number;
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

export type ActivityRow = typeof learning_activities.$inferSelect;
export type SessionRow = typeof study_sessions.$inferSelect;
export type LogRow = typeof activity_log.$inferSelect;

export interface NewSession {
  id: string;
  startedAt: string;
  sessionType: string;
  preConfidence?: string;
  surface?: string;
}

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
    masteryL1: row.mastery_L1 ?? 0,
    masteryL2: row.mastery_L2 ?? 0,
    masteryL3: row.mastery_L3 ?? 0,
    masteryL4: row.mastery_L4 ?? 0,
    masteryL5: row.mastery_L5 ?? 0,
    masteryL6: row.mastery_L6 ?? 0,
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

// ---------------------------------------------------------------------------
// Completion interfaces
// ---------------------------------------------------------------------------

export interface CompleteActivityInput {
  activityId: string;
  quality: number; // 0-5
  sessionId?: string;
  responseText?: string;
  responseTimeMs?: number;
  confidenceRating?: number;
  surface?: string;
}

export interface CompleteActivityResult {
  logEntryId: string;
  newDueAt: string;
  bloomCeilingBefore: number;
  bloomCeilingAfter: number;
}

export interface CompletionResult {
  logEntryId: string;
  newDueAt: string;
  advancement: { conceptId: string; conceptTitle: string; previousCeiling: number; newCeiling: number; generationNeeded: boolean } | null;
  generationNeeded: boolean;
  deEscalation: string | null;
}

// ---------------------------------------------------------------------------
// completeActivity — full SM-2 + mastery update in one transaction
// ---------------------------------------------------------------------------

/**
 * Complete an activity atomically:
 * 1. Look up the activity (throw if not found)
 * 2. Compute SM-2 update + new due date
 * 3. Determine mastery state (learning / reviewing / mastered)
 * 4. Update activity row (SM-2 fields + mastery_state)
 * 5. Insert activity_log entry
 * 6. Recompute concept mastery from ALL logs for this concept
 * 7. Update concept's mastery fields + bloom_ceiling + last_activity_at
 * 8. Increment session activities_completed if sessionId provided
 */
export function completeActivity(input: CompleteActivityInput): CompleteActivityResult {
  const now = new Date().toISOString();

  return getDb().transaction((tx) => {
    // Step 1: get activity
    const activity = tx
      .select()
      .from(learning_activities)
      .where(eq(learning_activities.id, input.activityId))
      .get();
    if (!activity) throw new Error(`Activity not found: ${input.activityId}`);

    // Step 2: SM-2
    const sm2Result = sm2({
      quality: input.quality,
      repetitions: activity.repetitions ?? 0,
      easeFactor: activity.ease_factor ?? 2.5,
      intervalDays: activity.interval_days ?? 1,
    });
    const newDueAt = computeDueDate(sm2Result.intervalDays);

    // Step 3: mastery state heuristic
    let masteryState: string = 'learning';
    if (sm2Result.repetitions === 0) {
      masteryState = 'learning';
    } else if (sm2Result.intervalDays >= 21) {
      masteryState = 'mastered';
    } else {
      masteryState = 'reviewing';
    }

    // Step 4: update activity
    tx.update(learning_activities)
      .set({
        ease_factor: sm2Result.easeFactor,
        interval_days: sm2Result.intervalDays,
        repetitions: sm2Result.repetitions,
        due_at: newDueAt,
        last_reviewed: now,
        last_quality: input.quality,
        mastery_state: masteryState,
      })
      .where(eq(learning_activities.id, input.activityId))
      .run();

    // Step 5: insert activity_log entry
    const logEntryId = crypto.randomUUID();
    tx.insert(activity_log)
      .values({
        id: logEntryId,
        activity_id: input.activityId,
        concept_id: activity.concept_id,
        activity_type: activity.activity_type,
        bloom_level: activity.bloom_level,
        quality: input.quality,
        response_text: input.responseText ?? null,
        response_time_ms: input.responseTimeMs ?? null,
        confidence_rating: input.confidenceRating ?? null,
        evaluation_method: 'self_rated',
        ai_quality: null,
        ai_feedback: null,
        method_used: null,
        surface: input.surface ?? null,
        session_id: input.sessionId ?? null,
        reviewed_at: now,
      })
      .run();

    // Step 6: recompute concept mastery from all logs
    const concept = tx
      .select()
      .from(concepts)
      .where(eq(concepts.id, activity.concept_id))
      .get();
    const bloomCeilingBefore = concept?.bloom_ceiling ?? 0;

    const allLogs = tx
      .select()
      .from(activity_log)
      .where(eq(activity_log.concept_id, activity.concept_id))
      .all();

    const masteryInput: MasteryActivityInput[] = allLogs.map((log) => ({
      bloomLevel: log.bloom_level as BloomLevel,
      quality: log.quality,
      reviewedAt: log.reviewed_at,
    }));

    const levels = computeMastery(masteryInput);
    const overall = computeOverallMastery(levels);
    const bloomCeilingAfter = computeBloomCeiling(levels);

    // Step 7: update concept mastery fields
    tx.update(concepts)
      .set({
        mastery_L1: levels.L1,
        mastery_L2: levels.L2,
        mastery_L3: levels.L3,
        mastery_L4: levels.L4,
        mastery_L5: levels.L5,
        mastery_L6: levels.L6,
        mastery_overall: overall,
        bloom_ceiling: bloomCeilingAfter,
        last_activity_at: now,
      })
      .where(eq(concepts.id, activity.concept_id))
      .run();

    // Step 8: increment session activity count
    if (input.sessionId) {
      tx.update(study_sessions)
        .set({
          activities_completed: sql`${study_sessions.activities_completed} + 1`,
        })
        .where(eq(study_sessions.id, input.sessionId))
        .run();
    }

    return { logEntryId, newDueAt, bloomCeilingBefore, bloomCeilingAfter };
  });
}

// ---------------------------------------------------------------------------
// processCompletion — wraps completeActivity with advancement + de-escalation
// ---------------------------------------------------------------------------

/**
 * Completes an activity and returns the full engine-level result including
 * Bloom advancement detection and de-escalation advice.
 */
export function processCompletion(input: CompleteActivityInput): CompletionResult {
  const db = getDb();

  // Look up activity first to get concept_id (throws if not found)
  const activity = db
    .select()
    .from(learning_activities)
    .where(eq(learning_activities.id, input.activityId))
    .get();
  if (!activity) throw new Error(`Activity not found: ${input.activityId}`);

  const conceptId = activity.concept_id;

  // Delegate to completeActivity — runs full SM-2 + mastery update atomically
  const { logEntryId, newDueAt, bloomCeilingBefore, bloomCeilingAfter } =
    completeActivity(input);

  let advancement: CompletionResult['advancement'] = null;
  let generationNeeded = false;

  if (bloomCeilingAfter > bloomCeilingBefore) {
    const concept = db
      .select()
      .from(concepts)
      .where(eq(concepts.id, conceptId))
      .get();

    // Check if activities already exist at the new ceiling level
    const existingAtLevel = db
      .select({ id: learning_activities.id })
      .from(learning_activities)
      .where(
        and(
          eq(learning_activities.concept_id, conceptId),
          sql`${learning_activities.bloom_level} >= ${bloomCeilingAfter}`,
        ),
      )
      .limit(1)
      .all();

    generationNeeded = existingAtLevel.length === 0;

    advancement = {
      conceptId,
      conceptTitle: concept?.title ?? conceptId,
      previousCeiling: bloomCeilingBefore,
      newCeiling: bloomCeilingAfter,
      generationNeeded,
    };
  }

  // De-escalation: check last 5 logs for this concept
  const recentLogs = db
    .select()
    .from(activity_log)
    .where(eq(activity_log.concept_id, conceptId))
    .orderBy(desc(activity_log.reviewed_at))
    .limit(5)
    .all();

  let deEscalation: string | null = null;
  if (recentLogs.length >= 3) {
    const avgQuality =
      recentLogs.reduce((sum, log) => sum + log.quality, 0) / recentLogs.length;

    const concept = db
      .select()
      .from(concepts)
      .where(eq(concepts.id, conceptId))
      .get();

    if (avgQuality < 2.5 && (concept?.bloom_ceiling ?? 0) > 1) {
      deEscalation =
        `You've been finding "${concept?.title ?? conceptId}" difficult recently ` +
        `(average quality ${avgQuality.toFixed(1)}/5). ` +
        `Consider reviewing foundational activities at a lower Bloom level ` +
        `before pushing higher.`;
    }
  }

  return { logEntryId, newDueAt, advancement, generationNeeded, deEscalation };
}

// ---------------------------------------------------------------------------
// Activity queries
// ---------------------------------------------------------------------------

/**
 * Activities due on or before today (YYYY-MM-DD), ordered by due_at asc.
 */
export function getDueActivities(): ActivityRow[] {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  return db
    .select()
    .from(learning_activities)
    .where(lte(learning_activities.due_at, today))
    .orderBy(asc(learning_activities.due_at))
    .all();
}

/**
 * Full activity row by ID.
 */
export function getActivityById(id: string): ActivityRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(learning_activities)
    .where(eq(learning_activities.id, id))
    .get();
}

/**
 * All activities for a concept, ordered by bloom_level asc.
 */
export function getActivitiesByConceptId(conceptId: string): ActivityRow[] {
  const db = getDb();
  return db
    .select()
    .from(learning_activities)
    .where(eq(learning_activities.concept_id, conceptId))
    .orderBy(asc(learning_activities.bloom_level))
    .all();
}

/**
 * Last N activity_log entries for a concept, ordered by reviewed_at desc.
 */
export function getRecentLogs(conceptId: string, limit: number): LogRow[] {
  const db = getDb();
  return db
    .select()
    .from(activity_log)
    .where(eq(activity_log.concept_id, conceptId))
    .orderBy(desc(activity_log.reviewed_at))
    .limit(limit)
    .all();
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

/**
 * Insert a new study session.
 */
export function createSession(session: NewSession): void {
  const db = getDb();
  db.insert(study_sessions)
    .values({
      id: session.id,
      started_at: session.startedAt,
      session_type: session.sessionType,
      pre_confidence: session.preConfidence ?? null,
      surface: session.surface ?? null,
    })
    .run();
}

/**
 * Read a session by ID.
 */
export function getSessionById(id: string): SessionRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(study_sessions)
    .where(eq(study_sessions.id, id))
    .get();
}

/**
 * Update session fields by ID.
 */
export function updateSession(id: string, updates: Partial<SessionRow>): void {
  const db = getDb();
  db.update(study_sessions).set(updates).where(eq(study_sessions.id, id)).run();
}

/**
 * Most recent sessions, ordered by started_at desc.
 */
export function getRecentSessions(limit: number): SessionRow[] {
  const db = getDb();
  return db
    .select()
    .from(study_sessions)
    .orderBy(desc(study_sessions.started_at))
    .limit(limit)
    .all();
}

/**
 * Most recent session with no ended_at (currently active).
 */
export function getActiveSession(): SessionRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(study_sessions)
    .where(isNull(study_sessions.ended_at))
    .orderBy(desc(study_sessions.started_at))
    .limit(1)
    .get();
}

/**
 * Count consecutive days from today backwards that have at least one completed
 * session (ended_at IS NOT NULL).
 */
export function getStreakDays(): number {
  const db = getDb();

  const rows = db.all<{ day: string }>(
    sql`SELECT date(ended_at) as day
        FROM study_sessions
        WHERE ended_at IS NOT NULL
        GROUP BY date(ended_at)
        ORDER BY day DESC`,
  );

  if (rows.length === 0) return 0;

  let streak = 0;
  const msPerDay = 86400000;
  const todayMs = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const firstRowMs = new Date(rows[0].day).getTime();

  // Allow most recent day to be today or yesterday (streak shouldn't reset before studying today)
  const offset = firstRowMs === todayMs ? 0 : firstRowMs === todayMs - msPerDay ? 1 : -1;
  if (offset === -1) return 0; // most recent day is older than yesterday

  for (let i = 0; i < rows.length; i++) {
    const expectedMs = todayMs - (i + offset) * msPerDay;
    const rowMs = new Date(rows[i].day).getTime();
    if (rowMs !== expectedMs) break;
    streak++;
  }

  return streak;
}

/**
 * Activity logs for a session, ordered by reviewed_at asc.
 */
export function getLogsBySession(sessionId: string): LogRow[] {
  const db = getDb();
  return db
    .select()
    .from(activity_log)
    .where(eq(activity_log.session_id, sessionId))
    .orderBy(asc(activity_log.reviewed_at))
    .all();
}
