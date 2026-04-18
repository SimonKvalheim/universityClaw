# Mr. Rogers Live — Design Spec (Deferred Stub)

**Status**: deferred. Blocked on designing a request/response IPC primitive between the dashboard and the per-group Claude Agent SDK container. This document captures the intended architecture and the open problem so we can return to it later without re-deriving the context.

## Why deferred

A subagent review of the initial combined voice-chat spec identified the `ask_mr_rogers` transport as a load-bearing unknown:

1. Existing IPC (`src/ipc.ts`) is a one-way filesystem-drop protocol. The container writes JSON files; the host picks them up and applies them. **There is no existing request/response correlation primitive.** `study_concept_status` writes to `ipc/{group}/responses/` but nothing reads those back for a waiting caller.
2. The main-group Claude container is already shared with Telegram. `GroupQueue.enqueueMessageCheck` uses a boolean `pendingMessages` flag to signal "more work to do," not a FIFO of distinct prompts. Injecting a voice-originated tool call while a Telegram turn is in flight does not give back a typed response; it's absorbed into the next Telegram-shaped reply.
3. Gemini's tool-call timeout is ~60 s. A Claude container vault search + reasoning turn can take 30–120 s. Without a dedicated blocking RPC path, `ask_mr_rogers` tool calls will time out and the "real" answer will appear in the Telegram chat minutes later — not the intended UX.
4. Runaway-loop risk: Gemini Live audio output is expensive; `ask_mr_rogers` → Claude → vault + RAG → text → Gemini narrates → user asks follow-up creates a multiplicative cost path. No cap, no budget estimate, no loop guard in the current design.

Addressing these requires a new IPC primitive, not a small reuse. That design work is deliberately **separated from** the v1 voice feature (`2026-04-18-live-voice-chat-design.md`), which ships the Dev Assistant persona using Gemini Live alone.

## Intended architecture (sketch, unchanged from earlier brainstorm)

- **Voice face**: the same `VoiceSession` + `/voice` page infrastructure shipped in v1. Gemini 3.1 Flash Live is the conversational agent.
- **Hybrid tool**: a new tool `ask_mr_rogers(question)` added to the Mr. Rogers persona config. Gemini Live handles natural back-and-forth natively; the tool is the escape hatch for anything that needs memory, vault writes, study-system state, or planning.
- **Backend of the tool**: posts the question into the main Telegram group's Claude container, awaits the container's response, returns it to Gemini.
- **Shared state**: by design, voice turns flow into the main group's conversation log (scope A from the earlier brainstorm). A voice session ends with a summary written via `ask_mr_rogers` → a single log entry tagged `[voice-session]` with metadata, plus a full archive at `groups/{main}/voice-archive/YYYY-MM-DD-HHMM.md`.
- **Startup context**: today's plan, recent concepts, open questions from the student profile. Injected via the same `clientContent` first-turn mechanism as the Dev Assistant.
- **Default voice**: `Aoede` (warmer) vs Dev's `Zephyr`.

## Open problems (must be resolved before a real plan)

### 1. Request/response IPC primitive

The central design problem. Candidate approaches:

- **Correlation-ID over existing IPC**: caller drops a `requests/<id>.json`; container picks it up, produces `responses/<id>.json`; host polls. Matches the existing model but requires a **new host-side poller** that correlates, times out, and resolves a promise. Not free, but fits the pattern.
- **Direct HTTP surface from the container**: the agent-runner exposes a small HTTP endpoint (inside the container) that the dashboard calls with a correlation ID, and the container answers synchronously. Requires plumbing the container's port out to the host, which is a larger architectural change.
- **Dedicated voice-tool container**: spin up a second container per voice session that only handles `ask_mr_rogers` calls, with its own short-lived IPC. Isolates voice from the main-group's Telegram turns at the cost of doubled container spawn latency and separate memory state.

The choice has implications for reliability, latency, cost, and whether voice and Telegram can run in parallel. Worth an agent-run design exploration before committing.

### 2. Container contention with Telegram

Even with a blocking RPC, two agents sharing the same container state (voice and Telegram) may race. Options:

- Serialize via the existing `GroupQueue` and accept voice-pauses-Telegram and vice versa. Document the UX consequence ("if a Telegram message is mid-flight, voice tool calls queue behind it and may time out").
- Use a separate container for voice tool calls (see option 3 above), at the cost of fragmented conversation memory.
- Add a priority lane to `GroupQueue` so interactive voice preempts background Telegram work. Introduces fairness concerns.

### 3. Cost and runaway-loop guards

- Per-session `ask_mr_rogers` invocation cap (e.g. 10 per session).
- Per-session token/dollar cap driven by the `voice_sessions` cost tracker built in v1.
- Hard end-of-session trigger if cumulative cost crosses a configurable threshold (auto-stop with a spoken notice).

### 4. Log-pollution vs continuity tradeoff

Voice turns landing in the Telegram log is the whole point of "shared scope," but it also means that opening Telegram will show a summary of a voice session the user might have forgotten. Needs an explicit UX decision: summary only? Full transcript linked? Neither, and voice stays out of the group log by default?

### 5. Voice + Telegram collision UX

User types on Telegram while a voice session is running. What happens?

- Both go to the same container (serialized), so one blocks the other.
- Voice transcribed captions could echo in Telegram or vice versa.
- Or: block text input on Telegram while a voice session is active.

All of these are product decisions, not engineering ones, and should be answered before the plan.

## Prerequisites

1. Voice infrastructure shipped (v1 `2026-04-18-live-voice-chat-design.md`).
2. Gemini TTS/STT migration shipped (`2026-04-18-gemini-tts-stt-migration-design.md`) — specifically the `GEMINI_API_KEY` rename.
3. IPC request/response primitive designed, built, and tested in isolation (likely its own spec under a name like `2026-xx-xx-container-rpc-design.md`).
4. Product answers to the five open problems above.

## When to revive

After v1 dogfood delivers clear signal that the Dev Assistant is useful, AND an IPC primitive has been designed. Not before.

## Relationship to Other Specs

- `2026-04-18-live-voice-chat-design.md` — v1 voice infrastructure and Dev Assistant persona. Provides `/voice`, `VoiceSession`, cost tracking, preview pane, transcript handling — all reusable.
- `2026-04-18-gemini-tts-stt-migration-design.md` — `GEMINI_API_KEY` env var required.
