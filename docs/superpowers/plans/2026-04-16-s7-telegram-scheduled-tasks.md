# S7: Telegram + Scheduled Tasks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Your role:** You are the engineer implementing this. The plan tells you *what* to build and *why*. You decide *how* within the stated constraints. If you disagree with an approach or see a better alternative, flag it before implementing — don't silently deviate and don't silently comply with something you think is wrong.

**Goal:** Add study-aware scheduled tasks (daily morning summary, weekly progress, monthly mastery review), quick card review via Telegram (Mr. Rogers picks due cards, student responds, agent evaluates via IPC), remaining study IPC handlers, SQLite backup rotation, and Mr. Rogers study integration.

**Architecture:** S7 builds on top of the existing task scheduler (`src/task-scheduler.ts`), IPC system (`src/ipc.ts`), and Telegram channel (`src/channels/telegram.ts`). Scheduled study tasks are plain `scheduled_tasks` DB rows with cron patterns — a new `src/study/scheduled.ts` module builds the task prompts and a setup function registers them. Mr. Rogers gets study awareness via CLAUDE.md updates and uses existing `study_complete` IPC (S5.9) for quick review evaluation. The SQLite backup is a standalone cron task with shell script.

**Tech Stack:** TypeScript/Node.js (backend), NanoClaw task scheduler (cron), Telegram via grammY, Vitest (tests)

**Branch:** Create `feat/s7-telegram-scheduled` off `main`. S6 merged via PR #33.

**Spec:** `docs/superpowers/specs/2026-04-12-multi-method-study-system-design.md` (Section 9)

**Master plan:** `docs/superpowers/plans/2026-04-13-study-system-master-plan.md` (S7 checklist)

---

## Codebase Conventions (Hard Constraints)

These apply to **every task**. Subagents must follow these — they're not obvious from context alone.

1. **`.js` extensions on all relative imports in `src/`.** The backend uses Node ESM resolution. Write `import { foo } from './bar.js'`, not `'./bar'`. **Exception:** Dashboard (`dashboard/src/`) does NOT use `.js` extensions — Next.js handles resolution.
2. **camelCase Drizzle properties in `src/db/schema/*.ts`**, snake_case SQL column names.
3. **Drizzle query builder operators** (`eq`, `and`, `lte`, `desc`, `asc`, `count`, `sql`, `inArray`, `gte`) — not raw SQL strings.
4. **Commit messages** use conventional commits: `feat(study):`, `feat(dashboard):`.
5. **Test file locations:** Backend tests are colocated: `src/study/foo.test.ts`. Use `_initTestDatabase()` from `../db/index.js` (or `../db.js`) to set up the test DB. Import from `./foo.js` (ESM extension rule applies in tests too).
6. **Study query functions** live in `src/study/queries.ts` (not `src/db.ts`). Study modules that need `getDb()` import it from `../db/index.js`. Non-study DB functions (like `createTask`) are imported from `../db.js`.
7. **IPC handlers** go in the `processTaskIpc` switch/case in `src/ipc.ts`. Follow the existing validation + logging patterns (see `study_complete` and `study_concept_status` cases for reference).
8. **Scheduled tasks** use the `createTask()` function from `src/db.js`. Tasks need: `id`, `group_folder`, `chat_jid`, `prompt`, `schedule_type: 'cron'`, `schedule_value` (cron expression), `context_mode: 'isolated'`, `next_run`, `status: 'active'`, `created_at`. The task scheduler (`src/task-scheduler.ts`) picks up due tasks automatically. Cron uses the `cron-parser` library with `TIMEZONE` from config.
9. **Mr. Rogers CLAUDE.md** is at `groups/telegram_main/CLAUDE.md`. Telegram formatting: `*bold*` (single asterisks only), `_italic_`, `•` bullets. No `##` headings, no `**double stars**`, no `[links](url)`.

---

## Spec Deviations

- **No `study_generate` IPC handler.** The master plan S7.1 calls for `study_generate` to trigger generation from Telegram. The existing `study_generation_request` IPC type (added in S3.8) already does this — same concept ID + bloom level payload. **Why:** Avoid duplicating functionality. Mr. Rogers can use `study_generation_request` directly.
- **Quick review is prompt-based, not real-time interactive.** The spec describes Mr. Rogers sending individual card prompts and evaluating responses in real-time. S7 implements this as: the scheduled morning task prompt tells Mr. Rogers which cards are due and instructs it to pick 3-5 for quick review during the conversation. When the student responds, Mr. Rogers evaluates in-context (it has vault access via RAG) and logs via `study_complete` IPC. **Why:** This is how Telegram agent interactions already work — the agent receives context in the prompt and responds conversationally. No new real-time mechanism needed.
- **Backup uses SQLite `.backup` CLI command, not WAL checkpoint + cp.** The spec mentions SQLite's `.backup` command. S7 uses `sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"` which is atomically safe even while the NanoClaw process is writing. **Why:** `.backup` acquires a shared lock, copies all pages consistently, and handles WAL automatically — simpler and safer than checkpoint + `cp` which could miss concurrent writes. **Dependency:** Requires `sqlite3` CLI tool installed (standard on macOS, `apt install sqlite3` on Linux).

---

## Key Decisions

### D1: Scheduled tasks are registered via a setup function, not IPC
`src/study/scheduled.ts` exports a `registerStudyScheduledTasks()` function that checks if study tasks exist in the DB and creates them if missing. Called from `src/index.ts` at startup (after migrations, before scheduler loop). Idempotent — safe to call every startup.

**Why not IPC?** IPC task creation requires a running container agent. Study scheduled tasks are infrastructure — they should exist without needing to ask Mr. Rogers to create them. The setup function guarantees they exist.

**Tradeoff:** If the task prompts need updating, the code must change and redeploy. Acceptable — prompt changes are infrequent and should be version-controlled anyway.

### D2: Task prompts are built dynamically at registration time
Each task's `prompt` field contains a template that instructs Mr. Rogers what to do. The prompt includes study-specific context (e.g., "Check for due activities, report concept alerts"). The agent then queries the DB via its mounted read-only project access and RAG to build the actual message.

**Why not pre-build data in the prompt?** The task prompt is stored once in the DB. The data (due counts, concept alerts) changes daily. The agent needs to compute fresh data each time it runs.

### D3: SQLite backup is an agent task with a simple prompt
The backup task is a regular scheduled task. The agent runs the backup shell commands (SQLite `.backup`, rotation) via bash in its container sandbox. The prompt tells the agent exactly what commands to run — no judgment needed.

**Why not a standalone cron job?** Keeping all scheduled tasks in the NanoClaw task scheduler gives visibility (task run logs, status tracking) and consistency. The agent overhead (~30s container startup) is acceptable for a once-daily task at 03:00.

**Why not a `script` field?** The task scheduler's `script` field (which runs a pre-check before waking the agent) does not currently support running scripts that skip the agent entirely. The `wakeAgent: false` pattern described in container CLAUDE.md docs is for IPC task scripts, not the host-side task scheduler. Using a regular prompt keeps the implementation simple and reliable.

### D4: Mr. Rogers quick review piggybacks on existing conversation flow
No new endpoints or real-time card delivery mechanism. Mr. Rogers sends card prompts as regular Telegram messages during the morning task. The student responds naturally. Mr. Rogers evaluates and logs via `study_complete` IPC.

**Why?** This is how Mr. Rogers already works — it receives a task prompt, interacts with the student, and logs results. Quick review is just a specific prompt pattern, not new infrastructure.

---

## Essential Reading

> **For coordinators:** Extract relevant patterns from these files and inline them into subagent prompts. Subagents won't read the files themselves.

| File | Why |
|------|-----|
| `src/task-scheduler.ts` | How scheduled tasks are picked up and executed. `runTask()` spawns containers. |
| `src/ipc.ts:291-984` | `processTaskIpc()` switch/case — S7 adds `study_session` case here. Existing `study_generation_request` already covers what master plan calls `study_generate`. |
| `src/db.ts:1-3` (re-exports) + `src/db/index.ts:332-350` | `createTask()` function signature and usage. |
| `src/types.ts:58-72` | `ScheduledTask` interface — required fields for task creation. |
| `src/config.ts:119-132` | `TIMEZONE` used by cron parser, `STORE_DIR` for backup path. |
| `src/study/queries.ts:168-176` | `getDueActivities()` — fetches activities with `dueAt <= today`. Used in morning task data. |
| `src/study/queries.ts:451-479` | `getActivePlans()`, `removeConceptFromPlan()`, `getPlanConceptIds()` — plan queries for weekly summary. |
| `src/study/engine.ts` | `processCompletion()` and `triggerPostSessionGeneration()` — used by `study_complete` IPC. |
| `groups/telegram_main/CLAUDE.md` | Current Mr. Rogers prompt — S7 adds a study section. |
| `src/study/session-builder.ts` | `buildDailySession()` — used to compute morning session data. |

---

## Task Numbering

| Plan task | Master plan items | What |
|-----------|-------------------|------|
| S7.1 | S7.2 | `src/study/scheduled.ts` — scheduled task builders + registration |
| S7.2 | S7.3 | Register scheduled tasks at startup in `src/index.ts` |
| S7.3 | S7.5 | SQLite backup scheduled task (script-based) |
| S7.4 | S7.4 | Mr. Rogers study integration — update CLAUDE.md |
| S7.5 | S7.1 (partial) | Remaining study IPC handler: `study_session`. `study_generate` covered by existing `study_generation_request` (S3.8). |
| S7.6 | — | Tests + verification |

---

## Parallelization & Model Recommendations

**Dependencies:**
- S7.1 is independent (new file, no other task depends on it except S7.2 and S7.3)
- S7.2 depends on S7.1 (startup registration calls the functions from scheduled.ts)
- S7.3 depends on S7.1 (adds backup task definition to `scheduled.ts` created by S7.1)
- S7.4 is independent (CLAUDE.md file edit, no code dependencies)
- S7.5 is independent (IPC handler addition, no dependency on scheduled tasks)
- S7.6 depends on all previous tasks

**Parallel opportunities:**
- **Wave 1:** S7.1 + S7.4 + S7.5 (all independent)
- **Wave 2:** S7.2 + S7.3 (both depend on S7.1 but not each other — S7.2 modifies `index.ts`, S7.3 modifies `scheduled.ts`)
- **Wave 3:** S7.6 (verification)

| Task | Can parallel with | Model | Rationale |
|------|-------------------|-------|-----------|
| S7.1 | S7.4, S7.5 | Sonnet | Mechanical query composition + task creation |
| S7.2 | S7.3 | Sonnet | Small wiring change in index.ts |
| S7.3 | S7.2 | Sonnet | Small addition to scheduled.ts |
| S7.4 | S7.1, S7.5 | **Opus** | Creative writing — study pedagogy needs judgment |
| S7.5 | S7.1, S7.4 | Sonnet | Follows existing IPC handler pattern |
| S7.6 | — | Sonnet | Mechanical verification |

**File ownership for Wave 1 parallel agents:**
- **S7.1 agent:** Owns `src/study/scheduled.ts` (create), `src/study/scheduled.test.ts` (create). Do NOT touch `src/index.ts`, `src/ipc.ts`, or `groups/telegram_main/CLAUDE.md`.
- **S7.4 agent:** Owns `groups/telegram_main/CLAUDE.md`. Do NOT touch any `.ts` files.
- **S7.5 agent:** Owns `src/ipc.ts` (modify — add `study_session` case only). Do NOT touch `src/study/scheduled.ts`, `src/index.ts`, or `groups/telegram_main/CLAUDE.md`.

**File ownership for Wave 2 parallel agents:**
- **S7.2 agent:** Owns `src/index.ts` (modify — add registration call). Do NOT touch `src/study/scheduled.ts`.
- **S7.3 agent:** Owns `src/study/scheduled.ts` (modify — add backup task definition), `src/study/scheduled.test.ts` (modify — update task count). Do NOT touch `src/index.ts`.

---

## S7.1: Scheduled Task Builders + Registration

**Files:** Create `src/study/scheduled.ts`, create `src/study/scheduled.test.ts`

**Parallelizable with S7.3, S7.4, S7.5.**

### What this module does

Exports functions that build scheduled task configurations and a registration function that ensures they exist in the DB. Each "builder" function composes a prompt string for Mr. Rogers containing the task context (what to do, what data to check). The scheduler spawns Mr. Rogers' container with this prompt when the cron fires.

### Task definitions

**1. Morning daily task (`study-daily-morning`)**
- **Cron:** `0 7 * * *` (07:00 daily, local timezone)
- **Group:** `telegram_main`
- **Prompt:**

```
You are running the morning study task. Do the following:

1. Query the study database to find today's study session:
   - Read /workspace/project/store/messages.db
   - Count learning_activities where due_at <= today's date
   - Count concepts where status = 'pending' and created_at >= yesterday

2. Check for pending concepts:
   - Query: SELECT count(*) FROM concepts WHERE status = 'pending'
   - If any pending, note how many new concepts are waiting for review

3. Check active plans for checkpoint dates:
   - Query: SELECT title, next_checkpoint_at FROM study_plans WHERE status = 'active' AND next_checkpoint_at <= date('now', '+2 days')
   - Note any upcoming checkpoints

4. Send a morning study message to the user with:
   - How many activities are due today (e.g., "15 activities ready (~25 min)")
   - If there are pending concepts: "N new concepts waiting for review on the dashboard"
   - If a plan checkpoint is upcoming: "Checkpoint coming up for [plan title]"
   - A brief encouraging note

Keep the message concise — 3-5 lines max. Use Telegram formatting (*bold* for emphasis, • for bullets). Do NOT use ## headings or **double asterisks**.

If there are 3-5 card_review activities due, offer a quick review: pick the most overdue ones and present them as questions. Wait for the student to respond, evaluate their answers against the reference_answer column, then log each via study_complete IPC with your quality assessment (0-5).
```

**2. Weekly progress task (`study-weekly-progress`)**
- **Cron:** `0 18 * * 0` (Sunday 18:00)
- **Group:** `telegram_main`
- **Prompt:**

```
You are running the weekly study progress task. Do the following:

1. Query the study database for this week's activity:
   - Read /workspace/project/store/messages.db
   - Count activity_log entries from the past 7 days: SELECT count(*) FROM activity_log WHERE reviewed_at >= date('now', '-7 days')
   - Average quality this week: SELECT avg(quality) FROM activity_log WHERE reviewed_at >= date('now', '-7 days')
   - Bloom level distribution: SELECT bloom_level, count(*) FROM activity_log WHERE reviewed_at >= date('now', '-7 days') GROUP BY bloom_level

2. Check concept progression:
   - Concepts that advanced bloom_ceiling this week (compare against activity_log timestamps)
   - Active plan progress: SELECT title, status FROM study_plans WHERE status = 'active'

3. Check for synthesis opportunities:
   - Concepts with bloom_ceiling >= 4 in the same domain that could benefit from cross-concept synthesis

4. Send a weekly summary message:
   - Activities completed this week and average quality
   - Which Bloom's levels were practiced
   - Any concepts that advanced
   - Plan progress if applicable
   - Synthesis suggestions if applicable
   - Encouragement and suggestion for next week's focus

Keep it conversational and under 10 lines. Use Telegram formatting.
```

**3. Monthly mastery review task (`study-monthly-mastery`)**
- **Cron:** `0 10 1 * *` (1st of month, 10:00)
- **Group:** `telegram_main`
- **Prompt:**

```
You are running the monthly mastery review task. Do the following:

1. Query comprehensive mastery state:
   - Read /workspace/project/store/messages.db
   - All active concepts with their mastery levels: SELECT title, domain, bloom_ceiling, mastery_overall, mastery_L1, mastery_L2, mastery_L3, mastery_L4, mastery_L5, mastery_L6 FROM concepts WHERE status = 'active' ORDER BY domain, mastery_overall DESC
   - Activity count by month: SELECT strftime('%Y-%m', reviewed_at) as month, count(*) FROM activity_log GROUP BY month ORDER BY month DESC LIMIT 3

2. Detect mastery decay:
   - Concepts where mastery_overall has decreased or bloom_ceiling is low relative to activity age
   - Concepts with no activity_log entries in the past 30 days (at risk of decay)

3. Growth trajectory:
   - How many concepts are at each bloom_ceiling level (distribution)
   - Compare with last month if data available

4. Plan status:
   - Active plans: progress toward target bloom for each concept
   - Completed or stale plans

5. Send a monthly review message:
   - Overall stats: total active concepts, bloom distribution
   - Decay alerts: concepts losing mastery (need review)
   - Growth highlights: concepts that advanced significantly
   - Plan progress
   - Recommended focus areas for the coming month

Keep it informative but concise — max 15 lines. Use Telegram formatting.
```

### Registration function

```typescript
import { CronExpressionParser } from 'cron-parser';
import { createTask, getTaskById } from '../db.js';
import { TIMEZONE } from '../config.js';
import { logger } from '../logger.js';

interface StudyTaskDefinition {
  id: string;
  prompt: string;
  cronExpression: string;
  groupFolder: string;
  chatJid: string;
  script?: string;
}

function getStudyTaskDefinitions(mainChatJid: string): StudyTaskDefinition[] {
  return [
    {
      id: 'study-daily-morning',
      prompt: MORNING_PROMPT,  // the morning prompt string above
      cronExpression: '0 7 * * *',
      groupFolder: 'telegram_main',
      chatJid: mainChatJid,
    },
    {
      id: 'study-weekly-progress',
      prompt: WEEKLY_PROMPT,
      cronExpression: '0 18 * * 0',
      groupFolder: 'telegram_main',
      chatJid: mainChatJid,
    },
    {
      id: 'study-monthly-mastery',
      prompt: MONTHLY_PROMPT,
      cronExpression: '0 10 1 * *',
      groupFolder: 'telegram_main',
      chatJid: mainChatJid,
    },
  ];
}

/**
 * Idempotent registration: creates study scheduled tasks if they don't exist.
 * Call at startup after DB migrations.
 * @param mainChatJid — the Telegram main group JID (e.g., 'tg:123456')
 */
export function registerStudyScheduledTasks(mainChatJid: string): void {
  const definitions = getStudyTaskDefinitions(mainChatJid);

  for (const def of definitions) {
    const existing = getTaskById(def.id);
    if (existing) {
      logger.debug({ taskId: def.id }, 'Study scheduled task already exists, skipping');
      continue;
    }

    const interval = CronExpressionParser.parse(def.cronExpression, { tz: TIMEZONE });
    const nextRun = interval.next().toISOString();

    createTask({
      id: def.id,
      group_folder: def.groupFolder,
      chat_jid: def.chatJid,
      prompt: def.prompt,
      script: def.script || null,
      schedule_type: 'cron',
      schedule_value: def.cronExpression,
      context_mode: 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logger.info({ taskId: def.id, nextRun }, 'Registered study scheduled task');
  }
}
```

**Agent discretion:** Exact prompt wording, how to structure the prompt constants (template literals or separate const strings), whether to extract shared prompt preamble.

### Tests

Test `registerStudyScheduledTasks()`:
1. Call with a test DB — verify 3 tasks created with correct IDs, cron patterns, and group_folder
2. Call again — verify idempotent (no duplicates, no errors)
3. Verify each task's `next_run` is a valid future ISO date
4. Verify `schedule_type` is `'cron'` for all tasks

**Constraint:** Tests must use `_initTestDatabase()` from `../db/index.js` (or `../db.js`) to set up the test DB. Follow the pattern in `src/study/queries.test.ts`. Import `getTaskById` and `getAllTasks` from `../db.js` (with `.js` extension).

- [ ] **Step 1:** Create `src/study/scheduled.ts` with the three prompt constants (morning, weekly, monthly) and `getStudyTaskDefinitions()` function
- [ ] **Step 2:** Implement `registerStudyScheduledTasks()` in the same file
- [ ] **Step 3:** Write test in `src/study/scheduled.test.ts`: register creates 3 tasks
- [ ] **Step 4:** Run test: `npm test -- src/study/scheduled.test.ts` — verify pass
- [ ] **Step 5:** Write test: second call is idempotent (no duplicates)
- [ ] **Step 6:** Run test — verify pass
- [ ] **Step 7:** Run full test suite: `npm test` — no regressions
- [ ] **Step 8:** Verify: `npm run build` — clean
- [ ] **Step 9:** Commit: `feat(study): add scheduled task builders and registration (S7.1)`

---

## S7.2: Register Scheduled Tasks at Startup

**Files:** Modify `src/index.ts`

**Depends on:** S7.1.

### What to change

In `src/index.ts`, after DB initialization (migrations) and after group registration, call `registerStudyScheduledTasks()`. The main chat JID for the Telegram main group must be found from registered groups.

**Pattern:**

```typescript
import { registerStudyScheduledTasks } from './study/scheduled.js';

// After groups are loaded and before scheduler loop starts.
// src/index.ts already has a module-level `registeredGroups` variable
// populated from getAllRegisteredGroups(). Use it:
const mainGroup = Object.entries(registeredGroups).find(
  ([_, g]) => g.folder === 'telegram_main'
);
if (mainGroup) {
  registerStudyScheduledTasks(mainGroup[0]); // mainGroup[0] is the JID
} else {
  logger.warn('telegram_main group not registered — skipping study task registration');
}
```

**Constraint:** Read `src/index.ts` to find the right location. It should be after `initDatabase()` / Drizzle migration and after the `registeredGroups` variable is populated (look for `registeredGroups = getAllRegisteredGroups()`). Place it before `startSchedulerLoop()` so the tasks exist when the scheduler first polls. Use the existing `registeredGroups` variable — do NOT call `getAllRegisteredGroups()` again.

**Agent discretion:** Exact placement within the startup sequence.

- [ ] **Step 1:** Read `src/index.ts` to find the startup sequence (migration, group loading, scheduler start)
- [ ] **Step 2:** Add import for `registerStudyScheduledTasks`
- [ ] **Step 3:** Add registration call in the correct location
- [ ] **Step 4:** Verify: `npm run build` — clean
- [ ] **Step 5:** Run full test suite: `npm test` — no regressions
- [ ] **Step 6:** Commit: `feat(study): register study scheduled tasks at startup (S7.2)`

---

## S7.3: SQLite Backup Scheduled Task

**Files:** Modify `src/study/scheduled.ts` (add backup task definition)

**Depends on:** S7.1 (backup task definition is added to `getStudyTaskDefinitions()` in `scheduled.ts`).

**NOT parallelizable with S7.1** — this modifies the same file S7.1 creates. Run after S7.1 completes.

### Task definition

Add a backup task to the `getStudyTaskDefinitions()` array in `src/study/scheduled.ts`:

```typescript
{
  id: 'study-sqlite-backup',
  prompt: `Run the following backup commands in your bash sandbox. Do not improvise — run exactly these commands:

\`\`\`bash
DB_PATH="/workspace/project/store/messages.db"
BACKUP_DIR="/workspace/project/store/backups"
mkdir -p "$BACKUP_DIR"
TODAY=$(date +%Y-%m-%d)
BACKUP_FILE="$BACKUP_DIR/messages-$TODAY.db"

# Use SQLite .backup for atomic consistency
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Rotate: keep last 7 daily backups
ls -1t "$BACKUP_DIR"/messages-*.db 2>/dev/null | tail -n +8 | xargs rm -f 2>/dev/null || true

# Report result
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backup complete: $BACKUP_FILE ($SIZE)"
\`\`\`

After running, report the result. If any command fails, report the exact error. Do NOT modify the database or any other files.`,
  cronExpression: '0 3 * * *',         // 03:00 daily
  groupFolder: 'telegram_main',
  chatJid: mainChatJid,
}
```

**Constraint:** The backup uses SQLite's `.backup` command which acquires a shared lock and produces an atomically consistent copy — safe even while the NanoClaw process is writing. Requires `sqlite3` CLI installed in the container image (it is — the container has `sqlite3` for DB queries).

**Constraint:** The rotation keeps the 7 most recent `messages-*.db` files and deletes older ones.

- [ ] **Step 1:** Add backup task definition to `getStudyTaskDefinitions()` in `src/study/scheduled.ts`
- [ ] **Step 2:** Run: `npm run build` — verify clean
- [ ] **Step 3:** Run full test suite: `npm test` — no regressions (existing scheduled task tests should now show 4 tasks instead of 3)
- [ ] **Step 4:** Update the test that checks task count from 3 to 4
- [ ] **Step 5:** Run tests again — verify pass
- [ ] **Step 6:** Commit: `feat(study): add SQLite backup scheduled task with 7-day rotation (S7.3)`

---

## S7.4: Mr. Rogers Study Integration — CLAUDE.md Update

**Files:** Modify `groups/telegram_main/CLAUDE.md`

**Parallelizable with S7.1, S7.3, S7.5.**

### What to add

Add a new `## Study System Integration` section to `groups/telegram_main/CLAUDE.md`. Place it after the existing `## Simon's Preferences` section (end of file).

**Section content (target ~50-60 lines, max 70):**

The section should cover:

**1. Study awareness context:**
- Simon uses a multi-method study system for his university courses (Digital Transformation, BI-2081 etc.)
- The study system uses Bloom's taxonomy levels (L1-L6) with spaced repetition scheduling
- Concepts progress through mastery levels: Remember → Understand → Apply → Analyze → Evaluate → Create
- The system has a dashboard at localhost:3100/study for deep study sessions — Telegram is the mobile companion

**2. Quick card review flow:**
When the morning scheduled task fires (or when Simon asks for a quick review):
- Query the DB for due card_review activities: `SELECT la.id, la.prompt, la.reference_answer, la.bloom_level, c.title as concept_title FROM learning_activities la JOIN concepts c ON la.concept_id = c.id WHERE la.due_at <= date('now') AND la.activity_type = 'card_review' ORDER BY la.due_at ASC LIMIT 5`
- Pick 3-5 cards and send each as a question
- Wait for the student to respond
- Evaluate the response against `reference_answer` — assess quality 0-5:
  - 5: Perfect recall, no hesitation
  - 4: Correct with minor hesitation
  - 3: Correct with significant effort
  - 2: Partially correct
  - 1: Mostly incorrect but shows some knowledge
  - 0: No useful response
- Log each completed activity via IPC:
```bash
echo '{"type":"study_complete","activityId":"<activity-id>","quality":<0-5>,"surface":"telegram"}' > /workspace/ipc/tasks/study_$(date +%s%N).json
```
- Send brief feedback after each card
- After all cards, give a summary: "3/5 correct, nice work on [concept]!"

**3. Concept discovery alerts:**
When mentioning new pending concepts in the morning message, note that the student should check the dashboard to approve them. Don't try to approve concepts via Telegram — that's a dashboard action.

**4. Light elaboration:**
When Simon asks "why does X work?" or similar conceptual questions during casual chat:
- Look up the concept in the vault via RAG
- Provide a concise explanation
- If the concept is in the study system, mention the current Bloom's level
- Optionally log as an informal study interaction (but don't auto-log every conversation as study activity)

**5. Constraints:**
- Do NOT create study plans via Telegram — that's a dashboard feature
- Do NOT try to run full Feynman/Socratic sessions via Telegram — those need the dashboard chat
- Do NOT send study messages unprompted outside of scheduled tasks
- Keep study-related messages concise — Telegram is for quick interactions
- Brain-first applies: when quizzing, always let the student attempt an answer before revealing the reference

**6. DB access:**
The study database is at `/workspace/project/store/messages.db`. Key tables:
- `concepts` — all study concepts with mastery levels
- `learning_activities` — schedulable study activities with SM-2 fields
- `activity_log` — every study interaction
- `study_plans` — learning plans with concept associations
- `study_sessions` — grouped study session records

### Constraints for the writer

- Total CLAUDE.md should stay under 520 lines after this addition. The current file is ~411 lines.
- Do NOT modify existing sections. Add the study section as a new section at the end.
- Follow the existing writing style: direct, concise, imperative.
- Use Telegram formatting conventions (no markdown headings, single asterisks for bold).
- Include the actual SQL queries the agent needs — it has sqlite3 access via bash.
- Include the exact IPC JSON format for `study_complete`.

- [ ] **Step 1:** Read current `groups/telegram_main/CLAUDE.md` to understand style and length
- [ ] **Step 2:** Add `## Study System Integration` section at the end of the file
- [ ] **Step 3:** Verify total line count is under 500
- [ ] **Step 4:** Commit: `feat(study): add study system integration to Mr. Rogers CLAUDE.md (S7.4)`

---

## S7.5: Remaining Study IPC Handler — `study_session`

**Files:** Modify `src/ipc.ts`

**Parallelizable with S7.1, S7.3, S7.4.**

### What to add

Add a `study_session` case to the `processTaskIpc` switch statement in `src/ipc.ts`. This handler returns today's due activities and session summary as a JSON response file that the requesting agent can read.

**Why this handler exists:** While the morning scheduled task prompt instructs Mr. Rogers to query the DB directly, a container agent may also want to request session data programmatically via IPC (e.g., if a user asks "what's due today?" during a conversation). The response is written to the agent's IPC responses directory.

### IPC contract

**Input:**
```typescript
{
  type: 'study_session',
  limit?: number,          // max activities to return (default 20)
  preferredTypes?: string[] // filter to specific activity types
}
```

**Output:** Written to `data/ipc/{sourceGroup}/responses/session-{timestamp}.json`:
```typescript
{
  type: 'session_summary',
  dueCount: number,
  pendingConceptCount: number,
  activePlanCount: number,
  dueActivities: Array<{
    id: string,
    conceptTitle: string,
    activityType: string,
    bloomLevel: number,
    dueAt: string,
    prompt: string,
  }>,
  activePlans: Array<{
    id: string,
    title: string,
    status: string,
  }>,
}
```

### Implementation pattern

Follow the existing `study_concept_status` case (line ~829 in `src/ipc.ts`):

```typescript
case 'study_session': {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const responseFile = path.join(
    responsesDir,
    `session-${Date.now()}.json`,
  );

  const limit = typeof data.limit === 'number' ? data.limit : 20;
  const dueActivities = getDueActivities();

  // Filter by preferred types if specified
  let filtered = dueActivities;
  if (Array.isArray(data.preferredTypes) && data.preferredTypes.length > 0) {
    const typeSet = new Set(data.preferredTypes);
    filtered = dueActivities.filter(a => typeSet.has(a.activityType));
  }

  // Limit results
  const limited = filtered.slice(0, limit);

  // Enrich with concept titles
  const enriched = limited.map(a => {
    const concept = getConceptById(a.conceptId);
    return {
      id: a.id,
      conceptTitle: concept?.title ?? 'Unknown',
      activityType: a.activityType,
      bloomLevel: a.bloomLevel,
      dueAt: a.dueAt,
      prompt: a.prompt,
    };
  });

  // Get pending concepts count
  const pendingConcepts = getPendingConcepts();
  const activePlans = getActivePlans();

  fs.writeFileSync(
    responseFile,
    JSON.stringify({
      type: 'session_summary',
      dueCount: dueActivities.length,
      pendingConceptCount: pendingConcepts.length,
      activePlanCount: activePlans.length,
      dueActivities: enriched,
      activePlans: activePlans.map(p => ({
        id: p.id,
        title: p.title,
        status: p.status,
      })),
    }),
  );

  logger.info(
    { sourceGroup, dueCount: dueActivities.length, returned: enriched.length },
    'study_session: wrote session summary',
  );
  break;
}
```

**Required imports** (add to existing import block at top of `src/ipc.ts`):

```typescript
import { getDueActivities, getPendingConcepts, getActivePlans } from './study/queries.js';
```

**Note:** None of `getDueActivities`, `getPendingConcepts`, or `getActivePlans` are currently imported in `src/ipc.ts` — all three must be added to the existing import block from `./study/queries.js`. `getConceptById` IS already imported (line ~16). `getPendingConcepts` returns concepts with `status = 'pending'`.

### Update IPC data type

Add `study_session` fields to the `processTaskIpc` `data` parameter type:

```typescript
// Add to the data type union in processTaskIpc:
// For study_session
limit?: number;
preferredTypes?: string[];
```

Note: `limit` may already exist on the data type from other IPC types. Check before adding duplicates.

- [ ] **Step 1:** Read `src/ipc.ts` to find the existing imports and the switch/case structure
- [ ] **Step 2:** Add `getDueActivities`, `getPendingConcepts`, and `getActivePlans` to the imports from `./study/queries.js` (none are currently imported — all three must be added)
- [ ] **Step 3:** Add `study_session` case to the switch statement, after `study_suggest_activity`
- [ ] **Step 4:** Add `preferredTypes` to the `data` parameter type if not already present
- [ ] **Step 5:** Run: `npm run build` — verify clean compilation
- [ ] **Step 6:** Run full test suite: `npm test` — no regressions
- [ ] **Step 7:** Commit: `feat(study): add study_session IPC handler for session summary (S7.5)`

---

## S7.6: Verification

**Depends on:** All previous tasks.

- [ ] **Step 1:** Run backend tests: `npm test` — all pass, no regressions
- [ ] **Step 2:** Build: `npm run build` — clean
- [ ] **Step 3:** Verify `scripts/backup-sqlite.sh` is executable and produces valid output
- [ ] **Step 4:** Verify `src/study/scheduled.ts` exports `registerStudyScheduledTasks` correctly
- [ ] **Step 5:** Check `groups/telegram_main/CLAUDE.md` contains study integration section with:
  - Quick review flow with IPC JSON format
  - DB query examples
  - Study-specific constraints
- [ ] **Step 6:** Check `src/ipc.ts` handles `study_session` type
- [ ] **Step 7:** Verify all new files use `.js` extensions on relative imports
- [ ] **Step 8:** Commit: `chore(study): verify S7 Telegram + scheduled tasks end-to-end (S7.6)`

---

## Acceptance Criteria

From master plan S7 (non-negotiable):

- [ ] Daily scheduled task registered with `0 7 * * *` cron pattern
- [ ] Weekly scheduled task registered with `0 18 * * 0` cron pattern
- [ ] Monthly scheduled task registered with `0 10 1 * *` cron pattern
- [ ] All scheduled tasks register idempotently at startup
- [ ] Morning task prompt includes: session summary, pending concept count, plan checkpoint alerts
- [ ] Weekly task prompt includes: retention data, concept progression, synthesis suggestions
- [ ] Monthly task prompt includes: mastery review, decay detection, growth trajectory
- [ ] Mr. Rogers CLAUDE.md includes study awareness and quick review instructions
- [ ] Quick card review flow documented with exact IPC format for `study_complete`
- [ ] SQLite backup runs daily at 03:00 with 7-day rotation
- [ ] Backup script handles missing backup directory (creates it)
- [ ] `study_session` IPC handler returns due activities with concept enrichment
- [ ] Confirm `study_generation_request` IPC handler (S3.8) covers master plan S7.1 `study_generate` requirement — no additional handler needed
- [ ] All existing tests pass (`npm test`)
- [ ] Clean build (`npm run build`)
