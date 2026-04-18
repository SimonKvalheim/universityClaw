# S1: Study Engine Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Your role:** You are the engineer implementing this. The plan tells you *what* to build and *why*. You decide *how* within the stated constraints. If you disagree with an approach or see a better alternative, flag it before implementing — don't silently deviate and don't silently comply with something you think is wrong.

**Goal:** Create the study system database tables, SM-2 scheduling algorithm, weighted evidence mastery model, study query functions, and group directory scaffolds — everything downstream sprints (S2-S8) depend on.

**Architecture:** Study tables defined as Drizzle schema in `src/db/schema/study.ts`, migration generated via `drizzle-kit generate`. Pure algorithm modules (`sm2.ts`, `mastery.ts`) have zero DB or side-effect dependencies. Query functions live in `src/study/queries.ts` using the existing Drizzle `getDb()` pattern from `src/db/index.ts`. Types derived from Drizzle schemas via `$inferSelect`/`$inferInsert` — no hand-written row interfaces.

**Tech Stack:** Drizzle ORM (better-sqlite3), Vitest, TypeScript

**Branch:** Create `feat/s1-study-engine` off `main`. S0 (Drizzle migration) is already merged via PR #27.

**Spec:** `docs/superpowers/specs/2026-04-12-multi-method-study-system-design.md` (v2.1, Sections 3.1, 3.2, 4.1, 4.2)

**Master plan:** `docs/superpowers/plans/2026-04-13-study-system-master-plan.md` (S1 checklist)

**Spec deviations (intentional — do not "fix" these to match the spec):**
- **D3:** The spec's SQL shows `bloom_ceiling INTEGER DEFAULT 1`. This plan uses `DEFAULT 0` (meaning "no level mastered yet"). The spec's comment says "highest Bloom's level with sufficient mastery" which is 0 when nothing is mastered. The default value in the spec SQL is a minor error; this plan's value is correct.
- **`SM2Result` type:** Defined in `sm2.ts` alongside the algorithm, NOT in `types.ts`. This keeps the SM-2 module self-contained with zero imports from the study subsystem. `types.ts` holds mastery types and forward-declared types for later sprints.

---

## Essential Reading

Study these files before writing any code. You need to understand the patterns and conventions in the existing codebase — not just what this plan says.

| File | Why |
|------|-----|
| `src/db/schema/tasks.ts` | Drizzle table definition pattern: `sqliteTable()`, column types, index builder, FK references |
| `src/db/schema/chats.ts` | Same, plus composite primary key pattern |
| `src/db/index.ts` | `getDb()` accessor, `_initTestDatabase()` / `_closeDatabase()` test helpers, existing query function patterns (how CRUD is structured, how `onConflictDoUpdate` is used, how transactions could work) |
| `src/db/migrate.ts` | Migration runner (called on startup, reads from `drizzle/migrations/`) |
| `drizzle.config.ts` | Drizzle Kit config — schema glob path, migration output dir |
| `src/db-migration.test.ts` | Migration test pattern — creates fresh DB, checks tables and columns exist |
| `vitest.config.ts` | Test file discovery pattern (`src/**/*.test.ts`) |
| Spec Section 3.1 (lines 248-441) | The SQL CREATE TABLE statements these schemas must match |
| Spec Section 4.1-4.2 (lines 511-571) | The SM-2 and mastery algorithm pseudocode |

---

## Key Decisions

### D1: Study queries live in `src/study/`, not `src/db/`

`src/db/index.ts` contains all existing NanoClaw query functions (~45 functions, ~1100 lines). The study system adds another ~25 functions. Rather than growing that file further, study queries live in their own module at `src/study/queries.ts`.

**Tradeoff:** Consumers now have two import paths for DB functions (`src/db/index.js` for NanoClaw core, `src/study/queries.js` for study). This is acceptable because the study system is a self-contained subsystem — downstream sprint code (S2-S8) imports from `src/study/` exclusively.

### D2: camelCase Drizzle properties for new study tables

Existing schemas use snake_case properties that mirror SQL column names (`group_folder`, `last_message_time`). New study tables use camelCase properties (`conceptId`, `vaultNotePath`) while still mapping to snake_case SQL columns via `text('vault_note_path')`.

**Why:** The existing tables were a 1:1 transliteration of raw SQL during S0 migration — matching snake_case was the lowest-risk approach. New tables have no legacy to match. camelCase properties are more ergonomic in TypeScript and are Drizzle's recommended convention. The study subsystem is self-contained, so the inconsistency is scoped — you'll never mix `schema.scheduled_tasks.group_folder` and `schema.concepts.vaultNotePath` in the same query.

**Constraint:** SQL column names MUST remain snake_case (the `text('column_name')` argument). Only the TypeScript property names are camelCase.

**This is an explicit user instruction, not an oversight.** Do not "fix" the naming to snake_case to match existing schemas. The schema in Task 2 shows the exact property names to use.

### D3: Bloom ceiling = highest mastered level (not next level)

The spec says: "highest Bloom's level with sufficient mastery." If L1 is mastered, `bloom_ceiling = 1`. If nothing is mastered, `bloom_ceiling = 0`. The engine (S3) will use `bloom_ceiling + 1` to recommend the next level to work toward.

**Why:** The ceiling describes *current state* ("where are you"), not a *directive* ("what to work on next"). State belongs in the DB; directives belong in the engine logic.

### D4: `completeActivity` is a transaction in the query layer

Activity completion touches 3-4 tables (learning_activities SM-2 update, activity_log insert, concepts mastery update, optionally study_sessions count increment). This must be atomic — partial writes produce inconsistent mastery scores.

**Why not a separate service layer?** The study system has exactly one multi-table write operation right now. Adding a service layer for one function is premature abstraction. If S3+ adds more complex workflows, refactor then.

### D5: Types derived from Drizzle, not hand-written

DB row types use `$inferSelect` / `$inferInsert` on the Drizzle schema tables. Non-DB types (algorithm inputs/outputs, enums) live in `src/study/types.ts`. No hand-written interfaces that duplicate column definitions.

**Why:** Single source of truth. When a column is added or renamed in the schema, the type updates automatically.

---

## File Map

### New files

| File | Responsibility |
|------|---------------|
| `src/db/schema/study.ts` | Drizzle table definitions: concepts, concept_prerequisites, learning_activities, activity_concepts, activity_log, study_sessions, study_plans, study_plan_concepts |
| `src/study/types.ts` | Non-DB types: enums/unions, algorithm result interfaces, forward-declared types for later sprints |
| `src/study/sm2.ts` | Pure SM-2 algorithm |
| `src/study/sm2.test.ts` | SM-2 tests (TDD) |
| `src/study/mastery.ts` | Pure weighted evidence mastery |
| `src/study/mastery.test.ts` | Mastery tests (TDD) |
| `src/study/queries.ts` | All study CRUD + transactional `completeActivity` |
| `src/study/queries.test.ts` | Query function tests |
| `src/study/index.ts` | Barrel re-exports |
| `groups/study/CLAUDE.md` | Placeholder study agent prompt |
| `groups/study-generator/CLAUDE.md` | Placeholder generator agent prompt |

### Modified files

| File | Change |
|------|--------|
| `src/db/schema/index.ts` | Add `export * from './study.js'` |
| `src/db-migration.test.ts` | Add study tables to expected tables list |

---

## Task 1: Study Types

**Files:** Create `src/study/types.ts`

Define all non-DB types. DB row types come from Drizzle `$inferSelect` in `queries.ts` (Task 6).

**Agent discretion:** Naming, JSDoc detail level, whether to use `type` aliases or `enum` for the union types. The values themselves are fixed by the spec.

- [ ] **Step 1: Create type definitions**

```typescript
// === Enums / Unions ===
// Values from spec Section 3.2 (activity types) and Section 3.1 (status fields)

/** Activity types — spec Section 3.2 */
export type ActivityType =
  | 'card_review' | 'elaboration' | 'self_explain' | 'concept_map'
  | 'comparison' | 'case_analysis' | 'synthesis' | 'socratic';

export type CardType = 'cloze' | 'basic' | 'reversed';
export type BloomLevel = 1 | 2 | 3 | 4 | 5 | 6;
export type MasteryState = 'new' | 'learning' | 'reviewing' | 'mastered';
export type EvaluationMethod = 'self_rated' | 'ai_rated' | 'hybrid';
export type SessionType = 'daily' | 'weekly' | 'monthly' | 'free';
export type PlanStrategy = 'open' | 'exam-prep' | 'weekly-review' | 'exploration';
export type Surface = 'dashboard_chat' | 'dashboard_ui' | 'telegram';
export type ConceptStatus = 'pending' | 'active' | 'skipped' | 'archived';
export type ActivityAuthor = 'system' | 'student';

// === Algorithm I/O types ===

/** Per-Bloom's-level mastery evidence */
export interface MasteryLevels {
  L1: number; L2: number; L3: number;
  L4: number; L5: number; L6: number;
}

/** Full mastery computation result */
export interface MasteryResult {
  levels: MasteryLevels;
  overall: number;       // 0.0 - 1.0
  bloomCeiling: number;  // 0-6 (D3: highest mastered level, 0 = none)
}

/** Single activity log entry as mastery computation input */
export interface MasteryActivityInput {
  bloomLevel: BloomLevel;
  quality: number;       // 0-5
  reviewedAt: string;    // ISO datetime
}

// === Forward-declared types for later sprints ===
// Stubs so downstream code can reference them. S3 will flesh these out.

/** Generator agent output (S3 will expand) */
export interface GeneratedActivity {
  activityType: ActivityType;
  prompt: string;
  referenceAnswer: string;
  bloomLevel: BloomLevel;
  cardType?: CardType;
  sourceNotePath?: string;
}

/** Session builder output (S3 will expand) */
export interface SessionComposition {
  sessionId: string;
  activities: Array<{ activityId: string; block: 'new' | 'review' | 'stretch' }>;
  estimatedMinutes: number;
}

/** Bloom advancement check result (S3 will expand) */
export interface BloomAdvancement {
  conceptId: string;
  previousCeiling: number;
  newCeiling: number;
  generationNeeded: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/study/types.ts
git commit -m "feat(study): add non-DB types for study system (S1.1)"
```

---

## Task 2: Drizzle Schema — Study Tables

**Files:** Create `src/db/schema/study.ts`, modify `src/db/schema/index.ts`

**Constraint (hard):** SQL column names, types, defaults, indexes, and foreign keys MUST match spec Section 3.1 exactly. The Drizzle schema is the source of truth for the database — get this wrong and everything downstream breaks.

**Convention (D2):** Use camelCase for Drizzle property names, snake_case for SQL column names. Follow the existing patterns in `src/db/schema/tasks.ts` for table structure (index builder in third arg, FK via `.references()`).

- [ ] **Step 1: Create `src/db/schema/study.ts`**

8 tables. Defined in FK-dependency order: concepts first (referenced by everything), then plans (referenced by sessions), then sessions (referenced by activity_log), then activities and log.

```typescript
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
```

- [ ] **Step 2: Re-export from `src/db/schema/index.ts`**

Add `export * from './study.js';`

- [ ] **Step 3: Commit**

```bash
git add src/db/schema/study.ts src/db/schema/index.ts
git commit -m "feat(study): add Drizzle schema for all study tables (S1.2)"
```

---

## Task 3: Generate and Verify Migration

**Files:** Generated `drizzle/migrations/0001_*.sql`

- [ ] **Step 1: Generate migration**

```bash
npx drizzle-kit generate
```

Expected: new file `drizzle/migrations/0001_*.sql` with CREATE TABLE + CREATE INDEX for all 8 study tables.

- [ ] **Step 2: Verify on existing DB**

Build and run `initDatabase()`. Check all 20 tables exist (12 original + 8 study). Spot-check `concepts` has `mastery_L1`, `bloom_ceiling`, `vault_note_path`. Spot-check `learning_activities` has `ease_factor`, `bloom_level`, `mastery_state`.

- [ ] **Step 3: Verify on fresh DB**

Create a fresh in-memory or temp-file DB, run all migrations from scratch, verify same table list.

- [ ] **Step 4: Commit**

```bash
git add drizzle/migrations/
git commit -m "feat(study): add study tables migration (S1.3)"
```

---

## Task 4: SM-2 Algorithm (TDD)

**Files:** Create `src/study/sm2.test.ts`, then `src/study/sm2.ts`

**Constraint (hard):** The algorithm MUST match the spec pseudocode in Section 4.1 exactly. This is not a place for creative interpretation.

**Agent discretion:** Interface naming, JSDoc style, whether to export the input type.

- [ ] **Step 1: Write failing tests**

The SM-2 function takes `{ quality, repetitions, easeFactor, intervalDays }` and returns `{ easeFactor, intervalDays, repetitions }`. Also provide a `computeDueDate(intervalDays, fromDate?) → 'YYYY-MM-DD'` helper.

Test cases that MUST be covered:

| Scenario | quality | reps in | EF in | Expected interval | Expected reps | Expected EF |
|----------|---------|---------|-------|-------------------|---------------|-------------|
| First correct | 4 | 0 | 2.5 | 1 | 1 | ~2.5 |
| Second correct | 4 | 1 | 2.5 | 6 | 2 | ~2.5 |
| Third correct | 4 | 2 | 2.5 | 15 (round(6*2.5)) | 3 | ~2.5 |
| Incorrect resets | 2 | 5 | 2.5 | 1 | 0 | (calculated) |
| EF floor | 0 | 0 | 1.3 | 1 | 0 | 1.3 |
| Perfect q=5 | 5 | 0 | 2.5 | 1 | 1 | 2.6 |
| Barely correct q=3 | 3 | 0 | 2.5 | 1 | 1 | 2.36 |
| Blackout q=0 | 0 | 0 | 2.5 | 1 | 0 | 1.7 |
| All quality values 0-5 | each | 0 | 2.5 | ≥1 | ≥0 | ≥1.3 |

`computeDueDate`: verify it adds days correctly, handles month boundaries, defaults to today.

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run src/study/sm2.test.ts
```

- [ ] **Step 3: Implement**

The SM-2 formula (spec Section 4.1):

```
EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
EF' = max(EF', 1.3)

if quality >= 3:
  rep 0: interval = 1
  rep 1: interval = 6
  rep 2+: interval = round(interval * EF')
  repetitions += 1
else:
  repetitions = 0, interval = 1
```

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/study/sm2.ts src/study/sm2.test.ts
git commit -m "feat(study): implement SM-2 scheduling algorithm with tests (S1.6)"
```

---

## Task 5: Weighted Evidence Mastery (TDD)

**Files:** Create `src/study/mastery.test.ts`, then `src/study/mastery.ts`

**Constraint (hard):** Algorithm MUST match spec Section 4.2 pseudocode. Constants are non-negotiable: `BLOOM_WEIGHTS = { 1: 1.0, 2: 1.5, 3: 2.0, 4: 2.5, 5: 3.0, 6: 4.0 }`, `MASTERY_THRESHOLD = 10.0`, `DECAY_HALF_LIFE_DAYS = 30`.

**Constraint (hard, D3):** `computeBloomCeiling` returns the highest level WHERE evidence ≥ 70% of threshold. Returns 0 if no level is mastered. Levels must be contiguous — a gap at L2 caps the ceiling at 1 regardless of L3+ evidence.

Three pure functions needed:

1. `computeMastery(activities: MasteryActivityInput[], now?: string) → MasteryLevels`
   - For each Bloom level, sum: `(quality / 5.0) * 0.5^(daysSince / 30)`
2. `computeBloomCeiling(levels: MasteryLevels) → number`
   - Walk L1→L6, stop at first level where `evidence / MASTERY_THRESHOLD < 0.7`
   - Return the last level that passed, or 0
3. `computeOverallMastery(levels: MasteryLevels) → number`
   - Weighted sum: `Σ min(evidence/threshold, 1.0) * weight[level]` / `Σ weights`

Also export a convenience `computeFullMastery(activities, now?) → MasteryResult` that calls all three and returns the composite `MasteryResult` from types.ts.

- [ ] **Step 1: Write failing tests**

Test cases that MUST be covered:

| Function | Scenario | Expected |
|----------|----------|----------|
| `computeMastery` | No activities | All zeros |
| `computeMastery` | Two L1 activities (q=5, q=3) today | L1 ≈ 1.6 |
| `computeMastery` | Activity 30 days ago (q=5) | L1 ≈ 0.5 (half-life) |
| `computeMastery` | Activities at different Bloom levels | Only respective levels have evidence |
| `computeBloomCeiling` | No mastery | 0 |
| `computeBloomCeiling` | L1 at 7.0 (≥70% of 10) | 1 |
| `computeBloomCeiling` | L1-L3 at 7.0+ | 3 |
| `computeBloomCeiling` | All levels at threshold | 6 |
| `computeBloomCeiling` | Gap at L2 (L1=8, L2=1, L3=9) | 1 (gap caps it) |
| `computeOverallMastery` | No evidence | 0 |
| `computeOverallMastery` | All levels fully mastered | 1.0 |
| `computeOverallMastery` | L6-only vs L1-only mastered | L6 produces higher overall |
| `computeOverallMastery` | Evidence above threshold | Capped at 1.0 per level |

- [ ] **Step 2: Run tests, verify they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run tests, verify they pass**
- [ ] **Step 5: Commit**

```bash
git add src/study/mastery.ts src/study/mastery.test.ts
git commit -m "feat(study): implement weighted evidence mastery model with tests (S1.7)"
```

---

## Task 6: Study Query Functions

**Files:** Create `src/study/queries.ts`

**Pattern:** Follow the existing CRUD pattern in `src/db/index.ts`. Study the functions there — `storeChatMetadata`, `getRegisteredGroup`, `updateTask`, `deleteTask` show the insert/select/update/delete patterns with Drizzle. Your functions should feel like they belong in the same codebase.

**Constraint (hard):** Multi-table writes MUST use `getDb().transaction()`. Specifically, `completeActivity` touches learning_activities + activity_log + concepts + optionally study_sessions — all within one transaction.

**Constraint (hard):** Use Drizzle's query builder operators (`eq`, `and`, `lte`, `desc`, `inArray`, `isNull`, etc.) — not raw `sql` template strings — for operations the builder supports. Use `sql` only for things like `datetime('now')` or `activitiesCompleted + 1` where no builder operator exists.

**Agent discretion:** Function signatures, grouping, whether to add convenience wrappers beyond the listed functions. If you see a query that would naturally be useful for S2-S3 consumers, add it.

### Derive these types from Drizzle schema

```typescript
export type Concept = typeof schema.concepts.$inferSelect;
export type NewConcept = typeof schema.concepts.$inferInsert;
// ... same pattern for LearningActivity, ActivityLogEntry, StudySession, StudyPlan
```

### Required functions

**Concepts:**
- `createConcept(concept: NewConcept): void`
- `getConceptById(id: string): Concept | undefined`
- `getConceptsByDomain(domain: string): Concept[]` — ordered by title
- `getConceptsByStatus(status: string): Concept[]` — ordered by title
- `getPendingConcepts(): Concept[]` — convenience wrapper
- `getActiveConcepts(): Concept[]` — convenience wrapper
- `updateConceptStatus(id: string, status: string): void`
- `updateConceptMastery(id, masteryLevels, overall, bloomCeiling): void` — also sets `lastActivityAt`

**Learning Activities:**
- `createActivity(activity: NewLearningActivity): void`
- `getActivityById(id: string): LearningActivity | undefined`
- `getDueActivities(beforeDate?: string): LearningActivity[]` — ordered by dueAt asc, defaults to now
- `getActivitiesByConceptAndType(conceptId, activityType): LearningActivity[]`
- `updateActivitySM2(id, sm2Fields, quality, masteryState): void` — also sets `lastReviewed`

**Activity Log:**
- `createActivityLogEntry(entry: NewActivityLogEntry): void`
- `getLogsByConceptAndLevel(conceptId, bloomLevel?): ActivityLogEntry[]` — ordered by reviewedAt desc
- `getLogsBySession(sessionId): ActivityLogEntry[]` — ordered by reviewedAt asc

**Study Sessions:**
- `createStudySession(session: NewStudySession): void`
- `getStudySessionById(id): StudySession | undefined`
- `updateStudySession(id, partialUpdates): void`
- `getActiveSession(): StudySession | undefined` — most recent where endedAt IS NULL

**Study Plans:**
- `createStudyPlan(plan: NewStudyPlan): void`
- `getStudyPlanById(id): StudyPlan | undefined`
- `getAllStudyPlans(): StudyPlan[]` — ordered by createdAt desc
- `updateStudyPlan(id, partialUpdates): void`
- `addConceptsToPlan(planId, conceptIds, targetBloom?): void` — use `onConflictDoNothing`, wrap in transaction if >1 concept
- `getPlanConcepts(planId): Concept[]` — join through study_plan_concepts, ordered by sort_order

### The `completeActivity` transaction (exact code — this is the complex one)

This is the one function that warrants full implementation in the plan because it orchestrates SM-2 + mastery + logging atomically:

```typescript
export interface CompleteActivityInput {
  activityId: string;
  quality: number;  // 0-5
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
export function completeActivity(input: CompleteActivityInput): CompleteActivityResult {
  return getDb().transaction((tx) => {
    // Step 1: get activity
    const activity = tx.select().from(schema.learningActivities)
      .where(eq(schema.learningActivities.id, input.activityId)).get();
    if (!activity) throw new Error(`Activity not found: ${input.activityId}`);

    // Step 2: SM-2
    const sm2 = computeSM2({
      quality: input.quality,
      repetitions: activity.repetitions ?? 0,
      easeFactor: activity.easeFactor ?? 2.5,
      intervalDays: activity.intervalDays ?? 1,
    });
    const newDueAt = computeDueDate(sm2.intervalDays);

    // Step 3: mastery state heuristic
    let masteryState: MasteryState = 'learning';
    if (sm2.repetitions === 0) masteryState = 'learning';
    else if (sm2.intervalDays >= 21) masteryState = 'mastered';
    else masteryState = 'reviewing';

    // Step 4: update activity
    tx.update(schema.learningActivities).set({
      easeFactor: sm2.easeFactor, intervalDays: sm2.intervalDays,
      repetitions: sm2.repetitions, dueAt: newDueAt,
      lastReviewed: new Date().toISOString(), lastQuality: input.quality,
      masteryState,
    }).where(eq(schema.learningActivities.id, input.activityId)).run();

    // Step 5: log entry
    const logEntryId = crypto.randomUUID();
    tx.insert(schema.activityLog).values({
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
      reviewedAt: new Date().toISOString(),
    }).run();

    // Step 6: recompute concept mastery from all logs
    const concept = tx.select().from(schema.concepts)
      .where(eq(schema.concepts.id, activity.conceptId)).get();
    const bloomCeilingBefore = concept?.bloomCeiling ?? 0;

    const allLogs = tx.select().from(schema.activityLog)
      .where(eq(schema.activityLog.conceptId, activity.conceptId)).all();

    const masteryInput: MasteryActivityInput[] = allLogs.map((log) => ({
      bloomLevel: log.bloomLevel as BloomLevel,
      quality: log.quality,
      reviewedAt: log.reviewedAt,
    }));

    const levels = computeMastery(masteryInput);
    const overall = computeOverallMastery(levels);
    const bloomCeiling = computeBloomCeiling(levels);

    // Step 7: update concept
    tx.update(schema.concepts).set({
      masteryL1: levels.L1, masteryL2: levels.L2, masteryL3: levels.L3,
      masteryL4: levels.L4, masteryL5: levels.L5, masteryL6: levels.L6,
      masteryOverall: overall, bloomCeiling,
      lastActivityAt: new Date().toISOString(),
    }).where(eq(schema.concepts.id, activity.conceptId)).run();

    // Step 8: increment session count
    if (input.sessionId) {
      tx.update(schema.studySessions).set({
        activitiesCompleted: sql`${schema.studySessions.activitiesCompleted} + 1`,
      }).where(eq(schema.studySessions.id, input.sessionId)).run();
    }

    return { logEntryId, newDueAt, masteryUpdated: true, bloomCeilingBefore, bloomCeilingAfter: bloomCeiling };
  });
}
```

- [ ] **Step 1: Create `src/study/queries.ts`** — types, CRUD functions, `completeActivity` transaction
- [ ] **Step 2: Commit**

```bash
git add src/study/queries.ts
git commit -m "feat(study): add study query functions with transactional completion (S1.4)"
```

---

## Task 7: Study Query Tests

**Files:** Create `src/study/queries.test.ts`

**Pattern:** Use `beforeEach(() => _initTestDatabase())` and `afterEach(() => _closeDatabase())` — same as existing DB tests. Create test fixtures (a concept, an activity) in `beforeEach` where multiple describe blocks need them.

**Constraint (hard):** `completeActivity` MUST have thorough tests — it's the most complex function and touches 4 tables. Test the happy path, non-existent activity error, session count increment, and transaction atomicity (all-or-nothing on failure).

**Agent discretion:** Test organization, fixture naming, whether to add extra edge case tests beyond the required set. More coverage is welcome if you see gaps.

### Required test coverage

| Describe block | Test cases |
|---------------|------------|
| concept queries | create + retrieve, not-found returns undefined, query by domain, pending vs active filtering, status update |
| activity queries | create + retrieve (verify SM-2 defaults: EF=2.5, reps=0, state='new'), getDueActivities with cutoff date (verify ordering), getByConceptAndType filtering |
| activity log queries | create + query by concept, filter by bloom level, query by session |
| session queries | create + retrieve, find active (non-ended) session, update partial fields |
| plan queries | create + retrieve, add concepts to plan + retrieve them, list all ordered by date desc |
| completeActivity | updates SM-2 fields + creates log + updates mastery, throws on non-existent activity, increments session count when sessionId provided, verify transaction rolls back on failure |

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Run tests, verify they pass**

```bash
npx vitest run src/study/queries.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/study/queries.test.ts
git commit -m "test(study): add query function tests with transaction rollback (S1.5)"
```

---

## Task 8: Update Migration Test

**Files:** Modify `src/db-migration.test.ts`

- [ ] **Step 1: Add study tables to expected tables list**

The existing test has an `expectedTables` array. Add: `activity_concepts`, `activity_log`, `concept_prerequisites`, `concepts`, `learning_activities`, `study_plan_concepts`, `study_plans`, `study_sessions`. Keep the array alphabetically sorted.

Also add spot-checks for study table columns (same pattern as the existing ingestion/chat checks):
- `concepts`: has `mastery_L1`, `bloom_ceiling`, `vault_note_path`
- `learning_activities`: has `ease_factor`, `bloom_level`, `mastery_state`

- [ ] **Step 2: Run test**

```bash
npx vitest run src/db-migration.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/db-migration.test.ts
git commit -m "test(db): add study tables to migration test (S1)"
```

---

## Task 9: Barrel Exports and Group Scaffolds

**Files:** Create `src/study/index.ts`, `groups/study/CLAUDE.md`, `groups/study-generator/CLAUDE.md`

- [ ] **Step 1: Create `src/study/index.ts`**

Re-export everything from `types.ts`, `sm2.ts`, `mastery.ts`, and `queries.ts`. This is the public API for the study subsystem — S2+ imports from `src/study/index.js`.

**Agent discretion:** Organize exports however makes sense. Prefer named re-exports over `export *` for clarity.

- [ ] **Step 2: Create `groups/study/CLAUDE.md`**

Placeholder for the interactive study agent (expanded in S5). Include:
- Role: study tutor for university courses
- Core principles: brain-first, desirable difficulties, suggest strongly enforce nothing
- Note: "Full prompt designed in S5"

- [ ] **Step 3: Create `groups/study-generator/CLAUDE.md`**

Placeholder for the batch generator agent (expanded in S3). Include:
- Role: generate learning activities from vault content
- Output format: structured JSON
- Quality rules: Wozniak's 20 Rules, Matuschak's 5 Attributes
- Note: "Full prompt designed in S3"

- [ ] **Step 4: Commit**

```bash
git add src/study/index.ts groups/study/CLAUDE.md groups/study-generator/CLAUDE.md
git commit -m "feat(study): add barrel exports and group directory scaffolds (S1.8, S1.9)"
```

---

## Task 10: Full Verification

- [ ] **Step 1: Run all study tests**

```bash
npx vitest run src/study/
```

- [ ] **Step 2: Run full project test suite**

```bash
npm test
```

No regressions. All existing + new tests pass.

- [ ] **Step 3: Build check**

```bash
npm run build
```

No TypeScript errors.

- [ ] **Step 4: Fresh DB migration check**

Create a temp DB, run all migrations from scratch, verify all 20 tables exist.

---

## Acceptance Criteria

From master plan S1 (non-negotiable):

- [ ] All 8 study tables created with correct schema (verified by migration test)
- [ ] SM-2 produces correct intervals for all quality values 0-5 across multiple repetitions
- [ ] Mastery correctly computes per-level evidence with time decay
- [ ] Bloom ceiling returns highest mastered level (0 if none); gap at any level caps it
- [ ] `completeActivity` atomically updates SM-2 + log + mastery within a transaction
- [ ] All tests pass (`npm test`)
- [ ] Clean build (`npm run build`)
