# Library + Dual-Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `vault/library/` for raw cleaned Docling extractions, make the dual-graph (vault wikilinks vs LightRAG entity graph) explicit, unblock oversized documents, and index raw library text in LightRAG. Includes a `vault_section` MCP tool for targeted reading and a one-shot backfill of existing sources.

**Architecture:** Pipeline gains `librarying`/`libraried` stages between `extracted` and `generating`. The library file is written first (atomic temp+rename) and indexed via chokidar's existing watcher. Under-budget docs proceed to the agent; over-budget docs get a deterministic stub source note. Indexer learns about `library/` paths, replaces per-wikilink disk reads with an in-memory `slug→title` map, restricts frontmatter wikilink scanning to known fields, and emits bidirectional `source↔library` edges with distinct keywords. A new MCP server (`mcp__vault__vault_section`) sits alongside the existing rag MCP. Backfill script requires NanoClaw stopped.

**Tech Stack:** TypeScript (NodeNext + tsx + vitest), Drizzle ORM (better-sqlite3), chokidar, gray-matter, MCP stdio servers, LightRAG HTTP API.

**Spec:** [`docs/superpowers/specs/2026-04-29-library-dual-graph-design.md`](../specs/2026-04-29-library-dual-graph-design.md)

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/ingestion/library-writer.ts` | Atomic write of `vault/library/{slug}.md` from extraction artifacts. One responsibility: take `(slug, jobMeta, cleanedBody)` and produce a library file with the spec's frontmatter. |
| `src/ingestion/library-writer.test.ts` | Unit tests for atomicity, frontmatter shape, idempotent overwrite. |
| `src/ingestion/oversized-stub.ts` | Builds the deterministic over-budget stub source note from job metadata. |
| `src/ingestion/oversized-stub.test.ts` | Unit tests for stub frontmatter and body content. |
| `container/agent-runner/src/vault-mcp-stdio.ts` | New MCP server exposing `mcp__vault__vault_section`. |
| `container/agent-runner/src/vault-mcp-stdio.test.ts` | Tests for section/page/range locators, multi-match disambiguation, miss responses. |
| `scripts/backfill-library.ts` | One-shot backfill: walks `vault/sources/`, re-extracts, writes library, patches frontmatter, reindexes. |
| `scripts/backfill-library.test.ts` | Tests for dry-run, idempotency, edge cases, concurrency guard. |
| `drizzle/migrations/0004_oversized_to_libraried.sql` | Data migration — `UPDATE ingestion_jobs SET status='libraried' WHERE status='oversized'`. |

### Modified files

| Path | Change |
|---|---|
| `src/ingestion/pipeline.ts` | Add `drainLibrarying()` step; add `librarying` to `STAGE_RESET_MAP`. |
| `src/ingestion/index.ts` | Wire `onLibrary` handler; remove inline `oversized` branch in `handleGeneration` and replace with stub-write delegation. Drop the Telegram oversized notification. |
| `src/rag/indexer.ts` | `ALLOWED_PATHS` gains `library`; add library prefix shape; in-memory slug→title map; restricted frontmatter wikilink scan; bidirectional edge keywords; library timeout overrides; logging. |
| `src/vault/wikilinks.ts` | Add `extractFrontmatterWikilinks(fm, allowlist)` for known-field-only scanning. |
| `src/rag/rag-client.ts` | Accept optional per-call timeout overrides for index POST + poll. |
| `container/agent-runner/src/index.ts` | Mount `vault` MCP server at the existing rag-MCP mount point (line ~432); extend `disallowedTools` allowlist for the new namespace. |
| `src/ingestion/agent-processor.ts` | Agent prompt gains the `library:` frontmatter + `Full text:` body line instructions. |
| `groups/main/CLAUDE.md`, `groups/study/CLAUDE.md`, `groups/study-generator/CLAUDE.md` | Append the verbatim "Reading library files" section from spec §4. |
| `src/ingestion/pipeline.test.ts`, `src/ingestion/extractor.test.ts`, `src/rag/indexer.test.ts` | Extended with new tests per spec §6. |
| `src/ingestion/integration.test.ts` | New end-to-end test covering both budget paths. |

---

## Conventions for this plan

- **Test framework:** vitest. Run a single file with `npx vitest run path/to/file.test.ts`. Run a single test with `-t "<name>"`.
- **Filenames:** all source files use `.ts` and import siblings with `.js` extension (NodeNext resolution). Tests live next to source: `foo.ts` ↔ `foo.test.ts`.
- **Logging:** use the shared `logger` from `src/logger.ts` (pino). Pattern: `logger.info({ jobId, ...ctx }, 'descriptive message')`.
- **DB access:** read-only views go through `getJobsByStatus`/`updateIngestionJob` in `src/db.ts`. Schema lives in `src/db/schema/ingestion.ts`. Migrations are SQL files in `drizzle/migrations/` — never run DDL directly against the live DB (per CLAUDE.md).
- **Path joining:** `node:path` `join()` everywhere. When matching path prefixes, support both `/` and `\\` separators (existing convention in `src/rag/indexer.ts:67`).
- **Frontmatter:** `parseFrontmatter`/`serializeFrontmatter` in `src/vault/frontmatter.ts`. Round-trips stable.
- **Atomic writes:** write to `<final>.tmp.<pid>.<ts>` then `fs.renameSync(tmp, final)`. POSIX rename is atomic.
- **Commits:** one commit per task. Include the test changes with the implementation in the same commit (TDD discipline). Commit message format: `feat:`/`fix:`/`refactor:`/`test:`/`docs:` + scope, e.g. `feat(library): write library file after extraction`.
- **Branch:** all work continues on `spec/library-dual-graph` (already created and holds the spec commits).

---

## Phase 0 — Slug helper

### Task 0: Pin slug derivation as a single exported helper

**Files:**
- Create or modify: `src/ingestion/slug.ts` (new — separated from `utils.ts` so it has one obvious owner)
- Test: `src/ingestion/slug.test.ts`
- Modify (later tasks consume): `src/ingestion/index.ts` (librarying handler, T5), `src/ingestion/agent-processor.ts` (agent prompt, T8), `scripts/backfill-library.ts` (T22+)

Why first: per spec §1, every component (librarying stage, agent prompt, over-budget stub, backfill) must derive the slug identically. Diverging slugs cause silent wikilink-resolution failures. Pin one helper, force every consumer to import it.

If `toKebabCase` already exists in the codebase (search: `grep -rn "toKebabCase\|kebab" src/`), reuse it. Otherwise add it inside the new `slug.ts`. Either way, expose a single `slugFromFilename(filename)` function.

- [ ] **Step 1: Write the failing test**

Create `src/ingestion/slug.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { slugFromFilename } from './slug.js';

describe('slugFromFilename', () => {
  it('strips extension and kebab-cases', () => {
    expect(slugFromFilename('Foo Bar.pdf')).toBe('foo-bar');
    expect(slugFromFilename('A_Review_of_Cloud_Computing.pdf')).toBe('a-review-of-cloud-computing');
  });

  it('handles multiple dots in filename', () => {
    expect(slugFromFilename('paper.v2.final.pdf')).toBe('paper-v2-final');
  });

  it('handles no extension', () => {
    expect(slugFromFilename('paper')).toBe('paper');
  });

  it('handles existing kebab-case', () => {
    expect(slugFromFilename('already-kebab.pdf')).toBe('already-kebab');
  });

  it('strips trailing/leading hyphens after normalization', () => {
    expect(slugFromFilename('--weird--.pdf')).toBe('weird');
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/ingestion/slug.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Search the codebase first for an existing kebab-case helper to reuse:

```bash
grep -rn "kebab\|to-kebab" src/ingestion src/vault | head
```

If a helper exists (likely in `src/ingestion/utils.ts` or `src/ingestion/promoter.ts`), `slug.ts` becomes a thin wrapper:

```typescript
import { toKebabCase } from './utils.js';  // or wherever
import { basename, extname } from 'node:path';

export function slugFromFilename(filename: string): string {
  const base = basename(filename, extname(filename));
  return toKebabCase(base).replace(/^-+|-+$/g, '');
}
```

If no helper exists, inline a minimal implementation:

```typescript
import { basename, extname } from 'node:path';

export function slugFromFilename(filename: string): string {
  const base = basename(filename, extname(filename));
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/ingestion/slug.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/slug.ts src/ingestion/slug.test.ts
git commit -m "feat(ingestion): canonical slug helper for library/source identity"
```

---

## Phase 1 — Status groundwork

### Task 1: Add `librarying` and `libraried` to the pipeline state machine

**Files:**
- Modify: `src/ingestion/pipeline.ts` (add to `STAGE_RESET_MAP`)
- Test: `src/ingestion/pipeline.test.ts`

Why first: every later task transitions jobs through `librarying`/`libraried`, so the rate-limited reset map and the drainer's status set must accept these values before we add code that produces them.

- [ ] **Step 1: Write the failing test**

Append to `src/ingestion/pipeline.test.ts`:

```typescript
describe('PipelineDrainer rate-limited reset', () => {
  it('resets a librarying:rate_limited job back to extracted', () => {
    const fixture = makePipelineFixture(); // existing helper in this file
    fixture.insertJob({
      id: 'job-rl-1',
      status: 'rate_limited',
      error: 'librarying:rate limit exceeded',
      retry_after: new Date(Date.now() - 1000).toISOString(),
    });
    fixture.drainer.drainRateLimited();
    expect(fixture.getJob('job-rl-1').status).toBe('extracted');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ingestion/pipeline.test.ts -t "resets a librarying"`
Expected: FAIL — status is reset to `pending` (default fallback), not `extracted`.

- [ ] **Step 3: Add `librarying` to `STAGE_RESET_MAP`**

In `src/ingestion/pipeline.ts`, change:

```typescript
private static readonly STAGE_RESET_MAP: Record<string, string> = {
  extracting: 'pending',
  generating: 'extracted',
  promoting: 'generated',
};
```

to:

```typescript
private static readonly STAGE_RESET_MAP: Record<string, string> = {
  extracting: 'pending',
  librarying: 'extracted',
  generating: 'libraried',
  promoting: 'generated',
};
```

Note: `generating`'s reset target changes from `extracted` to `libraried` — under the new pipeline, generation always runs against a libraried job.

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/ingestion/pipeline.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/pipeline.ts src/ingestion/pipeline.test.ts
git commit -m "feat(pipeline): add librarying/libraried to stage reset map"
```

---

### Task 2: Migration — existing `oversized` rows transition to `libraried`

**Files:**
- Create: `drizzle/migrations/0004_oversized_to_libraried.sql`
- Test: `src/db-migration.test.ts` (extend existing)

Why now: subsequent tasks may depend on the assumption that no `oversized` rows exist in the live state machine.

- [ ] **Step 1: Write the failing test**

Append to `src/db-migration.test.ts`:

```typescript
describe('migration 0004: oversized → libraried', () => {
  it('transitions oversized rows to libraried', () => {
    const db = makeMigratedDbAtMigration(3); // helper that runs migrations 0-3 only
    db.exec(`
      INSERT INTO ingestion_jobs (id, source_path, source_filename, status, created_at, updated_at)
      VALUES
        ('o1', '/a.pdf', 'a.pdf', 'oversized', '2026-04-01', '2026-04-01'),
        ('o2', '/b.pdf', 'b.pdf', 'oversized', '2026-04-01', '2026-04-01'),
        ('c1', '/c.pdf', 'c.pdf', 'completed', '2026-04-01', '2026-04-01');
    `);
    runMigration(db, '0004_oversized_to_libraried.sql');

    const rows = db.prepare("SELECT id, status FROM ingestion_jobs ORDER BY id").all();
    expect(rows).toEqual([
      { id: 'c1', status: 'completed' },     // untouched
      { id: 'o1', status: 'libraried' },
      { id: 'o2', status: 'libraried' },
    ]);
  });

  it('is idempotent', () => {
    const db = makeMigratedDbAtMigration(3);
    db.exec(`INSERT INTO ingestion_jobs (id, source_path, source_filename, status, created_at, updated_at) VALUES ('o1', '/a.pdf', 'a.pdf', 'oversized', '2026-04-01', '2026-04-01')`);
    runMigration(db, '0004_oversized_to_libraried.sql');
    runMigration(db, '0004_oversized_to_libraried.sql'); // re-apply
    expect(db.prepare("SELECT status FROM ingestion_jobs WHERE id='o1'").get()).toEqual({ status: 'libraried' });
  });
});
```

If `makeMigratedDbAtMigration` and `runMigration` helpers don't yet exist in this test file, write thin local helpers using `better-sqlite3` and `readFileSync` to apply the SQL files from `drizzle/migrations/` in order. Inspect existing `src/db-migration.test.ts` to match the prevailing style.

- [ ] **Step 2: Run the test — expect failure**

Run: `npx vitest run src/db-migration.test.ts -t "0004"`
Expected: FAIL — migration file not found.

- [ ] **Step 3: Edit schema (if needed) and generate the migration**

Status is a free-form `TEXT` column on `ingestion_jobs` (no enum constraint), so no schema edit is required. Generate the migration manually because `drizzle-kit generate` won't produce a data migration:

Create `drizzle/migrations/0004_oversized_to_libraried.sql`:

```sql
-- Data migration: existing 'oversized' jobs transition to 'libraried' under
-- the new pipeline. Idempotent — affects only rows currently at 'oversized'.
UPDATE ingestion_jobs
SET status = 'libraried',
    error = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'oversized';
```

Update `drizzle/migrations/meta/_journal.json` to register the new migration. Verified format (read from the live file):

```json
{
  "version": "7",
  "dialect": "sqlite",
  "entries": [
    { "idx": 0, "version": "6", "when": 1776197946601, "tag": "0000_glamorous_drax", "breakpoints": true },
    { "idx": 1, "version": "6", "when": 1776243235707, "tag": "0001_outstanding_loki", "breakpoints": true },
    { "idx": 2, "version": "6", "when": 1776245600959, "tag": "0002_vengeful_kat_farrell", "breakpoints": true },
    { "idx": 3, "version": "6", "when": 1776530493928, "tag": "0003_dry_caretaker", "breakpoints": true }
  ]
}
```

Append a new entry to the `entries` array (keep top-level `version: "7"` and `dialect: "sqlite"` unchanged):

```json
{ "idx": 4, "version": "6", "when": <NOW_IN_MS>, "tag": "0004_oversized_to_libraried", "breakpoints": true }
```

Replace `<NOW_IN_MS>` with `Date.now()` at the time of generation (e.g. paste the result of `node -e 'console.log(Date.now())'`). The four required fields per entry are `idx` (sequential), `version: "6"`, `when` (ms timestamp), `tag` (matches filename without `.sql`), `breakpoints: true`. The runner in `src/db/migrate.ts` reads this file to decide which migrations to apply; a malformed entry breaks startup for every install.

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/db-migration.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add drizzle/migrations/0004_oversized_to_libraried.sql drizzle/migrations/meta/_journal.json src/db-migration.test.ts
git commit -m "feat(db): migrate oversized jobs to libraried"
```

---

## Phase 2 — Library writer

### Task 3: `LibraryWriter` — atomic library file write

**Files:**
- Create: `src/ingestion/library-writer.ts`
- Test: `src/ingestion/library-writer.test.ts`

The writer is a pure function over `(libraryDir, jobMeta, cleanedBody)` returning the final path. It owns frontmatter shape, atomic temp+rename, and the slug-collision check (overwrite-with-warning, since each ingest of the same slug is the latest authoritative extract).

- [ ] **Step 1: Write the failing test**

Create `src/ingestion/library-writer.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLibraryFile } from './library-writer.js';

describe('writeLibraryFile', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'library-writer-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes a file with the spec frontmatter shape', () => {
    const path = writeLibraryFile({
      libraryDir: dir,
      slug: 'foo-bar',
      jobMeta: {
        title: 'Foo Bar',
        sourceType: 'paper',
        ingestedFrom: 'upload/processed/abc-foo.pdf',
        jobId: 'abc',
        sourceSummarySlug: 'foo-bar',
      },
      cleanedBody: 'BODY CONTENT\n',
    });
    expect(path).toBe(join(dir, 'foo-bar.md'));
    const written = readFileSync(path, 'utf-8');
    expect(written).toContain('title: "Foo Bar"');
    expect(written).toContain('type: library');
    expect(written).toContain('source_summary: "[[foo-bar]]"');
    expect(written).toContain('source_type: paper');
    expect(written).toContain('ingested_from: "upload/processed/abc-foo.pdf"');
    expect(written).toContain('job_id: abc');
    expect(written).toContain('indexed: false');
    expect(written.endsWith('\nBODY CONTENT\n')).toBe(true);
  });

  it('omits source_summary when not provided (over-budget case)', () => {
    const path = writeLibraryFile({
      libraryDir: dir,
      slug: 'big-book',
      jobMeta: {
        title: 'Big Book',
        sourceType: 'book',
        ingestedFrom: 'upload/processed/zz-big.pdf',
        jobId: 'zz',
        sourceSummarySlug: undefined,
      },
      cleanedBody: 'X',
    });
    const written = readFileSync(path, 'utf-8');
    expect(written).not.toContain('source_summary:');
  });

  it('atomic write: no .tmp file remains after success', () => {
    writeLibraryFile({
      libraryDir: dir,
      slug: 'a',
      jobMeta: { title: 'A', sourceType: 'paper', ingestedFrom: 'x', jobId: 'j', sourceSummarySlug: 'a' },
      cleanedBody: 'b',
    });
    const entries = readdirSync(dir);
    expect(entries).toEqual(['a.md']);
  });

  it('overwrites existing library file (latest extraction wins)', () => {
    writeLibraryFile({ libraryDir: dir, slug: 's', jobMeta: { title: 'first', sourceType: 'paper', ingestedFrom: 'x', jobId: 'j1', sourceSummarySlug: 's' }, cleanedBody: 'old' });
    writeLibraryFile({ libraryDir: dir, slug: 's', jobMeta: { title: 'second', sourceType: 'paper', ingestedFrom: 'x', jobId: 'j2', sourceSummarySlug: 's' }, cleanedBody: 'new' });
    const written = readFileSync(join(dir, 's.md'), 'utf-8');
    expect(written).toContain('title: "second"');
    expect(written.endsWith('new')).toBe(true);
  });

  it('creates libraryDir if missing', () => {
    const nested = join(dir, 'nested', 'library');
    writeLibraryFile({ libraryDir: nested, slug: 'a', jobMeta: { title: 'A', sourceType: 'paper', ingestedFrom: 'x', jobId: 'j', sourceSummarySlug: 'a' }, cleanedBody: 'b' });
    expect(statSync(join(nested, 'a.md')).isFile()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npx vitest run src/ingestion/library-writer.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `writeLibraryFile`**

Create `src/ingestion/library-writer.ts`:

```typescript
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeFrontmatter } from '../vault/frontmatter.js';

export interface LibraryJobMeta {
  title: string;
  sourceType: string;
  ingestedFrom: string;
  jobId: string;
  sourceSummarySlug: string | undefined;
}

export interface WriteLibraryFileInput {
  libraryDir: string;
  slug: string;
  jobMeta: LibraryJobMeta;
  cleanedBody: string;
}

export function writeLibraryFile(input: WriteLibraryFileInput): string {
  const { libraryDir, slug, jobMeta, cleanedBody } = input;
  mkdirSync(libraryDir, { recursive: true });

  const fm: Record<string, unknown> = {
    title: jobMeta.title,
    type: 'library',
    source_type: jobMeta.sourceType,
    ingested_from: jobMeta.ingestedFrom,
    job_id: jobMeta.jobId,
    indexed: false,
  };
  if (jobMeta.sourceSummarySlug) {
    fm.source_summary = `[[${jobMeta.sourceSummarySlug}]]`;
  }

  const finalPath = join(libraryDir, `${slug}.md`);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  const content = `${serializeFrontmatter(fm)}\n${cleanedBody}`;

  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, finalPath);
  return finalPath;
}
```

If `serializeFrontmatter` does not preserve the field order shown in the test (gray-matter's order is not guaranteed), open `src/vault/frontmatter.ts` and confirm. If serializer reorders, weaken assertions to `toMatch(/title:.*"Foo Bar"/)` rather than literal substring matches — but keep `type: library` and `indexed: false` checks.

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/ingestion/library-writer.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/library-writer.ts src/ingestion/library-writer.test.ts
git commit -m "feat(library): atomic write of vault/library files"
```

---

### Task 4: Add `librarying` drainer to the pipeline

**Files:**
- Modify: `src/ingestion/pipeline.ts`
- Test: `src/ingestion/pipeline.test.ts`

The new drainer reads `extracted` jobs (replacing the old generation-pulls-from-extracted flow), invokes `onLibrary`, transitions to `libraried` on success, leaves at `librarying` (for recovery retry) on failure. The generation drainer is updated to read from `libraried` instead.

- [ ] **Step 1: Write the failing test**

Append to `src/ingestion/pipeline.test.ts`:

```typescript
describe('drainLibrarying', () => {
  it('moves extracted → librarying → libraried on success', async () => {
    const fixture = makePipelineFixture({ onLibrary: async () => {} });
    fixture.insertJob({ id: 'j1', status: 'extracted' });
    await fixture.drainer.drainLibrarying();
    expect(fixture.getJob('j1').status).toBe('libraried');
  });

  it('leaves job at librarying on onLibrary failure', async () => {
    const fixture = makePipelineFixture({
      onLibrary: async () => { throw new Error('disk full'); },
    });
    fixture.insertJob({ id: 'j2', status: 'extracted' });
    await fixture.drainer.drainLibrarying();
    expect(fixture.getJob('j2').status).toBe('librarying');
    expect(fixture.getJob('j2').error).toMatch(/librarying:disk full/);
  });

  it('drainGenerations now reads from libraried, not extracted', async () => {
    const fixture = makePipelineFixture({ onLibrary: async () => {}, onGenerate: async () => {} });
    fixture.insertJob({ id: 'j3', status: 'libraried' });
    await fixture.drainer.drainGenerations();
    expect(fixture.getJob('j3').status).toBe('generating');
  });
});
```

If `makePipelineFixture` does not currently accept `onLibrary` in its options, extend it; the existing helper builds a `PipelineDrainer` with stub callbacks.

- [ ] **Step 2: Run the tests — expect failure**

Run: `npx vitest run src/ingestion/pipeline.test.ts -t "drainLibrarying"`
Expected: FAIL — `drainLibrarying` is not a function.

- [ ] **Step 3: Implement `drainLibrarying` and update `drainGenerations`**

Edit `src/ingestion/pipeline.ts`. Update the options interface:

```typescript
export interface PipelineDrainerOpts {
  onExtract: (job: JobRow) => Promise<void>;
  onLibrary: (job: JobRow) => Promise<void>;          // NEW
  onGenerate: (job: JobRow) => Promise<void>;
  onPromote: (job: JobRow) => Promise<void>;
  onComplete?: (job: JobRow) => Promise<void>;
  maxExtractionConcurrent: number;
  maxLibrarianConcurrent?: number;                     // NEW, default 2
  maxGenerationConcurrent: number | (() => number);
  pollIntervalMs: number;
}
```

Add a private `activeLibrarying = 0;` field and an `async drainLibrarying()` method modeled after `drainExtractions`:

```typescript
async drainLibrarying(): Promise<void> {
  const max = this.opts.maxLibrarianConcurrent ?? 2;
  const slots = max - this.activeLibrarying;
  if (slots <= 0) return;

  const extracted = getJobsByStatus('extracted') as JobRow[];
  const batch = extracted.slice(0, slots);

  for (const job of batch) {
    updateIngestionJob(job.id, { status: 'librarying' });
    this.activeLibrarying++;
    const p = this.opts
      .onLibrary(job)
      .then(() => {
        updateIngestionJob(job.id, { status: 'libraried', error: null });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Stay at 'librarying' — recovery loop retries. Do not transition to 'failed'.
        updateIngestionJob(job.id, { error: `librarying:${msg}` });
      })
      .finally(() => {
        this.activeLibrarying--;
        this.inFlight.delete(p);
      });
    this.inFlight.add(p);
  }
}
```

In `drainGenerations`, change `getJobsByStatus('extracted')` to `getJobsByStatus('libraried')`. Insert `await this.drainLibrarying()` between `drainExtractions` and `drainGenerations` in `tick()`.

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/ingestion/pipeline.test.ts`
Expected: All pass. Some pre-existing tests may fail because they insert jobs at status `extracted` expecting generation to pick them up; update those to `libraried`.

- [ ] **Step 5: Add `resetRecoverableInProgress` to job-recovery**

Read `src/ingestion/job-recovery.ts` first. Today the file exports `markInterruptedJobsFailed` (or similar) that transitions stuck in-progress jobs to `failed` on startup. **That's the wrong semantic for `librarying`** because the library write is idempotent (atomic rename + same-content overwrite), so re-running is safe and far more useful than failing.

Add a companion function that runs **before** `markInterruptedJobsFailed` and resets only `librarying`:

```typescript
// src/ingestion/job-recovery.ts (add to existing file)

import { getJobsByStatus, updateIngestionJob } from '../db.js';
import { logger } from '../logger.js';

const RECOVERABLE_STATUSES = ['librarying'] as const;

export function resetRecoverableInProgress(): void {
  for (const status of RECOVERABLE_STATUSES) {
    const jobs = getJobsByStatus(status);
    for (const job of jobs) {
      logger.info({ jobId: job.id, fromStatus: status, toStatus: 'extracted' }, 'recovery: resetting recoverable in-progress job');
      updateIngestionJob(job.id, { status: 'extracted', error: null });
    }
  }
}
```

Wire the new function in `src/index.ts` (or wherever `markInterruptedJobsFailed` is called at startup) so it runs **before** the failed-mark step:

```typescript
resetRecoverableInProgress();
markInterruptedJobsFailed();
```

Add a test in `src/ingestion/job-recovery.test.ts`:

```typescript
import { resetRecoverableInProgress } from './job-recovery.js';
// match the existing test fixture style in this file

it('resets a stuck librarying job to extracted', () => {
  // ... seed a librarying job via the existing fixture pattern
  resetRecoverableInProgress();
  expect(getJob('j1').status).toBe('extracted');
});

it('does not touch other in-progress statuses', () => {
  // seed an extracting job — the existing markInterruptedJobsFailed handles it; reset must not
  resetRecoverableInProgress();
  expect(getJob('j2').status).toBe('extracting');  // unchanged
});
```

Match the existing test style in this file. If `markInterruptedJobsFailed` already runs in the same flow and would re-fail the just-reset job, ensure the calling order is correct (reset first, then mark).

- [ ] **Step 6: Commit**

```bash
git add src/ingestion/pipeline.ts src/ingestion/pipeline.test.ts src/ingestion/job-recovery.ts src/ingestion/job-recovery.test.ts
git commit -m "feat(pipeline): add librarying drainer between extract and generate"
```

---

### Task 5: Wire `onLibrary` in `src/ingestion/index.ts`

**Files:**
- Modify: `src/ingestion/index.ts`
- Test: extend `src/ingestion/integration.test.ts`

Wires the writer to the drainer and threads `VAULT_DIR/library` as the destination.

- [ ] **Step 1: Write the failing test**

Append to `src/ingestion/integration.test.ts` (or matching integration fixture):

```typescript
describe('onLibrary handler', () => {
  it('writes vault/library/{slug}.md when a job transitions extracted → libraried', async () => {
    const fixture = await makeIngestionFixture();
    fixture.seedExtractedJob({
      jobId: 'j1',
      slug: 'sample-paper',
      title: 'Sample Paper',
      cleanedContent: 'CLEAN BODY',
      sourceType: 'paper',
      ingestedFrom: 'upload/processed/j1-sample.pdf',
    });
    await fixture.tickPipeline();
    const libraryPath = path.join(fixture.vaultDir, 'library', 'sample-paper.md');
    expect(existsSync(libraryPath)).toBe(true);
    const content = readFileSync(libraryPath, 'utf-8');
    expect(content).toContain('type: library');
    expect(content).toContain('CLEAN BODY');
    expect(fixture.getJob('j1').status).toBe('libraried');
  });
});
```

If `makeIngestionFixture`/`seedExtractedJob` aren't in this file, write thin helpers that use `IngestionService` (or whatever class is exported from `src/ingestion/index.ts`).

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/ingestion/integration.test.ts -t "onLibrary"`
Expected: FAIL — no library file written.

- [ ] **Step 3: Implement `handleLibrarying`**

In `src/ingestion/index.ts`, locate the handler registry around `onExtract: (job) => this.handleExtraction(job)`. Add `onLibrary: (job) => this.handleLibrarying(job)`.

Add the method (model on the existing `handleExtraction`):

```typescript
private async handleLibrarying(job: JobRow): Promise<void> {
  const extractionPath = job.extraction_path;
  if (!extractionPath) throw new Error(`No extraction path for job ${job.id}`);

  const cleanContentPath = join(extractionPath, 'content.clean.md');
  const rawContentPath = join(extractionPath, 'content.md');
  const contentPath = existsSync(cleanContentPath) ? cleanContentPath : rawContentPath;
  const cleanedBody = readFileSync(contentPath, 'utf-8');

  // Single slug rule — must match Section 1 of the spec. Source filename only;
  // do NOT derive from any agent-provided title (the agent hasn't run yet).
  const slug = slugFromFilename(job.source_filename);
  // Title is best-effort: prefer Zotero metadata, then extraction-detected title,
  // then fall back to a Title Case version of the slug. The under-budget agent
  // may overwrite the title in its source-note draft; the library file's title
  // is informational only (search uses the indexed prefix, not the title alone).
  const title = titleFromJobMetadata(job) ?? slugToTitle(slug);
  const ingestedFrom = `upload/processed/${job.id}-${job.source_filename}`;

  // Under-budget docs will gain a curated source summary later in the agent step;
  // over-budget docs won't. We optimistically point at the slug — if no source
  // note ever materializes, the wikilink is unresolved (fine; vault graph tolerates).
  writeLibraryFile({
    libraryDir: join(this.vaultDir, 'library'),
    slug,
    jobMeta: {
      title,
      sourceType: job.source_type ?? 'paper',
      ingestedFrom,
      jobId: job.id,
      sourceSummarySlug: slug,
    },
    cleanedBody,
  });

  logger.info({ jobId: job.id, slug }, 'ingestion: library file written');
}
```

**`slugFromFilename` is from Task 0 — import it.** `slugToTitle` exists in `src/vault/wikilinks.ts`. `titleFromJobMetadata` is a small new helper to add inline: read `job.zotero_metadata` JSON if present (`title` field), else parse the extracted Docling output's first H1 if available, else return null. Keep this lookup-only — no fallbacks beyond the three layers above; the slug-Title-Case fallback handles the worst case.

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/ingestion/integration.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/index.ts src/ingestion/integration.test.ts
git commit -m "feat(ingestion): write library file in librarying stage"
```

---

## Phase 3 — Over-budget stub source note

### Task 6: `oversized-stub` builder

**Files:**
- Create: `src/ingestion/oversized-stub.ts`
- Test: `src/ingestion/oversized-stub.test.ts`

Pure function `buildOversizedStub(jobMeta) → { frontmatter, body }`. Tested independently of disk so we can pin the exact shape.

- [ ] **Step 1: Write the failing test**

Create `src/ingestion/oversized-stub.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildOversizedStub } from './oversized-stub.js';

describe('buildOversizedStub', () => {
  it('produces the spec-mandated frontmatter shape', () => {
    const stub = buildOversizedStub({
      title: 'Big Book',
      slug: 'big-book',
      sourceType: 'book',
      ingestedFrom: 'upload/processed/jx-big.pdf',
      createdDate: '2026-04-29',
    });
    expect(stub.frontmatter).toEqual({
      title: 'Big Book',
      type: 'source',
      source_type: 'book',
      source_file: 'upload/processed/jx-big.pdf',
      library: '[[library/big-book]]',
      verification_status: 'unverified',
      auto_generated: true,
      concepts_generated: [],
      created: '2026-04-29',
    });
  });

  it('produces a body with the canned explanation and full-text link', () => {
    const stub = buildOversizedStub({
      title: 'Big Book',
      slug: 'big-book',
      sourceType: 'book',
      ingestedFrom: 'upload/processed/jx-big.pdf',
      createdDate: '2026-04-29',
    });
    expect(stub.body).toContain('# Big Book');
    expect(stub.body).toContain('exceeded the agent\'s token budget');
    expect(stub.body).toContain('[[library/big-book]]');
    expect(stub.body).toContain('**Full text:** [[library/big-book]]');
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/ingestion/oversized-stub.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/ingestion/oversized-stub.ts`:

```typescript
export interface OversizedStubInput {
  title: string;
  slug: string;
  sourceType: string;
  ingestedFrom: string;
  createdDate: string;
}

export interface OversizedStub {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function buildOversizedStub(input: OversizedStubInput): OversizedStub {
  const frontmatter: Record<string, unknown> = {
    title: input.title,
    type: 'source',
    source_type: input.sourceType,
    source_file: input.ingestedFrom,
    library: `[[library/${input.slug}]]`,
    verification_status: 'unverified',
    auto_generated: true,
    concepts_generated: [],  // required by draft-validator; empty since no agent ran
    created: input.createdDate,
  };

  const body = `# ${input.title}

This document was ingested but exceeded the agent's token budget for full synthesis.
The complete extracted text is available at [[library/${input.slug}]].

**Full text:** [[library/${input.slug}]]
`;

  return { frontmatter, body };
}
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/ingestion/oversized-stub.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/oversized-stub.ts src/ingestion/oversized-stub.test.ts
git commit -m "feat(library): deterministic stub source note for over-budget docs"
```

---

### Task 7: Replace inline `oversized` branch with stub-write in `handleGeneration`

**Files:**
- Modify: `src/ingestion/index.ts` (the block at lines ~284–315 that sets `status: 'oversized'`)
- Test: extend `src/ingestion/integration.test.ts`

Under the new flow, generation receives only `libraried` jobs. When the budget gate trips, it writes the stub source note + manifest, transitions to `generated` (so promotion runs normally), and skips the agent. The Telegram notification is removed entirely.

- [ ] **Step 1: Write the failing test**

Append to `src/ingestion/integration.test.ts`:

```typescript
describe('over-budget path', () => {
  it('writes a stub source draft, promotes it, and skips the agent', async () => {
    const fixture = await makeIngestionFixture();
    fixture.seedLibrariedJob({
      jobId: 'big',
      slug: 'big-book',
      title: 'Big Book',
      cleanedContent: 'A'.repeat(800_000), // ~200K tokens, well over 80K budget
      sourceType: 'book',
    });
    fixture.spyAgent();
    await fixture.tickPipelineToCompletion(); // drives drainer through generated→promoting→completed

    // Stub draft was written to drafts/ and promoted to sources/
    const sourcePath = path.join(fixture.vaultDir, 'sources', 'big-book.md');
    expect(existsSync(sourcePath)).toBe(true);
    const content = readFileSync(sourcePath, 'utf-8');
    expect(content).toContain('auto_generated: true');
    expect(content).toContain('library: "[[library/big-book]]"');
    expect(content).toContain('concepts_generated: []');
    expect(content).toContain('# Big Book');
    // Drafts dir is cleaned up by the existing promotion flow.
    expect(existsSync(path.join(fixture.draftsDir, 'big-source.md'))).toBe(false);
    expect(fixture.agentInvocations).toEqual([]); // never spawned
    expect(fixture.getJob('big').status).toBe('completed');
  });

  it('does not send a Telegram notification on over-budget', async () => {
    const fixture = await makeIngestionFixture();
    fixture.seedLibrariedJob({ jobId: 'big2', slug: 's', title: 't', cleanedContent: 'A'.repeat(800_000), sourceType: 'paper' });
    fixture.spyNotify();
    await fixture.tickPipeline();
    expect(fixture.notifyInvocations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/ingestion/integration.test.ts -t "over-budget"`
Expected: FAIL — current code transitions to `oversized`, doesn't write a stub.

- [ ] **Step 3: Modify `handleGeneration`**

In `src/ingestion/index.ts`, replace the block at the budget gate (currently around line 299–315) with code that writes the stub **to the drafts directory**, not directly to `vault/sources/`. This keeps the over-budget path uniform with the agent path: drafts → manifest (inferred) → `handlePromotion` does the rest.

```typescript
if (estimatedTokens > TOKEN_BUDGET) {
  const tokensK = Math.round(estimatedTokens / 1000);
  logger.info(
    { jobId: job.id, estimatedTokens, budget: TOKEN_BUDGET },
    `ingestion: Over budget (~${tokensK}K tokens); writing stub source draft`,
  );

  const slug = slugFromFilename(job.source_filename);
  const title = titleFromJobMetadata(job) ?? slugToTitle(slug);
  const ingestedFrom = `upload/processed/${job.id}-${job.source_filename}`;
  const stub = buildOversizedStub({
    title,
    slug,
    sourceType: job.source_type ?? 'paper',
    ingestedFrom,
    createdDate: new Date().toISOString().slice(0, 10),
  });

  // Write stub to drafts/ — promotion takes over from here. Filename matches the
  // pattern the agent would use: {jobId}-source.md. inferManifest (manifest.ts:23)
  // walks drafts/, finds this single source draft, returns a manifest with no
  // concept notes — promoteNote then renames to vault/sources/{slug}.md.
  const draftPath = join(draftsDir, `${job.id}-source.md`);
  mkdirSync(draftsDir, { recursive: true });
  const tmp = `${draftPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(
    tmp,
    `${serializeFrontmatter(stub.frontmatter)}\n${stub.body}`,
    'utf-8',
  );
  renameSync(tmp, draftPath);

  updateIngestionJob(job.id, { status: 'generated' });
  return;
}
```

Remove the `if (this.notify)` block entirely. Remove `existing.status === 'oversized'` from the duplicate-check at line ~152 (no `oversized` status exists anymore in the live state). Remove the Telegram channel callback wiring for the oversized notification at the call site.

**Verify the promotion path handles this**. Read `src/ingestion/index.ts:495` (`handlePromotion`). The flow is: `readManifest` (returns null because no manifest JSON file exists) → `inferManifest` (walks drafts, finds `{jobId}-source.md`, returns manifest with `concept_notes: []`) → `promoteNote` is called once for the source. If `promoteNote` requires concept notes (read `promoter.ts:21`), confirm an empty concepts list is acceptable. If not, the stub flow needs to write a minimal manifest JSON (`{"source_note": "{jobId}-source.md", "concept_notes": []}`) explicitly — adjust the implementation to do so.

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/ingestion/integration.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/index.ts src/ingestion/integration.test.ts
git commit -m "feat(ingestion): replace oversized status with stub source note write"
```

---

### Task 8: Update agent prompt for under-budget path

**Files:**
- Modify: `src/ingestion/agent-processor.ts`
- Test: `src/ingestion/agent-processor.test.ts`

Inject the spec §2 instruction into the source-note guidance section of the agent prompt.

- [ ] **Step 1: Write the failing test**

Append to `src/ingestion/agent-processor.test.ts`:

```typescript
it('agent prompt instructs the agent to add library wikilinks to the source note', () => {
  const prompt = buildAgentPrompt({
    jobId: 'jx',
    sourceFilename: 'paper.pdf',
    slug: 'paper',
    // ...other fields the helper requires
  });
  expect(prompt).toContain('library: "[[library/paper]]"');
  expect(prompt).toContain('**Full text:** [[library/paper]]');
  expect(prompt).toContain('overarching logical flow');
  expect(prompt).toContain('The slug is **paper** — use exactly this string');
});

it('draft-validator accepts a source note with library frontmatter', () => {
  // Cheap insurance against draft-validator regression.
  // Match the existing draft-validator.test.ts fixture pattern.
  const draft = `---
title: Foo
type: source
source_type: paper
source_file: upload/processed/jx-paper.pdf
library: "[[library/paper]]"
verification_status: unverified
concepts_generated: []
---
# Foo
body
`;
  const result = validateSourceDraft(draft); // existing validator entry point
  expect(result.valid).toBe(true);
});
```

If `buildAgentPrompt` is not the actual export name, locate the existing prompt builder and adapt the test name. The test exists to pin the strings the agent will see.

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/ingestion/agent-processor.test.ts -t "library wikilinks"`
Expected: FAIL — strings not found.

- [ ] **Step 3: Edit the prompt template**

Locate the section in `src/ingestion/agent-processor.ts` that builds the source-note guidance for the agent. The prompt builder already takes a `slug` (or has access to job metadata that derives one) — use the same value, computed via `slugFromFilename(job.source_filename)`. **Do not let the agent re-derive the slug from the document title** (the agent's title may differ from the slug used elsewhere).

Append to the source-note guidance:

```
### Linking to the library file

A raw cleaned extraction of this document has been written to `vault/library/${slug}.md`. The slug is **${slug}** — use exactly this string in both wikilinks below; do not derive a different one from the document title.

Your source note must reference it:

- Frontmatter: add `library: "[[library/${slug}]]"`
- Body: add `**Full text:** [[library/${slug}]]` near the top

The library file holds the raw extracted text and is the canonical place to read passages verbatim. Your source note remains the curated overarching logical flow.
```

If the existing prompt builder doesn't currently have a `slug` parameter, add one — derived in the caller via `slugFromFilename(job.source_filename)` (the same call site that already invokes the agent).

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/ingestion/agent-processor.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/agent-processor.ts src/ingestion/agent-processor.test.ts
git commit -m "feat(agent): instruct agent to wikilink library file from source notes"
```

---

## Phase 4 — Indexer changes

### Task 9: `ALLOWED_PATHS` gains `library`

**Files:**
- Modify: `src/rag/indexer.ts:19`
- Test: `src/rag/indexer.test.ts`

Smallest possible diff. Validate before bigger changes.

- [ ] **Step 1: Write the failing test**

Append to `src/rag/indexer.test.ts`:

```typescript
it('indexes files under vault/library/', async () => {
  const fixture = await makeIndexerFixture();
  fixture.writeVaultFile('library/foo.md', '---\ntitle: Foo\ntype: library\n---\nbody');
  await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'library/foo.md'));
  expect(fixture.ragClient.indexCalls).toHaveLength(1);
  expect(fixture.ragClient.indexCalls[0].fileSource).toBe('library/foo.md');
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/rag/indexer.test.ts -t "vault/library"`
Expected: FAIL — `isAllowed` returns false, no index call.

- [ ] **Step 3: Edit `ALLOWED_PATHS`**

In `src/rag/indexer.ts`, update the constant. Verify current value first by reading the file (do not assume the spec quote is the current value):

```typescript
const ALLOWED_PATHS = ['concepts', 'sources', 'profile/archive', 'library'];
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/rag/indexer.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/rag/indexer.ts src/rag/indexer.test.ts
git commit -m "feat(rag): index files under vault/library/"
```

---

### Task 10: Library-specific indexed prefix shape

**Files:**
- Modify: `src/rag/indexer.ts` (the `parts` block at ~87–92)
- Test: `src/rag/indexer.test.ts`

Library files use a distinct prefix: `[Title: X | Type: library | Source summary: Y]`. The `Source summary` line is omitted when no `source_summary` frontmatter exists.

- [ ] **Step 1: Write the failing test**

Append to `src/rag/indexer.test.ts`:

```typescript
describe('library prefix shape', () => {
  it('emits Title | Type | Source summary when source_summary present', async () => {
    const fixture = await makeIndexerFixture();
    fixture.writeVaultFile('library/foo.md',
      '---\ntitle: Foo\ntype: library\nsource_summary: "[[foo]]"\n---\nBODY');
    await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'library/foo.md'));
    const sent = fixture.ragClient.indexCalls[0].content;
    expect(sent.split('\n')[0]).toBe('[Title: Foo | Type: library | Source summary: foo]');
  });

  it('omits Source summary when missing (over-budget case)', async () => {
    const fixture = await makeIndexerFixture();
    fixture.writeVaultFile('library/big.md',
      '---\ntitle: Big\ntype: library\n---\nBODY');
    await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'library/big.md'));
    const sent = fixture.ragClient.indexCalls[0].content;
    expect(sent.split('\n')[0]).toBe('[Title: Big | Type: library]');
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/rag/indexer.test.ts -t "library prefix"`
Expected: FAIL — current prefix uses `Topics:`/`Source:`/`Verification:`.

- [ ] **Step 3: Branch the prefix construction by `type`**

In `src/rag/indexer.ts`, replace the block at ~87–92 with:

```typescript
const parts: string[] = [`Title: ${title}`, `Type: ${type}`];

if (type === 'library') {
  const sourceSummaryRaw = String(fm.source_summary || '');
  const slug = sourceSummaryRaw.replace(/^\[\[|\]\]$/g, '').trim();
  if (slug) parts.push(`Source summary: ${slug}`);
} else {
  if (topics) parts.push(`Topics: ${topics}`);
  if (sourceDoc) parts.push(`Source: ${sourceDoc}`);
  parts.push(`Verification: ${verification}`);
}

const prefix = `[${parts.join(' | ')}]`;
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/rag/indexer.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/rag/indexer.ts src/rag/indexer.test.ts
git commit -m "feat(rag): library files use distinct indexed prefix"
```

---

### Task 11: In-memory `slug → title` map

**Files:**
- Modify: `src/rag/indexer.ts` (add map + `start()` method + chokidar hook updates + lookup in `injectWikilinks`)
- Test: `src/rag/indexer.test.ts`

Replace the per-wikilink disk-read pattern with a single in-memory map built at startup and maintained by chokidar events. Look up bare slugs in the map; fall back to `slugToTitle` (existing helper in `src/vault/wikilinks.ts`) on miss with a warning.

- [ ] **Step 1: Write the failing test**

Append to `src/rag/indexer.test.ts`:

```typescript
describe('slug→title map (behavioral)', () => {
  // Tests target observable behavior — no direct map introspection. The map is
  // an implementation detail; what matters is that wikilink resolution uses it
  // (no disk reads after init) and that the map stays current on chokidar events.

  it('resolves wikilinks via the map after start() — no per-resolution disk read', async () => {
    const fixture = await makeIndexerFixture();
    fixture.writeVaultFile('sources/target.md', '---\ntitle: TargetTitle\ntype: source\n---\n');
    fixture.writeVaultFile('sources/origin.md', '---\ntitle: OriginTitle\ntype: source\n---\nbody refs [[target]]');
    fixture.ragClient.entityExists = vi.fn().mockResolvedValue(true);
    fixture.ragClient.createRelation = vi.fn().mockResolvedValue(undefined);
    await fixture.indexer.start();

    const readFileSpy = vi.spyOn(fs, 'readFileSync');
    readFileSpy.mockClear();
    await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'sources/origin.md'));

    // Only the file being indexed is read; the target's title comes from the in-memory map.
    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(readFileSpy.mock.calls[0][0]).toContain('sources/origin.md');
    expect(fixture.ragClient.entityExists).toHaveBeenCalledWith('TargetTitle');
  });

  it('picks up newly-added files: wikilinks to a freshly-added target resolve', async () => {
    const fixture = await makeIndexerFixture();
    await fixture.indexer.start();
    fixture.writeVaultFile('sources/late.md', '---\ntitle: LateTitle\ntype: source\n---\n');
    await fixture.indexer.handleAdd(path.join(fixture.vaultDir, 'sources/late.md'));

    fixture.writeVaultFile('sources/origin.md', '---\ntitle: OriginTitle\ntype: source\n---\nrefs [[late]]');
    fixture.ragClient.entityExists = vi.fn().mockResolvedValue(true);
    fixture.ragClient.createRelation = vi.fn().mockResolvedValue(undefined);
    await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'sources/origin.md'));
    expect(fixture.ragClient.entityExists).toHaveBeenCalledWith('LateTitle');
  });

  it('picks up renamed titles: changing a target file updates resolution', async () => {
    const fixture = await makeIndexerFixture();
    fixture.writeVaultFile('sources/d.md', '---\ntitle: Delta\ntype: source\n---\n');
    await fixture.indexer.start();
    fixture.writeVaultFile('sources/d.md', '---\ntitle: Delta Renamed\ntype: source\n---\n');
    await fixture.indexer.handleChange(path.join(fixture.vaultDir, 'sources/d.md'));

    fixture.writeVaultFile('sources/o.md', '---\ntitle: Origin\ntype: source\n---\nrefs [[d]]');
    fixture.ragClient.entityExists = vi.fn().mockResolvedValue(true);
    fixture.ragClient.createRelation = vi.fn().mockResolvedValue(undefined);
    await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'sources/o.md'));
    expect(fixture.ragClient.entityExists).toHaveBeenCalledWith('Delta Renamed');
  });

  it('forgets unlinked files: wikilinks to an unlinked target fall back to slugToTitle', async () => {
    const fixture = await makeIndexerFixture();
    fixture.writeVaultFile('sources/gone.md', '---\ntitle: GoneTitle\ntype: source\n---\n');
    await fixture.indexer.start();
    await fixture.indexer.handleUnlink(path.join(fixture.vaultDir, 'sources/gone.md'));

    fixture.writeVaultFile('sources/o.md', '---\ntitle: Origin\ntype: source\n---\nrefs [[gone]]');
    fixture.ragClient.entityExists = vi.fn().mockResolvedValue(false);
    const warnSpy = vi.spyOn(logger, 'warn');
    await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'sources/o.md'));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'gone' }),
      expect.stringContaining('not in slug-title map'),
    );
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/rag/indexer.test.ts -t "slug→title"`
Expected: FAIL — `slugTitleMap`, `start`, `handleAdd`, `handleChange` don't exist.

- [ ] **Step 3: Implement the map**

`RagIndexer.start()` does **not currently exist** — the watcher is attached inline in the constructor. Refactor first: extract the chokidar attachment into a new `start()` method (zero behavior change), confirm tests still pass, then layer the map work on top. This keeps the diff reviewable.

In `src/rag/indexer.ts`:

```typescript
import { readdirSync } from 'node:fs';
// ... existing imports

export class RagIndexer {
  // ... existing fields
  // Map kept private — tests cover behavior, not internal state.
  private slugTitleMap = new Map<string, string>();

  async start(): Promise<void> {
    const allowed = ALLOWED_PATHS;
    for (const dir of allowed) {
      const full = join(this.vaultDir, dir);
      let entries: string[] = [];
      try { entries = readdirSync(full); } catch { continue; }
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        this.indexSlugTitle(join(full, entry));
      }
    }
    // Existing chokidar wiring — bind handlers below
  }

  private indexSlugTitle(filePath: string): void {
    let raw: string;
    try { raw = readFileSync(filePath, 'utf-8'); } catch { return; }
    const { data: fm } = parseFrontmatter(raw);
    const slug = path.basename(filePath, '.md');
    const title = String(fm.title || '').trim();
    if (title) this.slugTitleMap.set(slug, title);
  }

  async handleAdd(filePath: string): Promise<void> {
    if (!filePath.endsWith('.md')) return;
    this.indexSlugTitle(filePath);
    await this.indexFile(filePath);
  }

  async handleChange(filePath: string): Promise<void> {
    if (!filePath.endsWith('.md')) return;
    this.indexSlugTitle(filePath);
    await this.indexFile(filePath);
  }

  async handleUnlink(filePath: string): Promise<void> {
    if (!filePath.endsWith('.md')) return;
    const slug = path.basename(filePath, '.md');
    this.slugTitleMap.delete(slug);
    // ... existing unlink logic from old method
  }
}
```

In `injectWikilinks`, replace any disk-based target resolution with `this.slugTitleMap.get(target) ?? slugToTitle(target)`. When the map has no entry, log a warning. Wire chokidar to `handleAdd`/`handleChange`/`handleUnlink` (existing wiring presumably calls `indexFile`/`handleUnlink` directly — point them at the new entry methods instead).

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/rag/indexer.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/rag/indexer.ts src/rag/indexer.test.ts
git commit -m "feat(rag): in-memory slug→title map for wikilink resolution"
```

---

### Task 12: Restricted frontmatter wikilink scan

**Files:**
- Modify: `src/vault/wikilinks.ts` (add new export)
- Modify: `src/rag/indexer.ts` (use the new helper in `injectWikilinks`)
- Test: `src/vault/wikilinks.test.ts`, `src/rag/indexer.test.ts`

Tighten frontmatter scanning to a known allowlist: `source_summary`, `library`, `links_to`, `related`. Body wikilinks remain fully scanned. Spurious frontmatter strings (`description: "see [[foo]]"`) no longer produce edges.

- [ ] **Step 1: Write the failing test**

Append to `src/vault/wikilinks.test.ts`:

```typescript
import { extractFrontmatterWikilinks } from './wikilinks.js';

describe('extractFrontmatterWikilinks', () => {
  const allowlist = ['source_summary', 'library', 'links_to', 'related'];

  it('walks values from the allowlist, returning target + originating field', () => {
    const fm = { source_summary: '[[foo]]', library: '[[library/bar]]' };
    const links = extractFrontmatterWikilinks(fm, allowlist);
    expect(links).toEqual([
      { target: 'foo', field: 'source_summary' },
      { target: 'library/bar', field: 'library' },
    ]);
  });

  it('walks arrays', () => {
    const fm = { related: ['[[a]]', '[[b]]'] };
    const links = extractFrontmatterWikilinks(fm, allowlist);
    expect(links).toEqual([
      { target: 'a', field: 'related' },
      { target: 'b', field: 'related' },
    ]);
  });

  it('ignores fields not in the allowlist', () => {
    const fm = { description: 'see [[foo]]', tags: ['[[bar]]'], title: '[[baz]]' };
    const links = extractFrontmatterWikilinks(fm, allowlist);
    expect(links).toEqual([]);
  });
});
```

Append to `src/rag/indexer.test.ts`:

```typescript
it('does not produce edges from arbitrary frontmatter fields', async () => {
  const fixture = await makeIndexerFixture();
  fixture.writeVaultFile('sources/origin.md',
    '---\ntitle: Origin\ntype: source\ndescription: "see [[ghost]]"\n---\nbody');
  fixture.ragClient.entityExists = vi.fn().mockResolvedValue(true);
  fixture.ragClient.createRelation = vi.fn().mockResolvedValue(undefined);
  await fixture.indexer.start();
  await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'sources/origin.md'));
  expect(fixture.ragClient.createRelation).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/vault/wikilinks.test.ts -t "extractFrontmatterWikilinks"`
Expected: FAIL — `extractFrontmatterWikilinks` does not exist.

- [ ] **Step 3: Implement and consume**

In `src/vault/wikilinks.ts`, add:

```typescript
export interface FrontmatterWikilink {
  target: string;
  field: string;  // originating frontmatter field — used by T13's keyword routing
}

export function extractFrontmatterWikilinks(
  fm: Record<string, unknown>,
  allowlist: readonly string[],
): FrontmatterWikilink[] {
  const out: FrontmatterWikilink[] = [];
  const wikilinkRe = /\[\[([^\]]+)\]\]/g;
  for (const field of allowlist) {
    const value = fm[field];
    const candidates = Array.isArray(value) ? value : [value];
    for (const c of candidates) {
      if (typeof c !== 'string') continue;
      let m: RegExpExecArray | null;
      while ((m = wikilinkRe.exec(c)) !== null) {
        out.push({ target: m[1].trim(), field });
      }
      wikilinkRe.lastIndex = 0;
    }
  }
  return out;
}
```

In `src/rag/indexer.ts`, modify `injectWikilinks` to compose body and frontmatter scans:

```typescript
const FRONTMATTER_LINK_FIELDS = ['source_summary', 'library', 'links_to', 'related'] as const;

async injectWikilinks(content: string, frontmatter: Record<string, unknown>): Promise<void> {
  // Body links: scan body only, not raw content (to avoid frontmatter double-scan).
  const { content: body } = parseFrontmatter(content);
  const bodyLinks = extractWikilinks(body);
  const fmLinks = extractFrontmatterWikilinks(frontmatter, FRONTMATTER_LINK_FIELDS);
  const allLinks = [...bodyLinks, ...fmLinks];
  // ... rest unchanged
}
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/vault/wikilinks.test.ts src/rag/indexer.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/vault/wikilinks.ts src/vault/wikilinks.test.ts src/rag/indexer.ts src/rag/indexer.test.ts
git commit -m "feat(rag): restrict frontmatter wikilink scan to known fields"
```

---

### Task 13: Bidirectional edges with distinct keywords

**Files:**
- Modify: `src/rag/indexer.ts` (`injectWikilinks` keyword selection)
- Test: `src/rag/indexer.test.ts`

Change the keyword string per origin field: `library:` field on a source note → `summarizes, full_text`; `source_summary:` field on a library file → `summarized_by, summary`; everything else → existing `references, wikilink`.

- [ ] **Step 1: Write the failing test**

Append to `src/rag/indexer.test.ts`:

```typescript
describe('bidirectional source↔library edges', () => {
  it('source.library → library uses summarizes/full_text keywords', async () => {
    const fixture = await makeIndexerFixture();
    fixture.writeVaultFile('library/foo.md', '---\ntitle: FooLib\ntype: library\n---\nbody');
    fixture.writeVaultFile('sources/foo.md', '---\ntitle: FooSrc\ntype: source\nlibrary: "[[library/foo]]"\n---\n');
    fixture.ragClient.entityExists = vi.fn().mockResolvedValue(true);
    fixture.ragClient.createRelation = vi.fn().mockResolvedValue(undefined);
    await fixture.indexer.start();
    await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'sources/foo.md'));
    expect(fixture.ragClient.createRelation).toHaveBeenCalledWith(
      'FooSrc', 'FooLib',
      expect.objectContaining({ keywords: 'summarizes, full_text' }),
    );
  });

  it('library.source_summary → source uses summarized_by/summary', async () => {
    const fixture = await makeIndexerFixture();
    fixture.writeVaultFile('sources/foo.md', '---\ntitle: FooSrc\ntype: source\n---\nbody');
    fixture.writeVaultFile('library/foo.md', '---\ntitle: FooLib\ntype: library\nsource_summary: "[[foo]]"\n---\n');
    fixture.ragClient.entityExists = vi.fn().mockResolvedValue(true);
    fixture.ragClient.createRelation = vi.fn().mockResolvedValue(undefined);
    await fixture.indexer.start();
    await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'library/foo.md'));
    expect(fixture.ragClient.createRelation).toHaveBeenCalledWith(
      'FooLib', 'FooSrc',
      expect.objectContaining({ keywords: 'summarized_by, summary' }),
    );
  });

  it('body wikilinks still use references/wikilink', async () => {
    const fixture = await makeIndexerFixture();
    fixture.writeVaultFile('sources/a.md', '---\ntitle: A\ntype: source\n---\n');
    fixture.writeVaultFile('sources/b.md', '---\ntitle: B\ntype: source\n---\nrefs [[a]]');
    fixture.ragClient.entityExists = vi.fn().mockResolvedValue(true);
    fixture.ragClient.createRelation = vi.fn().mockResolvedValue(undefined);
    await fixture.indexer.start();
    await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'sources/b.md'));
    expect(fixture.ragClient.createRelation).toHaveBeenCalledWith(
      'B', 'A',
      expect.objectContaining({ keywords: 'references, wikilink' }),
    );
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/rag/indexer.test.ts -t "bidirectional"`
Expected: FAIL — current code uses single keyword string for all links.

- [ ] **Step 3: Route keywords by source field**

`extractFrontmatterWikilinks` already returns `{ target, field }[]` (T12). In `src/rag/indexer.ts`, switch the keyword string per source field:

```typescript
type LinkSource = { kind: 'body' } | { kind: 'frontmatter'; field: string };

function keywordsFor(source: LinkSource, fileType: string): string {
  if (source.kind === 'frontmatter' && source.field === 'library' && fileType === 'source') {
    return 'summarizes, full_text';
  }
  if (source.kind === 'frontmatter' && source.field === 'source_summary' && fileType === 'library') {
    return 'summarized_by, summary';
  }
  return 'references, wikilink';
}
```

In `injectWikilinks`, pass `LinkSource` for each link and use `keywordsFor(source, type)` when invoking `createRelation`. Update the body-link scan to tag `{ kind: 'body' }`. Update the description string in the relation payload to match the keyword pair.

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/rag/indexer.test.ts src/vault/wikilinks.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/rag/indexer.ts src/vault/wikilinks.ts src/rag/indexer.test.ts src/vault/wikilinks.test.ts
git commit -m "feat(rag): distinct keywords for source↔library edges"
```

---

### Task 14: Library timeout overrides + path detection (POSIX + Windows)

**Files:**
- Modify: `src/rag/indexer.ts`, `src/rag/rag-client.ts`
- Test: `src/rag/indexer.test.ts`, `src/rag/rag-client.test.ts`

Library round-trips need bumped timeouts (POST 60s, poll 1.2M ms). Detection uses `/` and `\\`.

- [ ] **Step 1: Write the failing test**

Append to `src/rag/indexer.test.ts`:

```typescript
describe('library file timeouts', () => {
  it('passes 60s POST and 1_200_000 ms poll for library files', async () => {
    const fixture = await makeIndexerFixture();
    fixture.writeVaultFile('library/foo.md', '---\ntitle: F\ntype: library\n---\nbody');
    await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'library/foo.md'));
    expect(fixture.ragClient.indexCalls[0].timeoutMs).toBe(60_000);
    expect(fixture.ragClient.indexCalls[0].pollTimeoutMs).toBe(1_200_000);
  });

  it('uses default timeouts for non-library files', async () => {
    const fixture = await makeIndexerFixture();
    fixture.writeVaultFile('sources/foo.md', '---\ntitle: F\ntype: source\n---\nbody');
    await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'sources/foo.md'));
    expect(fixture.ragClient.indexCalls[0].timeoutMs).toBeUndefined();
    expect(fixture.ragClient.indexCalls[0].pollTimeoutMs).toBeUndefined();
  });

  it('detects library/ paths on Windows-style separators too', () => {
    expect(isLibraryPath('library/foo.md')).toBe(true);
    expect(isLibraryPath('library\\foo.md')).toBe(true);
    expect(isLibraryPath('sources/library-thing.md')).toBe(false); // not a library file, just contains substring
  });
});
```

`isLibraryPath` will be a small exported helper.

Append to `src/rag/rag-client.test.ts`:

```typescript
it('passes per-call timeoutMs and pollTimeoutMs through to underlying fetch', async () => {
  const fetchMock = vi.fn().mockResolvedValue(/* successful index response */);
  const client = new RagClient({ fetch: fetchMock });
  await client.index('content', { fileSource: 'x.md', timeoutMs: 60_000, pollTimeoutMs: 1_200_000 });
  // assert fetch was called with AbortSignal that times out at 60_000ms — match existing test idiom
});
```

If `RagClient` doesn't currently accept per-call options, the test pins what it should accept.

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/rag/indexer.test.ts src/rag/rag-client.test.ts -t "timeout"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/rag/indexer.ts`:

```typescript
export function isLibraryPath(relPath: string): boolean {
  return relPath.startsWith('library/') || relPath.startsWith('library\\');
}
```

In `indexFile`, before the `ragClient.index` call:

```typescript
const opts: { fileSource: string; timeoutMs?: number; pollTimeoutMs?: number } = { fileSource: relPath };
if (isLibraryPath(relPath)) {
  opts.timeoutMs = 60_000;
  opts.pollTimeoutMs = 1_200_000;
}
await this.ragClient.index(indexed, opts);
```

In `src/rag/rag-client.ts`, accept the new fields on the `index` method options object and pass `timeoutMs` to the AbortController for the POST and `pollTimeoutMs` to the polling loop. Match existing patterns in that file.

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/rag/indexer.test.ts src/rag/rag-client.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/rag/indexer.ts src/rag/rag-client.ts src/rag/indexer.test.ts src/rag/rag-client.test.ts
git commit -m "feat(rag): bumped timeouts for library file indexing"
```

---

### Task 15: Library indexing logs body length and elapsed ms

**Files:**
- Modify: `src/rag/indexer.ts`
- Test: `src/rag/indexer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('logs body length and elapsed ms after a library index', async () => {
  const fixture = await makeIndexerFixture();
  fixture.writeVaultFile('library/foo.md', '---\ntitle: F\ntype: library\n---\nABCDE');
  const infoSpy = vi.spyOn(logger, 'info');
  await fixture.indexer.indexFile(path.join(fixture.vaultDir, 'library/foo.md'));
  expect(infoSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      relPath: 'library/foo.md',
      bodyLen: expect.any(Number),
      elapsedMs: expect.any(Number),
    }),
    expect.stringContaining('library indexed'),
  );
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run src/rag/indexer.test.ts -t "elapsed"`
Expected: FAIL.

- [ ] **Step 3: Add timing + log**

In `indexFile`, wrap the `ragClient.index` call:

```typescript
if (isLibraryPath(relPath)) {
  const t0 = Date.now();
  await this.ragClient.index(indexed, opts);
  logger.info(
    { relPath, bodyLen: body.length, elapsedMs: Date.now() - t0 },
    'rag: library indexed',
  );
} else {
  await this.ragClient.index(indexed, opts);
}
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/rag/indexer.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/rag/indexer.ts src/rag/indexer.test.ts
git commit -m "feat(rag): log body length and elapsed ms for library indexes"
```

---

## Phase 5 — `vault_section` MCP server

### Task 16: Section locator (heading match, multi-match disambiguation)

**Files:**
- Create: `container/agent-runner/src/vault-mcp-stdio.ts`
- Test: `container/agent-runner/src/vault-mcp-stdio.test.ts`

Implement section-by-heading first; page and range come next. The MCP server is registered in Task 19.

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/vault-mcp-stdio.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vaultSection } from './vault-mcp-stdio.js';

const sample = `---
title: Sample
---

# Top

intro

## Introduction

intro body line 1
intro body line 2

## Methods

methods body

## Introduction (Appendix)

duplicate header
`;

describe('vaultSection (section locator)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vault-mcp-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns the matching H2 section with header line', () => {
    const file = join(dir, 's.md');
    writeFileSync(file, sample, 'utf-8');
    const result = vaultSection(file, { section: 'Methods' });
    expect(result.header).toMatch(/^File: .*\/s\.md \/ Section: Methods \/ Page \d+ \/ Lines \d+-\d+$/);
    expect(result.content).toContain('methods body');
    expect(result.multipleMatches).toBeUndefined();
  });

  it('case-insensitive substring match', () => {
    const file = join(dir, 's.md');
    writeFileSync(file, sample, 'utf-8');
    const result = vaultSection(file, { section: 'method' });
    expect(result.content).toContain('methods body');
  });

  it('first match in document order on collision, with multiple_matches', () => {
    const file = join(dir, 's.md');
    writeFileSync(file, sample, 'utf-8');
    const result = vaultSection(file, { section: 'Introduction' });
    expect(result.content).toContain('intro body line 1');
    expect(result.multipleMatches).toBe(2);
    expect(result.matchingHeadings).toEqual(['Introduction', 'Introduction (Appendix)']);
  });

  it('returns available sections list on miss', () => {
    const file = join(dir, 's.md');
    writeFileSync(file, sample, 'utf-8');
    const result = vaultSection(file, { section: 'Conclusion' });
    expect(result.notFound).toBe(true);
    expect(result.availableSections).toEqual(
      expect.arrayContaining(['Top', 'Introduction', 'Methods', 'Introduction (Appendix)']),
    );
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run container/agent-runner/src/vault-mcp-stdio.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `vaultSection` (section branch only)**

Create `container/agent-runner/src/vault-mcp-stdio.ts`:

```typescript
import { readFileSync } from 'node:fs';

export interface VaultSectionResult {
  header: string;
  content: string;
  multipleMatches?: number;
  matchingHeadings?: string[];
  notFound?: boolean;
  availableSections?: string[];
  truncated?: boolean;
}

export type VaultSectionLocator =
  | { section: string }
  | { page: number }
  | { range: { start: number; end: number } };

interface ParsedHeading { line: number; text: string; level: number; }

function parseHeadings(lines: string[]): ParsedHeading[] {
  const heads: ParsedHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) heads.push({ line: i, text: m[2], level: m[1].length });
  }
  return heads;
}

export function vaultSection(filePath: string, locator: VaultSectionLocator): VaultSectionResult {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const headings = parseHeadings(lines);

  if ('section' in locator) {
    const needle = locator.section.toLowerCase();
    const matches = headings.filter(h => h.text.toLowerCase().includes(needle));
    if (matches.length === 0) {
      return {
        header: `File: ${filePath} / Section: <not found>`,
        content: '',
        notFound: true,
        availableSections: headings.map(h => h.text),
      };
    }
    const chosen = matches[0];
    const next = headings.find(h => h.line > chosen.line && h.level <= chosen.level);
    const startLine = chosen.line;
    const endLine = next ? next.line - 1 : lines.length - 1;
    const content = lines.slice(startLine, endLine + 1).join('\n');
    const page = pageOfLine(lines, startLine);
    const result: VaultSectionResult = {
      header: `File: ${filePath} / Section: ${chosen.text} / Page ${page} / Lines ${startLine + 1}-${endLine + 1}`,
      content,
    };
    if (matches.length > 1) {
      result.multipleMatches = matches.length;
      result.matchingHeadings = matches.map(m => m.text);
    }
    return result;
  }

  // page / range branches: implemented in next tasks
  throw new Error('not yet implemented');
}

// Verified Docling marker format from data/extractions/*/content.clean.md:
//   <!-- page:1 label:section_header -->
//   <!-- page:1 label:text -->
//   <!-- page:2 label:picture -->
// Multiple markers per page (one per chunk). Capture the integer after `page:`.
const PAGE_MARKER_RE = /^<!-- page:(\d+) /;

function pageOfLine(lines: string[], targetLine: number): number {
  // Walk backwards from targetLine until we find a page marker. Default to 1 if none.
  for (let i = Math.min(targetLine, lines.length - 1); i >= 0; i--) {
    const m = lines[i].match(PAGE_MARKER_RE);
    if (m) return parseInt(m[1], 10);
  }
  return 1;
}
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run container/agent-runner/src/vault-mcp-stdio.test.ts`
Expected: section tests pass; page-related stub returns `1` (acceptable for now).

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/vault-mcp-stdio.ts container/agent-runner/src/vault-mcp-stdio.test.ts
git commit -m "feat(mcp): vault_section heading-match locator"
```

---

### Task 17: Page locator

**Files:**
- Modify: `container/agent-runner/src/vault-mcp-stdio.ts`
- Test: `container/agent-runner/src/vault-mcp-stdio.test.ts`

- [ ] **Step 1: Page-marker format is verified**

Docling emits markers like `<!-- page:1 label:section_header -->` — multiple per page (one per chunk). The regex `/^<!-- page:(\d+) /` (already pinned in T16's implementation) captures the page number. **No further verification needed.** First marker for a page is the page boundary; subsequent markers on the same page are intra-page chunks.

- [ ] **Step 2: Write the failing test**

Append:

```typescript
describe('vaultSection (page locator)', () => {
  it('returns content between first markers of page N and page N+1', () => {
    const file = join(dir, 'paged.md');
    writeFileSync(file, [
      '---', 'title: P', '---', '',
      '<!-- page:1 label:section_header -->',
      '## Intro',
      '<!-- page:1 label:text -->',
      'page one body',
      '<!-- page:2 label:text -->',
      'page two body',
      '<!-- page:3 label:text -->',
      'page three body',
    ].join('\n'), 'utf-8');
    const result = vaultSection(file, { page: 2 });
    expect(result.content).toContain('page two body');
    expect(result.content).not.toContain('page one body');
    expect(result.content).not.toContain('page three body');
    // Header MUST include all four fields per spec §4.
    expect(result.header).toMatch(/^File: .*\/paged\.md \/ Section: .+ \/ Page 2 \/ Lines \d+-\d+$/);
  });

  it('uses nearest enclosing heading at-or-before page start as Section', () => {
    const file = join(dir, 'paged.md');
    writeFileSync(file, [
      '<!-- page:1 label:section_header -->',
      '## Methods',
      '<!-- page:2 label:text -->',
      'page two body',
    ].join('\n'), 'utf-8');
    const result = vaultSection(file, { page: 2 });
    expect(result.header).toContain('Section: Methods');
  });

  it('uses <page-only> when no heading precedes the page start', () => {
    const file = join(dir, 'paged.md');
    writeFileSync(file, [
      '<!-- page:1 label:text -->',
      'page one (no heading)',
      '<!-- page:2 label:text -->',
      'page two body',
    ].join('\n'), 'utf-8');
    const result = vaultSection(file, { page: 1 });
    expect(result.header).toContain('Section: <page-only>');
  });

  it('miss returns total page count', () => {
    const file = join(dir, 'paged.md');
    writeFileSync(file, '<!-- page:1 label:text -->\na\n<!-- page:2 label:text -->\nb', 'utf-8');
    const result = vaultSection(file, { page: 99 });
    expect(result.notFound).toBe(true);
    expect(result.header).toContain('total pages: 2');
  });
});
```

- [ ] **Step 3: Run — expect failure**

Run: `npx vitest run container/agent-runner/src/vault-mcp-stdio.test.ts -t "page locator"`
Expected: FAIL — `not yet implemented` thrown.

- [ ] **Step 4: Implement page branch**

Add a helper that finds the **first** marker per page (subsequent markers on the same page are intra-page chunks, not boundaries):

```typescript
function findPageBoundaries(lines: string[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PAGE_MARKER_RE);
    if (m) {
      const page = parseInt(m[1], 10);
      if (!map.has(page)) map.set(page, i);  // keep first marker only
    }
  }
  return map;
}

function nearestHeadingAtOrBefore(headings: ParsedHeading[], line: number): string | undefined {
  for (let i = headings.length - 1; i >= 0; i--) {
    if (headings[i].line <= line) return headings[i].text;
  }
  return undefined;
}

// inside vaultSection:
if ('page' in locator) {
  const boundaries = findPageBoundaries(lines);
  const totalPages = boundaries.size;
  const start = boundaries.get(locator.page);
  if (start === undefined) {
    return {
      header: `File: ${filePath} / Section: <not found> / Page <not found> / total pages: ${totalPages}`,
      content: '',
      notFound: true,
    };
  }
  const next = boundaries.get(locator.page + 1);
  const endLine = next !== undefined ? next - 1 : lines.length - 1;
  const section = nearestHeadingAtOrBefore(headings, start) ?? '<page-only>';
  return {
    header: `File: ${filePath} / Section: ${section} / Page ${locator.page} / Lines ${start + 1}-${endLine + 1}`,
    content: lines.slice(start, endLine + 1).join('\n'),
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run container/agent-runner/src/vault-mcp-stdio.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/vault-mcp-stdio.ts container/agent-runner/src/vault-mcp-stdio.test.ts
git commit -m "feat(mcp): vault_section page locator"
```

---

### Task 18: Range locator + 500-line cap

**Files:**
- Modify: `container/agent-runner/src/vault-mcp-stdio.ts`
- Test: `container/agent-runner/src/vault-mcp-stdio.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('vaultSection (range locator)', () => {
  it('returns the requested line range with all four header fields', () => {
    const file = join(dir, 'r.md');
    const lines = ['<!-- page:1 label:text -->', '## Heading One', ...Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)];
    writeFileSync(file, lines.join('\n'), 'utf-8');
    const result = vaultSection(file, { range: { start: 5, end: 15 } });
    // Header MUST include Section, Page, Lines per spec §4.
    expect(result.header).toMatch(/^File: .*\/r\.md \/ Section: Heading One \/ Page 1 \/ Lines 5-15$/);
  });

  it('uses <range> when no heading precedes the start line', () => {
    const file = join(dir, 'r.md');
    writeFileSync(file, 'plain\nlines\nonly\nno\nheadings\n', 'utf-8');
    const result = vaultSection(file, { range: { start: 1, end: 3 } });
    expect(result.header).toContain('Section: <range>');
    expect(result.header).toContain('Page 1');
  });

  it('caps at 500 lines and sets truncated', () => {
    const file = join(dir, 'r.md');
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    writeFileSync(file, lines.join('\n'), 'utf-8');
    const result = vaultSection(file, { range: { start: 1, end: 1000 } });
    expect(result.content.split('\n')).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.header).toMatch(/Lines 1-500/);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run container/agent-runner/src/vault-mcp-stdio.test.ts -t "range"`
Expected: FAIL.

- [ ] **Step 3: Implement range branch**

```typescript
const MAX_RANGE_LINES = 500;

if ('range' in locator) {
  const startIdx = Math.max(0, locator.range.start - 1);
  const requestedEnd = Math.max(startIdx, locator.range.end - 1);
  const cappedEnd = Math.min(requestedEnd, startIdx + MAX_RANGE_LINES - 1, lines.length - 1);
  const truncated = cappedEnd < requestedEnd;
  const content = lines.slice(startIdx, cappedEnd + 1).join('\n');
  const section = nearestHeadingAtOrBefore(headings, startIdx) ?? '<range>';
  const page = pageOfLine(lines, startIdx);
  return {
    header: `File: ${filePath} / Section: ${section} / Page ${page} / Lines ${startIdx + 1}-${cappedEnd + 1}`,
    content,
    truncated: truncated || undefined,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run container/agent-runner/src/vault-mcp-stdio.test.ts`

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/vault-mcp-stdio.ts container/agent-runner/src/vault-mcp-stdio.test.ts
git commit -m "feat(mcp): vault_section range locator with 500-line cap"
```

---

### Task 19: MCP stdio wrapper + mount in agent runner

**Files:**
- Modify: `container/agent-runner/src/vault-mcp-stdio.ts` (add stdio entry point)
- Modify: `container/agent-runner/src/index.ts:432`

The MCP server has been a pure-function library so far. Add the stdio bootstrap and mount it.

- [ ] **Step 1: Verify the rag MCP stdio shape**

Read `container/agent-runner/src/rag-mcp-stdio.ts` (sibling file). Identify the exact MCP SDK pattern (likely `@modelcontextprotocol/sdk`). Match it precisely — schema definition, tool registration, stdio transport.

- [ ] **Step 2: Add the stdio bootstrap**

Append to `container/agent-runner/src/vault-mcp-stdio.ts`:

```typescript
// Stdio entry point — matches sibling rag-mcp-stdio.ts pattern.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const VAULT_DIR = process.env.VAULT_DIR; // injected by container-runner mount
if (!VAULT_DIR) throw new Error('VAULT_DIR env var required');

const server = new Server({ name: 'vault', version: '1.0.0' }, { capabilities: { tools: {} } });

// Tool schema (match the Zod/JSON-schema pattern used by rag-mcp-stdio.ts)
server.setRequestHandler(/* ListToolsRequest */, async () => ({
  tools: [{
    name: 'vault_section',
    description: 'Extract a section, page, or line range from a vault markdown file. Returns header line + content. On heading collision, returns first match with multipleMatches/matchingHeadings.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path' },
        section: { type: 'string', description: 'Heading text (case-insensitive substring match)' },
        page: { type: 'number', description: 'Page number (uses Docling markers)' },
        range: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } },
      },
      required: ['path'],
    },
  }],
}));

server.setRequestHandler(/* CallToolRequest */, async (req) => {
  if (req.params.name !== 'vault_section') throw new Error(`Unknown tool: ${req.params.name}`);
  const args = req.params.arguments as { path: string; section?: string; page?: number; range?: { start: number; end: number } };
  const fullPath = join(VAULT_DIR, args.path);
  const locator: VaultSectionLocator =
    args.section !== undefined ? { section: args.section } :
    args.page !== undefined ? { page: args.page } :
    args.range !== undefined ? { range: args.range } :
    (() => { throw new Error('Provide one of: section, page, range'); })();
  const result = vaultSection(fullPath, locator);
  return { content: [{ type: 'text', text: formatResult(result) }] };
});

function formatResult(r: VaultSectionResult): string {
  const lines = [r.header];
  if (r.notFound && r.availableSections) {
    lines.push('', 'Available sections:', ...r.availableSections.map(s => `- ${s}`));
  } else {
    if (r.multipleMatches) lines.push(`(multiple_matches: ${r.multipleMatches}, matching: ${r.matchingHeadings?.join(', ')})`);
    if (r.truncated) lines.push('(truncated to 500 lines)');
    lines.push('', r.content);
  }
  return lines.join('\n');
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

Replace `/* ListToolsRequest */` and `/* CallToolRequest */` with the actual schema imports used by `rag-mcp-stdio.ts`.

- [ ] **Step 3: Mount in agent runner**

In `container/agent-runner/src/index.ts`, locate the `mcpServers` object (starts at ~line 421). Inside it, alongside the conditional `rag` entry (~line 432), add a sibling `vault` entry:

```typescript
mcpServers: {
  // existing entries unchanged
  rag: {
    command: 'node',
    args: [path.join(path.dirname(mcpServerPath), 'rag-mcp-stdio.js')],
    env: { /* existing */ },
  },
  vault: {
    command: 'node',
    args: [path.join(path.dirname(mcpServerPath), 'vault-mcp-stdio.js')],
    env: { ...process.env, VAULT_DIR: containerInput.vaultDir /* match the rag entry's vault path injection */ },
  },
},
```

In the `disallowedTools`/allowed-tools list (around line 414), add `'mcp__vault__*'`.

- [ ] **Step 4: Build and smoke-test**

Run: `cd container/agent-runner && npm run build && cd ../..`

Smoke-test the stdio server directly:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | VAULT_DIR=/tmp node container/agent-runner/dist/vault-mcp-stdio.js
```
Expected: a JSON response listing `vault_section`. (No vitest test for the stdio bootstrap — the pure functions are covered.)

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/vault-mcp-stdio.ts container/agent-runner/src/index.ts
git commit -m "feat(mcp): mount vault MCP server alongside rag MCP"
```

---

### Task 20: Add "Reading library files" to group CLAUDE.md files

**Files:**
- Modify: `groups/main/CLAUDE.md`, `groups/study/CLAUDE.md`, `groups/study-generator/CLAUDE.md`

Verbatim insert from spec §4. No tests — these are config files.

- [ ] **Step 1: Append the verbatim block to each file**

Append the following exact block to the bottom of each of the three files:

```markdown

## Reading library files

`vault/library/*.md` files hold the raw cleaned text of every ingested source. They are long — entire books and full-text papers. Reading one inline will exhaust the context window. Follow this protocol:

1. **Start with the source note.** `vault/sources/{slug}.md` is the agent-authored synthesis and shows the document's logical flow. Read this first to orient before touching the library file.
2. **Target sections, don't open the whole file.** Use `mcp__vault__vault_section(path, { section: "<heading>" })` or `{ page: <N> }` or `{ range: { start, end } }` to pull just the part you need. The response header line includes `Section`, `Page`, and `Lines` for citation.
3. **Dispatch a subagent for full-document work.** Summarization, cross-document searches, or broad analysis go through a `Task` subagent invoked with the library file path — never read the full body in your own context.
4. **Cite by section and page.** When you reference library content, include the heading and page number from the `vault_section` header line. Citations to library files without section + page are not allowed.
```

- [ ] **Step 2: Commit**

```bash
git add groups/main/CLAUDE.md groups/study/CLAUDE.md groups/study-generator/CLAUDE.md
git commit -m "docs(groups): add 'Reading library files' protocol to group prompts"
```

---

## Phase 6 — Backfill script

### Task 21: Concurrency guard

**Files:**
- Create: `scripts/backfill-library.ts` (skeleton + guard)
- Test: `scripts/backfill-library.test.ts`

The guard refuses to run when NanoClaw is detected (process named `tsx src/index.ts`).

- [ ] **Step 1: Write the failing test**

Create `scripts/backfill-library.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { assertNoLiveNanoclaw } from './backfill-library.js';

describe('assertNoLiveNanoclaw', () => {
  it('throws when a tsx src/index.ts process is running', async () => {
    const spawnStub = vi.fn().mockResolvedValue({
      stdout: '12345 node tsx src/index.ts\n67890 node something-else\n',
    });
    await expect(assertNoLiveNanoclaw({ spawn: spawnStub })).rejects.toThrow(/NanoClaw is running/);
  });

  it('passes when no nanoclaw process is detected', async () => {
    const spawnStub = vi.fn().mockResolvedValue({ stdout: '12345 node something-else\n' });
    await expect(assertNoLiveNanoclaw({ spawn: spawnStub })).resolves.toBeUndefined();
  });

  it('--force-unsafe-concurrent bypasses the guard', async () => {
    const spawnStub = vi.fn().mockResolvedValue({ stdout: '12345 node tsx src/index.ts\n' });
    await expect(assertNoLiveNanoclaw({ spawn: spawnStub, force: true })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run scripts/backfill-library.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the guard**

Create `scripts/backfill-library.ts`:

```typescript
import { spawn } from 'node:child_process';

interface AssertOptions {
  spawn?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  force?: boolean;
}

async function defaultSpawn(cmd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('close', (code) => code === 0 ? resolve({ stdout }) : reject(new Error(`exit ${code}`)));
  });
}

export async function assertNoLiveNanoclaw(opts: AssertOptions = {}): Promise<void> {
  if (opts.force) return;
  const sp = opts.spawn ?? defaultSpawn;
  const { stdout } = await sp('ps', ['-axo', 'pid=,command=']);
  if (/tsx src\/index\.ts/.test(stdout)) {
    throw new Error(
      'NanoClaw is running. Stop it before running backfill (or pass --force-unsafe-concurrent for testing).',
    );
  }
}

// CLI entry — invoked via tsx scripts/backfill-library.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes('--force-unsafe-concurrent');
  await assertNoLiveNanoclaw({ force });
  // ... rest of script (added in subsequent tasks)
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run scripts/backfill-library.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-library.ts scripts/backfill-library.test.ts
git commit -m "feat(backfill): refuse to run while NanoClaw is live"
```

---

### Task 22: Walker + JSON report skeleton

**Files:**
- Modify: `scripts/backfill-library.ts`
- Test: `scripts/backfill-library.test.ts`

Walks `vault/sources/*.md`, accumulates a JSON report. Adds `--dry-run`, `--source`, `--report` flags.

- [ ] **Step 1: Write the failing test**

```typescript
describe('backfill walker', () => {
  it('reports a skip for already-libraried sources', async () => {
    const { vaultDir, run } = await makeBackfillFixture();
    writeSource(vaultDir, 'a', { title: 'A', source_file: 'upload/processed/x-a.pdf', library: '[[library/a]]' });
    const report = await run({ dryRun: true });
    expect(report.skipped).toContainEqual(expect.objectContaining({ slug: 'a', reason: 'skipped_existing' }));
  });

  it('reports missing_original when source_file is gone', async () => {
    const { vaultDir, run } = await makeBackfillFixture();
    writeSource(vaultDir, 'b', { title: 'B', source_file: 'upload/processed/missing.pdf' });
    const report = await run({ dryRun: true });
    expect(report.skipped).toContainEqual(expect.objectContaining({ slug: 'b', reason: 'missing_original' }));
  });

  it('--source filters to a single slug', async () => {
    const { vaultDir, run } = await makeBackfillFixture();
    writeSource(vaultDir, 'a', { title: 'A', source_file: 'x.pdf' });
    writeSource(vaultDir, 'b', { title: 'B', source_file: 'y.pdf' });
    const report = await run({ dryRun: true, source: 'a' });
    expect(report.totalSources).toBe(1);
  });

  it('writes JSON report to --report path', async () => {
    const { vaultDir, run, reportPath } = await makeBackfillFixture();
    await run({ dryRun: true });
    expect(JSON.parse(readFileSync(reportPath, 'utf-8'))).toMatchObject({ totalSources: expect.any(Number) });
  });
});
```

`makeBackfillFixture` is a local helper that creates a tmp vault, returns a `run({ dryRun, source, reportPath })` function that invokes the script's main exported entry (`runBackfill`).

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run scripts/backfill-library.test.ts -t "walker"`
Expected: FAIL.

- [ ] **Step 3: Implement the walker**

In `scripts/backfill-library.ts`:

```typescript
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '../src/vault/frontmatter.js';

export interface BackfillReport {
  startedAt: string;
  endedAt: string;
  totalSources: number;
  processed: number;
  skipped: { slug: string; reason: string; details?: string }[];
  errors: { slug: string; message: string }[];
}

export interface RunBackfillOptions {
  vaultDir: string;
  uploadProcessedDir: string;
  reportPath: string;
  dryRun: boolean;
  source?: string;        // single slug
  noPatchSource?: boolean;
  force?: boolean;
}

export async function runBackfill(opts: RunBackfillOptions): Promise<BackfillReport> {
  await assertNoLiveNanoclaw({ force: opts.force });
  const sourcesDir = join(opts.vaultDir, 'sources');
  const allSources = readdirSync(sourcesDir).filter(f => f.endsWith('.md'));
  const targets = opts.source ? allSources.filter(f => f === `${opts.source}.md`) : allSources;

  const report: BackfillReport = {
    startedAt: new Date().toISOString(),
    endedAt: '',
    totalSources: targets.length,
    processed: 0,
    skipped: [],
    errors: [],
  };

  for (const file of targets) {
    const slug = file.replace(/\.md$/, '');
    try {
      const raw = readFileSync(join(sourcesDir, file), 'utf-8');
      const { data: fm } = parseFrontmatter(raw);

      if (fm.library) {
        report.skipped.push({ slug, reason: 'skipped_existing' });
        continue;
      }

      const sourceFile = String(fm.source_file || '');
      const originalPath = sourceFile ? join(opts.vaultDir, '..', sourceFile) : '';
      if (!originalPath || !existsSync(originalPath)) {
        report.skipped.push({ slug, reason: 'missing_original', details: sourceFile });
        continue;
      }

      // Re-extract + write + patch — implemented in Task 23/24.
      // For Task 22, we only count it as processed in dry-run.
      if (opts.dryRun) {
        report.processed++;
        continue;
      }
      // (implementation follows in next tasks)
    } catch (err) {
      report.errors.push({ slug, message: err instanceof Error ? err.message : String(err) });
    }
  }

  report.endedAt = new Date().toISOString();
  writeFileSync(opts.reportPath, JSON.stringify(report, null, 2), 'utf-8');
  return report;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run scripts/backfill-library.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-library.ts scripts/backfill-library.test.ts
git commit -m "feat(backfill): walk sources and emit JSON report"
```

---

### Task 23: Re-extract + write library + patch source frontmatter + tracker delete

**Files:**
- Modify: `scripts/backfill-library.ts`
- Test: `scripts/backfill-library.test.ts`

Wire `Extractor.extract`, `writeLibraryFile`, `serializeFrontmatter`, and the tracker-row delete from `src/db.ts`.

- [ ] **Step 1: Verify or add the tracker delete API**

Run: `grep -n "deleteTrackedDoc\|tracked_doc\|rag_tracker" src/db.ts src/db/schema/rag.ts`

The pattern `getTrackedDoc`/`upsertTrackedDoc` exists per the indexer code (see `src/rag/indexer.ts:103,126`). If `deleteTrackedDoc(relPath)` already exists, use it. **If it does not**, add it now in `src/db.ts` matching the existing helpers' shape:

```typescript
export function deleteTrackedDoc(relPath: string): void {
  db.prepare('DELETE FROM rag_tracker WHERE rel_path = ?').run(relPath);
}
```

(Adjust column name to whatever `rag_tracker` actually uses — check `src/db/schema/rag.ts`.) Add a unit test in the existing `src/db.test.ts` file matching the surrounding style. Commit this as a separate prep commit before continuing T23 step 2:

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): deleteTrackedDoc helper for backfill force-reindex"
```

- [ ] **Step 2: Write the failing test**

```typescript
describe('backfill execute path (non-dry-run)', () => {
  it('writes library, patches source frontmatter, deletes tracker row', async () => {
    const { vaultDir, run, db } = await makeBackfillFixture();
    writeSource(vaultDir, 'paper', { title: 'Paper', source_file: 'upload/processed/jx-paper.pdf' });
    putFile(vaultDir, '../upload/processed/jx-paper.pdf', /* small fake PDF */);
    db.upsertTrackedDoc('sources/paper.md', 'docid-old', 'hash-old');

    await run({ dryRun: false });

    expect(existsSync(join(vaultDir, 'library', 'paper.md'))).toBe(true);
    const patched = readFileSync(join(vaultDir, 'sources', 'paper.md'), 'utf-8');
    expect(patched).toContain('library: "[[library/paper]]"');
    expect(db.getTrackedDoc('sources/paper.md')).toBeUndefined();
  });

  it('--no-patch-source preserves source frontmatter and tracker row', async () => {
    const { vaultDir, run, db } = await makeBackfillFixture();
    writeSource(vaultDir, 'p', { title: 'P', source_file: 'upload/processed/jx-p.pdf' });
    putFile(vaultDir, '../upload/processed/jx-p.pdf', /* fake */);
    db.upsertTrackedDoc('sources/p.md', 'd', 'h');

    await run({ dryRun: false, noPatchSource: true });

    const sourceContent = readFileSync(join(vaultDir, 'sources', 'p.md'), 'utf-8');
    expect(sourceContent).not.toContain('library:');
    expect(db.getTrackedDoc('sources/p.md')).toBeDefined();
  });
});
```

The test fixture must mock or stub `Extractor` since real Docling extraction is heavyweight; provide a fake that returns a fixed `cleanedContent` string.

- [ ] **Step 3: Run — expect failure**

Run: `npx vitest run scripts/backfill-library.test.ts -t "execute path"`
Expected: FAIL.

- [ ] **Step 4: Implement**

Replace the `// (implementation follows in next tasks)` block in `runBackfill` with:

```typescript
const { extractor } = opts;  // injected so tests can stub
const { cleanedContent } = await extractor.extract(slug, originalPath);

writeLibraryFile({
  libraryDir: join(opts.vaultDir, 'library'),
  slug,
  jobMeta: {
    title: String(fm.title || slug),
    sourceType: String(fm.source_type || 'paper'),
    ingestedFrom: sourceFile,
    jobId: String(fm.job_id || `backfill-${Date.now()}`),
    sourceSummarySlug: slug,
  },
  cleanedBody: cleanedContent,
});

if (!opts.noPatchSource) {
  const patched = serializeFrontmatter({ ...fm, library: `[[library/${slug}]]` }) + '\n' + body;
  const sourcePath = join(sourcesDir, file);
  const tmp = `${sourcePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, patched, 'utf-8');
  renameSync(tmp, sourcePath);
  deleteTrackedDoc(`sources/${slug}.md`);
}

report.processed++;
```

Add `extractor: ExtractorLike` to `RunBackfillOptions` and a default initializer in the CLI entry that constructs a real `Extractor`. `ExtractorLike` is `{ extract(slug, path): Promise<{ cleanedContent: string }> }` — narrow interface for testability.

Read `src/ingestion/extractor.ts` to confirm `extract`'s actual signature; the spec test names may need adjusting.

- [ ] **Step 5: Run tests**

Run: `npx vitest run scripts/backfill-library.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-library.ts scripts/backfill-library.test.ts
git commit -m "feat(backfill): re-extract, write library, patch source, delete tracker"
```

---

### Task 24: Direct library indexing in backfill

**Files:**
- Modify: `scripts/backfill-library.ts`
- Test: `scripts/backfill-library.test.ts`

Because NanoClaw is stopped, no chokidar watcher will pick up the new files. Backfill instantiates a `RagIndexer` and calls `indexFile()` directly.

- [ ] **Step 1: Write the failing test**

```typescript
it('directly indexes the new library file and the patched source note', async () => {
  const { vaultDir, run, mockRagClient } = await makeBackfillFixture();
  writeSource(vaultDir, 'p', { title: 'P', source_file: 'upload/processed/jx-p.pdf' });
  putFile(vaultDir, '../upload/processed/jx-p.pdf', /* fake */);

  await run({ dryRun: false });

  const indexedPaths = mockRagClient.indexCalls.map(c => c.fileSource);
  expect(indexedPaths).toEqual(expect.arrayContaining(['library/p.md', 'sources/p.md']));
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run scripts/backfill-library.test.ts -t "directly indexes"`
Expected: FAIL.

- [ ] **Step 3: Implement**

After the patch step in `runBackfill`:

```typescript
const indexer = opts.indexer; // injected; CLI builds a real one
await indexer.indexFile(join(opts.vaultDir, 'library', `${slug}.md`));
if (!opts.noPatchSource) {
  await indexer.indexFile(join(opts.vaultDir, 'sources', `${slug}.md`));
}
```

In the CLI entry, build the indexer:

```typescript
const indexer = new RagIndexer({ vaultDir, ragClient: new RagClient(/* ... */) });
await indexer.start(); // builds slug→title map
await runBackfill({ vaultDir, ..., indexer });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run scripts/backfill-library.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-library.ts scripts/backfill-library.test.ts
git commit -m "feat(backfill): index new library and patched source directly"
```

---

### Task 25: CLI flag parsing

**Files:**
- Modify: `scripts/backfill-library.ts`

Wire `--dry-run`, `--source`, `--report`, `--no-patch-source`, `--force-unsafe-concurrent` to the CLI entry point.

- [ ] **Step 1: Write a smoke test**

Append:

```typescript
it('CLI parses flags into RunBackfillOptions', () => {
  const opts = parseArgs(['--dry-run', '--source', 'foo', '--report', '/tmp/r.json']);
  expect(opts).toMatchObject({ dryRun: true, source: 'foo', reportPath: '/tmp/r.json' });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run scripts/backfill-library.test.ts -t "CLI parses"`
Expected: FAIL.

- [ ] **Step 3: Implement `parseArgs`**

```typescript
export function parseArgs(argv: string[]): Partial<RunBackfillOptions> {
  const opts: Partial<RunBackfillOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--source': opts.source = argv[++i]; break;
      case '--report': opts.reportPath = argv[++i]; break;
      case '--no-patch-source': opts.noPatchSource = true; break;
      case '--force-unsafe-concurrent': opts.force = true; break;
    }
  }
  return opts;
}
```

Wire it in the `import.meta.url` block.

- [ ] **Step 4: Run tests**

Run: `npx vitest run scripts/backfill-library.test.ts`

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-library.ts scripts/backfill-library.test.ts
git commit -m "feat(backfill): CLI flag parsing"
```

---

## Phase 7 — Integration & cleanup

### Task 26: End-to-end pipeline test (under-budget + over-budget)

**Files:**
- Modify: `src/ingestion/integration.test.ts`

Single test exercising the full pipeline with both budget paths in one run.

- [ ] **Step 1: Write the test**

```typescript
describe('end-to-end pipeline (under + over budget)', () => {
  it('both fixtures produce library files and bidirectional edges; oversized never observed', async () => {
    const fixture = await makeIngestionFixture();
    const stateLog: string[] = [];
    fixture.onStateTransition = (jobId, status) => stateLog.push(`${jobId}:${status}`);

    fixture.seedFreshUpload({ filename: 'small.pdf', cleanedContent: 'small body' }); // under budget
    fixture.seedFreshUpload({ filename: 'huge.pdf', cleanedContent: 'A'.repeat(800_000) }); // over budget

    await fixture.runUntilCompleted();

    // Both library files exist
    expect(existsSync(join(fixture.vaultDir, 'library', 'small.md'))).toBe(true);
    expect(existsSync(join(fixture.vaultDir, 'library', 'huge.md'))).toBe(true);

    // Both source notes exist
    expect(existsSync(join(fixture.vaultDir, 'sources', 'small.md'))).toBe(true);
    expect(existsSync(join(fixture.vaultDir, 'sources', 'huge.md'))).toBe(true);

    // Under-budget source has agent-authored content (mock agent writes a stub with library wikilinks)
    expect(readFileSync(join(fixture.vaultDir, 'sources', 'small.md'), 'utf-8'))
      .toContain('library: "[[library/small]]"');

    // Over-budget source is the deterministic stub
    expect(readFileSync(join(fixture.vaultDir, 'sources', 'huge.md'), 'utf-8'))
      .toContain('auto_generated: true');

    // oversized never appears
    expect(stateLog.some(s => s.endsWith(':oversized'))).toBe(false);

    // Bidirectional edges created (mocked)
    const edges = fixture.ragClient.createRelationCalls;
    expect(edges).toContainEqual(expect.objectContaining({ from: 'small', to: 'small', keywords: 'summarizes, full_text' }));
    expect(edges).toContainEqual(expect.objectContaining({ from: 'small', to: 'small', keywords: 'summarized_by, summary' }));
    // (similar for huge)
  });
});
```

The fixture must mock the agent (return a deterministic source-note draft for under-budget) and the RAG client. Match existing patterns in `integration.test.ts`.

- [ ] **Step 2: Run**

Run: `npx vitest run src/ingestion/integration.test.ts -t "end-to-end"`
Expected: pass (since all underlying tasks are done).

- [ ] **Step 3: Commit**

```bash
git add src/ingestion/integration.test.ts
git commit -m "test(ingestion): end-to-end coverage of under/over budget paths"
```

---

### Task 27: Type-check + full test sweep + manual smoke

**Files:** none modified

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 3: Container build**

Run: `./container/build.sh`
Expected: success. Verify the new `vault-mcp-stdio.js` is present in the built image:
`docker run --rm nanoclaw-agent:latest ls /app/dist | grep vault-mcp` (or the equivalent for the Apple Container runtime if that's what's in use).

- [ ] **Step 4: Manual smoke test (the user's own vault)**

Walk through manually (and report findings; do not auto-commit anything from this step):

1. Stop NanoClaw.
2. Run `npx tsx scripts/backfill-library.ts --dry-run --report /tmp/backfill-dry.json` — review the report.
3. If it looks right, run without `--dry-run` (still NanoClaw stopped).
4. Spot-check 2–3 generated `vault/library/*.md` files: frontmatter shape, body content matches extraction.
5. Spot-check 2–3 patched `vault/sources/*.md` files: `library:` field present, body unchanged.
6. Restart NanoClaw. Confirm it starts cleanly (migration `0004` should be a no-op now).
7. Drop a small PDF into `upload/`. Confirm pipeline transitions: `pending → extracting → extracted → librarying → libraried → generating → generated → completed`. Confirm `vault/library/{slug}.md` and `vault/sources/{slug}.md` both exist.
8. Drop a large PDF (>~80K tokens after cleanup). Confirm `vault/library/{slug}.md` exists, `vault/sources/{slug}.md` is the stub with `auto_generated: true`, no Telegram notification arrived.
9. Open the dashboard's vault browser. Confirm library files appear and are reachable.
10. Have an agent run a query that should hit a library file via RAG. Confirm `mcp__vault__vault_section` shows up in the agent's tool list and works on a library path.

- [ ] **Step 5: Commit and open the PR**

If any pre-existing-but-broken tests were touched during the sweep, fold those fixes in:

```bash
git status
# if there are intentional fix-ups:
git add <files>
git commit -m "fix: clean up tests after pipeline-status changes"
```

Then open the PR per CLAUDE.md (target `SimonKvalheim/universityClaw`, base `main`).

---

## Self-Review

Spec coverage check (against `2026-04-29-library-dual-graph-design.md`):

| Spec section | Tasks | Notes |
|---|---|---|
| §1 Architecture (slug rule + frontmatter) | T0 (slug helper), T3 (library frontmatter), T9–T13 (dual-graph wiring) | Complete |
| §2 Pipeline changes | T1, T4, T5, T6, T7, T8 | Status set, librarying drainer with recovery reset, library writer, stub via drafts/, agent-prompt edit, Telegram notification removed |
| §3 RAG indexer | T9–T15 | ALLOWED_PATHS, prefix, slug→title map (private), restricted scan with `{target,field}` shape, distinct edge keywords, timeouts, logging |
| §4 vault_section MCP | T16–T20 | Section/page/range with **all four header fields always**, Docling marker format pinned, mount, group prompts |
| §5 Backfill | T21–T25 | Concurrency guard, walker, re-extract+patch, indexing, CLI; `deleteTrackedDoc` added if missing |
| §6 Tests | distributed across each task + T26 integration | Migration test in T2, librarying-failure in T4, stub frontmatter (with `concepts_generated: []`) in T6, draft-validator regression in T8, integration in T26 |

Placeholder scan: no `TBD`/`TODO`/"add appropriate" patterns. The previously-flagged TBD-in-disguise items have been resolved inline — Docling page marker format is pinned (`<!-- page:N label:* -->`), `_journal.json` shape is pinned literally, `deleteTrackedDoc` is explicitly added if missing.

Type consistency:
- `JobRow`, `LibraryJobMeta`, `OversizedStubInput`, `VaultSectionLocator`, `VaultSectionResult`, `FrontmatterWikilink`, `BackfillReport`, `RunBackfillOptions` defined where introduced and referenced consistently afterward.
- `writeLibraryFile`, `buildOversizedStub`, `vaultSection`, `runBackfill`, `assertNoLiveNanoclaw`, `parseArgs`, `slugFromFilename`, `resetRecoverableInProgress` keep stable names across tasks.
- `slugTitleMap` is now `private` (no introspection in tests). Behavior is verified via wikilink resolution.
- `extractFrontmatterWikilinks` returns `FrontmatterWikilink[]` (`{ target, field }[]`) from T12 onward — no shape change in T13.
- `slug` is computed by `slugFromFilename(job.source_filename)` everywhere it appears (T5, T7, T8 prompt, T22 backfill walker via filename) — single source of truth per spec §1.

Scope: 28 tasks (added T0). Phased so each phase leaves the system coherent.
