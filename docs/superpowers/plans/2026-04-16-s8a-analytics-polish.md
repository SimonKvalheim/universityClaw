# S8a: Analytics + Concept Detail + Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Your role:** You are the engineer implementing this. The plan tells you *what* to build and *why*. You decide *how* within the stated constraints. If you disagree with an approach or see a better alternative, flag it before implementing — don't silently deviate and don't silently comply with something you think is wrong.

**Goal:** Add learning analytics (API + dashboard visualization), a concept detail page, prerequisite awareness warnings, and staleness detection — surfacing the data the study system already collects into actionable insights and quality signals.

**Architecture:** S8a is entirely about data presentation and awareness. No new LLM integration, no new IPC handlers, no container changes. Analytics queries run against the existing `activity_log` and `concepts` tables in dashboard-side Drizzle. The concept detail page is a new dashboard route reading existing data. Prerequisite and staleness warnings enrich the session API response and session UI. All work is dashboard queries + API routes + UI.

**Tech Stack:** TypeScript/Node.js (backend queries), Next.js + React (dashboard), Drizzle ORM + SQLite (storage), Vitest (tests), CSS-based visualizations (no charting library — follow existing mastery bar pattern on `/study` page)

**Branch:** Create `feat/s8a-analytics-polish` off `main`.

**Spec:** `docs/superpowers/specs/2026-04-12-multi-method-study-system-design.md` (Sections 7.5, 10)

**Master plan:** `docs/superpowers/plans/2026-04-13-study-system-master-plan.md` (S8.1, S8.2, S8.7, S8.8)

---

## Codebase Conventions (Hard Constraints)

These apply to **every task**. Subagents must follow these — they're not obvious from context alone.

1. **`.js` extensions on all relative imports in `src/`.** The backend uses Node ESM resolution. Write `import { foo } from './bar.js'`, not `'./bar'`. **Exception:** Dashboard (`dashboard/src/`) does NOT use `.js` extensions — Next.js handles resolution.
2. **Dashboard schema uses snake_case.** `dashboard/src/lib/db/schema.ts` defines tables with snake_case column names (e.g., `activity_log.bloom_level`, `concepts.mastery_L1`). This differs from the backend schema which uses camelCase Drizzle properties.
3. **Dashboard API routes must map snake_case DB → camelCase JSON responses.** All `study-db.ts` query functions return snake_case from Drizzle, and the API routes (or the query functions themselves) transform to camelCase for the frontend. Follow the existing `rowToSummary()` pattern in `study-db.ts`.
4. **Drizzle query builder operators** (`eq`, `and`, `lte`, `desc`, `asc`, `count`, `sql`, `inArray`, `gte`) — not raw SQL strings. Exception: `sql` template tag for computed expressions Drizzle can't express natively.
5. **Commit messages** use conventional commits: `feat(study):`, `feat(dashboard):`.
6. **Test file locations:** Backend tests are colocated: `src/study/foo.test.ts`. Dashboard tests go in `dashboard/src/**/*.test.ts` (or `__tests__/`). Use `_initTestDatabase()` from `../db/index.js` for backend test DBs.
7. **Study query functions** for the dashboard live in `dashboard/src/lib/study-db.ts`. Backend study queries live in `src/study/queries.ts`.
8. **Dashboard UI style:** Dark theme, Tailwind CSS. Gray-900/950 backgrounds, gray-800 borders, blue-700 buttons, green-500 for progress bars. Follow existing component patterns in `dashboard/src/app/study/page.tsx`.
9. **No charting library.** Use CSS-based bars/visualizations. The existing mastery bars use `div` elements with percentage `width` styling. Follow this pattern for analytics visualizations.

---

## Spec Deviations

- **Deferred: time-to-level and decay rate metrics.** The spec (Section 10.1) lists "time to level" and "decay rate" as analytics metrics. These require historical bloom_ceiling tracking that doesn't currently exist (bloom_ceiling is overwritten, not logged historically). **Deferred to post-S8** when activity_log provides enough longitudinal data to derive these retroactively. S8a implements the 5 metrics that are computable from current schema.
- **Deferred: scaffolding dependency metric.** The spec lists "scaffolding dependency" as a metric. Scaffolding isn't implemented until S8b (S8.6). The `scaffolding_level` column exists but is always 0. Metric deferred until S8b ships.
- **Staleness uses file mtime, not chunk hash comparison.** The spec envisions comparing `source_chunk_hash` against current vault content. However, the hash is of an arbitrary chunk selected by the generator agent — there's no reliable way to re-derive the same chunk boundary at detection time. S8a uses file modification time (`mtime > generated_at`) as the staleness signal instead. This catches all meaningful staleness (source content changed after generation) without the chunk-matching complexity. The `source_chunk_hash` column remains available for future precision improvements.
- **Prerequisite data is read-only in S8a.** The `concept_prerequisites` table exists but has no population mechanism yet (no UI to add prerequisites, no auto-detection). S8a adds the query + display infrastructure. Prerequisites can be populated manually via SQL or added through a future UI. The display works correctly with zero prerequisites (shows nothing).

---

## Key Decisions

### D1: Analytics queries live in dashboard study-db.ts, not backend queries.ts
Analytics are only consumed by dashboard API routes. Adding them to the backend `src/study/queries.ts` would add unused code to the main process. Dashboard queries go in `dashboard/src/lib/study-db.ts` following the established pattern.

**Why not a separate analytics-db.ts?** The established pattern puts all study queries in `study-db.ts`. The file is currently ~1025 lines and will grow to ~1200 with analytics + concept detail additions. This is large but acceptable — all functions share the same DB connection and schema imports. Splitting by feature (analytics vs. CRUD) would duplicate imports and break the single-file convention. If it becomes unwieldy later, extraction is straightforward.

### D2: Analytics are computed on-read, not cached
Each `/api/study/stats` request runs the analytics queries fresh. With a single-user SQLite database under 10K rows, these queries complete in <10ms. No caching layer needed.

**Tradeoff:** If the dataset grows to 100K+ activity_log entries, some queries (especially the time-series aggregation) may need caching. Acceptable for now — the student would need years of daily study to reach that scale.

### D3: Concept detail page uses dynamic route, not a modal
The concept detail is a separate page at `/study/concepts/[id]`, not an expand-in-place component on the overview page. This matches the master plan's file map and provides a stable URL for linking from session UI, chat, and Telegram.

### D4: Staleness detection runs at session build time
When the session API (`GET /api/study/session`) builds the session composition, it checks each activity's `source_note_path` against the filesystem. Stale activities get a `stale: true` flag in the response. The session UI displays a warning badge.

**Why not a background job?** The single-user system has <100 activities per session. File stat operations are ~0.1ms each. Running at request time is simpler and guarantees fresh results.

### D5: Prerequisite warnings use a configurable weakness threshold
A prerequisite is "weak" when its concept's `mastery_overall` is below 0.3 (30% of maximum). This threshold is a constant in `study-db.ts` — easy to tune after observing real data. The warning is advisory, not blocking.

---

## Essential Reading

> **For coordinators:** Extract relevant patterns from these files and inline them into subagent prompts. Subagents won't read the files themselves.

| File | Why |
|------|-----|
| `dashboard/src/lib/study-db.ts` | All existing dashboard study queries. S8a adds analytics + concept detail + prereq functions here. Follow `getActiveConcepts()` and `rowToSummary()` patterns. |
| `dashboard/src/lib/db/schema.ts` | Dashboard Drizzle schema — **snake_case** column names. Key tables: `concepts`, `learning_activities`, `activity_log`, `study_sessions`, `study_plans`. |
| `dashboard/src/app/study/page.tsx` | Current overview page. S8a.4 adds analytics section here. Follow UI patterns (dark theme, section headers, CSS bars). |
| `dashboard/src/app/study/session/page.tsx` | Session UI. S8a.3 adds prerequisite + staleness warnings here. |
| `dashboard/src/app/api/study/session/route.ts` | Session API. S8a.3 enriches the GET response with warnings. |
| `dashboard/src/app/api/study/concepts/route.ts` | Existing concepts list API. S8a.2 creates a sibling `[id]/route.ts`. |
| `dashboard/src/lib/session-builder.ts` | Session composition builder. S8a.3 may need to pass through extra fields. |
| `src/study/queries.ts` | Backend query functions. Reference only — S8a does not modify this file. |
| `src/db/schema/study.ts` | Backend Drizzle schema — **camelCase** properties. Reference for column names. Has `conceptPrerequisites` and `activityConcepts` tables that need dashboard-side equivalents. |

---

## Task Numbering

| Plan task | Master plan items | What |
|-----------|-------------------|------|
| S8a.1 | S8.1 | Analytics queries + API route |
| S8a.2 | S8.2 | Concept detail queries + API + page |
| S8a.3 | S8.7, S8.8 | Prerequisite awareness + staleness detection (session enrichment + UI) |
| S8a.4 | S8.1 (dashboard) | Analytics dashboard section on `/study` + concept links |
| S8a.5 | — | Tests + verification |

---

## Parallelization & Model Recommendations

**Dependencies:**
- S8a.1 is independent (adds to study-db.ts + creates stats route)
- S8a.2 depends on S8a.1 (both modify `study-db.ts` — must run sequentially)
- S8a.3 depends on S8a.2 (needs `concept_prerequisites` and `activity_concepts` tables added to dashboard schema by S8a.2)
- S8a.4 depends on S8a.1 (calls `/api/study/stats`) and S8a.2 (links to concept detail page)
- S8a.5 depends on all

**Execution order:** S8a.1 → S8a.2 → S8a.3 → S8a.4 → S8a.5. Limited parallelism — the tasks form a dependency chain through `study-db.ts` and `dashboard/src/lib/db/schema.ts`. S8a.4 can run after S8a.2 (in parallel with S8a.3) since it only reads the stats API and links to concept pages.

**Parallel opportunities:**
- **Wave 1:** S8a.1 (only independent task)
- **Wave 2:** S8a.2 (depends on S8a.1 for study-db.ts)
- **Wave 3:** S8a.3 + S8a.4 (S8a.3 uses schema from S8a.2; S8a.4 uses APIs from S8a.1 + pages from S8a.2 — no file overlap between S8a.3 and S8a.4)
- **Wave 4:** S8a.5 (verification)

| Task | Can parallel with | Model | Rationale |
|------|-------------------|-------|-----------|
| S8a.1 | — | Sonnet | Mechanical Drizzle queries + API route |
| S8a.2 | — | Sonnet | Queries + API + page creation (follows patterns) |
| S8a.3 | S8a.4 | Sonnet | Query + session enrichment + UI badges |
| S8a.4 | S8a.3 | Sonnet | UI section following existing patterns |
| S8a.5 | — | Sonnet | Mechanical verification |

**File ownership for Wave 3 parallel agents:**
- **S8a.3 agent:** Owns `dashboard/src/lib/session-warnings.ts` (create), `dashboard/src/app/api/study/session/route.ts` (modify GET handler), `dashboard/src/app/study/session/page.tsx` (add warning UI). Imports `concept_prerequisites` and `activity_concepts` from `dashboard/src/lib/db/schema.ts` (added by S8a.2). Do NOT touch the `/study` overview page, stats route, or concept detail page.
- **S8a.4 agent:** Owns `dashboard/src/app/study/page.tsx` (add analytics section + concept links). Do NOT touch session routes, session page, study-db.ts, or schema files.

---

## S8a.1: Analytics Queries + API Route

**Files:** Modify `dashboard/src/lib/study-db.ts` (add analytics functions), create `dashboard/src/app/api/study/stats/route.ts`

**Parallelizable with S8a.3.**

### Analytics functions to add to study-db.ts

Add these functions at the end of `dashboard/src/lib/study-db.ts`, after the existing plan functions. Each returns a camelCase response object.

**1. `getRetentionRate(days: number)`**
Query `activity_log` for entries where `reviewed_at >= date('now', '-N days')`. Compute: `count(quality >= 3) / count(*)`. Return `{ retentionRate: number, totalReviews: number, correctReviews: number }`.

Dashboard schema columns: `activity_log.reviewed_at`, `activity_log.quality`.

**2. `getBloomDistribution(days: number)`**
Query `activity_log` where `reviewed_at >= date('now', '-N days')`, group by `bloom_level`. Return `Array<{ bloomLevel: number, count: number, percentage: number }>`.

Dashboard schema columns: `activity_log.bloom_level`, `activity_log.reviewed_at`.

**3. `getMethodEffectiveness()`**
Query `activity_log`, group by `activity_type`. For each type: `avg(quality)`, `count(*)`. Return `Array<{ activityType: string, avgQuality: number, count: number }>`. Order by avgQuality desc.

Dashboard schema columns: `activity_log.activity_type`, `activity_log.quality`.

**4. `getActivityTimeSeries(days: number)`**
Query `activity_log` where `reviewed_at >= date('now', '-N days')`, group by date (truncate reviewed_at to date). Return `Array<{ date: string, count: number, avgQuality: number }>`. Fill gaps with zero-count entries for days with no activity.

Dashboard schema columns: `activity_log.reviewed_at`, `activity_log.quality`.

**5. `getCalibrationData(days: number)`**
Query `activity_log` where `reviewed_at >= date('now', '-N days')` AND `confidence_rating IS NOT NULL`. Return `{ calibrationScore: number | null, dataPoints: number }`. Calibration = Pearson correlation between `confidence_rating` and `quality`. Return null if fewer than 5 data points.

Dashboard schema columns: `activity_log.confidence_rating`, `activity_log.quality`, `activity_log.reviewed_at`.

### API route

Create `dashboard/src/app/api/study/stats/route.ts`:

```typescript
// GET /api/study/stats?days=7
// Returns all analytics metrics for the given time window
```

Query param `days` defaults to 7. Calls all 5 analytics functions and returns a combined response:
```typescript
{
  retentionRate: { retentionRate, totalReviews, correctReviews },
  bloomDistribution: [...],
  methodEffectiveness: [...],
  activityTimeSeries: [...],
  calibration: { calibrationScore, dataPoints },
  period: { days, from, to }
}
```

**Agent discretion:** Pearson correlation implementation (inline helper or import a tiny utility), gap-filling strategy for time series, exact Drizzle `sql` template syntax for date arithmetic.

### Tests

The Drizzle analytics queries are thin wrappers around SQL — testing them requires a real DB. Test the pure computation helpers instead:

Create `dashboard/src/lib/__tests__/analytics.test.ts` that tests:
1. **Pearson correlation helper:** Known dataset with expected r-value, edge case with < 5 points returns null
2. **Gap-filling for time series:** Date range with missing days filled with zero-count entries
3. **Retention rate computation:** Mixed quality values (0-5) — verify threshold at quality >= 3

The dashboard test infrastructure runs via `cd dashboard && npm test` (Vitest).

- [ ] **Step 1:** Add the 5 analytics query functions to `dashboard/src/lib/study-db.ts`
- [ ] **Step 2:** Create `dashboard/src/app/api/study/stats/route.ts` with GET handler
- [ ] **Step 3:** Run `cd dashboard && npm run build` — verify clean
- [ ] **Step 4:** Create `dashboard/src/lib/__tests__/analytics.test.ts` with Pearson correlation test
- [ ] **Step 5:** Run `cd dashboard && npm test` — verify pass
- [ ] **Step 6:** Run `npm test` (root) — no regressions
- [ ] **Step 7:** Commit: `feat(dashboard): add analytics queries and /api/study/stats endpoint (S8a.1)`

---

## S8a.2: Concept Detail Queries + API + Page

**Files:** Modify `dashboard/src/lib/study-db.ts` (add concept detail function), create `dashboard/src/app/api/study/concepts/[id]/route.ts`, create `dashboard/src/app/study/concepts/[id]/page.tsx`

**Depends on:** S8a.1 (both modify study-db.ts — run after S8a.1 commits).

### Concept detail query

Add `getConceptDetail(id: string)` to `dashboard/src/lib/study-db.ts`. Returns a rich object:

```typescript
interface ConceptDetail {
  // Core concept data (same as ConceptSummary)
  id: string;
  title: string;
  domain: string | null;
  subdomain: string | null;
  course: string | null;
  vaultNotePath: string | null;
  status: string;
  bloomCeiling: number;
  masteryOverall: number;
  masteryL1: number; masteryL2: number; masteryL3: number;
  masteryL4: number; masteryL5: number; masteryL6: number;
  createdAt: string;
  lastActivityAt: string | null;

  // Enrichment
  dueCount: number;
  totalActivities: number;
  activities: Array<{
    id: string;
    activityType: string;
    bloomLevel: number;
    dueAt: string;
    masteryState: string;
    author: string;
  }>;
  recentLogs: Array<{
    id: string;
    activityType: string;
    bloomLevel: number;
    quality: number;
    evaluationMethod: string;
    reviewedAt: string;
  }>;
  methodEffectiveness: Array<{
    activityType: string;
    avgQuality: number;
    count: number;
  }>;
  relatedConcepts: Array<{
    id: string;
    title: string;
    role: string;
  }>;
  prerequisites: Array<{
    id: string;
    title: string;
    bloomCeiling: number;
    masteryOverall: number;
  }>;
}
```

**Queries needed:**
1. Concept row from `concepts` table (existing `getActiveConcepts` pattern)
2. Activities from `learning_activities` where `concept_id = id`, ordered by `bloom_level` asc
3. Due count: subset of activities where `due_at <= today`
4. Recent logs from `activity_log` where `concept_id = id`, limit 20, order by `reviewed_at` desc
5. Method effectiveness: `activity_log` where `concept_id = id`, group by `activity_type`
6. Related concepts via `activity_concepts` join table. **Join path:** `learning_activities WHERE concept_id = id` → `activity_concepts WHERE activity_id IN those activity IDs` → `concepts WHERE id = activity_concepts.concept_id AND id != original concept_id`. Note: only multi-concept activities (comparisons, synthesis) create `activity_concepts` entries. This will be empty for concepts that haven't reached L4+ — that's expected, not a bug.
7. Prerequisites from `concept_prerequisites` where `concept_id = id`, joined with concepts table for title + mastery

Dashboard schema columns for `concept_prerequisites`: This table is defined in the backend schema (`src/db/schema/study.ts`) as `conceptPrerequisites` with columns `concept_id` and `prerequisite_id`. **The dashboard schema (`dashboard/src/lib/db/schema.ts`) does NOT yet have this table defined.** S8a.2 must add it.

### Dashboard schema addition

Add to `dashboard/src/lib/db/schema.ts`:
```typescript
import { primaryKey } from 'drizzle-orm/sqlite-core';

export const concept_prerequisites = sqliteTable('concept_prerequisites', {
  concept_id: text('concept_id').notNull(),
  prerequisite_id: text('prerequisite_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.concept_id, table.prerequisite_id] }),
]);

export const activity_concepts = sqliteTable('activity_concepts', {
  activity_id: text('activity_id').notNull(),
  concept_id: text('concept_id').notNull(),
  role: text('role').default('related'),
}, (table) => [
  primaryKey({ columns: [table.activity_id, table.concept_id] }),
]);
```

These tables exist in the DB (created by backend migrations) but weren't exposed in the dashboard schema because no dashboard feature needed them until now. The primary keys match the backend schema in `src/db/schema/study.ts`.

### API route

Create `dashboard/src/app/api/study/concepts/[id]/route.ts`:

```typescript
// GET /api/study/concepts/abc123
// Returns full concept detail
```

Returns `{ concept: ConceptDetail }` or `{ error: 'Concept not found' }` with 404.

### Concept detail page

Create `dashboard/src/app/study/concepts/[id]/page.tsx`:

**Layout (top to bottom):**
1. **Header:** Concept title, domain/subdomain badge, vault link (if `vaultNotePath` set)
2. **Mastery section:** 6-level horizontal bar chart (L1-L6). Each bar shows mastery evidence / threshold, color-coded by level (green = mastered, yellow = progressing, gray = untouched). Current `bloomCeiling` highlighted.
3. **Activities section:** Table of all activities for this concept: type, Bloom level, due date, mastery state, author (system/student). "Generate more" button at bottom.
4. **Activity history:** Recent activity log entries: date, type, Bloom level, quality score, evaluation method. Limited to 20 most recent.
5. **Method effectiveness:** Small CSS bar chart showing avg quality per method type used for this concept.
6. **Related concepts:** List of concepts linked via multi-concept activities (comparisons, synthesis). Each is a link to its detail page.
7. **Prerequisites:** List of prerequisite concepts with their mastery status. Weak prerequisites (mastery_overall < 0.3) highlighted in amber.

**"Generate more activities" button:** For S8a, this is a placeholder — clicking shows a toast "Generation requested" with no actual API call. Wiring it to the generator (via IPC to the existing `study_generation_request` handler) is S8b work. Do NOT POST to `/api/study/evaluate` — that endpoint is for AI evaluation, not generation.

**Agent discretion:** Exact layout proportions, color choices within the dark theme palette, whether to use tabs or scroll sections, "Generate more" button behavior.

- [ ] **Step 1:** Add `concept_prerequisites` and `activity_concepts` tables to `dashboard/src/lib/db/schema.ts`
- [ ] **Step 2:** Add `getConceptDetail(id)` function to `dashboard/src/lib/study-db.ts`
- [ ] **Step 3:** Create `dashboard/src/app/api/study/concepts/[id]/route.ts`
- [ ] **Step 4:** Create `dashboard/src/app/study/concepts/[id]/page.tsx`
- [ ] **Step 5:** Run `cd dashboard && npm run build` — verify clean
- [ ] **Step 6:** Run `npm test` (root) — no regressions
- [ ] **Step 7:** Commit: `feat(dashboard): add concept detail page with mastery breakdown and activity history (S8a.2)`

---

## S8a.3: Prerequisite Awareness + Staleness Detection

**Files:** Create `dashboard/src/lib/session-warnings.ts`, modify `dashboard/src/app/api/study/session/route.ts` (enrich GET response), modify `dashboard/src/app/study/session/page.tsx` (add warning UI)

**Parallelizable with S8a.1** (no file overlap — S8a.3 creates a new utility file and modifies session-specific files only).

### Session warnings utility

Create `dashboard/src/lib/session-warnings.ts`. This file contains two functions:

**1. `getPrerequisiteWarnings(conceptIds: string[])`**

For each concept ID in the session, query `concept_prerequisites` to find prerequisite concepts, then check if any prerequisite has `mastery_overall < WEAK_PREREQUISITE_THRESHOLD` (0.3).

Returns:
```typescript
Array<{
  conceptId: string;
  conceptTitle: string;
  weakPrerequisites: Array<{
    id: string;
    title: string;
    masteryOverall: number;
  }>;
}>
```

Only returns entries where `weakPrerequisites.length > 0`.

Dashboard schema columns:
- `concept_prerequisites.concept_id`, `concept_prerequisites.prerequisite_id`
- `concepts.id`, `concepts.title`, `concepts.mastery_overall`

**Note:** Import the `concept_prerequisites` table from `dashboard/src/lib/db/schema.ts` — added by S8a.2 which runs before S8a.3.

**2. `getStalenessWarnings(activities: Array<{ activityId: string, sourceNotePath: string | null, generatedAt: string }>)`**

For each activity with a non-null `sourceNotePath`:
1. Resolve the path relative to the vault directory (use `process.env.VAULT_DIR || './vault'`)
2. Call `fs.statSync()` to get the file's mtime
3. If file doesn't exist → stale (source deleted)
4. If file mtime > activity's `generatedAt` → stale (source modified)
5. Otherwise → fresh

Returns:
```typescript
Array<{
  activityId: string;
  staleReason: 'source_deleted' | 'source_modified';
}>
```

**Constraint:** Use `fs.statSync()` (synchronous) since this runs in a Next.js API route on Node.js. Wrap in try/catch — `ENOENT` = deleted, other errors = skip (treat as fresh).

### Session API enrichment

Modify `dashboard/src/app/api/study/session/route.ts` GET handler:

After building the session composition, call both warning functions and include results in the response:

```typescript
{
  session: { blocks, totalActivities, estimatedMinutes, domainsCovered },
  warnings: {
    prerequisites: [...],  // from getPrerequisiteWarnings
    staleActivities: [...] // from getStalenessWarnings
  }
}
```

To call `getStalenessWarnings`, the enriched activities need `sourceNotePath` and `generatedAt`. The current enrichment step in the GET handler (lines 14-27) reads `getActivityById()` which returns the full `ActivityRow` including `source_note_path` and `generated_at`, but these are not mapped through. **You must add them:** in the enrichment `.map()`, add `sourceNotePath: full.source_note_path ?? null` and `generatedAt: full.generated_at` alongside the existing `prompt`, `referenceAnswer`, and `cardType` mappings.

### Session UI warnings

Modify `dashboard/src/app/study/session/page.tsx`:

**Prerequisite warnings:** Show a dismissible amber banner at the top of the session when any concept has weak prerequisites. Format: "Note: [Concept Title] depends on [Prerequisite Title] (mastery: 23%) — consider reviewing it first." Non-blocking — the student can dismiss and continue.

**Staleness badges:** On individual activity cards, if the activity is stale, show a small amber badge: "Source updated" or "Source deleted". Add a "Regenerate" button next to stale activities that calls `POST /api/study/concepts/approve` with the concept ID (triggers re-generation in the existing approval flow). Agent discretion on exact UI placement.

**Constraint:** Both warning types are advisory, not blocking. The session continues normally regardless. Follow the spec's "suggest strongly, enforce nothing" principle.

- [ ] **Step 1:** Create `dashboard/src/lib/session-warnings.ts` with `getPrerequisiteWarnings()` and `getStalenessWarnings()`
- [ ] **Step 2:** Modify `dashboard/src/app/api/study/session/route.ts` GET handler to include warnings
- [ ] **Step 3:** Add prerequisite warning banner to `dashboard/src/app/study/session/page.tsx`
- [ ] **Step 4:** Add staleness badge + regenerate button to activity cards in session page
- [ ] **Step 5:** Run `cd dashboard && npm run build` — verify clean
- [ ] **Step 6:** Run `npm test` (root) — no regressions
- [ ] **Step 7:** Commit: `feat(dashboard): add prerequisite awareness and staleness detection to study sessions (S8a.3)`

---

## S8a.4: Analytics Dashboard Section + Concept Links

**Files:** Modify `dashboard/src/app/study/page.tsx`

**Depends on:** S8a.1 (stats API must exist), S8a.2 (concept detail page must exist for links).

### Analytics section

Add a new "Analytics" section to the `/study` overview page, between the "Plans" section and "Pending Approval" section. The section fetches from `GET /api/study/stats?days=7` and displays:

**1. Summary cards row (4 cards):**
- Retention rate: percentage, colored green/yellow/red based on threshold (>80% green, >60% yellow, <60% red)
- Activities this week: count + daily average
- Average quality: 0-5 scale
- Calibration accuracy: percentage (or "—" if insufficient data)

**2. Bloom's distribution bar:** Single horizontal stacked bar showing the percentage of activities at each Bloom's level, color-coded (L1=lighter, L6=darker blue). Small label below each segment.

**3. Method effectiveness:** Small table or horizontal bars showing avg quality per method type. Only show methods with > 0 activities.

**4. Time period toggle:** Buttons for "7 days" / "30 days" / "All time" that re-fetch stats with different `days` parameter.

### Concept links

Update the Active Concepts table to make concept titles clickable links to `/study/concepts/[id]`. The concept title cell becomes an `<a>` tag with `href={/study/concepts/${concept.id}}`.

**Agent discretion:** Exact card layout (grid vs flex), color thresholds for retention rate, whether to show the time series as a sparkline or just the summary, period toggle implementation.

- [ ] **Step 1:** Add analytics state and fetch to the existing `fetchData()` in `/study` page
- [ ] **Step 2:** Add Analytics section UI with summary cards
- [ ] **Step 3:** Add Bloom's distribution bar
- [ ] **Step 4:** Add method effectiveness display
- [ ] **Step 5:** Add time period toggle
- [ ] **Step 6:** Update concept titles to be clickable links to detail page
- [ ] **Step 7:** Run `cd dashboard && npm run build` — verify clean
- [ ] **Step 8:** Start dashboard dev server, visually verify the analytics section renders
- [ ] **Step 9:** Commit: `feat(dashboard): add analytics section to study overview and concept detail links (S8a.4)`

---

## S8a.5: Verification

**Depends on:** All previous tasks.

- [ ] **Step 1:** Run `npm test` — all pass, no regressions
- [ ] **Step 2:** Run `cd dashboard && npm run build` — clean
- [ ] **Step 3:** Run `npm run build` (root) — clean
- [ ] **Step 4:** Start dashboard dev server (`cd dashboard && npm run dev`)
- [ ] **Step 5:** Navigate to `/study` — verify analytics section shows (may show zeros if no data)
- [ ] **Step 6:** Click a concept title — verify concept detail page loads
- [ ] **Step 7:** Navigate to `/study/session` — verify no crashes (prerequisite/staleness warnings may be empty)
- [ ] **Step 8:** Verify all new files use correct import conventions (no `.js` in dashboard, `.js` in src/)
- [ ] **Step 9:** Commit: `chore(study): verify S8a analytics + concept detail + polish end-to-end (S8a.5)`

---

## Acceptance Criteria

From master plan S8 (non-negotiable):

- [ ] `GET /api/study/stats` returns: retention rate, Bloom's distribution, method effectiveness, activity time series, calibration data
- [ ] Analytics section on `/study` page displays meaningful learning data with period toggle
- [ ] Concept detail page at `/study/concepts/[id]` shows: Bloom's level mastery bars (6-level), activity history, method effectiveness, related concepts, vault source link
- [ ] Concept titles on overview page link to detail page
- [ ] Session API includes prerequisite warnings for concepts with weak prerequisites
- [ ] Session API includes staleness warnings for activities whose source notes changed
- [ ] Session UI shows prerequisite warning banner (dismissible, non-blocking)
- [ ] Session UI shows staleness badge on affected activities
- [ ] Dashboard schema includes `concept_prerequisites` and `activity_concepts` tables
- [ ] All existing tests pass (`npm test`)
- [ ] Dashboard builds cleanly (`cd dashboard && npm run build`)
- [ ] No regressions in existing dashboard pages
