# Mr. Rogers Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revised 2026-05-24** after a fresh-eyes code review caught structural issues in the original plan (no IPC return channel; hook layer too narrow; broken test signatures).

**Goal:** Stop the cron agent from repeating concepts within 14 days, log every agent utterance into the `messages` table so future tasks can read chat history, and add the small IPC request/response primitive needed for the new MCP tool to return errors to the agent.

**Architecture:** A new typed `delivered_concepts` ledger plus a new `mcp__nanoclaw__record_concept_delivery` MCP tool that uses a new container↔host request/response IPC primitive. The scheduler injects the last-14-day list into the cron prompt. Outbound logging hooks into `src/router.ts:routeOutbound` (single chokepoint) and threads `senderName` so swarm sub-bots log truthfully. A new `getMessagesSinceIncludingBot` reader unblocks future agents from actually consuming the new bot rows.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM, better-sqlite3, MCP SDK (`@modelcontextprotocol/sdk`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-23-mr-rogers-memory-design.md` (revised same day).

---

## File Structure

**New files:**
- `src/db/schema/delivered-concepts.ts` — Drizzle schema for the new table
- `src/db/delivered-concepts.ts` — `recordConceptDelivery`, `getRecentDeliveredConcepts` helpers
- `src/db/delivered-concepts.test.ts` — unit tests
- `src/db/messages-bot.ts` — `getMessagesSinceIncludingBot` reader
- `src/db/messages-bot.test.ts` — unit tests
- `src/outbound-logging.ts` — `logBotOutbound(jid, text, senderName?)`
- `src/outbound-logging.test.ts` — unit tests
- `src/router.test.ts` — tests for the new `routeOutbound` behavior
- `container/agent-runner/src/ipc-helpers.ts` — `writeIpcRequestAwaitResponse(dir, data, opts?)`
- `container/agent-runner/src/ipc-helpers.test.ts` — unit tests
- `container/agent-runner/src/ipc-mcp-stdio.test.ts` — tests for the new MCP tool (file does not exist yet)
- `drizzle/migrations/0005_<auto>.sql` — auto-generated
- `scripts/backfill-delivered-concepts.ts` — idempotent one-shot backfill
- `scripts/update-daily-morning-prompt.sql` — shim for existing live `study-daily-morning` row

**Modified files:**
- `src/db/schema/index.ts` — re-export the new schema
- `src/ipc.ts` — new `case 'record_concept_delivery'` verb; small `writeIpcResponse` helper used by the new verb
- `src/router.ts` — `routeOutbound(channels, jid, text, senderName?)` calls `logBotOutbound` and `formatOutbound` inline
- `src/task-scheduler.ts` — inject recent-deliveries list before `runContainerAgent`
- `src/task-scheduler.test.ts` — tests for the injection helper
- `src/index.ts` — both IPC sendMessage callbacks (lines 964 and 975) redirect through `routeOutbound`
- `src/study/scheduled.ts` — append the `record_concept_delivery` instruction to `MORNING_STUDY_PROMPT`
- `container/agent-runner/src/ipc-mcp-stdio.ts` — register `record_concept_delivery` using the new IPC helper

---

### Task 1: Add `delivered_concepts` schema and migration

**Files:**
- Create: `src/db/schema/delivered-concepts.ts`
- Modify: `src/db/schema/index.ts`
- Generated: `drizzle/migrations/0005_<auto>.sql`

- [ ] **Step 1: Write the schema**

Create `src/db/schema/delivered-concepts.ts`:

```typescript
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const deliveredConcepts = sqliteTable(
  'delivered_concepts',
  {
    id: text('id').primaryKey(),
    conceptId: text('concept_id').notNull(),
    chatJid: text('chat_jid').notNull(),
    sourceTaskId: text('source_task_id'),
    surface: text('surface'),
    deliveredAt: text('delivered_at').notNull(),
  },
  (t) => ({
    deliveredAtIdx: index('idx_delivered_at').on(t.deliveredAt),
    conceptIdx: index('idx_delivered_concept').on(t.conceptId, t.deliveredAt),
    chatIdx: index('idx_delivered_chat').on(t.chatJid, t.deliveredAt),
  }),
);
```

- [ ] **Step 2: Re-export from schema index**

Append to `src/db/schema/index.ts`:

```typescript
export * from './delivered-concepts.js';
```

- [ ] **Step 3: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new `drizzle/migrations/0005_<auto>.sql` containing `CREATE TABLE delivered_concepts ...` and the three indexes.

- [ ] **Step 4: Verify the migration applies on the live DB**

Run: `npm run dev` and watch startup for `Applied migration: 0005_<auto>`. Stop the app after confirming.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema/delivered-concepts.ts src/db/schema/index.ts drizzle/migrations/0005_*
git commit -m "db: add delivered_concepts ledger schema"
```

---

### Task 2: DB helpers — `recordConceptDelivery` and `getRecentDeliveredConcepts`

**Files:**
- Create: `src/db/delivered-concepts.ts`
- Test: `src/db/delivered-concepts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/db/delivered-concepts.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest';
import { _initTestDatabase, storeChatMetadata } from '../db.js';
import { db } from '../db/index.js';
import * as schema from '../db/schema/index.js';
import {
  getRecentDeliveredConcepts,
  recordConceptDelivery,
} from './delivered-concepts.js';

const CHAT = 'tg:test';
const OTHER_CHAT = 'tg:other';

function seedConcept(id: string, path: string, title: string) {
  db().insert(schema.concepts).values({
    id, title, vaultNotePath: path,
    createdAt: '2026-05-01T00:00:00.000Z',
  }).run();
}

beforeEach(() => {
  _initTestDatabase();
  storeChatMetadata({ jid: CHAT, name: 'Test', is_group: 1 });
  storeChatMetadata({ jid: OTHER_CHAT, name: 'Other', is_group: 1 });
});

describe('recordConceptDelivery', () => {
  it('inserts a row when concept exists by path', () => {
    seedConcept('c1', 'concepts/foo.md', 'Foo');
    const res = recordConceptDelivery({
      concept: 'concepts/foo.md',
      chatJid: CHAT,
      sourceTaskId: 'study-daily-morning',
      surface: 'text+voice',
    });
    expect(res).toEqual({ ok: true, conceptId: 'c1', title: 'Foo' });
  });

  it('accepts a UUID directly', () => {
    seedConcept('c2', 'concepts/bar.md', 'Bar');
    const res = recordConceptDelivery({ concept: 'c2', chatJid: CHAT });
    expect(res).toEqual({ ok: true, conceptId: 'c2', title: 'Bar' });
  });

  it('returns ok:false for an unknown concept', () => {
    const res = recordConceptDelivery({
      concept: 'concepts/does-not-exist.md',
      chatJid: CHAT,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not found/i);
  });

  it('allows duplicate deliveries of the same concept', () => {
    seedConcept('c3', 'concepts/dup.md', 'Dup');
    recordConceptDelivery({ concept: 'c3', chatJid: CHAT });
    const res2 = recordConceptDelivery({ concept: 'c3', chatJid: CHAT });
    expect(res2.ok).toBe(true);
  });
});

describe('getRecentDeliveredConcepts', () => {
  it('returns rows within the window, newest first', () => {
    seedConcept('c1', 'concepts/a.md', 'A');
    seedConcept('c2', 'concepts/b.md', 'B');
    const now = Date.now();
    const oneDay = 86_400_000;
    db().insert(schema.deliveredConcepts).values([
      { id: 'd1', conceptId: 'c1', chatJid: CHAT,
        deliveredAt: new Date(now - 1 * oneDay).toISOString() },
      { id: 'd2', conceptId: 'c2', chatJid: CHAT,
        deliveredAt: new Date(now - 7 * oneDay).toISOString() },
    ]).run();
    const rows = getRecentDeliveredConcepts(CHAT, 14);
    expect(rows.map((r) => r.conceptId)).toEqual(['c1', 'c2']);
    expect(rows[0]).toMatchObject({ title: 'A', vaultNotePath: 'concepts/a.md' });
  });

  it('excludes rows outside the window', () => {
    seedConcept('c1', 'concepts/old.md', 'Old');
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    db().insert(schema.deliveredConcepts).values({
      id: 'd1', conceptId: 'c1', chatJid: CHAT, deliveredAt: old,
    }).run();
    expect(getRecentDeliveredConcepts(CHAT, 14)).toEqual([]);
  });

  it('is scoped to chat_jid', () => {
    seedConcept('c1', 'concepts/x.md', 'X');
    db().insert(schema.deliveredConcepts).values({
      id: 'd1', conceptId: 'c1', chatJid: OTHER_CHAT,
      deliveredAt: new Date().toISOString(),
    }).run();
    expect(getRecentDeliveredConcepts(CHAT, 14)).toEqual([]);
    expect(getRecentDeliveredConcepts(OTHER_CHAT, 14)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db/delivered-concepts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `src/db/delivered-concepts.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from './index.js';
import * as schema from './schema/index.js';

type RecordArgs = {
  concept: string;
  chatJid: string;
  sourceTaskId?: string;
  surface?: 'text' | 'voice' | 'text+voice';
};

type RecordResult =
  | { ok: true; conceptId: string; title: string }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveConceptId(input: string): { id: string; title: string } | null {
  const isUuid = UUID_RE.test(input);
  const row = isUuid
    ? db().select({ id: schema.concepts.id, title: schema.concepts.title })
        .from(schema.concepts).where(eq(schema.concepts.id, input)).get()
    : db().select({ id: schema.concepts.id, title: schema.concepts.title })
        .from(schema.concepts).where(eq(schema.concepts.vaultNotePath, input)).get();
  return row ?? null;
}

export function recordConceptDelivery(args: RecordArgs): RecordResult {
  const resolved = resolveConceptId(args.concept);
  if (!resolved) return { ok: false, error: `Concept not found: ${args.concept}` };
  db().insert(schema.deliveredConcepts).values({
    id: randomUUID(),
    conceptId: resolved.id,
    chatJid: args.chatJid,
    sourceTaskId: args.sourceTaskId ?? null,
    surface: args.surface ?? null,
    deliveredAt: new Date().toISOString(),
  }).run();
  return { ok: true, conceptId: resolved.id, title: resolved.title };
}

export type RecentDelivery = {
  conceptId: string;
  title: string;
  vaultNotePath: string | null;
  deliveredAt: string;
};

export function getRecentDeliveredConcepts(
  chatJid: string,
  days: number,
): RecentDelivery[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return db()
    .select({
      conceptId: schema.deliveredConcepts.conceptId,
      title: schema.concepts.title,
      vaultNotePath: schema.concepts.vaultNotePath,
      deliveredAt: schema.deliveredConcepts.deliveredAt,
    })
    .from(schema.deliveredConcepts)
    .innerJoin(
      schema.concepts,
      eq(schema.concepts.id, schema.deliveredConcepts.conceptId),
    )
    .where(
      and(
        eq(schema.deliveredConcepts.chatJid, chatJid),
        gte(schema.deliveredConcepts.deliveredAt, cutoff),
      ),
    )
    .orderBy(desc(schema.deliveredConcepts.deliveredAt))
    .all();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/db/delivered-concepts.test.ts`
Expected: PASS — six tests green.

- [ ] **Step 5: Commit**

```bash
git add src/db/delivered-concepts.ts src/db/delivered-concepts.test.ts
git commit -m "db: helpers for recording and querying delivered concepts"
```

---

### Task 3: Bot-inclusive message reader

**Files:**
- Create: `src/db/messages-bot.ts`
- Test: `src/db/messages-bot.test.ts`

Without this, future agents running with `context_mode='group'` cannot read what the bot has said — the existing `getMessagesSince` / `getNewMessages` both `WHERE is_bot_message = 0` (`src/db/index.ts:276, 316`).

- [ ] **Step 1: Write the failing tests**

Create `src/db/messages-bot.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest';
import { _initTestDatabase, storeChatMetadata, storeMessage } from '../db.js';
import { getMessagesSinceIncludingBot } from './messages-bot.js';

const CHAT = 'tg:test';
const EPOCH = '1970-01-01T00:00:00.000Z';

beforeEach(() => {
  _initTestDatabase();
  storeChatMetadata({ jid: CHAT, name: 'Test', is_group: 1 });
});

describe('getMessagesSinceIncludingBot', () => {
  it('returns both human and bot rows', () => {
    storeMessage({
      id: 'm1', chat_jid: CHAT, sender: 'simon', sender_name: 'Simon',
      content: 'hello', timestamp: '2026-05-20T10:00:00.000Z',
      is_from_me: 0, is_bot_message: false,
    });
    storeMessage({
      id: 'm2', chat_jid: CHAT, sender: 'bot', sender_name: 'Mr. Rogers',
      content: 'hi simon', timestamp: '2026-05-20T10:01:00.000Z',
      is_from_me: 0, is_bot_message: true,
    });
    const rows = getMessagesSinceIncludingBot(CHAT, EPOCH);
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2']);
  });

  it('respects the since cutoff', () => {
    storeMessage({
      id: 'old', chat_jid: CHAT, sender: 'simon', sender_name: 'Simon',
      content: 'a', timestamp: '2026-05-01T00:00:00.000Z',
      is_from_me: 0, is_bot_message: false,
    });
    storeMessage({
      id: 'new', chat_jid: CHAT, sender: 'bot', sender_name: 'Mr. Rogers',
      content: 'b', timestamp: '2026-05-22T00:00:00.000Z',
      is_from_me: 0, is_bot_message: true,
    });
    const rows = getMessagesSinceIncludingBot(CHAT, '2026-05-10T00:00:00.000Z');
    expect(rows.map((r) => r.id)).toEqual(['new']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db/messages-bot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reader**

Create `src/db/messages-bot.ts`:

```typescript
import { and, asc, eq, gte } from 'drizzle-orm';
import { db } from './index.js';
import * as schema from './schema/index.js';

export function getMessagesSinceIncludingBot(
  chatJid: string,
  since: string,
  limit?: number,
) {
  const q = db()
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.chat_jid, chatJid),
        gte(schema.messages.timestamp, since),
      ),
    )
    .orderBy(asc(schema.messages.timestamp));
  return limit ? q.limit(limit).all() : q.all();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/db/messages-bot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/messages-bot.ts src/db/messages-bot.test.ts
git commit -m "db: bot-inclusive message reader for future group-context tasks"
```

---

### Task 4: IPC request/response primitive (container side)

**Files:**
- Create: `container/agent-runner/src/ipc-helpers.ts`
- Test: `container/agent-runner/src/ipc-helpers.test.ts`

The container needs to write a request file AND poll for a response file matching the request id. Today's `writeIpcFile` is fire-and-forget.

- [ ] **Step 1: Write the failing tests**

Create `container/agent-runner/src/ipc-helpers.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeIpcRequestAwaitResponse } from './ipc-helpers.js';

let base: string;
let tasksDir: string;
let responsesDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ipc-helpers-'));
  tasksDir = join(base, 'tasks');
  responsesDir = join(base, 'responses');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(responsesDir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('writeIpcRequestAwaitResponse', () => {
  it('returns the parsed response when the file appears', async () => {
    const responsePromise = writeIpcRequestAwaitResponse(
      tasksDir,
      { type: 'record_concept_delivery', concept: 'concepts/foo.md' },
      { responsesDir, timeoutMs: 2000, pollMs: 20 },
    );

    // Simulate the host writing a response after a short delay.
    setTimeout(() => {
      // The request file was just written with a requestId in it.
      // We don't know the id here, but we can read the most recent file in tasksDir
      // to discover it. In real use the host does this from the request payload.
      const fs = require('node:fs') as typeof import('node:fs');
      const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
      const data = JSON.parse(fs.readFileSync(join(tasksDir, files[0]), 'utf-8'));
      writeFileSync(
        join(responsesDir, `${data.requestId}.json`),
        JSON.stringify({ ok: true, conceptId: 'c1', title: 'Foo' }),
      );
    }, 30);

    const response = await responsePromise;
    expect(response).toEqual({ ok: true, conceptId: 'c1', title: 'Foo' });
  });

  it('throws IpcTimeoutError if no response appears within timeout', async () => {
    await expect(
      writeIpcRequestAwaitResponse(
        tasksDir,
        { type: 'anything' },
        { responsesDir, timeoutMs: 100, pollMs: 20 },
      ),
    ).rejects.toThrow(/timeout/i);
  });

  it('cleans up the response file after reading', async () => {
    const responsePromise = writeIpcRequestAwaitResponse(
      tasksDir,
      { type: 'x' },
      { responsesDir, timeoutMs: 2000, pollMs: 20 },
    );
    setTimeout(() => {
      const fs = require('node:fs') as typeof import('node:fs');
      const files = fs.readdirSync(tasksDir);
      const data = JSON.parse(fs.readFileSync(join(tasksDir, files[0]), 'utf-8'));
      writeFileSync(
        join(responsesDir, `${data.requestId}.json`),
        JSON.stringify({ ok: true }),
      );
    }, 30);
    await responsePromise;
    // Give the helper a tick to unlink.
    await new Promise((r) => setTimeout(r, 50));
    const fs = require('node:fs') as typeof import('node:fs');
    expect(fs.readdirSync(responsesDir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd container/agent-runner && npx vitest run src/ipc-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `container/agent-runner/src/ipc-helpers.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class IpcTimeoutError extends Error {
  constructor(verb: string, timeoutMs: number) {
    super(`IPC request timed out after ${timeoutMs}ms (verb=${verb})`);
    this.name = 'IpcTimeoutError';
  }
}

type Opts = {
  responsesDir: string;
  timeoutMs?: number;
  pollMs?: number;
};

export async function writeIpcRequestAwaitResponse<T = unknown>(
  requestsDir: string,
  data: Record<string, unknown> & { type: string },
  opts: Opts,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 50;
  const requestId = randomUUID();
  fs.mkdirSync(requestsDir, { recursive: true });
  const filename = `${Date.now()}-${requestId.slice(0, 8)}.json`;
  const filepath = path.join(requestsDir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ ...data, requestId }, null, 2));
  fs.renameSync(tempPath, filepath);

  const responsePath = path.join(opts.responsesDir, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      const body = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as T;
      try { fs.unlinkSync(responsePath); } catch { /* ignore */ }
      return body;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new IpcTimeoutError(data.type, timeoutMs);
}
```

- [ ] **Step 4: Run tests**

Run: `cd container/agent-runner && npx vitest run src/ipc-helpers.test.ts`
Expected: PASS — three tests green.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/ipc-helpers.ts container/agent-runner/src/ipc-helpers.test.ts
git commit -m "container: ipc request/response primitive with response polling"
```

---

### Task 5: Host IPC verb writes a response

**Files:**
- Modify: `src/ipc.ts`

The host needs to (a) handle `record_concept_delivery`, (b) write the result to `<ipcBaseDir>/<sourceGroup>/responses/<requestId>.json`. The audio verb at line 790 already shows the pattern.

- [ ] **Step 1: Add a `writeIpcResponse` helper**

Near the top of `src/ipc.ts` (with the other helpers), add:

```typescript
function writeIpcResponse(
  ipcBaseDir: string,
  sourceGroup: string,
  requestId: string,
  body: unknown,
): void {
  const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const target = path.join(responsesDir, `${requestId}.json`);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(body));
  fs.renameSync(temp, target);
}
```

(Refactoring existing audio/study response writes to use this helper is out of scope for this task — leave them as-is.)

- [ ] **Step 2: Import the db helper**

Add at the top of `src/ipc.ts`:

```typescript
import { recordConceptDelivery } from './db/delivered-concepts.js';
```

- [ ] **Step 3: Add the new case**

In `processTaskIpc`, alongside the other agent-callable verbs (around `case 'schedule_task':` line 347), add:

```typescript
case 'record_concept_delivery': {
  const { concept, chatJid, sourceTaskId, surface, requestId } =
    data as unknown as {
      concept: string;
      chatJid: string;
      sourceTaskId?: string;
      surface?: 'text' | 'voice' | 'text+voice';
      requestId?: string;
    };
  const result = recordConceptDelivery({
    concept, chatJid, sourceTaskId, surface,
  });
  if (requestId) {
    writeIpcResponse(ipcBaseDir, sourceGroup, requestId, result);
  }
  break;
}
```

`ipcBaseDir` and `sourceGroup` are already in scope in `processTaskIpc` — confirm via the existing audio case at line 790 if unsure.

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: builds clean. If `data` typing complains, cast or add the new fields to the `data` parameter type in `processTaskIpc`.

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts
git commit -m "ipc: record_concept_delivery verb with response writeback"
```

---

### Task 6: MCP tool — `record_concept_delivery`

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`
- Create: `container/agent-runner/src/ipc-mcp-stdio.test.ts`

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/ipc-mcp-stdio.test.ts`. Use the pattern from the existing `vault-mcp-stdio.test.ts` in the same directory:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { recordConceptDeliveryHandler } from './ipc-mcp-stdio.js';

describe('record_concept_delivery tool', () => {
  it('returns success block on host ok:true', async () => {
    const sendIpc = vi.fn().mockResolvedValue({
      ok: true, conceptId: 'c1', title: 'Foo',
    });
    const result = await recordConceptDeliveryHandler(
      { concept: 'concepts/foo.md', surface: 'text+voice' },
      { sendIpc, chatJid: 'tg:1', sourceTaskId: 'study-daily-morning' },
    );
    expect(sendIpc).toHaveBeenCalledWith({
      type: 'record_concept_delivery',
      concept: 'concepts/foo.md',
      chatJid: 'tg:1',
      sourceTaskId: 'study-daily-morning',
      surface: 'text+voice',
    });
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as any).text).toMatch(/Recorded delivery of Foo/);
  });

  it('returns isError block on host ok:false', async () => {
    const sendIpc = vi.fn().mockResolvedValue({
      ok: false, error: 'Concept not found: x',
    });
    const result = await recordConceptDeliveryHandler(
      { concept: 'x' },
      { sendIpc, chatJid: 'tg:1' },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toMatch(/Concept not found/);
  });

  it('returns isError block on IPC timeout', async () => {
    const sendIpc = vi.fn().mockRejectedValue(new Error('IPC timeout'));
    const result = await recordConceptDeliveryHandler(
      { concept: 'concepts/foo.md' },
      { sendIpc, chatJid: 'tg:1' },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toMatch(/timeout/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container/agent-runner && npx vitest run src/ipc-mcp-stdio.test.ts`
Expected: FAIL — `recordConceptDeliveryHandler` not exported.

- [ ] **Step 3: Add the exported handler**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, add a top-level exported handler near the other tool registrations:

```typescript
type RecordCtx = {
  sendIpc: (req: object) => Promise<any>;
  chatJid: string;
  sourceTaskId?: string;
};

export async function recordConceptDeliveryHandler(
  args: { concept: string; surface?: 'text' | 'voice' | 'text+voice' },
  ctx: RecordCtx,
) {
  try {
    const response = await ctx.sendIpc({
      type: 'record_concept_delivery',
      concept: args.concept,
      chatJid: ctx.chatJid,
      sourceTaskId: ctx.sourceTaskId,
      surface: args.surface,
    });
    if (!response?.ok) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: response?.error ?? 'Unknown error' }],
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text: `Recorded delivery of ${response.title} (id=${response.conceptId}).`,
      }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: `IPC error: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }
}
```

- [ ] **Step 4: Register the tool, using the new IPC helper**

Below the existing `send_voice` tool registration (around line 487+), add:

```typescript
import { writeIpcRequestAwaitResponse } from './ipc-helpers.js';

const IPC_BASE = path.dirname(TASKS_DIR);             // = data/ipc/<group>
const RESPONSES_DIR = path.join(IPC_BASE, 'responses');
const SOURCE_TASK_ID = process.env.NANOCLAW_SOURCE_TASK_ID;

server.tool(
  'record_concept_delivery',
  "Record that you have just chosen a vault concept to deliver to the user. " +
    "Call this BEFORE the send_voice call so the ledger stays accurate even " +
    "if the send transiently fails. Accepts either the vault path " +
    "(e.g. 'concepts/shadow-ai-economy.md') or the concept UUID.",
  {
    concept: z.string().describe('vault_note_path or concept UUID'),
    surface: z
      .enum(['text', 'voice', 'text+voice'])
      .optional()
      .describe("What you are about to deliver. Default omitted."),
  },
  async (args) =>
    recordConceptDeliveryHandler(args, {
      sendIpc: (req) =>
        writeIpcRequestAwaitResponse(TASKS_DIR, req as any, {
          responsesDir: RESPONSES_DIR,
          timeoutMs: 10_000,
        }),
      chatJid,
      sourceTaskId: SOURCE_TASK_ID,
    }),
);
```

The `NANOCLAW_SOURCE_TASK_ID` env var needs to be set by the host when spawning the container for a scheduled task. The host already passes `NANOCLAW_CHAT_JID` and similar — find the spawn site in `src/container-runner.ts` and add the new env var alongside `task.id` from `runTask`. (This is a 2-line change to `container-runner.ts` plus a 1-line addition to `runTask` in `task-scheduler.ts` to pass the id through.)

- [ ] **Step 5: Run the MCP tool tests**

Run: `cd container/agent-runner && npx vitest run src/ipc-mcp-stdio.test.ts`
Expected: PASS — three tests green.

- [ ] **Step 6: Rebuild the container**

Run: `docker buildx prune -f && ./container/build.sh`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts container/agent-runner/src/ipc-mcp-stdio.test.ts src/container-runner.ts src/task-scheduler.ts
git commit -m "container: record_concept_delivery MCP tool via IPC roundtrip"
```

---

### Task 7: Prompt injection in the scheduler

**Files:**
- Modify: `src/task-scheduler.ts`
- Modify: `src/task-scheduler.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/task-scheduler.test.ts`:

```typescript
import { buildPromptWithRecentConcepts } from './task-scheduler.js';
import type { RecentDelivery } from './db/delivered-concepts.js';

describe('buildPromptWithRecentConcepts', () => {
  it('returns the original prompt when no deliveries exist', () => {
    expect(buildPromptWithRecentConcepts('original prompt', []))
      .toBe('original prompt');
  });

  it('appends a list section when deliveries exist', () => {
    const recent: RecentDelivery[] = [
      { conceptId: 'c1', title: 'Shadow AI Economy',
        vaultNotePath: 'concepts/shadow-ai-economy.md',
        deliveredAt: '2026-05-16T05:03:00.000Z' },
      { conceptId: 'c2', title: 'Cognitive Debt',
        vaultNotePath: 'concepts/cognitive-debt.md',
        deliveredAt: '2026-05-13T05:09:00.000Z' },
    ];
    const out = buildPromptWithRecentConcepts('original prompt', recent);
    expect(out).toContain('original prompt');
    expect(out).toMatch(/Recently delivered concepts \(last 14 days/);
    expect(out).toMatch(/2026-05-16: Shadow AI Economy \(concepts\/shadow-ai-economy\.md\)/);
    expect(out).toMatch(/2026-05-13: Cognitive Debt/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/task-scheduler.test.ts -t buildPromptWithRecentConcepts`
Expected: FAIL — `buildPromptWithRecentConcepts` not exported.

- [ ] **Step 3: Implement the helper and wire it**

In `src/task-scheduler.ts`, add near the top:

```typescript
import {
  getRecentDeliveredConcepts,
  type RecentDelivery,
} from './db/delivered-concepts.js';

export function buildPromptWithRecentConcepts(
  basePrompt: string,
  recent: RecentDelivery[],
): string {
  if (recent.length === 0) return basePrompt;
  const lines = recent.map((r) => {
    const date = r.deliveredAt.slice(0, 10);
    const path = r.vaultNotePath ?? '(no path)';
    return `- ${date}: ${r.title} (${path})`;
  });
  return (
    `${basePrompt}\n\n` +
    `## Recently delivered concepts (last 14 days — pick something different)\n` +
    lines.join('\n')
  );
}
```

Then inside `runTask`, just before the `runContainerAgent` call (around line 178), inject:

```typescript
const recent = getRecentDeliveredConcepts(task.chat_jid, 14);
const injectedPrompt = buildPromptWithRecentConcepts(task.prompt, recent);

const output = await runContainerAgent(
  group,
  {
    prompt: injectedPrompt,   // was: task.prompt
    // ...rest unchanged
  },
  // ...
);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/task-scheduler.test.ts`
Expected: PASS — including the new tests.

- [ ] **Step 5: Commit**

```bash
git add src/task-scheduler.ts src/task-scheduler.test.ts
git commit -m "scheduler: inject recently-delivered concepts into cron prompt"
```

---

### Task 8: Outbound logging helper

**Files:**
- Create: `src/outbound-logging.ts`
- Create: `src/outbound-logging.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/outbound-logging.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _initTestDatabase, storeChatMetadata } from './db.js';
import { db } from './db/index.js';
import * as schema from './db/schema/index.js';
import { eq } from 'drizzle-orm';

beforeEach(() => {
  _initTestDatabase();
  storeChatMetadata({ jid: 'tg:1', name: 'Test', is_group: 1 });
  vi.resetModules();
});

describe('logBotOutbound', () => {
  it('writes a bot row for non-empty text using ASSISTANT_NAME by default', async () => {
    process.env.ASSISTANT_NAME = 'Mr. Rogers';
    const { logBotOutbound } = await import('./outbound-logging.js');
    logBotOutbound('tg:1', 'Hello world');
    const rows = db().select().from(schema.messages)
      .where(eq(schema.messages.chat_jid, 'tg:1')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sender: 'bot', sender_name: 'Mr. Rogers',
      content: 'Hello world', is_bot_message: 1, is_from_me: 0,
    });
  });

  it('uses the senderName argument when provided (swarm sub-bot)', async () => {
    const { logBotOutbound } = await import('./outbound-logging.js');
    logBotOutbound('tg:1', 'sub-bot speaking', 'Researcher');
    const rows = db().select().from(schema.messages)
      .where(eq(schema.messages.chat_jid, 'tg:1')).all();
    expect(rows[0].sender_name).toBe('Researcher');
  });

  it('skips empty and whitespace-only text', async () => {
    const { logBotOutbound } = await import('./outbound-logging.js');
    logBotOutbound('tg:1', '');
    logBotOutbound('tg:1', '   ');
    const rows = db().select().from(schema.messages).all();
    expect(rows).toEqual([]);
  });

  it('swallows storeMessage errors without throwing', async () => {
    const dbModule = await import('./db.js');
    const spy = vi.spyOn(dbModule, 'storeMessage').mockImplementation(() => {
      throw new Error('forced failure');
    });
    const { logBotOutbound } = await import('./outbound-logging.js');
    expect(() => logBotOutbound('tg:1', 'x')).not.toThrow();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/outbound-logging.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/outbound-logging.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { storeMessage } from './db.js';
import { logger } from './logger.js';

export function logBotOutbound(
  chatJid: string,
  text: string,
  senderName?: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const name = senderName || process.env.ASSISTANT_NAME || 'Assistant';
  try {
    storeMessage({
      id: randomUUID(),
      chat_jid: chatJid,
      sender: 'bot',
      sender_name: name,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: 0,
      is_bot_message: true,
    });
  } catch (err) {
    logger.warn({ err, chatJid }, 'Failed to log outbound bot message');
  }
}
```

If `storeMessage`'s exact signature differs (look at `src/db/index.ts:189-217`), adjust the call to match — the four tests cover the contract regardless of the field-name minutiae.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/outbound-logging.test.ts`
Expected: PASS — four tests green.

- [ ] **Step 5: Commit**

```bash
git add src/outbound-logging.ts src/outbound-logging.test.ts
git commit -m "feat: outbound bot-message logging helper with senderName support"
```

---

### Task 9: `routeOutbound` hooks `logBotOutbound`; wire IPC callbacks through it

**Files:**
- Modify: `src/router.ts`
- Create: `src/router.test.ts`
- Modify: `src/index.ts`
- Modify: `src/ipc.ts` (pool-bot path)

The current `routeOutbound` skips the log. We move both the format step AND the log into it, then redirect the two IPC sendMessage callbacks in `src/index.ts` (lines 964-979) plus the pool-bot path in `src/ipc.ts:124-133` to use it.

- [ ] **Step 1: Write the failing tests for `routeOutbound`**

Create `src/router.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { routeOutbound } from './router.js';

function makeChannel(jid: string) {
  return {
    name: 'mock',
    ownsJid: (j: string) => j === jid,
    isConnected: () => true,
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('routeOutbound', () => {
  it('logs and sends for non-empty text', async () => {
    const ch = makeChannel('tg:1');
    const logSpy = vi.fn();
    await routeOutbound([ch], 'tg:1', 'hello', undefined, logSpy);
    expect(logSpy).toHaveBeenCalledWith('tg:1', 'hello', undefined);
    expect(ch.sendMessage).toHaveBeenCalledWith('tg:1', 'hello');
  });

  it('forwards senderName for swarm sub-bots', async () => {
    const ch = makeChannel('tg:1');
    const logSpy = vi.fn();
    await routeOutbound([ch], 'tg:1', 'sub message', 'Researcher', logSpy);
    expect(logSpy).toHaveBeenCalledWith('tg:1', 'sub message', 'Researcher');
  });

  it('strips <internal> tags before logging and sending', async () => {
    const ch = makeChannel('tg:1');
    const logSpy = vi.fn();
    await routeOutbound([ch], 'tg:1', '<internal>shh</internal>visible', undefined, logSpy);
    expect(logSpy).toHaveBeenCalledWith('tg:1', 'visible', undefined);
    expect(ch.sendMessage).toHaveBeenCalledWith('tg:1', 'visible');
  });

  it('short-circuits on empty text — no log, no send', async () => {
    const ch = makeChannel('tg:1');
    const logSpy = vi.fn();
    await routeOutbound([ch], 'tg:1', '<internal>only-internal</internal>', undefined, logSpy);
    expect(logSpy).not.toHaveBeenCalled();
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/router.test.ts`
Expected: FAIL — `routeOutbound` doesn't accept the new args / doesn't call any log.

- [ ] **Step 3: Update `routeOutbound`**

Edit `src/router.ts:routeOutbound`:

```typescript
import { logBotOutbound as defaultLogBotOutbound } from './outbound-logging.js';

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  senderName?: string,
  logFn: (jid: string, text: string, senderName?: string) => void = defaultLogBotOutbound,
): Promise<void> {
  const cleaned = formatOutbound(text);
  if (!cleaned) return Promise.resolve();
  logFn(jid, cleaned, senderName);
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, cleaned);
}
```

The injectable `logFn` parameter exists purely for testability — production callers omit it.

- [ ] **Step 4: Run router tests**

Run: `npx vitest run src/router.test.ts`
Expected: PASS — four tests green.

- [ ] **Step 5: Wire `src/index.ts` callbacks through `routeOutbound`**

Replace lines 964-979 with:

```typescript
sendMessage: async (jid, rawText) => {
  try {
    await routeOutbound(channels, jid, rawText);
  } catch (err) {
    logger.warn({ jid, err }, 'No channel owns JID, cannot send message');
  }
},
```

(For the scheduler callback at 964 — same lines apply to the IPC callback at 975. The catch handles the existing "No channel for JID" error case.)

For the IPC callback at line 975:

```typescript
sendMessage: (jid, text) => routeOutbound(channels, jid, text),
```

Add the import:

```typescript
import { routeOutbound } from './router.js';
```

If `routeOutbound` was already imported in `src/index.ts` (it may be — grep first), don't duplicate.

- [ ] **Step 6: Wire the pool-bot path in `src/ipc.ts`**

Find `sendPoolMessage` calls in `src/ipc.ts` (around line 124). Either:
- (a) make `sendPoolMessage` call `logBotOutbound(chatJid, text, sender)` internally before dispatching to the channel, OR
- (b) at each `sendPoolMessage` call site, call `logBotOutbound(chatJid, text, data.sender)` immediately before.

(a) is cleaner. Add at the top of the file:

```typescript
import { logBotOutbound } from './outbound-logging.js';
```

Then inside `sendPoolMessage` (find its definition), at the top:

```typescript
logBotOutbound(chatJid, text, sender);
```

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: all tests pass. Watch for any test that exercises `routeOutbound` and previously expected the un-logged behavior.

- [ ] **Step 8: Commit**

```bash
git add src/router.ts src/router.test.ts src/index.ts src/ipc.ts
git commit -m "feat: log every bot outbound through routeOutbound chokepoint"
```

---

### Task 10: Update `MORNING_STUDY_PROMPT` in code AND patch the live row

**Files:**
- Modify: `src/study/scheduled.ts`
- Create: `scripts/update-daily-morning-prompt.sql`

- [ ] **Step 1: Edit the code constant**

In `src/study/scheduled.ts:11`, append to the `MORNING_STUDY_PROMPT` template literal (just before the closing backtick):

```
Before calling \`mcp__nanoclaw__send_voice\`, call \`mcp__nanoclaw__record_concept_delivery\` with the vault path of the concept you have chosen (e.g. \`concepts/shadow-ai-economy.md\`) and the \`surface\` argument set to \`'text+voice'\`. Record-then-send is intentional: recording first means the ledger stays accurate even if a send transiently fails, so tomorrow's run still avoids today's concept.
```

(Format/escape backticks appropriately for the surrounding template literal context.)

- [ ] **Step 2: Write the SQL shim for existing installs**

Create `scripts/update-daily-morning-prompt.sql`:

```sql
-- One-shot shim for installs where study-daily-morning already exists.
-- Fresh installs pick up the new prompt from src/study/scheduled.ts directly.
-- Idempotent: only updates if the new instruction is not already present.
UPDATE scheduled_tasks
SET prompt = prompt || X'0A0A' || 'Before calling mcp__nanoclaw__send_voice, call mcp__nanoclaw__record_concept_delivery with the vault path of the concept you have chosen (e.g. concepts/shadow-ai-economy.md) and the surface argument set to ''text+voice''. Record-then-send is intentional: recording first means the ledger stays accurate even if a send transiently fails, so tomorrow''s run still avoids today''s concept.'
WHERE id = 'study-daily-morning'
  AND prompt NOT LIKE '%record_concept_delivery%';
```

- [ ] **Step 3: Apply the shim**

Run: `sqlite3 store/messages.db < scripts/update-daily-morning-prompt.sql`

- [ ] **Step 4: Verify**

Run: `sqlite3 store/messages.db "SELECT substr(prompt, -400) FROM scheduled_tasks WHERE id='study-daily-morning';"`
Expected: ends with the new instruction.

- [ ] **Step 5: Commit**

```bash
git add src/study/scheduled.ts scripts/update-daily-morning-prompt.sql
git commit -m "study: instruct agent to record concept delivery before sending"
```

---

### Task 11: Idempotent backfill

**Files:**
- Create: `scripts/backfill-delivered-concepts.ts`

- [ ] **Step 1: Write the script**

Create `scripts/backfill-delivered-concepts.ts`:

```typescript
#!/usr/bin/env tsx
import { eq, and } from 'drizzle-orm';
import { initDatabase, db } from '../src/db/index.js';
import * as schema from '../src/db/schema/index.js';
import { recordConceptDelivery } from '../src/db/delivered-concepts.js';

initDatabase();

const CONCEPT_PATH_RE = /concepts\/[a-z0-9-]+\.md/g;
const TELEGRAM_MAIN_JID = process.env.TELEGRAM_MAIN_JID;
if (!TELEGRAM_MAIN_JID) {
  console.error('Set TELEGRAM_MAIN_JID env var to the main chat jid.');
  process.exit(1);
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function alreadyHaveRow(conceptId: string, chatJid: string, day: string): boolean {
  const dayStart = `${day}T00:00:00.000Z`;
  const dayEnd = `${day}T23:59:59.999Z`;
  const existing = db()
    .select({ id: schema.deliveredConcepts.id })
    .from(schema.deliveredConcepts)
    .where(
      and(
        eq(schema.deliveredConcepts.conceptId, conceptId),
        eq(schema.deliveredConcepts.chatJid, chatJid),
      ),
    )
    .all()
    .find((r) => {
      const at = db().select({ at: schema.deliveredConcepts.deliveredAt })
        .from(schema.deliveredConcepts)
        .where(eq(schema.deliveredConcepts.id, r.id)).get();
      return at && at.at >= dayStart && at.at <= dayEnd;
    });
  return !!existing;
}

const runs = db().select().from(schema.taskRunLogs).all();
let attempted = 0, inserted = 0, skipped = 0;

for (const run of runs) {
  if (run.status !== 'success' || !run.result) continue;
  const matches = run.result.match(CONCEPT_PATH_RE);
  if (!matches) continue;
  for (const path of new Set(matches)) {
    attempted++;
    // Resolve concept first to get its id for the dedup check.
    const concept = db()
      .select({ id: schema.concepts.id })
      .from(schema.concepts)
      .where(eq(schema.concepts.vaultNotePath, path)).get();
    if (!concept) { skipped++; continue; }
    if (alreadyHaveRow(concept.id, TELEGRAM_MAIN_JID, dayKey(run.runAt))) {
      skipped++; continue;
    }
    const res = recordConceptDelivery({
      concept: path,
      chatJid: TELEGRAM_MAIN_JID,
      sourceTaskId: run.taskId,
      surface: 'text+voice',
    });
    if (res.ok) inserted++; else skipped++;
  }
}

console.log(`Backfill: attempted=${attempted} inserted=${inserted} skipped=${skipped}.`);
process.exit(0);
```

(Field names like `taskRunLogs`, `runAt` may differ — check `src/db/schema/tasks.ts` and adjust.)

- [ ] **Step 2: Back up the DB**

Run: `cp store/messages.db store/messages.db.pre-backfill.bak`

- [ ] **Step 3: Find the main chat JID**

Run: `sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE group_folder='telegram_main';"`

- [ ] **Step 4: Run the backfill**

Run: `TELEGRAM_MAIN_JID='<jid>' npx tsx scripts/backfill-delivered-concepts.ts`
Expected: a count like `inserted=2 skipped=0` matching the two historical successful concept deliveries.

- [ ] **Step 5: Re-run to confirm idempotence**

Run the same command again. Expected: `inserted=0 skipped=2`.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-delivered-concepts.ts
git commit -m "scripts: idempotent backfill of historical concept deliveries"
```

---

### Task 12: End-to-end verification

Manual — no new code.

- [ ] **Step 1: Restart the NanoClaw stack**

```bash
pkill -f "tsx src/index.ts" || true
npm run dev > /tmp/uniclaw-nanoclaw.log 2>&1 &
```

Expected: log shows `Applied migration: 0005_*`, scheduler loop starts, Telegram pool ready, no errors.

- [ ] **Step 2: Trigger a manual run**

```bash
sqlite3 store/messages.db \
  "UPDATE scheduled_tasks SET next_run = datetime('now') WHERE id='study-daily-morning';"
```

- [ ] **Step 3: Tail the log for IPC traffic**

```bash
tail -f /tmp/uniclaw-nanoclaw.log | \
  grep -E "Running scheduled task|record_concept_delivery|Recorded delivery"
```

Expected: a `record_concept_delivery` call before the voice synthesis.

- [ ] **Step 4: Inspect the injected prompt**

```bash
ls -t data/ipc/telegram_main/tasks/ | head -1 \
  | xargs -I {} cat data/ipc/telegram_main/tasks/{} | head -80
```

Expected: the task payload shows a `## Recently delivered concepts` section appended to the `MORNING_STUDY_PROMPT`. (This is the proof that injection is working — not just "the agent picked something different.")

- [ ] **Step 5: Verify a new ledger row**

```bash
sqlite3 store/messages.db \
  "SELECT delivered_at, concept_id, surface FROM delivered_concepts ORDER BY delivered_at DESC LIMIT 3;"
```

Expected: the most recent row is from this run.

- [ ] **Step 6: Verify outbound logging**

```bash
sqlite3 store/messages.db \
  "SELECT timestamp, sender_name, substr(content, 1, 60) FROM messages WHERE is_bot_message=1 ORDER BY timestamp DESC LIMIT 3;"
```

Expected: a row for the text message sent in this run, with `sender_name='Mr. Rogers'`.

- [ ] **Step 7: Trigger a second run and verify the injected list contains the previous delivery**

Repeat steps 2 and 4. Expected: the `Recently delivered concepts` section in the new prompt now includes the concept from step 5.

- [ ] **Step 8: Push the branch**

```bash
git push -u origin spec/mr-rogers-memory
```

---

## Self-Review

**Spec coverage check (against revised `docs/superpowers/specs/2026-05-23-mr-rogers-memory-design.md`):**

| Spec item | Plan task |
|---|---|
| §0 IPC request/response primitive (container helper) | Task 4 |
| §0 IPC response writeback (host) | Task 5 step 1 |
| §1 `delivered_concepts` table + 3 indexes | Task 1 |
| §2 Outbound logging into `messages` with `is_bot_message=1` | Task 8 |
| §2 Bot-inclusive reader (`getMessagesSinceIncludingBot`) | Task 3 |
| §3a `routeOutbound` is the chokepoint, threads `senderName` | Task 9 |
| §3a Pool-bot path logs swarm sender | Task 9 step 6 |
| §3a IPC sendMessage callbacks routed through `routeOutbound` | Task 9 step 5 |
| §3b 14-day prompt injection | Task 7 |
| §3c MCP tool using IPC roundtrip | Task 6 |
| §3c Host verb for `record_concept_delivery` | Task 5 |
| §3d `MORNING_STUDY_PROMPT` updated in code | Task 10 step 1 |
| §3d SQL shim for existing row | Task 10 step 2 |
| §3d Record-before-send order | prompt text in Task 10 |
| §4 Idempotent backfill | Task 11 |
| §5 `storeMessage` failure must not block send | Task 8 step 3 + 9 step 3 |
| §5 IPC timeout returns isError to agent | Task 6 step 3 |
| §5 Unknown concept returns ok:false | Task 2 + Task 6 |
| §6 All seven new test files | Tasks 2, 3, 4, 6, 7, 8, 9 |

**Placeholder scan:** No "TBD", "TODO", or "implement later". The "field names may differ — check schema/adjust" notes in Tasks 5 and 11 are precise pointers (the file is named), not placeholders.

**Type consistency:** `RecentDelivery` exported in Task 2, imported in Task 7. `RecordResult` shape from Task 2 flows through Task 5 (host verb) and Task 6 (MCP tool) unchanged. `logBotOutbound` signature `(jid, text, senderName?)` consistent across Tasks 8, 9, and the test imports.

**Task order:** Task 3 (bot-inclusive reader) is independent of everything else. Task 4 (container IPC helper) and Task 5 (host response writer) form the IPC pair; either could be implemented first since they communicate via the filesystem, but Task 5 references the host verb which uses Task 2's `recordConceptDelivery`, so Task 2 must precede Task 5. Task 6 (MCP tool) depends on Task 4. Task 9 (router wiring) depends on Task 8 (helper). Task 12 (end-to-end) depends on everything else.

No circular dependencies. Each task produces a clean commit.
