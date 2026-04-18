# UniClaw AI Tutoring System — Research & Architecture Analysis

**Date:** 2026-04-10
**Purpose:** Ground-up reevaluation of how NanoClaw can become a personal AI tutor with progressive, science-backed learning.

---

## Part 1: NanoClaw Architecture — What We Have

### 1.1 Core Message Flow

NanoClaw is a single Node.js process that orchestrates message-driven AI agents running in isolated containers.

```
Channel receives message
  → storeMessage() to SQLite
  → startMessageLoop() polls every 2s
  → Trigger check (e.g. "@Andy" for non-main groups)
  → GroupQueue dispatches to runContainerAgent()
  → Claude Agent SDK executes inside Docker container
  → Streaming output parsed via sentinel markers
  → Response sent back through channel
  → Per-group cursor updated
```

**Key property:** Every interaction is message-driven. The system doesn't distinguish between "a student asking a question" and "a scheduled task firing." Both become container invocations with prompts.

### 1.2 Channel System

Channels self-register at startup via a factory pattern. Available channels:
- **Telegram** — Primary student-facing channel (Mr. Rogers persona)
- **WhatsApp** — Legacy support
- **Discord / Slack** — Group channels
- **Web** — HTTP + SSE for dashboard draft review (port 3200)
- **Email** — MCP integration

Each channel implements: `connect()`, `sendMessage()`, `ownsJid()`, `isConnected()`, with optional `setTyping()`, `syncGroups()`, `sendVoice()`.

**Tutoring relevance:** Telegram is the primary conversational tutoring channel. The web channel enables the dashboard quiz/study interface. Both can coexist.

### 1.3 Agent Containers & Isolation

Each group gets its own isolated container with:
- **Read-only** project root (prevents code modification)
- **Read-write** group folder (per-group state, CLAUDE.md)
- **Read-only** global shared memory
- **Per-group** `.claude/` session directory
- **Per-group** IPC namespace

Security: OneCLI gateway intercepts HTTPS and injects API keys — containers never see secrets directly. `.env` is shadowed with `/dev/null`.

**Three agent personas exist:**
| Agent | Group | Role |
|-------|-------|------|
| Mr. Rogers | `telegram_main` | Student-facing teaching assistant |
| Chef Brockett | `review_agent` | Document ingestion & note generation |
| Main | `main` | Admin control with elevated privileges |

### 1.4 Task Scheduler

Supports three schedule types: **cron**, **interval**, and **once**. Scheduler polls every 60 seconds, dispatches due tasks to GroupQueue just like messages. Tasks can run in **isolated** (fresh session) or **group** (shared context) mode.

**Tutoring relevance:** This is the engine for daily reminders, weekly reviews, monthly assessments. Tasks can trigger container agents with specific prompts on schedule.

### 1.5 IPC System

File-based inter-process communication. Containers write JSON files to `/workspace/ipc/`, the main process polls and processes them. Supports:
- **Messages** — Send text/voice to any channel
- **Tasks** — Create/pause/cancel scheduled tasks
- **Group management** — Register new groups, sync metadata

Authorization: Main group can send anywhere; subgroups restricted to their own JID.

**Tutoring relevance:** IPC is how the study system communicates between dashboard, agent, and scheduler. Study completion events, quiz results, and card updates all flow through IPC.

### 1.6 RAG System (LightRAG)

- **RagClient** — HTTP client to LightRAG server (port 9621)
- **RagIndexer** — Watches vault directories, indexes with content-hash deduplication
- **Indexed paths:** `concepts/`, `sources/`, `profile/archive/`
- **Excluded:** `drafts/`, `attachments/`
- **Wikilink injection** — Extracts `[[links]]` and creates graph relations

The RAG system enables agents to ground answers in vault content. Query modes: naive, local, global, hybrid, mix.

### 1.7 Ingestion Pipeline

Five-stage pipeline: **Upload → Extraction (Docling) → Generation (Claude) → Promotion → Complete**

Turns uploaded documents (PDFs, papers) into structured vault notes via:
1. Docling Python extraction
2. Claude agent generates atomic concept notes
3. Notes promoted to vault with proper frontmatter
4. RAG indexer picks them up automatically

Also supports Zotero integration for automatic paper ingestion.

### 1.8 Student Profile System

Three markdown notebooks in `vault/profile/`:
- **student-profile.md** — Courses, metadata
- **knowledge-map.md** — Per-topic confidence scores
- **study-log.md** — Activity log (quiz, Q&A, summary, writing sessions)

Methods: `logStudySession()`, `updateKnowledgeMap()`, `addCourse()`

**Current limitation:** Profile is markdown-based, not structured data. Works for the agent to read, but harder for the dashboard to query programmatically.

### 1.9 Web Dashboard

Next.js app (port 3100) with existing pages: Upload, Queue, Review, Vault, Quiz, Settings.

No Study page yet. Navigation template ready for insertion.

### 1.10 Database Schema

SQLite with tables for: chats, messages, router_state, sessions, registered_groups, scheduled_tasks, task_run_logs, ingestion_jobs, zotero_sync, rag_index_tracker, citation_edges, settings.

**Not yet created:** study_plans, sr_cards, study_plan_cards, sr_review_log (from the existing spec).

---

## Part 2: What's Already Been Planned

### 2.1 Existing Design Documents

Two documents dated 2026-04-05:
- **Spec:** `docs/superpowers/specs/2026-04-05-study-plan-system-design.md`
- **Plan:** `docs/superpowers/plans/2026-04-05-study-plan-system.md`

### 2.2 Previous Design Decisions

| Decision | Rationale |
|----------|-----------|
| Brain-first, AI-second | Kosmyna et al. 2025 cognitive debt research |
| SM-2 algorithm (not FSRS) | Simplicity for MVP |
| Dashboard has NO LLM access | Thin SQLite UI layer only |
| Main process handles all LLM work | Plan generation, answer evaluation |
| IPC-based communication | Between Telegram agent and main process |
| Two strategies: exam-prep + weekly-review | MVP scope |
| Feynman technique via Telegram | Conversational, not form-based |

### 2.3 Planned Data Model

Four new tables: `study_plans`, `study_plan_cards`, `sr_cards`, `sr_review_log`

Mastery state machine: `new → learning → reviewing → mastered` (with lapse back to learning)

### 2.4 Implementation Status

- **Done:** Student profile tracking, agent personas, vault structure, dashboard skeleton
- **Not started:** SM-2 engine, study tables, dashboard study page, quiz module, agent integration, scheduled study tasks

---

## Part 3: Learning Science Research

### 3.1 Spaced Repetition

**Core science:**
- Ebbinghaus forgetting curve: `R = e^(-t/S)` — memory decays exponentially, each successful retrieval increases strength
- Cepeda et al. (2008): Optimal gap between reviews is ~10-20% of desired retention interval
- SM-2 algorithm: Tracks repetitions, ease factor (initial 2.5), and interval. Simple, ~50 lines of code
- FSRS (Free Spaced Repetition Scheduler): Modern ML-based successor, 20-30% fewer reviews for same retention

**Recommendation:** Start with SM-2 (as planned), but design the review log schema to be algorithm-agnostic for future FSRS migration. Log everything: quality, response time, ease factor, interval — FSRS needs this training data.

### 3.2 Active Recall & Testing Effect

**Core science:**
- Roediger & Karpicke (2006): Testing beats re-reading on delayed tests, even without feedback
- Karpicke & Blunt (2011, Science): Retrieval practice > elaborative concept mapping
- Karpicke (2012): Up to 400% improvement in long-term retention vs. re-reading
- Bjork's "Desirable Difficulties": Harder retrieval = better learning

**Question type hierarchy (by effectiveness):**
1. Free recall ("Explain concept X from memory")
2. Short-answer generation ("What are the three types of...?")
3. Cued recall ("Given X, what is Y?")
4. Recognition/MCQ (lowest effect)

**Recommendation:** Prioritize free-recall and explain-in-your-own-words questions. MCQ only for factual recall at Remember level. The Feynman technique via Telegram (already planned) is excellent — it's the highest-effectiveness active recall strategy.

### 3.3 Bloom's Taxonomy (Revised)

**Six cognitive levels:** Remember → Understand → Apply → Analyze → Evaluate → Create

**Four knowledge dimensions:** Factual, Conceptual, Procedural, Metacognitive

**Recommendation:** Tag every card with its Bloom's level. Require mastery at lower levels before challenging at higher levels for the same concept. This creates natural progression:
- First encounters: Remember & Understand
- After initial mastery: Apply & Analyze
- Advanced mastery: Evaluate & Create

### 3.4 Mastery Learning (Bloom, 1968)

**Core principle:** 90%+ of students can master material given sufficient time and targeted corrective instruction.

**The cycle:** Instruction → Formative assessment → Correctives for gaps → Re-assess → Repeat until mastery

**Recommendation:** Implement mastery gates (80%+ threshold). After failure, identify specific missed concepts and generate targeted corrective content via Claude + RAG. Don't make students redo everything — only remediate the gaps.

### 3.5 Zone of Proximal Development (Vygotsky)

**Core concept:** Learning happens in the gap between what a learner can do alone and what they can do with guidance.

**Scaffolding levels (for the AI tutor):**
- Level 0: Question only
- Level 1: Contextual hint ("Think about concept X")
- Level 2: Structural hint ("The answer involves three components...")
- Level 3: Partial solution ("The first step is...")
- Level 4: Worked example with similar problem
- Level 5: Full explanation + answer

**Target success rate: 70-85%** — difficult enough for desirable difficulty, not so hard as to cause frustration.

**Recommendation:** Implement adaptive scaffolding. Track rolling success rate per concept. If >90%: increase difficulty. If <50%: decrease difficulty. Mr. Rogers serves as the "More Knowledgeable Other" providing calibrated support.

### 3.6 Cognitive Load Theory (Sweller)

**Three types of cognitive load:**
- **Intrinsic:** Inherent material complexity (manage, can't eliminate)
- **Extraneous:** Bad instructional design (minimize)
- **Germane:** Productive schema-building effort (maximize)

**Key insight — Expertise Reversal Effect:** What helps novices (worked examples, heavy scaffolding) hurts experts by adding unnecessary load.

**Recommendation:**
- New material: Block presentation, one concept at a time
- Session length: 25-50 minutes (Pomodoro-aligned)
- Prerequisite enforcement: Don't present concept B until sub-concepts are mastered
- Adapt scaffolding to expertise level (reduce for advanced students)

### 3.7 Interleaving & Distributed Practice

**Core finding:** Mixing different problem types in review sessions beats blocked practice for long-term retention and transfer.

**Critical nuance (Hwang, 2025):** For low-achieving learners, interleaving alone creates "undesirable difficulty." Hybrid approach works best: block first for initial learning, interleave for review.

**Recommendation:**
- New material: Blocked (one topic thoroughly)
- Review sessions: Interleaved (mix topics and question types)
- Session composition: ~30% new material (blocked), ~70% review (interleaved)
- Never place 2+ cards from the same concept adjacent in review

### 3.8 Self-Regulated Learning & Metacognition (Zimmerman)

**Three-phase cycle:**
1. **Forethought:** Goal setting, strategy planning, self-motivation
2. **Performance:** Self-monitoring, attention control, help-seeking
3. **Self-Reflection:** Self-evaluation, causal attribution, adaptive reactions

**Recommendation:** Build all three phases into the study session lifecycle:
- **Pre-session:** Show upcoming topics, ask confidence ratings, set goals
- **During:** Track response time, prompt reflection every 5-7 cards
- **Post-session:** Show accuracy vs. confidence (calibration), highlight improvements, prompt reflection

Track **calibration score** = correlation(confidence predictions, actual performance). This builds metacognitive accuracy over time.

### 3.9 AI Tutoring — State of the Art (2024-2026)

**What works:**
- RAG-grounded tutoring dramatically reduces hallucination
- Prompt-engineering guardrails preserve academic integrity (guide, don't give answers)
- Affective scaffolds (encouragement, empathy) increase persistence
- Nature 2025 study: AI tutor outperformed traditional active learning for practice-based tasks

**What doesn't work / pitfalls:**
- Fully autonomous tutors perform worse than hybrid human-AI
- "Cognitive debt" (Kosmyna et al., 2025): Habitual AI use causes cumulative cognitive cost — 83.3% of LLM users failed to quote from their own AI-assisted essay
- Students who use AI for answers (not scaffolding) learn less

**Emerging approaches:**
- Bayesian Knowledge Tracing (BKT): Probabilistic mastery estimation per knowledge component
- Multi-agent frameworks: Separate agents for content, assessment, emotional support, metacognitive coaching
- LPITutor architecture: LLM + RAG + prompt engineering

**Recommendation:** Our architecture (Claude + RAG + vault grounding + brain-first rule) aligns with best practices. Consider adding simplified BKT alongside SM-2: BKT for estimating concept mastery (what to ask), SM-2 for scheduling timing (when to ask).

### 3.10 Progressive Curriculum Design

**Bruner's Spiral Curriculum:**
1. Cyclical revisiting of the same topics
2. Increasing depth with each revisit
3. Explicit building on prior knowledge

**Cadence structure:**
- **Daily (25-50 min):** 5-8 new cards (blocked) + 15-20 review cards (interleaved) + 1 metacognitive reflection
- **Weekly:** Cross-topic synthesis questions, higher Bloom's assessments, knowledge map review
- **Monthly:** Comprehensive mastery check, study plan regeneration, decay identification

**Recommendation:** Implement Bloom's escalation per concept — each successful review cycle generates a higher-level question. This creates a natural spiral within the spaced repetition system.

```
encounters ≤ 2: Remember
encounters ≤ 4: Understand
encounters ≤ 6: Apply
encounters ≤ 8: Analyze
encounters ≤ 10: Evaluate
encounters > 10: Create
```

### 3.11 Learning Analytics

**Key metrics to track:**
| Metric | What It Measures |
|--------|-----------------|
| Retention rate | % of cards with quality ≥ 3 at review |
| Ease factor trend | Declining EF = concept getting harder |
| Time-to-competency | Reviews before "mastered" state |
| Response time | Proxy for knowledge fluency |
| Calibration accuracy | Confidence prediction vs. actual performance |
| Transfer score | High-Bloom success / Low-Bloom success |
| Knowledge decay rate | How fast mastery drops between reviews |

**Understanding vs. memorization test:** If a student aces Remember questions but fails Apply/Analyze, they memorized but didn't understand.

### 3.12 Assessment Strategy

**Formative (daily):** SR reviews, self-rated (quality 0-5), in-chat Feynman exercises, confidence ratings
**Summative (at gates):** AI-evaluated free-text answers, mastery threshold ≥80%, required before advancing
**Portfolio (auto-generated):** Weekly/monthly summaries of mastery progression, study time, Bloom's distribution

---

## Part 4: What's In The Vault (RAG Search Results)

The vault contains content on these learning-relevant topics:

**Strong coverage:**
- Cognitive Load Theory (CLT and CTML, Sweller, multimedia learning principles)
- Working memory constraints and concept formation (Cowan 2014)
- Knowledge construction and comprehension
- Chunking strategies
- Critical thinking
- Anticipatory reading
- Learning analytics and adaptive learning
- Formative assessment feedback loops
- Personalized learning paths (adaptive systems, CBR, LMS)

**Gaps (not in vault):**
- Spaced repetition algorithms and research
- Active recall / testing effect (Roediger & Karpicke)
- Bloom's Taxonomy
- Mastery learning (Bloom)
- Zone of Proximal Development (Vygotsky)
- Interleaving and distributed practice
- Self-regulated learning (Zimmerman)
- Bruner's spiral curriculum

**Recommendation:** These gaps represent opportunity for the ingestion pipeline — the learning science papers referenced in Part 3 could be ingested to build vault coverage of pedagogical foundations.

---

## Part 5: Architecture for a Progressive AI Tutor

### 5.1 The Three Learning Surfaces

UniClaw has three natural surfaces for learning interactions:

| Surface | Channel | Best For | Interaction Style |
|---------|---------|----------|-------------------|
| **Telegram** (Mr. Rogers) | Conversational | Feynman technique, Q&A, daily reminders, quick quizzes | Async, mobile-friendly, push notifications |
| **Dashboard** (/study) | Web UI | Study plans, card review, progress analytics, mastery heatmap | Focused sessions, visual progress tracking |
| **Scheduled Tasks** | Background | Daily reminders, weekly synthesis, monthly reviews | Proactive, no student action needed to trigger |

### 5.2 Data Architecture

**Existing (keep as-is):**
- Vault notes (concepts, sources) — the knowledge base
- RAG index — semantic search over vault
- Student profile (markdown) — agent-readable context
- Ingestion pipeline — document → knowledge flow

**New (to build):**
- `sr_cards` table — Spaced repetition cards with SM-2 fields + Bloom's level
- `sr_review_log` table — Every review event (enables future FSRS, BKT)
- `study_plans` table — Plan metadata (strategy, course, config)
- `study_plan_cards` table — Join table linking plans to cards
- Study engine (`src/study/`) — SM-2 algorithm, session builder, mastery tracking

### 5.3 The Learning Loop

```
                    ┌─────────────────────────────────┐
                    │                                  │
                    ▼                                  │
    ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌───┴──────┐
    │ INGEST   │──▶│ GENERATE │──▶│ SCHEDULE │──▶│  REVIEW  │
    │ content  │   │ cards    │   │ sessions │   │  & learn │
    └──────────┘   └──────────┘   └──────────┘   └──────────┘
         │              │              │               │
         ▼              ▼              ▼               ▼
    Upload/Zotero  Claude+RAG     SM-2 engine    Dashboard/
    → vault notes  → SR cards    → due dates     Telegram
                   + Bloom tags  → reminders     → feedback
                                                 → mastery update
```

### 5.4 Progressive Cadences

**Daily (triggered by scheduled task, ~25-50 min):**
1. Mr. Rogers sends morning reminder via Telegram: "You have X cards due today"
2. Student opens dashboard /study or responds in Telegram
3. Session: 30% new cards (blocked by topic) + 70% review (interleaved)
4. Pre-session: confidence ratings on upcoming topics
5. During: active recall questions, scaffolded hints on struggle
6. Post-session: calibration feedback, reflection prompt
7. Results flow back: SR card updates, knowledge map updates, study log entry

**Weekly (triggered by cron task, synthesis focus):**
1. Cross-topic synthesis questions ("How does concept A relate to concept B?")
2. Higher Bloom's level assessments for mastered concepts
3. Weekly progress summary sent via Telegram
4. Knowledge map review — visualize growth and gaps
5. Optionally: Feynman session on weakest topic

**Monthly (triggered by cron task, comprehensive review):**
1. Full mastery check across all active courses
2. Identify decaying concepts (mastery slipping)
3. Study plan regeneration based on upcoming deadlines
4. Portfolio generation: growth trajectory, Bloom's distribution
5. Strategy adjustment recommendations

### 5.5 Adaptive Difficulty & Scaffolding

```
For each concept, track:
  - rolling_success_rate (last 10 attempts)
  - current_bloom_level
  - scaffolding_level (0-5)

Adjustment rules:
  if rolling_success > 0.90:
    bloom_level++ (escalate)
    scaffolding_level-- (reduce support)
  elif rolling_success < 0.50:
    bloom_level-- (de-escalate)
    scaffolding_level++ (add support)
  else:
    maintain (in the ZPD sweet spot: 70-85%)
```

### 5.6 Dashboard Study Page Design

**Main /study page:**
- Study plan overview (active plans, progress bars)
- Today's due cards (count, estimated time)
- "Start Session" button → quiz mode
- Mastery heatmap (concepts as nodes, colored by state)
- Weekly/monthly analytics charts

**Quiz mode (/study/quiz):**
- One card at a time, clean interface (minimize extraneous load)
- Free-text answer box (brain-first)
- After submission: reference answer from vault, quality self-rating (0-5)
- Progressive hint button (scaffolding levels 1-5)
- Bloom's level indicator
- Session progress bar

### 5.7 Mr. Rogers Integration (Telegram)

Enhanced capabilities:
1. "What should I study today?" → Returns due cards with priority
2. In-chat quiz: presents question, waits for answer, gives feedback
3. Feynman technique: "Explain [concept] to me" → evaluates explanation
4. Daily morning reminder (scheduled task)
5. Weekly progress summary (scheduled task)
6. Metacognitive prompts: "How confident are you about [topic]?"
7. Results flow back to SR system via IPC

### 5.8 Website ↔ Tutoring Integration

The dashboard is the **study cockpit** — it shows progress, manages plans, and hosts focused study sessions. The tutoring system feeds it data:

| Website Feature | Tutoring Data Source |
|----------------|---------------------|
| Study plan management | `study_plans` table |
| Card review / quiz | `sr_cards` + SM-2 engine |
| Progress analytics | `sr_review_log` aggregations |
| Mastery heatmap | Knowledge map + Bloom's tracking |
| Vault browser | Links from cards to source notes |
| Upload page | Ingestion → cards pipeline |
| RSVP reader | Deep-link from cards to vault notes |

**Key integration:** When a student reviews a card on the dashboard, clicking the source link opens the relevant vault note in the RSVP reader or vault browser. Learning is grounded in the primary material.

---

## Part 6: Open Design Questions

These are the decisions we need to make together:

### Q1: SM-2 vs. SM-2 + BKT?
- **SM-2 only:** Simpler. Cards have individual scheduling. Per-concept mastery derived from card aggregation.
- **SM-2 + BKT:** More nuanced. BKT estimates concept-level mastery probabilistically, informing which questions to generate. SM-2 handles card-level timing.
- **Trade-off:** Complexity vs. adaptive intelligence.

### Q2: Self-Rated vs. AI-Evaluated Answers?
- **Self-rated (MVP):** Student rates own answer quality 0-5. Builds metacognitive skills. Simpler to implement.
- **AI-evaluated:** Claude + RAG evaluates free-text answers against vault content. More accurate but requires LLM call per review.
- **Hybrid:** Self-rated for daily formative reviews, AI-evaluated for weekly/monthly summative gates.
- **Recommendation from spec:** Start self-rated, add AI evaluation later.

### Q3: Card Generation — When and How?
- **On plan creation:** Generate all cards upfront from vault content via Claude. Fixed card set.
- **On demand:** Generate cards as concepts become due. More dynamic but less predictable.
- **Hybrid:** Generate initial card set, regenerate/add cards as new vault content arrives.

### Q4: How Should the Dashboard and Telegram Interact?
- **Dashboard-primary:** All study happens on dashboard, Telegram for reminders only.
- **Telegram-primary:** Most study via chat, dashboard for analytics/management only.
- **True hybrid:** Student can review cards on either surface, results sync via shared DB.
- **Recommendation:** True hybrid — some students prefer mobile/chat, others prefer focused web sessions.

### Q5: Mastery Scope — Per-Card or Per-Concept?
- **Per-card:** Each card has its own mastery state. Simple but doesn't capture concept-level understanding.
- **Per-concept:** Aggregate card results into concept-level mastery. Enables mastery gates and prerequisite enforcement.
- **Recommendation:** Both — cards have individual SM-2 state, concepts have aggregated mastery (derived from their cards' Bloom's distribution).

### Q6: How to Handle Vault Content Updates?
- When a vault note is updated (new ingestion, manual edit), what happens to cards generated from it?
- **Options:** Flag as stale (mtime comparison), auto-regenerate, manual regeneration.
- **Spec recommendation:** Manual — auto-updating mid-study disrupts spacing.

### Q7: Scheduling Architecture — Who Orchestrates?
- **Main process:** Study engine lives in main Node.js process, generates sessions, evaluates answers.
- **Container agent:** Agent in container handles quiz logic, has access to RAG.
- **Recommendation from spec:** Main process handles LLM work, dashboard is thin UI. But Mr. Rogers (container agent) also needs to run quizzes conversationally.

### Q8: Progressive Features — MVP vs. Full Vision?
What's the minimum viable tutoring loop?
- **Absolute MVP:** Cards in DB + SM-2 scheduling + dashboard quiz page + daily reminder
- **Phase 2:** Bloom's escalation, scaffolding hints, Telegram quiz, weekly synthesis
- **Phase 3:** BKT, AI evaluation, analytics dashboard, monthly reviews, calibration tracking
- **Phase 4:** Adaptive difficulty, cross-course synthesis, portfolio generation

---

## Part 7: Recommended Implementation Phases

### Phase 1 — The Core Loop (MVP)
- [ ] Add study tables to SQLite schema
- [ ] Implement SM-2 algorithm (pure functions)
- [ ] Build study engine (plan generation, session builder)
- [ ] Create dashboard /study page (plan management + quiz)
- [ ] Add daily reminder scheduled task
- [ ] Wire IPC for study completion events

### Phase 2 — Progressive Intelligence
- [ ] Add Bloom's level to cards and escalation logic
- [ ] Implement scaffolding hint system (5 levels)
- [ ] Mr. Rogers Telegram quiz integration
- [ ] Weekly synthesis tasks
- [ ] Interleaving algorithm for session building

### Phase 3 — Adaptive & Analytical
- [ ] Add confidence tracking and calibration scoring
- [ ] Implement response time tracking
- [ ] Build analytics dashboard (retention, Bloom's distribution, trends)
- [ ] AI-evaluated answers for summative gates
- [ ] Mastery heatmap visualization

### Phase 4 — Advanced Tutoring
- [ ] Bayesian Knowledge Tracing (optional)
- [ ] Cross-course synthesis questions
- [ ] Monthly comprehensive reviews
- [ ] Portfolio generation
- [ ] FSRS migration (if data supports it)

---

## Sources

### Spaced Repetition
- Ebbinghaus, H. (1885). *Memory: A Contribution to Experimental Psychology*
- Cepeda, N.J. et al. (2008). Spacing effects in learning: A temporal ridgeline of optimal retention. *Psychological Science*, 19(11), 1095-1102
- SM-2 Algorithm — SuperMemo (Wozniak, 1987)
- FSRS — Open-source ML-based scheduler (Expertium)

### Active Recall & Testing Effect
- Roediger, H.L. & Karpicke, J.D. (2006). Test-enhanced learning. *Psychological Science*, 17(3), 249-255
- Karpicke, J.D. & Blunt, J.R. (2011). Retrieval practice produces more learning than elaborative studying with concept mapping. *Science*, 331(6018), 772-775
- Bjork, R.A. (1994). Memory and metamemory considerations in the training of human beings. *Metacognition*

### Bloom's Taxonomy
- Anderson, L.W. & Krathwohl, D.R. (2001). *A Taxonomy for Learning, Teaching, and Assessing* (Revised edition)

### Mastery Learning
- Bloom, B.S. (1968). Learning for Mastery. *Evaluation Comment*, 1(2), 1-12
- Guskey, T.R. (2007). Closing achievement gaps: Revisiting Benjamin S. Bloom's "Learning for Mastery"

### Zone of Proximal Development
- Vygotsky, L.S. (1978). *Mind in Society*
- Wood, D., Bruner, J.S. & Ross, G. (1976). The role of tutoring in problem solving. *Journal of Child Psychology and Psychiatry*, 17(2), 89-100

### Cognitive Load Theory
- Sweller, J. (1988). Cognitive load during problem solving. *Cognitive Science*, 12(2), 257-285
- Mayer, R.E. (2009). *Multimedia Learning* (2nd ed.)

### Interleaving & Distributed Practice
- Cepeda, N.J. et al. (2006). Distributed practice in verbal recall tasks. *Review of Educational Research*, 76(3), 354-380
- Hwang, H. (2025). Undesirable difficulty of interleaved practice for low-achieving learners. *Language Learning*

### Self-Regulated Learning
- Zimmerman, B.J. (2002). Becoming a self-regulated learner. *Theory Into Practice*, 41(2), 64-70

### AI Tutoring
- Kosmyna, N. et al. (2025). Cognitive debt from AI use. *Nature*
- Dunlosky, J. et al. (2013). Improving students' learning with effective learning techniques. *Psychological Science in the Public Interest*, 14(1), 4-58

### Curriculum Design
- Bruner, J.S. (1960). *The Process of Education*
- Harden, R.M. (1999). What is a spiral curriculum? *Medical Teacher*, 21(2), 141-143
