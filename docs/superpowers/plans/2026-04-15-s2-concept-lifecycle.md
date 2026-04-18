# S2: Concept Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Your role:** You are the engineer implementing this. The plan tells you *what* to build and *why*. You decide *how* within the stated constraints. If you disagree with an approach or see a better alternative, flag it before implementing — don't silently deviate and don't silently comply with something you think is wrong.

**Goal:** Concepts flow from vault ingestion → pending → active, with a dashboard page for browsing and batch-approving concepts. First user-visible part of the study system.

**Architecture:** Concept discovery hooks into `handlePromotion()` in the ingestion pipeline. When vault notes promote to `concepts/`, a synchronous frontmatter reader creates pending concept rows. The dashboard reads SQLite via its own Drizzle instance. A one-time migration script backfills 899 existing vault concept notes.

**Tech Stack:** TypeScript, Drizzle ORM (better-sqlite3), gray-matter, Vitest, Next.js (dashboard), Tailwind CSS

**Branch:** Create `feat/s2-concept-lifecycle` off `main`. S1 merged via PR #28.

**Spec:** `docs/superpowers/specs/2026-04-12-multi-method-study-system-design.md` (v2.1, Sections 3.1, 5.3)

**Master plan:** `docs/superpowers/plans/2026-04-13-study-system-master-plan.md` (S2 checklist)

---

## Codebase Conventions (Hard Constraints)

These apply to **every task**. Subagents must follow these — they're not obvious from context alone.

1. **`.js` extensions on all relative imports in `src/`.** The backend uses Node ESM resolution. Write `import { foo } from './bar.js'`, not `'./bar'`. **Exception:** Dashboard (`dashboard/src/`) does NOT use `.js` extensions — Next.js/Turbopack handles resolution. Follow the existing pattern in `dashboard/src/lib/ingestion-db.ts` (imports from `'./db/index'` without `.js`).
2. **camelCase Drizzle properties, snake_case SQL columns** (backend `src/db/schema/study.ts`). Dashboard schema uses snake_case properties matching SQL column names (different convention — see D3 below).
3. **Drizzle query builder operators** (`eq`, `and`, `lte`, `desc`, `asc`, `count`, `sql`) — not raw SQL strings — for operations the builder supports. Use `sql` template only for things like `datetime('now')` or computed expressions.
4. **Vitest** for all tests. Pattern: `describe` → `it` → `expect`. Test file discovery: `src/**/*.test.ts`.
5. **`parseFrontmatter()` from `src/vault/frontmatter.ts`** for all YAML frontmatter reading. Returns `{ data: Record<string, unknown>, content: string }`.
6. **Dashboard API routes** use `Response.json()` + try/catch. See `dashboard/src/app/api/ingestion/jobs/route.ts` for the exact pattern.
7. **Dashboard pages** are `'use client'` components with `useState`/`useEffect` for data fetching. Tailwind CSS. Dark theme (bg-gray-950, text-gray-100). See `dashboard/src/app/upload/page.tsx`.
8. **Commit messages** use conventional commits: `feat(study):`, `test(study):`, `feat(dashboard):`.

---

## Spec Deviations

- **No prerequisite extraction from wikilinks.** The spec (Section 5.3) mentions "suggested prerequisites (from wikilinks)." Deferred to S3 — no code consumes prerequisites yet.
- **No DB group registration.** Master plan S2.10 says register study group in `registered_groups`. That table requires a non-null `trigger_pattern`, which study groups don't have. Deferred to S5 when web channel routing is implemented. The CLAUDE.md files were already scaffolded in S1 (Task 9) — nothing is lost by deferring the DB row.

---

## Key Decisions

### D1: Discovery reads frontmatter, not LLM
Concept discovery reads promoted notes' YAML frontmatter with `parseFrontmatter()`. No LLM call — the ingestion agent already writes domain/subdomain during generation.

### D2: Domain/subdomain are should-fix warnings, not must-fix
Draft validator treats missing domain/subdomain as `should-fix` severity. 899 existing notes lack these fields. Must-fix would block re-ingestion of old documents.

### D3: Dashboard duplicates study schema (snake_case properties)
Dashboard defines its own Drizzle tables in `dashboard/src/lib/db/schema.ts` with snake_case property names (matching SQL column names). It cannot import from `src/db/schema/` — Next.js can't bundle TS from outside the project root.

### D4: Deduplication by vault_note_path
Discovery checks for existing concepts by `vaultNotePath`, not title. Multiple notes can share titles across sources.

### D5: Topic-to-domain heuristic for migration
Migration script maps topic keywords → domain/subdomain using a static rule table. ~70-80% classification rate; rest get `null`. Student classifies remainder from dashboard.

---

## Essential Reading

> **For coordinators:** Extract relevant patterns from these files and inline them into subagent prompts. Subagents won't read the files themselves.

| File | Why |
|------|-----|
| `src/study/queries.ts` | `createConcept()`, `getConceptsByStatus()`, `updateConceptStatus()` — the S1 query API this sprint calls |
| `src/db/schema/study.ts` | Concepts table schema — `vaultNotePath`, `domain`, `subdomain`, `status` fields |
| `src/ingestion/index.ts:506-645` | `handlePromotion()` — insertion point for discovery hook |
| `src/ingestion/draft-validator.ts:206-253` | Concept note frontmatter validation — insertion point for domain/subdomain warnings |
| `groups/review_agent/CLAUDE.md:20-45` | Concept note frontmatter schema — where domain/subdomain fields go |
| `src/vault/frontmatter.ts` | `parseFrontmatter()` — the utility for reading note YAML |
| `dashboard/src/lib/ingestion-db.ts` | Dashboard query pattern to replicate for study-db.ts |
| `dashboard/src/lib/db/schema.ts` | Dashboard schema — add study tables here |
| `dashboard/src/app/layout.tsx` | Nav bar — add "Study" link |
| `vault/concepts/action-research.md` | Existing frontmatter format: `title`, `type`, `topics`, `source_doc`. No `domain`/`subdomain` |

---

## Task Numbering

This plan uses its own sequential task IDs (S2.1-S2.9) that don't map 1:1 to the master plan's S2.1-S2.10 checklist because some master plan items are merged and one is deferred. Commit messages reference **this plan's** task IDs.

| Plan task | Master plan items | What |
|-----------|-------------------|------|
| S2.1 | S2.1 + S2.2 | Discovery module + tests (TDD) |
| S2.2 | S2.3 | Pipeline hook |
| S2.3 | S2.4 | Agent prompt update |
| S2.4 | S2.5 | Draft validator update |
| S2.5 | S2.6 (partial) | Dashboard schema |
| S2.6 | S2.6 (partial) | Dashboard query functions |
| S2.7 | S2.7 + S2.8 | API routes + /study page |
| S2.8 | S2.9 | Migration script |
| S2.9 | — | Barrel export + verification |
| — | S2.10 | Deferred (see Spec Deviations) |

**Master plan errata:** S2.3 references `src/ingestion/pipeline.ts` — the actual file is `src/ingestion/index.ts`. S2.4 references `src/ingestion/agent-processor.ts` — the actual prompt template is in `groups/review_agent/CLAUDE.md`.

---

## Parallelization & Model Recommendations

**Dependencies:**
- S2.1 → S2.2 (discovery module before pipeline hook)
- S2.2 → S2.8 (need `getConceptByVaultPath` from S2.2 for migration script)
- S2.5 → S2.6 → S2.7 (dashboard: schema → queries → routes+page)

**Parallel opportunities:**
- S2.3 + S2.4 (agent prompt + validator — fully independent)
- S2.5 + S2.8 (dashboard schema + migration script — independent codepaths)
- S2.3 + S2.4 can start as soon as S2.1 is done (no dependency on S2.2)

| Task | Can parallel with | Model | Rationale |
|------|-------------------|-------|-----------|
| S2.1 | — (first task) | Sonnet | Mechanical: read frontmatter, filter, map |
| S2.2 | — (depends on S2.1) | Sonnet | Small insertion into existing function |
| S2.3 | S2.4 | Sonnet | Editing a markdown file |
| S2.4 | S2.3 | Sonnet | Adding 2 warning checks to existing validator |
| S2.5 | S2.8 | Sonnet | Schema declaration, must match backend exactly |
| S2.6 | — (depends on S2.5) | Sonnet | CRUD queries following existing pattern |
| S2.7 | — (depends on S2.6) | Sonnet | API routes + page following existing patterns |
| S2.8 | S2.5 | Sonnet | Script with heuristic map |
| S2.9 | — | Sonnet | Barrel export + test suite runs |

**Skip two-stage review for:** S2.3, S2.4, S2.9 (trivial edits). Full review for: S2.1, S2.2, S2.6, S2.7.

---

## S2.1: Concept Discovery Module (TDD)

**Files:** Create `src/study/concept-discovery.ts` + `src/study/concept-discovery.test.ts`

**Return type:** `NewConcept[]` (from `src/study/queries.ts` — this is `typeof schema.concepts.$inferInsert`). The caller (S2.2) passes each item directly to `createConcept()`. No wrapper type needed.

```typescript
import type { NewConcept } from './queries.js';

export function discoverConcepts(
  promotedPaths: string[],
  vaultDir: string,
): NewConcept[]
```

**Algorithm:**
1. For each path in `promotedPaths`: skip if not `concepts/*`. Read file contents with `readFileSync()`, parse with `parseFrontmatter()`. Skip if `type !== 'concept'` or no `title`. Map frontmatter fields → `NewConcept` with `status: 'pending'`, `id: randomUUID()`, `createdAt: new Date().toISOString()`. Return array.

**Agent discretion:** Error handling style, whether to log skipped notes, internal helpers.

**Required test cases:**

| Scenario | Input | Expected |
|----------|-------|----------|
| Full frontmatter | concept note with domain+subdomain | 1 result with all fields populated |
| Missing domain/subdomain | concept note without domain | 1 result with `domain: null`, `subdomain: null` |
| Source note (type=source) | `sources/vaswani.md` | 0 results (skipped) |
| Path not in concepts/ | `sources/some-note.md` with type=concept | 0 results |
| Nonexistent file | `concepts/ghost.md` | 0 results |
| Multiple paths mixed | 2 concepts + 1 source | 2 results |
| Missing title | concept note without title | 0 results |
| Course field | note with `course: 'BI-2081'` | result has `course: 'BI-2081'` |

**Test setup:** Create temp vault dir in `beforeEach` with `mkdirSync`, write mock `.md` files with gray-matter compatible frontmatter, `rmSync` in `afterEach`.

- [ ] **Step 1:** Write failing tests covering all cases above
- [ ] **Step 2:** Run tests, verify they fail (`npx vitest run src/study/concept-discovery.test.ts`)
- [ ] **Step 3:** Implement `discoverConcepts()` — make tests pass
- [ ] **Step 4:** Run tests, verify all pass
- [ ] **Step 5:** Commit: `feat(study): add concept discovery from vault frontmatter (S2.1)`

---

## S2.2: Hook Discovery into Ingestion Pipeline

**Files:** Modify `src/ingestion/index.ts`, modify `src/study/queries.ts`

**Prerequisite:** Add `getConceptByVaultPath(path: string): Concept | undefined` to `src/study/queries.ts`. Pattern: same as `getConceptById` but filters on `schema.concepts.vaultNotePath`.

**Insertion point in `handlePromotion()`:** After the citation linking block (around line 587) and before `// Move source file to processed/` (around line 589). The block:
1. Calls `discoverConcepts(promotedPaths, this.vaultDir)`
2. For each result, checks `getConceptByVaultPath()` — skip if exists
3. Calls `createConcept()` for new ones
4. Entire block wrapped in try/catch — logs warning on failure, never fails the promotion

**Agent discretion:** Log format, whether to count and report insertions.

- [ ] **Step 1:** Add `getConceptByVaultPath` to `src/study/queries.ts`
- [ ] **Step 2:** Add imports to `src/ingestion/index.ts`: `discoverConcepts`, `createConcept`, `getConceptByVaultPath`
- [ ] **Step 3:** Insert discovery block at the specified location in `handlePromotion()`
- [ ] **Step 4:** Run ingestion tests: `npx vitest run src/ingestion/` — no regressions
- [ ] **Step 5:** Commit: `feat(study): hook concept discovery into ingestion promotion (S2.2)`

---

## S2.3: Update Ingestion Agent Prompt

**Files:** Modify `groups/review_agent/CLAUDE.md`

**Parallelizable with S2.4.**

Two changes:
1. Add `domain` and `subdomain` fields to the concept note YAML schema example (after `type:`, before `topics:`). Example values: `domain: "Artificial Intelligence"`, `subdomain: "Deep Learning Architectures"`.
2. Add a guidance paragraph below the schema explaining what domain/subdomain mean: domain = broad knowledge area, subdomain = specific topic within it. Give 5-6 example domains from Simon's courses.

**Agent discretion:** Exact wording of guidance text, example domains chosen.

- [ ] **Step 1:** Edit the concept note schema block (around line 24-36)
- [ ] **Step 2:** Add guidance paragraph after the schema
- [ ] **Step 3:** Commit: `feat(study): add domain/subdomain to ingestion agent concept schema (S2.3)`

---

## S2.4: Update Draft Validator

**Files:** Modify `src/ingestion/draft-validator.ts`

**Parallelizable with S2.3.**

**Insertion point:** INSIDE the `for (const conceptFile of manifest.concept_notes)` loop, after the `type !== 'concept'` check (line 252), before the loop's closing `}` (line 253). The `conceptFile` variable is only in scope inside this loop — inserting outside it would be a reference error.

Add two warnings for missing `domain` and `subdomain` frontmatter on concept notes. Push to the `warnings` array (not `errors`). `ValidationWarning` has no `severity` field — items in `warnings` are inherently non-blocking. Pattern:

```typescript
warnings.push({
  check: 'concept-domain',
  message: `Concept note "${conceptFile}" is missing "domain" frontmatter field. ...`,
  file: conceptFile,
});
```

**Constraint:** Push to `warnings`, NOT `errors`. See D2. The `warnings` type (`ValidationWarning`) has fields `{ check, message, file? }` — no severity field.

- [ ] **Step 1:** Add domain + subdomain warnings inside the loop, after line 252
- [ ] **Step 3:** Run validator tests: `npx vitest run src/ingestion/draft-validator.test.ts` — update any assertion that counts exact warnings
- [ ] **Step 4:** Commit: `feat(study): add domain/subdomain warnings to draft validator (S2.4)`

---

## S2.5: Dashboard Study Schema

**Files:** Modify `dashboard/src/lib/db/schema.ts`

**Parallelizable with S2.8.**

Add `concepts` and `learning_activities` table definitions. These MUST match the SQL column names from `src/db/schema/study.ts` exactly. But property names use snake_case (dashboard convention — see D3).

**Design decision — schema definitions (use these exactly):**

```typescript
// Add `real` to the existing import from 'drizzle-orm/sqlite-core'

export const concepts = sqliteTable('concepts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  domain: text('domain'),
  subdomain: text('subdomain'),
  course: text('course'),
  vault_note_path: text('vault_note_path'),
  status: text('status').default('active'),
  mastery_L1: real('mastery_L1').default(0.0),
  mastery_L2: real('mastery_L2').default(0.0),
  mastery_L3: real('mastery_L3').default(0.0),
  mastery_L4: real('mastery_L4').default(0.0),
  mastery_L5: real('mastery_L5').default(0.0),
  mastery_L6: real('mastery_L6').default(0.0),
  mastery_overall: real('mastery_overall').default(0.0),
  bloom_ceiling: integer('bloom_ceiling').default(0),
  created_at: text('created_at').notNull(),
  last_activity_at: text('last_activity_at'),
});

export const learning_activities = sqliteTable('learning_activities', {
  id: text('id').primaryKey(),
  concept_id: text('concept_id').notNull(),
  activity_type: text('activity_type').notNull(),
  bloom_level: integer('bloom_level').notNull(),
  due_at: text('due_at').notNull(),
  mastery_state: text('mastery_state').default('new'),
});
```

The `learning_activities` definition is a minimal subset — only columns needed for the S2 due count query (`SELECT count(*) ... WHERE concept_id = ? AND due_at <= ?`). The full table has 17+ columns; S4 will extend this definition when the session UI needs additional fields like `prompt`, `reference_answer`, `ease_factor`.

- [ ] **Step 1:** Add `real` to import, append both table definitions
- [ ] **Step 2:** Verify: `cd dashboard && npx tsc --noEmit`
- [ ] **Step 3:** Commit: `feat(dashboard): add study table schemas for concept queries (S2.5)`

---

## S2.6: Dashboard Study Query Functions

**Files:** Create `dashboard/src/lib/study-db.ts`

**Pattern to follow:** `dashboard/src/lib/ingestion-db.ts` — own import of `getDb()` from `./db/index` (no `.js` extension — dashboard convention), function-per-query, own response interfaces. Note the `rowToSummary()` mapper function pattern in that file — you'll need the same approach here because the dashboard schema uses snake_case properties (`vault_note_path`, `mastery_overall`) but the response interfaces use camelCase (`vaultNotePath`, `masteryOverall`).

**Required functions:**

| Function | Signature | Notes |
|----------|-----------|-------|
| `getActiveConcepts` | `() → ConceptSummary[]` | Join with `learning_activities` for due count (count where `due_at <= today`). Two queries + Map merge. |
| `getPendingConcepts` | `() → PendingGroup[]` | Group by domain. `PendingGroup = { domain: string|null, concepts: Array<{id, title, subdomain, createdAt}> }` |
| `approveConcepts` | `(ids: string[]) → number` | Update status pending→active. Return count changed. |
| `approveDomain` | `(domain: string) → string[]` | Find all pending in domain, approve, return IDs. |
| `getConceptStats` | `() → ConceptStats` | `{ total, pending, active, domains }`. Count by status + count distinct domains. |

**`ConceptSummary` interface (design decision):**
```typescript
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
```

**Agent discretion:** Internal helpers, query optimization approach, whether to add `skipConcepts(ids)` for future use.

- [ ] **Step 1:** Create `study-db.ts` with interfaces and all functions
- [ ] **Step 2:** Verify: `cd dashboard && npx tsc --noEmit`
- [ ] **Step 3:** Commit: `feat(dashboard): add study DB query functions (S2.6)`

---

## S2.7: Dashboard API Routes + /study Page + Nav Link

**Files:** Create 3 API routes, create `dashboard/src/app/study/page.tsx`, modify `dashboard/src/app/layout.tsx`

This task combines S2.7 and S2.8 from the master plan — the API routes are only testable with the page, so building them together avoids a dead commit.

### API Routes

Follow the pattern in `dashboard/src/app/api/ingestion/jobs/route.ts`.

| Route | Method | Handler | Response |
|-------|--------|---------|----------|
| `/api/study/concepts` | GET | `getActiveConcepts()` + `getConceptStats()` | `{ concepts, stats }` |
| `/api/study/concepts/pending` | GET | `getPendingConcepts()` | `{ groups }` |
| `/api/study/concepts/approve` | POST | Body: `{ conceptIds?: string[], domain?: string }` | `{ approved: number }` or `{ approved: number, ids: string[] }` |

Directory structure:
```
dashboard/src/app/api/study/concepts/
  route.ts            — GET active concepts
  pending/route.ts    — GET pending grouped by domain
  approve/route.ts    — POST approve
```

### /study Page

**Layout:** Two sections in a `max-w-4xl` container.

**Section 1 — Pending Approval:** Shows when pending concepts exist. Groups by domain. Each group is a card with domain name, concept count, "Approve all" button (for non-null domains), and a row of concept chips that are individually clickable to approve. After approval, refetch data.

**Section 2 — Active Concepts:** Table with columns: Concept (title), Domain, Bloom (L1-L6 label from `bloomCeiling`), Mastery (progress bar + percentage from `masteryOverall`), Due (count from `dueCount`). Empty state message if no active concepts.

**Stats bar:** Top right — `{active} active · {pending} pending · {domains} domains`.

### Nav Link

Add `<a href="/study" className="hover:text-gray-100">Study</a>` to `dashboard/src/app/layout.tsx` after the "Book" link.

**Agent discretion:** Component decomposition (single file vs. extracted components), loading state UX, exact Tailwind classes, whether mastery bar uses gradient colors.

- [ ] **Step 1:** Create directory structure: `mkdir -p dashboard/src/app/api/study/concepts/pending dashboard/src/app/api/study/concepts/approve`
- [ ] **Step 2:** Create the three API route files
- [ ] **Step 3:** Add "Study" nav link in layout.tsx
- [ ] **Step 4:** Create `/study` page
- [ ] **Step 5:** Start dashboard dev server (`cd dashboard && npm run dev`), verify page renders at `http://localhost:3100/study`
- [ ] **Step 6:** Commit: `feat(dashboard): add /study page with concept approval UI (S2.7, S2.8)`

---

## S2.8: Vault Concept Migration Script

**Files:** Create `scripts/migrate-vault-concepts.ts`

**Parallelizable with S2.5.**

**Algorithm:**
1. Call `initDatabase()` from `src/db/index.js` (initializes DB + runs migrations)
2. Read all `.md` files from `vault/concepts/`
3. For each file: check `getConceptByVaultPath()` — skip if exists. Read frontmatter. Skip if no `title`. Infer domain from `topics` if not in frontmatter. Insert with `createConcept()`, `status: 'pending'`.
4. Print summary: inserted, skipped, classified, errors.

**Domain inference:** A static array of rules, each with `keywords: string[]`, `domain: string`, `subdomain: string`. First matching keyword wins. Cover Simon's main areas:

| Keywords (substring match on joined topics) | Domain | Subdomain |
|---------------------------------------------|--------|-----------|
| `knowledge-management`, `km-`, `tacit-knowledge`, `explicit-knowledge`, `seci`, `nonaka`, `knowledge-creation`, `knowledge-sharing` | Knowledge Management | KM Theory |
| `organizational-learning`, `learning-organization`, `absorptive-capacity` | Knowledge Management | Organizational Learning |
| `cognitive-load`, `working-memory`, `instructional-design`, `sweller` | Cognitive Psychology | Cognitive Load Theory |
| `spaced-repetition`, `retrieval-practice`, `metacognition`, `self-regulated-learning` | Cognitive Psychology | Learning & Memory |
| `digital-transformation`, `digitalization`, `digital-strategy` | Digital Transformation | DT Strategy |
| `business-process`, `bpm`, `workflow`, `process-improvement` | Digital Transformation | Business Process Management |
| `research-methodology`, `scientific-methods`, `qualitative-research`, `quantitative-research`, `action-research`, `case-study-research` | Research Methods | Research Design |
| `philosophy-of-science`, `epistemology`, `ontology`, `paradigm` | Research Methods | Philosophy of Science |
| `information-systems`, `sociotechnical`, `technology-acceptance` | Information Systems | IS Theory |
| `artificial-intelligence`, `ai-`, `machine-learning`, `deep-learning`, `neural-network`, `llm`, `transformer` | Artificial Intelligence | AI Foundations |

**Agent discretion:** Additional keyword rules, subdomain granularity, output formatting.

**Constraint:** Must be idempotent — running it twice inserts 0 the second time.

**Usage:** `npx tsx scripts/migrate-vault-concepts.ts`

- [ ] **Step 1:** Create the script
- [ ] **Step 2:** Verify it compiles: `npx tsx --check scripts/migrate-vault-concepts.ts`
- [ ] **Step 3:** Run it: `npx tsx scripts/migrate-vault-concepts.ts` — expect ~899 inserted
- [ ] **Step 4:** Run again — expect 0 inserted, ~899 skipped (idempotency)
- [ ] **Step 5:** Check dashboard `/study` — pending concepts should appear
- [ ] **Step 6:** Commit: `feat(study): add vault concept migration script (S2.8)`

---

## S2.9: Barrel Export + Full Verification

**Files:** Modify `src/study/index.ts`

- [ ] **Step 1:** Add `export * from './concept-discovery.js';` to `src/study/index.ts`
- [ ] **Step 2:** Run study tests: `npx vitest run src/study/`
- [ ] **Step 3:** Run ingestion tests: `npx vitest run src/ingestion/`
- [ ] **Step 4:** Run full test suite: `npm test`
- [ ] **Step 5:** Build check: `npm run build`
- [ ] **Step 6:** Dashboard build: `cd dashboard && npx tsc --noEmit`
- [ ] **Step 7:** Manual verify: start dashboard, check `/study`, approve a concept, verify it moves to active table
- [ ] **Step 8:** Commit: `feat(study): export concept-discovery from barrel (S2.9)`

---

## Acceptance Criteria

From master plan S2 (non-negotiable):

- [ ] Ingesting a new PDF produces pending concepts visible on `/study`
- [ ] Domain-batch approval moves concepts to active status
- [ ] Migration script correctly creates entries for existing vault notes (idempotent)
- [ ] No regressions in ingestion pipeline (existing tests pass)
- [ ] All tests pass (`npm test`)
- [ ] Clean build (`npm run build`)
- [ ] Dashboard `/study` page renders with pending + active sections
