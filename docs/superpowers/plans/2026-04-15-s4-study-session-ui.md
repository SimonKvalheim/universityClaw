# S4: Study Session UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Your role:** You are the engineer implementing this. The plan tells you *what* to build and *why*. You decide *how* within the stated constraints. If you disagree with an approach or see a better alternative, flag it before implementing — don't silently deviate and don't silently comply with something you think is wrong.

**Goal:** End-to-end study loop on the dashboard for self-rated activities (L1-L2). Student can start a session, complete card/elaboration activities, self-rate, see mastery progress, and trigger post-session generation — all from `/study/session`. Concept approval now triggers initial activity generation so new concepts aren't empty.

**Architecture:** The dashboard handles all structured study operations via direct SQLite access (master plan Flow 1). SM-2 and mastery algorithms are ported as pure functions to the dashboard (~130 lines including constants and helpers). Session composition, activity completion, and session CRUD all run in the dashboard process with its own Drizzle instance. The only cross-process call is for container operations: generation triggers use IPC files that the main process watcher picks up.

**Tech Stack:** Next.js (dashboard), Drizzle ORM (better-sqlite3), Tailwind CSS, TypeScript

**Branch:** Create `feat/s4-study-session-ui` off `main`. S3 merged via PR #30.

**Spec:** `docs/superpowers/specs/2026-04-12-multi-method-study-system-design.md` (v2.1, Sections 4.5, 7.2, 7.4)

**Master plan:** `docs/superpowers/plans/2026-04-13-study-system-master-plan.md` (S4 checklist)

---

## Codebase Conventions (Hard Constraints)

These apply to **every task**. Subagents must follow these — they're not obvious from context alone.

1. **`.js` extensions on all relative imports in `src/`.** The backend uses Node ESM resolution. Write `import { foo } from './bar.js'`, not `'./bar'`. **Exception:** Dashboard (`dashboard/src/`) does NOT use `.js` extensions — Next.js handles resolution.
2. **camelCase Drizzle properties, snake_case SQL columns** (backend `src/db/schema/study.ts`). Dashboard schema uses snake_case properties matching SQL column names (different convention — see D1).
3. **Drizzle query builder operators** (`eq`, `and`, `lte`, `desc`, `asc`, `count`, `sql`, `inArray`, `gte`) — not raw SQL strings.
4. **Dashboard API routes** use `Response.json()` + try/catch. Pattern: `dashboard/src/app/api/study/concepts/route.ts`.
5. **Dashboard pages** are `'use client'` components with `useState`/`useEffect` for data fetching. Tailwind CSS. Dark theme (bg-gray-950, text-gray-100). Pattern: `dashboard/src/app/study/page.tsx`.
6. **Dashboard imports** do NOT use `.js` extensions. Follow existing patterns in `dashboard/src/lib/study-db.ts` and `dashboard/src/lib/db/index.ts`.
7. **Commit messages** use conventional commits: `feat(study):`, `feat(dashboard):`.
8. **Next.js API conventions may differ from training data.** Read the relevant guide in `node_modules/next/dist/docs/` before writing API routes (especially dynamic `[id]` params).

---

## Spec Deviations

- **No AI evaluation in session UI.** S4 handles only self-rated activities (L1-L2). AI evaluation for L3+ activities is deferred to S5. The session page shows all activity types but the rating flow is always self-rated.
- **Simplified calibration.** The spec says "correlation(confidence, performance)" (Zimmerman 2002). S4 uses a simpler metric: average absolute difference between per-concept confidence (1-5 normalized to 0-1) and average quality (0-5 normalized to 0-1). Full statistical correlation requires more data points than a single session provides.
- **No 7-day analytics.** S4 implements a streak counter (consecutive days with a completed session). Full analytics dashboard (retention trends, calibration curves, Bloom's distribution) deferred to S8.
- **No plan-based sessions.** `study_sessions.plan_id` exists but is always null in S4. Plan-aware sessions are S6.

---

## Key Decisions

### D1: Dashboard schema convention — snake_case properties
Consistent with S2's dashboard schema. The dashboard Drizzle instance uses `row.concept_id`, not `row.conceptId`. Mapper functions (like `rowToSummary()` in study-db.ts) convert to camelCase for API responses.

### D2: Ported algorithms for direct SQLite writes (Flow 1)
The dashboard ports SM-2 and mastery pure functions (~80 lines) to `dashboard/src/lib/study-algorithms.ts`. The dashboard's `completeActivity()` transaction mirrors the backend's — all within its own Drizzle instance. No HTTP proxy to the main process for core study operations.

**Why:** Master plan Flow 1 explicitly assigns "activity completion writes" to direct SQLite access. The algorithms are deterministic and validated by 133 backend tests.

**Tradeoff:** ~130 lines of duplicated pure functions (including constants like `BLOOM_WEIGHTS`, `MASTERY_THRESHOLD`, `DECAY_HALF_LIFE_DAYS` and helpers like `daysSince`, `decayFactor`). If the mastery formula changes, both copies must update. Acceptable because SM-2 is a published algorithm and the mastery model is mathematically defined.

### D3: Generation triggers via IPC file writes
The dashboard writes JSON request files to `data/ipc/study-generator/tasks/`. The main process IPC watcher picks these up. Two new IPC message types: `study_generation_request` and `study_post_session_generation`.

**Why IPC files, not HTTP?** The IPC watcher already monitors this directory. No new server, port, or dependency. The dashboard writes a file; the main process processes it asynchronously.

### D4: Session page is a single-page state machine
`/study/session` handles: PRE_SESSION → IN_PROGRESS → POST_SESSION → COMPLETE. State held client-side. URL doesn't change between phases.

**Why not separate routes?** A study session is a continuous flow — the student shouldn't see URL changes or full-page reloads between activities.

### D5: Enriched session composition
The session GET route returns activities with `prompt`, `referenceAnswer`, and `cardType` appended. The backend's `SessionActivity` type intentionally omits these (session builder doesn't need them). Enrichment happens in the API route by looking up each activity's full record.

---

## Essential Reading

> **For coordinators:** Extract relevant patterns from these files and inline them into subagent prompts. Subagents won't read the files themselves.

| File | Why |
|------|-----|
| `src/study/sm2.ts` | SM-2 algorithm to port — `sm2()`, `computeDueDate()`, `SM2Input`, `SM2Result` |
| `src/study/mastery.ts` | Mastery functions to port — `computeMastery()`, `computeBloomCeiling()`, `computeOverallMastery()` |
| `src/study/queries.ts:412-560` | `completeActivity()` transaction — dashboard mirrors this logic |
| `src/study/engine.ts:133-210` | `processCompletion()` + `getDeEscalationAdvice()` — dashboard mirrors these |
| `src/study/session-builder.ts` | Session composition algorithm — dashboard reimplements this |
| `src/study/types.ts` | `SessionComposition`, `SessionBlock`, `SessionActivity`, `CompletionResult` types |
| `src/db/schema/study.ts` | Full backend schema — dashboard schema must match SQL columns |
| `dashboard/src/lib/study-db.ts` | Existing dashboard queries — extend this file |
| `dashboard/src/lib/db/schema.ts` | Dashboard schema — extend with full learning_activities + study_sessions + activity_log |
| `dashboard/src/app/study/page.tsx` | Existing /study page — update with session card and streak |
| `dashboard/src/app/api/study/concepts/approve/route.ts` | Approve route — wire to generation trigger |
| `src/ipc.ts:265-400` | `processTaskIpc()` — add cases for generation requests |

---

## Task Numbering

| Plan task | Master plan items | What |
|-----------|-------------------|------|
| S4.1 | — | Dashboard schema extension |
| S4.2 | — | Port algorithms + completion logic |
| S4.3 | — | Dashboard session builder + session CRUD |
| S4.4 | — (S3 bootstrapping gap) | Generation triggers + wire approval |
| S4.5 | S4.1 | Study session API routes |
| S4.6 | S4.2 + S4.5 | Update /study overview page |
| S4.7 | S4.3 + S4.4 | Create /study/session page |
| S4.8 | — | Verification |

**Master plan errata:** S4.5 says "Add 'Study' link to dashboard nav" — already done in S2.

---

## Parallelization & Model Recommendations

**Dependencies:**
- S4.1 → S4.2, S4.3 (schema before queries)
- S4.2 + S4.3 can run in parallel (independent modules, both need S4.1)
- S4.4 is fully independent (backend IPC + dashboard file write — no schema dependency)
- S4.5 depends on S4.2 + S4.3 + S4.4 (routes call these)
- S4.6 + S4.7 can run in parallel (separate pages, both need S4.5)

**Parallel opportunities:**
- S4.1 + S4.4 (dashboard schema + backend IPC — independent codebases)
- S4.2 + S4.3 (algorithms + session builder — independent modules)
- S4.6 + S4.7 (overview page + session page — separate files)

| Task | Can parallel with | Model | Rationale |
|------|-------------------|-------|-----------|
| S4.1 | S4.4 | Sonnet | Schema declarations — exact code |
| S4.2 | S4.3 | Sonnet | Port pure functions + transaction following backend pattern |
| S4.3 | S4.2 | Sonnet | Session builder from spec algorithm + CRUD |
| S4.4 | S4.1 | Sonnet | IPC handler case + file write utility |
| S4.5 | — | Sonnet | API routes following existing pattern |
| S4.6 | S4.7 | Sonnet | Page update following existing pattern |
| S4.7 | S4.6 | Sonnet | UI state machine, well-specified requirements |
| S4.8 | — | Sonnet | Mechanical verification |

**Skip two-stage review for:** S4.1, S4.4, S4.8 (schema, IPC handler, verification). Full review for: S4.2, S4.3, S4.5, S4.7.

---

## S4.1: Dashboard Schema Extension

**Files:** Modify `dashboard/src/lib/db/schema.ts`

**Parallelizable with S4.4.**

The S2 plan noted: "The `learning_activities` definition is a minimal subset. S4 will extend this definition when the session UI needs additional fields."

**Extend `learning_activities`** — add all missing columns from the backend schema (`src/db/schema/study.ts:learningActivities`). The columns to add: `prompt` (text, notNull), `reference_answer` (text), `difficulty_estimate` (integer, default 5), `card_type` (text), `author` (text, default 'system'), `source_note_path` (text), `source_chunk_hash` (text), `generated_at` (text, notNull), `ease_factor` (real, default 2.5), `interval_days` (integer, default 1), `repetitions` (integer, default 0), `last_reviewed` (text), `last_quality` (integer).

**Add `study_sessions` table** — design decision (exact schema):
```typescript
export const study_sessions = sqliteTable('study_sessions', {
  id: text('id').primaryKey(),
  started_at: text('started_at').notNull(),
  ended_at: text('ended_at'),
  session_type: text('session_type').notNull(),
  plan_id: text('plan_id'),
  pre_confidence: text('pre_confidence'),
  post_reflection: text('post_reflection'),
  calibration_score: real('calibration_score'),
  activities_completed: integer('activities_completed').default(0),
  total_time_ms: integer('total_time_ms'),
  surface: text('surface'),
});
```

**Add `activity_log` table** — design decision (exact schema):
```typescript
export const activity_log = sqliteTable('activity_log', {
  id: text('id').primaryKey(),
  activity_id: text('activity_id').notNull(),
  concept_id: text('concept_id').notNull(),
  activity_type: text('activity_type').notNull(),
  bloom_level: integer('bloom_level').notNull(),
  quality: integer('quality').notNull(),
  response_text: text('response_text'),
  response_time_ms: integer('response_time_ms'),
  confidence_rating: integer('confidence_rating'),
  scaffolding_level: integer('scaffolding_level').default(0),
  evaluation_method: text('evaluation_method').default('self_rated'),
  ai_quality: integer('ai_quality'),
  ai_feedback: text('ai_feedback'),
  method_used: text('method_used'),
  surface: text('surface'),
  session_id: text('session_id'),
  reviewed_at: text('reviewed_at').notNull(),
});
```

- [ ] **Step 1:** Extend `learning_activities` with all missing columns
- [ ] **Step 2:** Add `study_sessions` table definition
- [ ] **Step 3:** Add `activity_log` table definition
- [ ] **Step 4:** Verify: `cd dashboard && npx tsc --noEmit`
- [ ] **Step 5:** Commit: `feat(dashboard): extend study schema for session UI (S4.1)`

---

## S4.2: Port Algorithms + Completion Logic

**Files:** Create `dashboard/src/lib/study-algorithms.ts`, modify `dashboard/src/lib/study-db.ts`

**Parallelizable with S4.3** (after S4.1).

### Algorithms to port

Create `dashboard/src/lib/study-algorithms.ts`. Port these pure functions **verbatim** from the backend:

| Source file | Functions + dependencies | Approx lines |
|-------------|------------------------|-------------|
| `src/study/sm2.ts` | `sm2()`, `computeDueDate()`, `SM2Input`, `SM2Result` | ~30 |
| `src/study/mastery.ts` | `computeMastery()`, `computeBloomCeiling()`, `computeOverallMastery()` + constants (`BLOOM_WEIGHTS`, `MASTERY_THRESHOLD`, `DECAY_HALF_LIFE_DAYS`) + helpers (`daysSince`, `decayFactor`) | ~100 |

**Constraint:** Port the exact algorithm logic. Do NOT simplify, optimize, or refactor. Differences between the two copies would produce divergent mastery scores. Copy the function bodies AND all constants/helpers they depend on (e.g., `BLOOM_WEIGHTS`, `MASTERY_THRESHOLD`, `DECAY_HALF_LIFE_DAYS`, `daysSince`, `decayFactor`).

### Completion logic in study-db.ts

Add two functions:

**`completeActivity(input): CompleteActivityResult`** — mirror the backend's transaction from `src/study/queries.ts:447-560`:
1. Look up the activity (throw if not found)
2. Compute SM-2 update → call ported `sm2()` + `computeDueDate()`
3. Mastery state heuristic: `repetitions === 0` → 'learning', `intervalDays >= 21` → 'mastered', else → 'reviewing'
4. Update activity row: `ease_factor`, `interval_days`, `repetitions`, `due_at`, `last_reviewed`, `last_quality`, AND `mastery_state` (from step 3)
5. Insert activity_log entry with `crypto.randomUUID()` for ID. Default `evaluation_method` to `'self_rated'`, `ai_quality`/`ai_feedback`/`method_used` to null.
6. Recompute concept mastery from ALL logs → ported `computeMastery()` + `computeBloomCeiling()` + `computeOverallMastery()`
7. Update concept's mastery fields + bloomCeiling
8. Increment session `activities_completed` if sessionId provided
All within `getDb().transaction()`.

**Interfaces:**
```typescript
export interface CompleteActivityInput {
  activityId: string;
  quality: number;
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
```

**`processCompletion(input): CompletionResult`** — mirror `src/study/engine.ts:133-210`:
1. Look up activity to get conceptId
2. Call `completeActivity(input)`
3. If `bloomCeilingAfter > bloomCeilingBefore`: look up concept for title, check if activities exist at new level, build advancement object
4. De-escalation: get last 5 logs for this concept, if avg quality < 2.5 and ceiling > 1 → return advice string
5. Return CompletionResult

```typescript
export interface CompletionResult {
  logEntryId: string;
  newDueAt: string;
  advancement: { conceptId: string; conceptTitle: string; previousCeiling: number; newCeiling: number; generationNeeded: boolean } | null;
  generationNeeded: boolean;
  deEscalation: string | null;
}
```

**Agent discretion:** Internal helpers, whether to extract de-escalation into a standalone function.

- [ ] **Step 1:** Create `dashboard/src/lib/study-algorithms.ts` — port sm2 + mastery
- [ ] **Step 2:** Add `completeActivity` transaction to study-db.ts
- [ ] **Step 3:** Add `processCompletion` wrapper to study-db.ts
- [ ] **Step 4:** Verify: `cd dashboard && npx tsc --noEmit`
- [ ] **Step 5:** Commit: `feat(dashboard): add study algorithms and completion logic (S4.2)`

---

## S4.3: Dashboard Session Builder + Session CRUD

**Files:** Create `dashboard/src/lib/session-builder.ts`, modify `dashboard/src/lib/study-db.ts`

**Parallelizable with S4.2** (after S4.1).

### Session Builder

Create `dashboard/src/lib/session-builder.ts` implementing `buildSessionComposition(options?)`.

Follow the same algorithm as the backend's `src/study/session-builder.ts` (spec Section 4.5):

1. Get all due activities (where `due_at <= today`). Get all active concepts → Map by id.
2. Enrich each activity with concept metadata. Skip activities whose concept is missing.
3. If `domainFocus` set, filter to matching domain.
4. Target count: `targetActivities ?? 20`.

**Block composition:**
- **New material (~30%):** bloomLevel 1-2, concept's bloomCeiling < 3. Group by domain for topic coherence.
- **Review (~50%):** Everything NOT in new block. Sort by: most overdue first, lowest ease_factor. Interleave: never 2 consecutive with same conceptId (best-effort — skip and append).
- **Stretch (~20%):** bloomLevel >= 4, concept's bloomCeiling >= 4. NOT already in review.

5. Domain coverage: if an active domain with due activities is missing, swap lowest-priority review activity.
6. If total < target, fill from remaining pool.
7. Estimate minutes: card_review 1.5, elaboration 3, self_explain/comparison/case_analysis/concept_map 5, synthesis/socratic 7.

**Return type** — define interfaces locally (same shape as backend's `types.ts`):
```typescript
export interface SessionBlock { type: 'new' | 'review' | 'stretch'; activities: SessionActivity[] }
export interface SessionActivity { activityId: string; conceptId: string; conceptTitle: string; domain: string | null; activityType: string; bloomLevel: number }
export interface SessionComposition { blocks: SessionBlock[]; totalActivities: number; estimatedMinutes: number; domainsCovered: string[] }
export interface SessionOptions { targetActivities?: number; domainFocus?: string }
```

**Constraint:** No due activities → return `{ blocks: [], totalActivities: 0, estimatedMinutes: 0, domainsCovered: [] }`.
**Constraint:** Activities without a matching concept are silently skipped.

### DB queries needed

Add to study-db.ts:

| Function | Signature | Notes |
|----------|-----------|-------|
| `getDueActivities` | `() → ActivityRow[]` | `due_at <= today`, all columns (session builder + enrichment need them) |
| `getActivityById` | `(id: string) → ActivityRow \| undefined` | Full activity row |
| `getActivitiesByConceptId` | `(conceptId: string) → ActivityRow[]` | For advancement checks in processCompletion |
| `getRecentLogs` | `(conceptId: string, limit: number) → LogRow[]` | For de-escalation check |

### Session CRUD

Add to study-db.ts:

| Function | Signature | Notes |
|----------|-----------|-------|
| `createSession` | `(session: NewSession) → void` | Insert into study_sessions |
| `getSessionById` | `(id: string) → SessionRow \| undefined` | Read session |
| `updateSession` | `(id: string, updates: Partial<SessionRow>) → void` | Update endedAt, postReflection, etc. |
| `getRecentSessions` | `(limit: number) → SessionRow[]` | Ordered by started_at desc |
| `getStreakDays` | `() → number` | Consecutive days from today with at least one completed session (endedAt != null) |
| `getActiveSession` | `() → SessionRow \| undefined` | Most recent session with `ended_at = null`, for resume-on-refresh |
| `getLogsBySession` | `(sessionId: string) → LogRow[]` | Activity logs for a session, ordered by reviewed_at |

**Agent discretion:** Helper types, whether to define row→interface mappers, exact streak algorithm.

- [ ] **Step 1:** Add query functions to study-db.ts
- [ ] **Step 2:** Add session CRUD functions to study-db.ts
- [ ] **Step 3:** Create `dashboard/src/lib/session-builder.ts`
- [ ] **Step 4:** Verify: `cd dashboard && npx tsc --noEmit`
- [ ] **Step 5:** Commit: `feat(dashboard): add session builder and session CRUD (S4.3)`

---

## S4.4: Generation Triggers via IPC + Wire Approval

**Files:** Modify `src/ipc.ts`, create `dashboard/src/lib/generation-trigger.ts`, modify `dashboard/src/app/api/study/concepts/approve/route.ts`

**Parallelizable with S4.1.**

Solves the S3 bootstrapping gap: newly approved concepts have zero activities.

### IPC Handler (backend)

Add two new cases to `processTaskIpc()` in `src/ipc.ts`:

**Case `study_generation_request`:** Payload `{ type, conceptId: string, bloomLevel: number }`. Call `generateActivities(conceptId, bloomLevel)` from `src/study/generator.js`. Try/catch — log on error, don't crash.

**Case `study_post_session_generation`:** Payload `{ type, sessionId: string }`. Call `triggerPostSessionGeneration(sessionId)` from `src/study/engine.js`. Try/catch.

**Constraint:** These new IPC cases must NOT include `isMain` authorization checks. The `study-generator` directory is not a registered group — `isMain` will be `undefined`/`false`. These are system-internal operations triggered by the dashboard, not group-originated commands.

**Constraint:** Verify the IPC watcher monitors `data/ipc/study-generator/tasks/` at startup (even without an active container). The watcher scans ALL subdirectories of `data/ipc/`, so the directory just needs to exist. The dashboard's `fs.mkdirSync({ recursive: true })` ensures this.

### Dashboard Trigger Helper

Create `dashboard/src/lib/generation-trigger.ts`:

Two exported functions:
- `requestGeneration(conceptId: string, bloomLevel: number): void` — writes `{ type: "study_generation_request", conceptId, bloomLevel }` as JSON to `{projectRoot}/data/ipc/study-generator/tasks/gen-req-{conceptId}-{timestamp}.json`
- `requestPostSessionGeneration(sessionId: string): void` — writes `{ type: "study_post_session_generation", sessionId }` to same directory

Project root: `path.join(process.cwd(), '..')` (same pattern as `dashboard/src/lib/db/index.ts` uses for store dir).

**Constraint:** Create the target directory if it doesn't exist (`fs.mkdirSync({ recursive: true })`). Use unique filenames with timestamps to avoid collisions.

### Wire Approval Route

Modify `dashboard/src/app/api/study/concepts/approve/route.ts`: After each successful approval, call `requestGeneration(conceptId, 1)` for each approved concept. For `approveDomain()` path: iterate over returned IDs. For `approveConcepts()` path: iterate over input `conceptIds`.

**Constraint:** Generation requests are fire-and-forget. If `requestGeneration()` throws, log a warning but still return the successful approval response. Concepts are approved regardless.

**Known behavior:** There's a 30-60 second latency between approval and activities being available (container startup + LLM generation). If a user approves concepts and immediately starts a session, the newly approved concepts will have zero activities and won't appear. This is acceptable — the session builder silently skips concepts without due activities.

- [ ] **Step 1:** Add both cases to `processTaskIpc()` in `src/ipc.ts`
- [ ] **Step 2:** Create `dashboard/src/lib/generation-trigger.ts`
- [ ] **Step 3:** Modify approve route to call `requestGeneration()` after approval
- [ ] **Step 4:** Run backend tests: `npx vitest run src/ipc` — no regressions
- [ ] **Step 5:** Commit: `feat(study): add IPC generation triggers and wire approval (S4.4)`

---

## S4.5: Study Session API Routes

**Files:** Create API routes under `dashboard/src/app/api/study/`

**Depends on:** S4.2, S4.3, S4.4.

**Directory structure:**
```
dashboard/src/app/api/study/
  session/
    route.ts                 — GET (build) + POST (create)
    [id]/
      reflect/
        route.ts             — POST (reflection)
  complete/
    route.ts                 — POST (complete activity)
```

### GET /api/study/session

Call `buildSessionComposition()`. Enrich each activity by looking up the full record via `getActivityById()` — append `prompt`, `referenceAnswer` (mapped from `reference_answer`), and `cardType` (mapped from `card_type`). If activity not found, skip it.

Response: `{ session: EnrichedSessionComposition }`

### POST /api/study/session

Body: `{ sessionType?: string, preConfidence?: Record<string, number> }`

First check for an active session (`getActiveSession()`). If one exists, end it (`endedAt = now`) before creating the new one — prevents orphaned sessions.

Generate UUID. Create session with `startedAt: new Date().toISOString()`, `sessionType: body.sessionType ?? 'daily'`, `preConfidence: JSON.stringify(body.preConfidence ?? {})`, `surface: 'dashboard_ui'`.

Response: `{ sessionId: string }`

### POST /api/study/complete

Body: `{ activityId, quality, sessionId?, responseText?, responseTimeMs?, confidenceRating? }`

Call `processCompletion(body)`. If `result.generationNeeded`, also call `requestGeneration()` with the advancement's conceptId and newCeiling.

Response: the `CompletionResult` object.

### POST /api/study/session/[id]/reflect

Body: `{ reflection: string }`

1. Get session by ID (from URL param). 404 if not found.
2. Compute calibration: parse `preConfidence` JSON, get session's activity logs via `getLogsBySession()`, group logs by conceptId, compute per-concept average quality, compare with confidence. Score = 1 - avg(|confidence/5 - avgQuality/5|). Lower difference = higher score (better calibrated).
3. Update session: `ended_at = now, post_reflection = reflection, calibration_score = computed, total_time_ms = now - started_at`.
4. Call `requestPostSessionGeneration(sessionId)`.

Response: `{ calibrationScore: number, activitiesCompleted: number }`

**Constraint:** Check Next.js dynamic route params API in `node_modules/next/dist/docs/` before implementing the `[id]` route.

- [ ] **Step 1:** Create directory structure
- [ ] **Step 2:** Create GET + POST `/api/study/session` route
- [ ] **Step 3:** Create POST `/api/study/complete` route
- [ ] **Step 4:** Create POST `/api/study/session/[id]/reflect` route
- [ ] **Step 5:** Verify: `cd dashboard && npx tsc --noEmit`
- [ ] **Step 6:** Commit: `feat(dashboard): add study session API routes (S4.5)`

---

## S4.6: Update /study Overview Page

**Files:** Modify `dashboard/src/app/study/page.tsx`, modify `dashboard/src/lib/study-db.ts`

**Parallelizable with S4.7.**

### Per-level mastery in ConceptSummary

Update `rowToSummary()` in study-db.ts and the `ConceptSummary` interface to include `masteryL1` through `masteryL6` (already in the DB, not currently returned).

### Today's Session Card

Add above the "Pending Approval" section:
- Fetch from `GET /api/study/session` on mount
- Show: total activity count, activity breakdown by type, estimated time, domains covered
- "Start Session" button → navigate to `/study/session`
- If no activities due: "All caught up! No activities due today."

### Streak Indicator

Show alongside the stats bar. Call `getStreakDays()` via a new endpoint or include in the concepts stats response. Display "N-day streak" if > 0, hide if 0.

**Agent discretion:** Whether streak is a separate API call or included in existing stats, exact card layout, Tailwind styling, mastery bar design (tiny bars vs. heatmap).

- [ ] **Step 1:** Add per-level mastery to ConceptSummary + rowToSummary
- [ ] **Step 2:** Add session card to /study page
- [ ] **Step 3:** Add streak indicator
- [ ] **Step 4:** Start dashboard: `cd dashboard && npm run dev`. Verify at http://localhost:3100/study
- [ ] **Step 5:** Commit: `feat(dashboard): add session card, streak, per-level mastery to /study (S4.6)`

---

## S4.7: Create /study/session Page

**Files:** Create `dashboard/src/app/study/session/page.tsx`

**Parallelizable with S4.6.**

### State Machine

```
LOADING → PRE_SESSION → IN_PROGRESS → POST_SESSION → COMPLETE
```

**LOADING:** First check for an active session via `GET /api/study/session?resume=true` (or a separate endpoint). If an active session exists (endedAt = null), resume it: fetch the session's composition, check which activities have logs (already completed), and jump to IN_PROGRESS at the next uncompleted activity. If no active session, fetch a fresh composition. If no activities due, show "Nothing to study today" with link to /study.

**PRE_SESSION:** Show unique concepts from composition. For each: concept title + 1-5 confidence buttons ("How well do you know this?"). "Begin Session" button → `POST /api/study/session` with preConfidence map → receive sessionId → transition.

**IN_PROGRESS:** One activity at a time. Flatten blocks into a sequential list but show block labels ("New Material", "Review", "Stretch") when entering a new block.

Activity flow:
1. Show concept title + domain + Bloom level badge (e.g., "L1")
2. Show activity prompt text
3. Text area for response (or text input for card_review)
4. "Submit" button → reveals reference answer below with visual separator
5. Self-rating buttons: 0 (Blackout), 1 (Wrong but recognized), 2 (Wrong but easy recall), 3 (Correct with difficulty), 4 (Correct with hesitation), 5 (Perfect)
6. On rating → `POST /api/study/complete` with quality, sessionId, responseText, responseTimeMs
7. Show result: advancement badge if bloom advanced, de-escalation hint if struggling
8. "Next" button → advance
9. "Skip" button (before submission) → `POST /api/study/complete` with quality=0 (counts toward `activities_completed` — SM-2 treats this as a failed recall, resetting interval to 1 day)

Track `responseTimeMs`: `Date.now()` delta from prompt display to Submit click.

Progress bar: `{current} / {total}` with visual bar at top.

**POST_SESSION** (fulfills master plan S4.4 — post-session reflection):
- Summary: activities completed, average quality, time spent
- Calibration: per-concept "Predicted X, scored Y" with over/under feedback. Compute client-side from the preConfidence map (stored in state from PRE_SESSION) and completion results (accumulated during IN_PROGRESS). "Underestimated!" if scored higher, "Overconfident" if scored lower.
- Reflection text area: "What did you find surprising or difficult?"
- "Complete" → `POST /api/study/session/{id}/reflect`

**COMPLETE:** Summary stats, link to /study.

### Design

- Dark theme: bg-gray-950, text-gray-100 (consistent with dashboard)
- Activity card: bg-gray-900, rounded, generous padding
- Reference answer: bg-gray-800, visual separator
- Rating buttons: horizontal row, selected state highlight
- Progress bar: thin colored bar at top
- Block labels: subtle divider with text

**Agent discretion:** Component decomposition, exact Tailwind, animations, mobile responsiveness, keyboard shortcuts.

- [ ] **Step 1:** Create page with state machine skeleton
- [ ] **Step 2:** Implement LOADING + PRE_SESSION phases
- [ ] **Step 3:** Implement IN_PROGRESS phase
- [ ] **Step 4:** Implement POST_SESSION + COMPLETE phases
- [ ] **Step 5:** Start dashboard, test full flow at http://localhost:3100/study/session
- [ ] **Step 6:** Commit: `feat(dashboard): add /study/session page with full study loop (S4.7)`

---

## S4.8: Verification

- [ ] **Step 1:** Run backend tests: `npm test` — all pass, no regressions
- [ ] **Step 2:** Build: `npm run build` — clean
- [ ] **Step 3:** Dashboard types: `cd dashboard && npx tsc --noEmit` — clean
- [ ] **Step 4:** Start dashboard, navigate to /study — session card visible
- [ ] **Step 5:** Click "Start Session" — pre-confidence renders
- [ ] **Step 6:** Complete a card_review: type answer → submit → rate 5 → verify reference reveals
- [ ] **Step 7:** Complete an elaboration: type explanation → submit → rate → verify
- [ ] **Step 8:** Skip an activity → verify quality=0 logged
- [ ] **Step 9:** Complete session → reflection form + calibration feedback
- [ ] **Step 10:** Submit reflection → verify redirect to /study, mastery updated
- [ ] **Step 11:** Commit: `chore(study): verify study session end-to-end (S4.8)`

---

## Acceptance Criteria

From master plan S4 (non-negotiable):

- [ ] Student can start a session, complete card + elaboration activities, rate themselves
- [ ] SM-2 schedules update after each completion (due dates change)
- [ ] Mastery bars update after session
- [ ] Pre/post metacognition flow works (confidence → calibration feedback → reflection)
- [ ] Session recorded in study_sessions table
- [ ] Concept approval triggers initial L1-L2 activity generation (bootstrapping resolved)
- [ ] All existing tests pass (`npm test`)
- [ ] Clean build (`npm run build`, `cd dashboard && npx tsc --noEmit`)
