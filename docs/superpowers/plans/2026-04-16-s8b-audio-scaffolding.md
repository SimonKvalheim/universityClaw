# S8b: Audio + Student Activities + Scaffolding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Your role:** You are the engineer implementing this. The plan tells you *what* to build and *why*. You decide *how* within the stated constraints. If you disagree with an approach or see a better alternative, flag it before implementing — don't silently deviate and don't silently comply with something you think is wrong.

**Goal:** Add audio/podcast generation pipeline with TTS, Telegram podcast delivery, student-generated activity prompting in the dashboard, and an adaptive scaffolding hint system — completing the study system's feature set.

**Architecture:** S8b introduces two new capabilities: (1) an audio pipeline that generates conversational scripts via the generator agent, converts to audio via Mistral TTS API, and delivers via Telegram; (2) a scaffolding system that adapts hint levels based on rolling success rate. Student-generated activities leverage the existing `study_suggest_activity` IPC handler (S5.9) — S8b adds the dashboard UX for prompting at key moments.

**Tech Stack:** TypeScript/Node.js (backend), Next.js + React (dashboard), Mistral API (TTS), NanoClaw task scheduler (cron), Telegram grammY (audio delivery), Vitest (tests)

**Branch:** Create `feat/s8b-audio-scaffolding` off the branch where S8a was merged (or off `main` if S8a is already merged).

**Note:** Master plan S8.7 (prerequisite awareness), S8.8 (staleness detection), and S8.9 (monthly scheduled task) are NOT in this plan — S8.7 and S8.8 are covered by S8a, and S8.9 was already implemented in S7 (`study-monthly-mastery` scheduled task).

**Spec:** `docs/superpowers/specs/2026-04-12-multi-method-study-system-design.md` (Sections 4.4, 6.4, 8)

**Master plan:** `docs/superpowers/plans/2026-04-13-study-system-master-plan.md` (S8.3, S8.4, S8.5, S8.6)

---

## Codebase Conventions (Hard Constraints)

These apply to **every task**. Subagents must follow these — they're not obvious from context alone.

1. **`.js` extensions on all relative imports in `src/`.** The backend uses Node ESM resolution. Write `import { foo } from './bar.js'`, not `'./bar'`. **Exception:** Dashboard (`dashboard/src/`) does NOT use `.js` extensions — Next.js handles resolution.
2. **camelCase Drizzle properties in `src/db/schema/*.ts`**, snake_case SQL column names. Dashboard schema (`dashboard/src/lib/db/schema.ts`) uses snake_case properties.
3. **Drizzle query builder operators** — not raw SQL strings.
4. **Commit messages** use conventional commits: `feat(study):`, `feat(dashboard):`.
5. **Test file locations:** Backend tests are colocated: `src/study/foo.test.ts`. Use `_initTestDatabase()` from `../db/index.js`.
6. **IPC handlers** go in the `processTaskIpc` switch/case in `src/ipc.ts`. Follow existing patterns.
7. **Mr. Rogers CLAUDE.md** is at `groups/telegram_main/CLAUDE.md`. Telegram formatting: `*bold*`, `_italic_`, `•` bullets. No `##` headings or `**double stars**`.
8. **Generator CLAUDE.md** is at `groups/study-generator/CLAUDE.md`.
9. **Container agent dispatch** uses the existing task scheduler + IPC infrastructure. New generation jobs follow the `study_generation_request` IPC pattern (S3.8).

---

## Spec Deviations

- **TTS via OpenAI API, not Mistral.** The spec says "TTS via Mistral API, already configured" but Mistral does not offer a TTS endpoint. S8b uses OpenAI's TTS API (`https://api.openai.com/v1/audio/speech`, model `tts-1`) instead. The `OPENAI_API_KEY` is available via OneCLI. The `MISTRAL_API_KEY` env var exists for STT (transcription) — not TTS.
- **Audio storage is filesystem-based, not DB-linked.** The spec envisions "audio files linked to concepts" in the database. S8b stores audio files in `data/audio/` with filename convention `{contentType}-{conceptIds}-{timestamp}.mp3` and no new DB table. The file path is passed to Telegram for delivery. A future sprint can add a DB tracking table if audio management becomes complex.
- **Student activity prompting is dashboard-side only.** The spec mentions prompting "during dashboard chat after an illuminating exchange." S8b adds prompting on the session page (post-struggle, post-insight detection). Chat-based prompting requires study agent CLAUDE.md changes that are better addressed as a targeted follow-up.
- **Scaffolding hint content is AI-generated, not pre-stored.** The spec describes 5 fixed scaffolding levels. S8b implements the level selection logic (adaptive, targeting 70-85% success) but generates hint content dynamically via the study agent rather than pre-storing hints per activity. This is more flexible and avoids doubling the storage for every activity.
- **Scaffolding adjustment thresholds tightened from spec.** The spec (Section 4.4) uses `> 90%` to decrease and `< 50%` to increase scaffolding. S8b tightens these to `> 85%` / `< 70%` to keep students more consistently in the ZPD. The spec's 50% lower bound is too permissive — at 55% success a student is essentially guessing and needs help. The tighter window (70-85%) provides a more responsive adaptive system.

---

## Key Decisions

### D1: Audio pipeline is a two-stage process
Stage 1: Generator agent produces a conversational script (text). Stage 2: Mistral TTS API converts script to audio (mp3). This is two separate operations because: (a) the script can be reviewed/edited before synthesis, (b) TTS failures don't lose the script work, (c) script generation is free (Claude Max) while TTS has API cost.

### D2: TTS client is a thin wrapper in src/study/audio.ts
The OpenAI TTS API call is a simple HTTP POST. No SDK needed — use `fetch()` directly. The `OPENAI_API_KEY` is available via OneCLI (same as how Claude API keys are managed). The audio file is written to `data/audio/` and the file path returned.

### D3: Scaffolding level is computed per-concept from rolling window
The scaffolding level for a concept is derived from the last 10 activity completions for that concept. Success rate = quality >= 3 / total. If success rate > 85%, decrease scaffolding level. If < 70%, increase it. If 70-85%, maintain. This runs at session build time — the session composition includes recommended scaffolding levels.

**Why per-concept, not per-activity?** A student struggling with Cognitive Load Theory at L3 should get hints for all L3 CLT activities, not just the specific one they failed. The concept is the unit of struggle.

### D4: Student activity suggestion is a UI prompt, not automatic
After completing an activity with quality <= 2 (struggle) or quality = 5 (mastery), the session UI shows a prompt: "Want to create your own study question for this concept?" If yes, a form appears. The form POSTs to `/api/study/suggest-activity` which writes an IPC file for the `study_suggest_activity` handler (already implemented in S5.9).

### D5: Telegram audio delivery uses existing sendVoice
The Telegram channel already has `sendVoice()` via grammY. Audio delivery is triggered by a new scheduled task or on-demand IPC. Mr. Rogers sends the audio file with a brief description of the content.

---

## Essential Reading

> **For coordinators:** Extract relevant patterns from these files and inline them into subagent prompts. Subagents won't read the files themselves.

| File | Why |
|------|-----|
| `src/study/generator.ts` | Activity generation pipeline. S8b.1 adds audio script generation alongside it. |
| `groups/study-generator/CLAUDE.md` | Generator agent prompt. S8b.1 adds audio script generation instructions. |
| `src/ipc.ts:738-756` | `study_generation_request` handler. S8b.1 adds `study_audio_script` handler nearby. |
| `src/ipc.ts:911-985` | `study_suggest_activity` handler. S8b.4 triggers this from the dashboard. |
| `src/study/scheduled.ts` | Existing scheduled tasks. S8b.3 adds audio delivery task. |
| `groups/telegram_main/CLAUDE.md` | Mr. Rogers prompt. S8b.3 adds audio delivery instructions. |
| `dashboard/src/app/study/session/page.tsx` | Session UI. S8b.4 adds student activity prompt, S8b.5 adds hint button. |
| `dashboard/src/lib/study-db.ts` | Dashboard queries. S8b.5 adds scaffolding level computation. |
| `dashboard/src/app/api/study/complete/route.ts` | Activity completion. S8b.5 adds scaffolding_level to completion payload. |

---

## Task Numbering

| Plan task | Master plan items | What |
|-----------|-------------------|------|
| S8b.1 | S8.3 | Audio pipeline: script generation + TTS + IPC handler |
| S8b.2 | S8.4 | Telegram podcast delivery: scheduled task + Mr. Rogers CLAUDE.md |
| S8b.3 | S8.5 | Student-generated activities: dashboard prompt + API route |
| S8b.4 | S8.6 | Scaffolding hint system: level computation + session enrichment + UI |
| S8b.5 | — | Tests + verification |

---

## Parallelization & Model Recommendations

**Dependencies:**
- S8b.1 is independent (new audio.ts file, new IPC handler, generator CLAUDE.md update)
- S8b.2 depends on S8b.1 (audio files must exist for delivery)
- S8b.3 is independent (dashboard session page + new API route)
- S8b.4 is independent of S8b.1-S8b.2 BUT modifies session page (conflicts with S8b.3)
- S8b.5 depends on all

**Parallel opportunities:**
- **Wave 1:** S8b.1 + S8b.3 (independent: audio is backend + IPC; student activities is dashboard)
- **Wave 2:** S8b.2 + S8b.4 (S8b.2 depends on S8b.1; S8b.4 depends on S8b.3 for session page changes — or run S8b.4 in Wave 1 if session page edits don't overlap with S8b.3)
- **Wave 3:** S8b.5 (verification)

| Task | Can parallel with | Model | Rationale |
|------|-------------------|-------|-----------|
| S8b.1 | S8b.3 | Sonnet | Pipeline implementation follows existing generation pattern |
| S8b.2 | S8b.4 | Sonnet | Small: scheduled task + CLAUDE.md update |
| S8b.3 | S8b.1 | Sonnet | Dashboard form + API route |
| S8b.4 | S8b.2 | Sonnet | Query + session enrichment + UI component |
| S8b.5 | — | Sonnet | Mechanical verification |

**File ownership for Wave 1 parallel agents:**
- **S8b.1 agent:** Owns `src/study/audio.ts` (create), `src/study/audio.test.ts` (create), `src/ipc.ts` (add `study_audio_script` case), `groups/study-generator/CLAUDE.md` (add audio section). Do NOT touch dashboard files, session page, or `scheduled.ts`.
- **S8b.3 agent:** Owns `dashboard/src/app/study/session/page.tsx` (add suggestion prompt), `dashboard/src/app/api/study/suggest-activity/route.ts` (create). Do NOT touch `src/` backend files, IPC handlers, or generator CLAUDE.md.

---

## S8b.1: Audio Pipeline — Script Generation + TTS

**Files:** Create `src/study/audio.ts`, create `src/study/audio.test.ts`, modify `src/ipc.ts` (add `study_audio_script` handler), modify `groups/study-generator/CLAUDE.md` (add audio script section)

**Parallelizable with S8b.3.**

### Audio module: src/study/audio.ts

This module orchestrates the two-stage audio pipeline:

**Stage 1: Script generation**
```typescript
generateAudioScript(options: AudioScriptOptions): Promise<void>
```

`AudioScriptOptions`:
```typescript
interface AudioScriptOptions {
  conceptIds: string[];
  contentType: 'summary' | 'review_primer' | 'weekly_digest';
  targetDurationMinutes?: number; // default: 5 for summary, 3 for primer, 10 for digest
}
```

This function:
1. Fetches concept data from DB (titles, domains, mastery levels)
2. Builds a generation prompt for the generator agent
3. Dispatches via the existing task scheduler (same pattern as `study_generation_request`)
4. The generator agent returns the script via `study_audio_script` IPC

**Stage 2: TTS synthesis**
```typescript
synthesizeAudio(script: string, outputPath: string): Promise<string>
```

This function:
1. Calls the Mistral TTS API with the script text
2. Writes the audio response to `outputPath`
3. Returns the file path

**OpenAI TTS API call:**
```typescript
const response = await fetch('https://api.openai.com/v1/audio/speech', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'tts-1',
    input: script,
    voice: 'alloy', // or configurable
    response_format: 'mp3',
  }),
  signal: AbortSignal.timeout(60_000), // 60s timeout for long scripts
});
if (!response.ok) {
  throw new Error(`TTS API failed: ${response.status} ${await response.text()}`);
}
// Write to temp file then rename for atomicity
const tempPath = outputPath + '.tmp';
const audioBuffer = await response.arrayBuffer();
fs.writeFileSync(tempPath, Buffer.from(audioBuffer));
fs.renameSync(tempPath, outputPath);
```

**Error handling:** Wrap `synthesizeAudio()` in try/catch. On failure: log the error, clean up any temp files (`*.tmp`), and don't leave partial audio files on disk. The IPC handler should catch TTS errors and write an error response file (not crash the process).

### IPC handler: study_audio_script

Add to `src/ipc.ts` switch/case:

**Input:**
```typescript
{
  type: 'study_audio_script',
  conceptIds: string[],
  script: string,
  contentType: 'summary' | 'review_primer' | 'weekly_digest'
}
```

**Handler behavior:**
1. Validate: `conceptIds` is non-empty array, `script` is non-empty string, `contentType` is valid
2. Generate output path: `data/audio/${contentType}-${Date.now()}.mp3`
3. Call `synthesizeAudio(script, outputPath)`
4. Write response file to IPC responses dir with the audio file path
5. Log success

### Generator CLAUDE.md update

Add an "Audio Script Generation" section to `groups/study-generator/CLAUDE.md`. Instructions:
- When the prompt asks for audio script generation, produce a conversational narrative script
- Script should be written for text-to-speech (no markdown, no bullet points, natural spoken language)
- Content types: "summary" (overview of concept relationships), "review_primer" (quick recap of key points), "weekly_digest" (synthesis of the week's learning)
- Target word count: ~150 words per minute of target duration
- Include transitions, emphasis cues, and conceptual bridges
- Output via `study_audio_script` IPC with the script text

### Tests

Test `synthesizeAudio()` with a mocked fetch (don't call real API in tests). Verify:
1. Correct API call format (URL, headers, body)
2. Audio file written to disk
3. Error handling for API failures (non-200 response)

- [ ] **Step 1:** Create `src/study/audio.ts` with `generateAudioScript()` and `synthesizeAudio()`
- [ ] **Step 2:** Add `study_audio_script` IPC handler to `src/ipc.ts`
- [ ] **Step 3:** Add audio script generation section to `groups/study-generator/CLAUDE.md`
- [ ] **Step 4:** Create `src/study/audio.test.ts` with mocked TTS test
- [ ] **Step 5:** Run `npm test` — verify pass
- [ ] **Step 6:** Run `npm run build` — verify clean
- [ ] **Step 7:** Commit: `feat(study): add audio pipeline with TTS synthesis and IPC handler (S8b.1)`

---

## S8b.2: Telegram Podcast Delivery

**Files:** Modify `src/study/scheduled.ts` (add audio delivery task), modify `groups/telegram_main/CLAUDE.md` (add audio delivery section)

**Depends on:** S8b.1 (audio files must be generatable).

### Scheduled task for audio delivery

Add a new task definition to `getStudyTaskDefinitions()` in `src/study/scheduled.ts`:

**Audio review primer task (`study-audio-primer`)**
- **Cron:** `0 6 * * *` (06:00 daily, before the morning study task at 07:00)
- **Group:** `telegram_main`
- **Prompt:** Instruct Mr. Rogers to:
  1. Check if there are due activities for today
  2. If yes, trigger audio script generation for a review primer of today's concepts
  3. Wait for the audio file to be generated (check `data/audio/` for recent files)
  4. Send the audio file via Telegram with a brief message: "Here's a quick audio review of today's concepts. Listen while you get ready!"

**On-demand audio:** Mr. Rogers can also generate audio on request. When the student asks "generate a podcast about [topic]", Mr. Rogers:
1. Identifies relevant concept IDs
2. Writes a `study_audio_script` IPC request
3. Waits for the audio file
4. Sends via Telegram

### Mr. Rogers CLAUDE.md update

Add an "Audio/Podcast Delivery" subsection to the existing "Study System Integration" section in `groups/telegram_main/CLAUDE.md`:

Content:
- How to trigger audio generation (write IPC file with `study_audio_script` type... actually, Mr. Rogers triggers generation by writing a `study_generation_request` IPC with a special audio flag, or directly dispatches the generator)
- Where audio files are stored (`/workspace/project/data/audio/`)
- How to send audio via Telegram (use the bash command to send voice message, or the built-in voice capability)
- When to proactively offer audio: before morning study sessions, before weekly reviews

**Agent discretion:** Exact prompt wording, how Mr. Rogers discovers and sends audio files, whether to use a two-step process (generate then send) or combine.

- [ ] **Step 1:** Add audio primer task definition to `src/study/scheduled.ts`
- [ ] **Step 2:** Add audio delivery section to `groups/telegram_main/CLAUDE.md`
- [ ] **Step 3:** Run `npm run build` — verify clean
- [ ] **Step 4:** Run `npm test` — update task count in scheduled.test.ts if needed
- [ ] **Step 5:** Commit: `feat(study): add Telegram podcast delivery scheduled task (S8b.2)`

---

## S8b.3: Student-Generated Activities — Dashboard Prompting

**Files:** Modify `dashboard/src/app/study/session/page.tsx` (add suggestion prompt), create `dashboard/src/app/api/study/suggest-activity/route.ts`

**Parallelizable with S8b.1.**

### When to prompt

After each activity completion, check the quality score:
- **Quality 0-2 (struggle):** Show prompt: "This was a tough one. Want to create your own question about [concept title] to practice later?"
- **Quality 5 (mastery):** Show prompt: "Great work! Want to capture what made this click as a study question?"
- **Quality 3-4:** No prompt (normal performance, don't interrupt flow)

The prompt appears as a collapsible section below the completion feedback, not as a modal. It should not disrupt the session flow.

### Suggestion form

When the student clicks "Yes" on the prompt:
1. Show a form with:
   - Activity type dropdown (card_review, elaboration, self_explain, comparison)
   - Prompt text area (the question they want to study)
   - Bloom's level selector (1-6, default to current activity's level)
2. On submit, POST to `/api/study/suggest-activity`

### API route

Create `dashboard/src/app/api/study/suggest-activity/route.ts`:

```typescript
// POST /api/study/suggest-activity
// Body: { conceptId, activityType, prompt, bloomLevel }
```

This route writes an IPC file to `data/ipc/study-generator/tasks/suggest_{timestamp}.json`:
```json
{
  "type": "study_suggest_activity",
  "conceptId": "abc123",
  "activityType": "elaboration",
  "prompt": "Why does dual coding theory predict better retention?",
  "bloomLevel": 3,
  "author": "student"
}
```

The existing `study_suggest_activity` IPC handler (line ~911 in `src/ipc.ts`) picks this up and creates the activity.

**Constraint:** Follow the exact IPC file-write pattern from `dashboard/src/lib/generation-trigger.ts` — same `ipcTaskDir()` helper function, same directory structure (`data/ipc/study-generator/tasks/`), same filename convention. The `study-generator` group folder is registered and the IPC watcher scans `data/ipc/{groupFolder}/tasks/` for new files. Do NOT use `data/ipc/study/tasks/` — no group named `study` exists in the registered groups.

**IPC file path:** `data/ipc/study-generator/tasks/suggest_${Date.now()}.json`.

**Dashboard schema columns used by the IPC handler for `study_suggest_activity`:**
- `learning_activities.id` (generated UUID)
- `learning_activities.concept_id` (from request)
- `learning_activities.activity_type` (from request, validated against: card_review, elaboration, self_explain, concept_map, synthesis, socratic, comparison, case_analysis)
- `learning_activities.prompt` (from request)
- `learning_activities.bloom_level` (from request, integer 1-6)
- `learning_activities.author` ('student')
- `learning_activities.due_at` (set to today)
- `learning_activities.generated_at` (now)
- `learning_activities.ease_factor` (2.5 default)
- `learning_activities.interval_days` (1 default)
- `learning_activities.repetitions` (0 default)
- `learning_activities.mastery_state` ('new')

- [ ] **Step 1:** Add suggestion prompt UI to session page (appears after quality 0-2 or 5)
- [ ] **Step 2:** Add suggestion form (activity type, prompt text, bloom level)
- [ ] **Step 3:** Create `dashboard/src/app/api/study/suggest-activity/route.ts`
- [ ] **Step 4:** Wire form submission to API route
- [ ] **Step 5:** Run `cd dashboard && npm run build` — verify clean
- [ ] **Step 6:** Run `npm test` — no regressions
- [ ] **Step 7:** Commit: `feat(dashboard): add student-generated activity prompting in study sessions (S8b.3)`

---

## S8b.4: Scaffolding Hint System

**Files:** Create `dashboard/src/lib/scaffolding.ts`, modify `dashboard/src/app/api/study/session/route.ts` (add scaffolding levels), modify `dashboard/src/app/study/session/page.tsx` (add hint button + display), modify `dashboard/src/app/api/study/complete/route.ts` (record scaffolding level)

**Depends on:** S8b.3 (if S8b.3 modified session page; otherwise independent). Recommended: run after S8b.3 to avoid merge conflicts on session page.

### Scaffolding level computation

Create `dashboard/src/lib/scaffolding.ts`:

```typescript
/**
 * Compute recommended scaffolding level for a concept based on
 * rolling success rate (last 10 attempts).
 *
 * Scaffolding levels (spec Section 4.4):
 *   0: No hints (prompt only)
 *   1: Contextual hint ("Think about concept X")
 *   2: Structural hint ("The answer involves three components...")
 *   3: Partial solution ("The first step is...")
 *   4: Worked example with similar problem
 *   5: Full explanation + answer (last resort)
 *
 * Target: 70-85% success rate (Vygotsky's ZPD)
 *   > 85% success → decrease level (min 0)
 *   < 70% success → increase level (max 5)
 *   70-85% → maintain current level
 */
export function computeScaffoldingLevel(
  recentQualities: number[], // last 10 quality scores for this concept
  currentLevel: number,      // current scaffolding level (0-5)
): number
```

The function:
1. Computes success rate: `recentQualities.filter(q => q >= 3).length / recentQualities.length`
2. If fewer than 3 data points, return `currentLevel` (not enough data to adjust)
3. If success rate > 0.85, return `Math.max(0, currentLevel - 1)`
4. If success rate < 0.70, return `Math.min(5, currentLevel + 1)`
5. Otherwise return `currentLevel`

### Session enrichment

Modify the session API (`GET /api/study/session`) to include recommended scaffolding level per activity. For each activity in the session composition:
1. Get the concept ID
2. Use the existing `getRecentLogs(conceptId, 10)` function from `study-db.ts` (~line 548) — it already queries `activity_log` ordered by `reviewed_at` desc with a limit. Do NOT create a duplicate query function.
3. Extract quality scores from the returned logs
4. Call `computeScaffoldingLevel(qualities, 0)` (default level 0 if no history)
5. Include `scaffoldingLevel: number` in the enriched activity object

Dashboard schema columns:
- `activity_log.concept_id`, `activity_log.quality`, `activity_log.reviewed_at` (for rolling window)
- `activity_log.scaffolding_level` (already exists, default 0)

### Hint generation

When the student clicks "Need a hint?", the hint content is generated based on the scaffolding level:

- **Level 0:** No hint button shown
- **Level 1-2:** Hint is derived from the activity's `reference_answer` — the API returns a truncated/abstracted version. Level 1 = first sentence of the reference answer. Level 2 = structural summary ("The answer covers N points: [first words of each]").
- **Level 3-5:** Hint requires the study agent (AI-generated). For S8b, levels 3-5 show the reference answer with progressively more revealed (level 3 = 30%, level 4 = 60%, level 5 = 100%).

**Why not AI hints?** AI hint generation requires a container agent round-trip (1-3 seconds). For levels 1-2, reference-answer-derived hints are instant and sufficient. For levels 3-5, progressive reveal of the reference answer is pragmatic — full AI scaffolding can be a post-S8 enhancement.

### Session UI changes

Add to each activity card in `/study/session`:
1. **Hint button:** "Need a hint?" — only shown if scaffolding level >= 1
2. **Hint display:** Collapsible section below the prompt showing the hint text
3. **Hint level indicator:** Small badge showing the scaffolding level (e.g., "Scaffolding: L2")

### Completion recording

Modify three files to wire scaffolding level through the completion flow:
1. **`dashboard/src/lib/study-db.ts`:** Add `scaffoldingLevel?: number` to the `CompleteActivityInput` interface (~line 258). In the `completeActivity()` function (~line 299), pass `scaffolding_level: input.scaffoldingLevel ?? 0` to the `activity_log` insert.
2. **`dashboard/src/app/api/study/complete/route.ts`:** Accept `scaffoldingLevel` from the request body and pass it to `processCompletion()`.
3. **`dashboard/src/app/study/session/page.tsx`:** Include the current scaffolding level in the completion POST request body.

Dashboard schema column: `activity_log.scaffolding_level` (integer, default 0) — already exists, just not wired.

- [ ] **Step 1:** Create `dashboard/src/lib/scaffolding.ts` with `computeScaffoldingLevel()`
- [ ] **Step 2:** Write tests for scaffolding computation in `dashboard/src/lib/__tests__/scaffolding.test.ts`
- [ ] **Step 3:** Run `cd dashboard && npm test` — verify pass
- [ ] **Step 4:** Modify session API to include scaffolding levels per activity
- [ ] **Step 5:** Add hint button and display to session page
- [ ] **Step 6:** Modify complete API to record scaffolding level
- [ ] **Step 7:** Run `cd dashboard && npm run build` — verify clean
- [ ] **Step 8:** Run `npm test` (root) — no regressions
- [ ] **Step 9:** Commit: `feat(dashboard): add adaptive scaffolding hint system with rolling success targeting (S8b.4)`

---

## S8b.5: Verification

**Depends on:** All previous tasks.

- [ ] **Step 1:** Run `npm test` — all pass, no regressions
- [ ] **Step 2:** Run `cd dashboard && npm run build` — clean
- [ ] **Step 3:** Run `npm run build` (root) — clean
- [ ] **Step 4:** Start dashboard dev server and main process
- [ ] **Step 5:** Verify `/study/session` shows hint buttons when scaffolding level > 0
- [ ] **Step 6:** Verify student suggestion prompt appears after low/high quality completions
- [ ] **Step 7:** Verify `src/study/audio.ts` exists and exports `generateAudioScript` and `synthesizeAudio`
- [ ] **Step 8:** Verify `study_audio_script` IPC handler exists in `src/ipc.ts`
- [ ] **Step 9:** Verify `groups/study-generator/CLAUDE.md` includes audio script section
- [ ] **Step 10:** Verify `groups/telegram_main/CLAUDE.md` includes audio delivery section
- [ ] **Step 11:** Verify all new files use correct import conventions
- [ ] **Step 12:** Commit: `chore(study): verify S8b audio + student activities + scaffolding end-to-end (S8b.5)`

---

## Acceptance Criteria

From master plan S8 (non-negotiable):

**Audio (S8.3, S8.4):**
- [ ] `src/study/audio.ts` exports `generateAudioScript()` and `synthesizeAudio()`
- [ ] Audio scripts generated via generator agent with IPC
- [ ] TTS synthesis calls Mistral (or OpenAI fallback) API and writes mp3 to `data/audio/`
- [ ] `study_audio_script` IPC handler validates and triggers TTS
- [ ] Generator CLAUDE.md includes audio script generation instructions
- [ ] Scheduled audio primer task registered at 06:00 daily
- [ ] Mr. Rogers CLAUDE.md includes audio delivery instructions

**Student Activities (S8.5):**
- [ ] Session page prompts student to create activities after quality 0-2 or 5
- [ ] Suggestion form accepts activity type, prompt, bloom level
- [ ] Form submission writes IPC file for `study_suggest_activity` handler
- [ ] Created activities have `author = 'student'` and are scheduled for today

**Scaffolding (S8.6):**
- [ ] `computeScaffoldingLevel()` targets 70-85% success rate from rolling 10-attempt window
- [ ] Session API includes scaffolding level per activity
- [ ] Hint button shown when scaffolding level >= 1
- [ ] Hints derived from reference answer (levels 1-2: truncated; levels 3-5: progressive reveal)
- [ ] Scaffolding level recorded in `activity_log.scaffolding_level` on completion
- [ ] Scaffolding computation has unit tests

**General:**
- [ ] All existing tests pass (`npm test`)
- [ ] Dashboard builds cleanly (`cd dashboard && npm run build`)
- [ ] No regressions in existing dashboard pages or study session flow
