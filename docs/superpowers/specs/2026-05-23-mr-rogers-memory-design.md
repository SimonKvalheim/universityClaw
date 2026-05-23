# Mr. Rogers Memory: Concept-Delivery Ledger and Outbound Message Log

**Date:** 2026-05-23
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
- Past bot utterances are queryable from the database (closes the broader observability hole).
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
2. **Outbound message logging** into the existing `messages` table with `is_bot_message=1`. Hooks the agent's IPC `sendMessage` egress.

The two are deliberately decoupled. The ledger is structured and is the dedup primitive. The outbound log is a faithful chat transcript and serves general observability.

### Repeat policy

Soft recency dedup: do not repeat any concept delivered in the last **14 days**. After 14 days a concept is eligible again. This matches Simon's spaced-repetition vision — concepts cool, then circle back with new framing.

The window is currently fixed at 14 days. If real usage suggests a different value, a single named constant changes.

### 1. `delivered_concepts` table

```
delivered_concepts
├─ id              TEXT PK (UUID)
├─ concept_id      TEXT NOT NULL → concepts.id
├─ chat_jid        TEXT NOT NULL → chats.jid
├─ source_task_id  TEXT          → scheduled_tasks.id (nullable for manual deliveries)
├─ surface         TEXT          ('text' | 'voice' | 'text+voice')
└─ delivered_at    TEXT NOT NULL ISO 8601 UTC

INDEX idx_delivered_at        ON (delivered_at)
INDEX idx_delivered_concept   ON (concept_id, delivered_at)
INDEX idx_delivered_chat      ON (chat_jid, delivered_at)
```

Field rationale:

- **`concept_id`** (not `vault_note_path`): joins cleanly with `concepts`, `learning_activities`, `activity_log`. Stable across vault file renames. The MCP tool accepts either path or id and resolves to id internally.
- **`chat_jid`**: per-chat dedup. There is one chat today (`telegram_main`); designing global-only would force a migration once Slack/Discord/Telegram-swarm exist.
- **`source_task_id`** nullable: lets ad-hoc manual deliveries log truthfully without inventing a fake task id.
- **`surface`**: cheap analytics axis. Was a particular delivery text-only or text+voice?

Per `CLAUDE.md`, the schema change goes through `npx drizzle-kit generate` after editing `src/db/schema*.ts`. The table is purely additive — no drift risk.

### 2. Outbound message logging

The `messages` schema already supports this. Reuse as-is. Each agent utterance writes:

| column | value |
|---|---|
| `id` | `crypto.randomUUID()` |
| `chat_jid` | destination jid |
| `sender` | `'bot'` literal |
| `sender_name` | `ASSISTANT_NAME` env var (e.g. "Mr. Rogers") |
| `content` | post-`stripInternalTags` text — the user-visible body |
| `timestamp` | now, UTC ISO |
| `is_from_me` | 0 |
| `is_bot_message` | 1 |

No migration needed.

### 3. Integration points

Three localized hooks. Each is small and well-bounded.

#### 3a. Outbound message log — `src/index.ts:964-978`

The IPC `sendMessage` handler currently does `stripInternalTags` then `channel.sendMessage`. Insert one DB write between those:

```
sendMessage handler:
  text = stripInternalTags(rawText)
  if text not empty:
    try storeMessage({ id: randomUUID(), chat_jid: jid, sender: 'bot',
                       sender_name: ASSISTANT_NAME, content: text,
                       timestamp: nowUtcIso(), is_from_me: 0,
                       is_bot_message: 1 })
    catch err: log and continue
    await channel.sendMessage(jid, text)
```

`storeMessage` failure must NOT block the send. The log is observability, not load-bearing. The store happens before the send so that a channel-send failure still leaves a record of what the agent attempted to deliver.

#### 3b. Prompt injection — `src/task-scheduler.ts` around line 150

Before calling `runContainerAgent`, query the last 14 days of deliveries for the task's `chat_jid` and prepend a list to the prompt:

```
const recent = getRecentDeliveredConcepts(task.chat_jid, 14)
const prompt = recent.length > 0
  ? `${task.prompt}\n\n## Recently delivered concepts (last 14 days — pick something different)\n${formatRecentList(recent)}`
  : task.prompt
```

The list format is human-readable: `- 2026-05-16: Shadow AI Economy (concepts/shadow-ai-economy.md)`. A 14-day list at the current cadence is ~14 lines, ~200 tokens. Injection is unconditional for every cron run; tasks that don't deliver concepts ignore the list.

#### 3c. New MCP tool — `container/agent-runner/src/ipc-mcp-stdio.ts`

Add `record_concept_delivery` alongside the existing `synthesize_speech` and `send_voice` tools.

Tool signature:

- Name: `record_concept_delivery`
- Args: `{ concept: string }` — accepts either a vault path (`concepts/foo.md`) or a concept UUID
- Returns: `{ ok: true, concept_id, title }` on success, `{ ok: false, error }` on unknown concept

Forwards to the host via the existing IPC mechanism. The host's IPC handler (`src/ipc.ts`) registers a new verb `record_concept_delivery` that:

1. Resolves the `concept` argument to a `concept_id` (path lookup against `concepts.vault_note_path`, or UUID identity).
2. Returns `{ok: false, error: 'concept not found'}` if neither resolves.
3. Inserts a row into `delivered_concepts`.
4. Returns confirmation with the resolved title.

Allowed-tool patterns at `container/agent-runner/src/index.ts:414` already cover `mcp__nanoclaw__*`, so no allowlist change is needed.

#### 3d. Prompt update for `study-daily-morning`

One-time DB row update appending an instruction to `scheduled_tasks.prompt`:

> *After sending the text and voice, call `mcp__nanoclaw__record_concept_delivery` with the vault path of the concept you delivered. This is how you remember what you've taught.*

This is data, not a schema migration. Applied via a small SQL update committed alongside the code.

### 4. Backfill

A dev-time one-shot script `scripts/backfill-delivered-concepts.ts` parses `task_run_logs.result` for `concepts/[a-z0-9-]+\.md` matches and inserts matching rows into `delivered_concepts`. Best-effort — only what the regex catches.

Primary purpose: tomorrow's cron sees today's "Shadow AI Economy" delivery and avoids it. Not part of the migration system. Run once, then irrelevant.

### 5. Error handling

| Scenario | Behavior |
|---|---|
| `record_concept_delivery` called with unknown path/id | Returns `{ok: false, error: 'concept not found'}`. Agent retries with a correct identifier. Do NOT silently insert into `concepts` — that's the ingestion pipeline's job. |
| Outbound `storeMessage` fails (disk, lock) | Log error, continue with `channel.sendMessage`. Message must still reach the user. |
| Empty text after `stripInternalTags` | Skip both store and send (the existing send guard already covers this; extend to the store). |
| Agent forgets to call `record_concept_delivery` | Silent gap accepted for v1. Optional future safety net: cross-check `messages.is_bot_message=1` rows mentioning `concepts/*.md` against ledger entries and warn. |
| Agent calls `record_concept_delivery` twice for the same concept | Both rows insert. No uniqueness constraint. Dedup query uses MAX/most-recent. Harmless. |
| Record called but send later fails | Ledger row stays. Documents intent. Mr. Rogers won't immediately re-pick it, which is the correct outcome. |
| Telegram splits a long message into chunks | Channel handles splitting internally. One logical message → one row. |
| Pool-bot sub-bot sends (telegram swarm) | All logged as `sender_name = ASSISTANT_NAME`. Per-bot distinction is a future refinement. |
| Concurrent cron + manual chat | UUID PKs, no collision. |
| Multi-channel future (Slack delivery of a Telegram-delivered concept) | `chat_jid` axis treats them as independent dedup contexts. Correct. |

### 6. Testing

Vitest is the framework. Tests live next to the code.

| File | Covers |
|---|---|
| `src/db/delivered-concepts.test.ts` (new) | `getRecentDeliveredConcepts(chat_jid, days)` and `recordConceptDelivery(...)`. Window boundary (just inside, just outside), per-chat isolation, path↔id resolution, unknown-concept rejection, idempotence for duplicate inserts. |
| `src/task-scheduler.test.ts` (extend existing) | Prompt injection. Empty ledger ⇒ original prompt unchanged. Non-empty ledger ⇒ list section appended in expected format. Mock the db helper. |
| `src/outbound-logging.test.ts` (new) | IPC `sendMessage` handler outbound logging. Empty post-strip text ⇒ no store and no send. Non-empty ⇒ store before send. `storeMessage` throws ⇒ send still happens, error logged. The handler is currently inline in `src/index.ts`; extracting it to a small helper that both `index.ts` and the test can import is part of the implementation. |
| `container/agent-runner/src/ipc-mcp-stdio.test.ts` (extend) | New `record_concept_delivery` tool. Accepts vault path, accepts UUID, rejects empty, rejects malformed. Mocks the IPC channel. Pattern follows the existing `synthesize_speech` tests in this file. |

Not tested:

- The Drizzle migration itself. `runMigrations` runs on every startup; a failing migration is a loud signal.
- End-to-end "agent calls tool → row appears." Would require spinning a real container. The two halves are unit-tested independently and the IPC contract between them is small.
- The backfill script. One-shot dev tool. Code review + a manual run against a copy of `messages.db` is sufficient.

TDD posture: write tests before implementation for the four files above.

## Open questions

None at design time. All design decisions made via brainstorming questions on 2026-05-23.
