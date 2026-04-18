# Multi-Method Study System — Design Spec v2.1

Personal, adaptive, multi-method study system for universityClaw. Goes beyond flashcard-based spaced repetition to implement a full learning toolkit grounded in cognitive science research. Concepts progress through Bloom's taxonomy levels with the system recommending appropriate study methods at each level.

**Supersedes:** `2026-04-05-study-plan-system-design.md` (cards-only design). Preserves its architectural decisions (brain-first, dashboard-reads-main-writes) while expanding the pedagogical model, adding a dashboard chat interface for deep learning, and repositioning Telegram as a mobile companion.

**Key evolution from original spec:** Study plans are co-created through collaborative dialogue (Knowles' learning contracts), not auto-generated. Concepts are organized by knowledge domain, not just course. The dashboard has a full chat interface for deep conversational methods. Telegram handles reminders, quick reviews, and podcast delivery.

**v2.1 changes (2026-04-13 review):** Replaced BKT with weighted evidence mastery model. Replaced 8-stage method ladder with Bloom's-based progression (methods are tools, not stages). Clarified exam-prep as scheduling constraint. Dropped transfer_score. Made planning dialogue optional-depth. Added domain-batch concept approval. Session design: suggest strongly, enforce nothing. Added future considerations (backup, deletion handling, rate limiting).

---

## 1. Why Multi-Method? The Research Case

### 1.1 The Limits of Cards Alone

Spaced repetition flashcards are the most evidence-backed tool for long-term retention of factual knowledge (Dunlosky et al. 2013, "high utility"). But university learning demands more than recall:

- **Karpicke & Blunt (2011, Science):** Retrieval practice outperforms elaborative study -- but only when retrieval targets the right cognitive level. Simple recall cards test recognition; complex understanding requires generation, explanation, and application.
- **Matuschak (2020):** LLM-generated cards "reinforce the surface -- what is said, rather than what it means or why it matters." Cards are effective for declarative knowledge but fail for relational, procedural, and evaluative understanding.
- **Nielsen (2018):** "What you really want is to feel every element and the connections between them in your bones." Cards build the skeleton; other methods build the muscle.

For Simon's learning domains (knowledge management theory, digital transformation, information systems, cognitive psychology), the critical challenges are:
- Understanding *why* Nonaka's SECI model differs from Wiig's lifecycle (comparative analysis)
- Applying cognitive load theory to critique an instructional design (case-based reasoning)
- Synthesizing across frameworks to argue a position in an exam (synthesis + writing)

**Conclusion:** Cards are layer 1 of a multi-layer system. Each layer targets progressively higher Bloom's taxonomy levels with the study method best suited to that cognitive demand.

### 1.2 The Study Method Toolkit — Evidence Base

Each method is selected based on its research backing, the Bloom's levels it targets, and its practical implementability in an AI tutor. **Methods are tools, not stages** — any method can be used at any point, but the system recommends methods that match the concept's current Bloom's level.

| Method | Bloom's | Key Research | Best For |
|--------|---------|-------------|----------|
| SR Cards | L1-L2 | Dunlosky 2013 ("high utility"), Cepeda 2008 (spacing), Wozniak 1987 (SM-2) | Foundational retention of facts and definitions |
| Elaborative Interrogation | L2-L3 | Dunlosky 2013 ("moderate utility"), Pressley 1987 (2x recall improvement) | "Why" reasoning, activating prior knowledge schemas |
| Self-Explanation / Feynman | L2-L4 | Chi 1994 (all high-explainers achieved correct mental model), Nestojko 2014 (teaching expectation improves memory) | Exposing gaps, integrative + error-correcting |
| Concept Mapping | L2-L5 | Nesbit & Adesope 2006 (moderate-large effect), STEM meta-analysis 2025 (ES=0.630) | Mapping relationships between ideas |
| Comparative Analysis | L4-L5 | Alfieri et al. 2013 (d=0.50, d=1.60 with principles after), Gentner 1983 (structure-mapping) | Deep structural comparison, framework discrimination |
| Case-Based Learning | L3-L6 | Nkhoma 2016 (positive cascade: application -> higher-order thinking), Yadav 2024 (d=0.498 motivation) | Transferring theory to authentic situations |
| Synthesis Exercises | L5-L6 | Research on argumentative synthesis (PMC 2022): explicit instruction on integrating conflicting sources required | Cross-topic integration, highest cognitive demand |
| Socratic Dialogue | L4-L6 | UK RCT 2025 (5.5pp improvement on novel problems), ECAI 2024 (p<0.001 critical thinking improvement) | Probing assumptions, metacognitive fluency |

**Bloom's level is the progression axis, not method type.** Concepts advance through Bloom's L1-L6 based on mastery evidence. The system recommends method combinations suited to the current level, but the student can use any method at any time. Karpicke & Blunt (2011) showed retrieval practice is effective at all cognitive levels — rigid method gates would prevent this.

**Method recommendation guidelines (not gates):**
- L1-L2 (Remember/Understand): Cards, elaboration, light Feynman
- L3-L4 (Apply/Analyze): Feynman, concept mapping, comparison, case analysis
- L5-L6 (Evaluate/Create): Synthesis, Socratic dialogue, case analysis, comparison

The system suggests the best method mix for where you are, but never locks out a method.

### 1.3 Foundational Design Principles

These principles are carried forward from the original spec, grounded in research, and apply to every method -- not just cards.

**Brain-first, AI-second (Kosmyna et al. 2025).**
Habitual AI use causes cumulative cognitive debt -- 83.3% of LLM users failed to correctly quote from their own AI-assisted essay. Every method requires the student to produce output before receiving feedback. The AI scaffolds, questions, and evaluates -- it never leads with answers.

**Desirable difficulties (Bjork 1994, 2011).**
Conditions that feel harder during learning produce better long-term retention and transfer. The system optimizes for learning, which means: spacing (not massing), interleaving (not blocking review), generation (not recognition), and contextual variation (not repetition of identical prompts). The system communicates *why* it recommends certain activities ("interleaving these topics improves long-term retention") so the student can make informed decisions.

**Suggest strongly, enforce nothing.**
The system recommends session composition, method choices, and difficulty levels based on learning science. Mr. Rogers actively nudges and reminds. But the student has full control — they can change, skip, or ignore any recommendation. No flagging, no guilt mechanics, no paternalism. The system is a smart assistant, not a strict tutor.

**Cognitive load management (Sweller 1988, Mayer 2002).**
- New material: block presentation, one concept at a time (minimize intrinsic load)
- Session length: 25-50 minutes (prevent working memory overload)
- Prerequisite awareness: flag when a concept depends on others that aren't yet solid
- Expertise reversal effect: reduce scaffolding as mastery grows (what helps novices hurts experts)
- Personalization effect (Mayer): conversational style produces the largest multimedia learning effect (ES=1.55)
- Minimize extraneous load: clear interfaces, smart defaults, no unnecessary steps — maximize cognitive effort on actual learning

**Metacognition and self-regulated learning (Zimmerman 2002).**
Three-phase cycle built into every session:
1. Forethought: confidence ratings, goal setting
2. Performance: self-monitoring, help-seeking
3. Self-reflection: calibration feedback, adaptive reactions

Tracking calibration (predicted vs. actual performance) builds metacognitive accuracy over time -- a skill that transfers beyond the study system.

**Transfer over recall (Mayer 2002).**
Rote learning produces retention without transfer. Meaningful learning produces both. The system prioritizes methods that develop transfer capability (application, analysis, synthesis) over methods that only develop recall. Cards are the floor, not the ceiling.

**Mastery orientation over performance orientation (Dweck, Ames).**
The system frames all learning as mastery-approach goals ("understand deeply, apply flexibly") rather than performance goals ("get 90% on the exam"). Mastery orientation produces deeper learning strategies, challenge-seeking, persistence after failure, and sustained interest beyond the course (Katz-Vago 2024). Exam-prep mode is a scheduling constraint (deadline + coverage), not a different learning philosophy — the mastery orientation applies regardless.

---

## 2. Architecture

### 2.1 System Topology

The architecture has four surfaces: the dashboard (UI + chat), the main process (engine + LLM), Telegram (mobile companion), and scheduled background tasks. Container agents (via NanoClaw's existing infrastructure) handle all LLM work, running through the Claude Max subscription via OneCLI -- no paid API calls.

```
Dashboard (Next.js, port 3100)
  /study -------- Concept map, plans, analytics
  /study/session - Multi-method study UI
  /study/chat --- Deep learning dialogue (Feynman, Socratic, planning)
  /study/plan --- Collaborative plan creation
  /read --------- RSVP reader (vault deep-links)
  /api/study/* -- SQLite reads + completion writes
  Web channel --- SSE streaming for chat
      |
      | HTTP + SSE
      v
Main Process (src/study/)
  engine.ts ----- Concept progression, session building
  planner.ts ---- Collaborative plan dialogue
  sm2.ts -------- Card-level scheduling
  mastery.ts ---- Concept-level mastery (weighted evidence)
  generator.ts -- Activity generation via Claude + RAG
  audio.ts ------ Podcast/audio generation via Claude + TTS
  Uses: RagClient, StudentProfile, VaultUtility, SQLite
      |                    |
      | IPC                | IPC
      v                    v
Study Agent             Mr. Rogers (Telegram)
(Container)             - Daily reminders + nudges
- Dashboard chat        - Quick card review
- Feynman sessions      - Podcast delivery
- Socratic dialogue     - Progress summaries
- AI evaluation         - Light elaboration
- Plan dialogue         - On-the-go study
- Results -> IPC        - Concept discovery alerts
                        - Results -> IPC
```

### 2.2 The Four Learning Surfaces

The dashboard is the primary surface for deep, focused learning. Telegram is the mobile companion for lightweight interactions and content delivery. Each surface plays to its strengths.

**Dashboard Chat (`/study/chat`)** -- Primary surface for deep learning:
- Feynman technique (full multi-turn dialogue)
- Socratic questioning (iterative, transcript-saving)
- Case analysis discussion (multi-step reasoning)
- Synthesis dialogue (cross-concept integration)
- Collaborative plan creation
- Future: live voice dialogue

**Dashboard UI (`/study/session`, `/study`)** -- Primary surface for structured activities:
- SR card review (quiz interface)
- Concept mapping (visual builder)
- Comparison matrices
- Writing/synthesis labs
- Progress analytics and mastery heatmaps
- Pre/post session metacognitive prompts

**Telegram (Mr. Rogers)** -- Mobile companion:
- Daily reminders and session-ready notifications
- Quick card review on the go
- Light elaborative interrogation
- Weekly/monthly progress summaries
- Podcast/audio delivery (listen while traveling)
- Concept discovery notifications ("3 new concepts from yesterday's upload")

**Scheduled Tasks** -- Proactive background:
- Morning session preparation (generate activities, build session)
- Post-session activity generation (for escalated concepts)
- Daily/weekly/monthly reminder triggers
- Audio/podcast generation for upcoming review topics

| Method | Dashboard Chat | Dashboard UI | Telegram | Scheduled |
|--------|---------------|-------------|----------|-----------|
| SR Card Review | -- | Full quiz interface | Quick review | -- |
| Elaboration | "Why?" dialogue | Structured prompts | Light "why?" | -- |
| Feynman | **Primary** | -- | -- | -- |
| Concept Mapping | -- | **Primary** (visual) | -- | -- |
| Comparison | Discussion mode | **Primary** (matrix) | -- | -- |
| Case Analysis | **Primary** | Case workbench | -- | -- |
| Synthesis | **Primary** | Writing lab | -- | -- |
| Socratic | **Primary** | -- | -- | -- |
| Plan Creation | **Primary** | Plan overview | -- | -- |
| Daily Reminder | -- | -- | **Primary** | Trigger |
| Podcasts | Generation UI | -- | **Delivery** | Generation |
| Progress Reports | -- | Analytics page | Summaries | Trigger |
| Voice Dialogue | **Future** | -- | -- | -- |

### 2.3 Key Architectural Decisions

**Decision 1: Dashboard reads, main process writes (carried forward).**
The dashboard has no Anthropic API key. All LLM work -- activity generation, answer evaluation, Socratic dialogue on the web -- routes through the main process via container agents. Container agents run through the Claude Max subscription via OneCLI, so AI evaluation is essentially free in API cost terms.

**Decision 2: Concepts are the central entity, organized by domain (new).**
The original spec centered on cards and organized by course. This spec centers on concepts organized by **knowledge domain** and **subdomain**. A concept belongs to a domain ("Knowledge Management") and subdomain ("KM Models"), not necessarily to a course. Courses are just one way concepts get tagged -- personal interest, research fields, and cross-disciplinary themes are equally valid organizing structures.

**Decision 3: SM-2 + weighted evidence mastery coexist at different levels (revised v2.1).**
- SM-2 operates per-activity: "this specific elaboration prompt is due in 6 days"
- Weighted evidence mastery operates per-concept: "the student has strong L1-L3 mastery but weak L4+ on Cognitive Load Theory"
- SM-2 decides WHEN to show each activity
- Mastery evidence decides WHICH TYPE of activity to recommend next and at what Bloom's level

*Why weighted evidence and not BKT?* BKT was designed for estimating mastery across student populations. With a single learner, its four parameters (p_learn, p_guess, p_slip) never accumulate enough data per concept to converge meaningfully — the defaults from literature are population-derived constants. A weighted evidence model provides the same decision-making capability (stage gates, mastery %, identifying weak concepts) with transparent, interpretable scores. Each activity at a Bloom's level contributes weighted evidence scaled by quality, with exponential time decay. See Section 4.2.

**Decision 4: Activities are schedulable units (new).**
The original spec had only `sr_cards`. This spec introduces `learning_activities` -- a broader entity that includes cards, elaboration prompts, Feynman prompts, comparison tasks, case scenarios, synthesis exercises, and Socratic dialogue starters. All activity types share SM-2 scheduling fields. The session builder mixes activity types to create varied, cognitively demanding study sessions.

**Decision 5: Brain-first applies to every method (carried forward, expanded).**
Not just "show question before answer." For each method:
- Cards: student answers before seeing reference
- Elaboration: student explains "why" before seeing the source reasoning
- Feynman: student explains the concept before AI identifies gaps
- Concept mapping: student constructs the map before seeing the reference map
- Comparison: student identifies differences before seeing the analysis
- Case analysis: student proposes a solution before seeing the expert analysis
- Synthesis: student writes the integration before seeing the model synthesis
- Socratic dialogue: student reasons through questions before receiving guidance

**Decision 6: AI evaluation from Bloom's L3+ via container agents (revised v2.1).**
Since container agents run through the Claude Max subscription (no API cost), AI evaluation is used broadly:
- L1-L2 activities (cards, basic elaboration): Self-rated only. Clear right/wrong answers. Self-rating builds metacognition.
- L2-L3 activities (elaboration, Feynman): Self-rated + AI review. Student rates first (brain-first applies to evaluation too), then container agent evaluates against vault via RAG. Shows both ratings. This is where calibration training starts.
- L4-L6 activities (cases, synthesis, Socratic): AI-rated (primary). The AI rating feeds SM-2 and mastery evidence. Complex free-text responses are genuinely hard to self-assess.

**Container reuse:** During a study session, a single container agent stays alive across all activities — no per-activity spin-up. The dashboard chat is already a persistent container session via the web channel.

**Decision 7: Domain-based synthesis, not course-based (new).**
- **Within-subdomain synthesis (automatic):** Concepts in the same subdomain with strong L3+ mastery get synthesis activities automatically. Closely related ideas that should be integrated.
- **Within-domain synthesis (automatic):** Concepts in the same domain but different subdomains with strong L3+ mastery get synthesis automatically.
- **Cross-domain synthesis (proposed, not automatic):** When depth exists across multiple domains, the system suggests it in the weekly summary. Student confirms before generation. Avoids generating useless cross-domain connections while surfacing meaningful ones.

**Decision 8: Batch activity generation, triggered post-session + morning (new).**
Activities are generated in batches when concepts advance to new Bloom's levels. Two triggers:
- **Post-session (primary):** After session completion, the engine checks which concepts advanced and immediately generates next-level activities via a container agent. By tomorrow, everything is ready.
- **Morning scheduled task (safety net):** Catches anything missed, builds today's session composition, sends Telegram notification: "Your session is ready."
- **Rate limit:** Maximum 10 concepts per generation cycle. Remaining queued for next cycle.
The student never opens the dashboard to find "generating, please wait."

**Decision 9: Study plans as collaborative learning contracts (new, optional depth).**
Study plans are co-created through dialogue between the student and the AI (see Section 5). Grounded in Knowles' learning contracts (1975), backward design (Wiggins & McTighe), and self-determination theory (Deci & Ryan). The student drives; the AI structures.

**The dialogue depth is optional.** The minimum path is: "I want to study X" → system creates a plan with the selected concepts and default scheduling. The student can optionally go deeper: set learning objectives, define desired outcomes, create implementation intentions, identify obstacles. All plan fields except domain and concepts are nullable — the engine uses sensible defaults for anything not provided. A 30-second exchange and a 10-minute deep planning session produce the same data structure.

**Decision 10: Student-generated activities at key moments (new).**
The act of writing prompts is itself a learning activity (Nielsen 2018, Matuschak 2020). The system prompts the student to write their own activities at moments where self-authoring is most valuable:
- After a Feynman session where they struggled (captures personal gaps)
- When they notice a connection the system hasn't made (captures insight)
- During dashboard chat after an illuminating exchange (captures learning moments)
- After reading a vault note (Nielsen's multi-pass Ankification)
Student-authored activities are stored with `author = 'student'` and scheduled like any other.

---

## 3. Data Model

### 3.1 New SQLite Tables

```sql
-- CONCEPTS -- the central learning entity
-- Organized by knowledge domain/subdomain, not just course.
-- Weighted evidence mastery updated after every activity.

CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,                    -- "Cognitive Load Theory"
  domain TEXT,                            -- "Cognitive Psychology"
  subdomain TEXT,                         -- "Learning & Memory"
  course TEXT,                            -- "BI-2081" (optional tag, not primary organizer)
  vault_note_path TEXT,                   -- "concepts/cognitive-load-theory.md"

  -- Discovery and approval
  status TEXT DEFAULT 'active',           -- 'pending' | 'active' | 'skipped' | 'archived'

  -- Weighted evidence mastery (per Bloom's level)
  -- Each field stores accumulated weighted evidence (0.0+)
  -- Mastery at a level = evidence / threshold (capped at 1.0)
  mastery_L1 REAL DEFAULT 0.0,           -- Remember
  mastery_L2 REAL DEFAULT 0.0,           -- Understand
  mastery_L3 REAL DEFAULT 0.0,           -- Apply
  mastery_L4 REAL DEFAULT 0.0,           -- Analyze
  mastery_L5 REAL DEFAULT 0.0,           -- Evaluate
  mastery_L6 REAL DEFAULT 0.0,           -- Create
  mastery_overall REAL DEFAULT 0.0,      -- weighted aggregate (L1=1, L2=1.5, ... L6=4)

  -- Progression state
  bloom_ceiling INTEGER DEFAULT 1,        -- highest Bloom's level with sufficient mastery

  -- Metadata
  created_at TEXT NOT NULL,
  last_activity_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_concepts_domain ON concepts(domain);
CREATE INDEX IF NOT EXISTS idx_concepts_status ON concepts(status);

-- Prerequisite relationships between concepts.
-- The system flags when a concept's prerequisites have weak mastery
-- (CLT: isolated-to-interacting element progression, Sweller 1988)
-- but does not hard-block — the student decides.
CREATE TABLE IF NOT EXISTS concept_prerequisites (
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  prerequisite_id TEXT NOT NULL REFERENCES concepts(id),
  PRIMARY KEY (concept_id, prerequisite_id)
);

-- LEARNING ACTIVITIES -- schedulable study units
-- Every activity type shares SM-2 scheduling fields so the
-- session builder can interleave cards, elaboration, Feynman,
-- comparisons, cases, and synthesis in a single session.

CREATE TABLE IF NOT EXISTS learning_activities (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES concepts(id),

  -- Activity specification
  activity_type TEXT NOT NULL,            -- see Activity Types (Section 3.2)
  prompt TEXT NOT NULL,                   -- the question/task presented to student
  reference_answer TEXT,                  -- expected answer or evaluation rubric
  bloom_level INTEGER NOT NULL,           -- 1-6 (tagged per activity)
  difficulty_estimate INTEGER DEFAULT 5,  -- 1-10, content-based initial estimate

  -- For card_review activities specifically
  card_type TEXT,                         -- 'cloze' | 'basic' | 'reversed' | NULL

  -- Authorship
  author TEXT DEFAULT 'system',           -- 'system' | 'student'

  -- Source traceability (Wozniak Rules 18-19)
  source_note_path TEXT,                  -- vault note this was generated from
  source_chunk_hash TEXT,                 -- hash for staleness detection
  generated_at TEXT NOT NULL,

  -- SM-2 scheduling (per-activity)
  ease_factor REAL DEFAULT 2.5,
  interval_days INTEGER DEFAULT 1,
  repetitions INTEGER DEFAULT 0,
  due_at TEXT NOT NULL,
  last_reviewed TEXT,
  last_quality INTEGER,
  mastery_state TEXT DEFAULT 'new'        -- 'new' | 'learning' | 'reviewing' | 'mastered'
);
CREATE INDEX IF NOT EXISTS idx_activities_due ON learning_activities(due_at);
CREATE INDEX IF NOT EXISTS idx_activities_concept ON learning_activities(concept_id);
CREATE INDEX IF NOT EXISTS idx_activities_type ON learning_activities(activity_type);

-- ACTIVITY CONCEPTS -- join table for multi-concept activities
-- Used by comparison, synthesis, and cross-domain activities.
-- Replaces the previous related_concept_ids JSON field.
CREATE TABLE IF NOT EXISTS activity_concepts (
  activity_id TEXT NOT NULL REFERENCES learning_activities(id),
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  role TEXT DEFAULT 'related',            -- 'primary' | 'related' | 'comparison_target'
  PRIMARY KEY (activity_id, concept_id)
);

-- ACTIVITY LOG -- every interaction, every method
-- Granular enough for future FSRS migration and mastery computation.
-- Log everything; derive metrics later.

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES learning_activities(id),
  concept_id TEXT NOT NULL,               -- denormalized for fast concept queries
  activity_type TEXT NOT NULL,            -- denormalized for analytics
  bloom_level INTEGER NOT NULL,           -- denormalized for per-level analysis

  -- Student response
  quality INTEGER NOT NULL,               -- 0-5 (SM-2 scale)
  response_text TEXT,                     -- student's actual answer (for AI eval)
  response_time_ms INTEGER,              -- retrieval fluency proxy
  confidence_rating INTEGER,             -- pre-answer self-assessment (1-5)

  -- Evaluation
  scaffolding_level INTEGER DEFAULT 0,   -- 0-5 (how much help was needed)
  evaluation_method TEXT DEFAULT 'self_rated', -- 'self_rated' | 'ai_rated' | 'hybrid'
  ai_quality INTEGER,                    -- AI's quality assessment (for hybrid)
  ai_feedback TEXT,                       -- AI's specific feedback text

  -- Method used (for analytics: which methods work best)
  method_used TEXT,                       -- actual method type used in this interaction

  -- Context
  surface TEXT,                           -- 'dashboard_chat' | 'dashboard_ui' | 'telegram'
  session_id TEXT REFERENCES study_sessions(id),
  reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_concept ON activity_log(concept_id);
CREATE INDEX IF NOT EXISTS idx_log_session ON activity_log(session_id);
CREATE INDEX IF NOT EXISTS idx_log_bloom ON activity_log(bloom_level);

-- STUDY SESSIONS -- groups activities into study sessions
-- Enables Zimmerman's three-phase SRL cycle.

CREATE TABLE IF NOT EXISTS study_sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  session_type TEXT NOT NULL,             -- 'daily' | 'weekly' | 'monthly' | 'free'
  plan_id TEXT REFERENCES study_plans(id),

  -- Metacognition (Zimmerman 2002)
  pre_confidence TEXT,                    -- JSON: { concept_id: rating(1-5) }
  post_reflection TEXT,                   -- student's own words
  calibration_score REAL,                 -- correlation(confidence, performance)

  -- Session metrics
  activities_completed INTEGER DEFAULT 0,
  total_time_ms INTEGER,
  surface TEXT                            -- 'dashboard' | 'telegram'
);

-- STUDY PLANS -- collaborative learning contracts
-- Co-created through dialogue (Knowles 1975, Wiggins & McTighe backward design).
-- All fields except domain and concepts are optional -- the engine
-- uses sensible defaults for anything not provided.

CREATE TABLE IF NOT EXISTS study_plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  domain TEXT,                            -- primary domain, or NULL for cross-domain
  course TEXT,                            -- optional course tag
  strategy TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'exam-prep' | 'weekly-review' | 'exploration'

  -- Learning contract (Knowles 1975) -- all optional
  learning_objectives TEXT,               -- JSON array of Bloom's-tagged objectives
  desired_outcomes TEXT,                  -- "what will I be able to do?" (backward design)

  -- Commitment (Gollwitzer 1999, Oettingen WOOP) -- all optional
  implementation_intention TEXT,          -- "if X, then Y" commitment
  obstacle TEXT,                          -- identified barrier
  study_schedule TEXT,                    -- "weekdays after dinner, 25 min"

  -- Plan management
  config TEXT,                            -- JSON: exam_date, session_length_min, etc.
  checkpoint_interval_days INTEGER DEFAULT 14,
  next_checkpoint_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT DEFAULT 'active'            -- 'active' | 'completed' | 'archived'
);

-- Links plans to concepts
CREATE TABLE IF NOT EXISTS study_plan_concepts (
  plan_id TEXT NOT NULL REFERENCES study_plans(id),
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  target_bloom INTEGER DEFAULT 6,         -- target Bloom's level for this plan
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (plan_id, concept_id)
);
```

**Transaction requirement:** All multi-table writes (activity completion updating activity_log + learning_activities + concepts + study_sessions) MUST be wrapped in a SQLite transaction to prevent inconsistent state on partial failure.

### 3.2 Activity Types

```
activity_type values:

  card_review     -- Traditional SR card (cloze, basic Q&A, reversed)
                    Bloom's L1-L2. Recommended at low mastery.

  elaboration     -- "Why does this make sense?" prompt
                    Bloom's L2-L3.
                    Student explains causal reasoning.

  self_explain    -- Feynman technique prompt ("Explain X as if teaching someone")
                    Bloom's L2-L4.
                    Student produces full explanation, AI identifies gaps.

  concept_map     -- "List key concepts and their relationships"
                    Bloom's L2-L5.
                    Visual on dashboard, text-based fallback.

  comparison      -- "Compare X and Y along dimensions [a, b, c]"
                    Bloom's L4-L5.
                    Uses activity_concepts join table (2+ concepts).

  case_analysis   -- Real-world scenario requiring theory application
                    Bloom's L3-L6.
                    Multi-step: identify problem -> select framework -> analyze -> recommend.

  synthesis       -- "Integrate concepts A, B, C to address question Q"
                    Bloom's L5-L6.
                    Uses activity_concepts join table (2-3 concepts).

  socratic        -- Dialogue starter with guided question sequence
                    Bloom's L4-L6.
                    Primary surface: dashboard chat.
```

### 3.3 Activity Quality Rules

Every auto-generated activity must pass these checks before entering the schedule. Grounded in Wozniak's 20 Rules, Matuschak's 5 Attributes, and card design research.

**Wozniak's Minimum Information Principle:** Each activity tests ONE concept. If the reference answer exceeds ~15 words (for card_review type), split the activity.

**Matuschak's Five Attributes:**
1. **Focused** -- one concept per prompt
2. **Precise** -- produces a consistent answer over time
3. **Consistent** -- correct answer doesn't shift with context
4. **Tractable** -- answerable with effort (not impossible)
5. **Effortful** -- requires genuine retrieval (not trivially inferable)

**Anti-patterns to reject:**
- Yes/no questions (50% guessable, no retrieval effort)
- "List all X" prompts (sets are extremely hard to memorize -- break into individuals)
- Copy-paste from source text (encourages pattern-matching, not understanding)
- Orphan activities (single activity per concept -- always generate 2+ from different angles)
- Answer keywords in the question (enables pattern matching without recall)
- Answers longer than 15 words for card_review (split the card)

**Source traceability (Wozniak Rules 18-19):**
Every activity stores `source_note_path` and `source_chunk_hash`. This enables:
- Clicking through to the vault note during review
- Staleness detection when vault content changes
- Verification of AI-generated content against the source

---

## 4. Algorithms

### 4.1 SM-2 -- Per-Activity Scheduling

Carried forward from original spec. Pure function, ~50 lines.

```typescript
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

SM-2 is chosen over FSRS for simplicity. The activity_log schema stores all fields needed for future FSRS migration (quality, response_time_ms, ease_factor, interval_days per review).

### 4.2 Weighted Evidence Mastery -- Per-Concept, Per-Bloom's Level

Replaces BKT. Estimates mastery at each Bloom's level for each concept, updated after every activity. Transparent, interpretable, and doesn't require population data to converge.

```typescript
// Bloom's level weights -- higher levels contribute more evidence
const BLOOM_WEIGHTS = { 1: 1.0, 2: 1.5, 3: 2.0, 4: 2.5, 5: 3.0, 6: 4.0 };

// Mastery threshold -- evidence needed to consider a level "mastered"
const MASTERY_THRESHOLD = 10.0;

// Time decay -- recent evidence weighted more than old
const DECAY_HALF_LIFE_DAYS = 30;

function updateMastery(concept, activityLog) {
  // For each Bloom's level, compute weighted evidence
  for (let level = 1; level <= 6; level++) {
    const activities = activityLog.filter(a => a.bloom_level === level);
    let evidence = 0;

    for (const activity of activities) {
      const qualityWeight = activity.quality / 5.0;  // 0.0-1.0
      const daysSince = daysBetween(activity.reviewed_at, now);
      const timeDecay = Math.pow(0.5, daysSince / DECAY_HALF_LIFE_DAYS);

      evidence += qualityWeight * timeDecay;
    }

    concept[`mastery_L${level}`] = evidence;
  }

  // Overall mastery: weighted sum across levels
  concept.mastery_overall = sum(
    levels.map(l => Math.min(concept[`mastery_L${l}`] / MASTERY_THRESHOLD, 1.0) * BLOOM_WEIGHTS[l])
  ) / sum(Object.values(BLOOM_WEIGHTS));

  // Bloom ceiling: highest level with sufficient mastery
  concept.bloom_ceiling = highestLevel where
    concept[`mastery_L${level}`] / MASTERY_THRESHOLD >= 0.7;
}
```

**What this gives you:**
- Per-concept, per-Bloom's-level mastery visibility ("strong recall but weak application")
- Transparent scoring — you can see exactly why a concept shows 72% mastery
- Time decay means unused knowledge fades, driving spaced review
- bloom_ceiling drives activity recommendations (push the student to the next level)
- All raw data logged in activity_log for future metric derivation

### 4.3 Concept Progression Engine

The core logic that determines which activities to recommend for a concept. **Bloom's level is the progression axis; methods are recommended, not gated.**

```
For each active concept, compute bloom_ceiling from mastery evidence.

LEVEL RECOMMENDATIONS:

  Bloom's L1-L2 (Remember/Understand) — bloom_ceiling < 3
    Recommended activities: 3-5 SR cards, 2 elaboration prompts
    Evaluation: Self-rated
    Advancement: mastery_L1 and mastery_L2 reach threshold
    Rationale: Cepeda 2008 -- foundational facts retained before
    deeper methods build on them.

  Bloom's L3-L4 (Apply/Analyze) — bloom_ceiling 3-4
    Recommended activities: Feynman prompts, concept map tasks,
    comparison tasks, initial case analysis
    Evaluation: Self-rated + AI review (container agent via RAG)
    Advancement: mastery_L3 and mastery_L4 reach threshold
    Prerequisite awareness: flag if prerequisites have weak L1-L2
    Rationale: Chi 1994, Alfieri 2013 -- explanation and comparison
    build structural understanding.

  Bloom's L5-L6 (Evaluate/Create) — bloom_ceiling 5-6
    Recommended activities: Synthesis prompts, Socratic dialogue
    starters, complex case analysis, cross-concept comparison
    Evaluation: AI-rated (primary) -- complex free-text too hard
    to self-assess
    No further advancement -- maintain with spaced reviews.
    Rationale: Synthesis requires integration across mastered concepts.

SYNTHESIS RULES:
  Within-subdomain: Automatic when 2+ concepts have bloom_ceiling >= 4
  Within-domain: Automatic when concepts across subdomains have bloom_ceiling >= 4
  Cross-domain: Proposed in weekly summary, requires student confirmation

DE-ESCALATION GUIDANCE:
  If quality consistently < 3 and mastery evidence at a level is declining,
  the system recommends returning to lower-level activities for that concept.
  "Your recent case analyses on CLT suggest the foundational understanding
  could use reinforcement — want to do some elaboration exercises?"

ANY METHOD, ANY TIME:
  The student can always request any method for any concept via dashboard
  chat or free study mode. The system logs and updates mastery regardless
  of whether the activity was system-recommended.
```

### 4.4 Adaptive Scaffolding

Within each activity, scaffolding adapts based on the student's rolling performance (Vygotsky's ZPD, Wood et al. 1976).

```
Target success rate: 70-85% (the ZPD sweet spot)
  > 90% -> reduce scaffolding, recommend higher Bloom's level
  < 50% -> increase scaffolding, recommend simpler method
  70-85% -> maintain current level (in the zone)

Scaffolding levels (available for all activity types):
  Level 0: Activity prompt only (no hints)
  Level 1: Contextual hint ("Think about concept X")
  Level 2: Structural hint ("The answer involves three components...")
  Level 3: Partial solution ("The first step is...")
  Level 4: Worked example with similar problem
  Level 5: Full explanation + answer (last resort)
```

### 4.5 Session Builder

Builds a daily study session mixing methods, topics, and Bloom's levels. **The session is a recommendation — the student has full control to adjust.**

```
buildDailySession(student):
  1. Pull all activities with due_at <= now, sorted by:
     a. Overdue first
     b. Low ease_factor (struggling activities)
     c. Activity type variety

  2. Compose session in three blocks:

     NEW MATERIAL BLOCK (~30%, BLOCKED by topic)
       L1-L2 activities for recently added concepts.
       Grouped by topic to minimize extraneous cognitive load.
       Rationale: Hwang 2025 -- interleaving new material creates
       "undesirable difficulty." Block first, interleave later.

     REVIEW BLOCK (~50%, INTERLEAVED)
       Mix activity types across concepts and domains.
       Never 2 consecutive activities on same concept.
       Vary activity_type: card -> elaboration -> comparison -> card.
       Rationale: Cepeda 2006 -- interleaved review outperforms blocked.

     STRETCH BLOCK (~20%, highest available Bloom's)
       One higher-order activity (synthesis, case, or Socratic starter).
       Only if student has concepts at bloom_ceiling 4+.
       Rationale: Bjork 1994 -- desirable difficulties.

  3. Bookend with metacognition (Zimmerman 2002):
     PRE-SESSION: Confidence ratings, session goal
     POST-SESSION: Calibration feedback, reflection prompt

  4. Constraints:
     Target: 25-30 min OR 15-25 activities.
     Recommend not exceeding 50 min.
     At least 1 activity from each active domain when possible.

  5. Student adjustments:
     - Swap activities for similar Bloom's level alternatives
     - Request domain focus ("I want to focus on KM today")
     - Skip any activity or block
     - Switch to free study mode at any time
     System explains reasoning: "The stretch block targets L5-L6
     where your evidence is still building — recommended but optional."
```

### 4.6 Activity Generation Timing

```
Post-session generation (primary trigger):
  Student completes session
    -> Engine checks for Bloom's level advancements
    -> For each advanced concept: generate next-level activities
       via container agent (Claude + RAG)
    -> Activities stored with due_at based on SM-2 intervals
    -> Happens immediately in background
    -> Rate limit: max 10 concepts per cycle, queue remainder

Morning scheduled task (safety net, e.g. 06:00):
  -> Check for concepts missing activities at recommended level
  -> Generate if needed (respecting rate limit)
  -> Build today's session composition
  -> Send Telegram: "Good morning! 15 activities ready (~25 min)"
```

### 4.7 Weekly and Monthly Sessions

**Weekly session (triggered by scheduled task):**
- Cross-topic synthesis questions
- Higher Bloom's level assessments for concepts at bloom_ceiling 4+
- Concept map reconstruction from memory
- Weekly progress summary via Telegram
- Cross-domain synthesis suggestions (if applicable)
- Rationale: Bruner's spiral curriculum (1960)

**Monthly session (triggered by scheduled task):**
- Comprehensive mastery check across all active domains
- Identify decaying concepts (mastery evidence declining)
- Study plan checkpoint and adaptation dialogue
- Growth trajectory: Bloom's distribution over time, method effectiveness
- Rationale: Harden 1999

---

## 5. Collaborative Study Plan Creation

Study plans are not auto-generated. They are co-created through dialogue grounded in learning science. **The dialogue depth is optional — the minimum path is "I want to study X."**

### 5.1 Planning Dialogue (Flexible Depth)

The planning conversation adapts to what the student wants. The minimum is selecting concepts; the maximum is a full learning contract.

**Quick path (30 seconds):**
- "I want to study Knowledge Management models"
- System: "You have 8 concepts in KM Models, 3 untouched. Add all to a plan with default scheduling?"
- "Yes" → Plan created, activities generated.

**Standard path (5 minutes):**
- Concept selection + "Want to set a target date or just add to rotation?"
- If deadline: allocate time, set checkpoint
- "Any specific goals? Or should I push toward full Bloom's coverage?"

**Deep path (10+ minutes, optional):**
Uses the full framework when the student wants it:

1. **Discover (Needs Analysis + Backward Design):** "What do you want to learn and why?" → "When you're done, what will you be able to *do*?" (Wiggins & McTighe)
2. **Define (Goal-Setting + Bloom's):** Translate intent into Bloom's-tagged objectives (Locke & Latham). Offer choices for autonomy (Deci & Ryan SDT).
3. **Design (Sequencing + Scheduling):** Map objectives to concepts, prerequisites, timeline. Build in spaced practice. Set checkpoints every 2-3 weeks.
4. **Commit (WOOP + Implementation Intentions):** "When and where will you study?" → "What's most likely to get in the way?" (Gollwitzer 1999, Oettingen WOOP). Record in plan.
5. **Adapt (SRL Cycle):** At each checkpoint: reflect, compare against plan, propose adjustments (Zimmerman self-reflection).

The system asks "Want to go deeper?" at natural break points rather than forcing all 5 phases.

### 5.2 Where Planning Happens

The planning dialogue happens primarily on the **dashboard chat** (`/study/plan`). This is a focused conversation where the student sits down with the AI to co-create their learning path. The dashboard `/study` page shows the plan overview, progress, and upcoming checkpoints.

### 5.3 Concept Discovery and Approval

When new documents are ingested (upload or Zotero), new vault notes may represent concepts worth studying. The system auto-discovers these and supports batch approval:

```
Document uploaded / Zotero sync
  -> Chef Brockett generates vault notes
  -> Study engine detects new vault notes in concepts/
  -> Creates concept entries with status = 'pending'
  -> Pre-populates: title, domain/subdomain (from frontmatter),
     vault_note_path, suggested prerequisites (from wikilinks)
  -> Dashboard shows: "3 new concepts ready for review"
  -> Telegram morning message includes: "3 new concepts
     from yesterday's upload -- check dashboard to add them"

Student reviews on dashboard:
  -> Quick actions: [Add to study] [Skip] [Edit domain]
  -> Domain-batch action: [Approve all in "Knowledge Management"]
  -> "Add to study" -> status = 'active', generate L1-L2 activities
  -> "Skip" -> status = 'skipped' (stays in vault, not in study system)

Important: The study system's priorities are:
  1. Spaced revision of existing material (the core daily loop)
  2. New material from collaborative planning (student-directed)
  3. Auto-discovered concepts from ingestion (supplementary pool)
Auto-discovered concepts feed a pool of *available* concepts.
They don't enter active study unless pulled in during planning
or approved via domain batch.
```

---

## 6. Activity Generation

### 6.1 Generation Pipeline

When a concept advances to a new Bloom's level, a container agent generates appropriate activities.

```
Concept advances to new Bloom's level
  -> Query RAG for the concept's vault content (hybrid mode)
  -> Build generation prompt with:
     - Source content from vault
     - Bloom's level + recommended method instructions
     - Quality checklist (Wozniak + Matuschak rules)
     - Student's current knowledge map context
     - For comparison/synthesis: related concepts' content
  -> Container agent generates activities as structured JSON
  -> Quality filter (automated): reject anti-patterns
  -> Assign SM-2 initial parameters
  -> Store in learning_activities table
  -> Multi-concept activities: create activity_concepts entries
```

### 6.2 Bloom's-Level Generation Guidelines

**L1-L2 (Remember/Understand):** 3-5 cards per concept + 2 elaboration prompts
**L3-L4 (Apply/Analyze):** Feynman prompts, concept map tasks, comparison tasks, case starters
**L5-L6 (Evaluate/Create):** Synthesis prompts, Socratic dialogue starters, complex case scenarios

The generator can produce any activity type at any level — these are guidelines for the default generation prompt, not constraints.

### 6.3 LLM Prompting Strategy

Based on Matuschak's research on LLM card generation and Gossmann's benchmarks:
- **Analyze first, generate second:** LLM identifies key concepts and relationships before generating activities.
- **Specify card type explicitly:** Don't just say "make flashcards."
- **Supply the Bloom's level:** "Generate a Bloom's L3 (Apply) question."
- **Include quality criteria in the prompt:** Reference the Wozniak/Matuschak checklist.
- **Request multiple angles:** Different activities per concept.
- **Use structured JSON output:** Consistent parsing and metadata.
- **Avoid shallow pattern matching:** "Ensure question uses different vocabulary than answer."

### 6.4 Student-Generated Activities

Prompted at key moments where self-authoring is most valuable:
- After a Feynman session where the student struggled (captures personal gaps)
- When the student notices a connection the system hasn't made
- During dashboard chat after an illuminating exchange
- After reading a vault note (Nielsen's multi-pass Ankification)

Student-authored activities stored with `author = 'student'`, scheduled by SM-2 like any other. The dashboard chat agent helps refine self-authored activities against quality rules.

---

## 7. Dashboard Modules

### 7.1 Navigation

Add "Study" link to `dashboard/src/app/layout.tsx` nav bar, between "Vault" and "Read".

### 7.2 Study Overview (`/study`)

Shows: today's session (activity counts by type, estimated time, start button), concept progress (per concept: Bloom's ceiling, mastery bars per level), active plans (progress, upcoming checkpoints), pending concepts (from auto-discovery with domain-batch approval), and 7-day analytics (retention, calibration, Bloom's distribution, streak).

### 7.3 Dashboard Chat (`/study/chat`)

A proper conversational interface connected to a study-focused container agent via the existing web channel (HTTP + SSE). Supports:
- Multi-turn Feynman technique dialogues
- Socratic questioning sessions
- Case analysis discussions
- Synthesis conversations
- Collaborative plan creation/revision
- Session transcripts saved and linked to concepts

Extends the existing web channel (`src/channels/web.ts`) which already supports SSE streaming and session management. The key extension: persistent study conversations rather than one-off draft reviews.

### 7.4 Study Session (`/study/session`)

Handles all activity types with activity-type-specific UI:
- `card_review`: Question -> text input -> submit -> reference answer + quality rating
- `elaboration`: "Why?" prompt -> text input -> submit -> source reasoning + AI feedback
- `self_explain`: "Explain X" -> large text area -> submit -> AI gap analysis
- `concept_map`: Concept list -> relationship builder -> reference map
- `comparison`: Comparison matrix -> fill cells -> submit -> expert analysis
- `case_analysis`: Scenario -> multi-step response -> expert comparison
- `synthesis`: Integration prompt -> essay area -> AI feedback
- `socratic`: Redirects to dashboard chat for dialogue

Pre-session: Confidence ratings (Zimmerman forethought). Post-session: Calibration feedback, reflection prompt, session summary.

### 7.5 Concept Detail Page (`/study/concepts/[id]`)

Per-concept view: Bloom's level mastery breakdown (6-level bar chart), activity history, method effectiveness for this concept, related concepts, vault source link, "Generate more activities" button.

### 7.6 API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/study/plans` | GET | List plans with concept counts + progress |
| `/api/study/plans` | POST | Create plan from dialogue results |
| `/api/study/concepts` | GET | List concepts with mastery, Bloom's ceiling, due counts |
| `/api/study/concepts/pending` | GET | List pending concepts for approval |
| `/api/study/concepts/approve` | POST | Approve concept(s) — single or domain batch |
| `/api/study/session` | GET | Build today's session (mixed activities) |
| `/api/study/session` | POST | Create session record (pre-confidence) |
| `/api/study/complete` | POST | Complete activity (quality, response, time) |
| `/api/study/evaluate` | POST | Proxy answer to container agent for AI evaluation |
| `/api/study/stats` | GET | Analytics: retention, calibration, Bloom's dist |
| `/api/study/session/[id]/reflect` | POST | Save post-session reflection |

---

## 8. Audio & Podcast Generation

### 8.1 Purpose

Audio content serves as a **priming layer** -- passive exposure that activates concepts in working memory before the next active study session. Research on pre-training (Mayer 2002) supports this: exposure to key concepts before the main lesson reduces intrinsic cognitive load during the learning activity.

Audio does NOT replace active study. It supplements it for mobile/traveling contexts.

### 8.2 Implementation

```
Generation trigger:
  - On demand: student requests "generate podcast for [topic/plan]"
  - Scheduled: before weekly review, generate audio summaries
    of concepts due for review

Pipeline:
  1. Select concepts (from plan, or due this week)
  2. Claude generates a conversational script/summary from vault content
  3. TTS converts to audio (Mistral API, already configured)
  4. Send to Telegram via existing sendVoice() channel method
  5. Store audio path in metadata for re-listening

Content types:
  - Concept summary (5-10 min): overview of a topic and its key relationships
  - Review primer (3-5 min): quick recap of concepts due today
  - Weekly digest (10-15 min): synthesis of the week's learning themes
```

### 8.3 Delivery

Primary delivery via Telegram -- the student listens on their phone while traveling. Dashboard can also host an audio player for desktop listening. Audio files linked to concepts so the student can jump to active study after listening.

---

## 9. Agent Integration (Mr. Rogers / Study Agent)

### 9.1 Two Agent Roles

**Study Agent (container, dashboard chat):** Handles deep conversational methods. Spun up when the student opens `/study/chat` and stays alive for the session. Has access to vault via RAG, student profile, and study system state via IPC. Handles: Feynman, Socratic, case discussion, plan dialogue, AI evaluation.

**Mr. Rogers (container, Telegram):** Mobile companion. Handles: daily reminders and nudges, quick card review, light elaboration, progress summaries, podcast delivery, concept discovery alerts. Already exists; needs study system IPC integration.

### 9.2 IPC Task Contract

```typescript
// Complete an activity (from either agent)
{ type: 'study_complete', activityId, quality, responseTimeMs?,
  responseText?, surface: 'dashboard_chat' | 'telegram' }

// Request today's due activities
{ type: 'study_session', limit?, preferredTypes? }

// Request concept status
{ type: 'study_concept_status', conceptId?, domain? }

// Trigger activity generation for advanced concepts
{ type: 'study_generate', conceptId, bloomLevel }
```

### 9.3 Scheduled Tasks

**Daily (morning, cron):**
- Run activity generation for any gaps (safety net, respecting rate limit)
- Build today's session composition
- Send via Telegram: "Your session is ready -- 15 activities, ~25 min"
- Nudge if yesterday's session was skipped (encouraging, not guilt-inducing)

**Weekly (Sunday evening, cron):**
- Progress summary: retention rate, concepts advanced, Bloom's distribution
- Cross-domain synthesis suggestions (if applicable)
- Plan checkpoint reminder (if due)

**Monthly (1st of month, cron):**
- Comprehensive mastery review
- Decay detection (mastery evidence declining)
- Growth trajectory snapshot
- Plan adaptation recommendation

---

## 10. Learning Analytics

### 10.1 Key Metrics

| Metric | Computation | What It Tells You |
|--------|------------|-------------------|
| Retention rate | correct_reviews / total_reviews | Overall recall effectiveness |
| Calibration score | pearson(confidence, actual_quality) | Metacognitive accuracy |
| Per-level mastery | mastery_L1 through mastery_L6 per concept | Understanding depth at each Bloom's level |
| Time to level | avg days to reach each Bloom's ceiling | Learning velocity |
| Decay rate | regression slope of quality between reviews | Concept-specific forgetting |
| Scaffolding dependency | avg scaffolding_level per concept | Concepts needing more support |
| Method effectiveness | avg quality after each method type | What works for this student |
| Bloom's distribution | % of activities at each level | Depth of engagement |

### 10.2 Understanding vs. Memorization Detection

The per-level mastery breakdown directly shows this. If a concept has strong mastery_L1 and mastery_L2 but weak mastery_L4+, the student is memorizing without developing understanding. The system recommends more explanation, comparison, and application activities.

All raw data (quality scores, Bloom's levels, methods, response times, confidence ratings, timestamps) is logged in activity_log. Future metrics can be derived retroactively from this data without schema changes.

---

## 11. Implementation Phases

### Phase 1: Core Engine + Cards (MVP)
- [ ] Add all tables to `src/db.ts` (with transaction helpers)
- [ ] Implement SM-2 in `src/study/sm2.ts` (pure functions)
- [ ] Implement weighted evidence mastery in `src/study/mastery.ts` (pure functions)
- [ ] Build concept progression engine in `src/study/engine.ts` (L1-L3 recommendations)
- [ ] Build activity generator in `src/study/generator.ts` (cards + elaboration)
- [ ] Build session builder (new material block + review block)
- [ ] Write comprehensive tests
- [ ] Create dashboard `/study` page with concept list, Bloom's mastery bars, due counts
- [ ] Create dashboard `/study/session` page (card_review + elaboration)
- [ ] Wire core API routes (including domain-batch concept approval)
- [ ] Add daily reminder scheduled task (Telegram)
- [ ] Add concept discovery queue (pending concepts from ingestion)

### Phase 2: Deep Methods + Dashboard Chat
- [ ] Add L4-L6 activity generation for all types
- [ ] Build dashboard chat interface (`/study/chat`) extending web channel
- [ ] Implement Feynman and Socratic dialogue in study agent
- [ ] Build comparison matrix and concept map UI
- [ ] Expand session builder with stretch block
- [ ] Wire AI evaluation for L3+ (container agents, session-persistent)
- [ ] Add weekly scheduled task

### Phase 3: Planning + Metacognition
- [ ] Build collaborative planning dialogue (`/study/plan`)
- [ ] Implement flexible-depth planning framework in `src/study/planner.ts`
- [ ] Add pre/post session confidence tracking and calibration
- [ ] Build analytics dashboard
- [ ] Implement scaffolding hint system (5 levels)
- [ ] Add plan checkpoints and adaptation dialogue
- [ ] Add monthly scheduled task
- [ ] Concept detail page

### Phase 4: Audio + Mobile + Refinement
- [ ] Audio/podcast generation pipeline (`src/study/audio.ts`)
- [ ] Telegram podcast delivery
- [ ] Wire Mr. Rogers IPC for study system
- [ ] Student-generated activity prompting in dashboard chat
- [ ] Post-session activity generation (automatic, rate-limited)
- [ ] Prerequisite awareness flags for L4+ activities
- [ ] Staleness detection (source_chunk_hash)
- [ ] Vault note deletion handling (archive linked concepts)
- [ ] RSVP vault integration (deep-link from activities)
- [ ] FSRS migration evaluation

---

## 12. Future Considerations

These are noted for later implementation, not designed in detail now:

- **Data backup:** Periodic SQLite backup (cron job). Critical once learning history accumulates. Address during Mac Mini deployment.
- **Vault note deletion:** When a vault note is deleted, mark linked concepts as `archived` rather than deleting — learning history remains valuable. The ingestion pipeline already watches the vault.
- **Offline/degraded mode:** Dashboard could work read-only without the main process (show due cards, self-rate, queue completions). Low priority — launchd auto-start handles the common case.
- **Export:** Anki-compatible export of SR cards for portability. CSV export of learning history.

---

## 13. Vault Knowledge Gaps

RAG searches revealed the vault lacks content on core learning science:

**Missing (high priority):**
- Spaced repetition algorithms and research (Ebbinghaus, Cepeda, Wozniak)
- Active recall / testing effect (Roediger & Karpicke 2006, Karpicke 2012)
- Bloom's Taxonomy revised (Anderson & Krathwohl 2001)
- Mastery learning (Bloom 1968)
- Zone of Proximal Development (Vygotsky 1978)
- Interleaving and distributed practice (Cepeda 2006)
- Self-regulated learning (Zimmerman 2002)
- Bruner's spiral curriculum (1960)

**Already in vault (leverage these):**
- Cognitive Load Theory (Sweller, well-covered)
- Working memory and concept formation (Cowan 2014)
- Knowledge construction and comprehension
- Formative assessment and feedback loops
- Learning analytics and adaptive learning

---

## 14. Sources

### Learning Science Foundations
- Dunlosky, J. et al. (2013). Improving students' learning with effective techniques. *Psychological Science in the Public Interest*, 14(1), 4-58
- Karpicke, J.D. & Blunt, J.R. (2011). Retrieval practice produces more learning than elaborative studying. *Science*, 331(6018), 772-775
- Karpicke, J.D. (2012). Retrieval-based learning. *Current Directions in Psychological Science*, 21(3), 157-163
- Bjork, R.A. (1994). Memory and metamemory considerations in training. *Metacognition*
- Bjork, E.L. & Bjork, R.A. (2011). Making things hard on yourself, but in a good way. *Psychology and the Real World*
- Kosmyna, N. et al. (2025). Your brain on ChatGPT: Cognitive debt from AI use. *Nature*
- Sweller, J. (1988). Cognitive load during problem solving. *Cognitive Science*, 12(2), 257-285
- Mayer, R.E. (2002). Cognitive Theory of Multimedia Learning. *Cambridge Handbook of Multimedia Learning*
- Zimmerman, B.J. (2002). Becoming a self-regulated learner. *Theory Into Practice*, 41(2), 64-70
- Bloom, B.S. (1968). Learning for mastery. *Evaluation Comment*, 1(2), 1-12
- Cepeda, N.J. et al. (2008). Spacing effects in learning. *Psychological Science*, 19(11), 1095-1102

### Method-Specific Research
- Pressley, M. et al. (1987). Elaborative interrogation facilitates acquisition of confusing facts. *Journal of Educational Psychology*
- Chi, M.T.H. et al. (1994). Eliciting self-explanations improves understanding. *Cognitive Science*, 18(3), 439-477
- Nestojko, J.F. et al. (2014). Expecting to teach enhances learning. *Memory & Cognition*, 42, 1038-1048
- Novak, J.D. & Gowin, D.B. (1984). *Learning How to Learn*. Cambridge University Press
- Nesbit, J.C. & Adesope, O.O. (2006). Learning with concept and knowledge maps. *Review of Educational Research*
- Alfieri, L. et al. (2013). Learning through case comparisons. *Educational Psychologist*, 48(2), 87-113
- Gentner, D. (1983). Structure-mapping: A theoretical framework for analogy. *Cognitive Science*, 7(2), 155-170
- Nkhoma, M. et al. (2016). Unpacking the revised Bloom's taxonomy in CBL. *Education + Training*
- Hwang, H. (2025). Undesirable difficulty of interleaved practice. *Language Learning*
- Wood, D., Bruner, J.S. & Ross, G. (1976). The role of tutoring in problem solving. *JCPP*, 17(2), 89-100
- Vygotsky, L.S. (1978). *Mind in Society*. Harvard University Press
- Bruner, J.S. (1960). *The Process of Education*. Harvard University Press

### Study Plan Design
- Knowles, M. (1975). *Self-Directed Learning: A Guide for Learners and Teachers*
- Wiggins, G. & McTighe, J. (2005). *Understanding by Design* (2nd ed.). ASCD
- Locke, E.A. & Latham, G.P. (2002). Building a practically useful theory of goal setting. *American Psychologist*, 57(9), 705-717
- Gollwitzer, P.M. (1999). Implementation intentions: Strong effects of simple plans. *American Psychologist*, 54(7), 493-503
- Oettingen, G. (2012). Future thought and behaviour change. *European Review of Social Psychology*, 23(1), 1-63
- Deci, E.L. & Ryan, R.M. (2000). Self-determination theory. *Contemporary Educational Psychology*, 25(1), 54-67
- Dweck, C.S. (1986). Motivational processes affecting learning. *American Psychologist*, 41(10), 1040-1048

### Card Design
- Wozniak, P. (1999). 20 Rules of Formulating Knowledge (supermemo.com)
- Matuschak, A. (2020). How to write good prompts (andymatuschak.org/prompts)
- Nielsen, M. (2018). Augmenting long-term memory (augmentingcognition.com)

### AI Tutoring
- UK RCT 2025 -- AI Socratic tutors in classrooms (arXiv: 2512.23633)
- ECAI 2024 -- Socratic chatbot for critical thinking (arXiv: 2409.05511)
- Gossmann, A. -- Comparing LLMs for flashcard generation (alexejgossmann.com)

### Algorithms
- Wozniak, P. (1987). SM-2 algorithm (SuperMemo)

---

## 15. Open Questions — All Resolved

1. **Activity generation timing** — Batch per Bloom's level advancement. Post-session generation (primary) + morning safety net. Rate limited to 10 concepts per cycle.
2. **Cross-domain synthesis** — Graduated: within-domain automatic (bloom_ceiling 4+), cross-domain proposed and confirmed by student.
3. **AI evaluation threshold** — Self-rated for L1-L2; self-rated + AI review for L2-L3; AI-rated for L4-L6. Container agents via Claude Max subscription (no API cost). Single container reused per session.
4. **Dashboard vs. Telegram** — Dashboard chat is primary for deep work (Feynman, Socratic, cases, planning). Telegram is mobile companion (reminders, quick review, podcasts). Mr. Rogers nudges actively but doesn't restrict.
5. **Student-generated activities** — Prompted at key moments (post-struggle, post-insight, post-reading). Not always available, but actively suggested when valuable.
6. **Session flexibility** — AI-recommended with full student control. System builds session, shows reasoning, suggests strongly. Student can adjust anything — swap activities, skip blocks, switch to free study. No enforcement, no guilt mechanics. Balances autonomy (Deci & Ryan SDT) with desirable difficulties (Bjork) through transparent communication.
7. **Concept approval** — Domain-batch approval supported. Auto-discovered concepts enter a pool; they don't enter active study without student action. System priorities: revision > planned new material > discovered concepts.
8. **Planning depth** — Optional. Minimum: select concepts + defaults. Maximum: full 5-phase learning contract. Engine handles missing fields with sensible defaults.
