# Multi-Method Study System — Master Implementation Plan

> **Cross-session tracker.** This document is the single source of truth for the study system implementation. Each sprint has checkboxes for progress tracking. At the start of each session, check what's done and pick up the next unchecked item. Sub-plans for each sprint live alongside this file.

**Spec:** `docs/superpowers/specs/2026-04-12-multi-method-study-system-design.md` (v2.1)

**Supersedes:** `docs/superpowers/plans/2026-04-05-study-plan-system.md` (cards-only plan, never implemented)

**Spec deviations:** The spec's Phase 1 includes Telegram daily reminders and concept discovery as part of the MVP. This plan deliberately defers Telegram to S7, making the dashboard study loop (S4) the usable MVP. Rationale: the dashboard is the primary learning surface — getting it right matters more than mobile reminders. Post-session activity generation is pulled forward from spec Phase 4 to S3 so that sessions produce new activities immediately.

**Tech Stack:** TypeScript/Node.js (backend), Next.js 16 + React 19 (dashboard), Drizzle ORM + SQLite/better-sqlite3 (storage), LightRAG (RAG), Vitest (tests), NanoClaw container agents (LLM work)

---

## 1. Architecture Decisions

These decisions are **binding across all sprints**. Sub-plans must not contradict them. If a decision needs revision, update this section first.

### 1.1 Agent Architecture

Two container agent roles serve the study system. Both use the same container image (`nanoclaw-agent:latest`) but get different CLAUDE.md files, IPC namespaces, and mounted context.

#### Study Agent (interactive, long-lived)

**Purpose:** Handles all conversational learning methods and AI evaluation during study sessions.

**Surface:** Dashboard chat via web channel (SSE streaming).

**Session lifecycle:**
1. Student opens `/study/chat` or triggers AI evaluation from `/study/session`
2. Dashboard creates a session ID, sends first message via web channel
3. Main process spawns container with study group context
4. Container stays alive across all activities in the session (reuses session ID)
5. Container dies after 30-min idle timeout or explicit close
6. Next study session gets a fresh container (clean cognitive context)

**JID format:** `web:study:{sessionId}` (new pattern, alongside existing `web:review:{draftId}`)

**Mounted context:**
- `/workspace/group` ← `groups/study/` (rw) — Study agent's working directory
- `/workspace/group/CLAUDE.md` — Study-specific system prompt with:
  - Available methods (Feynman, Socratic, case analysis, comparison, synthesis)
  - Evaluation rubrics per Bloom's level
  - Brain-first principle enforcement ("never lead with answers")
  - Session state awareness (current concept, Bloom's level, method)
  - RAG query instructions
- Vault mounted read-only for source reference
- IPC namespace: `study/{sessionId}`

**Handles:**
- Feynman technique dialogue (multi-turn, gap identification)
- Socratic questioning (iterative, assumption-probing)
- Case analysis discussion (multi-step reasoning)
- Synthesis conversation (cross-concept integration)
- AI evaluation of L3+ activity responses
- Collaborative plan creation dialogue
- Student-generated activity refinement

**IPC contract (agent → main process):**
```typescript
// Agent completes an evaluation
{ type: 'study_complete', activityId: string, quality: number,
  responseText?: string, aiFeedback?: string, surface: 'dashboard_chat' }

// Agent requests concept state for context
{ type: 'study_concept_status', conceptId?: string, domain?: string }

// Agent suggests new activities from dialogue
{ type: 'study_suggest_activity', conceptId: string, activityType: string,
  prompt: string, bloomLevel: number, author: 'student' | 'system' }
```

#### Generator Agent (batch, single-turn)

**Purpose:** Generates learning activities and audio scripts in batches.

**Surface:** Background — triggered by engine post-session or morning scheduled task.

**Session lifecycle:**
1. Engine determines which concepts need new activities
2. Main process spawns container with generator context
3. Agent generates activities as structured JSON, writes to IPC
4. Container closes after single turn

**JID format:** Uses existing task scheduling infrastructure (no web channel needed).

**Mounted context:**
- `/workspace/group` ← `groups/study-generator/` (rw) — Generator working directory
- `/workspace/group/CLAUDE.md` — Generation-specific system prompt with:
  - Activity type specifications (card, elaboration, Feynman prompt, comparison, etc.)
  - Quality rules (Wozniak 20 Rules, Matuschak 5 Attributes, anti-patterns)
  - Bloom's level generation guidelines
  - Structured JSON output format
  - RAG query instructions for source content retrieval
- Vault mounted read-only for source content
- IPC namespace: `study-generator/{jobId}`

**Handles:**
- L1-L2 activity generation (cards + elaboration prompts)
- L3-L4 activity generation (Feynman prompts, concept maps, comparison tasks)
- L5-L6 activity generation (synthesis prompts, Socratic starters, case scenarios)
- Audio/podcast script generation
- Activity quality self-validation before output

**IPC contract (agent → main process):**
```typescript
// Agent outputs generated activities
{ type: 'study_generated_activities', conceptId: string,
  activities: GeneratedActivity[] }

// Agent outputs audio script
{ type: 'study_audio_script', conceptIds: string[],
  script: string, contentType: 'summary' | 'review_primer' | 'weekly_digest' }
```

### 1.2 Data Flow Architecture

Three distinct data flows, each using the appropriate mechanism:

```
FLOW 1: Structured data (reads + writes)
  Dashboard ←→ SQLite (direct, via better-sqlite3)
  - Concept lists, mastery bars, due counts, session composition
  - Activity completion writes, concept approval, plan management
  - Analytics queries
  - No main process involvement needed

FLOW 2: Conversational AI (dashboard chat)
  Dashboard → HTTP POST /api/study/chat → Web Channel (port 3200)
    → Main Process → Container Agent (Study Agent)
    → Agent responds via stdout → Main Process
    → Web Channel SSE → Dashboard EventSource
  - Feynman, Socratic, case analysis, synthesis, plan dialogue
  - AI evaluation of free-text responses

FLOW 3: Background generation (no dashboard involvement)
  Engine (main process) → Container Agent (Generator Agent)
    → Agent outputs via IPC → Main Process → SQLite writes
  - Post-session activity generation
  - Morning scheduled task generation
  - Audio/podcast script generation
```

**Key principle:** The dashboard never spawns containers or calls LLMs. It reads/writes SQLite for structured data and proxies to the web channel for conversational AI. The main process owns all LLM orchestration.

### 1.3 Study Session Lifecycle

A study session spans the student's entire sitting, potentially mixing self-rated activities (no LLM) with AI-evaluated activities (LLM via container).

```
Student opens /study → Dashboard reads session composition from SQLite
  │
  ├─ Self-rated activity (L1-L2 card, basic elaboration):
  │    Dashboard shows question → student types answer → reveals reference
  │    → student self-rates (0-5) → Dashboard POSTs to /api/study/complete
  │    → API writes to activity_log + updates learning_activities SM-2 fields
  │    → API calls mastery update (pure function) → updates concepts table
  │    → Dashboard refreshes next activity from local session state
  │    (No container involved)
  │
  ├─ AI-evaluated activity (L3+ Feynman, case, synthesis):
  │    Dashboard shows prompt → student writes response → submits
  │    → Dashboard POSTs to /api/study/evaluate with response text
  │    → API proxies to web channel → Study Agent evaluates via RAG
  │    → Agent returns quality score + feedback via SSE
  │    → Dashboard displays feedback → student reviews
  │    → Dashboard POSTs to /api/study/complete with AI quality score
  │    → Same DB update path as self-rated
  │
  └─ Conversational activity (Socratic, deep Feynman):
       Student navigates to /study/chat
       → Opens SSE connection → sends first message
       → Study Agent conducts multi-turn dialogue
       → At conclusion, agent sends study_complete via IPC
       → Main process updates DB
       → Dashboard refreshes on return to /study/session
```

### 1.4 Web Channel Extension

The existing web channel (`src/channels/web.ts`) supports `web:review:{draftId}` for draft reviews. The study system adds a new JID pattern:

**New JID pattern:** `web:study:{sessionId}`

**Changes required:**
- `sendMessage()`: detect `web:study:` prefix, route to study SSE clients
- New endpoint: `POST /study-message` — accepts `{ sessionId, text }`, routes to study container
- New endpoint: `GET /study-stream/{sessionId}` — SSE connection for study chat
- New endpoint: `POST /study-close/{sessionId}` — close study session container
- Response buffer: same 50-message cap (study transcripts saved in DB, not buffer)

**Session persistence:** Study chat transcripts are saved in `activity_log.response_text` and linked to the session. The buffer is ephemeral — if the student refreshes, the dashboard reloads transcript from DB and reconnects SSE.

### 1.5 Concept Discovery Pipeline

When ingestion promotes a vault note to `concepts/`, the study system creates a pending concept:

```
handlePromotion() completes → promoted_paths includes concepts/*.md
  → For each promoted concept note:
     1. Read frontmatter (title, type, domain, subdomain, topics, source_doc)
     2. Check if concept already exists in concepts table (by vault_note_path)
     3. If new: INSERT with status='pending', populate from frontmatter
     4. If exists: update vault_note_path if moved, leave status unchanged
  → Dashboard shows pending count on /study overview
  → Telegram morning message includes: "N new concepts from yesterday"
```

**Frontmatter extension:** The ingestion agent prompt gets two new required fields:
- `domain` — knowledge domain (e.g., "Knowledge Management", "Cognitive Psychology")
- `subdomain` — subdomain within the domain (e.g., "KM Models", "Learning & Memory")

These are added to the agent's generation prompt template and validation rules in `draft-validator.ts`.

**Existing vault notes migration:** A one-time script scans `vault/concepts/` and creates pending concept entries for any note not yet in the concepts table. Domain/subdomain inferred from existing `topics` frontmatter field where possible, null otherwise.

### 1.6 Testing Strategy

**TDD (write tests first):**
- SM-2 algorithm — pure function, easy to get wrong, critical for correctness
- Weighted evidence mastery — time decay math, threshold logic, Bloom's ceiling
- Session builder composition — block allocation, interleaving, constraints

**Unit tests (write alongside):**
- Engine concept progression (given state → recommendations)
- Activity quality validation (Wozniak/Matuschak rules)
- Concept discovery hook (frontmatter → pending concept)
- DB CRUD functions for all study tables
- Use Drizzle test helper (`createTestDb()`) from S0

**Integration tests (write after feature works):**
- Full cycle: build session → complete activity → mastery update → next session changes
- Concept approval → activity generation trigger
- Plan creation → concept association → session inclusion

**Manual verification:**
- All dashboard UI (start dev server, test flows)
- Container agent dialogue quality (manual study sessions)
- Telegram notifications (manual trigger)

**Not tested:**
- LLM output quality (test parsing, not generation)
- E2E browser automation (overkill for single-user)
- Coverage thresholds (focus on critical path correctness)

### 1.7 Data Layer: Drizzle ORM

The project migrates from raw SQL (`better-sqlite3` with hand-written queries) to **Drizzle ORM** before any study system work begins (S0). This is a full data layer rewrite that future-proofs the project for distribution and ongoing development.

**Why Drizzle:**
- Schema-as-code: TypeScript table definitions = single source of truth for types and schema
- Built-in migrations: `drizzle-kit generate` produces SQL migration files, `drizzle-kit migrate` applies them. No hand-rolled ALTER TABLE or try-catch patterns.
- Type-safe queries: all DB access is fully typed, no raw SQL string errors
- Native `better-sqlite3` support: zero runtime overhead, synchronous API preserved
- Lightweight: minimal dependency footprint (~50KB runtime)

**Schema organization:**
```
src/db/
  schema/
    chats.ts              — chats, messages tables
    tasks.ts              — scheduled_tasks, task_run_logs tables
    ingestion.ts          — ingestion_jobs table
    rag.ts                — rag_index_tracker table
    groups.ts             — registered_groups, sessions tables
    state.ts              — router_state, settings, zotero_sync tables
    citations.ts          — citation_edges table
    study.ts              — concepts, learning_activities, activity_log,
                            study_sessions, study_plans + join tables
  index.ts                — Drizzle instance, db export, shared helpers
  migrate.ts              — Migration runner (called on startup)
drizzle/
  migrations/             — Generated SQL migration files (committed to git)
drizzle.config.ts         — Drizzle Kit configuration
```

**Migration strategy:**
- S0 creates a baseline migration from the current raw schema (12 existing tables)
- S1 adds study tables as the next migration
- Each subsequent schema change generates a new migration via `drizzle-kit generate`
- Migrations run automatically on startup via `migrate()` in `src/db/migrate.ts`
- Existing databases are migrated in-place; new installs run all migrations from scratch

**Dashboard DB access:**
- Dashboard imports the same Drizzle schema types for type safety
- Dashboard's `study-db.ts` and `ingestion-db.ts` use Drizzle queries (not raw SQL)
- Schema version mismatch (dashboard starts before main process runs migrations) handled by Drizzle's migration check — throws a clear error

**Test infrastructure:**
- `_initTestDatabase()` replaced with a Drizzle-based helper that creates an in-memory SQLite + runs all migrations
- All existing tests updated to use Drizzle queries where they interact with DB
- Test pattern: `const testDb = createTestDb()` → returns typed Drizzle instance

---

## 2. Group Setup

Two new NanoClaw groups for study system agents.

### 2.1 `groups/study/`

Interactive study agent for dashboard chat.

```
groups/study/
  CLAUDE.md          — Study agent system prompt
  logs/              — Container logs (auto-created)
```

**CLAUDE.md contents (designed in S5, scaffolded in S2):**
- Role: "You are a study tutor for Simon's university courses"
- Available methods with instructions for each
- Evaluation rubrics per Bloom's level
- Brain-first enforcement rules
- RAG query instructions (how to retrieve vault content)
- IPC output format for study_complete
- Concept and activity context injection pattern

**Registration:** Added to `registered_groups` in DB with:
- `jid`: `web:study:__agent__` (base JID, sessionId appended at runtime)
- `folder`: `study`
- `trigger_pattern`: null (no trigger needed — activated by web channel routing)
- `requires_trigger`: 0
- `is_main`: 0

### 2.2 `groups/study-generator/`

Batch activity generator for background tasks.

```
groups/study-generator/
  CLAUDE.md          — Generation prompt with quality rules
  logs/              — Container logs (auto-created)
```

**CLAUDE.md contents (designed in S3):**
- Role: "You generate learning activities from vault content"
- Activity type specifications with examples
- Quality rules (Wozniak, Matuschak, anti-patterns)
- Bloom's level mapping to activity types
- Structured JSON output format
- RAG query instructions

**Registration:** Added to `registered_groups` with:
- `jid`: `internal:study-generator` (not a real chat JID — triggered by scheduler)
- `folder`: `study-generator`
- `trigger_pattern`: null
- `requires_trigger`: 0
- `is_main`: 0

---

## 3. File Map

All new and modified files, organized by sprint.

### New files

```
src/db/                        — S0: Drizzle ORM data layer
  schema/
    chats.ts                   — S0: chats, messages tables
    tasks.ts                   — S0: scheduled_tasks, task_run_logs tables
    ingestion.ts               — S0: ingestion_jobs table
    rag.ts                     — S0: rag_index_tracker table
    groups.ts                  — S0: registered_groups, sessions tables
    state.ts                   — S0: router_state, settings, zotero_sync tables
    citations.ts               — S0: citation_edges table
    study.ts                   — S1: study system tables (concepts, activities, sessions, plans)
    index.ts                   — S0: re-exports all schemas
  index.ts                     — S0: Drizzle instance, db export, helpers
  migrate.ts                   — S0: Migration runner (called on startup)

drizzle/
  migrations/                  — S0+: Generated SQL migration files (committed to git)

drizzle.config.ts              — S0: Drizzle Kit configuration

src/study/
  types.ts                     — S1: Non-DB interfaces, enums, result types
  sm2.ts                       — S1: SM-2 algorithm (pure functions)
  sm2.test.ts                  — S1: SM-2 tests (TDD)
  mastery.ts                   — S1: Weighted evidence mastery (pure functions)
  mastery.test.ts              — S1: Mastery tests (TDD)
  engine.ts                    — S3: Concept progression, activity recommendations
  engine.test.ts               — S3: Engine tests
  session-builder.ts           — S3: Daily session composition
  session-builder.test.ts      — S3: Session builder tests (TDD)
  generator.ts                 — S3: Activity generation orchestration (container dispatch)
  generator.test.ts            — S3: Generator tests
  planner.ts                   — S6: Collaborative plan dialogue orchestration
  audio.ts                     — S8: Audio/podcast generation pipeline
  scheduled.ts                 — S7: Study-specific scheduled task definitions
  concept-discovery.ts         — S2: Ingestion hook for concept creation
  concept-discovery.test.ts    — S2: Discovery tests
  index.ts                     — S1: Public exports

groups/study/
  CLAUDE.md                    — S2 (scaffold), S5 (full)

groups/study-generator/
  CLAUDE.md                    — S3

dashboard/src/app/study/
  page.tsx                     — S4: Study overview (concept list, due counts, mastery bars)
  session/
    page.tsx                   — S4: Study session UI (card review, elaboration, self-rating)
  chat/
    page.tsx                   — S5: Dashboard chat interface (SSE streaming)
  plan/
    page.tsx                   — S6: Plan creation and management
  concepts/
    [id]/
      page.tsx                 — S8: Concept detail page

dashboard/src/app/api/study/
  concepts/
    route.ts                   — S2: GET concepts list with mastery
    pending/
      route.ts                 — S2: GET pending concepts
    approve/
      route.ts                 — S2: POST approve concept(s)
  session/
    route.ts                   — S4: GET build session, POST create session record
    [id]/
      reflect/
        route.ts               — S4: POST save reflection
  complete/
    route.ts                   — S4: POST complete activity
  evaluate/
    route.ts                   — S5: POST proxy to study agent for AI evaluation
  plans/
    route.ts                   — S6: GET list plans, POST create plan
  stats/
    route.ts                   — S8: GET analytics data
  chat/
    route.ts                   — S5: POST send message to study agent
    stream/
      [sessionId]/
        route.ts               — S5: GET SSE stream from study agent

dashboard/src/lib/
  study-db.ts                  — S2: Dashboard-side Drizzle queries for study tables

scripts/
  migrate-vault-concepts.ts    — S2: One-time vault → concepts table migration
```

### Modified files

```
src/db.ts                      — S0: Replaced by src/db/index.ts (all raw SQL → Drizzle)
src/ipc.ts                     — S3: study_generated_activities IPC; S5: study_complete + study_concept_status; S7: remaining IPC
src/channels/web.ts            — S5: Add web:study: JID pattern + endpoints
src/index.ts                   — S0: Drizzle startup; S5: findGroupForJid + study JID routing
src/ingestion/pipeline.ts      — S2: Post-promotion concept discovery hook
src/ingestion/draft-validator.ts — S2: Add domain/subdomain validation
src/ingestion/agent-processor.ts — S2: Add domain/subdomain to generation prompt
src/channels/registry.ts       — S5: Add onStudyClosed to ChannelOpts
src/task-scheduler.ts          — S7: Register study scheduled tasks
dashboard/src/app/layout.tsx   — S4: Add "Study" nav link
dashboard/src/lib/ingestion-db.ts — S0: Raw SQL → Drizzle queries
```

---

## 4. Sprint Plan

### Dependency graph

```
S0: Drizzle Migration ───────────┐
  (ORM migration, schema-as-code,│
   migrate all queries + tests)  │
                                 │
S1: Foundation ──────────────────┤
  (study schema, SM-2, mastery,  │
   types, group scaffolds)       │
                                 │
S2: Concept Lifecycle ───────────┤
  (CRUD, discovery, approval,    │
   migration, basic /study page) │
                                 │
S3: Generation + Engine ─────────┤
  (generator agent, engine,      │
   session builder)              │
                                 │
         ┌───────────────────────┤
         │                       │
S4: Study Session UI        S5: Dashboard Chat + Deep Methods
  (session page, self-rate,   (chat UI, SSE, study agent,
   completion flow)            AI evaluation, L3-L6 gen)
         │                       │
         └───────────┬───────────┘
                     │
         ┌───────────┤
         │           │
S6: Planning    S7: Telegram + Scheduled
  (plan dialogue,  (IPC handlers, daily/weekly
   plan management) cron, Mr. Rogers integration)
         │           │
         └─────┬─────┘
               │
S8: Analytics + Audio + Polish
  (stats, concept detail, podcasts,
   scaffolding, staleness, prereqs)
```

### Parallelization opportunities

| Phase | Session A | Session B | Notes |
|-------|-----------|-----------|-------|
| S0 | `src/db.ts` → Drizzle schema + queries | Dashboard DB files → Drizzle | Independent: backend vs. dashboard |
| S1 | Study schema + types + group scaffolds | SM-2 + mastery algorithms (TDD) | Types file needed by both — create first or duplicate temporarily |
| S2 | Sequential | — | Small sprint, not worth splitting |
| S3 | Generator agent + CLAUDE.md | Engine + session builder (TDD) | Generator needs container; engine is pure logic |
| S4 + S5 | Study session UI (S4) | Dashboard chat + web channel (S5) | Fully independent — different pages, different data flows |
| S6 + S7 | Planning system (S6) | Telegram + scheduled tasks (S7) | Fully independent codepaths |
| S8 | Analytics + concept detail | Audio + remaining polish | Independent features |

---

### S0: Drizzle ORM Migration

**Goal:** Migrate the entire data layer from raw SQL to Drizzle ORM. All existing tables, queries, and tests converted. Baseline migration generated. Project is distribution-ready with proper schema management.

**Estimated sessions:** 2-3 (parallelizable: backend vs. dashboard)

**Dependencies:** None — this is the first sprint.

**Key decisions:**
- Full migration, not incremental. No raw SQL remains after S0.
- Schema files organized by domain (see Section 1.7)
- Drizzle Kit for migration generation; migrations committed to git
- Migrations run automatically on startup
- In-memory SQLite + Drizzle for test infrastructure
- Dashboard uses same Drizzle schema types (imported) for type safety

#### Checklist

- [ ] **S0.0** Backup current database
  - `cp store/messages.db store/messages.db.pre-drizzle-backup`
  - Verify backup: `sqlite3 store/messages.db.pre-drizzle-backup "SELECT count(*) FROM chats"`
- [ ] **S0.1** Install dependencies
  - `npm install drizzle-orm` (runtime)
  - `npm install -D drizzle-kit` (dev — migration generation + studio)
  - `cd dashboard && npm install drizzle-orm` (dashboard runtime)
- [ ] **S0.2** Create Drizzle config
  - `drizzle.config.ts` at project root
  - SQLite dialect, `better-sqlite3` driver
  - Schema path: `src/db/schema/*`
  - Migration output: `drizzle/migrations/`
- [ ] **S0.3** Define existing table schemas in TypeScript
  - `src/db/schema/chats.ts` — `chats`, `messages` tables
  - `src/db/schema/tasks.ts` — `scheduled_tasks`, `task_run_logs` tables
  - `src/db/schema/ingestion.ts` — `ingestion_jobs` table
  - `src/db/schema/rag.ts` — `rag_index_tracker` table
  - `src/db/schema/groups.ts` — `registered_groups`, `sessions` tables
  - `src/db/schema/state.ts` — `router_state`, `settings`, `zotero_sync` tables
  - `src/db/schema/citations.ts` — `citation_edges` table
  - `src/db/schema/index.ts` — re-exports all schemas
  - Each table must exactly match current CREATE TABLE + ALTER TABLE columns
- [ ] **S0.4** Generate baseline migration
  - `npx drizzle-kit generate` → produces initial SQL migration in `drizzle/migrations/`
  - Verify generated SQL matches current `createSchema()` output
  - Add `drizzle/migrations/meta/` journal file to git
- [ ] **S0.5** Create Drizzle instance and migration runner
  - `src/db/index.ts` — create `better-sqlite3` connection, wrap with `drizzle()`, export `db`
  - `src/db/migrate.ts` — run pending migrations on startup via `migrate()`
  - Preserve WAL mode and FK enforcement (`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON`)
  - Export `getDb()` for backwards compatibility during migration (can remove later)
- [ ] **S0.6** Migrate all query functions in `src/db.ts` to Drizzle
  - Replace raw SQL in every exported function with Drizzle query builder
  - Maintain same function signatures (callers don't change yet)
  - Functions to migrate (~50+): storeChatMetadata, storeMessage, getNewMessages, getMessagesSince, createTask, getTaskById, getDueTasks, updateTask, deleteTask, logTaskRun, createIngestionJob, getIngestionJobs, updateIngestionJob, getTrackedDoc, upsertTrackedDoc, deleteTrackedDoc, getRegisteredGroup, setRegisteredGroup, getAllRegisteredGroups, getRouterState, setRouterState, getSession, setSession, getSetting, setSetting, insertCitationEdge, deleteCitationEdges, getCites, getCitedBy, etc.
  - Transaction support: Drizzle wraps `better-sqlite3`'s synchronous transactions natively
- [ ] **S0.7** Migrate dashboard DB access to Drizzle
  - `dashboard/src/lib/ingestion-db.ts` → Drizzle queries
  - Any other dashboard files with raw SQL
  - Import schema types from shared schema files (or duplicate — Next.js may need its own Drizzle instance due to separate process)
  - Dashboard creates its own Drizzle instance pointing to same `store/messages.db`
- [ ] **S0.8** Update test infrastructure
  - Replace `_initTestDatabase()` with Drizzle-based helper: creates in-memory SQLite, runs all migrations, returns typed Drizzle instance
  - Update all ~50 test files that use `_initTestDatabase()` or raw DB access
  - Verify all 664 tests pass
- [ ] **S0.9** Update startup sequence in `src/index.ts`
  - Replace `initDatabase()` call with Drizzle migration runner
  - Ensure migrations run before any other initialization (channels, IPC, scheduler)
- [ ] **S0.10** Cleanup
  - Remove old `createSchema()` function and inline ALTER TABLE migrations from `src/db.ts`
  - Remove `_initTestDatabase()` (replaced by Drizzle test helper)
  - Verify `npm test` passes, `npm run build` succeeds
  - Verify dashboard `npm run dev` works with Drizzle

**Acceptance criteria:**
- Zero raw SQL remaining in `src/db.ts` or dashboard DB files
- `drizzle/migrations/` contains baseline migration committed to git
- All 664+ existing tests pass with Drizzle
- New install (empty DB) runs migrations and produces correct schema
- Existing install (populated DB) runs migrations without data loss
- `npx drizzle-kit studio` can browse the database (dev tooling works)

---

### S1: Foundation

**Goal:** Study system schema (as Drizzle migration), pure algorithms, shared types, group directory scaffolds. Everything downstream depends on this.

**Estimated sessions:** 2 (parallelizable: schema vs. algorithms)

**Key decisions:**
- Study tables defined in `src/db/schema/study.ts` as Drizzle schema, migration generated via `drizzle-kit generate`
- Transactions via Drizzle's native `db.transaction()` wrapper (synchronous, better-sqlite3)
- Study query functions in `src/study/` modules (not in `src/db.ts` — study system is self-contained)
- Types derived from Drizzle schema via `typeof table.$inferSelect` / `$inferInsert` where possible, custom interfaces in `src/study/types.ts` for non-DB types

#### Checklist

- [ ] **S1.1** Create `src/study/types.ts` — non-DB interfaces and enums
  - ActivityType, BloomLevel, MasteryState enums/unions
  - GeneratedActivity (generator agent output format)
  - SessionComposition (session builder output)
  - SM2Result, MasteryResult, CompletionResult, BloomAdvancement
  - DB row types (Concept, LearningActivity, etc.) inferred from Drizzle schema via `$inferSelect`
- [ ] **S1.2** Define study tables in `src/db/schema/study.ts` (Drizzle schema)
  - `concepts` (with mastery_L1-L6, bloom_ceiling, status, domain/subdomain)
  - `conceptPrerequisites` (concept_id → concepts)
  - `learningActivities` (SM-2 fields, activity_type, bloom_level, author → concepts)
  - `activityConcepts` (join table → learningActivities, concepts)
  - `studyPlans` + `studyPlanConcepts` (learning contracts → concepts)
  - `studySessions` (metacognition → studyPlans, nullable FK)
  - `activityLog` (every interaction → learningActivities, studySessions)
  - All indexes from spec Section 3.1
  - Re-export from `src/db/schema/index.ts`
- [ ] **S1.3** Generate and apply study tables migration
  - `npx drizzle-kit generate` → new migration file in `drizzle/migrations/`
  - Verify migration applies cleanly on existing DB (with S0 baseline)
  - Verify fresh DB (all migrations from scratch) produces correct schema
- [ ] **S1.4** Add study query functions in `src/study/` modules (Drizzle queries)
  - Concept: create, get, getByDomain, getPending, updateStatus, updateMastery
  - Activity: create, get, getDue, updateSM2, getByConceptAndType
  - ActivityLog: create, getByConceptAndLevel, getBySession
  - Session: create, update, getActive
  - Plan: create, get, getAll, update, addConcepts
  - Multi-table writes use Drizzle's `db.transaction()` (synchronous, native better-sqlite3)
  - Add a test for transaction rollback on partial failure
- [ ] **S1.5** Add DB tests for all study query functions
- [ ] **S1.6** Implement SM-2 in `src/study/sm2.ts` (TDD)
  - `computeSM2(quality, repetitions, easeFactor, interval) → SM2Result`
  - `computeDueDate(interval, fromDate?) → string`
  - Pure functions, no side effects, no DB access
  - Edge cases: quality 0-5, first review, EF floor at 1.3
- [ ] **S1.7** Implement weighted evidence mastery in `src/study/mastery.ts` (TDD)
  - `computeMastery(activityLogs, now?) → MasteryResult`
  - `computeBloomCeiling(mastery) → number`
  - `computeOverallMastery(mastery) → number`
  - Constants: BLOOM_WEIGHTS, MASTERY_THRESHOLD (10.0), DECAY_HALF_LIFE_DAYS (30)
  - Time decay: `0.5^(daysSince / halfLife)`
- [ ] **S1.8** Create `src/study/index.ts` — public exports
- [ ] **S1.9** Scaffold group directories
  - `groups/study/CLAUDE.md` — placeholder with role description
  - `groups/study-generator/CLAUDE.md` — placeholder with role description

**Acceptance criteria:**
- All study tables created with correct schema (verified by DB tests)
- SM-2 produces correct intervals for all quality values 0-5 across multiple repetitions
- Mastery correctly computes per-level evidence with time decay
- Bloom ceiling advances when evidence exceeds 70% of threshold
- All tests pass (`npm test`)

---

### S2: Concept Lifecycle

**Goal:** Concepts flow from ingestion → pending → active. Dashboard shows concept list with approval UI.

**Estimated sessions:** 2

**Dependencies:** S1 (tables + types)

**Key decisions:**
- Concept discovery is a synchronous call at end of `handlePromotion()`, not an async watcher
- Domain/subdomain added to ingestion agent prompt as required frontmatter fields
- Batch approval by domain is a single API call, not per-concept
- The `/study` page in this sprint is minimal — concept list + approval. Session UI comes in S4.

#### Checklist

- [ ] **S2.1** Create `src/study/concept-discovery.ts`
  - `discoverConcepts(promotedPaths: string[], vaultDir: string) → ConceptDiscovery[]`
  - Reads each promoted `concepts/*.md`, extracts frontmatter
  - Returns array of concept data ready for DB insert
  - Handles: missing domain (null), existing concept (skip), non-concept notes (skip)
- [ ] **S2.2** Tests for concept discovery
- [ ] **S2.3** Hook concept discovery into `src/ingestion/pipeline.ts`
  - At end of `handlePromotion()`, after promoted_paths are set
  - Call `discoverConcepts()` → batch insert into concepts table with status='pending'
  - Non-blocking: log errors but don't fail the promotion
- [ ] **S2.4** Update ingestion agent prompt (`src/ingestion/agent-processor.ts`)
  - Add `domain` and `subdomain` as required frontmatter fields for concept notes
  - Add guidance: "domain is the broad knowledge area, subdomain is the specific topic area"
- [ ] **S2.5** Update draft validator (`src/ingestion/draft-validator.ts`)
  - Add `domain` and `subdomain` to required fields for type=concept (warning, not error — allows null)
- [ ] **S2.6** Create `dashboard/src/lib/study-db.ts`
  - Dashboard-side Drizzle queries for study tables (same pattern as `ingestion-db.ts` post-S0: own Drizzle instance, shared schema types)
  - Functions: getConcepts, getPendingConcepts, approveConcept, approveDomain, getConceptStats
- [ ] **S2.7** Create dashboard API routes
  - `GET /api/study/concepts` — list concepts with mastery, Bloom's ceiling, due activity counts
  - `GET /api/study/concepts/pending` — list pending concepts grouped by domain
  - `POST /api/study/concepts/approve` — approve single or domain batch `{ conceptIds?: string[], domain?: string }`
- [ ] **S2.8** Create dashboard `/study` page (minimal)
  - Pending concepts section with domain-batch approve buttons
  - Active concepts table: name, domain, Bloom's ceiling, mastery bar, due count
  - Nav link added to `layout.tsx`
- [ ] **S2.9** Create `scripts/migrate-vault-concepts.ts`
  - Scans `vault/concepts/`, creates pending entries for notes not in concepts table
  - Infers domain from `topics` frontmatter where possible
  - Idempotent: safe to run multiple times
- [ ] **S2.10** Scaffold `groups/study/` registration
  - Register study group in DB (manual or via setup script)
  - CLAUDE.md updated with basic study context (full prompt designed in S5)

**Acceptance criteria:**
- Ingesting a new PDF produces pending concepts visible on `/study`
- Domain-batch approval moves concepts to active status
- Migration script correctly creates entries for existing vault notes
- No regressions in ingestion pipeline (existing tests pass)

---

### S3: Generation + Engine

**Goal:** System can generate activities for concepts, recommend what to study, and compose sessions.

**Estimated sessions:** 3-4 (parallelizable: generator vs. engine)

**Dependencies:** S2 (concepts exist in DB)

**Key decisions:**
- Generator agent receives concept content via RAG query (not direct vault mount — consistent with how other agents access knowledge)
- Engine is a pure logic module — no container spawning, no LLM calls. It reads DB state and returns recommendations.
- Session builder outputs a `SessionComposition` object that the API returns directly to the dashboard.
- Activity generation is rate-limited: max 10 concepts per cycle.

#### Checklist

- [ ] **S3.1** Design generator agent CLAUDE.md (`groups/study-generator/CLAUDE.md`)
  - Role, output format (JSON array of activities), quality rules
  - Bloom's level guidelines: what to generate at each level
  - Anti-pattern list from spec Section 3.3
  - Example outputs for each activity type
- [ ] **S3.2** Implement `src/study/generator.ts`
  - `generateActivities(conceptId, bloomLevel, options?) → GeneratedActivity[]`
  - Queries RAG for concept's vault content
  - Builds generation prompt with Bloom's level + quality rules
  - Spawns generator agent container (single-turn)
  - Parses structured JSON output
  - Validates against quality rules (rejects anti-patterns)
  - Stores valid activities in learning_activities table with SM-2 initial params
  - Rate limit: tracks concepts per cycle, queues remainder
- [ ] **S3.3** Generator tests (mock container output, test parsing + validation + DB writes)
- [ ] **S3.4** Implement `src/study/engine.ts`
  - `getConceptRecommendations(conceptId) → ActivityRecommendation[]`
    - Given mastery state, returns recommended activity types and Bloom's levels
  - `checkForAdvancement(conceptId) → BloomAdvancement | null`
    - After activity completion, checks if concept advanced to new Bloom's level
  - `processCompletion(activityId, quality, opts?) → CompletionResult`
    - Updates SM-2 on activity, logs to activity_log, updates concept mastery
    - Checks for advancement, returns whether generation is needed
    - All within a transaction
    - Note: `activity_log.session_id` is nullable — completions before S4 (and out-of-session completions like Telegram) pass `session_id = NULL`
  - `getDeEscalationAdvice(conceptId) → string | null`
    - If quality consistently < 3 and mastery declining, suggest returning to lower level
  - `getSynthesisOpportunities(domain?) → SynthesisOpportunity[]`
    - Within-subdomain: auto when 2+ concepts have bloom_ceiling >= 4
    - Within-domain: auto when concepts across subdomains have bloom_ceiling >= 4
    - Cross-domain: proposed only, requires confirmation
- [ ] **S3.5** Engine tests (with in-memory DB, test progression scenarios)
- [ ] **S3.6** Implement `src/study/session-builder.ts` (TDD)
  - `buildDailySession(options?) → SessionComposition`
  - Three blocks:
    - New material (~30%): L1-L2 activities for recent concepts, blocked by topic
    - Review (~50%): mixed types, interleaved across concepts/domains
    - Stretch (~20%): highest available Bloom's for concepts at ceiling 4+
  - Constraints: 25-30 min target OR 15-25 activities, at least 1 per active domain
  - Sorting: overdue first, low ease_factor, type variety
  - Never 2 consecutive same-concept activities in review block
- [ ] **S3.7** Session builder tests (TDD — test block allocation, interleaving, constraints)
- [ ] **S3.8** Add `study_generated_activities` IPC handler to `src/ipc.ts`
  - Receives generator agent output (array of activities)
  - Validates and inserts into learning_activities table
  - Creates activity_concepts entries for multi-concept activities
  - Needed for generator output to reach the DB
- [ ] **S3.9** Post-session generation trigger
  - After session completion, engine checks for Bloom's advancements
  - Dispatches generator for each advanced concept (background, rate-limited)
  - Queues remainder for next cycle

**Acceptance criteria:**
- Generator produces valid activities for a concept at each Bloom's level
- Generated activities pass quality validation (no anti-patterns)
- Engine correctly recommends activity types based on mastery state
- Session builder produces balanced sessions with correct block composition
- Completion flow: activity done → SM-2 updated → mastery updated → advancement detected → generation triggered

---

### S4: Study Session UI

**Goal:** End-to-end study loop on the dashboard for self-rated activities (L1-L2).

**Estimated sessions:** 2

**Dependencies:** S3 (engine + session builder produce sessions)

**Key decisions:**
- Session UI handles only self-rated activities in this sprint. AI evaluation added in S5.
- Activity type determines UI variant (card → text input, elaboration → text area, etc.)
- Pre/post session metacognition is basic: confidence rating (pre) + reflection text (post)

#### Checklist

- [ ] **S4.1** Create study session API routes
  - `GET /api/study/session` — calls session builder, returns SessionComposition
  - `POST /api/study/session` — creates study_sessions record with pre_confidence
  - `POST /api/study/complete` — calls engine.processCompletion(), returns result
  - `POST /api/study/session/[id]/reflect` — saves post_reflection, computes calibration
- [ ] **S4.2** Update `/study` overview page
  - Today's session card: activity counts by type, estimated time, "Start Session" button
  - Active concepts with Bloom's ceiling, mastery bars per level, due counts
  - 7-day streak indicator (sessions completed)
- [ ] **S4.3** Create `/study/session` page
  - Pre-session: confidence rating per concept (1-5 slider/buttons)
  - Activity flow: show prompt → student types response → submit → reveal reference → self-rate (0-5)
  - Activity type variants:
    - `card_review`: question → text input → reference answer
    - `elaboration`: "Why?" prompt → text area → source reasoning
  - Progress bar: activities completed / total
  - Skip button (logs quality=0)
  - Block labels ("New Material", "Review", "Stretch") with explanations
- [ ] **S4.4** Post-session reflection
  - Calibration feedback: compare pre-confidence vs. actual performance
  - Reflection prompt: "What did you find surprising or difficult?"
  - Session summary: activities completed, average quality, time spent
- [ ] **S4.5** Add "Study" link to dashboard nav (`layout.tsx`)

**Acceptance criteria:**
- Student can start a session, complete card + elaboration activities, rate themselves
- SM-2 schedules update after each completion (due dates change)
- Mastery bars update after session
- Pre/post metacognition flow works
- Session recorded in study_sessions table

---

### S5: Dashboard Chat + Deep Methods

**Goal:** Full conversational interface for deep learning methods (Feynman, Socratic, etc.) and AI evaluation.

**Estimated sessions:** 3-4

**Dependencies:** S3 (engine), S4 (completion flow)

**Key decisions:**
- Web channel extended with `web:study:` JID pattern (not a separate server)
- Chat transcripts saved per-activity in activity_log, linked to session
- Study agent gets full CLAUDE.md with method instructions and RAG access
- AI evaluation returns both a quality score (0-5) and textual feedback

#### Checklist

- [ ] **S5.1** Extend web channel and message routing for study sessions
  - `src/channels/web.ts`: Add `WEB_STUDY_PREFIX = 'web:study:'` constant
  - `src/channels/web.ts`: Update `ownsJid()` to match both `web:review:` and `web:study:` prefixes
  - `src/channels/web.ts`: Add `sendMessage()` handling for `web:study:` JIDs (route to study SSE clients)
  - `src/channels/web.ts`: New endpoint `POST /study-message` — accepts `{ sessionId, text }`, routes to study container
  - `src/channels/web.ts`: New endpoint `GET /study-stream/{sessionId}` — SSE connection for study chat
  - `src/channels/web.ts`: New endpoint `POST /study-close/{sessionId}` — close study session container
  - `src/index.ts`: Extend `findGroupForJid()` with `WEB_STUDY_PREFIX` handler (analogous to `WEB_REVIEW_PREFIX`)
  - `src/index.ts`: Add `activeWebStudyJids` tracking set (or generalize `activeWebReviewJids` to handle both patterns)
  - `src/index.ts`: Update `channelOpts.onMessage` to add study JIDs to tracking set
  - `src/channels/registry.ts`: Add `onStudyClosed?: (sessionId: string) => void` to `ChannelOpts` (or generalize `onDraftClosed`)
  - `src/index.ts`: Wire `onStudyClosed` in `channelOpts` to kill study container and remove from active JID set
- [ ] **S5.2** Design full study agent CLAUDE.md (`groups/study/CLAUDE.md`)
  - Method-specific instructions: Feynman (identify gaps, ask clarifying), Socratic (question assumptions, don't reveal), case analysis (multi-step framework), synthesis (cross-concept integration)
  - Brain-first rules: never lead with answers, always let student attempt first
  - Evaluation rubrics per Bloom's level
  - IPC output format: study_complete with quality + feedback
  - Session state injection pattern (concept, method, Bloom's level as context in first message)
- [ ] **S5.3** Create dashboard chat API routes
  - `POST /api/study/chat` — proxy message to web channel study endpoint
  - `GET /api/study/chat/stream/[sessionId]` — proxy SSE from web channel
- [ ] **S5.4** Create `/study/chat` page
  - Message list with SSE streaming (real-time agent responses)
  - Text input with send button
  - Session context display: current concept, method, Bloom's level
  - Method selector: Feynman, Socratic, Case Analysis, Synthesis, Free
  - Concept selector: pick concept to discuss
  - "End session" button that triggers study_close
- [ ] **S5.5** AI evaluation endpoint
  - `POST /api/study/evaluate` — sends student response + activity context to study agent
  - Study agent evaluates against vault content via RAG
  - Returns: `{ quality: number, feedback: string }`
  - Dashboard displays feedback alongside self-rating (hybrid evaluation for L2-L3)
- [ ] **S5.6** Integrate AI evaluation into `/study/session` page
  - For L3+ activities: show "AI is evaluating..." after submission
  - Display AI feedback + quality alongside student's self-rating
  - For L2-L3: show both ratings (calibration training)
  - For L4-L6: AI rating feeds SM-2 (primary)
- [ ] **S5.7** Add L3-L6 activity types to `/study/session`
  - `self_explain`: "Explain X" → large text area → AI gap analysis
  - `concept_map`: concept list → relationship builder (text-based initially)
  - `comparison`: comparison prompt → structured input → expert analysis
  - `case_analysis`: scenario → multi-step response → expert comparison
  - `synthesis`: integration prompt → essay area → AI feedback
  - `socratic`: redirects to `/study/chat` with Socratic method pre-selected
- [ ] **S5.8** Expand generator for L3-L6 activity types
  - Update generator CLAUDE.md with L3-L6 generation guidelines
  - Add activity types: self_explain, concept_map, comparison, case_analysis, synthesis, socratic
  - Update quality validation for new types
- [ ] **S5.9** Add `study_complete` and `study_concept_status` IPC handlers to `src/ipc.ts`
  - `study_complete`: process activity completion from study agent (quality, feedback, response)
  - `study_concept_status`: return concept mastery state to study agent for context
  - Needed for AI evaluation flow (study agent evaluates → reports back via IPC)
- [ ] **S5.10** Add stretch block to session builder
  - Stretch block (20%): one L5-L6 activity if concepts at bloom_ceiling 4+
  - Only included if student has eligible concepts

**Acceptance criteria:**
- Dashboard chat streams agent responses in real-time
- Feynman dialogue: student explains → agent identifies gaps → follow-up questions
- AI evaluation returns quality + feedback for L3+ activities
- All 8 activity types functional in session UI
- Transcripts saved and linked to sessions/concepts

---

### S6: Planning System

**Goal:** Collaborative study plan creation through dialogue.

**Estimated sessions:** 2

**Dependencies:** S5 (dashboard chat for plan dialogue)

**Key decisions:**
- Planning dialogue happens in dashboard chat with method="plan"
- Plan data structure stores results of dialogue — all optional fields except domain + concepts
- Quick path (30s) doesn't require chat — direct API call with defaults
- Deep path uses chat agent to guide through 5-phase framework

#### Checklist

- [ ] **S6.1** Implement `src/study/planner.ts`
  - `createQuickPlan(title, conceptIds, options?) → StudyPlan`
    - Quick path: select concepts + defaults, no dialogue needed
  - `processPlanDialogue(sessionTranscript) → PlanUpdate`
    - Extracts plan fields from dialogue transcript
    - Handles partial: only fills fields the student provided
  - Plan lifecycle: active → completed → archived
  - Checkpoint computation: next_checkpoint_at = created_at + checkpoint_interval_days
- [ ] **S6.2** Create plan API routes
  - `GET /api/study/plans` — list plans with concept counts + progress
  - `POST /api/study/plans` — create plan (quick or from dialogue)
- [ ] **S6.3** Create `/study/plan` page
  - Active plans list with progress, upcoming checkpoints
  - "New Plan" button → choice: Quick (form) or Guided (opens chat with plan mode)
  - Quick form: title, select concepts (grouped by domain), strategy, optional deadline
  - Plan detail view: concept progress within plan, checkpoint history
- [ ] **S6.4** Update study agent for plan dialogue
  - Add plan dialogue instructions to CLAUDE.md
  - 5-phase framework: Discover → Define → Design → Commit → Adapt
  - "Want to go deeper?" at natural break points
  - Output: study_plan IPC message with extracted fields
- [ ] **S6.5** Plan integration with engine
  - Session builder respects active plans: prioritize plan concepts
  - Plan concepts get target_bloom from plan (not just system default)
  - Checkpoint due → suggest plan review in daily summary

**Acceptance criteria:**
- Quick plan creation works (30-second path)
- Guided plan dialogue produces a valid plan through chat
- Plans appear on `/study/plan` with concept progress
- Session builder includes plan concepts with appropriate priority

---

### S7: Telegram + Scheduled Tasks

**Goal:** Mr. Rogers sends daily reminders, supports quick review, study system has cron tasks.

**Estimated sessions:** 2

**Dependencies:** S3 (engine), S4 (completion flow)

**Key decisions:**
- Study IPC handlers extend existing `src/ipc.ts` switch/case
- Scheduled tasks use existing task scheduler infrastructure (cron patterns)
- Mr. Rogers quick review: sends card prompt via Telegram, student responds, Telegram agent evaluates
- Telegram completion data flows through IPC to main process

#### Checklist

- [ ] **S7.1** Add remaining study IPC handlers to `src/ipc.ts`
  - `study_session`: return today's due activities (for Telegram quick review)
  - `study_generate`: trigger activity generation for concept (for Telegram-triggered generation)
  - Note: `study_generated_activities` added in S3.8, `study_complete` + `study_concept_status` added in S5.9
- [ ] **S7.2** Create `src/study/scheduled.ts`
  - `buildMorningTask() → ScheduledTaskConfig`
    - Check for generation gaps, build session, compose Telegram message
    - "Good morning! 15 activities ready (~25 min). 3 new concepts from yesterday."
  - `buildWeeklyTask() → ScheduledTaskConfig`
    - Progress summary: retention, concepts advanced, Bloom's distribution
    - Cross-domain synthesis suggestions
    - Plan checkpoint reminder
  - `buildMonthlyTask() → ScheduledTaskConfig`
    - Comprehensive mastery review, decay detection, growth trajectory
- [ ] **S7.3** Register scheduled tasks
  - Daily: morning (e.g., 07:00) via cron
  - Weekly: Sunday evening via cron
  - Monthly: 1st of month via cron
  - Registration in DB via existing `createTask()` or setup script
- [ ] **S7.4** Update Mr. Rogers for study integration
  - Update `groups/telegram_main/CLAUDE.md` with study awareness
  - Quick card review: Mr. Rogers sends card prompt, student responds, agent evaluates
  - Light elaboration: "Why does X work?" style prompts
  - Concept discovery alerts in morning message
- [ ] **S7.5** SQLite backup scheduled task
  - Daily cron: `cp store/messages.db store/backups/messages-{YYYY-MM-DD}.db`
  - Retain last 7 daily backups (rotate out older ones)
  - Lightweight — SQLite in WAL mode supports safe hot copies via `.backup` command
- [ ] **S7.6** Telegram quick review flow
  - Mr. Rogers picks 3-5 due card activities
  - Sends as individual messages: "Quick review: [prompt]"
  - Student responds in chat
  - Mr. Rogers evaluates, sends feedback, logs via study_complete IPC

**Acceptance criteria:**
- Daily Telegram message with session summary and concept alerts
- Quick card review works via Telegram (send, respond, evaluate)
- Weekly summary includes retention and progression data
- All scheduled tasks register and fire on schedule

---

### S8: Analytics + Audio + Polish

**Goal:** Feature-complete system with analytics, audio, and remaining features.

**Estimated sessions:** 2-3

**Dependencies:** S4-S7 (all core features)

#### Checklist

- [ ] **S8.1** Analytics API and dashboard
  - `GET /api/study/stats` — retention rate, calibration score, per-level mastery, time to level, method effectiveness, Bloom's distribution
  - Analytics section on `/study` page: charts, trends, method comparison
- [ ] **S8.2** Concept detail page (`/study/concepts/[id]`)
  - Bloom's level mastery breakdown (6-level bar chart)
  - Activity history for this concept
  - Method effectiveness comparison
  - Related concepts (from activity_concepts)
  - Vault source link
  - "Generate more activities" button
- [ ] **S8.3** Audio/podcast generation (`src/study/audio.ts`)
  - Script generation via generator agent
  - TTS via Mistral API (existing integration)
  - Content types: concept summary, review primer, weekly digest
  - Storage: audio files linked to concepts
- [ ] **S8.4** Telegram podcast delivery
  - Send audio via existing `sendVoice()` channel method
  - Triggered by scheduled task or on-demand
- [ ] **S8.5** Student-generated activities
  - Prompting in dashboard chat at key moments (post-struggle, post-insight)
  - `author = 'student'` in learning_activities
  - Quality refinement through chat agent
- [ ] **S8.6** Scaffolding hint system
  - 5 levels: no hints → contextual → structural → partial → worked example → full explanation
  - Adaptive: target 70-85% success rate
  - Integrated into activity UI: "Need a hint?" button
- [ ] **S8.7** Prerequisite awareness
  - Flag when concept's prerequisites have weak mastery
  - Display on session UI: "Note: prerequisite X has low mastery"
  - Non-blocking: student decides whether to proceed
- [ ] **S8.8** Staleness detection
  - Compare source_chunk_hash against current vault content
  - Flag stale activities on session UI
  - "Regenerate" button for stale activities
- [ ] **S8.9** Monthly scheduled task
  - Comprehensive mastery check across all domains
  - Decay detection: identify concepts with declining mastery evidence
  - Plan adaptation recommendation
  - Growth trajectory: Bloom's distribution over time

**Backlog (post-S8):**
- RSVP vault integration: deep-link from study activities to `/read` page (spec Phase 4)
- FSRS migration evaluation: assess whether to replace SM-2 with FSRS (spec Phase 4, data model supports it)
- Data export: Anki-compatible card export, CSV learning history export (spec Section 12)
- Offline/degraded mode: dashboard read-only without main process (spec Section 12)

**Acceptance criteria:**
- Analytics page shows meaningful learning data
- Concept detail page provides full per-concept view
- Audio generation produces listenable podcasts
- Scaffolding adapts based on success rate
- Stale activities flagged and regenerable

---

## 5. Risk Register

| Risk | Impact | Likelihood | Mitigation | Sprint |
|------|--------|------------|------------|--------|
| Web channel study sessions conflict with existing draft review sessions | High | Medium | Separate JID namespace (`web:study:` vs `web:review:`), separate SSE endpoints | S5 |
| Generator agent produces low-quality activities | Medium | High | Quality validation in generator.ts, anti-pattern rejection, iterative CLAUDE.md tuning | S3 |
| Container 30-min timeout too short for deep study sessions | Medium | Low | Timeout resets on activity (existing behavior). If needed, make configurable per-group. | S5 |
| Dashboard + main process concurrent SQLite writes | Medium | Low | WAL mode + `busy_timeout = 5000` on both processes. Two Node.js processes (Next.js + main), not two users. | S0, S1 |
| Drizzle migration breaks existing data | High | Low | Pre-migration DB backup (S0.0). Baseline migration matches current schema exactly. Test on copy first. | S0 |
| Drizzle schema drift from raw SQL in tests/scripts | Low | Medium | Grep for raw SQL after S0 completion. All DB access must go through Drizzle. | S0 |
| Container concurrency during study + generation | Low | Low | Study agent (long-lived) + generator (single-turn) + Telegram = 3 concurrent. MAX_CONCURRENT_CONTAINERS=5 has headroom. | S3, S5 |
| Mastery model parameters need tuning (threshold, decay half-life) | Low | High | All constants in `mastery.ts`, easy to adjust. Log raw data for analysis. | S1, ongoing |
| Ingestion agent doesn't produce good domain/subdomain values | Medium | Medium | Make domain/subdomain warnings (not errors) in validator. Allow null, classify at approval. | S2 |
| Session builder produces unbalanced sessions with few concepts | Low | Medium | Graceful degradation: skip blocks with no eligible activities, min 1 activity per session | S3 |
| Chat transcript storage grows large | Low | Low | Only store for AI-evaluated activities. Truncate after configurable limit. | S5 |

---

## 6. Definition of Done

A sprint is complete when:

1. All checklist items checked off
2. All new code has tests (per testing strategy: TDD for algorithms, unit for orchestration, integration for flows)
3. Existing tests still pass (`npm test`)
4. Dashboard features manually verified in browser
5. No regressions in ingestion pipeline, RAG indexing, or existing dashboard pages
6. Sub-plan document updated with any deviations from this master plan
