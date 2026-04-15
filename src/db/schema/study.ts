import {
  index, integer, primaryKey, real, sqliteTable, text,
} from 'drizzle-orm/sqlite-core';

// ====================================================================
// Concepts — the central learning entity
// ====================================================================

export const concepts = sqliteTable(
  'concepts',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    domain: text('domain'),
    subdomain: text('subdomain'),
    course: text('course'),
    vaultNotePath: text('vault_note_path'),

    status: text('status').default('active'),

    // Weighted evidence mastery (per Bloom's level)
    masteryL1: real('mastery_L1').default(0.0),
    masteryL2: real('mastery_L2').default(0.0),
    masteryL3: real('mastery_L3').default(0.0),
    masteryL4: real('mastery_L4').default(0.0),
    masteryL5: real('mastery_L5').default(0.0),
    masteryL6: real('mastery_L6').default(0.0),
    masteryOverall: real('mastery_overall').default(0.0),

    // Progression state (D3: highest mastered level, 0 = none)
    bloomCeiling: integer('bloom_ceiling').default(0),

    createdAt: text('created_at').notNull(),
    lastActivityAt: text('last_activity_at'),
  },
  (table) => ({
    idxConceptsDomain: index('idx_concepts_domain').on(table.domain),
    idxConceptsStatus: index('idx_concepts_status').on(table.status),
  }),
);

// ====================================================================
// Concept Prerequisites
// ====================================================================

export const conceptPrerequisites = sqliteTable(
  'concept_prerequisites',
  {
    conceptId: text('concept_id').notNull().references(() => concepts.id),
    prerequisiteId: text('prerequisite_id').notNull().references(() => concepts.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.conceptId, table.prerequisiteId] }),
  }),
);

// ====================================================================
// Study Plans
// ====================================================================

export const studyPlans = sqliteTable('study_plans', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  domain: text('domain'),
  course: text('course'),
  strategy: text('strategy').notNull().default('open'),

  learningObjectives: text('learning_objectives'),  // JSON array
  desiredOutcomes: text('desired_outcomes'),

  implementationIntention: text('implementation_intention'),
  obstacle: text('obstacle'),
  studySchedule: text('study_schedule'),

  config: text('config'),  // JSON
  checkpointIntervalDays: integer('checkpoint_interval_days').default(14),
  nextCheckpointAt: text('next_checkpoint_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  status: text('status').default('active'),
});

// ====================================================================
// Study Plan <-> Concept join
// ====================================================================

export const studyPlanConcepts = sqliteTable(
  'study_plan_concepts',
  {
    planId: text('plan_id').notNull().references(() => studyPlans.id),
    conceptId: text('concept_id').notNull().references(() => concepts.id),
    targetBloom: integer('target_bloom').default(6),
    sortOrder: integer('sort_order').default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.planId, table.conceptId] }),
  }),
);

// ====================================================================
// Study Sessions
// ====================================================================

export const studySessions = sqliteTable('study_sessions', {
  id: text('id').primaryKey(),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  sessionType: text('session_type').notNull(),
  planId: text('plan_id').references(() => studyPlans.id),

  preConfidence: text('pre_confidence'),    // JSON
  postReflection: text('post_reflection'),
  calibrationScore: real('calibration_score'),

  activitiesCompleted: integer('activities_completed').default(0),
  totalTimeMs: integer('total_time_ms'),
  surface: text('surface'),
});

// ====================================================================
// Learning Activities — schedulable study units
// ====================================================================

export const learningActivities = sqliteTable(
  'learning_activities',
  {
    id: text('id').primaryKey(),
    conceptId: text('concept_id').notNull().references(() => concepts.id),

    activityType: text('activity_type').notNull(),
    prompt: text('prompt').notNull(),
    referenceAnswer: text('reference_answer'),
    bloomLevel: integer('bloom_level').notNull(),
    difficultyEstimate: integer('difficulty_estimate').default(5),

    cardType: text('card_type'),
    author: text('author').default('system'),

    sourceNotePath: text('source_note_path'),
    sourceChunkHash: text('source_chunk_hash'),
    generatedAt: text('generated_at').notNull(),

    // SM-2 scheduling
    easeFactor: real('ease_factor').default(2.5),
    intervalDays: integer('interval_days').default(1),
    repetitions: integer('repetitions').default(0),
    dueAt: text('due_at').notNull(),
    lastReviewed: text('last_reviewed'),
    lastQuality: integer('last_quality'),
    masteryState: text('mastery_state').default('new'),
  },
  (table) => ({
    idxActivitiesDue: index('idx_activities_due').on(table.dueAt),
    idxActivitiesConcept: index('idx_activities_concept').on(table.conceptId),
    idxActivitiesType: index('idx_activities_type').on(table.activityType),
  }),
);

// ====================================================================
// Activity <-> Concept join (multi-concept activities)
// ====================================================================

export const activityConcepts = sqliteTable(
  'activity_concepts',
  {
    activityId: text('activity_id').notNull().references(() => learningActivities.id),
    conceptId: text('concept_id').notNull().references(() => concepts.id),
    role: text('role').default('related'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.activityId, table.conceptId] }),
  }),
);

// ====================================================================
// Activity Log — every interaction
// ====================================================================

export const activityLog = sqliteTable(
  'activity_log',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id').notNull().references(() => learningActivities.id),
    conceptId: text('concept_id').notNull(),
    activityType: text('activity_type').notNull(),
    bloomLevel: integer('bloom_level').notNull(),

    quality: integer('quality').notNull(),
    responseText: text('response_text'),
    responseTimeMs: integer('response_time_ms'),

    confidenceRating: integer('confidence_rating'),

    scaffoldingLevel: integer('scaffolding_level').default(0),
    evaluationMethod: text('evaluation_method').default('self_rated'),
    aiQuality: integer('ai_quality'),
    aiFeedback: text('ai_feedback'),

    methodUsed: text('method_used'),

    surface: text('surface'),
    sessionId: text('session_id').references(() => studySessions.id),
    reviewedAt: text('reviewed_at').notNull(),
  },
  (table) => ({
    idxLogConcept: index('idx_log_concept').on(table.conceptId),
    idxLogSession: index('idx_log_session').on(table.sessionId),
    idxLogBloom: index('idx_log_bloom').on(table.bloomLevel),
  }),
);
