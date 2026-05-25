# Mr. Rogers Memory: Concept-Delivery Ledger and Outbound Message Log

**Date:** 2026-05-23 (revised 2026-05-24 after code review)
**Status:** Approved

## Problem

Mr. Rogers (the cron-scheduled `study-daily-morning` agent) repeats himself. On 2026-05-23 he delivered the *Shadow AI Economy* concept — the same concept he delivered on 2026-05-16, exactly one week earlier. Two of two recent concept-format deliveries are duplicates.

Three converging gaps cause this:

1. **`study-daily-morning` runs with `context_mode='isolated'`** (`src/task-scheduler.ts:155-156`). Every morning is a brand-new Claude session with no transcript carried forward. The agent literally cannot see what he sent yesterday.
2. **Outbound messages are not logged.** The `messages` table only stores Simon's inbound. The `is_bot_message` column exists in the schema but no live write path uses it. Reconstructing what the agent sent requires SQL forensics on `task_run_logs.result`.
3. **The CLAUDE.md hint to "read `conversations/` for past history"** points at an unmaintained folder that's been frozen since 2026-04-02. No code in the repo writes to it.

The prompt says *"avoid repeating topics from recent days"* but nothing in the agent's environment defines "recent days."

## Goals

- Mr. Rogers stops repeating concepts within a 14-day window.
- Past bot utterances are queryable from the database, *including by future agent runs* (closes the broader observability hole — see §0 Bot-inclusive reader).
- The fix is composable: structured concept dedup and general chat history are two independently-useful pieces.

## Non-goals

- Changing `context_mode` from `isolated` to `group`. That risks unbounded session bloat and mixes interactive chat with cron output — a separate decision.
- Solving the laptop-asleep-at-07:00 timeout problem. That's its own spec.
- Building dashboard UI for the new tables. Out of scope; tables can be inspected via SQL until there's a real product need.
- Backfilling all historical outbound from `task_run_logs` into `messages`. A one-shot best-effort backfill of the concept ledger is in scope; full transcript reconstruction is not.

## Design

### Overview

Two complementary additions, each independently shippable:

1. A typed **`delivered_concepts`** ledger table. Mr. Rogers writes a row every time he sends a concept. The next cron run sees the last 14 days of entries pre-injected into the prompt.
2. **Outbound message logging** into the existing `messages` table with `is_bot_message=1`. Hooked at `router.ts:routeOutbound` — the single chokepoint that every outbound message in the codebase already passes through (or that we redirect callers to use).

A new **IPC request/response primitive** (§0) supports the MCP tool's need to return structured success/failure to the agent.

The two halves are deliberately decoupled. The ledger is structured and is the dedup primitive. The outbound log is a faithful chat transcript and serves general observability.

### Repeat policy

Soft recency dedup: do not repeat any concept delivered in the last **14 days**. After 14 days a concept is eligible again. This matches Simon's spaced-repetition vision — concepts cool, then circle back with new framing.

The window is currently fixed at 14 days. If real usage suggests a different value, a single named constant changes.

The dedup boundary is `Date.now() - 14 * 86_400_000` in UTC ISO 8601. Cron schedules use `Europe/Oslo` local time. The 1-hour DST shifts mean the boundary can slide by up to an hour relative to delivery time — acceptable for a soft window.

### 0. IPC request/response primitive

Existing container→host IPC is fire-and-forget: `writeIpcFile(TASKS_DIR, data)` drops a JSON file the host watcher picks up and dispatches via `processTaskIpc`. There is no return channel today.

A subset of host-side verbs (audio synthesis at `src/ipc.ts:790-798`, two more at lines 903 and 1048) already write response files into `data/ipc/<group>/responses/`. The container does not currently poll that directory.

This spec generalizes the response pattern:

**Container side** (`container/agent-runner/src/ipc-helpers.ts`, new file):

```
function writeIpcRequestAwaitResponse(dir, data, opts?):
  requestId = randomId
  filename = `${Date.now()}-${requestId}.json`
  data.requestId = requestId
  write file atomically (existing pattern)
  poll responses/<requestId>.json for up to opts.timeoutMs (default 10s)
  on file appears: read, parse, unlink, return body
  on timeout: throw IpcTimeoutError
```

**Host side** (`src/ipc.ts`): when a verb completes, if the inbound `data.requestId` is set, write the JSON response to `<ipcBaseDir>/<sourceGroup>/responses/<requestId>.json` atomically (temp file + rename). The existing audio/study verbs already do this — generalize via a small `writeIpcResponse(sourceGroup, requestId, body)` helper.

Fire-and-forget callers (which is currently everything) simply don't set `requestId` and don't poll. Backward compatible.

### 1. `delivered_concepts` table

```
delivered_concepts
├─ id              TEXT PK (UUID)
├─ concept_id      TEXT NOT NULL → concepts.id
├─ chat_jid        TEXT NOT NULL → chats.jid
├─ source_task_id  TEXT          → scheduled_tasks.id (nullable for manual deliveries)
├─ surface         TEXT          ('text' | 'voice' | 'text+voice')  -- enforced in code, not DB
└─ delivered_at    TEXT NOT NULL ISO 8601 UTC

INDEX idx_delivered_at        ON (delivered_at)
INDEX idx_delivered_concept   ON (concept_id, delivered_at)
INDEX idx_delivered_chat      ON (chat_jid, delivered_at)
```

Field rationale:

- **`concept_id`** (not `vault_note_path`): joins cleanly with `concepts`, `learning_activities`, `activity_log`. Stable across vault file renames. The MCP tool accepts either path or id and resolves to id internally.
- **`chat_jid`**: per-chat dedup. There is one chat today (`telegram_main`); designing global-only would force a migration once Slack/Discord/Telegram-swarm exist.
- **`source_task_id`** nullable: lets ad-hoc manual deliveries log truthfully without inventing a fake task id.
- **`surface`**: cheap analytics axis. Was a particular delivery text-only or text+voice? Validated in code (Zod on the MCP tool, TypeScript union in the helper); no DB CHECK constraint — keeping the schema portable for future surfaces.

**No uniqueness constraint** on `(concept_id, chat_jid)`. Runtime correctness comes from `getRecentDeliveredConcepts` using `desc(delivered_at)`. Duplicate-insert safety for the backfill script is handled in code (§4).

Per `CLAUDE.md`, the schema change goes through `npx drizzle-kit generate` after editing `src/db/schema*.ts`. The table is purely additive — no drift risk.

### 2. Outbound message logging

The `messages` schema already supports this. Reuse as-is. Each bot utterance writes:

| column | value |
|---|---|
| `id` | `crypto.randomUUID()` |
| `chat_jid` | destination jid |
| `sender` | `'bot'` literal |
| `sender_name` | the actual sender (e.g. `ASSISTANT_NAME`, or a pool sub-bot's `sender` for swarm sub-agents) |
| `content` | post-`stripInternalTags` text — the user-visible body |
| `timestamp` | now, UTC ISO |
| `is_from_me` | 0 |
| `is_bot_message` | 1 |

No schema migration needed.

**Bot-inclusive reader.** The existing `getMessagesSince` and `getNewMessages` filter `WHERE is_bot_message = 0` (`src/db/index.ts:276, 316`). They cannot be repurposed without breaking every existing caller. Add a sibling function `getMessagesSinceIncludingBot(chatJid, since, limit?)` returning the union. This is the function future agent prompts (or a follow-up `context_mode='group'` decision) will read from.

### 3. Integration points

Three localized hooks. Each is small and well-bounded.

#### 3a. Outbound message log — `src/router.ts:routeOutbound`

`router.ts:routeOutbound(channels, jid, text)` is the function that wraps `channel.sendMessage` for the main message-loop path. Today only some sites use it; others call `channel.sendMessage` directly (lines 387, 794, 846/848/856/858 in `src/index.ts`, plus the IPC sendMessage callbacks at 964-978). The spec does **not** require migrating every existing direct call — but it does require that the hook itself sits at the router layer and that we convert the agent egress paths (which are the ones that actually generate bot speech worth logging) to use it.

Change `routeOutbound` to take an optional `senderName`:

```
export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  senderName?: string,
): Promise<void> {
  const cleaned = formatOutbound(text)
  if (!cleaned) return Promise.resolve()
  logBotOutbound(jid, cleaned, senderName)       // new
  const channel = channels.find(...)
  return channel.sendMessage(jid, cleaned)
}
```

Then redirect the two existing IPC-side callbacks in `src/index.ts:964-978` to call `routeOutbound(channels, jid, rawText, senderName?)` instead of `channel.sendMessage` directly. The pool-bot path in `src/ipc.ts:124-133` (which calls `sendPoolMessage(chatJid, text, data.sender, sourceGroup)`) gets a parallel `logBotOutbound` call inside `sendPoolMessage` (or, equivalently, in `processIpcFiles` before dispatching to the pool) — passing `data.sender` as `senderName` so swarm sub-bots log truthfully.

**Out of scope for v1:** rewriting lines 387 / 794 / 846-858 to use `routeOutbound`. Those paths are non-agent (streaming partial output that doesn't go through the IPC verb, ingestion notifications, remote-control responses). Tracked as a follow-up.

`logBotOutbound` itself:

```
function logBotOutbound(chatJid, text, senderName?):
  trimmed = text.trim()
  if !trimmed: return
  try storeMessage({ ..., sender: 'bot',
                     sender_name: senderName ?? ASSISTANT_NAME,
                     is_bot_message: true })
  catch err: log warning, do NOT rethrow
```

`storeMessage` failure must not block the send. The log is observability, not load-bearing.

#### 3b. Prompt injection — `src/task-scheduler.ts` around line 178

Before calling `runContainerAgent`, query the last 14 days of deliveries for the task's `chat_jid` and prepend a list to the prompt:

```
const recent = getRecentDeliveredConcepts(task.chat_jid, 14)
const prompt = recent.length > 0
  ? `${task.prompt}\n\n## Recently delivered concepts (last 14 days — pick something different)\n${formatRecentList(recent)}`
  : task.prompt
```

Human-readable list format: `- 2026-05-16: Shadow AI Economy (concepts/shadow-ai-economy.md)`. A 14-day list at current cadence is ~14 lines, ~200 tokens. Injection is unconditional for every cron run; tasks that don't deliver concepts ignore the list.

**Enforcement strength.** Prompt injection is soft — the agent can still pick a listed concept if it ignores the instruction. We accept this for v1 because (a) it's the simplest mechanism that matches how the agent already takes guidance from its prompt, (b) the duplicate-recovery cost is low (Simon notices, complains, we revisit), and (c) hard enforcement would require the agent to *commit* a candidate concept via the MCP tool *before* generation, which is a much larger redesign of the morning-task flow.

#### 3c. New MCP tool — `container/agent-runner/src/ipc-mcp-stdio.ts`

Add `record_concept_delivery` alongside the existing `synthesize_speech` and `send_voice` tools.

Tool signature:

- Name: `record_concept_delivery`
- Args: `{ concept: string, surface?: 'text' | 'voice' | 'text+voice' }`
- Returns to agent: a text block with the resolved title on success; an `isError: true` block with the host's error message on failure

Calls `writeIpcRequestAwaitResponse` (§0) with verb `record_concept_delivery` and a 10-second timeout. Reads the response. Translates `{ok: true, conceptId, title}` into a success content block; `{ok: false, error}` into an `isError: true` block.

Host side (`src/ipc.ts`): new `case 'record_concept_delivery'` in `processTaskIpc`. Resolves the `concept` argument to a `concept_id` (path lookup against `concepts.vault_note_path`, or UUID identity). Returns `{ok: false, error: 'Concept not found: ...'}` if neither resolves. Inserts a row into `delivered_concepts`. Writes the response via `writeIpcResponse` (§0).

Allowed-tool patterns at `container/agent-runner/src/index.ts:414` already cover `mcp__nanoclaw__*`, so no allowlist change is needed.

#### 3d. Prompt update for `study-daily-morning`

The current prompt lives in **code** at `src/study/scheduled.ts:11` as the exported constant `MORNING_STUDY_PROMPT`, and is applied to the DB row by `registerStudyScheduledTasks`. A SQL update alone is insufficient — the next time a fresh install registers the task, the old prompt comes back.

The fix:

1. Edit `MORNING_STUDY_PROMPT` in `src/study/scheduled.ts` to append the instruction. New text:

   > *Before calling `mcp__nanoclaw__send_voice`, call `mcp__nanoclaw__record_concept_delivery` with the vault path of the concept you have chosen (e.g. `concepts/shadow-ai-economy.md`) and the surface argument set to `'text+voice'`. Record-then-send is intentional: recording first means the ledger stays accurate even if a send transiently fails, so tomorrow's run still avoids today's concept.*

2. A small SQL shim `scripts/update-daily-morning-prompt.sql` patches the existing live row for installs that already have a `study-daily-morning` entry. Idempotent (uses `prompt NOT LIKE '%record_concept_delivery%'`).

**Recording order.** Record-then-send. If the send fails, we have a defensible ledger that documents intent and prevents re-pick on the next run. If recording fails (DB issue), the agent gets an error and can decide whether to abort the send. This is the opposite of what §5 of the previous draft suggested — corrected.

### 4. Backfill

A dev-time one-shot script `scripts/backfill-delivered-concepts.ts` parses `task_run_logs.result` for `concepts/[a-z0-9-]+\.md` matches and inserts matching rows into `delivered_concepts`. Best-effort — only what the regex catches.

**Idempotency:** before inserting, check whether a row already exists for `(concept_id, chat_jid, calendar_date(delivered_at))` and skip if so. The script can be safely re-run.

Primary purpose: tomorrow's cron sees today's "Shadow AI Economy" delivery and avoids it. Not part of the migration system.

### 5. Error handling

| Scenario | Behavior |
|---|---|
| `record_concept_delivery` called with unknown path/id | Host returns `{ok: false, error: 'concept not found'}`. MCP tool surfaces this as `isError: true` to the agent. Agent retries with a corrected identifier or aborts the run. Do NOT silently insert into `concepts`. |
| IPC response timeout (>10s) | Container's `writeIpcRequestAwaitResponse` throws `IpcTimeoutError`. MCP tool returns an `isError` block. The agent may proceed without the ledger entry — defensible since the failure mode is "no row written" not "wrong row written". |
| Outbound `storeMessage` fails (disk, lock) | Log warning, continue with `channel.sendMessage`. Message must still reach the user. |
| Empty text after `stripInternalTags` | `routeOutbound` short-circuits: no log, no send. |
| Agent forgets to call `record_concept_delivery` | Silent gap accepted for v1. Optional future safety net: cross-check `messages.is_bot_message=1` rows mentioning `concepts/*.md` against ledger entries and warn. |
| Agent calls `record_concept_delivery` twice for the same concept (within a single run) | Both rows insert. No DB-level uniqueness constraint. Dedup query uses most-recent. Harmless. |
| Record succeeds, send fails | Ledger row stays. Documents intent. Mr. Rogers won't immediately re-pick it. Correct. |
| Telegram splits a long message into chunks | Channel handles splitting internally. One logical message → one row. |
| Pool-bot sub-bot send (telegram swarm) | `data.sender` from IPC propagates as `senderName` to `logBotOutbound`. Sub-bot identity preserved. |
| Concurrent cron + manual chat | UUID PKs, no collision. |
| Multi-channel future (Slack delivery of a Telegram-delivered concept) | `chat_jid` axis treats them as independent dedup contexts. Correct. |

### 6. Testing

Vitest is the framework. Tests live next to the code.

| File | Covers |
|---|---|
| `src/db/delivered-concepts.test.ts` (new) | `getRecentDeliveredConcepts(chat_jid, days)` and `recordConceptDelivery(...)`. Window boundary (just inside, just outside), per-chat isolation, path↔id resolution, unknown-concept rejection, idempotence for duplicate inserts. Queries use direct Drizzle selects on `schema.deliveredConcepts` (NOT `getMessagesSince`, which filters bot messages). |
| `src/db/messages-bot.test.ts` (new) | `getMessagesSinceIncludingBot` returns union of human + bot rows; the existing `getMessagesSince` is unchanged. |
| `src/task-scheduler.test.ts` (extend existing) | Prompt injection. Empty ledger ⇒ original prompt unchanged. Non-empty ledger ⇒ list section appended in expected format. Mock the db helper. |
| `src/outbound-logging.test.ts` (new) | `logBotOutbound(jid, text, senderName?)`. Empty / whitespace-only text ⇒ no row. Non-empty ⇒ row with correct fields. `senderName` parameter is honored. `storeMessage` mocked to throw ⇒ no rethrow, warning logged. Reads use direct Drizzle selects. |
| `src/router.test.ts` (new) | `routeOutbound` calls `logBotOutbound` and `channel.sendMessage` in that order; empty text short-circuits both. |
| `container/agent-runner/src/ipc-mcp-stdio.test.ts` (new file — extends pattern from `vault-mcp-stdio.test.ts` which already exists in this directory) | New `record_concept_delivery` tool. Mocks `writeIpcRequestAwaitResponse`. Path arg, UUID arg, success path, error path (host returns `ok:false`), timeout path. |
| `container/agent-runner/src/ipc-helpers.test.ts` (new) | `writeIpcRequestAwaitResponse`. Happy path (response file appears within timeout), timeout path (no file appears), cleanup (response file is unlinked after read). |

Not tested:

- The Drizzle migration itself. `runMigrations` runs on every startup; a failing migration is a loud signal.
- End-to-end "agent calls tool → row appears." Would require spinning a real container. The two halves are unit-tested independently and the IPC contract is small.
- The backfill script. One-shot dev tool. Code review + a manual run against a copy of `messages.db` is sufficient.

TDD posture: write tests before implementation for the seven files above.

## Open questions

None at design time. All design decisions made via brainstorming on 2026-05-23 plus revisions on 2026-05-24 after a subagent code review caught structural issues with the original IPC and hook-layer choices.
