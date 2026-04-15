import { eq, and, lte, desc, sql, isNull, asc, gte, inArray } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import * as schema from '../db/schema/index.js';
import {
  computeMastery,
  computeOverallMastery,
  computeBloomCeiling,
} from './mastery.js';
import { sm2, computeDueDate } from './sm2.js';
import type {
  BloomLevel,
  MasteryActivityInput,
  MasteryState,
} from './types.js';

// ====================================================================
// Derived types from schema
// ====================================================================

export type Concept = typeof schema.concepts.$inferSelect;
export type NewConcept = typeof schema.concepts.$inferInsert;

export type LearningActivity = typeof schema.learningActivities.$inferSelect;
export type NewLearningActivity = typeof schema.learningActivities.$inferInsert;

export type ActivityLogEntry = typeof schema.activityLog.$inferSelect;
export type NewActivityLogEntry = typeof schema.activityLog.$inferInsert;

export type StudySession = typeof schema.studySessions.$inferSelect;
export type NewStudySession = typeof schema.studySessions.$inferInsert;

export type StudyPlan = typeof schema.studyPlans.$inferSelect;
export type NewStudyPlan = typeof schema.studyPlans.$inferInsert;

// ====================================================================
// Concepts
// ====================================================================

export function createConcept(concept: NewConcept): void {
  getDb().insert(schema.concepts).values(concept).run();
}

export function getConceptById(id: string): Concept | undefined {
  return getDb()
    .select()
    .from(schema.concepts)
    .where(eq(schema.concepts.id, id))
    .get();
}

export function getConceptByVaultPath(
  vaultNotePath: string,
): Concept | undefined {
  return getDb()
    .select()
    .from(schema.concepts)
    .where(eq(schema.concepts.vaultNotePath, vaultNotePath))
    .get();
}

export function getConceptsByDomain(domain: string): Concept[] {
  return getDb()
    .select()
    .from(schema.concepts)
    .where(eq(schema.concepts.domain, domain))
    .orderBy(asc(schema.concepts.title))
    .all();
}

export function getConceptsByStatus(status: string): Concept[] {
  return getDb()
    .select()
    .from(schema.concepts)
    .where(eq(schema.concepts.status, status))
    .orderBy(asc(schema.concepts.title))
    .all();
}

export function getPendingConcepts(): Concept[] {
  return getConceptsByStatus('pending');
}

export function getActiveConcepts(): Concept[] {
  return getConceptsByStatus('active');
}

export function getConceptsAboveBloomCeiling(minCeiling: number): Concept[] {
  return getDb()
    .select()
    .from(schema.concepts)
    .where(
      and(
        eq(schema.concepts.status, 'active'),
        gte(schema.concepts.bloomCeiling, minCeiling),
      ),
    )
    .orderBy(asc(schema.concepts.title))
    .all();
}

export function updateConceptStatus(id: string, status: string): void {
  getDb()
    .update(schema.concepts)
    .set({ status })
    .where(eq(schema.concepts.id, id))
    .run();
}

export function updateConceptMastery(
  id: string,
  masteryLevels: {
    L1: number;
    L2: number;
    L3: number;
    L4: number;
    L5: number;
    L6: number;
  },
  overall: number,
  bloomCeiling: number,
): void {
  getDb()
    .update(schema.concepts)
    .set({
      masteryL1: masteryLevels.L1,
      masteryL2: masteryLevels.L2,
      masteryL3: masteryLevels.L3,
      masteryL4: masteryLevels.L4,
      masteryL5: masteryLevels.L5,
      masteryL6: masteryLevels.L6,
      masteryOverall: overall,
      bloomCeiling,
      lastActivityAt: new Date().toISOString(),
    })
    .where(eq(schema.concepts.id, id))
    .run();
}

// ====================================================================
// Learning Activities
// ====================================================================

export function createActivity(activity: NewLearningActivity): void {
  getDb().insert(schema.learningActivities).values(activity).run();
}

export function getActivityById(id: string): LearningActivity | undefined {
  return getDb()
    .select()
    .from(schema.learningActivities)
    .where(eq(schema.learningActivities.id, id))
    .get();
}

export function getDueActivities(beforeDate?: string): LearningActivity[] {
  const cutoff = beforeDate ?? new Date().toISOString().slice(0, 10);
  return getDb()
    .select()
    .from(schema.learningActivities)
    .where(lte(schema.learningActivities.dueAt, cutoff))
    .orderBy(asc(schema.learningActivities.dueAt))
    .all();
}

export function getActivitiesByConceptAndType(
  conceptId: string,
  activityType: string,
): LearningActivity[] {
  return getDb()
    .select()
    .from(schema.learningActivities)
    .where(
      and(
        eq(schema.learningActivities.conceptId, conceptId),
        eq(schema.learningActivities.activityType, activityType),
      ),
    )
    .all();
}

export function getActivitiesByConcept(conceptId: string): LearningActivity[] {
  return getDb()
    .select()
    .from(schema.learningActivities)
    .where(eq(schema.learningActivities.conceptId, conceptId))
    .orderBy(asc(schema.learningActivities.bloomLevel))
    .all();
}

export function batchCreateActivities(
  activities: NewLearningActivity[],
): void {
  if (activities.length === 0) return;
  getDb().transaction((tx) => {
    for (const activity of activities) {
      tx.insert(schema.learningActivities).values(activity).run();
    }
  });
}

export function createActivityConceptLinks(
  activityId: string,
  conceptIds: string[],
  role = 'related',
): void {
  if (conceptIds.length === 0) return;
  getDb().transaction((tx) => {
    for (const conceptId of conceptIds) {
      tx.insert(schema.activityConcepts)
        .values({ activityId, conceptId, role })
        .onConflictDoNothing()
        .run();
    }
  });
}

// ====================================================================
// Activity Log
// ====================================================================

export function createActivityLogEntry(entry: NewActivityLogEntry): void {
  getDb().insert(schema.activityLog).values(entry).run();
}

export function getLogsByConceptAndLevel(
  conceptId: string,
  bloomLevel?: number,
): ActivityLogEntry[] {
  const db = getDb();
  if (bloomLevel !== undefined) {
    return db
      .select()
      .from(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.conceptId, conceptId),
          eq(schema.activityLog.bloomLevel, bloomLevel),
        ),
      )
      .orderBy(desc(schema.activityLog.reviewedAt))
      .all();
  }
  return db
    .select()
    .from(schema.activityLog)
    .where(eq(schema.activityLog.conceptId, conceptId))
    .orderBy(desc(schema.activityLog.reviewedAt))
    .all();
}

export function getLogsBySession(sessionId: string): ActivityLogEntry[] {
  return getDb()
    .select()
    .from(schema.activityLog)
    .where(eq(schema.activityLog.sessionId, sessionId))
    .orderBy(asc(schema.activityLog.reviewedAt))
    .all();
}

export function getRecentActivityLogs(
  conceptId: string,
  limit: number,
): ActivityLogEntry[] {
  return getDb()
    .select()
    .from(schema.activityLog)
    .where(eq(schema.activityLog.conceptId, conceptId))
    .orderBy(desc(schema.activityLog.reviewedAt))
    .limit(limit)
    .all();
}

// ====================================================================
// Study Sessions
// ====================================================================

export function createStudySession(session: NewStudySession): void {
  getDb().insert(schema.studySessions).values(session).run();
}

export function getStudySessionById(id: string): StudySession | undefined {
  return getDb()
    .select()
    .from(schema.studySessions)
    .where(eq(schema.studySessions.id, id))
    .get();
}

export function updateStudySession(
  id: string,
  partialUpdates: Partial<StudySession>,
): void {
  getDb()
    .update(schema.studySessions)
    .set(partialUpdates)
    .where(eq(schema.studySessions.id, id))
    .run();
}

export function getActiveSession(): StudySession | undefined {
  return getDb()
    .select()
    .from(schema.studySessions)
    .where(isNull(schema.studySessions.endedAt))
    .orderBy(desc(schema.studySessions.startedAt))
    .limit(1)
    .get();
}

// ====================================================================
// Study Plans
// ====================================================================

export function createStudyPlan(plan: NewStudyPlan): void {
  getDb().insert(schema.studyPlans).values(plan).run();
}

export function getStudyPlanById(id: string): StudyPlan | undefined {
  return getDb()
    .select()
    .from(schema.studyPlans)
    .where(eq(schema.studyPlans.id, id))
    .get();
}

export function getAllStudyPlans(): StudyPlan[] {
  return getDb()
    .select()
    .from(schema.studyPlans)
    .orderBy(desc(schema.studyPlans.createdAt))
    .all();
}

export function updateStudyPlan(
  id: string,
  partialUpdates: Partial<StudyPlan>,
): void {
  getDb()
    .update(schema.studyPlans)
    .set(partialUpdates)
    .where(eq(schema.studyPlans.id, id))
    .run();
}

export function addConceptsToPlan(
  planId: string,
  conceptIds: string[],
  targetBloom?: number,
): void {
  if (conceptIds.length === 0) return;

  const rows = conceptIds.map((conceptId, i) => ({
    planId,
    conceptId,
    targetBloom: targetBloom ?? 6,
    sortOrder: i,
  }));

  getDb().transaction((tx) => {
    for (const row of rows) {
      tx.insert(schema.studyPlanConcepts)
        .values(row)
        .onConflictDoNothing()
        .run();
    }
  });
}

export function getPlanConcepts(planId: string): Concept[] {
  return getDb()
    .select({
      id: schema.concepts.id,
      title: schema.concepts.title,
      domain: schema.concepts.domain,
      subdomain: schema.concepts.subdomain,
      course: schema.concepts.course,
      vaultNotePath: schema.concepts.vaultNotePath,
      status: schema.concepts.status,
      masteryL1: schema.concepts.masteryL1,
      masteryL2: schema.concepts.masteryL2,
      masteryL3: schema.concepts.masteryL3,
      masteryL4: schema.concepts.masteryL4,
      masteryL5: schema.concepts.masteryL5,
      masteryL6: schema.concepts.masteryL6,
      masteryOverall: schema.concepts.masteryOverall,
      bloomCeiling: schema.concepts.bloomCeiling,
      createdAt: schema.concepts.createdAt,
      lastActivityAt: schema.concepts.lastActivityAt,
    })
    .from(schema.concepts)
    .innerJoin(
      schema.studyPlanConcepts,
      eq(schema.concepts.id, schema.studyPlanConcepts.conceptId),
    )
    .where(eq(schema.studyPlanConcepts.planId, planId))
    .orderBy(asc(schema.studyPlanConcepts.sortOrder))
    .all();
}

// ====================================================================
// Complete Activity (transactional)
// ====================================================================

export interface CompleteActivityInput {
  activityId: string;
  quality: number; // 0-5
  sessionId?: string;
  responseText?: string;
  responseTimeMs?: number;
  confidenceRating?: number;
  evaluationMethod?: string;
  aiQuality?: number;
  aiFeedback?: string;
  methodUsed?: string;
  surface?: string;
}

export interface CompleteActivityResult {
  logEntryId: string;
  newDueAt: string;
  masteryUpdated: boolean;
  bloomCeilingBefore: number;
  bloomCeilingAfter: number;
}

/**
 * Complete an activity atomically:
 * 1. Look up the activity (throw if not found)
 * 2. Compute SM-2 update from current state + quality
 * 3. Determine mastery state (new/learning/reviewing/mastered)
 * 4. Update activity's SM-2 fields
 * 5. Insert activity_log entry
 * 6. Recompute concept mastery from ALL logs for this concept
 * 7. Update concept's mastery fields + bloomCeiling
 * 8. Increment session activity count if sessionId provided
 * All within db.transaction().
 */
export function completeActivity(
  input: CompleteActivityInput,
): CompleteActivityResult {
  const now = new Date().toISOString();

  return getDb().transaction((tx) => {
    // Step 1: get activity
    const activity = tx
      .select()
      .from(schema.learningActivities)
      .where(eq(schema.learningActivities.id, input.activityId))
      .get();
    if (!activity) throw new Error(`Activity not found: ${input.activityId}`);

    // Step 2: SM-2
    const sm2Result = sm2({
      quality: input.quality,
      repetitions: activity.repetitions ?? 0,
      easeFactor: activity.easeFactor ?? 2.5,
      intervalDays: activity.intervalDays ?? 1,
    });
    const newDueAt = computeDueDate(sm2Result.intervalDays);

    // Step 3: mastery state heuristic
    let masteryState: MasteryState = 'learning';
    if (sm2Result.repetitions === 0) {
      masteryState = 'learning';
    } else if (sm2Result.intervalDays >= 21) {
      masteryState = 'mastered';
    } else {
      masteryState = 'reviewing';
    }

    // Step 4: update activity
    tx.update(schema.learningActivities)
      .set({
        easeFactor: sm2Result.easeFactor,
        intervalDays: sm2Result.intervalDays,
        repetitions: sm2Result.repetitions,
        dueAt: newDueAt,
        lastReviewed: now,
        lastQuality: input.quality,
        masteryState,
      })
      .where(eq(schema.learningActivities.id, input.activityId))
      .run();

    // Step 5: log entry
    const logEntryId = crypto.randomUUID();
    tx.insert(schema.activityLog)
      .values({
        id: logEntryId,
        activityId: input.activityId,
        conceptId: activity.conceptId,
        activityType: activity.activityType,
        bloomLevel: activity.bloomLevel,
        quality: input.quality,
        responseText: input.responseText ?? null,
        responseTimeMs: input.responseTimeMs ?? null,
        confidenceRating: input.confidenceRating ?? null,
        evaluationMethod: input.evaluationMethod ?? 'self_rated',
        aiQuality: input.aiQuality ?? null,
        aiFeedback: input.aiFeedback ?? null,
        methodUsed: input.methodUsed ?? null,
        surface: input.surface ?? null,
        sessionId: input.sessionId ?? null,
        reviewedAt: now,
      })
      .run();

    // Step 6: recompute concept mastery from all logs
    const concept = tx
      .select()
      .from(schema.concepts)
      .where(eq(schema.concepts.id, activity.conceptId))
      .get();
    const bloomCeilingBefore = concept?.bloomCeiling ?? 0;

    const allLogs = tx
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.conceptId, activity.conceptId))
      .all();

    const masteryInput: MasteryActivityInput[] = allLogs.map((log) => ({
      bloomLevel: log.bloomLevel as BloomLevel,
      quality: log.quality,
      reviewedAt: log.reviewedAt,
    }));

    const levels = computeMastery(masteryInput);
    const overall = computeOverallMastery(levels);
    const bloomCeiling = computeBloomCeiling(levels);

    // Step 7: update concept
    tx.update(schema.concepts)
      .set({
        masteryL1: levels.L1,
        masteryL2: levels.L2,
        masteryL3: levels.L3,
        masteryL4: levels.L4,
        masteryL5: levels.L5,
        masteryL6: levels.L6,
        masteryOverall: overall,
        bloomCeiling,
        lastActivityAt: now,
      })
      .where(eq(schema.concepts.id, activity.conceptId))
      .run();

    // Step 8: increment session count
    if (input.sessionId) {
      tx.update(schema.studySessions)
        .set({
          activitiesCompleted: sql`${schema.studySessions.activitiesCompleted} + 1`,
        })
        .where(eq(schema.studySessions.id, input.sessionId))
        .run();
    }

    return {
      logEntryId,
      newDueAt,
      masteryUpdated: true,
      bloomCeilingBefore,
      bloomCeilingAfter: bloomCeiling,
    };
  });
}
