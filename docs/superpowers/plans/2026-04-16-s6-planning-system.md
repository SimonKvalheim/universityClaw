# S6: Planning System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Your role:** You are the engineer implementing this. The plan tells you *what* to build and *why*. You decide *how* within the stated constraints. If you disagree with an approach or see a better alternative, flag it before implementing — don't silently deviate and don't silently comply with something you think is wrong.

**Goal:** Add collaborative study plan creation, plan-aware session building, and plan progress tracking to the study system. Students can create plans (quick form or guided chat dialogue), associate concepts, set deadlines, and see plan-scoped progress. Sessions can be scoped to a plan so the session builder prioritizes plan concepts.

**Architecture:** S6 builds on top of existing infrastructure. The `study_plans` and `study_plan_concepts` tables already exist (S1). Backend `queries.ts` already has basic plan CRUD (`createStudyPlan`, `getStudyPlanById`, `getAllStudyPlans`, `updateStudyPlan`, `addConceptsToPlan`, `getPlanConcepts`). S6 adds: (1) new query functions for plan progress and plan-scoped activity fetching, (2) plan-aware session builder option (`planId`), (3) dashboard schema tables for plans, (4) dashboard DB functions for plan management, (5) dashboard API routes for plan CRUD, (6) `/study/plan` page with plan list + create + detail views, (7) plan creation dialogue instructions in the study agent CLAUDE.md, (8) `plan_id` wired into existing session creation flow.

**Tech Stack:** TypeScript/Node.js (backend), Next.js + React (dashboard), Drizzle ORM (SQLite), container agents (Claude via NanoClaw)

**Branch:** Create `feat/s6-planning-system` off `main`. S5 merged via PR #32.

**Spec:** `docs/superpowers/specs/2026-04-12-multi-method-study-system-design.md` (v2.1, Section 5)

**Master plan:** `docs/superpowers/plans/2026-04-13-study-system-master-plan.md` (S6 checklist)

---

## Codebase Conventions (Hard Constraints)

These apply to **every task**. Subagents must follow these — they're not obvious from context alone.

1. **`.js` extensions on all relative imports in `src/`.** The backend uses Node ESM resolution. Write `import { foo } from './bar.js'`, not `'./bar'`. **Exception:** Dashboard (`dashboard/src/`) does NOT use `.js` extensions — Next.js handles resolution.
2. **camelCase Drizzle properties, snake_case SQL columns** (backend `src/db/schema/study.ts`). Dashboard schema (`dashboard/src/lib/db/schema.ts`) uses snake_case properties matching SQL column names (different convention — established in S2).
3. **Drizzle query builder operators** (`eq`, `and`, `lte`, `desc`, `asc`, `count`, `sql`, `inArray`, `gte`) — not raw SQL strings.
4. **Dashboard API routes** use `Response.json()` + try/catch. Pattern: `dashboard/src/app/api/study/concepts/route.ts`.
5. **Dashboard pages** are `'use client'` components with `useState`/`useEffect` for data fetching. Tailwind CSS. Dark theme (bg-gray-950, text-gray-100). Pattern: `dashboard/src/app/study/page.tsx`.
6. **Dashboard imports** do NOT use `.js` extensions. Follow existing patterns in `dashboard/src/lib/study-db.ts` and `dashboard/src/lib/db/index.ts`.
7. **Commit messages** use conventional commits: `feat(study):`, `feat(dashboard):`.
8. **Next.js API conventions may differ from training data.** Read the relevant guide in `node_modules/next/dist/docs/` before writing API routes (especially dynamic `[id]` params).
9. **Test file locations:** Backend tests are colocated: `src/study/foo.test.ts`. Use `createTestDb()` from test helpers. Import from `./foo.js` (ESM extension rule applies in tests too).
10. **Study query functions** live in `src/study/queries.ts` (not `src/db.ts`). Study is self-contained — never import `getDb()` from `src/db/index.ts` in study modules; use the existing `getDb()` re-export from `queries.ts`.

---

## Spec Deviations

- **No IPC for plan creation.** The spec mentions a `study_plan` IPC message from the study agent after plan dialogue. S6 implements plan creation via direct dashboard API calls instead. The study agent's plan dialogue outputs a structured recommendation that the dashboard extracts from the chat transcript — no new IPC type needed. **Why:** Adding a new IPC type + handler is complex infrastructure for a simple CRUD operation the dashboard can do directly. The chat dialogue helps the student think; the dashboard captures the result.
- **No `planner.ts` module.** The master plan S6.1 calls for `src/study/planner.ts` with `createQuickPlan()` and `processPlanDialogue()`. S6 skips this file entirely — plan CRUD is handled by dashboard API routes calling `study-db.ts` functions, and plan dialogue happens in the study agent (no transcript parsing needed). **Why:** `planner.ts` would be a thin wrapper around `createStudyPlan()` + `addConceptsToPlan()` in `queries.ts`. Adding a module for two lines of orchestration isn't justified. The dashboard API route does the same work directly.
- **Checkpoint system is data-only.** The spec describes checkpoint adaptation dialogue (Zimmerman self-reflection). S6 stores `next_checkpoint_at` and computes progress, but the checkpoint review dialogue (where the agent asks "how is the plan going?") is deferred to S8. S6 shows checkpoint dates and progress on the plan detail page.
- **Plan dialogue is additive, not mandatory.** The spec (Section 5.1) describes three paths: quick (30s), standard (5min), deep (10+min). S6 implements quick (form) and standard (chat with the study agent using method="plan"). The deep 5-phase framework (Discover → Define → Design → Commit → Adapt) is added to the study agent CLAUDE.md as optional depth the agent offers, but the UI doesn't enforce phases.

---

## Key Decisions

### D1: Plan creation via dashboard form, not agent dialogue
The quick path creates plans entirely through the dashboard: title, select concepts (grouped by domain), set strategy, optional deadline. No container agent needed. The guided path opens `/study/chat?method=plan` where the study agent helps the student think through objectives and strategy — but the student still creates the plan via the dashboard form after the dialogue.

**Why not agent-created plans via IPC?** The plan data is simple (title, concepts, strategy, deadline). Having the agent write IPC that triggers plan creation adds an IPC type, a handler, error paths for invalid concept IDs, and a race condition between the dashboard and the agent both trying to create the same plan. The dialogue adds value by helping the student think — the form captures the result.

**Tradeoff:** The student must manually transfer insights from the dialogue to the form. Acceptable for a single user; the dialogue primes their thinking, they fill in the form with clarity.

### D2: Plan-scoped sessions via `planId` filter on session builder
When the student starts a session from a plan detail page, the session builder filters due activities to only those belonging to plan concepts. The existing `SessionOptions` interface gets a `planId?: string` field. The session builder joins `learning_activities` → `concepts` → `study_plan_concepts` to filter.

**Why filter, not separate builder?** The block allocation logic (30% new, 50% review, 20% stretch), interleaving, and domain coverage are identical. Only the activity pool differs. One `planId` filter keeps the builder DRY.

### D3: Plan progress computed, not stored
Plan progress (% of concepts reaching their `target_bloom`) is computed on read from current concept mastery, not stored as a cached field. With <50 concepts per plan and simple column reads, this is fast enough. No staleness issues.

**Why not cache?** Cached progress would need invalidation on every activity completion (mastery changes). The computation is a COUNT query — negligible cost for a single-user app.

### D4: Dashboard schema gets plan tables
The dashboard schema (`dashboard/src/lib/db/schema.ts`) currently lacks `study_plans` and `study_plan_concepts`. These must be added so dashboard DB functions can query plan data directly. Same pattern as the existing `concepts`, `learning_activities`, `study_sessions`, and `activity_log` tables there.

### D5: Exam-prep mode = deadline + target bloom constraints
The spec says "exam-prep" is a scheduling constraint. S6 implements it as: `strategy = 'exam-prep'` + `config.exam_date` (ISO date string in the JSON config field). The session builder, when given a plan with exam-prep strategy, prioritizes concepts furthest from their `target_bloom` and increases session size as the deadline approaches. No new algorithm — just priority sorting within the existing builder.

---

## Essential Reading

> **For coordinators:** Extract relevant patterns from these files and inline them into subagent prompts. Subagents won't read the files themselves.

| File | Why |
|------|-----|
| `src/study/queries.ts:319-407` | Existing plan CRUD functions. S6 adds progress queries alongside these. |
| `src/study/session-builder.ts` | Full session builder. S6 adds `planId` filtering. 274 lines. |
| `dashboard/src/lib/session-builder.ts` | Dashboard copy of session builder. Must also get `planId` support. 294 lines. |
| `dashboard/src/lib/study-db.ts` | Dashboard DB functions. S6 adds plan queries here. |
| `dashboard/src/lib/db/schema.ts` | Dashboard schema. S6 adds `study_plans` + `study_plan_concepts` tables. |
| `src/db/schema/study.ts:70-111` | Backend schema for `studyPlans` and `studyPlanConcepts`. Dashboard schema must match SQL columns. |
| `dashboard/src/app/api/study/session/route.ts` | Session creation route. S6 wires `planId` into this. |
| `dashboard/src/app/study/page.tsx` | Study overview. S6 adds plans section here. |
| `groups/study/CLAUDE.md` | Study agent prompt. S6 adds plan dialogue instructions. |

---

## Task Numbering

| Plan task | Master plan items | What |
|-----------|-------------------|------|
| S6.1 | S6.1 (partial) | Backend: plan progress queries + plan-scoped activity queries |
| S6.2 | S6.5 (partial) | Backend: plan-aware session builder |
| S6.3 | — | Dashboard: schema + DB functions for plans |
| S6.4 | S6.2 | Dashboard: plan API routes |
| S6.5 | S6.3 | Dashboard: /study/plan page |
| S6.6 | S6.5 (partial) | Dashboard: wire planId into session creation flow |
| S6.7 | S6.4 | Study agent: plan dialogue instructions in CLAUDE.md |
| S6.8 | — | Verification |

---

## Parallelization & Model Recommendations

**Dependencies:**
- S6.1 is independent (backend queries — no dashboard dependency)
- S6.2 depends on S6.1 (session builder uses new plan queries)
- S6.3 is independent (dashboard schema/DB — no backend dependency)
- S6.4 depends on S6.3 (API routes use dashboard DB functions)
- S6.5 depends on S6.4 (plan page calls API routes)
- S6.6 depends on S6.3 + S6.4 (session route needs plan DB functions)
- S6.7 is independent (CLAUDE.md file — no code dependency)

**Parallel opportunities:**
- **Wave 1:** S6.1 + S6.3 + S6.7 (backend queries, dashboard schema+DB, CLAUDE.md — fully independent)
- **Wave 2:** S6.2 + S6.4 (session builder, API routes — both depend on Wave 1 but not each other)
- **Wave 3:** S6.5 + S6.6 (plan page, session wiring — depend on Wave 2)
- **Wave 4:** S6.8 (verification)

| Task | Can parallel with | Model | Rationale |
|------|-------------------|-------|-----------|
| S6.1 | S6.3, S6.7 | Sonnet | Mechanical queries following established pattern |
| S6.2 | S6.4 | Sonnet | Adds filter to existing builder — well-defined |
| S6.3 | S6.1, S6.7 | Sonnet | Schema + DB functions following existing pattern |
| S6.4 | S6.2 | Sonnet | API routes following dashboard pattern |
| S6.5 | S6.6 | Sonnet | Plan page — clear UI requirements |
| S6.6 | S6.5 | Sonnet | Small wiring change in session route |
| S6.7 | S6.1, S6.3 | **Opus** | Creative writing — plan dialogue pedagogy needs judgment |
| S6.8 | — | Sonnet | Mechanical verification |

**File ownership for parallel waves:**

Wave 1 parallel agents:
- **S6.1 agent:** Owns `src/study/queries.ts`, `src/study/queries.test.ts`. Do NOT touch dashboard files or `session-builder.ts`.
- **S6.3 agent:** Owns `dashboard/src/lib/db/schema.ts`, `dashboard/src/lib/study-db.ts`. Do NOT touch `src/study/` files.
- **S6.7 agent:** Owns `groups/study/CLAUDE.md`. Do NOT touch any `.ts` files.

Wave 2 parallel agents:
- **S6.2 agent:** Owns `src/study/session-builder.ts`, `src/study/session-builder.test.ts`, `dashboard/src/lib/session-builder.ts`. Do NOT touch `queries.ts` or API routes.
- **S6.4 agent:** Owns `dashboard/src/app/api/study/plans/` directory. Do NOT touch session-builder files.

Wave 3 parallel agents:
- **S6.5 agent:** Owns `dashboard/src/app/study/plan/` directory, may modify `dashboard/src/app/study/page.tsx`. Do NOT touch API routes, session route, or `study-db.ts`.
- **S6.6 agent:** Owns `dashboard/src/app/api/study/session/route.ts`, `dashboard/src/app/study/session/page.tsx`, and `dashboard/src/lib/study-db.ts` (NewSession interface only — do NOT add new plan functions, those were added in S6.3). Do NOT touch plan page files.

---

## S6.1: Backend Plan Progress Queries

**Files:** Modify `src/study/queries.ts`, modify `src/study/types.ts`, create/modify `src/study/queries.test.ts`

**Parallelizable with S6.3, S6.7.**

### New types in `src/study/types.ts`

Add after the existing `SynthesisOpportunity` interface (end of file):

```typescript
/** Progress summary for a study plan */
export interface PlanProgress {
  planId: string;
  totalConcepts: number;
  conceptsAtTarget: number;  // concepts where bloomCeiling >= targetBloom
  progressPercent: number;   // conceptsAtTarget / totalConcepts * 100
  conceptDetails: PlanConceptProgress[];
}

/** Per-concept progress within a plan */
export interface PlanConceptProgress {
  conceptId: string;
  conceptTitle: string;
  domain: string | null;
  currentBloomCeiling: number;
  targetBloom: number;
  masteryOverall: number;
  atTarget: boolean;
}
```

### New query functions in `src/study/queries.ts`

Add these after the closing brace of `getPlanConcepts()` (around line 407, after the `// ====` separator).

**1. `getPlanProgress(planId: string): PlanProgress | null`**

Joins `study_plan_concepts` → `concepts` for the given planId. For each row, checks if `concept.bloomCeiling >= studyPlanConcepts.targetBloom`. Computes aggregate counts.

Pattern:
```typescript
export function getPlanProgress(planId: string): PlanProgress | null {
  const plan = getStudyPlanById(planId);
  if (!plan) return null;

  const rows = getDb()
    .select({
      conceptId: schema.concepts.id,
      conceptTitle: schema.concepts.title,
      domain: schema.concepts.domain,
      bloomCeiling: schema.concepts.bloomCeiling,
      masteryOverall: schema.concepts.masteryOverall,
      targetBloom: schema.studyPlanConcepts.targetBloom,
    })
    .from(schema.studyPlanConcepts)
    .innerJoin(schema.concepts, eq(schema.studyPlanConcepts.conceptId, schema.concepts.id))
    .where(eq(schema.studyPlanConcepts.planId, planId))
    .orderBy(asc(schema.studyPlanConcepts.sortOrder))
    .all();

  const details: PlanConceptProgress[] = rows.map(r => ({
    conceptId: r.conceptId,
    conceptTitle: r.conceptTitle,
    domain: r.domain,
    currentBloomCeiling: r.bloomCeiling ?? 0,
    targetBloom: r.targetBloom ?? 6,
    masteryOverall: r.masteryOverall ?? 0,
    atTarget: (r.bloomCeiling ?? 0) >= (r.targetBloom ?? 6),
  }));

  const atTarget = details.filter(d => d.atTarget).length;

  return {
    planId,
    totalConcepts: details.length,
    conceptsAtTarget: atTarget,
    progressPercent: details.length > 0 ? Math.round((atTarget / details.length) * 100) : 0,
    conceptDetails: details,
  };
}
```

**2. `getActivePlans(): StudyPlan[]`** — filter `getAllStudyPlans()` to status='active'.

```typescript
export function getActivePlans(): StudyPlan[] {
  return getDb()
    .select()
    .from(schema.studyPlans)
    .where(eq(schema.studyPlans.status, 'active'))
    .orderBy(desc(schema.studyPlans.createdAt))
    .all();
}
```

**3. `removeConceptFromPlan(planId: string, conceptId: string): void`** — deletes a single join row.

```typescript
export function removeConceptFromPlan(planId: string, conceptId: string): void {
  getDb()
    .delete(schema.studyPlanConcepts)
    .where(
      and(
        eq(schema.studyPlanConcepts.planId, planId),
        eq(schema.studyPlanConcepts.conceptId, conceptId),
      ),
    )
    .run();
}
```

**4. `getPlanConceptIds(planId: string): string[]`** — returns just the concept IDs for a plan (used by session builder to avoid the full join).

```typescript
export function getPlanConceptIds(planId: string): string[] {
  return getDb()
    .select({ conceptId: schema.studyPlanConcepts.conceptId })
    .from(schema.studyPlanConcepts)
    .where(eq(schema.studyPlanConcepts.planId, planId))
    .all()
    .map(r => r.conceptId);
}
```

### Tests

Write tests for `getPlanProgress`, `getActivePlans`, `removeConceptFromPlan`, `getPlanConceptIds`. Pattern: create test DB, insert a plan + concepts + plan_concepts, verify results. See existing plan tests if any, or follow the concept query test pattern.

- [ ] **Step 1:** Add `PlanProgress` and `PlanConceptProgress` types to `src/study/types.ts`
- [ ] **Step 2:** Write failing tests for `getPlanProgress` — plan with 3 concepts, 1 at target, verify counts
- [ ] **Step 3:** Implement `getPlanProgress` in `src/study/queries.ts`
- [ ] **Step 4:** Run tests — verify pass
- [ ] **Step 5:** Write tests for `getActivePlans` — 2 active + 1 archived plan, verify only active returned
- [ ] **Step 6:** Implement `getActivePlans`
- [ ] **Step 7:** Write tests for `removeConceptFromPlan` — add 3 concepts, remove 1, verify 2 remain
- [ ] **Step 8:** Implement `removeConceptFromPlan`
- [ ] **Step 9:** Write test for `getPlanConceptIds`
- [ ] **Step 10:** Implement `getPlanConceptIds`
- [ ] **Step 11:** Run full test suite: `npm test` — no regressions
- [ ] **Step 12:** Verify: `npm run build` — clean
- [ ] **Step 13:** Commit: `feat(study): add plan progress and plan-scoped query functions (S6.1)`

---

## S6.2: Plan-Aware Session Builder

**Files:** Modify `src/study/session-builder.ts`, modify `src/study/session-builder.test.ts`, modify `src/study/types.ts`, modify `dashboard/src/lib/session-builder.ts`

**Depends on:** S6.1, S6.3 (dashboard session builder imports `getPlanConceptIds` from `study-db.ts`).

**Important:** There are TWO independent `SessionOptions` interfaces — one at `src/study/types.ts:95-98` (backend, used by `src/study/session-builder.ts`) and one at `dashboard/src/lib/session-builder.ts:36-39` (dashboard, local). Both need `planId` added. They are separate type declarations in separate packages.

### Backend session builder changes (`src/study/session-builder.ts`)

**1. Add `planId` to the existing `SessionOptions` in `src/study/types.ts:95-98`:**

```typescript
// In src/study/types.ts — ADD planId to the existing interface:
export interface SessionOptions {
  targetActivities?: number;
  domainFocus?: string;
  planId?: string;  // NEW: filter activities to plan concepts only
}
```

**2. Filter due activities by plan concepts:**

After fetching `dueActivities` and before enrichment (around line 79-99 in `src/study/session-builder.ts`), add plan filtering:

```typescript
import { getPlanConceptIds } from './queries.js';

// In buildDailySession(), after dueActivities fetch:
let filteredActivities = dueActivities;
if (options?.planId) {
  const planConceptIds = new Set(getPlanConceptIds(options.planId));
  filteredActivities = dueActivities.filter(a => planConceptIds.has(a.conceptId));
}
```

Then use `filteredActivities` instead of `dueActivities` for the enrichment loop.

**Constraint:** Do NOT change the block allocation logic, interleaving, or domain coverage. Only the input activity pool changes. The rest of the builder works identically.

**3. Exam-prep priority sorting:**

When `planId` is set, also look up the plan to check for exam-prep strategy. If `strategy === 'exam-prep'` and `config` has an `exam_date`:

- Sort activities with concepts furthest from `target_bloom` first (need most work)
- As deadline approaches (< 7 days), increase target to 30 activities

**Important:** The existing `target` is declared as `const` (line 77: `const target = options?.targetActivities ?? 20`). To allow exam-prep override, change it to `let` and compute the exam-prep adjustment before the block allocation:

```typescript
import { getStudyPlanById, getPlanConceptIds } from './queries.js';

// At the start of buildDailySession(), change const to let:
let target = options?.targetActivities ?? 20;

// After plan filtering, before block allocation:
if (options?.planId) {
  const plan = getStudyPlanById(options.planId);
  if (plan?.strategy === 'exam-prep' && plan.config) {
    const config = JSON.parse(plan.config);
    if (config.exam_date) {
      const daysUntilExam = Math.ceil(
        (new Date(config.exam_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      if (daysUntilExam < 7 && !options.targetActivities) {
        target = 30; // cram mode
      }
    }
  }
}
```

**Agent discretion:** Where to insert the exam-prep logic within the function body.

### Dashboard session builder changes (`dashboard/src/lib/session-builder.ts`)

Apply the same `planId` filter to the dashboard's copy of the session builder. **Note:** The dashboard function is `buildSessionComposition()` (NOT `buildDailySession()` like the backend). The `SessionOptions` interface is defined locally at line 36-39, not imported from `types.ts`.

**1. Add `planId` to the local `SessionOptions`** (line 36-39 of `dashboard/src/lib/session-builder.ts`):

```typescript
export interface SessionOptions {
  targetActivities?: number;
  domainFocus?: string;
  planId?: string;
}
```

**2. Add plan filtering** — same pattern as backend. The dashboard builder calls `getDueActivities()` from `study-db.ts` and then filters by plan concept IDs. Add `getPlanConceptIds` to the import:

```typescript
import { getDueActivities, getActiveConcepts, getPlanConceptIds } from './study-db';
```

Then filter `dueActivities` by plan concept IDs before enrichment (after line 104 `const dueActivities = getDueActivities()`), same logic as backend.

**Dependency note:** `getPlanConceptIds()` is created in S6.3 (Wave 1). S6.2 is Wave 2. S6.3 must complete before this step.

### Tests

Write tests for plan-scoped session building. Pattern:

1. Create test DB with concepts A, B, C (all active, with due activities)
2. Create plan P with concepts A and B only
3. Call `buildDailySession({ planId: P.id })`
4. Verify: all returned activities belong to concepts A or B, none to C
5. Verify: block allocation still correct (30/50/20 split)

Also test: empty plan (no concepts), plan with no due activities (returns empty).

- [ ] **Step 1:** Add `planId` to `SessionOptions` in `src/study/types.ts`
- [ ] **Step 2:** Write failing test: plan-scoped session contains only plan concept activities
- [ ] **Step 3:** Add plan filtering to `src/study/session-builder.ts`
- [ ] **Step 4:** Run test — verify pass
- [ ] **Step 5:** Write test: empty plan returns empty session
- [ ] **Step 6:** Run tests — verify pass
- [ ] **Step 7:** Add `planId` to dashboard `SessionOptions` in `dashboard/src/lib/session-builder.ts`
- [ ] **Step 8:** Add plan filtering to dashboard session builder (import `getPlanConceptIds` from study-db)
- [ ] **Step 9:** Run full test suite: `npm test` — no regressions
- [ ] **Step 10:** Verify: `npm run build` — clean
- [ ] **Step 11:** Verify: `cd dashboard && npx tsc --noEmit` — clean
- [ ] **Step 12:** Commit: `feat(study): add plan-aware session builder with planId filtering (S6.2)`

---

## S6.3: Dashboard Schema + DB Functions for Plans

**Files:** Modify `dashboard/src/lib/db/schema.ts`, modify `dashboard/src/lib/study-db.ts`

**Parallelizable with S6.1, S6.7.**

### Dashboard schema additions (`dashboard/src/lib/db/schema.ts`)

Add `study_plans` and `study_plan_concepts` tables. **These must match the SQL column names in `src/db/schema/study.ts` exactly.** Dashboard schema uses snake_case properties (not camelCase like the backend schema).

Add after the `activity_log` table definition (end of file):

```typescript
export const study_plans = sqliteTable('study_plans', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  domain: text('domain'),
  course: text('course'),
  strategy: text('strategy').notNull().default('open'),
  learning_objectives: text('learning_objectives'),
  desired_outcomes: text('desired_outcomes'),
  implementation_intention: text('implementation_intention'),
  obstacle: text('obstacle'),
  study_schedule: text('study_schedule'),
  config: text('config'),
  checkpoint_interval_days: integer('checkpoint_interval_days').default(14),
  next_checkpoint_at: text('next_checkpoint_at'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
  status: text('status').default('active'),
});

export const study_plan_concepts = sqliteTable('study_plan_concepts', {
  plan_id: text('plan_id').notNull(),
  concept_id: text('concept_id').notNull(),
  target_bloom: integer('target_bloom').default(6),
  sort_order: integer('sort_order').default(0),
});
```

**Constraint:** The column names must match the backend schema SQL columns exactly: `study_plans` table has `learning_objectives` (not `learningObjectives`), `checkpoint_interval_days` (not `checkpointIntervalDays`), etc.

**Constraint:** The dashboard schema uses flat table definitions — no composite primary key callbacks, no `.references()`. This matches the established pattern for `concepts`, `learning_activities`, etc. in this file. For `addConceptsToPlan()`, use a check-before-insert pattern (query existing, skip duplicates) rather than `.onConflictDoNothing()` which requires the primary key definition.

### Dashboard DB functions (`dashboard/src/lib/study-db.ts`)

Add new interfaces and functions for plan management. Add these after the existing session functions (end of file).

**New interfaces:**

```typescript
export interface PlanSummary {
  id: string;
  title: string;
  domain: string | null;
  course: string | null;
  strategy: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  nextCheckpointAt: string | null;
  conceptCount: number;
  progressPercent: number;
}

export interface PlanDetail extends PlanSummary {
  learningObjectives: string | null;
  desiredOutcomes: string | null;
  implementationIntention: string | null;
  obstacle: string | null;
  studySchedule: string | null;
  config: string | null;
  checkpointIntervalDays: number;
  concepts: PlanConceptRow[];
}

export interface PlanConceptRow {
  conceptId: string;
  title: string;
  domain: string | null;
  bloomCeiling: number;
  targetBloom: number;
  masteryOverall: number;
  atTarget: boolean;
}

export interface NewPlan {
  id: string;
  title: string;
  domain?: string;
  course?: string;
  strategy?: string;
  learningObjectives?: string;
  desiredOutcomes?: string;
  implementationIntention?: string;
  obstacle?: string;
  studySchedule?: string;
  config?: string;
  checkpointIntervalDays?: number;
}
```

**New functions:**

**1. `getAllPlans(): PlanSummary[]`** — list all plans with concept counts and progress.

Query `study_plans`, then for each plan count concepts and compute progress (concepts at target / total). Use a subquery or post-fetch aggregation. Progress = concepts where `bloom_ceiling >= target_bloom` / total concepts.

**2. `getActivePlans(): PlanSummary[]`** — same as `getAllPlans()` but filtered to `status = 'active'`.

**3. `getPlanById(id: string): PlanDetail | null`** — full plan with concept details.

Join `study_plan_concepts` → `concepts` for the concept list. Compute `atTarget` for each concept.

**4. `createPlan(plan: NewPlan, conceptIds: string[], targetBloom?: number): void`** — insert plan + concept associations in a transaction.

```typescript
export function createPlan(plan: NewPlan, conceptIds: string[], targetBloom?: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  const checkpointDays = plan.checkpointIntervalDays ?? 14;
  const checkpointDate = new Date(Date.now() + checkpointDays * 86400000).toISOString().slice(0, 10);

  db.transaction((tx) => {
    tx.insert(study_plans).values({
      id: plan.id,
      title: plan.title,
      domain: plan.domain ?? null,
      course: plan.course ?? null,
      strategy: plan.strategy ?? 'open',
      learning_objectives: plan.learningObjectives ?? null,
      desired_outcomes: plan.desiredOutcomes ?? null,
      implementation_intention: plan.implementationIntention ?? null,
      obstacle: plan.obstacle ?? null,
      study_schedule: plan.studySchedule ?? null,
      config: plan.config ?? null,
      checkpoint_interval_days: checkpointDays,
      next_checkpoint_at: checkpointDate,
      created_at: now,
      updated_at: now,
      status: 'active',
    }).run();

    for (let i = 0; i < conceptIds.length; i++) {
      tx.insert(study_plan_concepts).values({
        plan_id: plan.id,
        concept_id: conceptIds[i],
        target_bloom: targetBloom ?? 6,
        sort_order: i,
      }).run();
    }
  });
}
```

**5. `updatePlan(id: string, updates: Partial<...>): void`** — update plan fields. Sets `updated_at` automatically.

**6. `getPlanConceptIds(planId: string): string[]`** — returns concept IDs for a plan (used by session builder).

**7. `addConceptsToPlan(planId: string, conceptIds: string[], targetBloom?: number): void`** — batch add concepts to an existing plan.

**8. `removeConceptFromPlan(planId: string, conceptId: string): void`** — remove a single concept from a plan.

Import the new tables and `gte` operator (needed for bloom_ceiling >= target_bloom comparisons):
```typescript
import { concepts, learning_activities, study_sessions, activity_log, study_plans, study_plan_concepts } from './db/schema';
// Add gte to the existing drizzle-orm import:
import { eq, and, lte, asc, desc, count, sql, inArray, isNull, gte } from 'drizzle-orm';
```

- [ ] **Step 1:** Add `study_plans` and `study_plan_concepts` tables to `dashboard/src/lib/db/schema.ts`
- [ ] **Step 2:** Add plan interfaces (`PlanSummary`, `PlanDetail`, `PlanConceptRow`, `NewPlan`) to `dashboard/src/lib/study-db.ts`
- [ ] **Step 3:** Implement `createPlan()` with transaction
- [ ] **Step 4:** Implement `getAllPlans()` and `getActivePlans()`
- [ ] **Step 5:** Implement `getPlanById()`
- [ ] **Step 6:** Implement `updatePlan()`, `getPlanConceptIds()`, `addConceptsToPlan()`, `removeConceptFromPlan()`
- [ ] **Step 7:** Verify: `cd dashboard && npx tsc --noEmit` — clean
- [ ] **Step 8:** Commit: `feat(dashboard): add plan schema tables and CRUD functions (S6.3)`

---

## S6.4: Dashboard Plan API Routes

**Files:** Create `dashboard/src/app/api/study/plans/route.ts`, create `dashboard/src/app/api/study/plans/[id]/route.ts`, create `dashboard/src/app/api/study/plans/[id]/concepts/route.ts`

**Depends on:** S6.3.

### GET/POST /api/study/plans (`route.ts`)

**GET:** Returns all plans with progress summaries. Calls `getAllPlans()`.

```typescript
export async function GET() {
  try {
    const plans = getAllPlans();
    return Response.json({ plans });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
```

**POST:** Creates a new plan. Body:

```typescript
{
  title: string;
  conceptIds: string[];
  domain?: string;
  course?: string;
  strategy?: string;           // 'open' | 'exam-prep' | 'weekly-review' | 'exploration'
  targetBloom?: number;        // default 6
  examDate?: string;           // ISO date, for exam-prep strategy
  learningObjectives?: string; // JSON string
  desiredOutcomes?: string;
  implementationIntention?: string;
  obstacle?: string;
  studySchedule?: string;
  checkpointIntervalDays?: number;
}
```

Validates: `title` required, `conceptIds` must be non-empty array. Generates `id = crypto.randomUUID()`. If `examDate` provided, stores in `config` as JSON: `{ exam_date: examDate }`.

```typescript
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.title || !Array.isArray(body.conceptIds) || body.conceptIds.length === 0) {
      return Response.json({ error: 'title and conceptIds required' }, { status: 400 });
    }

    const planId = crypto.randomUUID();
    const config = body.examDate ? JSON.stringify({ exam_date: body.examDate }) : undefined;

    createPlan({
      id: planId,
      title: body.title,
      domain: body.domain,
      course: body.course,
      strategy: body.strategy ?? 'open',
      learningObjectives: body.learningObjectives,
      desiredOutcomes: body.desiredOutcomes,
      implementationIntention: body.implementationIntention,
      obstacle: body.obstacle,
      studySchedule: body.studySchedule,
      config,
      checkpointIntervalDays: body.checkpointIntervalDays,
    }, body.conceptIds, body.targetBloom);

    return Response.json({ planId });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
```

### GET/PATCH /api/study/plans/[id] (`[id]/route.ts`)

**GET:** Returns full plan detail with concept progress. Calls `getPlanById(id)`.

**PATCH:** Updates plan fields. Body: partial plan fields. Calls `updatePlan(id, updates)`. Can update: `title`, `strategy`, `status`, `learningObjectives`, `desiredOutcomes`, `implementationIntention`, `obstacle`, `studySchedule`, `config`, `checkpointIntervalDays`.

**Constraint:** Read `node_modules/next/dist/docs/` for dynamic route param extraction in this version of Next.js before implementing. The `[id]` param format may differ from standard Next.js patterns.

### POST/DELETE /api/study/plans/[id]/concepts (`[id]/concepts/route.ts`)

**POST:** Add concepts to a plan. Body: `{ conceptIds: string[], targetBloom?: number }`. Calls `addConceptsToPlan()`.

**DELETE:** Remove a concept from a plan. Body: `{ conceptId: string }`. Calls `removeConceptFromPlan()`.

- [ ] **Step 1:** Create `GET /api/study/plans` route
- [ ] **Step 2:** Create `POST /api/study/plans` route with validation
- [ ] **Step 3:** Create `GET /api/study/plans/[id]` route
- [ ] **Step 4:** Create `PATCH /api/study/plans/[id]` route
- [ ] **Step 5:** Create `POST /api/study/plans/[id]/concepts` route
- [ ] **Step 6:** Create `DELETE /api/study/plans/[id]/concepts` route
- [ ] **Step 7:** Verify: `cd dashboard && npx tsc --noEmit` — clean
- [ ] **Step 8:** Commit: `feat(dashboard): add plan CRUD API routes (S6.4)`

---

## S6.5: Dashboard /study/plan Page

**Files:** Create `dashboard/src/app/study/plan/page.tsx`, modify `dashboard/src/app/study/page.tsx`

**Depends on:** S6.4. **Parallelizable with S6.6.**

### Plan page structure

Single `'use client'` component with three views:

```
LIST → CREATE → DETAIL
```

**LIST view (default):**
- Active plans list. Each card shows: title, strategy badge (`open`/`exam-prep`/`weekly-review`/`exploration`), progress bar (% of concepts at target bloom), concept count, next checkpoint date.
- Archived/completed plans collapsed below.
- "New Plan" button → transitions to CREATE.
- Click on a plan → transitions to DETAIL.

**CREATE view:**
- Form fields:
  - Title (text input, required)
  - Strategy (radio: Open, Exam Prep, Weekly Review, Exploration)
  - If Exam Prep: exam date picker
  - Concept selector: list of active concepts grouped by domain, with checkboxes. "Select All in Domain" button per domain group.
  - Target Bloom (number 1-6, default 6)
  - Optional fields (collapsible "Advanced" section): learning objectives (textarea), desired outcomes (textarea), study schedule (text), implementation intention (text), obstacle (text), checkpoint interval (number, default 14 days)
- "Create Plan" button → `POST /api/study/plans` → transitions to DETAIL for new plan
- "Or: Plan with AI" link → navigates to `/study/chat?method=plan` (S5's chat page with plan method)
- "Cancel" button → transitions back to LIST

**DETAIL view:**
- Plan header: title, strategy badge, progress bar, created date, next checkpoint
- Concept checklist: each concept shows title, domain, current bloom ceiling → target bloom, mastery bar, "at target" checkmark
- Concepts sorted by: furthest from target first (most work needed)
- "Start Plan Session" button → navigates to `/study/session?planId={id}` (creates a plan-scoped session)
- "Edit" button for title/strategy/deadline
- "Add Concepts" button → concept selector modal
- "Remove" button per concept (with confirmation)
- "Archive Plan" button → `PATCH /api/study/plans/[id]` with `{ status: 'archived' }`
- "Complete Plan" button → `PATCH /api/study/plans/[id]` with `{ status: 'completed' }`

### Study overview page changes (`dashboard/src/app/study/page.tsx`)

Add a "Plans" section between the session card and concept list. Shows:
- Active plan count
- Top 2-3 active plans with title + progress bar
- "View All Plans" link → `/study/plan`

Fetch from `GET /api/study/plans` and filter to active, sorted by most recent.

### Design

- Dark theme: bg-gray-950, text-gray-100 (matching existing study pages)
- Plan cards: bg-gray-900 border border-gray-800 rounded-lg p-4
- Progress bar: bg-gray-700 rounded-full h-2, fill with bg-green-500
- Strategy badges: bg-blue-900 text-blue-300 for open, bg-red-900 text-red-300 for exam-prep, bg-purple-900 text-purple-300 for weekly-review, bg-amber-900 text-amber-300 for exploration
- Concept checkboxes: green checkmark for at-target, gray circle for in-progress
- Concept selector: scrollable list with domain group headers

**Agent discretion:** Component decomposition (whether to split PlanList, PlanCreate, PlanDetail into separate components or keep as one file with view state), exact Tailwind classes, animations, mobile responsiveness.

- [ ] **Step 1:** Create `/study/plan/page.tsx` with LIST view — fetch plans, render cards with progress
- [ ] **Step 2:** Add CREATE view with form fields and concept selector
- [ ] **Step 3:** Wire form submission to `POST /api/study/plans`
- [ ] **Step 4:** Add DETAIL view — plan header, concept checklist, action buttons
- [ ] **Step 5:** Wire concept add/remove buttons to API routes
- [ ] **Step 6:** Wire "Start Plan Session" button to navigate to `/study/session?planId={id}`
- [ ] **Step 7:** Add plans section to study overview page (`/study`)
- [ ] **Step 8:** Start dashboard: `cd dashboard && npm run dev`. Navigate to `/study/plan`, verify plan creation flow works
- [ ] **Step 9:** Verify: `cd dashboard && npx tsc --noEmit` — clean
- [ ] **Step 10:** Commit: `feat(dashboard): add /study/plan page with list, create, and detail views (S6.5)`

---

## S6.6: Wire `planId` into Session Creation Flow

**Files:** Modify `dashboard/src/app/api/study/session/route.ts`, modify `dashboard/src/app/study/session/page.tsx`, modify `dashboard/src/lib/study-db.ts` (NewSession interface only)

**Depends on:** S6.3, S6.4. **Parallelizable with S6.5.**

**Note:** The `study_sessions` table in the dashboard schema already has `plan_id` (line 78 of `dashboard/src/lib/db/schema.ts`). Only the `NewSession` interface and `createSession()` function in `study-db.ts` need updating — no schema change.

### Session API changes (`route.ts`)

**GET handler:** Currently calls `buildSessionComposition()` with no options. Accept `planId` query param and pass it through:

```typescript
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const planId = url.searchParams.get('planId') ?? undefined;
    const composition = buildSessionComposition({ planId });
    // ... rest unchanged
  }
}
```

**POST handler:** Currently creates sessions without `plan_id`. Accept `planId` in body and pass to `createSession()`:

```typescript
const body = (await request.json()) as {
  sessionType?: string;
  preConfidence?: Record<string, number>;
  planId?: string;  // NEW
};

// In createSession call:
createSession({
  id: sessionId,
  startedAt: new Date().toISOString(),
  sessionType: body.sessionType ?? 'daily',
  preConfidence: body.preConfidence ? JSON.stringify(body.preConfidence) : undefined,
  surface: 'dashboard_ui',
  planId: body.planId,  // NEW
});
```

**Dashboard `createSession` in `study-db.ts`:** Add `planId` to the `NewSession` interface and pass through to the insert:

```typescript
export interface NewSession {
  id: string;
  startedAt: string;
  sessionType: string;
  preConfidence?: string;
  surface?: string;
  planId?: string;  // NEW
}
```

In the `createSession` function, add `plan_id: session.planId ?? null` to the values object.

### Session page changes (`session/page.tsx`)

Read `planId` from URL search params. When present:
- Pass `planId` in the `GET /api/study/session?planId={id}` request
- Pass `planId` in the `POST /api/study/session` body
- Show plan context banner at top: "Studying: {plan title}" with link back to plan detail

```typescript
const searchParams = useSearchParams();
const planId = searchParams.get('planId');

// In session fetch:
const url = planId ? `/api/study/session?planId=${planId}` : '/api/study/session';
```

- [ ] **Step 1:** Add `planId` to `NewSession` interface in `dashboard/src/lib/study-db.ts`
- [ ] **Step 2:** Pass `plan_id` through in `createSession()` function
- [ ] **Step 3:** Update `GET /api/study/session` to accept `planId` query param
- [ ] **Step 4:** Update `POST /api/study/session` to accept `planId` in body
- [ ] **Step 5:** Update `/study/session` page to read `planId` from URL and pass to API calls
- [ ] **Step 6:** Add plan context banner when session is plan-scoped
- [ ] **Step 7:** Start dashboard, test: navigate from plan detail → start session → verify only plan concepts shown
- [ ] **Step 8:** Verify: `cd dashboard && npx tsc --noEmit` — clean
- [ ] **Step 9:** Commit: `feat(dashboard): wire planId into session creation and session page (S6.6)`

---

## S6.7: Study Agent Plan Dialogue Instructions

**Files:** Modify `groups/study/CLAUDE.md`

**Parallelizable with S6.1, S6.3.**

### What to add

Add a new section after the existing method sections (Feynman, Socratic, Case Analysis, Comparison, Synthesis). Add a **Plan Creation Dialogue** section.

**Section content (~40 lines):**

**When:** The student opens a chat with `method=plan`. The first message context will include `Method: plan`.

**Your role:** Help the student think through what they want to study and why. You are a learning advisor, not a form filler. The student will create the actual plan via the dashboard form — your job is to help them clarify their goals, identify the right concepts, and choose an effective strategy.

**Dialogue flow (flexible depth):**

1. **Opening:** Ask what the student wants to focus on. Listen for: domain/course, specific concepts, time pressure (exam), general exploration.

2. **Goal clarification:** Help them articulate what "success" looks like. "When you're done studying this, what will you be able to do?" (Backward design — Wiggins & McTighe). Push for Bloom's-level specificity: "Do you need to recall these models, or apply them to cases?"

3. **Strategy selection:** Based on their goals, recommend a strategy:
   - `open` — no deadline, mastery-oriented, steady progression
   - `exam-prep` — deadline, coverage-focused, prioritize weak concepts
   - `weekly-review` — recurring, maintenance-oriented
   - `exploration` — curiosity-driven, breadth over depth

4. **Concept identification:** If they mentioned a domain, list available concepts in that domain and help them select. Don't fetch concept lists — suggest they use the dashboard's concept selector.

5. **Optional depth (offer, don't force):** "Want to go deeper?" At any natural pause point, offer to discuss:
   - Learning objectives (Bloom's-tagged)
   - Implementation intentions ("When and where will you study?" — Gollwitzer 1999)
   - Obstacles and mitigation ("What's most likely to get in the way?" — WOOP, Oettingen)
   - Study schedule

6. **Wrap-up:** Summarize what you've discussed. Suggest they create the plan via the dashboard form with the fields you've discussed. Be specific: "I'd suggest an exam-prep plan titled 'KM Frameworks for BI-2081 Exam', targeting Bloom's L4 for the models and L5 for synthesis."

**Constraints:**
- Do NOT create plans via IPC. The dashboard handles plan creation.
- Do NOT fetch concept lists. You don't have access to the study DB. Suggest concepts based on what the student tells you and recommend they select from the dashboard.
- Keep it conversational. No numbered checklists. No form-like prompts.
- Brain-first applies: ask the student what they think first, then offer your perspective.
- The dialogue can be 2 messages or 20 — match the student's depth preference.

**Do NOT include exam tips, study technique tutorials, or motivational speeches. Focus on plan structure and concept selection.**

### Constraints for the writer

- Total CLAUDE.md should stay under 350 lines after this addition. The current file is ~260 lines.
- Do NOT modify existing method sections. Add the plan section as a new method alongside the others.
- Follow the existing writing style: direct, concise, pedagogically grounded.

- [ ] **Step 1:** Add plan creation dialogue section to `groups/study/CLAUDE.md`
- [ ] **Step 2:** Verify total line count is under 350
- [ ] **Step 3:** Commit: `feat(study): add plan creation dialogue instructions to study agent CLAUDE.md (S6.7)`

---

## S6.8: Verification

**Depends on:** All previous tasks.

- [ ] **Step 1:** Run backend tests: `npm test` — all pass, no regressions
- [ ] **Step 2:** Build: `npm run build` — clean
- [ ] **Step 3:** Dashboard types: `cd dashboard && npx tsc --noEmit` — clean
- [ ] **Step 4:** Start dashboard: `cd dashboard && npm run dev`
- [ ] **Step 5:** Navigate to `/study/plan` — plan list renders (empty state)
- [ ] **Step 6:** Click "New Plan" — create form renders with concept selector
- [ ] **Step 7:** Create a plan: select 3-5 concepts, strategy=open, click Create — redirects to plan detail
- [ ] **Step 8:** Plan detail: concept checklist shows correct bloom ceilings and target bloom, progress bar at 0%
- [ ] **Step 9:** Click "Start Plan Session" — navigates to `/study/session?planId={id}`, session contains only plan concepts
- [ ] **Step 10:** Return to `/study` overview — plans section shows the new plan
- [ ] **Step 11:** Navigate to `/study/plan`, click plan, click "Archive" — plan moves to archived section
- [ ] **Step 12:** Create an exam-prep plan with a deadline — verify it shows on plan detail
- [ ] **Step 13:** Commit: `chore(study): verify S6 planning system end-to-end (S6.8)`

---

## Acceptance Criteria

From master plan S6 (non-negotiable):

- [ ] Quick plan creation works (select concepts + defaults, <30 seconds)
- [ ] Plans appear on `/study/plan` with concept progress (% at target bloom)
- [ ] Plan detail shows concept checklist with bloom ceiling vs target
- [ ] Session builder includes only plan concepts when `planId` is set
- [ ] `plan_id` saved on `study_sessions` records for plan-scoped sessions
- [ ] Exam-prep strategy stores `exam_date` in plan config
- [ ] Study agent CLAUDE.md includes plan dialogue instructions
- [ ] `/study` overview shows active plans section
- [ ] All existing tests pass (`npm test`)
- [ ] Clean build (`npm run build`, `cd dashboard && npx tsc --noEmit`)
