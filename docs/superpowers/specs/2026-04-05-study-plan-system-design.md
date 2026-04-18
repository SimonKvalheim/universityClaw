# Study Plan System — Design Spec

Personal, adaptive study planning system for universityClaw. Generates science-backed study plans, tracks progress with spaced repetition, and provides interactive learning modules on the web dashboard alongside Telegram-based study sessions with Mr. Rogers.

This spec addresses Non-Goal #1 from the original design spec: "Personalized revision/teaching plan — Auto-generated study plans with summaries, Q&A, quizzes based on current relevance (upcoming exams, weak areas, course progression). Needs its own design cycle for scheduling, spaced repetition, and adaptive difficulty."

---

## Research Foundation

### Vault-Grounded Principles

The Obsidian vault contains extensive research on learning science that directly informs this design. The system must embody these findings rather than contradict them.

**Cognitive Load Theory (Kirschner 2002, van Merrienboer & Sweller 2005):**
- Three load types: intrinsic (element interactivity), extraneous (bad design), germane (productive schema-building)
- *Isolated-to-interacting element progression* — start with sub-concepts before requiring integration. Block new material, then interleave for review
- *Adaptive eLearning* — two-step cycle: assess expertise, then dynamically select next task

**Multimedia Learning (Mayer 2002):**
- *Personalization effect* — conversational style produces the largest effect size (1.55) of all multimedia effects. Mr. Rogers' persona is pedagogically grounded, not just branding
- *Cognitive vs. behavioral activity* — cognitive activity (selecting, organizing, integrating) causes meaningful learning, not busywork. Every study activity must demand genuine thinking
- *Rote vs. meaningful learning* — rote = good retention, poor transfer; meaningful = good both. Transfer tests (apply knowledge to new situations) are the gold standard

**Cognitive Debt from AI Use (Kosmyna et al. 2025 "Your Brain on ChatGPT"):**
- Habitual AI use causes cumulative cognitive cost — deep encoding and critical evaluation both bypassed
- 83.3% of LLM users failed to provide correct quotation from their own AI-assisted essay
- **Design rule: Brain-first, AI-second.** The student must always attempt an answer before the AI provides feedback. Never show the answer first

**Constructivism (Olusegun 2015):**
- Learners build on prior knowledge; learning is active, not passive
- The system must connect new concepts to existing knowledge structures

### Evidence-Based Technique Ratings (Dunlosky et al. 2013)

| Utility | Technique | System Implementation |
|---------|-----------|----------------------|
| **High** | Practice testing / retrieval practice | Quiz module — AI-generated questions from vault, free-recall format |
| **High** | Distributed / spaced practice | SM-2 scheduling engine with expanding intervals |
| **Moderate** | Elaborative interrogation | "Why does this work?" prompts mixed into quiz questions |
| **Moderate** | Self-explanation | Feynman-style exercises via Mr. Rogers in Telegram (not a separate dashboard module) |
| **Moderate** | Interleaved practice | Session engine mixes topics across courses during review |
| **Low** | Summarization | Not used as a primary study mode |
| **Low** | Highlighting / rereading | Never presented as study activities |

### Additional Research Informing Design

- **Active recall:** Repeated retrieval produces 400% improvement in long-term retention (Karpicke 2012). Open-ended "explain" questions produce stronger effects than recognition-based formats
- **Interleaving:** Increases cognitive load during training but improves retention and transfer. Default for review sessions; block new material first, then interleave once first successful recall is achieved
- **Session length:** 25-50 minute focused blocks are optimal. 10-20% of desired retention interval = optimal spacing gap (Cepeda et al. 2008)

---

## Architecture

### LLM Access Pattern

The dashboard is a thin UI over SQLite — it has no Anthropic API key and cannot call Claude directly. All LLM work (quiz generation, answer evaluation) happens in the **main NanoClaw process**, which has access to RAG and the Anthropic SDK via OneCLI. The dashboard reads pre-generated data from the database.

**Quiz flow:**
1. Plan generation (main process) creates SR cards with pre-generated questions via RAG + Claude
2. Dashboard reads cards from SQLite and presents them
3. Student answers; dashboard posts the answer to `/api/study/complete`
4. Main process evaluates the answer via Claude + RAG (triggered by an internal HTTP endpoint or IPC)
5. Dashboard polls for the evaluation result

This matches the existing architecture where the dashboard only does SQLite reads/writes and the main process handles all LLM interaction.

```
                    ┌─────────────────────────────────────┐
                    │        Dashboard (Next.js)          │
                    │                                     │
                    │  /study ─── Active Plans + Session  │
                    │  /study/quiz ─── Quiz Module        │
                    │  /read ─── RSVP Reader (+ vault)    │
                    │                                     │
                    │  /api/study/* ─── Study API Routes  │
                    │        (SQLite reads only)          │
                    └──────────────┬──────────────────────┘
                                   │ HTTP
                    ┌──────────────▼──────────────────────┐
                    │     Main Process (src/study/)       │
                    │                                     │
                    │  engine.ts ─── Plan generation,     │
                    │                card creation,       │
                    │                answer evaluation    │
                    │  sm2.ts ───── Spaced repetition     │
                    │                                     │
                    │  Uses:                              │
                    │  ├── RagClient (hybrid retrieval)   │
                    │  ├── StudentProfile (knowledge map) │
                    │  ├── VaultUtility (note access)     │
                    │  └── SQLite (study tables)          │
                    └──────────────┬──────────────────────┘
                                   │ IPC (JSON file drop)
                    ┌──────────────▼──────────────────────┐
                    │        Mr. Rogers (Agent)           │
                    │                                     │
                    │  Daily reminders via scheduled task │
                    │  In-chat quiz/Q&A + Feynman         │
                    │  Results written back via IPC        │
                    └─────────────────────────────────────┘
```

---

## Data Model

### New SQLite Tables (added to `src/db.ts` via `createSchema()`)

The original design had separate `study_items` and `sr_cards` tables, but these are redundant — both track concepts with difficulty, due dates, and review outcomes. A study plan simply references a set of cards via a join table.

```sql
-- A study plan: generated per course or cross-course
CREATE TABLE IF NOT EXISTS study_plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  course TEXT,                     -- NULL for cross-course plans
  strategy TEXT NOT NULL,          -- 'exam-prep' | 'weekly-review'
  config TEXT,                     -- JSON: exam_date, session_length_min, etc.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT DEFAULT 'active'     -- 'active' | 'completed' | 'archived'
);

-- Join table: which cards belong to which plan
CREATE TABLE IF NOT EXISTS study_plan_cards (
  plan_id TEXT NOT NULL REFERENCES study_plans(id),
  card_id TEXT NOT NULL REFERENCES sr_cards(id),
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (plan_id, card_id)
);

-- Spaced repetition cards per concept (SM-2)
CREATE TABLE IF NOT EXISTS sr_cards (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  course TEXT,
  vault_path TEXT,                 -- source note
  card_type TEXT DEFAULT 'recall', -- 'recall' | 'cloze' | 'explain'
  front TEXT NOT NULL,             -- question / prompt
  back TEXT NOT NULL,              -- answer / expected explanation points
  ease_factor REAL DEFAULT 2.5,   -- SM-2 ease factor (min 1.3)
  interval_days INTEGER DEFAULT 1,
  repetitions INTEGER DEFAULT 0,
  due_at TEXT NOT NULL,
  last_reviewed TEXT,
  last_quality INTEGER,            -- 0-5 SM-2 quality rating
  mastery_state TEXT DEFAULT 'new' -- 'new' | 'learning' | 'reviewing' | 'mastered'
);
CREATE INDEX IF NOT EXISTS idx_sr_cards_due ON sr_cards(due_at);
CREATE INDEX IF NOT EXISTS idx_sr_cards_course ON sr_cards(course);

-- Review history for analytics (granular enough for future FSRS migration)
CREATE TABLE IF NOT EXISTS sr_review_log (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES sr_cards(id),
  quality INTEGER NOT NULL,        -- 0-5 SM-2 grade
  response_time_ms INTEGER,        -- time to answer (retrieval fluency proxy)
  ease_factor REAL NOT NULL,       -- EF after this review
  interval_days INTEGER NOT NULL,  -- interval after this review
  reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sr_review_log_card ON sr_review_log(card_id);
```

### Mastery State Machine

```
new → learning → reviewing → mastered
       ↑            │
       └────────────┘  (lapse: quality < 3 resets to learning)
```

- **new**: Never reviewed. Initial state.
- **learning**: Fewer than 3 consecutive correct recalls (quality >= 3)
- **reviewing**: 3+ consecutive correct recalls with expanding intervals
- **mastered**: interval >= 21 days AND ease_factor >= 2.3 AND 5+ consecutive correct recalls

---

## SM-2 Algorithm (`src/study/sm2.ts`)

Pure function, ~50 lines. Export as standalone functions for testability (same pattern as RSVP engine).

```typescript
interface SM2Input {
  quality: number;       // 0-5 (0=blackout, 5=perfect)
  easeFactor: number;    // current EF, default 2.5
  interval: number;      // current interval in days
  repetitions: number;   // consecutive correct recalls
}

interface SM2Output {
  easeFactor: number;    // updated EF (min 1.3)
  interval: number;      // next interval in days
  repetitions: number;   // updated repetition count
}

// Core formula:
// If quality >= 3 (correct):
//   rep 0: interval = 1
//   rep 1: interval = 6
//   rep 2+: interval = round(interval * EF)
//   repetitions += 1
// If quality < 3 (incorrect):
//   repetitions = 0, interval = 1
//
// EF = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
// EF = max(EF, 1.3)
```

---

## Study Engine (`src/study/engine.ts`)

Core orchestrator. Exported standalone functions (not a class) following `src/db.ts` pattern.

### Plan Generation

```typescript
generateStudyPlan(options: {
  title: string;
  course?: string;           // NULL for cross-course
  strategy: 'exam-prep' | 'weekly-review';
  focusTopics?: string[];    // optional topic filter
  examDate?: string;         // ISO date — for exam-prep strategy
  sessionLengthMin?: number; // default 30
}): Promise<StudyPlan>
```

**Process:**
1. Query knowledge map for topics in the course + their confidence scores
2. Query RAG for vault content related to those topics
3. Prioritize weak areas (low confidence) and unreviewed topics
4. Apply isolated-to-interacting progression: simple sub-concepts before integration topics
5. Generate SR cards (front/back) via Claude + RAG for each topic
6. Assign card types based on confidence level:
   - Confidence 1-2: `recall` (basic questions, read vault note first)
   - Confidence 3: `recall` + `cloze` (deeper questions with "why" prompts)
   - Confidence 4-5: `explain` (Feynman-style, interleaved with other topics)
7. Schedule cards using the 10-20% rule relative to exam date or weekly cadence
8. Store cards in `sr_cards`, link to plan via `study_plan_cards`

### Session Queries

```typescript
getTodaySession(limit?: number): Promise<SRCard[]>
```

Returns due cards across all active plans, sorted by:
1. Overdue cards first
2. Low ease-factor cards (struggling concepts)
3. Card type variety (don't cluster all recall together)

### Completion Tracking

```typescript
completeCard(cardId: string, result: {
  quality: number;       // 0-5
  responseTimeMs?: number;
}): Promise<SRCard>
```

1. Run SM-2 algorithm, update card (ease_factor, interval, repetitions, due_at)
2. Update mastery_state based on state machine
3. Log to sr_review_log
4. Update knowledge map via StudentProfile.updateKnowledgeMap()
5. Return updated card

### Answer Evaluation

```typescript
evaluateAnswer(cardId: string, studentAnswer: string): Promise<Evaluation>
```

Uses RAG to retrieve vault context for the card's topic, then Claude evaluates:
- Correctness (grounded in vault content)
- Suggested quality rating (0-5)
- Feedback with specific gaps
- Vault note references

This runs in the main process (has Claude access), not in the dashboard.

---

## Dashboard Modules

### Navigation

Add "Study" link to `dashboard/src/app/layout.tsx` nav bar, between "Vault" and "Read".

### 1. Study Plan Page (`/study`)

**Route:** `dashboard/src/app/study/page.tsx` — `'use client'`

**Layout:**
```
┌─────────────────────────────────────┐
│  Today's Session (N cards due)      │
│  ┌───────┐ ┌───────┐ ┌───────┐     │
│  │recall │ │explain│ │ cloze │     │
│  │BI-2081│ │TIØ4258│ │BI-2081│     │
│  │ due!  │ │ +2d   │ │ new   │     │
│  └───────┘ └───────┘ └───────┘     │
├─────────────────────────────────────┤
│  Active Plans                       │
│  ┌─────────────────────────────┐    │
│  │ BI-2081 Exam Prep           │    │
│  │ ████████░░ 72%  │  12 due   │    │
│  └─────────────────────────────┘    │
├─────────────────────────────────────┤
│  + Generate New Plan                │
│  Course: [dropdown]                 │
│  Strategy: [exam-prep | weekly]     │
│  Focus: [optional topics]           │
│  Exam date: [date picker]           │
│  [Generate]                         │
├─────────────────────────────────────┤
│  Progress                           │
│  Mastery: ██████░░ 65%              │
│  Streak: 5 days                     │
│  Cards due this week: 23            │
└─────────────────────────────────────┘
```

**Progress section metrics:**
- *Mastery*: % of reviewed concepts in "reviewing" or "mastered" state
- *Streak*: consecutive days with at least one completed review
- *Review forecast*: cards due in the next 7 days

### 2. Quiz Module (`/study/quiz`)

**Route:** `dashboard/src/app/study/quiz/page.tsx` — `'use client'`

**Query param:** `?card=<card_id>` or `?plan=<plan_id>` for a batch session.

**Flow (brain-first, AI-second):**
1. Show question (pre-generated, stored in `sr_cards.front`)
2. Text area for student's answer — no hints, no multiple choice
3. Student submits answer
4. Dashboard posts answer to `/api/study/evaluate` which proxies to main process
5. Show evaluation result:
   - Correctness assessment with specific feedback
   - The reference answer (from `sr_cards.back` + vault sources)
   - Vault note links for further reading
6. **Post-answer quality rating:** 0-5 (SM-2 scale), auto-suggested based on evaluation but student can override
7. SR card updated, review logged
8. Next card or session summary

**Batch mode:** 5-10 cards per session. Summary at the end shows score and weak areas.

### 3. RSVP Vault Integration (existing `/read`)

**Changes to `dashboard/src/app/read/page.tsx`:**

1. **Enable "From Vault" tab** — Currently disabled. Wire up:
   - Search vault notes via `/api/vault?path=concepts/` (list) and search
   - Select a note → load its markdown content (strip frontmatter)
   - Feed content to the existing RSVP engine
2. **Study item linking** — Cards with vault_path link to `/read?vault_path=...` for pre-study reading

Post-reading comprehension checks are deferred — they couple two unrelated features (speed reading and quizzing). If you want to quiz after reading, navigate to `/study/quiz`.

---

## API Routes

All under `dashboard/src/app/api/study/`. Follow existing patterns: `Response.json()`, try/catch, camelCase interfaces.

MVP routes (5 total):

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/study/plans` | GET | List all study plans (with card counts + progress) |
| `/api/study/plans` | POST | Trigger plan generation (posts to main process, returns plan ID) |
| `/api/study/session` | GET | Today's due cards across all plans |
| `/api/study/complete` | POST | Mark card complete with quality + response time |
| `/api/study/stats` | GET | Progress metrics: mastery %, streak, forecast |

Deferred routes (add when needed):
- `GET /api/study/plans/[id]` — plan detail
- `PATCH /api/study/plans/[id]` — update plan status
- `GET /api/study/cards` — filtered card listing
- `POST /api/study/evaluate` — proxy answer evaluation to main process

### Dashboard DB Layer

New file: `dashboard/src/lib/study-db.ts` — lazy singleton DB connection (same pattern as `ingestion-db.ts`). camelCase interfaces for API responses. Reads from the same `store/messages.db`.

---

## Agent Integration (Mr. Rogers)

### IPC Task Contract

The container agent communicates via JSON file drops in `data/ipc/{group_folder}/`. New task types:

```typescript
// Agent → Main: mark a card complete after in-chat quiz
{ type: 'study_complete', cardId: string, quality: number, responseTimeMs?: number }

// Agent → Main: request today's due cards (response written to result file)
{ type: 'study_session', limit?: number }
```

These follow the existing IPC pattern in `src/ipc.ts` — the agent writes a JSON file, the IPC watcher processes it, and writes a response file if needed.

### Scheduled Study Reminders

Add a daily scheduled task in `groups/telegram_main/` that:
1. Queries `sr_cards` for cards due today
2. Sends a Telegram message with counts by course
3. Includes a direct link to the dashboard `/study` page
4. If user replies, Mr. Rogers can run quiz sessions directly in chat

### In-Chat Study Sessions

Mr. Rogers already has quiz and Q&A capabilities. Update `groups/telegram_main/CLAUDE.md` to:
- After quiz sessions, write results back via IPC `study_complete` to update SR cards
- When user asks "what should I study?", query due cards via IPC `study_session`
- Support Feynman-style "explain this concept" exercises natively in chat (the conversational format is better suited for iterative explain-feedback than a dashboard form)
- Use the brain-first principle: always ask the question, wait for answer, then evaluate

### Feynman Technique — Agent-Native

The Feynman technique (explain a concept simply, get feedback on gaps) is inherently conversational. Rather than building a separate dashboard module, Mr. Rogers handles this natively:
1. Student says "let me explain [concept]" or agent suggests it for low-mastery topics
2. Agent asks the student to explain
3. Student explains
4. Agent evaluates against vault content via RAG, identifies gaps
5. Iterative refinement until the explanation is solid
6. Agent writes quality rating back via IPC `study_complete`

This leverages Mr. Rogers' existing Q&A infrastructure and the personalization effect (Mayer).

---

## Existing Code to Reuse

| Module | What to Use |
|--------|-------------|
| `src/rag/rag-client.ts` | `query()` with hybrid mode for finding vault content to generate questions |
| `src/profile/student-profile.ts` | `logStudySession()`, `updateKnowledgeMap()` for tracking |
| `src/vault/vault-utility.ts` | `readNote()`, `listNotes()`, `searchNotes()` for vault access |
| `src/db.ts` | Schema pattern, migration pattern (ALTER TABLE in try/catch), `_initTestDatabase()` |
| `dashboard/src/lib/ingestion-db.ts` | Pattern for dashboard-side DB access (lazy singleton, camelCase interfaces) |
| `dashboard/src/app/read/useRSVPEngine.ts` | Pure function export pattern for testable logic |

---

## Implementation Phases

### Phase 1: Data Model + SM-2 Engine
1. Add study types to `src/types.ts`
2. Add study tables to `src/db.ts` schema (study_plans, study_plan_cards, sr_cards, sr_review_log)
3. Add DB CRUD functions to `src/db.ts`
4. Create `src/study/sm2.ts` — pure SM-2 algorithm
5. Create `src/study/engine.ts` — plan generation, session queries, completion tracking, answer evaluation
6. Create `src/study/index.ts` — public exports
7. Write tests for SM-2, engine, and DB operations

### Phase 2: Dashboard — Study Plan Page + Quiz
8. Add "Study" nav link to `dashboard/src/app/layout.tsx`
9. Create `dashboard/src/lib/study-db.ts` — dashboard DB layer
10. Create 5 MVP API routes (plans GET/POST, session GET, complete POST, stats GET)
11. Build study plan page (`/study`) with active plans, today's session, generate form, progress
12. Build quiz module page (`/study/quiz`) with brain-first flow

### Phase 3: RSVP Vault Integration
13. Enable "From Vault" tab on `/read` — search and load vault notes
14. Support `?vault_path=` deep linking from study cards

### Phase 4: Agent Integration
15. Add `study_complete` and `study_session` IPC task types to `src/ipc.ts`
16. Add daily study reminder scheduled task
17. Update Mr. Rogers' `CLAUDE.md` with study plan + Feynman instructions
18. Wire quiz completions from Telegram back to SR tracking

---

## Key Design Decisions

1. **SM-2, not FSRS.** SM-2 is simple, proven, and ~50 lines. The `sr_review_log` table stores granular data should FSRS ever become worthwhile, but we do not design around it.

2. **Brain-first, AI-second.** Grounded in Kosmyna (2025) cognitive debt research. Every module requires the student to produce an answer before showing AI feedback. No passive flashcard flipping.

3. **One card table, not two.** Plans reference cards via a join table (`study_plan_cards`). Cards are the canonical review unit. No dual-write between "items" and "cards."

4. **Interleave by default, block for new material.** New concepts get focused study until first successful recall, then get mixed into interleaved review sessions.

5. **Dashboard reads, main process writes.** The dashboard has no LLM access. Quiz questions are pre-generated during plan creation. Answer evaluation routes through the main process.

6. **Feynman via Telegram, not dashboard.** The conversational format is better suited for iterative explain-feedback. Mr. Rogers already has the infrastructure.

7. **Two strategies for MVP.** `exam-prep` (deadline-driven spacing) and `weekly-review` (rolling review). `deep-dive` and `project` are YAGNI.

8. **Transfer tests, not just recall.** Following Mayer: meaningful learning = good retention AND good transfer. Quiz questions should include application/analysis questions, not just "what is X?" definitions.

---

## Deferred Features

These are explicitly out of scope for the initial build but may be revisited:

- **Pre-answer confidence tracking / calibration** — Adds friction per-answer. Needs 30+ samples per topic for meaningful correlation. Add once core flow is proven and engagement is consistent.
- **Dashboard Feynman module** — Mr. Rogers handles this better via Telegram conversation.
- **RSVP post-reading comprehension check** — Couples two unrelated features. Quiz after reading by navigating to `/study/quiz`.
- **FSRS algorithm** — Review log data is stored for this, but do not design around it.
- **`deep-dive` and `project` strategies** — No concrete use case yet.
- **Cognitive efficiency E=P/R** — Requires population normalization (n=1 makes z-scores meaningless). SM-2 quality ratings capture difficulty progression adequately.

---

## Verification Checklist

- [ ] `npm test` — SM-2 algorithm, engine plan generation, DB operations all pass
- [ ] `npm run build` — TypeScript compiles without errors
- [ ] `cd dashboard && npm run dev` — navigate to `/study`, generate a plan
- [ ] Generate a plan → complete quiz cards → verify SR intervals update correctly
- [ ] Mastery states transition correctly: new → learning → reviewing → mastered
- [ ] RSVP: load a vault note via "From Vault" tab
- [ ] Mr. Rogers: "what should I study?" returns due cards
- [ ] Mr. Rogers: in-chat quiz results update SR cards via IPC
- [ ] Daily reminder scheduled task fires and lists due cards

---

## Sources

### From Vault
- Kirschner (2002) — Cognitive Load Theory implications for instructional design
- van Merrienboer & Sweller (2005) — CLT and complex learning, adaptive eLearning
- Mayer (2002) — Cognitive Theory of Multimedia Learning, personalization effect
- Kosmyna et al. (2025) — Cognitive debt from AI use, brain-first principle
- Olusegun (2015) — Constructivism learning theory
- Cowan (2014) — Working memory and education
- Wang et al. (2024) — AI in education systematic review, ITS architecture
- Rayner et al. (2016) — Speed reading evidence

### External Research
- Dunlosky et al. (2013) — Study technique utility meta-analysis ([SAGE](https://journals.sagepub.com/doi/abs/10.1177/1529100612453266))
- Karpicke (2012) — Active retrieval practice, 400% retention improvement ([Purdue](https://learninglab.psych.purdue.edu/downloads/2012/2012_Karpicke_CDPS.pdf))
- Wozniak (1987) — SM-2 algorithm ([SuperMemo](https://en.wikipedia.org/wiki/SuperMemo))
- Cepeda et al. (2008) — Optimal spacing intervals, 10-20% rule ([UCSD](https://laplab.ucsd.edu/articles/Cepeda%20et%20al%202008_psychsci.pdf))
- Ebersbach (2020) — Generating questions vs. testing vs. restudying
- Firth (2021) — Systematic review of interleaving effects
- Bjork & Bjork (2019) — Interleaving vs. blocking myths ([UCLA](https://bjorklab.psych.ucla.edu/wp-content/uploads/sites/13/2020/01/BjorkBjorkEducatinMythChapterPublishedFormSept2019.pdf))
- LPITutor (2024) — LLM-based personalized ITS using RAG ([PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC12453719/))
