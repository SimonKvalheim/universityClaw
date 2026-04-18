# S0: Drizzle ORM Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the entire data layer from raw SQL (better-sqlite3 with hand-written queries) to Drizzle ORM. All 12 existing tables, ~45 query functions, dashboard DB access, and test infrastructure converted. Baseline migration generated and committed. Zero raw SQL remains.

**Architecture:** Drizzle wraps the existing better-sqlite3 connection (synchronous, zero overhead). Schema files in `src/db/schema/` define tables in TypeScript — the single source of truth for types and DDL. `drizzle-kit generate` produces SQL migration files committed to git. All query functions rewritten with Drizzle's query builder, maintaining identical function signatures so callers don't change. Dashboard gets its own Drizzle instance pointing to the same SQLite file.

**Tech Stack:** drizzle-orm + drizzle-kit (new), better-sqlite3 (existing), SQLite, Vitest

**Master plan:** `docs/superpowers/plans/2026-04-13-study-system-master-plan.md` § 1.7 + Sprint S0

**Essential reading before implementing:**
- `src/db.ts` — the entire file. This is what you're replacing. Understand every function, every table, every ALTER TABLE migration.
- `src/types.ts` — `NewMessage`, `ScheduledTask`, `TaskRunLog`, `RegisteredGroup` interfaces. Your Drizzle schemas must produce compatible types.
- `src/shared/db-reader.ts` — middleman module that wraps `src/db.ts` functions. It uses no raw SQL itself.
- `dashboard/src/lib/ingestion-db.ts` — dashboard's independent DB access with its own raw SQL. This needs a full Drizzle rewrite.
- `src/db.test.ts` — the main DB test file. Understand what behavior is being verified.
- `src/db-migration.test.ts` — tests the migration from legacy schemas. Needs rewriting for Drizzle.

---

## Why Drizzle, and Why Now

The current `src/db.ts` is 1100 lines of hand-written SQL with 16 try-catch ALTER TABLE migrations for columns added after initial release. Every new table or column means more raw SQL strings with no type checking and another try-catch migration block. The study system (S1+) adds 7+ new tables — doing that with raw SQL would be unmaintainable.

Drizzle gives us:
- **Schema-as-code** — TypeScript table definitions are the single source of truth. Types and DDL come from the same place.
- **Generated migrations** — `drizzle-kit generate` diffs your schema against the last migration and produces SQL. No hand-written ALTER TABLE.
- **Type-safe queries** — the query builder catches column name typos, wrong types, missing required fields at compile time.
- **Zero overhead** — Drizzle's better-sqlite3 driver is a thin wrapper. Same synchronous API, same performance.

The migration happens now (S0) because everything in S1–S8 depends on it. If we build study tables on raw SQL, we'd have to migrate them later anyway.

---

## Key Decisions

Read these before writing any code. They explain WHY the implementation looks the way it does.

### 1. Snake_case property names in Drizzle schemas

The existing TypeScript types (`NewMessage`, `ScheduledTask`, `ChatInfo`) use snake_case: `chat_jid`, `is_from_me`, `last_message_time`. If we used camelCase in Drizzle schemas, every function would need mapping code to convert between Drizzle's return types and the existing interfaces.

**Decision:** S0 schemas use snake_case property names matching the DB column names. This means `typeof chats.$inferSelect` produces types compatible with existing interfaces — no mapping code, no caller changes.

**Tradeoff:** Not idiomatic TypeScript. S1+ study tables can use camelCase since they're new code with no backwards compatibility concern.

### 2. Idempotent baseline migration

Drizzle's migration runner (`migrate()`) tracks applied migrations in a `__drizzle_migrations` table. On an existing database that predates Drizzle, this table doesn't exist, so Drizzle tries to run the baseline migration — which would `CREATE TABLE` for tables that already exist, and fail.

**Decision:** After generating the baseline migration with `drizzle-kit generate`, manually edit the SQL to add `IF NOT EXISTS` to all `CREATE TABLE` and `CREATE INDEX` statements. This makes it safe everywhere:
- Fresh database: tables don't exist → creates them
- Existing database: tables already exist → no-op, Drizzle records it as applied

**Why not runtime detection?** We considered checking for pre-existing tables and marking the baseline as applied in `__drizzle_migrations`. That requires reading Drizzle's journal format and computing hashes. The idempotent approach is simpler, has no edge cases, and the edit is a one-time committed change.

### 3. Barrel re-export strategy

25 files import from `src/db.ts` (11 production + 14 test). Changing all import paths at once is risky. Instead:

- Build `src/db/index.ts` with all migrated functions
- Convert `src/db.ts` to a thin barrel: `export { ... } from './db/index.js'`
- All existing `from './db.js'` imports continue to work unchanged
- Optionally update import paths later (low priority, no behavior change)

This means the switch-over is atomic: one file change (`src/db.ts` → barrel), full test suite verifies everything.

### 4. Dashboard schema duplication

The dashboard runs as a separate Next.js process. Its existing code (`dashboard/src/lib/ingestion-db.ts`) has a comment: "Next.js/Turbopack cannot bundle TypeScript source from outside the project root." The dashboard can't `import from '../../src/db/schema/'`.

**Decision:** Dashboard gets `dashboard/src/lib/db/schema.ts` with Drizzle definitions for just the 2 tables it uses (ingestion_jobs, settings). These must match the main schemas exactly. The dashboard creates its own Drizzle instance pointing to the same `store/messages.db`.

**Why not a shared package?** Overkill for a single-developer project with 2 shared tables. If the dashboard needs more tables later, consider a workspace package then.

### 5. No `integer({ mode: 'boolean' })` in S0

Drizzle can auto-convert 0/1 integers to booleans with `{ mode: 'boolean' }`. But the existing code does manual conversion everywhere:
```typescript
requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
```

If we use `mode: 'boolean'`, Drizzle returns `true/false/null` instead of `0/1/null`. That `=== 1` check would silently break (it'd compare `true === 1` which is `false` in strict equality).

**Decision:** Plain `integer()` for all boolean-like columns. Conversion logic stays in functions unchanged. Switch to `mode: 'boolean'` when types are updated (S1+ or later cleanup).

### 6. Use `sql` template only when the builder can't express it

Drizzle's `sql` tagged template is an escape hatch for SQL that the query builder can't represent. It should be used for:
- `MAX()`, `COALESCE()` in ON CONFLICT SET clauses
- `excluded.column_name` references in upserts
- `datetime('now')` (SQLite function) in defaults and updates

It should NOT be used for comparisons, conditions, or logic that Drizzle has operators for (`eq`, `gt`, `lte`, `ne`, `like`, `and`, `or`, `inArray`, etc.). If you find yourself writing `sql`column <= value``, use `lte(column, value)` instead.

---

## File Structure

### New files

```
drizzle.config.ts                    — Drizzle Kit configuration
src/db/
  schema/
    chats.ts                         — chats, messages tables
    tasks.ts                         — scheduled_tasks, task_run_logs tables
    ingestion.ts                     — ingestion_jobs table
    rag.ts                           — rag_index_tracker table
    groups.ts                        — registered_groups, sessions tables
    state.ts                         — router_state, settings, zotero_sync tables
    citations.ts                     — citation_edges table
    index.ts                         — re-exports all schema tables
  index.ts                           — Drizzle instance, init, all query functions
  migrate.ts                         — Migration runner
drizzle/
  migrations/                        — Generated SQL (committed to git)
dashboard/src/lib/db/
  schema.ts                          — Dashboard-side schema (ingestion_jobs, settings only)
  index.ts                           — Dashboard Drizzle instance
```

### Modified files

```
src/db.ts                            — Converted to re-export barrel for ./db/index.js
dashboard/src/lib/ingestion-db.ts    — Raw SQL → Drizzle queries
src/db-migration.test.ts             — Rewritten for Drizzle migration path
src/ingestion/db-ingestion.test.ts   — getDb().prepare() → getDb().all(sql`...`)
package.json                         — drizzle-orm (dep), drizzle-kit (devDep)
dashboard/package.json               — drizzle-orm (dep)
```

### Unchanged files (25 total — verified by existing tests)

All consumer files — import paths unchanged because `src/db.ts` barrel re-exports everything:

**Production (11):** `src/index.ts`, `src/ipc.ts`, `src/task-scheduler.ts`, `src/channels/web.ts`, `src/shared/db-reader.ts`, `src/rag/indexer.ts`, `src/ingestion/{pipeline,index,citation-linker,job-recovery,zotero-watcher}.ts`

**Tests (14):** 12 files using `_initTestDatabase()` (function signature preserved), `src/ingestion/zotero-watcher.test.ts` (vi.mock), `src/db-migration.test.ts` (rewritten in Task 8)

---

## Task 1: Dependencies, Backup, and Config

**Files:** `package.json`, `dashboard/package.json`, `drizzle.config.ts` (new)

- [ ] **Step 1:** Backup the database: `cp store/messages.db store/messages.db.pre-drizzle-backup`
- [ ] **Step 2:** Install: `npm install drizzle-orm && npm install -D drizzle-kit && cd dashboard && npm install drizzle-orm`
- [ ] **Step 3:** Create `drizzle.config.ts` at project root:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/*',
  out: './drizzle/migrations',
  dbCredentials: {
    url: './store/messages.db',
  },
});
```

The `dbCredentials.url` is only used by `drizzle-kit studio` (dev tooling) — the app resolves the path from `STORE_DIR` at runtime.

- [ ] **Step 4:** Verify: `npx tsc --noEmit` passes
- [ ] **Step 5:** Commit

---

## Task 2: Schema Definitions

**Files:** All files in `src/db/schema/`

Define every existing table as a Drizzle schema. The source of truth is `src/db.ts:17-263` — the `createSchema()` function plus all the ALTER TABLE try-catch blocks below it. Every column, constraint, default, and index must match exactly.

**Important context:** The current schema evolved through 16 ALTER TABLE migrations wrapped in try-catch (lines 112-263). The Drizzle schemas must represent the FINAL state — all columns present, no migration logic. The Drizzle baseline migration replaces all that incremental ALTER TABLE code.

### How to define each schema file

Use `sqliteTable` from `drizzle-orm/sqlite-core`. Key patterns:

- **Column naming:** Property name = DB column name (snake_case). Write `jid: text('jid')` — the string argument is the SQL column name.
- **Primary keys:** Single-column: `.primaryKey()` on the column. Composite: `primaryKey({ columns: [table.col1, table.col2] })` in the third argument.
- **NOT NULL:** Add `.notNull()`. Check the original CREATE TABLE — only columns explicitly marked NOT NULL or part of a PRIMARY KEY get this.
- **Defaults:** `.default(0)` for literals, `.default(sql`(datetime('now'))`)` for SQL expressions. The parentheses matter for SQLite expression defaults.
- **Foreign keys:** `.references(() => otherTable.column)` — works for same-file references (messages → chats, taskRunLogs → scheduledTasks).
- **Indexes:** In the third argument: `index('idx_name').on(table.column)`. Multi-column: `.on(table.col1, table.col2)`. Use the exact index names from the current schema.
- **UNIQUE:** `.unique()` on the column (e.g., `registered_groups.folder`).
- **AUTOINCREMENT:** `integer('id').primaryKey({ autoIncrement: true })` (only `task_run_logs.id`).

### Schema file inventory

Create these files based on the table groupings. Read `src/db.ts:17-263` to get exact columns.

| File | Tables | Notable details |
|------|--------|-----------------|
| `chats.ts` | `chats`, `messages` | messages has composite PK `(id, chat_jid)`, FK to chats.jid, index on timestamp |
| `tasks.ts` | `scheduled_tasks`, `task_run_logs` | task_run_logs has AUTOINCREMENT, FK to scheduled_tasks.id, composite index on `(task_id, run_at)` |
| `ingestion.ts` | `ingestion_jobs` | 16 columns (most added via ALTER TABLE), 3 indexes, `datetime('now')` defaults |
| `rag.ts` | `rag_index_tracker` | All columns NOT NULL, index on doc_id |
| `groups.ts` | `registered_groups`, `sessions` | folder is UNIQUE, defaults on requires_trigger and is_main |
| `state.ts` | `router_state`, `settings`, `zotero_sync` | settings has `datetime('now')` default on updated_at |
| `citations.ts` | `citation_edges` | Composite PK `(source_slug, target_slug)`, index on target_slug |
| `index.ts` | — | Re-exports all tables from the other files |

- [ ] **Step 1:** Create all 8 schema files based on `src/db.ts:17-263`
- [ ] **Step 2:** Verify: `npx tsc --noEmit` passes
- [ ] **Step 3:** Commit

---

## Task 3: Generate Baseline Migration

**Files:** `drizzle/migrations/` (generated)

- [ ] **Step 1:** Run `npx drizzle-kit generate` — produces SQL and `meta/_journal.json` in `drizzle/migrations/`
- [ ] **Step 2:** Make the baseline idempotent — edit the generated SQL:
  - `CREATE TABLE ` → `CREATE TABLE IF NOT EXISTS `
  - `CREATE INDEX ` → `CREATE INDEX IF NOT EXISTS `
  - `CREATE UNIQUE INDEX ` → `CREATE UNIQUE INDEX IF NOT EXISTS `

  (See Key Decision #2 for why.)

- [ ] **Step 3:** Verify the generated SQL matches the current schema. Spot-check:
  - `messages` has composite PK and FK to chats
  - `task_run_logs` has AUTOINCREMENT and FK to scheduled_tasks
  - `ingestion_jobs` has all 16 columns with correct defaults
  - `registered_groups.folder` has UNIQUE
  - All index names and columns match `src/db.ts`
- [ ] **Step 4:** Commit

---

## Task 4: Drizzle Instance and Migration Runner

**Files:** `src/db/migrate.ts` (new), `src/db/index.ts` (new — initial version)

### Migration runner (`src/db/migrate.ts`)

A simple function that calls Drizzle's `migrate()` with the path to the migrations folder. Uses `import.meta.url` to resolve the path relative to the module (works in ESM). The function takes a `BetterSQLite3Database` — the Drizzle instance.

### Initial `src/db/index.ts`

This file will eventually contain all ~45 query functions. Start with just the infrastructure:

- Module-level variables: `db` (Drizzle instance, type `BetterSQLite3Database`) and `rawSqlite` (the underlying better-sqlite3 connection, needed for `_closeDatabase` and pragmas)
- `initDatabase()` — creates better-sqlite3 connection, sets WAL mode + FK pragma, wraps with `drizzle()`, calls `runMigrations()`, calls `migrateJsonState()`
- `_initTestDatabase()` — creates in-memory better-sqlite3, wraps with Drizzle, runs migrations. Same name and signature as the current version — all 12 test files call this in `beforeEach`.
- `_closeDatabase()` — closes the underlying better-sqlite3 connection
- `getDb()` — returns the Drizzle instance (type changes from `Database.Database` to `BetterSQLite3Database` — see Gotcha #1)
- `migrateJsonState()` — copy from current `src/db.ts:1038-1096`. It calls `setRouterState`, `setSession`, `setRegisteredGroup` which are Drizzle functions you'll add in Task 6. The file won't compile until those functions exist.
- Import `* as schema from './schema/index.js'` — all schema tables available as `schema.chats`, `schema.messages`, etc.

**Note on `_initTestDatabase`:** The current version calls `createSchema(db)` (raw DDL). The new version calls `runMigrations(db)` (Drizzle migrations). The migrations create the same tables. This is the mechanism that makes all 12 existing test files work unchanged — they call `_initTestDatabase()` in beforeEach and get a fresh in-memory DB with correct schema.

- [ ] **Step 1:** Create `src/db/migrate.ts`
- [ ] **Step 2:** Create `src/db/index.ts` with infrastructure functions (no query functions yet)
- [ ] **Step 3:** Commit

---

## Task 5: Migrate All Query Functions

**Files:** `src/db/index.ts`

This is the bulk of the work. You're converting ~45 functions from raw SQL (`.prepare().run()`, `.prepare().get()`, `.prepare().all()`) to Drizzle's query builder. The function signatures, parameter types, and return types must not change — callers don't know the implementation switched.

### Conversion patterns

Read `src/db.ts` thoroughly. Every function follows one of these patterns:

#### Pattern A: Simple SELECT

```typescript
// OLD: db.prepare('SELECT * FROM x WHERE id = ?').get(id) as T | undefined
// NEW: db.select().from(schema.x).where(eq(schema.x.id, id)).get() as T | undefined

// OLD: db.prepare('SELECT * FROM x ORDER BY y DESC').all() as T[]
// NEW: db.select().from(schema.x).orderBy(desc(schema.x.y)).all() as T[]
```

The `as T` casts match what the old code does. Drizzle's return types are nullable (`string | null`) while existing interfaces use non-null (`string`). The cast bridges this — same pattern as before.

For column subsets, use named selections:
```typescript
db.select({ id: schema.x.id, status: schema.x.status }).from(schema.x).where(...)
```

#### Pattern B: INSERT

```typescript
// OLD: db.prepare('INSERT INTO x (a, b) VALUES (?, ?)').run(a, b)
// NEW: db.insert(schema.x).values({ a, b }).run()
```

#### Pattern C: Upsert (INSERT OR REPLACE / ON CONFLICT)

Most "INSERT OR REPLACE" calls become `onConflictDoUpdate` which is actually safer (no cascading deletes, no row recreation):

```typescript
// Simple upsert — replace a value
db.insert(schema.routerState)
  .values({ key, value })
  .onConflictDoUpdate({ target: schema.routerState.key, set: { value } })
  .run();

// INSERT OR IGNORE
db.insert(schema.citationEdges)
  .values({ source_slug, target_slug, created_at })
  .onConflictDoNothing()
  .run();
```

**Tricky case — `storeChatMetadata`:** Uses `MAX()` and `COALESCE()` in the ON CONFLICT SET clause. These require `sql` template because the query builder can't express SQL functions in upsert sets. The `excluded.column_name` syntax refers to the proposed (conflicting) row's values — this is raw SQLite, written as a string inside `sql`:

```typescript
.onConflictDoUpdate({
  target: schema.chats.jid,
  set: {
    name: sql`excluded.name`,
    last_message_time: sql`MAX(${schema.chats.last_message_time}, excluded.last_message_time)`,
    channel: sql`COALESCE(excluded.channel, ${schema.chats.channel})`,
  },
})
```

In `sql` templates: `${schema.chats.column}` resolves to the current row's column reference. Plain text like `excluded.name` stays as raw SQL.

**The `storeChatMetadata` function has two code paths** (with name vs. without name) that produce different SET clauses. Read the original carefully and preserve both paths.

#### Pattern D: UPDATE with dynamic fields

`updateTask` and `updateIngestionJob` build SET clauses dynamically from a partial updates object. In Drizzle, build a plain object and pass it to `.set()`:

```typescript
const set: Record<string, unknown> = {};
if (updates.status !== undefined) set.status = updates.status;
if (updates.error !== undefined) set.error = updates.error;
// ... etc
db.update(schema.x).set(set).where(eq(schema.x.id, id)).run();
```

For `updateIngestionJob`, always include `updated_at: sql`datetime('now')`` in the set. When `status === 'completed'`, also set `completed_at: sql`datetime('now')`` — this mirrors the original logic.

#### Pattern E: Conditional status in UPDATE

`updateTaskAfterRun` sets status to 'completed' only when `nextRun` is null. Don't use a SQL CASE expression — express this in TypeScript:

```typescript
const set: Record<string, unknown> = {
  next_run: nextRun,
  last_run: now,
  last_result: lastResult,
};
if (nextRun === null) {
  set.status = 'completed';
}
db.update(schema.scheduledTasks).set(set).where(eq(schema.scheduledTasks.id, id)).run();
```

Drizzle only updates columns present in the `set` object — omitted columns are left unchanged. This is cleaner than a CASE expression.

#### Pattern F: DELETE

```typescript
// OLD: db.prepare('DELETE FROM x WHERE id = ?').run(id)
// NEW: db.delete(schema.x).where(eq(schema.x.id, id)).run()
```

Note: `deleteTask` must delete from `task_run_logs` first (FK constraint), then from `scheduled_tasks`. Same order as the original.

#### Pattern G: Message queries with reverse

`getNewMessages` and `getMessagesSince` use a subquery pattern: get the N most recent messages (ORDER BY DESC LIMIT N), then return them in chronological order. Replace the subquery with `.reverse()`:

```typescript
db.select({ /* specific columns — NOT is_bot_message */ })
  .from(schema.messages)
  .where(and(
    gt(schema.messages.timestamp, sinceTimestamp),
    eq(schema.messages.is_bot_message, 0),
    not(like(schema.messages.content, `${botPrefix}:%`)),
    ne(schema.messages.content, ''),
    isNotNull(schema.messages.content),
    // For getNewMessages: inArray(schema.messages.chat_jid, jids)
    // For getMessagesSince: eq(schema.messages.chat_jid, chatJid)
  ))
  .orderBy(desc(schema.messages.timestamp))
  .limit(limit)
  .all()
  .reverse()
```

The `.reverse()` produces identical results to the original subquery — it's O(n) on an already-small array.

### Drizzle operators to import

```typescript
import { eq, and, gt, lte, ne, like, not, isNotNull, inArray, desc, sql } from 'drizzle-orm';
```

Use these instead of `sql` template for all comparisons and conditions.

### Function inventory

Every function listed here must be migrated. Check them off as you go. Read the original implementation in `src/db.ts` for each one.

**Chat & messages** (8 functions + ChatInfo interface):
- [ ] `storeChatMetadata` — Pattern C (complex upsert with MAX/COALESCE, two code paths)
- [ ] `updateChatName` — Pattern C (simple upsert)
- [ ] `getAllChats` — Pattern A
- [ ] `getLastGroupSync` — Pattern A (special `__group_sync__` sentinel JID)
- [ ] `setLastGroupSync` — Pattern C (upsert sentinel)
- [ ] `storeMessage` — Pattern C (upsert on composite PK `[messages.id, messages.chat_jid]`)
- [ ] `storeMessageDirect` — delegate to `storeMessage` (same logic, keep wrapper for API compat)
- [ ] `getNewMessages` — Pattern G (reverse) + dynamic IN clause via `inArray`
- [ ] `getMessagesSince` — Pattern G (reverse)

**Tasks** (9 functions):
- [ ] `createTask` — Pattern B
- [ ] `getTaskById` — Pattern A
- [ ] `getTasksForGroup` — Pattern A
- [ ] `getAllTasks` — Pattern A
- [ ] `updateTask` — Pattern D (dynamic update)
- [ ] `deleteTask` — Pattern F (two deletes, order matters for FK)
- [ ] `getDueTasks` — Pattern A (use `lte()` for the `<= now` comparison, NOT `sql`)
- [ ] `updateTaskAfterRun` — Pattern E (conditional status)
- [ ] `logTaskRun` — Pattern B

**Router state & sessions** (5 functions):
- [ ] `getRouterState` — Pattern A
- [ ] `setRouterState` — Pattern C (simple upsert)
- [ ] `getSession` — Pattern A
- [ ] `setSession` — Pattern C (simple upsert)
- [ ] `getAllSessions` — Pattern A (build Record from rows)

**Registered groups** (3 functions):
- [ ] `getRegisteredGroup` — Pattern A + post-processing (JSON.parse container_config, boolean conversion, folder validation). Read `src/db.ts:686-724` carefully — the mapping logic is non-trivial.
- [ ] `setRegisteredGroup` — Pattern C (upsert with all columns in SET, JSON.stringify container_config, folder validation)
- [ ] `getAllRegisteredGroups` — Pattern A + same mapping as getRegisteredGroup, with folder validation logging

**Ingestion** (11 functions):
- [ ] `getIngestionJobByPath` — Pattern A (ORDER BY + LIMIT 1)
- [ ] `getCompletedJobByHash` — Pattern A
- [ ] `getIngestionJobByZoteroKey` — Pattern A (NOT IN via `not(inArray(..., ['dismissed', 'failed']))`)
- [ ] `deleteIngestionJob` — Pattern F
- [ ] `createIngestionJob` — Pattern B
- [ ] `getIngestionJobById` — Pattern A (returns `unknown`)
- [ ] `getIngestionJobs` — Pattern A (optional status filter)
- [ ] `getJobsByStatus` — Pattern A
- [ ] `updateIngestionJob` — Pattern D (dynamic update with `datetime('now')` side effects)
- [ ] `getRecentlyCompletedJobs` — Pattern A

**Settings** (2 functions):
- [ ] `getSetting` — Pattern A (returns default if not found)
- [ ] `setSetting` — Pattern C (upsert with `datetime('now')` in updated_at)

**RAG tracker** (3 functions + TrackedDoc interface):
- [ ] `getTrackedDoc` — Pattern A (return null, not undefined, for miss)
- [ ] `upsertTrackedDoc` — Pattern C (upsert with all columns)
- [ ] `deleteTrackedDoc` — Pattern F

**Citations** (4 functions):
- [ ] `insertCitationEdge` — Pattern C (`onConflictDoNothing` for INSERT OR IGNORE)
- [ ] `deleteCitationEdges` — Pattern F
- [ ] `getCites` — Pattern A (map rows to string array)
- [ ] `getCitedBy` — Pattern A (map rows to string array)

**Zotero** (2 functions):
- [ ] `getZoteroSyncVersion` — Pattern A (parseInt on value)
- [ ] `setZoteroSyncVersion` — Pattern C (upsert, String(version))

- [ ] **Step 1:** Migrate functions group by group, verifying `npx tsc --noEmit` after each group
- [ ] **Step 2:** Ensure `migrateJsonState()` (from Task 4) compiles — it references `setRouterState`, `setSession`, `setRegisteredGroup`
- [ ] **Step 3:** Commit after each group or when the file compiles cleanly

---

## Task 6: Switch Over — Convert `src/db.ts` to Barrel

**Files:** `src/db.ts`, `src/ingestion/db-ingestion.test.ts`

This is the moment of truth. All ~45 functions exist in `src/db/index.ts`. Now swap the old implementation for a barrel re-export.

- [ ] **Step 1:** Replace the entire contents of `src/db.ts` with re-exports from `./db/index.js`. Export every function, interface, and type that was previously exported. The barrel must be complete — any missing export breaks a consumer.

  Cross-reference: grep for every `import { ... } from './db.js'` and `import { ... } from '../db.js'` in the codebase. Every imported symbol must be in the barrel.

- [ ] **Step 2:** Fix `src/ingestion/db-ingestion.test.ts` — one test calls `getDb().prepare()` which is raw better-sqlite3 API. `getDb()` now returns a Drizzle instance. Change it to use Drizzle's `sql` template:

  ```typescript
  import { sql } from 'drizzle-orm';
  // ...
  it('does not have a review_items table', () => {
      const db = getDb();
      expect(() => {
        db.all(sql`SELECT * FROM review_items`);
      }).toThrow();
  });
  ```

- [ ] **Step 3:** Run `npm run build` — must succeed
- [ ] **Step 4:** Run `npm test` — all 665 tests must pass

  If tests fail, common causes:
  - Missing export in the barrel (symbol not found)
  - Drizzle returning `null` where old code returned `undefined` (check function return types)
  - Column name mismatch in a select (Drizzle uses schema property names)
  - `sql` template syntax error in an ON CONFLICT clause
  - Boolean-like integer handling (0/1 comparisons)

- [ ] **Step 5:** Commit

---

## Task 7: Migrate Dashboard DB Access

**Files:** `dashboard/src/lib/db/schema.ts` (new), `dashboard/src/lib/db/index.ts` (new), `dashboard/src/lib/ingestion-db.ts`

The dashboard currently has its own raw SQL in `dashboard/src/lib/ingestion-db.ts` — a completely separate DB access layer that opens its own better-sqlite3 connection to `store/messages.db`. This needs the same Drizzle treatment.

### Dashboard schema (`dashboard/src/lib/db/schema.ts`)

Define Drizzle schemas for ONLY the 2 tables the dashboard uses: `ingestion_jobs` and `settings`. These must be identical to the main schemas in `src/db/schema/ingestion.ts` and `src/db/schema/state.ts`. Copy the table definitions — same columns, same types, same defaults.

### Dashboard Drizzle instance (`dashboard/src/lib/db/index.ts`)

Same pattern as the current `dashboard/src/lib/ingestion-db.ts` connection setup: read `STORE_DIR` env var (fallback to `../store`), create better-sqlite3 connection, set WAL + FK + busy_timeout pragmas, wrap with `drizzle()`. Lazy singleton pattern (create on first `getDb()` call).

### Rewrite `dashboard/src/lib/ingestion-db.ts`

Replace all raw SQL with Drizzle queries. The dashboard has 7 functions:

- [ ] `getRecentJobs` — select from ingestion_jobs with optional status filter, limit 100
- [ ] `getJobDetail` — select by id, parse `promoted_paths` JSON
- [ ] `getJobSourcePath` — select source_path by id
- [ ] `retryJob` — select + validate status + update (reset to appropriate stage)
- [ ] `dismissJob` — select + validate status + update to 'dismissed'
- [ ] `getSettings` — select from settings, parseInt + clamp
- [ ] `updateSettings` — upsert into settings

The `rowToSummary` helper maps snake_case DB columns to camelCase `JobSummary` — this stays, but reads from Drizzle result objects instead of raw `DbRow`.

- [ ] **Step 1:** Create dashboard schema and Drizzle instance
- [ ] **Step 2:** Rewrite `ingestion-db.ts` functions to use Drizzle
- [ ] **Step 3:** Run `cd dashboard && npm run build`
- [ ] **Step 4:** Run `cd dashboard && npm test` (if tests exist)
- [ ] **Step 5:** Commit

---

## Task 8: Update `src/db-migration.test.ts`

**Files:** `src/db-migration.test.ts`

The existing test creates a legacy database (only the `chats` table, pre-migration) and verifies that `initDatabase()` upgrades it. With Drizzle, the baseline migration creates all tables with all columns — there are no ALTER TABLE upgrades. The test should verify:

1. **Fresh database:** Running `initDatabase()` on an empty DB produces correct schema (all tables exist)
2. **Existing database:** Running `initDatabase()` on a DB that already has tables preserves existing data (idempotent baseline)

For test #2: create a "pre-Drizzle" database with a `chats` table and data, then call `initDatabase()` and verify the data survives.

Both tests use the dynamic import pattern (create temp dir, chdir, `vi.resetModules()`, `await import('./db.js')`) — same pattern as the current test.

- [ ] **Step 1:** Rewrite both test cases
- [ ] **Step 2:** Run `npx vitest run src/db-migration.test.ts`
- [ ] **Step 3:** Commit

---

## Task 9: Final Verification and Cleanup

- [ ] **Step 1:** Verify zero raw SQL remains:
  ```bash
  grep -rn '\.prepare(' src/ --include='*.ts' | grep -v node_modules | grep -v '.test.ts'
  grep -rn '\.prepare(' dashboard/src/ --include='*.ts' | grep -v node_modules
  ```
  Expected: No results.

- [ ] **Step 2:** Run full test suite: `npm test` — all 665 tests pass
- [ ] **Step 3:** Run build: `npm run build`
- [ ] **Step 4:** Dashboard build: `cd dashboard && npm run build`
- [ ] **Step 5:** Verify Drizzle Kit studio: `npx drizzle-kit studio` — opens browser showing all 12 tables
- [ ] **Step 6:** Test on existing database:
  ```bash
  cp store/messages.db.pre-drizzle-backup store/messages.db
  npm run dev  # Verify startup succeeds, Ctrl+C after confirming
  ```
- [ ] **Step 7:** Commit any remaining cleanup

---

## Acceptance Criteria

From the master plan — all must be true before S0 is complete:

- [ ] Zero raw SQL remaining in `src/db.ts`, `src/db/index.ts`, or dashboard DB files
- [ ] `drizzle/migrations/` contains baseline migration committed to git
- [ ] All 665+ existing tests pass with Drizzle (`npm test`)
- [ ] `npm run build` succeeds
- [ ] Dashboard `npm run build` succeeds
- [ ] New install (empty DB) runs migrations and produces correct schema
- [ ] Existing install (populated DB) runs migrations without data loss
- [ ] `npx drizzle-kit studio` can browse the database

---

## Note on S0.9 (Startup Sequence)

The master plan S0.9 says to "replace `initDatabase()` call with Drizzle migration runner." Because this plan preserves `initDatabase()` as the entry point (re-exported through the barrel) with Drizzle internals, the startup call in `src/index.ts` requires **no change**. The same `initDatabase()` call works — it now creates a Drizzle instance and calls `runMigrations()` internally.

---

## Parallelization

Per master plan § Parallelization:

| Session A (backend) | Session B (dashboard) |
|---------------------|-----------------------|
| Tasks 1–6, 8–9 | Task 7 (after Task 2 — needs schema defs) |

Task 7 (dashboard) is independent of the backend function migration and can run in parallel once schema files exist.

---

## Notes for S1

After S0 is complete, S1 adds study system tables:

1. Create `src/db/schema/study.ts` with new table definitions (camelCase property names OK for new tables)
2. Run `npx drizzle-kit generate` → produces a new migration in `drizzle/migrations/`
3. The migration runner picks it up automatically on next startup
4. Study query functions go in `src/study/` modules (not `src/db/index.ts`)
5. Types derived from Drizzle schema: `typeof concepts.$inferSelect`
