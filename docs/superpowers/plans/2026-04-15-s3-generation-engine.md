# S3: Generation + Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Your role:** You are the engineer implementing this. The plan tells you *what* to build and *why*. You decide *how* within the stated constraints. If you disagree with an approach or see a better alternative, flag it before implementing — don't silently deviate and don't silently comply with something you think is wrong.

**Goal:** The system can generate learning activities for concepts, recommend what to study based on mastery state, compose balanced daily sessions, and trigger background generation when concepts advance to new Bloom's levels.

**Architecture:** Three new modules in `src/study/`: engine.ts (concept progression logic — recommendations, advancement detection, de-escalation), session-builder.ts (daily session composition with new/review/stretch blocks), generator.ts (container dispatch for batch activity generation). A generator container agent (`groups/study-generator/`) produces structured JSON activities written to IPC. The existing IPC watcher receives them via a new handler.

**Tech Stack:** TypeScript, Drizzle ORM (better-sqlite3), Vitest, NanoClaw container agents (Claude via OneCLI)

**Branch:** Create `feat/s3-generation-engine` off `main`. S2 merged via PR #29.

**Spec:** `docs/superpowers/specs/2026-04-12-multi-method-study-system-design.md` (v2.1, Sections 4.3, 4.5, 4.6, 6.1–6.3)

**Master plan:** `docs/superpowers/plans/2026-04-13-study-system-master-plan.md` (S3 checklist)

---

## Codebase Conventions (Hard Constraints)

These apply to **every task**. Subagents must follow these — they're not obvious from context alone.

1. **`.js` extensions on all relative imports in `src/`.** The backend uses Node ESM resolution. Write `import { foo } from './bar.js'`, not `'./bar'`.
2. **camelCase Drizzle properties, snake_case SQL columns** (backend `src/db/schema/study.ts`).
3. **Drizzle query builder operators** (`eq`, `and`, `lte`, `desc`, `asc`, `count`, `sql`, `inArray`, `gte`) — not raw SQL strings — for operations the builder supports. Use `sql` template only for things like `datetime('now')` or computed expressions.
4. **Vitest** for all tests. Pattern: `describe` → `it` → `expect`. Test file discovery: `src/**/*.test.ts`.
5. **Test DB setup:** `_initTestDatabase()` from `src/db/index.js` creates in-memory SQLite with all migrations. `_closeDatabase()` in afterEach. Pattern: see `src/study/queries.test.ts`.
6. **Commit messages** use conventional commits: `feat(study):`, `test(study):`.
7. **Existing types from `src/study/types.ts`** — `ActivityType`, `BloomLevel`, `MasteryState`, `GeneratedActivity` (stub), `SessionComposition` (stub), `BloomAdvancement` (stub). Expand stubs in S3.1; don't create parallel types.
8. **Existing queries from `src/study/queries.ts`** — `completeActivity()` returns `{ logEntryId, newDueAt, masteryUpdated, bloomCeilingBefore, bloomCeilingAfter }`. The engine wraps this; it does NOT duplicate the SM-2/mastery transaction logic.

---

## Spec Deviations

- **No RAG integration in generator prompt.** The spec says "queries RAG for concept's vault content." For S3, generator.ts reads the vault note directly from disk (via `vault_note_path`) and includes content in the prompt. RAG integration deferred to S5 when the study agent (which also needs RAG) is built — one integration point instead of two.
- **No morning scheduled task.** Master plan mentions a "morning safety net" for generation. Deferred to S7 (scheduled tasks sprint). S3 implements only the post-session trigger.
- **Synthesis opportunities are advisory-only.** `getSynthesisOpportunities()` returns opportunities but does NOT auto-generate synthesis activities. That requires the dashboard chat (S5) and scheduling (S7).
- **No automated quality validation of generated content.** Master plan S3.2 says the generator "validates against quality rules (rejects anti-patterns)." S3 relies on the CLAUDE.md prompt to enforce quality rules at generation time. Automated content validation (detecting yes/no questions, "list all X" prompts, etc.) would require a second LLM call — deferred. The IPC handler validates structural correctness only (required fields, valid types, bloom range).
- **No automatic generation on concept approval.** Newly approved concepts start with zero activities. The session builder can only include existing activities. Initial activity generation for new concepts is triggered by the concept approval flow in S4 (the API route will call `generateActivities` after approval) and the morning scheduled task in S7. S3 provides the generator machinery; S4 and S7 provide the triggers.

---

## Key Decisions

### D1: processCompletion wraps completeActivity — clean layering

The engine's `processCompletion()` calls `queries.ts:completeActivity()` for all transactional DB work (SM-2 update → activity log → mastery recomputation → concept update). Then it adds business logic: advancement detection (`bloomCeilingAfter > bloomCeilingBefore`), checking whether activities already exist at the new level, and de-escalation advice.

**Boundary:** `completeActivity()` = atomic data consistency (queries layer). `processCompletion()` = progression decisions (engine layer). The engine never imports `getDb()` — all DB access goes through query functions.

### D2: Generator agent writes output to IPC

The generator agent writes a JSON file to its IPC tasks directory (`/workspace/ipc/tasks/`). On the host this maps to `data/ipc/study-generator/tasks/`. The existing IPC watcher picks it up; the new `study_generated_activities` case in `processTaskIpc()` validates and inserts activities. Generator.ts just spawns the container — it doesn't parse output or touch the DB.

### D3: Session builder is pure — reads DB, returns data, no writes

`buildDailySession()` calls `getDueActivities()` + `getActiveConcepts()`, composes blocks, returns a `SessionComposition`. It does NOT create a `study_sessions` DB row — the API route (S4) does that. Two queries + in-memory merge is simpler than a complex join.

### D4: Rate limiting is per-invocation, not persistent

Generator tracks concepts processed via a module-level counter. Max 10 per cycle. No persistent queue — remaining concepts are picked up by the next trigger (S7's morning task). `resetGenerationCycle()` resets the counter at the start of each trigger.

---

## Essential Reading

> **For coordinators:** Extract relevant patterns from these files and inline them into subagent prompts. Subagents won't read the files themselves.

| File | Why |
|------|-----|
| `src/study/queries.ts` | `completeActivity()` signature and return type — engine wraps this. All existing CRUD functions — new queries follow same patterns. |
| `src/study/types.ts` | Existing stubs for `GeneratedActivity`, `SessionComposition`, `BloomAdvancement` — expand these. `ActivityType` union for generator. |
| `src/study/mastery.ts` | `computeMastery()`, `computeBloomCeiling()`, `computeOverallMastery()` — engine calls these for independent advancement checks |
| `src/study/sm2.ts` | `computeDueDate()` — IPC handler uses this for initial `due_at` on generated activities |
| `src/db/schema/study.ts` | `learningActivities` columns — IPC handler must produce valid `NewLearningActivity` rows. `activityConcepts` table for multi-concept activities. |
| `src/ipc.ts:265–400` | `processTaskIpc()` switch statement — add new case for `study_generated_activities` |
| `src/container-runner.ts:300–400` | `runContainerAgent()` signature, `ContainerInput` interface — generator.ts calls this |
| `src/types.ts:36–44` | `RegisteredGroup` interface — generator.ts constructs one for the study-generator group |
| `src/config.ts:53` | `VAULT_DIR` — generator reads vault notes from here |
| `src/study/queries.test.ts:40–100` | Test fixture helpers — `makeConcept()`, `makeActivity()`, `makeSession()` patterns |
| `groups/study-generator/CLAUDE.md` | Current scaffold — replace with full prompt |

---

## Task Numbering

This plan uses its own sequential task IDs (S3.1–S3.8) that don't map 1:1 to the master plan's S3.1–S3.9 checklist.

| Plan task | Master plan items | What |
|-----------|-------------------|------|
| S3.1 | — | Expand type stubs + new query functions |
| S3.2 | S3.4 + S3.5 | Engine module (TDD) |
| S3.3 | S3.6 + S3.7 | Session builder (TDD) |
| S3.4 | S3.1 | Generator agent CLAUDE.md |
| S3.5 | S3.2 + S3.3 | Generator orchestration + tests |
| S3.6 | S3.8 | IPC handler for generated activities |
| S3.7 | S3.9 | Post-session generation trigger |
| S3.8 | — | Barrel export + verification |

---

## Parallelization & Model Recommendations

**Dependencies:**
- S3.1 → S3.2, S3.3, S3.5, S3.6 (types + queries before logic)
- S3.4 is fully independent (markdown, no code imports)
- S3.2 + S3.3 can run in parallel (engine + session builder — independent modules)
- S3.5 depends on S3.1 + S3.4 (types must exist, CLAUDE.md must exist for container)
- S3.6 depends on S3.1 (needs types for validation)
- S3.7 depends on S3.2 + S3.5 (engine + generator wired together)

**Parallel opportunities:**
- S3.1 + S3.4 (types/queries + CLAUDE.md — fully independent)
- S3.2 + S3.3 (engine + session builder — independent codepaths, both need only S3.1)
- S3.5 + S3.6 (generator + IPC handler — independent, both need S3.1)

| Task | Can parallel with | Model | Rationale |
|------|-------------------|-------|-----------|
| S3.1 | S3.4 | Sonnet | Types + CRUD queries following existing patterns |
| S3.2 | S3.3 | Sonnet | Engine logic with algorithm from spec, well-specified |
| S3.3 | S3.2 | Sonnet | Session builder with composition rules from spec |
| S3.4 | S3.1 | Sonnet | Markdown writing from spec quality rules |
| S3.5 | S3.6 | Sonnet | Container dispatch following existing pattern |
| S3.6 | S3.5 | Sonnet | IPC handler following processTaskIpc pattern |
| S3.7 | — | Sonnet | Thin wiring: engine + generator |
| S3.8 | — | Sonnet | Barrel export + test suite runs |

**Skip two-stage review for:** S3.1, S3.4, S3.8 (types/queries, markdown, barrel). Full review for: S3.2, S3.3, S3.5, S3.6, S3.7.

---

## S3.1: Expand Type Stubs + New Query Functions

**Files:** Modify `src/study/types.ts`, modify `src/study/queries.ts`, modify `src/study/queries.test.ts`

**Parallelizable with S3.4.**

### Types to expand in `types.ts`

Replace the three stub interfaces with full versions. Add new interfaces.

**GeneratedActivity (expand stub — design decision):**
```typescript
export interface GeneratedActivity {
  activityType: ActivityType;
  prompt: string;
  referenceAnswer: string;
  bloomLevel: BloomLevel;
  difficultyEstimate?: number;
  cardType?: CardType;
  sourceNotePath?: string;
  sourceChunkHash?: string;
  relatedConceptIds?: string[];
}
```

**SessionComposition (replace stub — design decision):**
```typescript
export interface SessionBlock {
  type: 'new' | 'review' | 'stretch';
  activities: SessionActivity[];
}

export interface SessionActivity {
  activityId: string;
  conceptId: string;
  conceptTitle: string;
  domain: string | null;
  activityType: ActivityType;
  bloomLevel: BloomLevel;
}

export interface SessionComposition {
  blocks: SessionBlock[];
  totalActivities: number;
  estimatedMinutes: number;
  domainsCovered: string[];
}

export interface SessionOptions {
  targetActivities?: number;  // default 20
  domainFocus?: string;       // filter to specific domain
  maxMinutes?: number;        // default 30
}
```

**BloomAdvancement (expand stub — design decision):**
```typescript
export interface BloomAdvancement {
  conceptId: string;
  conceptTitle: string;
  previousCeiling: number;
  newCeiling: number;
  generationNeeded: boolean;
}
```

**New types — design decision:**
```typescript
export interface ActivityRecommendation {
  activityType: ActivityType;
  bloomLevel: BloomLevel;
  count: number;
}

export interface CompletionResult {
  logEntryId: string;
  newDueAt: string;
  advancement: BloomAdvancement | null;
  generationNeeded: boolean;
  deEscalation: string | null;
}

export interface SynthesisOpportunity {
  type: 'within-subdomain' | 'within-domain' | 'cross-domain';
  domain: string;
  subdomain?: string;
  concepts: Array<{ id: string; title: string; bloomCeiling: number }>;
  automatic: boolean;  // true for within-subdomain/domain, false for cross-domain
}
```

**Constraint:** Remove the old `SessionComposition` stub (it has `sessionId` and `activities` with `block: string`). The new version uses `SessionBlock[]`. If any code references the old shape, update it — but nothing should yet (it was a forward stub).

### New query functions in `queries.ts`

Add these functions following the existing pattern (same imports, same style):

| Function | Signature | Notes |
|----------|-----------|-------|
| `getActivitiesByConcept` | `(conceptId: string) → LearningActivity[]` | All activities for a concept, ordered by `bloomLevel` asc |
| `getRecentActivityLogs` | `(conceptId: string, limit: number) → ActivityLogEntry[]` | Last N logs, ordered by `reviewedAt` desc. Use `.limit(limit)`. |
| `batchCreateActivities` | `(activities: NewLearningActivity[]) → void` | Wrap all inserts in `getDb().transaction()` |
| `createActivityConceptLinks` | `(activityId: string, conceptIds: string[], role?: string) → void` | Insert into `schema.activityConcepts`. Role defaults to `'related'`. |
| `getConceptsAboveBloomCeiling` | `(minCeiling: number) → Concept[]` | Active concepts where `bloomCeiling >= minCeiling`. Filter with `and(eq(status, 'active'), gte(bloomCeiling, minCeiling))`. |

**Constraint:** Add test cases for all five new query functions in `queries.test.ts`, following the existing pattern (`beforeEach/_initTestDatabase`, `afterEach/_closeDatabase`, fixture helpers).

**Agent discretion:** Additional edge-case tests beyond one-per-function, exact test descriptions.

- [ ] **Step 1:** Expand the three type stubs and add new types in `src/study/types.ts`
- [ ] **Step 2:** Run type check: `npx tsc --noEmit` — fix any issues with code referencing old stub shapes
- [ ] **Step 3:** Add the five new query functions to `src/study/queries.ts`
- [ ] **Step 4:** Add test cases for all new queries in `src/study/queries.test.ts`
- [ ] **Step 5:** Run tests: `npx vitest run src/study/queries.test.ts`
- [ ] **Step 6:** Commit: `feat(study): expand type stubs and add engine/session query functions (S3.1)`

---

## S3.2: Engine Module (TDD)

**Files:** Create `src/study/engine.ts` + `src/study/engine.test.ts`

**Parallelizable with S3.3** (after S3.1 is complete).

The engine is the concept progression logic module. It reads DB state via query functions and returns recommendations. No container spawning, no LLM calls. All DB access goes through `src/study/queries.js` — do NOT import `getDb()`.

### Functions

**`getConceptRecommendations(conceptId: string): ActivityRecommendation[]`**

Algorithm (from spec Section 4.3):
- Get concept from DB via `getConceptById()`. Throw if not found.
- Read `bloomCeiling`.
- bloomCeiling < 3: recommend `card_review` at L1 (count 3–5) + `elaboration` at L2 (count 2)
- bloomCeiling 3–4: recommend `self_explain` at L3 + `concept_map` at L3 + `comparison` at L4 + `case_analysis` at L4 (count 1 each)
- bloomCeiling >= 5: recommend `synthesis` at L5 + `socratic` at L6 + `case_analysis` at L5 (count 1 each)
- Return `ActivityRecommendation[]`

**`checkForAdvancement(conceptId: string): BloomAdvancement | null`**

- Get concept from DB. Get ALL activity logs for this concept via `getLogsByConceptAndLevel(conceptId)`.
- Compute mastery using `computeMastery()` from `mastery.js`.
- Compute new ceiling using `computeBloomCeiling()`.
- If new ceiling > concept's current `bloomCeiling`:
  - Check if activities already exist at the new level: call `getActivitiesByConcept(conceptId)`, filter to `bloomLevel >= newCeiling`. If any exist, `generationNeeded = false`; otherwise `true`.
  - Return `BloomAdvancement` with concept title and ceiling info.
- If no advancement: return `null`.

**`processCompletion(input: CompleteActivityInput): CompletionResult`**

- Look up the activity first via `getActivityById(input.activityId)` to get `conceptId` (needed for later steps).
- Call `completeActivity(input)` from queries.js → get `{ bloomCeilingBefore, bloomCeilingAfter, logEntryId, newDueAt }`
- If `bloomCeilingAfter > bloomCeilingBefore`:
  - Get concept via `getConceptById(conceptId)` for the title
  - Check if activities already exist at the new level: `getActivitiesByConcept(conceptId)` → filter to `bloomLevel >= bloomCeilingAfter`. If any exist: `generationNeeded = false`; otherwise `true`.
  - Build `BloomAdvancement` object
- Call `getDeEscalationAdvice(conceptId)`
- Return `CompletionResult`

**Constraint:** processCompletion uses the `bloomCeilingBefore`/`bloomCeilingAfter` values from `completeActivity()`'s return. It does NOT call `checkForAdvancement()` — that function is a standalone utility for use outside the completion flow (e.g., morning scheduled task in S7). Do NOT duplicate SM-2 or mastery computation in engine.ts.

**`getDeEscalationAdvice(conceptId: string): string | null`**

- Get last 5 logs via `getRecentActivityLogs(conceptId, 5)`
- If fewer than 3 logs: return `null` (not enough data)
- Compute average quality
- If avg < 2.5 AND concept's bloomCeiling > 1: return advice string ("Recent performance suggests reinforcing lower-level understanding before continuing at L{ceiling}.")
- Otherwise: return `null`

**`getSynthesisOpportunities(domain?: string): SynthesisOpportunity[]`**

- Get active concepts with bloomCeiling >= 4 via `getConceptsAboveBloomCeiling(4)`
- If `domain` provided, filter to that domain
- Group by subdomain → if 2+ concepts share a subdomain: within-subdomain opportunity (`automatic: true`)
- Group by domain (across subdomains) → if concepts span multiple subdomains: within-domain opportunity (`automatic: true`)
- Cross-domain: if concepts span multiple domains: cross-domain opportunity (`automatic: false`)
- Return array sorted by type priority: within-subdomain first, then within-domain, then cross-domain

### Required test cases

| Function | Scenario | Expected |
|----------|----------|----------|
| getConceptRecommendations | bloomCeiling = 0 (fresh) | L1–L2 recommendations (cards + elaboration) |
| getConceptRecommendations | bloomCeiling = 3 | L3–L4 recommendations |
| getConceptRecommendations | bloomCeiling = 5 | L5–L6 recommendations |
| getConceptRecommendations | concept not found | throws |
| checkForAdvancement | enough mastery evidence to advance | BloomAdvancement with generationNeeded=true |
| checkForAdvancement | activities exist at new level | BloomAdvancement with generationNeeded=false |
| checkForAdvancement | insufficient mastery | null |
| processCompletion | quality=5, concept advances | CompletionResult with advancement + generationNeeded |
| processCompletion | quality=3, no advancement | CompletionResult with advancement=null |
| processCompletion | repeated low quality | CompletionResult with deEscalation string |
| getDeEscalationAdvice | avg quality < 2.5 (5 logs) | advice string |
| getDeEscalationAdvice | avg quality >= 2.5 | null |
| getDeEscalationAdvice | fewer than 3 logs | null |
| getSynthesisOpportunities | 3 concepts, same subdomain, ceiling 4+ | 1 within-subdomain opportunity |
| getSynthesisOpportunities | concepts across subdomains | within-domain opportunity |
| getSynthesisOpportunities | domain filter applied | only matching domain |
| getSynthesisOpportunities | no concepts above ceiling 4 | empty array |

**Test setup:** `_initTestDatabase()` in beforeEach. Create concepts with varying mastery/bloomCeiling. Create activity log entries. Use `makeConcept()` pattern from queries.test.ts.

**Agent discretion:** Additional edge-case tests, exact recommendation counts, de-escalation message wording.

- [ ] **Step 1:** Write failing tests for all engine functions
- [ ] **Step 2:** Run tests, verify they fail: `npx vitest run src/study/engine.test.ts`
- [ ] **Step 3:** Implement all engine functions — make tests pass
- [ ] **Step 4:** Run tests, verify all pass
- [ ] **Step 5:** Commit: `feat(study): add concept progression engine with advancement detection (S3.2)`

---

## S3.3: Session Builder (TDD)

**Files:** Create `src/study/session-builder.ts` + `src/study/session-builder.test.ts`

**Parallelizable with S3.2** (after S3.1 is complete).

### `buildDailySession(options?: SessionOptions): SessionComposition`

Algorithm (from spec Section 4.5):

1. Get all due activities: `getDueActivities()` — activities with `due_at <= today`
2. Get all active concepts: `getActiveConcepts()` — build `Map<string, Concept>` keyed by id
3. Enrich each activity with its concept's metadata. Skip activities whose concept is missing from the map (concept may have been archived).
4. If `options.domainFocus`, filter to activities whose concept matches that domain.
5. Target activity count: `options.targetActivities ?? 20`

**Block composition:**

**New material block (~30%):**
- Filter to activities at bloomLevel 1–2 where the concept's bloomCeiling < 3
- Group by domain for topic coherence (blocked, NOT interleaved — Hwang 2025)
- Take up to 30% of target count

**Review block (~50%):**
- Filter to activities NOT in the new block
- Sort by: (a) most overdue first, (b) lowest ease_factor, (c) activity type variety
- Interleave: never 2 consecutive activities with the same `conceptId`. Algorithm: place activities one by one from the sorted list, skip if previous has same conceptId; append skipped ones at the end. After the first pass, remaining activities are appended in order — consecutive same-concept at the tail is acceptable (the best-effort interleaving applies to the bulk, not the overflow)
- Take up to 50% of target

**Stretch block (~20%):**
- Filter to activities at bloomLevel >= 4 where concept's bloomCeiling >= 4
- NOT already placed in review block
- Take up to 20% of target (2–4 activities)

6. **Domain coverage:** After block composition, check if any active domain with due activities is unrepresented. If so, swap the lowest-priority review activity for one from the missing domain. Best-effort — if no due activity exists for a domain, skip it.
7. If total < target and more due activities remain, fill from remaining pool into review block
8. Estimate minutes per activity type:
   - `card_review`: 1.5 min
   - `elaboration`: 3 min
   - `self_explain`, `comparison`, `case_analysis`, `concept_map`: 5 min
   - `synthesis`, `socratic`: 7 min
8. Build `domainsCovered` from unique domains across all placed activities

**Constraint:** The session builder does NOT create a `study_sessions` DB row. It returns data. The API route (S4) creates the session.

**Constraint:** Activities without a matching concept in the active concepts map should be silently skipped, not crash.

**Constraint:** If no activities are due, return `{ blocks: [], totalActivities: 0, estimatedMinutes: 0, domainsCovered: [] }` — not an error.

### Required test cases

| Scenario | Setup | Expected |
|----------|-------|----------|
| All three blocks populated | 5 new L1, 10 review, 3 stretch L5 | 3 blocks, activities allocated by percentage |
| Only review (no new, no stretch) | 15 review activities, all concepts ceiling 2 | review block gets all, new+stretch empty |
| No due activities | empty DB | totalActivities: 0, empty blocks |
| Domain focus filter | activities across 3 domains | only activities from focused domain |
| Interleaving: no consecutive same-concept | 10 reviews across 5 concepts | no adjacent activities share conceptId in review block |
| New block is topic-grouped | 6 L1–L2 activities, 2 domains | activities within new block grouped by domain |
| Stretch only if ceiling >= 4 | concepts at ceiling 2,3 | no stretch block activities |
| Target cap | 30 due activities | session capped at target count |
| Time estimate | mix of card_review + synthesis | correct estimatedMinutes |
| Missing concept silently skipped | activity with deleted concept | activity excluded, no crash |
| Domain coverage | 3 domains with due activities, initial composition misses 1 | missing domain swapped in |

**Test setup:** `_initTestDatabase()` in beforeEach. Create concepts with varying domains/bloom ceilings. Create activities at different bloom levels with `dueAt <= today`.

**Agent discretion:** Internal helpers, sort tiebreakers, fill strategy, exact percentage rounding.

- [ ] **Step 1:** Write failing tests for buildDailySession covering all scenarios
- [ ] **Step 2:** Run tests, verify they fail: `npx vitest run src/study/session-builder.test.ts`
- [ ] **Step 3:** Implement buildDailySession — make tests pass
- [ ] **Step 4:** Run tests, verify all pass
- [ ] **Step 5:** Commit: `feat(study): add session builder with new/review/stretch blocks (S3.3)`

---

## S3.4: Generator Agent CLAUDE.md

**Files:** Replace `groups/study-generator/CLAUDE.md`

**Parallelizable with S3.1.**

Replace the scaffold with a full generator agent system prompt. The agent receives a structured prompt from generator.ts containing concept info and vault note content. It must output a JSON IPC file.

**Required sections:**

1. **Role:** "You generate learning activities from source material. Output is structured JSON written to IPC."

2. **Output format:** Write a JSON file to `/workspace/ipc/tasks/activities-{timestamp}.json`:
   ```json
   {
     "type": "study_generated_activities",
     "conceptId": "...",
     "activities": [
       {
         "activityType": "card_review",
         "prompt": "...",
         "referenceAnswer": "...",
         "bloomLevel": 1,
         "difficultyEstimate": 5,
         "cardType": "basic",
         "sourceNotePath": "concepts/cognitive-load-theory.md"
       }
     ]
   }
   ```

3. **Activity type specifications** (from spec Section 3.2). Include all 8 types with bloom ranges and a worked example for each:
   - `card_review` (L1–L2): basic Q&A, cloze, reversed
   - `elaboration` (L2–L3): "Why does...?" prompts
   - `self_explain` (L2–L4): Feynman technique prompts
   - `concept_map` (L2–L5): list key concepts + relationships
   - `comparison` (L4–L5): compare X and Y (include `relatedConceptIds`)
   - `case_analysis` (L3–L6): real-world scenario
   - `synthesis` (L5–L6): integrate multiple concepts (include `relatedConceptIds`)
   - `socratic` (L4–L6): guided question sequence

4. **Quality rules (Wozniak + Matuschak):**
   - Minimum Information Principle: one concept per activity. If reference answer > 15 words for card_review, split.
   - Five Attributes: focused, precise, consistent, tractable, effortful
   - Source traceability: always set `sourceNotePath` to the vault path provided in the prompt

5. **Anti-pattern checklist — NEVER generate these:**
   - Yes/no questions (50% guessable)
   - "List all X" prompts (sets are hard to memorize — break into individuals)
   - Copy-paste from source (encourages pattern matching)
   - Answer keywords appearing in the question
   - Single activity per concept (always generate 2+ from different angles)
   - Answers > 15 words for card_review (split the card)

6. **Bloom's level generation guidelines (spec Section 6.2):**
   - L1–L2: 3–5 cards + 2 elaboration prompts
   - L3–L4: Feynman prompts, concept map tasks, comparison, case starters
   - L5–L6: Synthesis prompts, Socratic starters, complex case scenarios

7. **Generation strategy (spec Section 6.3):**
   - Analyze source content first: identify key concepts, relationships, and critical details
   - Then generate activities targeting those elements
   - Use different vocabulary in questions than in the source material
   - Each activity should test from a different angle

8. **Common mistakes section** with 3–5 examples of bad activities and why they fail. E.g.: a yes/no question → "50% guessable, no retrieval effort"; a "list all 6 stages" prompt → "sets are nearly impossible to memorize atomically — break into individual questions."

**Constraint:** Include at least one fully worked example output per activity type in section 3. The agent needs concrete quality examples.

**Agent discretion:** Exact wording, additional examples, formatting style.

- [ ] **Step 1:** Write the full CLAUDE.md with all sections above
- [ ] **Step 2:** Commit: `feat(study): design generator agent prompt with quality rules (S3.4)`

---

## S3.5: Generator Orchestration

**Files:** Create `src/study/generator.ts` + `src/study/generator.test.ts`

**Depends on S3.1 + S3.4.**

`generator.ts` orchestrates activity generation: reads concept and vault content, builds the generation prompt, spawns a container agent. It does NOT parse or insert activities — that's the IPC handler's job (S3.6).

### Functions

**`generateActivities(conceptId: string, bloomLevel: BloomLevel): Promise<void>`**

Algorithm:
1. Check rate limit: if `conceptsGeneratedThisCycle >= MAX_CONCEPTS_PER_CYCLE` (10), log and return early.
2. Get concept from DB via `getConceptById()`. Throw if not found. Throw if status !== 'active'.
3. Read vault note content: if concept has `vaultNotePath`, read the file from `VAULT_DIR` (import from `config.js`). If file doesn't exist, log warning — proceed with title-only generation (do NOT skip).
4. Build generation prompt string containing:
   - Concept title
   - Vault note content (or "No vault note available — generate from title")
   - Target bloom level and recommended activity count (L1–L2: 5, L3–L4: 3, L5–L6: 2)
   - Source note path for traceability
5. Construct a `RegisteredGroup` for the study-generator folder:
   ```typescript
   { name: 'Study Generator', folder: 'study-generator', trigger: '',
     added_at: new Date().toISOString(), requiresTrigger: false, isMain: false }
   ```
6. Construct `ContainerInput` with `prompt`, `groupFolder: 'study-generator'`, `singleTurn: true`, `chatJid: 'internal:study-generator'`, `isMain: false`, `ipcNamespace: 'study-generator'`
7. Call `runContainerAgent(group, input, onProcess)`. The `onProcess` callback has signature `(proc: ChildProcess, containerName: string) => void` — log the container name. Do not await the result — fire and forget (the IPC handler processes the output asynchronously).
8. Increment `conceptsGeneratedThisCycle`

**`resetGenerationCycle(): void`** — sets counter to 0.

**Rate limit constant:** `MAX_CONCEPTS_PER_CYCLE = 10`

### Tests

Generator spawns actual containers — tests MUST mock `runContainerAgent`. Use `vi.mock()` on the container-runner module. The mock should resolve with `{ status: 'success', result: null }` (type `ContainerOutput` from `container-runner.ts`). The generator doesn't use the return value — it fires and forgets.

| Scenario | Expected |
|----------|----------|
| Prompt includes concept title and vault content | verify prompt string passed to mock |
| Prompt includes bloom level | bloom level appears in prompt |
| Missing vault note: generation proceeds with title only | no throw, prompt says "No vault note available" |
| Concept not found | throws |
| Archived concept (status !== 'active') | throws |
| Rate limit: 11th call skipped | `runContainerAgent` called 10 times, not 11 |
| `resetGenerationCycle()` resets counter | after reset, generation proceeds |

**Agent discretion:** Prompt format/template, mock strategy, whether to export the prompt builder for direct testing.

- [ ] **Step 1:** Write generator.ts with `generateActivities` + rate limiting
- [ ] **Step 2:** Write generator.test.ts with mocked `runContainerAgent`
- [ ] **Step 3:** Run tests: `npx vitest run src/study/generator.test.ts`
- [ ] **Step 4:** Commit: `feat(study): add activity generator with container dispatch (S3.5)`

---

## S3.6: IPC Handler for Generated Activities

**Files:** Modify `src/ipc.ts`

**Parallelizable with S3.5** (after S3.1).

Add a new case to `processTaskIpc()` for `type: 'study_generated_activities'`.

**IPC payload shape (what the generator agent writes):**
```typescript
{
  type: 'study_generated_activities',
  conceptId: string,
  activities: GeneratedActivity[]
}
```

**Handler logic:**
1. Validate `conceptId` exists in DB via `getConceptById()`. If not found, log error and return.
2. Build a `NewLearningActivity[]` from the activities array. For each activity:
   a. Validate **required** fields: `activityType`, `prompt`, `referenceAnswer`, `bloomLevel`. If any are missing, log and **skip** that entry (do NOT throw — one bad activity must not block the batch).
   b. Validate `activityType` is a known `ActivityType` value. Validate `bloomLevel` is 1–6.
   c. **Optional** fields — pass through when present, use defaults when absent: `difficultyEstimate` (default 5), `cardType` (default null), `sourceNotePath` (default null), `sourceChunkHash` (default null), `relatedConceptIds` (default empty — no activity_concepts links). Do NOT skip an activity because an optional field is missing.
   d. Map to `NewLearningActivity`:
      - `id`: `crypto.randomUUID()`
      - `conceptId`: from payload
      - `activityType`, `prompt`, `referenceAnswer`, `bloomLevel`, `difficultyEstimate`, `cardType`, `sourceNotePath`, `sourceChunkHash`: from activity
      - `generatedAt`: `new Date().toISOString()`
      - `author`: `'system'`
      - `easeFactor`: `2.5`, `intervalDays`: `1`, `repetitions`: `0`
      - `dueAt`: `computeDueDate(1)` (due tomorrow)
      - `masteryState`: `'new'`
3. Call `batchCreateActivities(validActivities)` from queries.js.
4. For activities with `relatedConceptIds` (comparison/synthesis): call `createActivityConceptLinks(activityId, relatedConceptIds)`.
5. Log: `"IPC: inserted N activities for concept {title} (M skipped)"`

**Constraint:** Invalid activities are logged and skipped. The rest of the batch is still inserted. Never throw from this handler — the IPC watcher expects handlers to resolve, not reject.

**Constraint:** Use `computeDueDate` from `src/study/sm2.js` for the initial due date. Do NOT hardcode date arithmetic.

**Imports to add to `src/ipc.ts`:**
- `import { getConceptById, batchCreateActivities, createActivityConceptLinks } from './study/queries.js'`
- `import { computeDueDate } from './study/sm2.js'`
- `import type { GeneratedActivity, ActivityType } from './study/types.js'`

- [ ] **Step 1:** Add imports to `src/ipc.ts`
- [ ] **Step 2:** Add `case 'study_generated_activities':` block to `processTaskIpc()` switch
- [ ] **Step 3:** Run build check: `npm run build` — no type errors
- [ ] **Step 4:** Run full test suite: `npm test` — no regressions
- [ ] **Step 5:** Commit: `feat(study): add IPC handler for generated activities (S3.6)`

---

## S3.7: Post-Session Generation Trigger

**Files:** Modify `src/study/engine.ts`, modify `src/study/engine.test.ts`

**Depends on S3.2 + S3.5.**

### `triggerPostSessionGeneration(sessionId: string): Promise<void>`

Algorithm:
1. Call `resetGenerationCycle()` from generator.js (resets rate limit counter)
2. Get all activity log entries for this session via `getLogsBySession(sessionId)`
3. Collect unique `conceptId` values from the logs
4. For each unique concept: call `checkForAdvancement(conceptId)`
5. For each advancement with `generationNeeded === true`:
   - Call `generateActivities(conceptId, advancement.newCeiling as BloomLevel)` from generator.js
6. Log summary: `"Post-session generation: {N} concepts checked, {M} advanced, {K} queued for generation"`

**Constraint:** Wrap each `generateActivities()` call in try/catch. Failure for one concept must NOT prevent generation for others. Log errors but don't throw.

**Constraint:** This function does NOT end the study session or update the session record. The API route (S4) calls `updateStudySession()` for lifecycle, then calls `triggerPostSessionGeneration()` for background work.

### Tests

Mock `generateActivities` (it spawns containers). Test:

| Scenario | Expected |
|----------|----------|
| Session with 2 completed activities, 1 concept advances | `generateActivities` called once for the advanced concept |
| Session with 3 concepts, none advance | `generateActivities` not called |
| `generateActivities` throws for 1 concept | other concepts still processed, error logged |
| Empty session (no logs) | no calls, no errors |

- [ ] **Step 1:** Add `triggerPostSessionGeneration` to engine.ts with imports from generator.js
- [ ] **Step 2:** Add tests with mocked generator
- [ ] **Step 3:** Run tests: `npx vitest run src/study/engine.test.ts`
- [ ] **Step 4:** Commit: `feat(study): add post-session generation trigger (S3.7)`

---

## S3.8: Barrel Export + Full Verification

**Files:** Modify `src/study/index.ts`

- [ ] **Step 1:** Add exports to `src/study/index.ts`:
  ```typescript
  export * from './engine.js';
  export * from './session-builder.js';
  export * from './generator.js';
  ```
- [ ] **Step 2:** Run study tests: `npx vitest run src/study/`
- [ ] **Step 3:** Run full test suite: `npm test`
- [ ] **Step 4:** Build check: `npm run build`
- [ ] **Step 5:** Commit: `feat(study): export engine, session-builder, generator from barrel (S3.8)`

---

## Acceptance Criteria

From master plan S3 (non-negotiable):

- [ ] Generator produces valid activities for a concept at each Bloom's level (tested via mocked container + IPC handler unit)
- [ ] IPC handler validates activities and rejects anti-patterns (bad type, missing fields)
- [ ] Engine correctly recommends activity types based on mastery state
- [ ] Session builder produces balanced sessions with correct block composition
- [ ] Completion flow: activity done → SM-2 updated → mastery updated → advancement detected → generation triggered
- [ ] Post-session trigger handles errors gracefully (one concept failure doesn't block others)
- [ ] All tests pass (`npm test`)
- [ ] Clean build (`npm run build`)
