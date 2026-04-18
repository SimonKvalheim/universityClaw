# Study Plan System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a science-backed, adaptive study planning system with spaced repetition, a quiz module on the dashboard, and agent integration for Mr. Rogers.

**Spec:** `docs/superpowers/specs/2026-04-05-study-plan-system-design.md`

**Tech Stack:** TypeScript/Node.js (backend), Next.js (dashboard), SQLite (better-sqlite3), LightRAG (existing), Vitest (tests)

**Key architectural constraint:** The dashboard has no LLM access. Quiz questions are pre-generated during plan creation (main process). The dashboard reads from SQLite and writes completion results. Answer evaluation routes through the main process.

---

## File Structure

### Existing files to modify

- `src/db.ts` — Add study_plans, study_plan_cards, sr_cards, sr_review_log tables + CRUD functions
- `src/types.ts` — Add study-related interfaces
- `src/ipc.ts` — Add `study_complete` and `study_session` IPC task types
- `dashboard/src/app/layout.tsx` — Add "Study" nav link
- `dashboard/src/app/read/page.tsx` — Enable "From Vault" tab
- `groups/telegram_main/CLAUDE.md` — Add study plan + Feynman instructions for Mr. Rogers

### New files to create

**Study Engine (backend):**
- `src/study/sm2.ts` — SM-2 spaced repetition algorithm (pure functions)
- `src/study/sm2.test.ts` — SM-2 tests
- `src/study/engine.ts` — Plan generation, session management, completion tracking
- `src/study/engine.test.ts` — Engine tests
- `src/study/index.ts` — Public exports

**Dashboard DB Layer:**
- `dashboard/src/lib/study-db.ts` — Dashboard-side DB access for study tables

**Dashboard API Routes (5 MVP routes):**
- `dashboard/src/app/api/study/plans/route.ts` — GET (list), POST (trigger generation)
- `dashboard/src/app/api/study/session/route.ts` — GET (today's due cards)
- `dashboard/src/app/api/study/complete/route.ts` — POST (mark card complete)
- `dashboard/src/app/api/study/stats/route.ts` — GET (progress metrics)

**Dashboard Pages:**
- `dashboard/src/app/study/page.tsx` — Study plan dashboard
- `dashboard/src/app/study/quiz/page.tsx` — Quiz module

---

## Open Questions (Resolve During Implementation)

1. **Website quiz evaluation** — Pre-generated questions are stored in `sr_cards.front/back`. When the student types a free-text answer on the website, who evaluates it? Options:
   - **Self-rated (simpler):** Show the reference answer from `sr_cards.back`, student rates themselves 0-5. Works today, no proxy needed.
   - **AI-evaluated (richer):** Dashboard posts answer to main process via internal HTTP endpoint, main process evaluates via Claude + RAG, returns feedback. Needs a new endpoint in the main process.
   - Recommendation: Start self-rated, add AI evaluation as a follow-up.

2. **Plan regeneration on new content** — When new vault notes are ingested (new lecture slides, new articles), should existing plans auto-update with new cards? Or does the student regenerate manually? Likely manual — auto-updating plans mid-study would mess with spacing.

3. **Card staleness** — Pre-generated questions can go stale if the underlying vault note is edited. No refresh mechanism currently. Options: flag cards whose vault_path has a newer mtime than the card's created_at, or regenerate on demand.

---

## Phase 1: Data Model + SM-2 Engine

### Step 1: Add study types to `src/types.ts`

- [ ] Add `StudyPlan` interface (id, title, course, strategy, config, status, timestamps)
- [ ] Add `SRCard` interface (id, topic, course, vault_path, card_type, front, back, ease_factor, interval_days, repetitions, due_at, last_reviewed, last_quality, mastery_state)
- [ ] Add `SRReviewLog` interface (id, card_id, quality, response_time_ms, ease_factor, interval_days, reviewed_at)
- [ ] Add `StudyStrategy` type: `'exam-prep' | 'weekly-review'`
- [ ] Add `CardType` type: `'recall' | 'cloze' | 'explain'`
- [ ] Add `MasteryState` type: `'new' | 'learning' | 'reviewing' | 'mastered'`

### Step 2: Add study tables to `src/db.ts`

- [ ] Add `study_plans` table to `createSchema()` (see spec for full schema)
- [ ] Add `study_plan_cards` join table (plan_id, card_id, sort_order)
- [ ] Add `sr_cards` table with indexes on due_at and course
- [ ] Add `sr_review_log` table with index on card_id
- [ ] Add CRUD functions: `createStudyPlan()`, `getStudyPlan()`, `getAllStudyPlans()`, `updateStudyPlan()`
- [ ] Add CRUD functions: `createSRCard()`, `getSRCard()`, `getDueSRCards()`, `updateSRCard()`
- [ ] Add functions: `addCardToPlan()`, `getCardsByPlan()`
- [ ] Add functions: `createSRReviewLog()`, `getReviewLogByCard()`
- [ ] Add function: `getStudyStats()` — mastery %, streak, forecast

### Step 3: Create `src/study/sm2.ts`

- [ ] Define `SM2Input` and `SM2Output` interfaces
- [ ] Implement `calculateSM2(input: SM2Input): SM2Output` pure function
- [ ] Implement `getNextDueDate(interval: number, fromDate?: Date): string` helper
- [ ] Implement `updateMasteryState(repetitions: number, interval: number, easeFactor: number, quality: number, currentState: MasteryState): MasteryState`
- [ ] Export all functions (follow RSVP pure-function pattern)

### Step 4: Create `src/study/engine.ts`

- [ ] Implement `generateStudyPlan(options)` — queries RAG + knowledge map, generates cards via Claude, creates plan with cards linked via study_plan_cards
- [ ] Implement `getTodaySession(limit?)` — returns due cards sorted by priority (overdue first, low EF, type variety)
- [ ] Implement `completeCard(cardId, result)` — runs SM-2, updates card, logs review, updates knowledge map
- [ ] Implement `evaluateAnswer(cardId, studentAnswer)` — uses RAG + Claude to evaluate, returns feedback
- [ ] Implement `getStudyStats()` — mastery %, streak, review forecast

### Step 5: Create `src/study/index.ts`

- [ ] Re-export public API from sm2.ts and engine.ts

### Step 6: Write Phase 1 tests

- [ ] `src/study/sm2.test.ts` — test SM-2 calculations: quality 0-5, EF floor at 1.3, interval progression (1→6→EF*I), mastery state transitions
- [ ] `src/study/engine.test.ts` — test session queries, completion flow, stats computation (mock RAG for plan generation)
- [ ] Test DB operations via `_initTestDatabase()`: create plan → add cards → link → complete → verify SR updates

---

## Phase 2: Dashboard — Study Plan Page + Quiz

### Step 7: Add Study nav link

- [ ] Add `<a href="/study" ...>Study</a>` to `dashboard/src/app/layout.tsx` nav (between Vault and Read)

### Step 8: Create dashboard DB layer

- [ ] Create `dashboard/src/lib/study-db.ts` following `ingestion-db.ts` pattern
- [ ] Add camelCase interfaces: `StudyPlanSummary`, `SRCardSummary`, `StudyStats`
- [ ] Add row mapper functions: `rowToPlan()`, `rowToCard()`
- [ ] Add query functions: `getPlans()`, `getDueCards()`, `getStats()`, `getCardsByPlan()`

### Step 9: Create API routes (5 MVP routes)

- [ ] `GET /api/study/plans` — list plans with card counts + progress (% mastered/reviewing)
- [ ] `POST /api/study/plans` — trigger plan generation (calls main process study engine)
- [ ] `GET /api/study/session` — today's due cards across all plans
- [ ] `POST /api/study/complete` — mark card complete with quality (0-5) + optional response_time_ms
- [ ] `GET /api/study/stats` — mastery %, streak, review forecast

### Step 10: Build study plan page

- [ ] Create `dashboard/src/app/study/page.tsx` — `'use client'`
- [ ] Today's Session section: cards for each due card with type badge, topic, course, link to quiz
- [ ] Active Plans section: plan cards with progress bar, due count, course tag
- [ ] Generate Plan form: course dropdown (from knowledge map courses), strategy selector (exam-prep / weekly), optional focus topics, exam date picker (for exam-prep)
- [ ] Progress section: mastery %, streak, cards due this week
- [ ] Follow existing dark theme styling (`bg-gray-900`, `border-gray-800`, etc.)

### Step 11: Build quiz module page

- [ ] Create `dashboard/src/app/study/quiz/page.tsx` — `'use client'`
- [ ] Accept `?card=<id>` or `?plan=<id>` query params
- [ ] Show question from `sr_cards.front` with topic and course context
- [ ] Text area for free-form answer (brain-first: no hints visible)
- [ ] Submit → POST to `/api/study/complete` → show reference answer from `sr_cards.back` + feedback
- [ ] Post-answer quality rating (0-5, auto-suggested, overridable)
- [ ] Batch flow: next card button, session summary at end (score, weak areas)

---

## Phase 3: RSVP Vault Integration

### Step 12: Enable vault tab on `/read`

- [ ] Wire up the disabled "From Vault" tab in `dashboard/src/app/read/page.tsx`
- [ ] Add vault note search/browse (call `/api/vault?path=concepts/` for listing)
- [ ] Select note → strip frontmatter → feed content to RSVP engine
- [ ] Support `?vault_path=` query param for deep linking from study cards

---

## Phase 4: Agent Integration

### Step 13: Add study IPC task types to `src/ipc.ts`

- [ ] Add `study_complete` handler: reads `{ cardId, quality, responseTimeMs? }`, calls `completeCard()`
- [ ] Add `study_session` handler: reads `{ limit? }`, calls `getTodaySession()`, writes result to response file
- [ ] Follow existing IPC switch/case pattern in `processIpcTask()`

### Step 14: Add daily study reminder

- [ ] Create scheduled task in `groups/telegram_main/` config
- [ ] Task queries due cards, formats a summary message with counts by course
- [ ] Includes dashboard link and offer to run a quick quiz in chat

### Step 15: Update Mr. Rogers instructions

- [ ] Add study plan section to `groups/telegram_main/CLAUDE.md`
- [ ] "What should I study?" → write IPC `study_session`, report due cards + weak areas from knowledge map
- [ ] After in-chat quiz: write IPC `study_complete` with quality rating
- [ ] Feynman technique: when a concept has low mastery (quality <= 3 after multiple attempts), suggest "explain this concept to me" exercises. Evaluate explanation against vault content via RAG, identify gaps, iterate
- [ ] Brain-first principle: always ask question → wait for answer → evaluate

---

## Verification

After each phase, run:
```bash
npm test                    # Backend tests pass
npm run build              # TypeScript compiles
cd dashboard && npm run dev # Dashboard renders correctly
```

End-to-end flow after all phases:
1. Generate a study plan from `/study` page
2. Complete quiz cards → verify SR intervals update correctly
3. Mastery states transition: new → learning → reviewing → mastered
4. Load vault note in RSVP via "From Vault" tab
5. Ask Mr. Rogers "what should I study?" → get due cards
6. Mr. Rogers in-chat quiz → results update SR cards via IPC
7. Next day: verify spaced cards appear at correct intervals
