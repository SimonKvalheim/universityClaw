# S5: Dashboard Chat + Deep Methods — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Your role:** You are the engineer implementing this. The plan tells you *what* to build and *why*. You decide *how* within the stated constraints. If you disagree with an approach or see a better alternative, flag it before implementing — don't silently deviate and don't silently comply with something you think is wrong.

**Goal:** Add conversational AI to the study system — a chat interface for deep learning methods (Feynman, Socratic, case analysis, synthesis) and AI evaluation for L3+ activities. The study agent runs in a container, communicates via the web channel's SSE infrastructure, and evaluates student responses using RAG-powered context.

**Architecture:** S5 extends the existing web channel (`src/channels/web.ts`, port 3200) with a `web:study:{sessionId}` JID pattern — parallel to the existing `web:review:{draftId}` pattern. The dashboard gets a `/study/chat` page for multi-turn dialogue and an "AI Evaluate" option on `/study/session` for L3+ activities. Both proxy through new dashboard API routes to the web channel, which routes to a study container agent. The study agent writes IPC messages (`study_complete`, `study_concept_status`, `study_suggest_activity`) that the main process handles. Chat transcripts persist in `activity_log.response_text` and `activity_log.ai_feedback`.

**Tech Stack:** TypeScript/Node.js (backend), Next.js + React (dashboard), SSE (streaming), Drizzle ORM (SQLite), container agents (Claude via NanoClaw)

**Branch:** Create `feat/s5-dashboard-chat` off `main`. S4 merged via PR #31.

**Spec:** `docs/superpowers/specs/2026-04-12-multi-method-study-system-design.md` (v2.1, Sections 1.4, 2.2, 7.3, 7.4)

**Master plan:** `docs/superpowers/plans/2026-04-13-study-system-master-plan.md` (S5 checklist)

---

## Codebase Conventions (Hard Constraints)

These apply to **every task**. Subagents must follow these — they're not obvious from context alone.

1. **`.js` extensions on all relative imports in `src/`.** The backend uses Node ESM resolution. Write `import { foo } from './bar.js'`, not `'./bar'`. **Exception:** Dashboard (`dashboard/src/`) does NOT use `.js` extensions — Next.js handles resolution.
2. **camelCase Drizzle properties, snake_case SQL columns** (backend `src/db/schema/study.ts`). Dashboard schema uses snake_case properties matching SQL column names (different convention — established in S2).
3. **Drizzle query builder operators** (`eq`, `and`, `lte`, `desc`, `asc`, `count`, `sql`, `inArray`, `gte`) — not raw SQL strings.
4. **Dashboard API routes** use `Response.json()` + try/catch. Pattern: `dashboard/src/app/api/study/concepts/route.ts`.
5. **Dashboard pages** are `'use client'` components with `useState`/`useEffect` for data fetching. Tailwind CSS. Dark theme (bg-gray-950, text-gray-100). Pattern: `dashboard/src/app/study/page.tsx`.
6. **Dashboard imports** do NOT use `.js` extensions. Follow existing patterns in `dashboard/src/lib/study-db.ts` and `dashboard/src/lib/db/index.ts`.
7. **Commit messages** use conventional commits: `feat(study):`, `feat(dashboard):`.
8. **Next.js API conventions may differ from training data.** Read the relevant guide in `node_modules/next/dist/docs/` before writing API routes (especially dynamic `[id]` params).
9. **Web channel HTTP endpoints** use Node's raw `http` module (`http.IncomingMessage`, `http.ServerResponse`). No Express, no `Response.json()`. Body parsing is manual: `req.on('data')` + `req.on('end')` + `JSON.parse()`. See `src/channels/web.ts` for the exact pattern.
10. **Container agents** are spawned via `runContainerAgent(group, input, onProcess)` from `src/container-runner.ts`. The `RegisteredGroup` object defines the group folder, mounts, and allowed tools. See how `REVIEW_AGENT_JID` is registered in `src/index.ts:656-690` for the exact pattern.

---

## Spec Deviations

- **No concept map visual builder.** The spec says `concept_map` gets a "relationship builder" UI. S5 renders it as a text prompt + text area (same as self_explain). Visual concept mapping is deferred to S8.
- **Socratic redirects to chat.** The spec says `socratic` activity type "redirects to `/study/chat` with Socratic method pre-selected." S5 implements this as a link/button that navigates to `/study/chat?conceptId={id}&method=socratic`, not an in-session embed.
- **No collaborative plan creation.** The spec mentions plan creation dialogue in the chat interface. Plans are S6 — the chat page doesn't include plan creation or revision flows.
- **Hybrid evaluation for L2-L3 deferred.** The spec says L2-L3 shows both self-rating and AI rating. S5 uses AI evaluation only for L3+ (bloomLevel >= 3). Activities at L1-L2 remain self-rated only. Mixing both ratings in the same flow adds UI complexity for marginal benefit.
- **No student-generated activities in S5.** The `study_suggest_activity` IPC handler is wired for future use (spec section 6.4) but the chat UI doesn't prompt for self-authoring. The handler is added now because the study agent's dialogue may naturally produce activity suggestions — wiring it in S5 avoids a future IPC change.

---

## Key Decisions

### D1: Web channel extension — parallel JID pattern
Add `WEB_STUDY_PREFIX = 'web:study:'` alongside the existing `WEB_REVIEW_PREFIX = 'web:review:'`. Both share the same SSE infrastructure (`sseClients`, `responseBuffers`) and HTTP server. Study endpoints (`/study-message`, `/study-stream/{sessionId}`, `/study-close/{sessionId}`) are new routes on the same server.

**Why not a separate server?** The web channel already handles SSE streaming, CORS, response buffering, and connection lifecycle. Duplicating this infrastructure would double the code and add a new port. The JID prefix cleanly separates study from review traffic.

**Tradeoff:** The web channel file grows from 240 to ~350 lines. Acceptable — both JID patterns share the same infrastructure.

### D2: Study agent group registration — same pattern as review agent
Register `STUDY_AGENT_JID = 'web:study:__agent__'` at startup in `src/index.ts`, same as `REVIEW_AGENT_JID`. Mount the vault read-only and `groups/study/` read-write. The study agent's CLAUDE.md contains method instructions, evaluation rubrics, and IPC output format.

**Why a static registration?** The container lifecycle (spawn on first message, kill on close/timeout) is identical to review agents. The `findGroupForJid()` function already maps JID prefixes to groups — adding a second prefix is one `if` clause.

### D3: AI evaluation flow — dashboard proxies to study agent
Student submits L3+ response on `/study/session` → dashboard `POST /api/study/evaluate` → proxies to web channel `POST /study-message` → study agent evaluates against vault content via tools → agent writes `study_complete` IPC → main process calls `processCompletion()` → dashboard polls for result.

**Why IPC for completion, not SSE?** The study agent's evaluation writes must go through the backend's `processCompletion()` to update SM-2, mastery, and bloom ceiling atomically. If the dashboard did this, the completion would bypass the backend's advancement and generation logic. The IPC path ensures a single source of truth.

**Evaluation reuses session container:** When the student clicks "AI Evaluate" on `/study/session`, the dashboard uses the same `sessionId` that was created when the study session started (via `POST /api/study/session`). The first evaluation call creates a container via the web channel; subsequent evaluations in the same session reuse that container. This avoids cold-starting a new container per activity. The container dies after 30-min idle timeout or when the study session ends.

**Polling for result:** The completion result (quality score, advancement) comes from a separate `GET /api/study/evaluate/[sessionId]/result` poll that reads the activity_log entry created by the IPC handler. The poll waits up to 60s with 2s intervals (container cold start can take 15-20s for the first evaluation).

### D4: Study agent CLAUDE.md — method-specific sections
The study agent's system prompt (`groups/study/CLAUDE.md`) has sections for each method: Feynman, Socratic, case analysis, comparison, synthesis. Each section defines the dialogue pattern, when to use tools, and how to write IPC output. The brain-first principle is enforced globally: "Never reveal the answer before the student has attempted."

### D5: Container lifecycle — one per session, 30-min idle timeout
Each study chat session gets a fresh container. The container persists across all activities in that session (the student can switch concepts/methods mid-session). The container dies after 30-min idle timeout (existing `CONTAINER_TIMEOUT` config) or explicit close via `/study-close/{sessionId}`. The next session gets a fresh container.

**Why fresh per session?** Cognitive context. A Feynman dialogue about concept A shouldn't bleed into a Socratic dialogue about concept B in the next session. Clean containers prevent stale context.

---

## Essential Reading

> **For coordinators:** Extract relevant patterns from these files and inline them into subagent prompts. Subagents won't read the files themselves.

| File | Why |
|------|-----|
| `src/channels/web.ts` | Full web channel — SSE, response buffers, CORS, `/message`, `/stream/{id}`, `/close/{id}` endpoints. S5 adds parallel study endpoints. |
| `src/index.ts:79-80,135,252-261,656-690,784-835` | JID prefix constants, `activeWebReviewJids`, `findGroupForJid()`, review agent registration, `channelOpts` callbacks. S5 mirrors all of these for study. |
| `src/ipc.ts:704-747` | Existing `study_generation_request` and `study_post_session_generation` handlers. S5 adds `study_complete`, `study_concept_status`, `study_suggest_activity`. |
| `src/study/engine.ts:133-209` | `processCompletion()` and `getDeEscalationAdvice()` — the `study_complete` IPC handler calls these. |
| `src/study/generator.ts:45-134` | `generateActivities()` — called when advancement triggers new activity generation. |
| `src/channels/registry.ts` | `ChannelOpts` interface. S5 adds `onStudyClosed` callback. |
| `groups/study-generator/CLAUDE.md` | Existing generator agent prompt — reference for study agent prompt structure and IPC output format. |
| `groups/study/CLAUDE.md` | Current placeholder — S5 replaces with full prompt. |
| `dashboard/src/app/study/session/page.tsx` | Existing session page — S5 adds AI evaluation option for L3+ activities. |
| `dashboard/src/lib/study-db.ts` | Dashboard DB functions — S5 adds transcript persistence functions. |

---

## Task Numbering

| Plan task | Master plan items | What |
|-----------|-------------------|------|
| S5.1 | S5.1 | Extend web channel + message routing for study sessions |
| S5.2 | S5.9 | Add study IPC handlers (study_complete, study_concept_status, study_suggest_activity) |
| S5.3 | S5.2 | Design study agent CLAUDE.md |
| S5.4 | S5.1 (index.ts parts) | Register study agent group + wire into main process |
| S5.5 | S5.3, S5.5 (partial — hybrid L2-L3 deferred) | Dashboard chat API routes + evaluate endpoint |
| S5.6 | S5.4 | Create /study/chat page |
| S5.7 | S5.6, S5.7 | AI evaluation in /study/session + L3-L6 activity type UIs |
| S5.8 | S5.8 | Expand generator CLAUDE.md for L3-L6 activity types |
| S5.9 | — | Verification |

**Master plan errata:** S5.10 says "Add stretch block to session builder" — already implemented in S4.3 (session builder has new/review/stretch blocks). S5.7 says "Add L3-L6 activity types to /study/session" — this is partially S5.7 (UI variations) and partially S5.5 (evaluation endpoint).

---

## Parallelization & Model Recommendations

**Dependencies:**
- S5.1 → S5.4 (web channel before group registration wires to it)
- S5.2 is independent (backend IPC — no web channel dependency)
- S5.3 is independent (CLAUDE.md file — no code dependency)
- S5.4 depends on S5.1 (group registration references web channel callbacks)
- S5.5 depends on S5.1 + S5.4 (API routes proxy to web channel, need study group registered)
- S5.6 depends on S5.5 (chat page calls chat API routes)
- S5.7 depends on S5.5 (evaluation calls evaluate endpoint)
- S5.8 is independent (generator CLAUDE.md — no code dependency)

**Parallel opportunities:**
- S5.1 + S5.2 + S5.3 + S5.8 (web channel, IPC handlers, study agent CLAUDE.md, generator CLAUDE.md — fully independent)
- S5.6 + S5.7 (chat page + session evaluation — separate pages, both need S5.5)

| Task | Can parallel with | Model | Rationale |
|------|-------------------|-------|-----------|
| S5.1 | S5.2, S5.3, S5.8 | Sonnet | Extends existing pattern with parallel endpoints |
| S5.2 | S5.1, S5.3, S5.8 | Sonnet | New IPC switch cases following existing pattern |
| S5.3 | S5.1, S5.2, S5.8 | **Opus** | Creative writing — method instructions, evaluation rubrics, brain-first rules need pedagogical judgment |
| S5.4 | — | Sonnet | Group registration mirroring review agent pattern |
| S5.5 | — | Sonnet | API routes following dashboard pattern |
| S5.6 | S5.7 | Sonnet | SSE chat page — well-defined UI requirements |
| S5.7 | S5.6 | Sonnet | Extends existing session page with conditional evaluation |
| S5.8 | S5.1, S5.2, S5.3 | Sonnet | CLAUDE.md text additions following existing format |
| S5.9 | — | Sonnet | Mechanical verification |

**Skip two-stage review for:** S5.3, S5.8 (CLAUDE.md files — review content quality, not code correctness), S5.9 (verification). Full review for: S5.1, S5.2, S5.4, S5.5, S5.6, S5.7.

---

## S5.1: Extend Web Channel for Study Sessions

**Files:** Modify `src/channels/web.ts`, modify `src/channels/registry.ts`

**Parallelizable with S5.2, S5.3, S5.8.**

### Web channel changes

The web channel currently handles only `web:review:*` JIDs. S5 adds a parallel `web:study:*` JID pattern with its own endpoints. Both patterns share the same SSE infrastructure (response buffers, SSE clients, CORS handling).

**Current state of `src/channels/web.ts` (240 lines):**
- Constants: `JID_PREFIX = 'web:review:'`, `CORS_ORIGIN`
- State: `responseBuffers: Map<string, string[]>`, `sseClients: Map<string, Set<http.ServerResponse>>`
- Endpoints: `POST /message`, `GET /stream/{uuid}`, `POST /close/{uuid}`, `GET /recent`
- `sendMessage(jid, text)`: strips `JID_PREFIX`, writes to SSE clients + buffer
- `ownsJid(jid)`: `jid.startsWith(JID_PREFIX)`

**What to add:**

1. **New constant:** `const STUDY_PREFIX = 'web:study:';`

2. **New endpoint — `POST /study-message`:** Accepts `{ sessionId: string, text: string }`. Creates message with JID `web:study:{sessionId}`, calls `opts.onChatMetadata()` and `opts.onMessage()`. Same pattern as `handleMessage()` but with `STUDY_PREFIX` and field named `sessionId` instead of `draftId`. Chat metadata name: `'Study: {sessionId}'`.

3. **New endpoint — `GET /study-stream/{sessionId}`:** SSE connection for study chat. Same implementation as `handleSSE()` — adds client to `sseClients`, sends buffered responses, sends keepalive comment. The sessionId format is a UUID (same regex as draft routes: `/^\/study-stream\/([a-f0-9-]{36})$/`).

4. **New endpoint — `POST /study-close/{sessionId}`:** Signals study session container shutdown. Calls `opts.onStudyClosed?.(sessionId)`. Cleans up SSE clients and response buffers. Same pattern as `/close/{draftId}`.

5. **Update `sendMessage(jid, text)`:** Currently hardcoded to strip `JID_PREFIX`. Must handle both prefixes: extract the session/draft ID by stripping whichever prefix matches. Approach: `const id = jid.startsWith(STUDY_PREFIX) ? jid.replace(STUDY_PREFIX, '') : jid.replace(JID_PREFIX, '');`

6. **Update `ownsJid(jid)`:** Return `jid.startsWith(JID_PREFIX) || jid.startsWith(STUDY_PREFIX)`.

### Registry changes

**File: `src/channels/registry.ts`** (30 lines)

Add `onStudyClosed?: (sessionId: string) => void` to the `ChannelOpts` interface (alongside existing `onDraftClosed`).

**Constraint:** Do NOT refactor `handleMessage` into a shared function parameterized by prefix. The two handlers will diverge in S6+ (study messages include method context, concept state injection). Keep them as separate `handleStudyMessage()` and `handleMessage()` functions with clear duplication for now.

**Constraint:** Do NOT rename existing `handleMessage`/`handleSSE` functions. Add new `handleStudyMessage`/`handleStudySSE` functions alongside them.

- [ ] **Step 1:** Add `STUDY_PREFIX` constant and `onStudyClosed` to `ChannelOpts` in registry.ts
- [ ] **Step 2:** Add `handleStudyMessage()` function in web.ts
- [ ] **Step 3:** Add `handleStudySSE()` function in web.ts
- [ ] **Step 4:** Add `/study-message`, `/study-stream/{id}`, `/study-close/{id}` routes to `handleRequest()`
- [ ] **Step 5:** Update `sendMessage()` to handle both JID prefixes
- [ ] **Step 6:** Update `ownsJid()` to match both prefixes
- [ ] **Step 7:** Run backend tests: `npx vitest run src/channels` — no regressions
- [ ] **Step 8:** Verify: `npm run build` — clean
- [ ] **Step 9:** Commit: `feat(study): extend web channel with study session endpoints (S5.1)`

---

## S5.2: Add Study IPC Handlers

**Files:** Modify `src/ipc.ts`

**Parallelizable with S5.1, S5.3, S5.8.**

Add three new cases to the `processTaskIpc()` switch statement (currently at lines 308-746 in `src/ipc.ts`). These handle messages from the study container agent.

**Existing IPC context:** The function signature is `processTaskIpc(data, sourceGroup, isMain, deps)`. Cases are added to a switch on `data.type`. The `data` object has typed fields declared inline at lines 276-301. The S4-added cases `study_generation_request` (line 704) and `study_post_session_generation` (line 725) follow the pattern.

**Constraint:** Extend the `data` parameter type to include the new fields needed by S5 handlers: `activityId?: string`, `quality?: number`, `responseText?: string`, `responseTimeMs?: number`, `aiFeedback?: string`, `surface?: string`, `domain?: string`, `activityType?: string`, `prompt?: string`, `author?: string`. Add these alongside the existing optional fields in the type definition at lines 276-301. Without this, TypeScript will error on `data.activityId` etc.

### Case 1: `study_complete`

**Payload:** `{ type: 'study_complete', activityId: string, quality: number, sessionId?: string, responseText?: string, responseTimeMs?: number, aiFeedback?: string, surface: string }`

**Handler logic:**
1. Validate: `activityId` required (string), `quality` required (integer 0-5). Log error and break if missing or invalid.
2. Call `processCompletion()` from `src/study/engine.js` — pass all fields through:
   ```typescript
   processCompletion({
     activityId: data.activityId,
     quality: data.quality,
     sessionId: data.sessionId,
     responseText: data.responseText,
     responseTimeMs: data.responseTimeMs,
     evaluationMethod: data.aiFeedback ? 'ai_evaluated' : 'self_rated',
     aiQuality: data.aiFeedback ? data.quality : undefined,
     aiFeedback: data.aiFeedback,
     surface: data.surface ?? 'dashboard_chat',
   })
   ```
   The backend's `CompleteActivityInput` already accepts `evaluationMethod`, `aiQuality`, `aiFeedback`, `sessionId`, and `responseTimeMs` — the transaction writes them atomically. Do NOT do a separate UPDATE after the transaction.
3. If the completion result has `generationNeeded`, call `generateActivities(result.advancement.conceptId, result.advancement.newCeiling)` — same pattern as `study_generation_request` handler.
4. Log: `study_complete: activityId={id}, quality={n}, advancement={yes/no}`.

**Constraint:** Do NOT check `isMain` — study agent containers are not main-group. This matches the S4 pattern where `study_generation_request` has no `isMain` check.

### Case 2: `study_concept_status`

**Payload:** `{ type: 'study_concept_status', conceptId?: string, domain?: string }`

**Handler logic:**
1. If `conceptId` provided: look up concept by ID, get recent activity logs (last 10), compute mastery levels via `computeMastery()`, get bloom ceiling.
2. If `domain` provided: get all active concepts in that domain with mastery summaries.
3. If neither: log warning and break.
4. Write response JSON to `data/ipc/{sourceGroup}/responses/concept-status-{timestamp}.json`.

**IPC response directory:** The response goes to a `responses/` subdirectory, NOT `tasks/`. The IPC watcher monitors `tasks/` directories and would re-process response files. The `responses/` directory is not watched. The agent reads from `/workspace/ipc/responses/` (same host directory, mounted into the container). Ensure this directory is created via `fs.mkdirSync({ recursive: true })`.

**Container mount note:** The agent's IPC namespace is `study/{sessionId}` so the host path is `data/ipc/study/{sessionId}/`. The container mounts this at `/workspace/ipc/`. The response file goes to `data/ipc/study/{sessionId}/responses/` on the host, readable at `/workspace/ipc/responses/` in the container.

**Note:** This handler needs imports from `src/study/queries.js` for `getConceptById`, `getRecentActivityLogs`, and `getActivitiesByConcept`. Also needs `computeMastery`, `computeBloomCeiling`, `computeOverallMastery` from `src/study/mastery.js`.

### Case 3: `study_suggest_activity`

**Payload:** `{ type: 'study_suggest_activity', conceptId: string, activityType: string, prompt: string, bloomLevel: number, author: 'student' | 'system' }`

**Handler logic:**
1. Validate: `conceptId`, `activityType`, `prompt`, `bloomLevel` all required. Validate `activityType` against the same 8-type allowlist used in `study_generated_activities` handler (line 622): `card_review`, `elaboration`, `self_explain`, `concept_map`, `comparison`, `case_analysis`, `synthesis`, `socratic`. Validate `bloomLevel` is integer 1-6.
2. Create a single activity using the same `batchCreateActivities()` call used in `study_generated_activities` handler (line 677). Activity fields: `conceptId: data.conceptId`, `activityType: data.activityType`, `prompt: data.prompt`, `bloomLevel: data.bloomLevel`, `author: data.author ?? 'student'`, `referenceAnswer: ''`, `difficultyEstimate: 5`, `generatedAt: new Date().toISOString()`, `dueAt: new Date().toISOString().split('T')[0]` (due immediately). Also create the concept link via `batchCreateConceptLinks()` — same pattern as `study_generated_activities` handler (line 690).
3. Log: `study_suggest_activity: conceptId={id}, type={type}, bloomLevel={level}`.

- [ ] **Step 1:** Add `study_complete` case to `processTaskIpc()` switch
- [ ] **Step 2:** Add `study_concept_status` case
- [ ] **Step 3:** Add `study_suggest_activity` case
- [ ] **Step 4:** Add necessary imports at top of file (engine functions, mastery functions, schema, drizzle operators)
- [ ] **Step 5:** Run backend tests: `npx vitest run src/ipc` — no regressions
- [ ] **Step 6:** Verify: `npm run build` — clean
- [ ] **Step 7:** Commit: `feat(study): add study_complete, study_concept_status, study_suggest_activity IPC handlers (S5.2)`

---

## S5.3: Design Study Agent CLAUDE.md

**Files:** Replace `groups/study/CLAUDE.md`

**Parallelizable with S5.1, S5.2, S5.8.**

Replace the current placeholder (13 lines) with the full study agent system prompt. This is the most pedagogically important file in S5 — it determines the quality of the AI tutor's interactions.

**Current content:**
```markdown
# Study Agent
**Role:** Interactive study tutor for university courses.
## Core Principles
- **Brain-first:** ...
- **Desirable difficulties:** ...
- **Suggest strongly, enforce nothing:** ...
> Full prompt designed in S5.
```

### Structure of the full CLAUDE.md

The prompt should be organized into these sections. The agent sees this as its system prompt when the container starts.

**1. Role & Core Principles (~20 lines)**
- You are a study tutor for a university student. Your job is to facilitate deep learning through dialogue — not to lecture.
- Brain-first (Kosmyna et al. 2025): Never reveal an answer before the student has attempted. Always let the student produce output first.
- Desirable difficulties (Bjork 1994): Productive struggle is the goal, not comfortable confirmation. If the student finds it easy, push harder.
- Suggest strongly, enforce nothing: Offer evidence-based guidance, but respect autonomy. No guilt, no judgement.
- Personalization effect (Mayer 2002): Use conversational style. Address the student directly. Be warm but intellectually rigorous.

**2. Session Context (~10 lines)**
- The first message you receive contains context: concept title, Bloom's level, method, and any previous dialogue context.
- Parse this context to understand what you're working on. Respond within the scope of the specified concept and method.
- If the student wants to switch topics or methods, acknowledge and adapt.

**3. Method-Specific Instructions (~80 lines total)**

Each method gets its own subsection with dialogue pattern and examples:

**Feynman Technique (L2-L4):**
- Ask the student to explain the concept as if teaching someone who knows nothing about it.
- Listen for gaps, oversimplifications, and incorrect causal reasoning.
- When you identify a gap: ask a targeted follow-up question that exposes it. Do NOT explain the gap yourself.
- After 2-3 rounds: summarize what the student got right, identify remaining gaps, suggest what to review.
- IPC: Write `study_complete` when the dialogue concludes with a quality assessment (0-5).

**Socratic Questioning (L4-L6):**
- Never state facts. Only ask questions.
- Start with an open-ended question about the concept's assumptions or implications.
- If the student gives a shallow answer: probe deeper ("What would happen if that assumption were wrong?", "How do you know that?").
- If the student is stuck: narrow the question scope, don't answer it.
- Build toward the student reaching a conclusion independently.
- End with a reflective question: "What did you learn about your own thinking?"

**Case Analysis (L3-L6):**
- Present or discuss a real-world scenario requiring theory application.
- Guide through: (1) identify the problem, (2) select relevant frameworks, (3) analyze using the frameworks, (4) recommend action.
- At each step, ask the student to produce before you evaluate.
- Compare the student's analysis against expert reasoning.

**Comparison / Contrast (L4-L5):**
- Two or more concepts/frameworks/theories being compared.
- Ask the student to identify dimensions of comparison before providing your own.
- Push for structural comparison (how they work), not just surface differences (what they look like).
- Reference Gentner's structure-mapping theory: analogies based on relational structure, not surface features.

**Synthesis (L5-L6):**
- Multiple concepts must be integrated to address a complex question.
- Ask the student to articulate the connections before you fill in gaps.
- Evaluate: Does the synthesis show genuine integration, or just serial summarization?
- Push for an argument or position, not just a list of related ideas.

**4. AI Evaluation Mode (~20 lines)**
- When the first message contains `[EVALUATE]` prefix, you're in evaluation mode.
- You receive: the activity prompt, the student's response, and the reference answer.
- Use your tools to access vault content for additional context if the reference answer is insufficient.
- Evaluate against the Bloom's level rubric (see section 5).
- Output: Write a `study_complete` IPC file with `quality` (0-5) and `aiFeedback` (2-3 sentences: what was good, what was missing, what to review). Include `responseText` with the student's original response.
- Then respond via stdout with the same feedback text so it streams to the student via SSE.
- Do NOT add encouragement fluff. Be specific about what was right and wrong.

**4b. Transcript Persistence (~10 lines)**
- For multi-turn dialogues (Feynman, Socratic, case analysis, synthesis): when you write `study_complete` at the end of the dialogue, include the full conversation transcript in `responseText`. Format: alternating `STUDENT: ...` and `TUTOR: ...` lines.
- For evaluation mode: `responseText` is the student's original response (not the full exchange).
- This is how chat transcripts are saved — the `processCompletion()` handler stores `responseText` in `activity_log.response_text` and `aiFeedback` in `activity_log.ai_feedback`.

**5. Bloom's Level Evaluation Rubrics (~30 lines)**
- L1 (Remember): Correct facts recalled? Missing key terms?
- L2 (Understand): Can explain in own words? Correct causal reasoning?
- L3 (Apply): Can use concept in a new context? Correct application of procedure/framework?
- L4 (Analyze): Can break down components? Identify relationships? Distinguish relevant from irrelevant?
- L5 (Evaluate): Can make judgments? Compare alternatives? Argue for a position with evidence?
- L6 (Create): Can synthesize new understanding? Produce original argument? Connect across domains?

Quality mapping:
- 0: No meaningful response / completely wrong
- 1: Major errors, fundamental misunderstanding
- 2: Partial understanding, significant gaps
- 3: Correct core reasoning, some gaps or imprecision
- 4: Strong understanding, minor gaps
- 5: Excellent — demonstrates mastery at or above the target Bloom's level

**6. IPC Output Format (~15 lines)**
- Write JSON files to `/workspace/ipc/tasks/`.
- `study_complete`: `{ "type": "study_complete", "activityId": "{id}", "quality": 0-5, "sessionId": "{sessionId from context}", "responseText": "student's text", "aiFeedback": "your feedback", "surface": "dashboard_chat" }`
- The `sessionId` is extracted from your JID (`web:study:{sessionId}`) — include it in every `study_complete` so the completion increments the session counter.
- `study_concept_status`: `{ "type": "study_concept_status", "conceptId": "{id}" }` — request concept mastery state.
- `study_suggest_activity`: `{ "type": "study_suggest_activity", "conceptId": "{id}", "activityType": "...", "prompt": "...", "bloomLevel": 1-6, "author": "system" }`

**7. Tool Usage (~10 lines)**
- You have read-only access to the vault at `/workspace/extra/vault/`.
- Use `Read` to look up vault notes for source content when evaluating or when the student references material.
- Use `Glob` to find relevant vault notes by pattern.
- Use `Grep` to search vault content for specific terms.
- Write IPC files using `Write` or `Bash`.

**Agent discretion:** Exact wording, example dialogues, how prescriptive each method section is, whether to include a "Common Mistakes" section. The structure and sections above are the requirement; the prose is yours.

**Constraint:** The total CLAUDE.md should be 200-350 lines. Longer prompts waste context window that the dialogue needs. Be concise — every line should teach the agent something it wouldn't do by default.

**Constraint:** Do NOT include RAG API instructions (curl to LightRAG). The agent uses vault file access for context, not RAG queries. RAG is for the generator agent.

- [ ] **Step 1:** Write the full `groups/study/CLAUDE.md` following the structure above
- [ ] **Step 2:** Verify line count is 200-350
- [ ] **Step 3:** Commit: `feat(study): design study agent CLAUDE.md with method instructions and rubrics (S5.3)`

---

## S5.4: Register Study Agent Group + Wire into Main Process

**Files:** Modify `src/index.ts`, modify `src/channels/registry.ts` (if not done in S5.1)

**Depends on:** S5.1.

### Study agent group registration

Follow the exact pattern of `REVIEW_AGENT_JID` registration (lines 656-690 in `src/index.ts`).

**New constants (near line 80):**
```typescript
const STUDY_AGENT_JID = 'web:study:__agent__';
const WEB_STUDY_PREFIX = 'web:study:';
```

**New tracking set (near line 135):**
```typescript
const activeWebStudyJids = new Set<string>();
```

**Extend `findGroupForJid()` (line 252):**
```typescript
function findGroupForJid(chatJid: string): RegisteredGroup | undefined {
  if (registeredGroups[chatJid]) return registeredGroups[chatJid];
  if (chatJid.startsWith(WEB_REVIEW_PREFIX) && registeredGroups[REVIEW_AGENT_JID]) {
    return registeredGroups[REVIEW_AGENT_JID];
  }
  if (chatJid.startsWith(WEB_STUDY_PREFIX) && registeredGroups[STUDY_AGENT_JID]) {
    return registeredGroups[STUDY_AGENT_JID];
  }
  return undefined;
}
```

**Register study agent group (near line 690, after review agent):**
```typescript
if (!registeredGroups[STUDY_AGENT_JID]) {
  registerGroup(STUDY_AGENT_JID, {
    name: 'Study Agent',
    folder: 'study',
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
    containerConfig: {
      additionalMounts: [
        {
          hostPath: join(process.cwd(), 'vault'),
          containerPath: 'vault',
          readonly: true,
        },
      ],
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
      ],
    },
  });
}
```

**Vault is read-only** for the study agent (unlike review agent which gets rw vault access). The study agent reads source material but shouldn't modify vault notes.

### Wire channelOpts callbacks

**In `channelOpts.onMessage` (near line 814):** Add study JID tracking alongside review JID tracking:
```typescript
if (chatJid.startsWith(WEB_STUDY_PREFIX)) {
  activeWebStudyJids.add(chatJid);
}
```

**Add `onStudyClosed` callback to channelOpts (near line 826):**
```typescript
onStudyClosed: (sessionId: string) => {
  const chatJid = `${WEB_STUDY_PREFIX}${sessionId}`;
  logger.info({ sessionId, chatJid }, 'Study session closed, shutting down study agent');
  queue.closeStdin(chatJid);
  activeWebStudyJids.delete(chatJid);
},
```

### Include study JIDs in message loop

**In `startMessageLoop()` (near line 493):** Add active study JIDs to the polling list:
```typescript
for (const webJid of activeWebStudyJids) {
  if (!jids.includes(webJid)) jids.push(webJid);
}
```

### Build study context (analogous to buildReviewContext)

Add a `buildStudyContext()` function that builds context for study chat messages. This is called in the message processing path (near line 301 where `buildReviewContext` is called).

**What to include in study context:** The first message of a study session should include the concept title, Bloom's level, and method. Subsequent messages in the same session don't need context injection — the container persists across the session.

**First-message detection:** Use a module-level `Set<string>` called `studySessionsInitialized`. When `buildStudyContext()` is called for a `web:study:*` JID, check if the JID is in the set. If not, prepend context and add the JID. If yes, return empty string. Remove the JID from the set in `onStudyClosed`. This is 3 lines of state and avoids coupling to GroupQueue internals.

**Agent discretion:** The context format itself — how to structure the concept/method/Bloom context that gets prepended to the first message.

- [ ] **Step 1:** Add `STUDY_AGENT_JID`, `WEB_STUDY_PREFIX`, `activeWebStudyJids` constants/set
- [ ] **Step 2:** Extend `findGroupForJid()` with study prefix clause
- [ ] **Step 3:** Register study agent group at startup
- [ ] **Step 4:** Add `onStudyClosed` to channelOpts
- [ ] **Step 5:** Add study JID tracking in `onMessage` callback
- [ ] **Step 6:** Include `activeWebStudyJids` in message loop polling
- [ ] **Step 7:** Add `buildStudyContext()` function and wire it into message processing
- [ ] **Step 8:** Run backend tests: `npm test` — no regressions
- [ ] **Step 9:** Verify: `npm run build` — clean
- [ ] **Step 10:** Commit: `feat(study): register study agent group and wire into main process (S5.4)`

---

## S5.5: Dashboard Chat API Routes + Evaluate Endpoint

**Files:** Create `dashboard/src/app/api/study/chat/route.ts`, create `dashboard/src/app/api/study/chat/stream/[sessionId]/route.ts`, create `dashboard/src/app/api/study/chat/close/route.ts`, create `dashboard/src/app/api/study/evaluate/route.ts`, create `dashboard/src/app/api/study/evaluate/[sessionId]/result/route.ts`

**Depends on:** S5.1, S5.4.

The dashboard proxies chat and evaluation requests to the web channel (port 3200) where the main process handles container lifecycle.

### POST /api/study/chat

**Body:** `{ sessionId: string, text: string, conceptId?: string, method?: string, bloomLevel?: number }`

Proxy to web channel: `POST http://localhost:3200/study-message` with `{ sessionId, text }`.

**First-message injection:** If `conceptId` and `method` are provided, prepend context to the text:
```
[CONTEXT] Concept: {conceptTitle} | Bloom's Level: L{bloomLevel} | Method: {method}

{text}
```
Look up concept title from DB using `getConceptById()` or a lightweight query. If concept not found, use conceptId as fallback.

**Response:** `{ ok: true }` (the actual agent response comes via SSE).

### GET /api/study/chat/stream/[sessionId]

Proxy SSE from web channel: `GET http://localhost:3200/study-stream/{sessionId}`.

This is a streaming proxy — the dashboard API route opens an SSE connection to the web channel and forwards events to the browser. Use Node's `fetch()` to connect to the web channel SSE endpoint, then pipe the response stream to the Next.js response.

**Constraint:** Read the Next.js streaming response guide in `node_modules/next/dist/docs/` before implementing. Streaming API routes may require specific patterns in this Next.js version.

### POST /api/study/evaluate

**Body:** `{ sessionId: string, activityId: string, responseText: string, conceptId: string, bloomLevel: number, prompt: string, referenceAnswer: string }`

Builds an evaluation request and sends it to the study agent:

1. Build evaluation message: `[EVALUATE] Activity: {activityId}\nConcept: {conceptTitle}\nBloom's Level: L{bloomLevel}\nPrompt: {prompt}\nReference Answer: {referenceAnswer}\n\nStudent Response:\n{responseText}`
2. Proxy to web channel: `POST http://localhost:3200/study-message` with `{ sessionId, text: evaluationMessage }`.
3. Response: `{ ok: true, sessionId }`.

The student sees the evaluation feedback streaming via SSE. The completion result (quality score, advancement) arrives via IPC → `study_complete` → DB write.

### POST /api/study/chat/close

**Body:** `{ sessionId: string }`

Proxy to web channel: `POST http://localhost:3200/study-close/{sessionId}`.

**Response:** `{ ok: true }`

### GET /api/study/evaluate/[sessionId]/result

Polls for the evaluation result. The study agent writes a `study_complete` IPC message, which the main process handles by calling `processCompletion()` and writing to `activity_log`.

**Query params:** `activityId` (required) — the activity being evaluated.

**Logic:**
1. Look up the most recent `activity_log` entry for this `activityId` where `evaluation_method = 'ai_evaluated'`.
2. If found: return `{ status: 'complete', quality, aiFeedback, advancement, deEscalation }`. The `advancement` and `deEscalation` fields come from checking the concept's current state.
3. If not found: return `{ status: 'pending' }`.

The dashboard polls this endpoint every 1s until it gets `status: 'complete'` or 30s timeout.

**Agent discretion:** Exact proxy implementation for SSE streaming, error handling for web channel connection failures, whether to use `fetch()` or `http.request()` for proxying.

- [ ] **Step 1:** Create `POST /api/study/chat` route
- [ ] **Step 2:** Create `GET /api/study/chat/stream/[sessionId]` SSE proxy route
- [ ] **Step 3:** Create `POST /api/study/chat/close` route
- [ ] **Step 4:** Create `POST /api/study/evaluate` route
- [ ] **Step 5:** Create `GET /api/study/evaluate/[sessionId]/result` polling route
- [ ] **Step 6:** Add `getLogByActivityIdAndMethod(activityId: string, method: string)` to study-db.ts
- [ ] **Step 7:** Verify: `cd dashboard && npx tsc --noEmit` — clean
- [ ] **Step 8:** Commit: `feat(dashboard): add study chat and AI evaluation API routes (S5.5)`

---

## S5.6: Create /study/chat Page

**Files:** Create `dashboard/src/app/study/chat/page.tsx`

**Depends on:** S5.5. **Parallelizable with S5.7.**

A multi-turn conversational interface connected to the study agent via SSE. The student selects a concept and method, then has a dialogue with the AI tutor.

### Page Structure

Single `'use client'` component. State machine:

```
SETUP → CHATTING → ENDED
```

**SETUP phase:**
- Concept selector: dropdown of active concepts (fetch from `GET /api/study/concepts`). Shows concept title + domain.
- Method selector: radio buttons — Feynman, Socratic, Case Analysis, Comparison, Synthesis, Free.
- "Start Chat" button → generates sessionId (UUID via `crypto.randomUUID()`), opens SSE connection, transitions to CHATTING.

If URL has query params (`?conceptId=...&method=...`), pre-select them and optionally auto-start.

**CHATTING phase:**
- Message list showing the conversation. User messages right-aligned (bg-blue-600), agent messages left-aligned (bg-gray-800). Messages render incrementally as SSE events arrive.
- Text input at bottom with send button. On send: `POST /api/study/chat` with `{ sessionId, text }`. Clear input. Add user message to list immediately (optimistic).
- Agent responses stream in via SSE (`GET /api/study/chat/stream/{sessionId}`). Parse each `data:` event — if `type === 'message'`, append text to current agent message. If `type === 'closed'`, the session is over.
- Context bar at top: shows current concept title, method badge, Bloom's level.
- "End Session" button → `POST /api/study/chat/close` with `{ sessionId }` (proxied through dashboard API route from S5.5), transitions to ENDED.

**ENDED phase:**
- "Session ended" banner. Link to `/study` and "New Chat" button.

### SSE Connection Management

Use `EventSource` or `fetch()` + `ReadableStream` to connect to `GET /api/study/chat/stream/{sessionId}`.

Pattern for streaming text:
```typescript
const es = new EventSource(`/api/study/chat/stream/${sessionId}`);
es.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'message') {
    // Append to current agent message
  } else if (data.type === 'closed') {
    es.close();
  }
};
```

**Constraint:** Clean up EventSource on unmount (return cleanup function from useEffect). Close on page navigation.

### Design

- Dark theme consistent with dashboard: bg-gray-950, text-gray-100
- Message bubbles: user bg-blue-600, agent bg-gray-800, rounded-lg, max-w-[80%]
- Input: bg-gray-900 border-gray-700, full width, auto-growing textarea
- Send button: bg-blue-600 hover:bg-blue-700
- Context bar: bg-gray-900 border-b border-gray-800, concept title + method badge
- Auto-scroll to bottom on new messages

**Agent discretion:** Component decomposition, exact Tailwind, animations, mobile responsiveness, whether to split message list into its own component.

- [ ] **Step 1:** Create page with SETUP phase (concept/method selectors)
- [ ] **Step 2:** Implement SSE connection and CHATTING phase message list
- [ ] **Step 3:** Implement text input and send functionality
- [ ] **Step 4:** Implement ENDED phase and cleanup
- [ ] **Step 5:** Start dashboard: `cd dashboard && npm run dev`. Navigate to `/study/chat`, verify concept list loads
- [ ] **Step 6:** Commit: `feat(dashboard): add /study/chat page with SSE streaming dialogue (S5.6)`

---

## S5.7: AI Evaluation in /study/session + L3-L6 Activity Type UIs

**Files:** Modify `dashboard/src/app/study/session/page.tsx`

**Depends on:** S5.5. **Parallelizable with S5.6.**

The existing session page handles all activities with self-rating only. S5 adds:
1. Activity-type-specific UI variations for L3-L6 types
2. An "AI Evaluate" option for activities where `bloomLevel >= 3`

### Activity Type UI Variations

Currently, all activities show the same UI: prompt → text area → submit → reference answer → self-rate. S5 adds variations:

**`self_explain` (Feynman):**
- Prompt: "Explain {concept} as if teaching someone who knows nothing about it."
- Large text area (min 6 rows)
- After submit: reference answer shown + AI evaluation option (see below)
- No change to submit/rate flow for L1-L2 self_explain activities

**`concept_map`:**
- Prompt: "List the key concepts related to {topic} and describe their relationships."
- Large text area (min 8 rows)
- Reference answer shows expected relationships

**`comparison`:**
- Prompt: "Compare {X} and {Y} along the following dimensions: ..."
- Large text area (min 6 rows)
- Reference answer shows expert comparison

**`case_analysis`:**
- Prompt: scenario description
- Multi-step UI: Step 1 "Identify the problem" → Step 2 "Select framework" → Step 3 "Analyze" → Step 4 "Recommend"
- Each step gets its own text input. All steps concatenated as `responseText`.
- Reference answer shows expert analysis

**`synthesis`:**
- Prompt: "Integrate concepts {A}, {B}, {C} to address: {question}"
- Large text area (min 10 rows, essay-length)
- Reference answer shows integration approach

**`socratic`:**
- Instead of in-session activity: show "This activity is best completed as a dialogue." + "Open in Study Chat" button → navigates to `/study/chat?conceptId={id}&method=socratic`
- Mark as skipped if the student clicks "Skip" without opening chat

### AI Evaluation Flow (L3+ Activities)

For activities where `bloomLevel >= 3` AND `activityType` is NOT `card_review`:

After the student submits their response (clicks "Submit"), instead of immediately showing the reference answer and self-rating buttons, show two options:

```
[AI Evaluate]  [Self-Rate]
```

**If "Self-Rate" clicked:** Normal flow — show reference answer, show rating buttons. `evaluation_method` remains `'self_rated'`.

**If "AI Evaluate" clicked:**
1. Show "AI is evaluating your response..." spinner
2. Open SSE connection: `GET /api/study/chat/stream/{sessionId}` using the study session's sessionId (same ID created in PRE_SESSION). This reuses the container if one is already running — avoids cold-starting a new container per evaluation.
3. Send evaluation request: `POST /api/study/evaluate` with `{ sessionId, activityId, responseText, conceptId, bloomLevel, prompt, referenceAnswer }`
4. Stream AI feedback text below the spinner as it arrives via SSE
5. Poll `GET /api/study/evaluate/{sessionId}/result?activityId={id}` every 2s
6. When result arrives: show quality score badge, advancement info if any, de-escalation advice if any
7. Show "Next" button to advance (no self-rating needed — AI provided the quality score)
8. The IPC handler has already called `processCompletion()`, so SM-2 and mastery are updated

**Surface value:** The evaluation request message should set `surface: 'dashboard_ui'` (not `'dashboard_chat'`) since this runs from the session page, not the chat page. The study agent CLAUDE.md defaults to `'dashboard_chat'` but the `[EVALUATE]` context should override this.

**Timeout handling:** If 60s passes without a result (container cold start can take 15-20s), show "Evaluation timed out. Please self-rate." and fall back to self-rating flow.

### State Changes

Add to the component state:
- `evaluationMode: 'choosing' | 'evaluating' | 'result' | 'self_rate' | null` — tracks which evaluation flow is active
- `aiFeedback: string` — accumulated streaming feedback text
- `aiQuality: number | null` — quality from AI evaluation

The `evaluationMode` is set to `'choosing'` after submit if `bloomLevel >= 3` and `activityType !== 'card_review'`. Otherwise it's `null` and the existing self-rate flow runs.

**Constraint:** Do NOT break the existing self-rate flow for L1-L2 activities. The AI evaluation is additive — `bloomLevel < 3` activities behave exactly as before.

**Constraint:** The case_analysis multi-step UI is optional — if it adds too much complexity, a single large text area is acceptable for S5. The multi-step structure can be refined in S8.

- [ ] **Step 1:** Add activity-type-specific prompt rendering (different text area sizes, socratic redirect)
- [ ] **Step 2:** Add evaluation mode state and "AI Evaluate" / "Self-Rate" choice for L3+ activities
- [ ] **Step 3:** Implement AI evaluation flow (SSE + polling)
- [ ] **Step 4:** Implement timeout fallback to self-rating
- [ ] **Step 5:** Start dashboard, test with L3+ activities at `/study/session`. Verify L1-L2 flow unchanged.
- [ ] **Step 6:** Commit: `feat(dashboard): add AI evaluation and L3-L6 activity UIs to /study/session (S5.7)`

---

## S5.8: Expand Generator CLAUDE.md for L3-L6 Activity Types

**Files:** Modify `groups/study-generator/CLAUDE.md`

**Parallelizable with S5.1, S5.2, S5.3.**

The generator agent currently has specifications for all 8 activity types in its CLAUDE.md (lines 60-200+ of the existing file). However, the L3-L6 generation guidelines may need expansion to produce higher-quality prompts for deep learning activities.

### What to add/expand

Review the existing `groups/study-generator/CLAUDE.md` and add or expand the following sections:

**Feynman / self_explain prompts (L2-L4):**
- Prompts should ask for explanation in the student's own words
- Must specify what to explain (not just "explain X" — target specific aspects)
- Reference answer should list the key points a complete explanation would cover, NOT be a full explanation itself
- Example: "Explain how Nonaka's SECI model accounts for the conversion of tacit knowledge to explicit knowledge. Focus on the socialization and externalization phases."

**Comparison prompts (L4-L5):**
- Must specify 2+ concepts and comparison dimensions
- Reference answer should be a structured comparison, not a narrative
- Use the `activity_concepts` join table for multi-concept activities (include all related conceptIds in the output)
- Example: "Compare Polanyi's tacit knowledge and Nonaka's tacit knowledge along three dimensions: definition, role in knowledge creation, and how it's made accessible."

**Case analysis prompts (L3-L6):**
- Must present a realistic scenario (not abstract)
- Reference answer should walk through the analytical framework step by step
- Include the framework to apply (not just "analyze this case")
- Example: "A hospital's quality improvement team has collected extensive data but staff continue to rely on informal experience rather than documented protocols. Using Nonaka's SECI model, diagnose which knowledge conversion phase is failing and propose an intervention."

**Synthesis prompts (L5-L6):**
- Must reference 2-3 concepts that need to be integrated
- The question should require genuine integration, not serial summarization
- Reference answer should demonstrate the synthesis structure
- Use the `activity_concepts` join table

**Socratic starters (L4-L6):**
- These are dialogue openers, not standalone questions
- The prompt should be an assumption-challenging question that starts a Socratic dialogue
- Reference answer should be the expected line of reasoning, not a direct answer
- Example: "If knowledge can only exist in people's heads (as tacit knowledge theorists claim), how do organizations learn anything?"

**Agent discretion:** Exact examples, how many examples per type, how to integrate with existing content (add new sections vs. expand existing ones).

- [ ] **Step 1:** Review existing generator CLAUDE.md content for L3-L6 types
- [ ] **Step 2:** Expand or add generation guidelines for self_explain, comparison, case_analysis, synthesis, socratic types
- [ ] **Step 3:** Verify total CLAUDE.md length is reasonable (under 500 lines)
- [ ] **Step 4:** Commit: `feat(study): expand generator CLAUDE.md with L3-L6 activity guidelines (S5.8)`

---

## S5.9: Verification

**Depends on:** All previous tasks.

- [ ] **Step 1:** Run backend tests: `npm test` — all pass, no regressions
- [ ] **Step 2:** Build: `npm run build` — clean
- [ ] **Step 3:** Dashboard types: `cd dashboard && npx tsc --noEmit` — clean
- [ ] **Step 4:** Start all services: NanoClaw (`npm run dev`), Dashboard (`cd dashboard && npm run dev`)
- [ ] **Step 5:** Navigate to `/study/chat` — concept and method selectors render
- [ ] **Step 6:** Select a concept and method, click "Start Chat" — SSE connection established, context bar shows concept
- [ ] **Step 7:** Type a message and send — message appears in chat, agent response streams back
- [ ] **Step 8:** Navigate to `/study/session` — start a session with L3+ activities available
- [ ] **Step 9:** Submit a response to an L3+ activity — "AI Evaluate" and "Self-Rate" buttons appear
- [ ] **Step 10:** Click "Self-Rate" — normal rating flow works (regression test)
- [ ] **Step 11:** Click "AI Evaluate" on another L3+ activity — evaluation streams feedback, quality score appears
- [ ] **Step 12:** Complete session — post-session reflection works, mastery updates
- [ ] **Step 13:** Commit: `chore(study): verify S5 dashboard chat and AI evaluation end-to-end (S5.9)`

---

## Acceptance Criteria

From master plan S5 (non-negotiable):

- [ ] Dashboard chat streams agent responses in real-time via SSE
- [ ] Feynman dialogue: student explains → agent identifies gaps → follow-up questions
- [ ] AI evaluation returns quality (0-5) + textual feedback for L3+ activities
- [ ] All 8 activity types functional in session UI (card_review, elaboration, self_explain, concept_map, comparison, case_analysis, synthesis, socratic)
- [ ] Socratic type redirects to `/study/chat` with method pre-selected
- [ ] Chat transcripts saved and linked to sessions/concepts (via activity_log)
- [ ] Study agent IPC contract works: study_complete writes are processed correctly
- [ ] L1-L2 self-rating flow unchanged (no regressions)
- [ ] All existing tests pass (`npm test`)
- [ ] Clean build (`npm run build`, `cd dashboard && npx tsc --noEmit`)
