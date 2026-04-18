# Live Voice Chat (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a dashboard `/voice` page that hosts a real-time voice brainstorming session with a Gemini-powered Dev Assistant persona — with a live dollar tracker, captions, a preview pane for mockups and diagrams, durable transcripts, and strict read/write scoping.

**Architecture:** Browser opens a WebSocket to Gemini Live using a short-lived ephemeral token minted by the dashboard backend. A `VoiceSession` abstraction owns the WS lifecycle and fires UI events. Server-side API routes execute tool calls (read from scoped roots, write to `docs/superpowers/`), persist transcripts to disk, and write session/cost records to a new `voice_sessions` SQLite table. No Claude container is in the loop — Gemini IS the Dev Assistant.

**Tech Stack:** Next.js 16 (dashboard), React 19, `@google/genai`, `mermaid`, Drizzle ORM + `better-sqlite3`, Web Audio API (`AudioWorklet`), Vitest.

**Spec:** `docs/superpowers/specs/2026-04-18-live-voice-chat-design.md`.

---

## Prerequisites

Work in the `feat/live-voice-chat` worktree at `/Users/simonkvalheim/Documents/01 - Projects/universityClaw-voice`. Do NOT modify anything on the `feat/gemini-tts-stt-migration` branch (separate parallel work).

This plan assumes the parallel migration spec is either complete or running concurrently. `GEMINI_API_KEY` is the canonical env var name. If the migration hasn't yet renamed `google_api_key`, this plan adds a compatibility shim that reads both (preferring uppercase).

## Essential Reading (coordinator only — do NOT dump into subagent prompts)

If you're executing this plan yourself: read the full spec (`docs/superpowers/specs/2026-04-18-live-voice-chat-design.md`) and skim `src/db/schema/study.ts`, `src/db/migrate.ts`, `drizzle.config.ts`, `dashboard/src/lib/db/schema.ts`, `dashboard/src/app/api/chat/route.ts`, and `dashboard/src/lib/__tests__/analytics.test.ts` to internalize patterns.

If you're dispatching subagents: inline the specific snippets each task needs (see Subagent Dispatch Guidance at the bottom).

## Conventions (applies to all tasks)

These are **hard constraints**, not suggestions. If your change appears to violate one, stop and ask.

1. **Branch & worktree.** Work on `feat/live-voice-chat` in the `universityClaw-voice` worktree. Commit frequently. Never rebase published work. Never push to `main`.

2. **DB schema: two schema files must stay in sync.**
   - Canonical schema: `src/db/schema/*.ts` (consumed by `drizzle-kit generate`).
   - Dashboard mirror: `dashboard/src/lib/db/schema.ts` (consumed by dashboard Drizzle queries).
   - Both must describe the same SQL columns. The existing file `dashboard/src/lib/db/schema.ts` has a comment banner: "must match src/db/schema/*.ts SQL columns exactly" — preserve that invariant.

3. **camelCase ↔ snake_case.**
   - Request/response JSON keys in API routes: **camelCase** (`voiceSessionId`, not `voice_session_id`).
   - Drizzle schema TS properties: **camelCase** mapped to snake_case DB columns (e.g. `voiceSessionId: text('voice_session_id')`).
   - DB column names: **snake_case**.
   - When a tool handler writes to a table, translate at the boundary.

4. **Testing.**
   - Run `npm test` from repo root (not from `dashboard/`). Tests live in `src/**/*.test.ts` or `dashboard/src/**/*.test.ts` and both are picked up by the root `vitest.config.ts`.
   - Prefer one describe block per module; one `it` per behavior; short, named fixtures.
   - TDD: write the failing test first, run it, watch it fail, then implement.

5. **Path discipline.**
   - All file paths in code: use `path.join`, never string concatenation.
   - Repo root: resolve once via `process.cwd()` (from `npm test` this is repo root; from `next dev` this is `dashboard/`). Always derive: `const REPO_ROOT = path.resolve(process.cwd(), process.cwd().endsWith('/dashboard') ? '..' : '.');` OR use an env var `REPO_ROOT` set in `.env`. This plan uses the derivation approach — simpler.

6. **Imports.**
   - Use the project's existing module style (ESM with `.js` import extensions where the existing code does).
   - No default exports for shared utilities; named exports only.

7. **Env vars.** Read `process.env.X` only inside functions (NOT at module top level) so tests can set/unset without module-cache contamination. If caching is needed, cache inside the first call.

8. **Logging.** Use the existing `logger` from `src/logger.ts` for backend code. For voice-specific structured logs, write JSON lines to `data/voice.log` using a tiny helper built in Task 7.

9. **Secrets.** Never log `GEMINI_API_KEY` content. Never include it in error messages surfaced to the client.

10. **Commit messages.** Follow the repo's conventional-commit style: `feat(voice): …`, `test(voice): …`, `chore(voice): …`. Include the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer when committing.

11. **YAGNI / DRY.** No premature abstractions. Share utilities only after the second caller exists.

## File Structure (what gets created)

```
src/db/schema/voice.ts                                      NEW  canonical schema for voice_sessions
src/db/schema/index.ts                                      MOD  export voice.ts
src/voice/                                                  NEW  server-side voice helpers (non-dashboard)
  path-scope.ts                                             NEW  read/write scope + realpath guards
  voice-log.ts                                              NEW  JSON-line logger → data/voice.log
dashboard/src/lib/db/schema.ts                              MOD  mirror voice_sessions schema
dashboard/src/app/voice/page.tsx                            NEW  /voice page
dashboard/src/app/voice/voice-session.ts                    NEW  WS lifecycle + event stream
dashboard/src/app/voice/audio-io.ts                         NEW  mic capture + playback
dashboard/src/app/voice/audio-worklet-processor.ts          NEW  16 kHz resampler (AudioWorklet)
dashboard/src/app/voice/cost-tracker.ts                     NEW  token accumulator + $ conversion
dashboard/src/app/voice/rates.ts                            NEW  Gemini pricing config
dashboard/src/app/voice/personas.ts                         NEW  Dev Assistant persona config
dashboard/src/app/voice/captions.tsx                        NEW  scrolling transcript
dashboard/src/app/voice/preview-pane.tsx                    NEW  mockup iframe + mermaid tabs
dashboard/src/app/voice/cost-panel.tsx                      NEW  live $ ticker + rollups
dashboard/src/app/voice/__tests__/cost-tracker.test.ts      NEW
dashboard/src/app/voice/__tests__/voice-session.test.ts     NEW
dashboard/src/app/voice/__tests__/fake-gemini-server.ts     NEW  WS fixture
dashboard/src/app/api/voice/token/route.ts                  NEW
dashboard/src/app/api/voice/context/dev/route.ts            NEW
dashboard/src/app/api/voice/tools/dev/[tool]/route.ts       NEW  single dynamic handler, dispatches by tool name
dashboard/src/app/api/voice/session-close/route.ts          NEW
dashboard/src/app/api/voice/__tests__/token.test.ts         NEW
dashboard/src/app/api/voice/__tests__/context.test.ts       NEW
dashboard/src/app/api/voice/__tests__/tools-read.test.ts    NEW
dashboard/src/app/api/voice/__tests__/tools-write.test.ts   NEW
dashboard/src/app/api/voice/__tests__/session-close.test.ts NEW
dashboard/src/app/layout.tsx                                MOD  add nav link (dev-only)
drizzle/migrations/000N_voice_sessions.sql                  NEW  generated by drizzle-kit
docs/superpowers/mockups/                                   NEW  directory (.gitkeep)
docs/superpowers/brainstorm-sessions/                       NEW  directory (.gitkeep)
docs/superpowers/research/                                   NEW  directory (.gitkeep; reserved)
.env.example                                                 MOD  add GEMINI_API_KEY + VOICE_MONTHLY_BUDGET_USD
CLAUDE.md                                                    MOD  document the /voice surface
```

## Parallelism Guidance

Tasks can be grouped into phases. Within a phase, tasks that touch disjoint files can run in parallel subagents.

- **Phase A** (Foundation, sequential): Tasks 1 → 2 → 3 → 4
- **Phase B** (Server, mostly parallel after 5): Task 5 first; then 6, 7, 8, 10, 11 in parallel (different files). Task 9 **must run after Task 8** because it extends the same dispatcher file.
- **Phase C** (Client, parallel after 12): Task 12 first (cost tracker is a dep); then 13, 14, 15 in parallel (different files). Then 16, 17, 18 in parallel. Then 19 (page wiring; depends on all).
- **Phase D** (Integration, sequential): 20 → 21 → 22 → 23.

File scope per task is listed in each task's **Files** section. A parallel subagent must touch ONLY those files.

---

## Phase A — Foundation

### Task 1: Install dependencies

**Files:**
- Modify: `dashboard/package.json`
- Modify: `package-lock.json` (generated)
- Do NOT touch: root `package.json` (backend doesn't need these)

- [ ] **Step 1.1: Install `@google/genai`, `mermaid`, `uuid`, and dev dep `@types/uuid` in the dashboard.**

Run from repo root:
```bash
cd dashboard && npm install @google/genai mermaid uuid && npm install --save-dev @types/uuid && cd ..
```

Pin nothing by hand; trust `^` ranges from npm install.

- [ ] **Step 1.2: Sanity-check build.**

Run: `cd dashboard && npx tsc --noEmit && cd ..`
Expected: no errors. If there are pre-existing errors unrelated to this work, note them and proceed.

- [ ] **Step 1.3: Commit.**

```bash
git add dashboard/package.json dashboard/package-lock.json
git commit -m "chore(voice): add @google/genai, mermaid, uuid deps to dashboard"
```

### Task 2: Env var setup

**Files:**
- Modify: `.env.example`

- [ ] **Step 2.1: Append voice env section to `.env.example`.**

Add at the bottom:
```
# --- Voice (live Gemini chat at /voice) ---
# GEMINI_API_KEY is set by the migration spec; if only lowercase google_api_key
# is present, the voice feature falls back to it with a one-time warning.
VOICE_MONTHLY_BUDGET_USD=
```

- [ ] **Step 2.2: Commit.**

```bash
git add .env.example
git commit -m "chore(voice): document VOICE_MONTHLY_BUDGET_USD env var"
```

### Task 3: `voice_sessions` table — schema + migration

**Files:**
- Create: `src/db/schema/voice.ts`
- Modify: `src/db/schema/index.ts`
- Modify: `dashboard/src/lib/db/schema.ts`
- Create: `drizzle/migrations/NNNN_voice_sessions.sql` (generated)

Column list (SQL, **use these names exactly**, snake_case):

```
id               TEXT PRIMARY KEY       -- UUID
persona          TEXT NOT NULL          -- 'dev' in v1
started_at       TEXT NOT NULL          -- ISO 8601
ended_at         TEXT NOT NULL          -- ISO 8601
duration_seconds INTEGER NOT NULL
text_tokens_in   INTEGER NOT NULL DEFAULT 0
text_tokens_out  INTEGER NOT NULL DEFAULT 0
audio_tokens_in  INTEGER NOT NULL DEFAULT 0
audio_tokens_out INTEGER NOT NULL DEFAULT 0
cost_usd         REAL    NOT NULL
rates_version    TEXT    NOT NULL       -- sha256(rates.ts) short hash
transcript_path  TEXT                   -- nullable (if beacon fails)
artifacts        TEXT                   -- JSON array of file paths
```

Index: `CREATE INDEX idx_voice_sessions_started ON voice_sessions(started_at);`

- [ ] **Step 3.1: Write the canonical Drizzle schema at `src/db/schema/voice.ts`.**

Use the existing `src/db/schema/study.ts` as the pattern (import `sqliteTable`, `text`, `integer`, `real`, `index` from `drizzle-orm/sqlite-core`).

Property names must be camelCase; DB column names must match the SQL list above exactly.

Key exports:
```ts
export const voiceSessions = sqliteTable('voice_sessions', { ... },
  (table) => ({ startedAtIdx: index('idx_voice_sessions_started').on(table.startedAt) })
);
export type VoiceSession = typeof voiceSessions.$inferSelect;
export type NewVoiceSession = typeof voiceSessions.$inferInsert;
```

- [ ] **Step 3.2: Add voice export to `src/db/schema/index.ts`.**

Append: `export * from './voice.js';` in the same style as the other re-exports.

- [ ] **Step 3.3: Generate migration SQL.**

Run from repo root:
```bash
npx drizzle-kit generate
```

Expected: a new file `drizzle/migrations/NNNN_<adjective>_<name>.sql` containing a `CREATE TABLE voice_sessions` plus the index.

Inspect the generated file. Confirm columns match the list above. If drizzle-kit chose a weird adjective, that's fine.

- [ ] **Step 3.4: Mirror schema in the dashboard.**

Open `dashboard/src/lib/db/schema.ts`. At the bottom (respecting the comment banner), add a `voice_sessions` export that matches the canonical one.

**The dashboard schema uses `snake_case` TypeScript property names** (read the nearby `ingestion_jobs`, `settings`, and `concepts` exports — they all use `source_path: text('source_path')`, `vault_note_path: text('vault_note_path')`, etc.). Match that convention exactly:

```ts
export const voice_sessions = sqliteTable('voice_sessions', {
  id: text('id').primaryKey(),
  persona: text('persona').notNull(),
  started_at: text('started_at').notNull(),
  ended_at: text('ended_at').notNull(),
  duration_seconds: integer('duration_seconds').notNull(),
  text_tokens_in: integer('text_tokens_in').notNull().default(0),
  text_tokens_out: integer('text_tokens_out').notNull().default(0),
  audio_tokens_in: integer('audio_tokens_in').notNull().default(0),
  audio_tokens_out: integer('audio_tokens_out').notNull().default(0),
  cost_usd: real('cost_usd').notNull(),
  rates_version: text('rates_version').notNull(),
  transcript_path: text('transcript_path'),
  artifacts: text('artifacts'),
});
```

**Consequence for Task 10:** Drizzle insert values use TS property names, so `db.insert(voice_sessions).values({...})` uses snake_case keys (`started_at:`, `duration_seconds:`, `cost_usd:`, etc.). Translation from camelCase request JSON to snake_case Drizzle values happens explicitly at the route-handler boundary.

- [ ] **Step 3.5: Sanity-run migration.**

Run the dashboard in a scratch terminal just to trigger migration (or run the migration script directly if one exists):
```bash
# Start nanoclaw to trigger migrations (it calls runMigrations in src/db/migrate.ts)
# Or use drizzle-kit migrate if desired:
npx drizzle-kit migrate
```

Expected: `store/messages.db` has the new table. Verify with:
```bash
sqlite3 store/messages.db ".schema voice_sessions"
```
Expected output: the CREATE TABLE matches step 3.3.

- [ ] **Step 3.6: Commit.**

```bash
git add src/db/schema/voice.ts src/db/schema/index.ts dashboard/src/lib/db/schema.ts drizzle/migrations/
git commit -m "feat(voice): add voice_sessions table for cost tracking"
```

### Task 4: Rates config (`rates.ts`)

**Files:**
- Create: `dashboard/src/app/voice/rates.ts`
- Create: `dashboard/src/app/voice/__tests__/rates.test.ts`

This is a pure-data module plus a `computeCostUsd(usage, rates)` function. Tests pin the math.

- [ ] **Step 4.1: Write the failing test at `dashboard/src/app/voice/__tests__/rates.test.ts`.**

```ts
import { describe, it, expect } from 'vitest';
import { computeCostUsd, RATES } from '../rates';

describe('rates', () => {
  it('computes zero cost for zero tokens', () => {
    expect(computeCostUsd({ textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 }, RATES)).toBe(0);
  });

  it('computes cost as the sum of per-modality rates (per million tokens)', () => {
    const rates = { textInPerM: 1, textOutPerM: 2, audioInPerM: 4, audioOutPerM: 8, asOf: '2026-04-18', version: 'test' };
    const usage = { textIn: 500_000, textOut: 1_000_000, audioIn: 2_000_000, audioOut: 500_000 };
    // 0.5 * 1 + 1 * 2 + 2 * 4 + 0.5 * 8 = 0.5 + 2 + 8 + 4 = 14.5
    expect(computeCostUsd(usage, rates)).toBeCloseTo(14.5, 6);
  });

  it('exposes a rates version string for persistence', () => {
    expect(RATES.version).toMatch(/^[a-z0-9-]+$/);
    expect(RATES.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 4.2: Run to confirm failure.**

Run: `npm test -- dashboard/src/app/voice/__tests__/rates.test.ts`
Expected: FAIL with "Cannot find module '../rates'".

- [ ] **Step 4.3: Implement `rates.ts`.**

Put actual Gemini 3.1 Flash Live values (look them up at https://ai.google.dev/gemini-api/docs/pricing when running this task; insert a clear comment with source URL and retrieval date).

```ts
// Gemini 3.1 Flash Live pricing. Source: https://ai.google.dev/gemini-api/docs/pricing
// Retrieved: <YYYY-MM-DD>. Update the `asOf` field and `version` when these change.

export interface Rates {
  textInPerM: number;
  textOutPerM: number;
  audioInPerM: number;
  audioOutPerM: number;
  asOf: string;  // YYYY-MM-DD
  version: string;  // short tag used by voice_sessions.rates_version
}

export const RATES: Rates = {
  textInPerM:  /* look up */ 0,
  textOutPerM: /* look up */ 0,
  audioInPerM: /* look up */ 0,
  audioOutPerM:/* look up */ 0,
  asOf: '2026-04-18',
  version: 'gemini-3.1-flash-live-2026-04',
};

export interface TokenUsage {
  textIn: number;
  textOut: number;
  audioIn: number;
  audioOut: number;
}

export function computeCostUsd(usage: TokenUsage, rates: Rates): number {
  return (
    (usage.textIn   / 1_000_000) * rates.textInPerM +
    (usage.textOut  / 1_000_000) * rates.textOutPerM +
    (usage.audioIn  / 1_000_000) * rates.audioInPerM +
    (usage.audioOut / 1_000_000) * rates.audioOutPerM
  );
}
```

**Do NOT guess rates.** If Google's pricing page is unreachable, leave placeholders and flag to the coordinator; tests will still pass because they provide their own rates object.

- [ ] **Step 4.4: Run tests.**

Run: `npm test -- dashboard/src/app/voice/__tests__/rates.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4.5: Commit.**

```bash
git add dashboard/src/app/voice/rates.ts dashboard/src/app/voice/__tests__/rates.test.ts
git commit -m "feat(voice): rates config + cost math"
```

---

## Phase B — Server

### Task 5: Voice logger + path-scope utilities

**Files:**
- Create: `src/voice/path-scope.ts`
- Create: `src/voice/voice-log.ts`
- Create: `src/voice/__tests__/path-scope.test.ts`
- Create: `src/voice/__tests__/voice-log.test.ts`

These are shared server utilities. Building them first unblocks the tool handlers.

- [ ] **Step 5.1: Write failing path-scope tests.**

Create `src/voice/__tests__/path-scope.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveReadPath, resolveWritePath, sanitizeSlug } from '../path-scope';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'voice-scope-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'x');
  await writeFile(path.join(root, '.env'), 'SECRET=1');
  await mkdir(path.join(root, 'docs', 'superpowers', 'specs'), { recursive: true });
});

describe('sanitizeSlug', () => {
  it('accepts lowercase, digits, hyphen', () => {
    expect(sanitizeSlug('voice-chat-v1')).toBe('voice-chat-v1');
  });
  it.each([
    [''], ['a'.repeat(81)], ['has slash/bad'], ['UPPER'], ['dot.bad'], ['..'], [' pad '],
  ])('rejects invalid slug %s', (bad) => {
    expect(() => sanitizeSlug(bad)).toThrow();
  });
});

describe('resolveReadPath', () => {
  it('allows files under src/', async () => {
    const p = await resolveReadPath(root, 'src/a.ts');
    expect(p).toBe(path.join(root, 'src', 'a.ts'));
  });

  it('rejects .env', async () => {
    await expect(resolveReadPath(root, '.env')).rejects.toThrow(/out of scope/);
  });

  it('rejects absolute path outside root', async () => {
    await expect(resolveReadPath(root, '/etc/passwd')).rejects.toThrow(/out of scope/);
  });

  it('rejects parent traversal', async () => {
    await expect(resolveReadPath(root, '../etc/passwd')).rejects.toThrow(/out of scope/);
  });

  it('rejects symlink escapes', async () => {
    await symlink(path.join(root, '..'), path.join(root, 'src', 'escape'));
    await expect(resolveReadPath(root, 'src/escape/secret')).rejects.toThrow();
  });
});

describe('resolveWritePath', () => {
  it('returns a path under the targeted docs dir with server-generated date prefix', async () => {
    const p = await resolveWritePath(root, 'specs', 'my-slug', 'md');
    expect(p).toMatch(/docs\/superpowers\/specs\/\d{4}-\d{2}-\d{2}-my-slug\.md$/);
  });

  it('rejects slug with path separator', async () => {
    await expect(resolveWritePath(root, 'specs', '../escape', 'md')).rejects.toThrow();
  });
});
```

- [ ] **Step 5.2: Run to confirm failure.**

Run: `npm test -- src/voice/__tests__/path-scope.test.ts`
Expected: FAIL with "Cannot find module '../path-scope'".

- [ ] **Step 5.3: Implement `src/voice/path-scope.ts`.**

Export:
- `sanitizeSlug(slug: string): string` — regex `^[a-z0-9-]{1,80}$`, throws on mismatch.
- `resolveReadPath(repoRoot: string, requested: string): Promise<string>` — joins, resolves via `fs.realpath`, asserts resolved path starts with `repoRoot`, asserts first segment is in allow-list (`src`, `container`, `dashboard/src`, `docs`, `scripts`, `public`) OR the basename is in the root-config allowlist, asserts no denied substring (`.env`, `store`, `onecli`, `groups`, `data`, `node_modules`, `.venv`, `.git`).
- `resolveWritePath(repoRoot: string, kind: 'specs'|'plans'|'mockups', slug: string, ext: string): Promise<string>` — calls `sanitizeSlug`, joins `docs/superpowers/<kind>/<YYYY-MM-DD>-<slug>.<ext>`, ensures parent dir exists (mkdir -p), resolves parent via realpath, asserts parent starts with `path.join(repoRoot, 'docs/superpowers', kind)`. Date = `new Date().toISOString().slice(0,10)`.

Allow-list root config names (exact match against basename): `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`.

- [ ] **Step 5.4: Run tests.**

Run: `npm test -- src/voice/__tests__/path-scope.test.ts`
Expected: PASS.

- [ ] **Step 5.5: Write failing voice-log test.**

Create `src/voice/__tests__/voice-log.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createVoiceLogger } from '../voice-log';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'voice-log-'));
});

describe('voice-log', () => {
  it('writes one JSON line per event', async () => {
    const log = createVoiceLogger(path.join(dir, 'voice.log'));
    await log({ event: 'session.start', voiceSessionId: 'abc', persona: 'dev' });
    await log({ event: 'tool.call', voiceSessionId: 'abc', tool: 'read_file' });
    const body = await readFile(path.join(dir, 'voice.log'), 'utf8');
    const lines = body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: 'session.start', voiceSessionId: 'abc' });
    expect(lines[0].ts).toBeDefined();
  });

  it('includes a timestamp', async () => {
    const log = createVoiceLogger(path.join(dir, 'voice.log'));
    await log({ event: 'session.end', voiceSessionId: 'x' });
    const body = await readFile(path.join(dir, 'voice.log'), 'utf8');
    const line = JSON.parse(body.trim());
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 5.6: Implement `src/voice/voice-log.ts`.**

`createVoiceLogger(path: string) => (record: Record<string, unknown>) => Promise<void>` — opens the file in append mode, writes `{ ts: new Date().toISOString(), ...record }` as a single JSON line, flushes. Ensures parent directory exists.

- [ ] **Step 5.7: Run tests.**

Run: `npm test -- src/voice/__tests__/`
Expected: PASS.

- [ ] **Step 5.8: Commit.**

```bash
git add src/voice/
git commit -m "feat(voice): path-scope guards + voice-log JSON writer"
```

### Task 6: Token endpoint (`POST /api/voice/token`) — parallel-safe

**Files:**
- Create: `dashboard/src/app/api/voice/token/route.ts`
- Create: `dashboard/src/app/api/voice/__tests__/token.test.ts`

This endpoint mints an ephemeral token using `@google/genai`. It accepts an optional `resumeHandle` (ignored) and a required `persona`.

Spec requirement (security): reject if the `Host` header indicates the server is not on loopback.

- [ ] **Step 6.1: Write failing test.**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../../voice/token/route';

// Mock @google/genai
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    authTokens = {
      create: vi.fn().mockResolvedValue({
        name: 'tokens/fake',
        // The real SDK returns an opaque token in authTokens.create; check the SDK docs at implementation time.
      }),
    };
  },
}));

function makeReq(body: unknown, host = 'localhost:3100') {
  return new Request('http://localhost:3100/api/voice/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host },
    body: JSON.stringify(body),
  });
}

describe('POST /api/voice/token', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
  });

  it('returns 400 when persona missing', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 403 when host is not loopback', async () => {
    const res = await POST(makeReq({ persona: 'dev' }, 'public.example.com'));
    expect(res.status).toBe(403);
  });

  it('returns 500 when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.google_api_key;
    const res = await POST(makeReq({ persona: 'dev' }));
    expect(res.status).toBe(500);
  });

  it('returns an ephemeral token on success', async () => {
    const res = await POST(makeReq({ persona: 'dev' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeDefined();
    expect(body.voiceSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts (and ignores) resumeHandle in v1', async () => {
    const res = await POST(makeReq({ persona: 'dev', resumeHandle: 'abc' }));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 6.2: Run to confirm failure.**

Run: `npm test -- dashboard/src/app/api/voice/__tests__/token.test.ts`
Expected: FAIL.

- [ ] **Step 6.3: Implement token route.**

`dashboard/src/app/api/voice/token/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'node:crypto';

function isLoopback(host: string | null): boolean {
  if (!host) return false;
  const h = host.split(':')[0];
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

function getApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.google_api_key;
}

export async function POST(req: NextRequest) {
  if (!isLoopback(req.headers.get('host'))) {
    return NextResponse.json({ error: 'voice endpoints are localhost-only' }, { status: 403 });
  }
  let body: { persona?: string; resumeHandle?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  if (!body.persona || body.persona !== 'dev') {
    return NextResponse.json({ error: 'persona required (only "dev" supported in v1)' }, { status: 400 });
  }
  const apiKey = getApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: 'GEMINI_API_KEY is not set' }, { status: 500 });
  }
  const voiceSessionId = randomUUID();
  try {
    const client = new GoogleGenAI({ apiKey });
    // Exact SDK call: look up the current @google/genai API for ephemeral tokens.
    // As of research date: client.authTokens.create({ config: { uses: 1, expireTime, liveConnectConstraints: { model: 'gemini-3.1-flash-live-preview' } } })
    const token = await (client as any).authTokens.create({
      config: {
        uses: 1,
        liveConnectConstraints: { model: 'gemini-3.1-flash-live-preview' },
        // 30 min session lifetime after start; 1 min to start:
        expireTime: new Date(Date.now() + 31 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
      },
    });
    return NextResponse.json({ token: token.name ?? token, voiceSessionId });
  } catch (err) {
    return NextResponse.json({ error: `token mint failed: ${(err as Error).message}` }, { status: 502 });
  }
}
```

**Note to the engineer**: the SDK method name and request shape MUST be verified against the latest `@google/genai` TypeScript types at implementation time. If the call signature differs, adjust to match the SDK. The important invariant is: we mint a single-use, short-lived token bound to `gemini-3.1-flash-live-preview` and return it to the client.

- [ ] **Step 6.4: Run tests.**

Run: `npm test -- dashboard/src/app/api/voice/__tests__/token.test.ts`
Expected: PASS.

- [ ] **Step 6.5: Commit.**

```bash
git add dashboard/src/app/api/voice/token/ dashboard/src/app/api/voice/__tests__/token.test.ts
git commit -m "feat(voice): ephemeral-token endpoint (/api/voice/token)"
```

### Task 7: Startup context endpoint (`GET /api/voice/context/dev`) — parallel-safe

**Files:**
- Create: `dashboard/src/app/api/voice/context/dev/route.ts`
- Create: `dashboard/src/app/api/voice/__tests__/context.test.ts`
- Create: `src/voice/subsystem-map.ts` (static data; exported so both the endpoint and tests can reference it)

Context payload shape (JSON returned to the client, in camelCase):

```ts
interface DevStartupContext {
  claudeMd: string;
  architecture: string;
  subsystemMap: Array<{ path: string; purpose: string }>;
  scripts: { root: Record<string, string>; dashboard: Record<string, string> };
  repoState: {
    branch: string;
    statusShort: string;   // `git status --short`
    recentCommits: Array<{ sha: string; subject: string }>;
    specNames: string[];
    planNames: string[];
  };
  sessionMeta: { generatedAt: string };
}
```

- [ ] **Step 7.1: Create `src/voice/subsystem-map.ts`.**

Hand-curated list. Example seed:
```ts
export interface SubsystemEntry { path: string; purpose: string; }
export const SUBSYSTEMS: SubsystemEntry[] = [
  { path: 'src/ingestion/', purpose: 'File watcher → Docling extraction → Claude note generation → auto-promotion to vault.' },
  { path: 'src/rag/', purpose: 'LightRAG hybrid retrieval with SQLite-tracked indexing; chokidar watcher with content-hash dedup.' },
  { path: 'src/study/', purpose: 'Study engine, session builder, SM-2 spacing, scaffolding, audio pipeline.' },
  { path: 'src/vault/', purpose: 'Direct Obsidian vault file I/O (gray-matter + wikilinks).' },
  { path: 'src/channels/', purpose: 'Channel registry and per-channel adapters (telegram, web, slack, …).' },
  { path: 'src/profile/', purpose: 'Student profile: progress tracking, knowledge map, study-log rotation.' },
  { path: 'src/db/schema/', purpose: 'Canonical Drizzle schema (snake_case SQL columns, camelCase TS properties).' },
  { path: 'dashboard/src/app/study/', purpose: 'Dashboard UI for study sessions, plans, analytics.' },
  { path: 'dashboard/src/app/vault/', purpose: 'Dashboard UI for browsing and editing vault notes.' },
  { path: 'dashboard/src/app/read/', purpose: 'Speed reader (RSVP) and book (EPUB) reading surfaces.' },
  { path: 'dashboard/src/lib/', purpose: 'Dashboard-side DB helpers, study math, session builder.' },
  { path: 'container/', purpose: 'Agent-runner container definition (Dockerfile + TS entrypoint + MCP tool surface).' },
  { path: 'docs/superpowers/', purpose: 'Design specs and implementation plans for major features.' },
];
```

Keep the list short and accurate. Update if you notice the repo has additional significant subsystems.

- [ ] **Step 7.2: Write failing test.**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { GET } from '../../voice/context/dev/route';

function makeReq(host = 'localhost:3100') {
  return new Request('http://localhost:3100/api/voice/context/dev', { headers: { host } });
}

describe('GET /api/voice/context/dev', () => {
  it('returns 403 off loopback', async () => {
    const res = await GET(makeReq('public.example.com'));
    expect(res.status).toBe(403);
  });

  it('returns full context payload', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.claudeMd).toBe('string');
    expect(body.claudeMd.length).toBeGreaterThan(100);
    expect(Array.isArray(body.subsystemMap)).toBe(true);
    expect(body.subsystemMap[0]).toHaveProperty('path');
    expect(body.repoState.branch).toBeDefined();
    expect(Array.isArray(body.repoState.recentCommits)).toBe(true);
  });
});
```

- [ ] **Step 7.3: Implement `dashboard/src/app/api/voice/context/dev/route.ts`.**

Steps inside the handler:
1. Loopback gate (same as token).
2. Resolve repo root (see Conventions §5).
3. Read `CLAUDE.md`, `docs/ARCHITECTURE.md` from repo root; tolerate missing with an empty-string fallback and a `warning` field.
4. Load `SUBSYSTEMS` from `src/voice/subsystem-map.ts`.
5. Read `package.json` scripts + `dashboard/package.json` scripts.
6. Shell out to `git`:
   - `git rev-parse --abbrev-ref HEAD`
   - `git status --short`
   - `git log -n 10 --pretty=format:%h%x09%s`
7. `fs.readdir` `docs/superpowers/specs/` and `.../plans/` (names only).
8. Return as `DevStartupContext`.

Use `child_process.execFileSync` with array args (never template strings) and a working-dir set to repo root. Capture stderr; if any git call fails, populate fields with empty defaults.

- [ ] **Step 7.4: Run tests.**

Run: `npm test -- dashboard/src/app/api/voice/__tests__/context.test.ts`
Expected: PASS. (Test runs against the real repo in the worktree.)

- [ ] **Step 7.5: Commit.**

```bash
git add dashboard/src/app/api/voice/context/ dashboard/src/app/api/voice/__tests__/context.test.ts src/voice/subsystem-map.ts
git commit -m "feat(voice): startup-context endpoint + subsystem map"
```

### Task 8: Read tools (`read_file`, `glob`, `grep`, `git_log`, `git_status`, `list_docs`, `read_doc`) — parallel-safe

**Files:**
- Create: `dashboard/src/app/api/voice/tools/dev/[tool]/route.ts` (single dynamic route; dispatches by tool name)
- Create: `dashboard/src/app/api/voice/__tests__/tools-read.test.ts`

The single route handler is a small dispatcher. Each tool lives as a named function. This avoids creating seven separate route files.

- [ ] **Step 8.1: Write failing tests. For each read tool, one success case and one scope-denial case.**

Skeleton (expand with a case per tool):

```ts
import { describe, it, expect } from 'vitest';
import { POST } from '../../voice/tools/dev/[tool]/route';

async function call(tool: string, args: unknown) {
  const req = new Request(`http://localhost:3100/api/voice/tools/dev/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost' },
    body: JSON.stringify(args),
  });
  const res = await POST(req, { params: Promise.resolve({ tool }) } as any);
  return { status: res.status, body: await res.json() };
}

describe('read tools', () => {
  it('read_file: returns file contents for an allowed path', async () => {
    const { status, body } = await call('read_file', { path: 'package.json' });
    expect(status).toBe(200);
    expect(body.content).toContain('"name"');
  });

  it('read_file: rejects .env with a clear error', async () => {
    const { status, body } = await call('read_file', { path: '.env' });
    expect(status).toBe(200);            // tool-level errors return 200 with { error }
    expect(body.error).toMatch(/out of scope/);
  });

  it('read_file: truncates at 256 KB', async () => {
    // arrange: use a known large file or create a temp fixture; assert marker in body
  });

  it('glob: returns matching paths', async () => {
    const { body } = await call('glob', { pattern: 'src/**/*.test.ts' });
    expect(body.paths.length).toBeGreaterThan(0);
  });

  it('grep: returns matches with path/line/text', async () => {
    const { body } = await call('grep', { pattern: 'function', glob: 'src/**/*.ts' });
    expect(body.matches[0]).toHaveProperty('path');
    expect(body.matches[0]).toHaveProperty('line');
  });

  it('git_log: returns recent commits', async () => {
    const { body } = await call('git_log', { limit: 3 });
    expect(body.commits.length).toBeLessThanOrEqual(3);
  });

  it('git_status: returns branch and changes', async () => {
    const { body } = await call('git_status', {});
    expect(typeof body.branch).toBe('string');
  });

  it('list_docs: lists spec filenames', async () => {
    const { body } = await call('list_docs', { kind: 'specs' });
    expect(body.files.some((f: string) => f.endsWith('.md'))).toBe(true);
  });

  it('read_doc: returns a spec file', async () => {
    const { body } = await call('read_doc', { kind: 'specs', name: '2026-04-18-live-voice-chat-design.md' });
    expect(body.content.startsWith('# Live Voice Chat')).toBe(true);
  });

  it('unknown tool returns 404', async () => {
    const res = await call('bogus', {});
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 8.2: Run to confirm failure.**

Run: `npm test -- dashboard/src/app/api/voice/__tests__/tools-read.test.ts`
Expected: FAIL.

- [ ] **Step 8.3: Implement the dispatcher and read-tool functions.**

`route.ts` outline:

```ts
import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveReadPath } from '../../../../../../../src/voice/path-scope';
// Or via a tsconfig path; match the import style used in the rest of dashboard/.

const READ_MAX = 256 * 1024;
const TRUNC_MARKER = '\n\n[truncated at 256 KB — use grep/glob for larger files]';

async function readFileTool(repoRoot: string, args: { path: string }) { /* … */ }
async function globTool(repoRoot: string, args: { pattern: string }) { /* use `glob` npm package or fs-based walk; add dep if needed */ }
async function grepTool(repoRoot: string, args: { pattern: string; glob?: string; path?: string }) { /* shell out to `rg` if available, else node-side; fail soft */ }
async function gitLogTool(repoRoot: string, args: { limit?: number; path?: string }) { /* execFile git */ }
async function gitStatusTool(repoRoot: string) { /* execFile git */ }
async function listDocsTool(repoRoot: string, args: { kind: 'specs'|'plans'|'mockups'|'sessions' }) { /* fs.readdir */ }
async function readDocTool(repoRoot: string, args: { kind: string; name: string }) { /* compose path, call readFileTool */ }

const TOOLS: Record<string, (repoRoot: string, args: any) => Promise<unknown>> = {
  read_file: readFileTool,
  glob: globTool,
  grep: grepTool,
  git_log: gitLogTool,
  git_status: gitStatusTool,
  list_docs: listDocsTool,
  read_doc: readDocTool,
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ tool: string }> }) {
  // loopback gate
  const { tool } = await ctx.params;
  if (!(tool in TOOLS)) return NextResponse.json({ error: 'unknown tool' }, { status: 404 });
  const args = await req.json().catch(() => ({}));
  const repoRoot = getRepoRoot(); // derived per Conventions §5
  try {
    const out = await TOOLS[tool](repoRoot, args);
    return NextResponse.json(out);
  } catch (err) {
    // Distinguish scope errors (200 with body.error) from programmer errors (500).
    if ((err as Error).message.includes('out of scope')) {
      return NextResponse.json({ error: (err as Error).message });
    }
    return NextResponse.json({ error: 'tool execution failed' }, { status: 500 });
  }
}
```

Key correctness notes:
- `glob` tool: use the `glob` npm package (`npm install glob @types/glob` in dashboard if needed). Reject patterns with `..` at the top level.
- `grep` tool: shell out to `rg` via `execFile` if available (`rg --json`), otherwise fall back to the `glob` + `fs.readFile` walk with a simple regex. Cap results at 200 matches.
- Every read path passes through `resolveReadPath`.
- `read_file` truncation: if `content.length > READ_MAX`, slice to `READ_MAX` and append marker.

- [ ] **Step 8.4: Run tests.**

Run: `npm test -- dashboard/src/app/api/voice/__tests__/tools-read.test.ts`
Expected: PASS. If `rg` isn't available on the test machine, the grep test may hit the fallback — that's fine, just verify it still returns matches.

- [ ] **Step 8.5: Commit.**

```bash
git add dashboard/src/app/api/voice/tools/ dashboard/src/app/api/voice/__tests__/tools-read.test.ts
git commit -m "feat(voice): read tools (read_file, glob, grep, git_log, git_status, list_docs, read_doc)"
```

### Task 9: Write tools (`write_spec`, `write_plan`, `write_mockup`, `write_diagram`) — **sequential after Task 8**

**Files:**
- Modify: `dashboard/src/app/api/voice/tools/dev/[tool]/route.ts` (add write handlers to the dispatcher)
- Create: `dashboard/src/app/api/voice/__tests__/tools-write.test.ts`

Write contract: server controls the final path. Slug is sanitized. Content size capped at 256 KB. Existing-file-with-different-content refused with `error`.

- [ ] **Step 9.1: Write failing tests.**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { POST } from '../../voice/tools/dev/[tool]/route';

// The tests write to the actual repo's docs/superpowers/... — use a temp slug and clean up.

async function call(tool: string, args: unknown) {
  const req = new Request(`http://localhost:3100/api/voice/tools/dev/${tool}`, {
    method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify(args),
  });
  return POST(req, { params: Promise.resolve({ tool }) } as any);
}

const UNIQUE_SLUG = `test-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

describe('write tools', () => {
  afterEach(() => {
    // Best-effort cleanup: rm any docs/superpowers/*/**-UNIQUE_SLUG.* files created.
  });

  it('write_spec: writes to docs/superpowers/specs/ with today\'s date', async () => {
    const res = await call('write_spec', { slug: UNIQUE_SLUG, content: '# Hello' });
    const body = await res.json();
    expect(body.path).toMatch(new RegExp(`docs/superpowers/specs/\\d{4}-\\d{2}-\\d{2}-${UNIQUE_SLUG}\\.md$`));
    expect(existsSync(body.path)).toBe(true);
  });

  it('write_plan: same pattern, plans dir', async () => { /* … */ });
  it('write_mockup: writes .html with previewUrl', async () => { /* … */ });
  it('write_diagram: wraps mermaid in a fenced block in .md', async () => {
    const res = await call('write_diagram', { slug: UNIQUE_SLUG+'-d', mermaid: 'graph TD; A-->B;', title: 'x' });
    const body = await res.json();
    const contents = readFileSync(body.path, 'utf8');
    expect(contents).toContain('```mermaid');
    expect(contents).toContain('graph TD; A-->B;');
  });

  it('rejects slug with path separator', async () => {
    const res = await call('write_spec', { slug: 'bad/slug', content: 'x' });
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('rejects oversized content (>256 KB)', async () => {
    const res = await call('write_spec', { slug: UNIQUE_SLUG+'-big', content: 'x'.repeat(260 * 1024) });
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it('refuses to overwrite existing file with different content', async () => {
    const slug = UNIQUE_SLUG + '-dup';
    const first = await (await call('write_spec', { slug, content: 'A' })).json();
    const second = await (await call('write_spec', { slug, content: 'B' })).json();
    expect(second.error).toMatch(/would overwrite/);
    expect(second.existingContent).toBe('A');
  });
});
```

- [ ] **Step 9.2: Run to confirm failure.**

Run: `npm test -- dashboard/src/app/api/voice/__tests__/tools-write.test.ts`
Expected: FAIL.

- [ ] **Step 9.3: Implement write handlers.**

Add to the dispatcher:

```ts
const WRITE_MAX = 256 * 1024;

async function writeDoc(repoRoot: string, kind: 'specs'|'plans'|'mockups', slug: string, ext: string, body: string) {
  if (body.length > WRITE_MAX) throw new Error(`content too large (${body.length} bytes, max ${WRITE_MAX})`);
  const dest = await resolveWritePath(repoRoot, kind, slug, ext);
  // If file exists, compare.
  try {
    const existing = await fs.readFile(dest, 'utf8');
    if (existing !== body) {
      // Return structured error; do NOT throw.
      return { error: `would overwrite ${dest}`, existingContent: existing.slice(0, WRITE_MAX) };
    }
    // identical — no-op
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  await fs.writeFile(dest, body, 'utf8');
  return { path: path.relative(repoRoot, dest) };
}

async function writeSpecTool(root: string, args: { slug: string; content: string }) {
  return writeDoc(root, 'specs', args.slug, 'md', args.content);
}
async function writePlanTool(root: string, args: { slug: string; content: string }) {
  return writeDoc(root, 'plans', args.slug, 'md', args.content);
}
async function writeMockupTool(root: string, args: { slug: string; html: string }) {
  const result = await writeDoc(root, 'mockups', args.slug, 'html', args.html);
  if ('path' in result) return { ...result, previewUrl: `/voice/preview?file=${encodeURIComponent(result.path)}` };
  return result;
}
async function writeDiagramTool(root: string, args: { slug: string; mermaid: string; title?: string }) {
  const md = (args.title ? `# ${args.title}\n\n` : '') + '```mermaid\n' + args.mermaid + '\n```\n';
  const result = await writeDoc(root, 'mockups', args.slug, 'md', md);
  if ('path' in result) return { ...result, previewUrl: `/voice/preview?file=${encodeURIComponent(result.path)}` };
  return result;
}

// Register in TOOLS map:
TOOLS.write_spec = writeSpecTool;
TOOLS.write_plan = writePlanTool;
TOOLS.write_mockup = writeMockupTool;
TOOLS.write_diagram = writeDiagramTool;
```

- [ ] **Step 9.4: Run tests.**

Run: `npm test -- dashboard/src/app/api/voice/__tests__/tools-write.test.ts`
Expected: PASS.

- [ ] **Step 9.5: Commit.**

```bash
git add dashboard/src/app/api/voice/tools/ dashboard/src/app/api/voice/__tests__/tools-write.test.ts
git commit -m "feat(voice): write tools (spec/plan/mockup/diagram) with path+size guards"
```

### Task 10: Session-close endpoint — parallel-safe with 6-9

**Files:**
- Create: `dashboard/src/app/api/voice/session-close/route.ts`
- Create: `dashboard/src/app/api/voice/__tests__/session-close.test.ts`

Request body (camelCase):
```ts
{
  voiceSessionId: string;
  persona: 'dev';
  startedAt: string;    // ISO
  endedAt: string;      // ISO
  transcript: Array<{ role: 'user'|'assistant'; text: string; ts: string }>;
  usage: { textIn: number; textOut: number; audioIn: number; audioOut: number };
  artifacts: string[];  // paths returned by write tools during session
  endReason: 'user_stop'|'tab_close'|'soft_cap'|'hard_cap'|'ws_drop';
}
```

Behavior:
1. Loopback gate.
2. Compute duration.
3. Compute cost from `usage` using `rates.ts` on the server side too (import the same module).
4. Write transcript markdown file to `docs/superpowers/brainstorm-sessions/YYYY-MM-DD-HHMM.md` with frontmatter; if `transcript` is empty, skip the file and leave `transcript_path` null.
5. Insert row into `voice_sessions` via dashboard Drizzle client.
6. Emit `voice-log.ts` `session.end` record.
7. Respond `{ ok: true, transcriptPath, costUsd }`.

Transcript markdown template:
```
---
voiceSessionId: <id>
persona: dev
startedAt: <iso>
endedAt: <iso>
durationSeconds: <n>
costUsd: <$...>
artifacts:
  - <path1>
  - <path2>
---

## User

> <user turn>

## Assistant

<assistant turn>

…
```

- [ ] **Step 10.1: Write failing test.**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST } from '../../voice/session-close/route';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';

// This test writes a real row to store/messages.db. Use a sentinel voiceSessionId
// and clean up after.

describe('POST /api/voice/session-close', () => {
  const sid = 'test-' + Math.random().toString(36).slice(2, 10);

  afterEach(() => {
    // Remove the row
    const db = new Database('store/messages.db');
    db.prepare('DELETE FROM voice_sessions WHERE id = ?').run(sid);
    db.close();
    // Remove the transcript file(s) written with this sid if any — best effort
  });

  it('persists transcript file + session row', async () => {
    const req = new Request('http://localhost:3100/api/voice/session-close', {
      method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' },
      body: JSON.stringify({
        voiceSessionId: sid, persona: 'dev',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        endedAt: new Date().toISOString(),
        transcript: [{ role: 'user', text: 'hi', ts: new Date().toISOString() }],
        usage: { textIn: 1000, textOut: 2000, audioIn: 50_000, audioOut: 100_000 },
        artifacts: [],
        endReason: 'user_stop',
      }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.transcriptPath).toMatch(/brainstorm-sessions/);
    expect(existsSync(body.transcriptPath)).toBe(true);

    const db = new Database('store/messages.db');
    const row = db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(sid) as any;
    expect(row.persona).toBe('dev');
    expect(row.duration_seconds).toBeGreaterThan(0);
    expect(row.cost_usd).toBeGreaterThanOrEqual(0);
  });

  it('skips transcript file when transcript is empty', async () => {
    // …
  });
});
```

- [ ] **Step 10.2: Run to confirm failure.**

Run: `npm test -- dashboard/src/app/api/voice/__tests__/session-close.test.ts`
Expected: FAIL.

- [ ] **Step 10.3: Implement the route.**

Use `getDb()` from `dashboard/src/lib/db/index.ts` and import the `voice_sessions` table from `./schema` (note: dashboard schema uses snake_case TS property names — see Task 3.4). The Drizzle insert values object therefore uses snake_case keys matching the schema:

```ts
await db.insert(voice_sessions).values({
  id: body.voiceSessionId,                      // camelCase request → snake_case value key
  persona: body.persona,
  started_at: body.startedAt,
  ended_at: body.endedAt,
  duration_seconds: durationSeconds,
  text_tokens_in: body.usage.textIn,
  text_tokens_out: body.usage.textOut,
  audio_tokens_in: body.usage.audioIn,
  audio_tokens_out: body.usage.audioOut,
  cost_usd: costUsd,
  rates_version: RATES.version,
  transcript_path: transcriptPath,              // null if no transcript was written
  artifacts: JSON.stringify(body.artifacts),
});
```

API request JSON remains camelCase (`voiceSessionId`, `startedAt`, `usage.textIn`); translation to snake_case happens only at this boundary. The response JSON is also camelCase: `{ ok: true, transcriptPath, costUsd }`.

- [ ] **Step 10.4: Run tests.**

Run: `npm test -- dashboard/src/app/api/voice/__tests__/session-close.test.ts`
Expected: PASS.

- [ ] **Step 10.5: Commit.**

```bash
git add dashboard/src/app/api/voice/session-close/ dashboard/src/app/api/voice/__tests__/session-close.test.ts
git commit -m "feat(voice): session-close endpoint (transcript + session row)"
```

### Task 11: Persona config — parallel-safe

**Files:**
- Create: `dashboard/src/app/voice/personas.ts`

Pure-data module. Exports the Dev persona's system prompt, tool declarations (in `FunctionDeclaration` shape for Gemini), voice name, and startup-context path.

- [ ] **Step 11.1: Implement `personas.ts`.**

Approximate shape:

```ts
import type { FunctionDeclaration } from '@google/genai';

export interface PersonaConfig {
  name: 'dev';
  voice: string;
  systemInstruction: string;
  tools: FunctionDeclaration[];
  contextPath: string;  // '/api/voice/context/dev'
}

export const DEV_PERSONA: PersonaConfig = {
  name: 'dev',
  voice: 'Zephyr',
  systemInstruction: `<paste final system prompt from spec §Persona: Dev Assistant>`,
  contextPath: '/api/voice/context/dev',
  tools: [
    { name: 'read_file', description: '…', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] } },
    // glob, grep, git_log, git_status, list_docs, read_doc, write_spec, write_plan, write_mockup, write_diagram
  ],
};
```

Use the exact tool names defined in the spec and Tasks 8 + 9. The full param schemas live with the implementation in this file.

- [ ] **Step 11.2: Commit.**

```bash
git add dashboard/src/app/voice/personas.ts
git commit -m "feat(voice): Dev Assistant persona config"
```

---

## Phase C — Client

### Task 12: Cost tracker

**Files:**
- Create: `dashboard/src/app/voice/cost-tracker.ts`
- Create: `dashboard/src/app/voice/__tests__/cost-tracker.test.ts`

- [ ] **Step 12.1: Write failing test.**

```ts
import { describe, it, expect } from 'vitest';
import { CostTracker } from '../cost-tracker';
import { RATES } from '../rates';

describe('CostTracker', () => {
  it('accumulates token counts across turns', () => {
    const t = new CostTracker(RATES);
    t.addUsage({ textIn: 10, textOut: 20, audioIn: 100, audioOut: 200 });
    t.addUsage({ textIn: 5, textOut: 0, audioIn: 0, audioOut: 50 });
    expect(t.totals).toEqual({ textIn: 15, textOut: 20, audioIn: 100, audioOut: 250 });
  });

  it('exposes a live cost figure', () => {
    const t = new CostTracker({ textInPerM: 1_000_000, textOutPerM: 0, audioInPerM: 0, audioOutPerM: 0, asOf: 'x', version: 'x' });
    t.addUsage({ textIn: 1, textOut: 0, audioIn: 0, audioOut: 0 });
    expect(t.costUsd).toBeCloseTo(1, 6);
  });

  it('emits change events', () => {
    const t = new CostTracker(RATES);
    const seen: number[] = [];
    t.onChange((c) => seen.push(c));
    t.addUsage({ textIn: 100, textOut: 0, audioIn: 0, audioOut: 0 });
    expect(seen.length).toBe(1);
  });
});
```

- [ ] **Step 12.2: Run to confirm failure.**

Run: `npm test -- dashboard/src/app/voice/__tests__/cost-tracker.test.ts`
Expected: FAIL.

- [ ] **Step 12.3: Implement `CostTracker`.**

Plain TS class, no framework deps. Holds an internal `TokenUsage` total, exposes `totals`, `costUsd` getter, `addUsage(u)`, `reset()`, and `onChange(cb)`/`offChange(cb)`.

- [ ] **Step 12.4: Run tests.**

Run: `npm test -- dashboard/src/app/voice/__tests__/cost-tracker.test.ts`
Expected: PASS.

- [ ] **Step 12.5: Commit.**

```bash
git add dashboard/src/app/voice/cost-tracker.ts dashboard/src/app/voice/__tests__/cost-tracker.test.ts
git commit -m "feat(voice): cost tracker with live change events"
```

### Task 13: Audio I/O — parallel-safe with 14, 15

**Files:**
- Create: `dashboard/src/app/voice/audio-io.ts`
- Create: `dashboard/src/app/voice/audio-worklet-processor.ts`

This is browser-only code. Tests would need jsdom + a Web Audio shim (which jsdom lacks); skip unit tests for these two files and cover behavior via the integration test in Task 20.

- [ ] **Step 13.1: Implement the worklet processor.**

`audio-worklet-processor.ts` is loaded by the browser via `audioContext.audioWorklet.addModule(url)`. Contents (plain JS worklet):

```ts
class PcmCaptureProcessor extends AudioWorkletProcessor {
  // Downsample from audioContext.sampleRate (likely 48000) to 16000 and post Int16 frames.
  process(inputs: Float32Array[][]) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    // resample + Int16 convert + postMessage(buffer)
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
```

Ship as a `.ts` that Next.js can serve (or a `.js` placed in `public/`). Next.js 16 can import workers via `new Worker(new URL(...), import.meta.url)` but AudioWorkletModules need a URL path. Simplest: put a compiled `pcm-capture.js` in `dashboard/public/voice/` and `addModule('/voice/pcm-capture.js')`.

- [ ] **Step 13.2: Implement `audio-io.ts`.**

Two exports:

- `startMicCapture(): Promise<{ stream: MediaStream; onFrame: (cb: (pcm: Int16Array) => void) => void; stop: () => void }>`
- `createPlayback(): { enqueue: (pcm24: Int16Array) => void; stop: () => void }`

Playback uses `AudioBufferSourceNode` with a minimal buffer queue that schedules each chunk right after the previous one (`startTime = Math.max(ctx.currentTime, lastEndTime)`). No worklet needed for output.

- [ ] **Step 13.3: Commit.**

```bash
git add dashboard/src/app/voice/audio-io.ts dashboard/src/app/voice/audio-worklet-processor.ts dashboard/public/voice/
git commit -m "feat(voice): mic capture (worklet) + PCM playback"
```

### Task 14: Fake Gemini server — parallel-safe with 13, 15

**Files:**
- Create: `dashboard/src/app/voice/__tests__/fake-gemini-server.ts`

Standalone module used by `voice-session.test.ts`. Uses the `ws` package (add as a dev dep in dashboard if not present).

- [ ] **Step 14.1: Add `ws` dep.**

```bash
cd dashboard && npm install --save-dev ws @types/ws && cd ..
```

- [ ] **Step 14.2: Implement the fake server.**

Minimal API:

```ts
import { WebSocketServer, WebSocket } from 'ws';

export interface FakeGemini {
  url: string;
  close: () => Promise<void>;
  // Scripted behaviors:
  sendAssistantAudio: (chunkBase64: string) => void;
  sendInputTranscription: (text: string, partial?: boolean) => void;
  sendOutputTranscription: (text: string, partial?: boolean) => void;
  sendToolCall: (call: { id: string; name: string; args: unknown }) => void;
  sendUsage: (usage: { textIn: number; textOut: number; audioIn: number; audioOut: number }) => void;
  terminate: () => void;  // server-initiated close (simulates 15-min cap)
  waitForClientAudio: () => Promise<Buffer>;
  waitForToolResponse: (toolCallId: string) => Promise<unknown>;
}

export async function startFakeGemini(): Promise<FakeGemini>;
```

Implement only the framing needed for tests — opaque frames are fine as long as they match the shape `VoiceSession` expects.

- [ ] **Step 14.3: Commit.**

```bash
git add dashboard/src/app/voice/__tests__/fake-gemini-server.ts dashboard/package.json dashboard/package-lock.json
git commit -m "test(voice): fake Gemini Live WS server for integration tests"
```

### Task 15: `VoiceSession` class — parallel-safe with 13, 14

**Files:**
- Create: `dashboard/src/app/voice/voice-session.ts`
- Create: `dashboard/src/app/voice/__tests__/voice-session.test.ts`

Public surface:

```ts
export interface VoiceSessionEvents {
  onInputTranscript: (text: string, partial: boolean) => void;
  onOutputTranscript: (text: string, partial: boolean) => void;
  onAudio: (pcm: Int16Array) => void;
  onToolCall: (call: { id: string; name: string; args: unknown }) => Promise<unknown>;
  onCost: (costUsd: number) => void;
  onEnd: (payload: SessionEndPayload) => void;
}

export interface SessionEndPayload {
  transcript: Array<{ role: 'user'|'assistant'; text: string; ts: string }>;
  startedAt: string;
  endedAt: string;
  usage: TokenUsage;
  endReason: 'user_stop'|'tab_close'|'soft_cap'|'hard_cap'|'ws_drop';
  resumeHandle?: string;
}

export class VoiceSession {
  constructor(opts: {
    persona: PersonaConfig;
    tokenEndpoint?: string;     // defaults '/api/voice/token'
    contextEndpoint?: string;   // derived from persona
    toolEndpoint?: string;
    closeEndpoint?: string;
    liveApiUrl?: string;        // injectable for tests
    softCapSeconds?: number;    // default 10 * 60
    events: VoiceSessionEvents;
  });
  start(): Promise<void>;  // mints token, fetches context, opens WS, sends first clientContent
  sendAudio(pcm: Int16Array): void;
  mute(): void;
  unmute(): void;
  stop(reason?: SessionEndPayload['endReason']): Promise<void>;
}
```

Responsibilities:
- Own a `CostTracker` instance and forward `onChange` to `onCost`.
- Buffer the transcript from `onInput/OutputTranscript` final events only (drop partials from the buffer).
- Track `startedAt`. When `stop()` is called, compose `SessionEndPayload`, `fetch(closeEndpoint, { method: 'POST', keepalive: true, body: JSON.stringify(...) })`, then fire `onEnd`.
- Tool-call dispatch: on `onToolCall`, await the caller's response, send back as `toolResponse` over the WS.
- Soft-cap: `setTimeout(softCapSeconds * 1000, () => stop('soft_cap'))`.

- [ ] **Step 15.1: Write failing test using the fake server.**

```ts
import { describe, it, expect } from 'vitest';
import { startFakeGemini } from './fake-gemini-server';
import { VoiceSession } from '../voice-session';
import { DEV_PERSONA } from '../personas';

describe('VoiceSession', () => {
  it('connects, receives audio, and accumulates cost on usage events', async () => {
    const fake = await startFakeGemini();
    const audio: Int16Array[] = [];
    let lastCost = 0;
    const session = new VoiceSession({
      persona: DEV_PERSONA,
      liveApiUrl: fake.url,
      tokenEndpoint: '/test/token',   // stubbed via vi.fetch mock
      contextEndpoint: '/test/ctx',
      toolEndpoint: '/test/tool',
      closeEndpoint: '/test/close',
      events: {
        onAudio: (pcm) => audio.push(pcm),
        onCost: (c) => { lastCost = c; },
        onInputTranscript: () => {}, onOutputTranscript: () => {},
        onToolCall: async () => ({}), onEnd: () => {},
      },
    });
    // mock global fetch for the endpoints used above
    // start, feed a usage event + audio frame, assert receipt
    await session.start();
    fake.sendUsage({ textIn: 100_000, textOut: 200_000, audioIn: 1_000_000, audioOut: 1_000_000 });
    fake.sendAssistantAudio(/* tiny base64 PCM */ 'AAAA');
    await new Promise((r) => setTimeout(r, 50));
    expect(audio.length).toBeGreaterThan(0);
    expect(lastCost).toBeGreaterThan(0);
    await session.stop('user_stop');
    await fake.close();
  });

  it('round-trips a tool call', async () => { /* … */ });
  it('auto-stops at soft cap', async () => { /* using fake timers */ });
});
```

- [ ] **Step 15.2: Run to confirm failure.**

Run: `npm test -- dashboard/src/app/voice/__tests__/voice-session.test.ts`
Expected: FAIL.

- [ ] **Step 15.3: Implement `VoiceSession`.**

Decide per the latest `@google/genai` browser API: whether to use `client.live.connect()` (SDK-wrapped) or the raw WebSocket. For testability against the fake server, prefer the raw WebSocket approach and keep the frame shape minimal. Document the choice in a code comment.

- [ ] **Step 15.4: Run tests.**

Run: `npm test -- dashboard/src/app/voice/__tests__/voice-session.test.ts`
Expected: PASS.

- [ ] **Step 15.5: Commit.**

```bash
git add dashboard/src/app/voice/voice-session.ts dashboard/src/app/voice/__tests__/voice-session.test.ts
git commit -m "feat(voice): VoiceSession owns WS lifecycle + cost + transcript buffer"
```

### Task 16: Captions component

**Files:**
- Create: `dashboard/src/app/voice/captions.tsx`

Simple React component. No unit test required; exercised by Task 20 / manual dogfood.

- [ ] **Step 16.1: Implement.**

Props: `{ lines: Array<{ role: 'user'|'assistant'; text: string; ts: string; partial?: boolean }> }`. Renders a scrolling list. User lines left-aligned muted; assistant lines right-aligned normal. Pin to bottom unless user has scrolled up. Include a "Copy session" button.

- [ ] **Step 16.2: Commit.**

```bash
git add dashboard/src/app/voice/captions.tsx
git commit -m "feat(voice): Captions component"
```

### Task 17: Preview pane

**Files:**
- Create: `dashboard/src/app/voice/preview-pane.tsx`

- [ ] **Step 17.1: Implement.**

Props: `{ artifacts: Array<{ type: 'mockup'|'diagram'; path: string }> }`. Two tabs: Mockup and Diagram. Selected tab renders the latest artifact of that type. Mockup via `<iframe sandbox="allow-scripts" src={`/voice/preview?file=${encodeURIComponent(path)}`} />`. Diagram via `mermaid.initialize({ startOnLoad: false })` and `mermaid.render()`.

To serve the mockup file from its location on disk, add a helper route `dashboard/src/app/voice/preview/route.ts` (GET) that reads the file from the mockups dir (path-scoped to `docs/superpowers/mockups/`) and returns its bytes as text/html or text/markdown. Reuse `resolveReadPath`-style guards.

- [ ] **Step 17.2: Commit.**

```bash
git add dashboard/src/app/voice/preview-pane.tsx dashboard/src/app/voice/preview/
git commit -m "feat(voice): preview pane (mockup iframe + mermaid)"
```

### Task 18: Cost panel

**Files:**
- Create: `dashboard/src/app/voice/cost-panel.tsx`
- Create: `dashboard/src/app/api/voice/stats/route.ts`
- Create: `dashboard/src/app/api/voice/__tests__/stats.test.ts`

Cost panel shows: current session $ (from `CostTracker`), today total, month-to-date total. The rollups come from `/api/voice/stats`.

- [ ] **Step 18.1: Write failing test for stats endpoint.**

```ts
import { describe, it, expect } from 'vitest';
import { GET } from '../../voice/stats/route';

describe('GET /api/voice/stats', () => {
  it('returns today and month totals + warning threshold', async () => {
    const req = new Request('http://localhost:3100/api/voice/stats', { headers: { host: 'localhost' } });
    const res = await GET(req);
    const body = await res.json();
    expect(typeof body.todayUsd).toBe('number');
    expect(typeof body.monthUsd).toBe('number');
    expect(body.budgetUsd === null || typeof body.budgetUsd === 'number').toBe(true);
  });
});
```

- [ ] **Step 18.2: Implement stats endpoint.**

SQL (inline to avoid hallucination — verified against Task 3 schema):

```ts
const todayRow = db.all(sql`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM voice_sessions WHERE date(started_at) = date('now','localtime')`);
const monthRow = db.all(sql`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM voice_sessions WHERE strftime('%Y-%m', started_at) = strftime('%Y-%m', 'now','localtime')`);
```

Return `{ todayUsd, monthUsd, budgetUsd: process.env.VOICE_MONTHLY_BUDGET_USD ? Number(...) : null }`.

- [ ] **Step 18.3: Implement cost panel UI.**

Shows three figures; tooltip on session $ shows token breakdown from `CostTracker.totals`. If `monthUsd > budgetUsd`, render a non-blocking amber banner.

- [ ] **Step 18.4: Run tests.**

Run: `npm test -- dashboard/src/app/api/voice/__tests__/stats.test.ts`
Expected: PASS.

- [ ] **Step 18.5: Commit.**

```bash
git add dashboard/src/app/voice/cost-panel.tsx dashboard/src/app/api/voice/stats/ dashboard/src/app/api/voice/__tests__/stats.test.ts
git commit -m "feat(voice): cost panel + /api/voice/stats rollups"
```

### Task 19: `/voice` page

**Files:**
- Create: `dashboard/src/app/voice/page.tsx`

- [ ] **Step 19.1: Implement page.**

Use a top-level client component (`'use client'`). Responsibilities:

1. Mount: fetch `/api/voice/stats` for rollups; subscribe to `CostTracker` updates.
2. Top bar: persona name (Dev Assistant), localhost-only banner.
3. Controls: Start / Stop button; mute; session timer.
4. Main layout: three-pane CSS grid — captions (left, ~40%), preview pane (right, ~60%), cost panel (bottom, fixed height).
5. Start button: constructs `VoiceSession` with `DEV_PERSONA` and event callbacks wired to React state. Catches errors and shows inline messages.
6. On `onEnd`: show "Session ended — cost $X. Transcript saved to [path]." with a "Start new session" button.

Keep CSS Tailwind-only, no custom stylesheet.

- [ ] **Step 19.2: Manually smoke-test.**

Start services per `CLAUDE.md`. Open `http://localhost:3100/voice` in Chrome (Gemini Live requires a Chromium-based browser for Web Audio + Worklets). Click Start. Verify: mic permission, banner visible, stop works, session-end writes a row and a file.

- [ ] **Step 19.3: Commit.**

```bash
git add dashboard/src/app/voice/page.tsx
git commit -m "feat(voice): /voice page wiring"
```

---

## Phase D — Integration

### Task 20: End-to-end test via fake Gemini server

**Files:**
- Create: `dashboard/src/app/voice/__tests__/e2e.test.ts`

Drives `VoiceSession` against the fake server + hits the real backend API routes via Next.js request helpers. Confirms: session-close is called, DB row written, transcript file created, tool calls round-trip.

- [ ] **Step 20.1: Write the e2e test.**

Integrate the fake server with spies on `fetch` routed to real route handlers. Cleanup after.

- [ ] **Step 20.2: Run.**

Run: `npm test -- dashboard/src/app/voice/__tests__/e2e.test.ts`
Expected: PASS.

- [ ] **Step 20.3: Commit.**

```bash
git add dashboard/src/app/voice/__tests__/e2e.test.ts
git commit -m "test(voice): end-to-end against fake Gemini server"
```

### Task 21: Dashboard nav (dev-only)

**Files:**
- Modify: `dashboard/src/app/layout.tsx` (or wherever the nav lives)

- [ ] **Step 21.1: Add conditional link.**

`{process.env.NODE_ENV === 'development' && <Link href="/voice">Voice</Link>}`

- [ ] **Step 21.2: Commit.**

```bash
git add dashboard/src/app/layout.tsx
git commit -m "feat(voice): add /voice nav link (dev-only)"
```

### Task 22: Dogfood checklist + CLAUDE.md update

**Files:**
- Create: `docs/superpowers/brainstorm-sessions/.gitkeep`
- Create: `docs/superpowers/mockups/.gitkeep`
- Create: `docs/superpowers/research/.gitkeep`
- Create: `docs/voice-dogfood-checklist.md`
- Modify: `CLAUDE.md` (add `/voice` row to the dashboard section)

- [ ] **Step 22.1: Create gitkeep files.**

- [ ] **Step 22.2: Verify RAG indexer does NOT watch `docs/superpowers/`.**

Run:
```bash
grep -n "superpowers\|brainstorm-sessions" src/rag/indexer.ts
```

Expected: no matches. The indexer's watch roots should be vault-only (likely `VAULT_DIR` from env). If `docs/superpowers/` is in the watch scope, STOP — the spec's privacy guarantee is violated and the plan must add an exclusion before shipping. Report the finding to the coordinator rather than silently editing `src/rag/indexer.ts` (that module is outside this plan's write scope).

Document the verification in the commit message for Step 22.5.

- [ ] **Step 22.3: Write `docs/voice-dogfood-checklist.md`.**

A concise manual-test list — mirror the spec's "Manual dogfood checklist" bullets.

- [ ] **Step 22.4: Update `CLAUDE.md`.**

In the universityClaw Extensions section, add:
- A row in the Subsystems table: `Live Voice (/voice) | dashboard/src/app/voice/ | Gemini Live brainstorm partner`
- A row in the Key Paths section pointing to the new dirs under `docs/superpowers/`
- A row in the Services table for the voice feature if that pattern fits; otherwise a dedicated short section is fine.

- [ ] **Step 22.5: Commit.**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(voice): dogfood checklist + CLAUDE.md entry + RAG-scope verification"
```

### Task 23: Final verification + open PR

- [ ] **Step 23.1: Run all tests.**

Run from repo root: `npm test`
Expected: all green (including pre-existing tests).

- [ ] **Step 23.2: TypeScript + lint.**

```bash
npm run typecheck && npm run lint
cd dashboard && npx tsc --noEmit && cd ..
```

Expected: no new errors. (Pre-existing ones unrelated to voice can be noted.)

- [ ] **Step 23.3: Manual smoke test.**

Full manual pass per `docs/voice-dogfood-checklist.md`. Capture any issues as GitHub issues or follow-up tasks; do NOT fix scope-creep items in this PR.

- [ ] **Step 23.4: Push + PR.**

```bash
git push -u origin feat/live-voice-chat
gh pr create --title "Live Voice Chat v1 — Dev Assistant (/voice)" --body "<summary of what's in the spec + link to it>"
```

Target base: `main`. Repo: `SimonKvalheim/universityClaw` (never upstream).

---

## Self-Review (coordinator, before dispatch)

- [ ] Every spec section has at least one task implementing it.
- [ ] No placeholders remain (grep the plan for "TBD", "TODO", "fill in").
- [ ] Function/method names are consistent across tasks.
- [ ] Every write tool has a corresponding test case.
- [ ] `voice_sessions` column names match between Task 3 SQL, Drizzle schemas, Task 10 insert, and Task 18 SELECT.
- [ ] camelCase vs snake_case: request/response JSON is camelCase; DB columns are snake_case; Drizzle TS properties are camelCase with explicit column name in `text('snake_case')`.

---

## Subagent Dispatch Guidance (coordinator-only)

If using superpowers:subagent-driven-development, for each task include in the subagent prompt:

1. The exact content of the task (from above), verbatim.
2. The "Conventions" section, verbatim.
3. The relevant code snippet(s) from the surrounding context the subagent would otherwise grep for — NEVER trust the subagent to find them. Specifically:
   - For Task 3: the canonical schema SQL column list (as shown in the task).
   - For Task 10 / 18: the `voice_sessions` column list and sample SQL inline.
   - For Tasks 6, 7, 10, 18: the loopback-gate pattern (copy from Task 6 implementation).
   - For Tasks 8, 9: the `resolveReadPath`/`resolveWritePath` signatures from Task 5.
   - For Task 15: a copy of the `VoiceSessionEvents` interface.
4. Explicit file scope: the `Files` section of the task, and an instruction: "Do NOT modify any files outside the listed set without pausing to ask the coordinator."
5. Explicit "what not to skip": tests before implementation; run the failing test and paste the output before writing any implementation code; commit at each step boundary; do not invent DB column names — use the ones inlined in this prompt.

End of plan.
