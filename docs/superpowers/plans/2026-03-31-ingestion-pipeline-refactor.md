# Ingestion Pipeline Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the ingestion pipeline from a bulk-upload system to a single-document PDF workflow with content-hash dedup, simplified recovery, and pre-generation draft checks.

**Architecture:** The pipeline is a linear state machine (pending → extracting → extracted → generating → generated → promoting → completed) driven by a polling drainer. Changes are localized to `src/ingestion/`, `src/db.ts`, and `src/config.ts`. No new files created — only modifications and deletions.

**Tech Stack:** TypeScript, Vitest, SQLite (better-sqlite3), chokidar, Node.js crypto

---

### Task 1: Filesystem Cleanup

One-time cleanup of legacy bulk-upload artifacts. Must happen first so subsequent code changes don't interact with stale data.

**Files:**
- Delete: `upload/.processed/` (103 files)
- Delete: `vault/attachments/_unsorted/` (130+ files)
- Delete: `vault/_nav/`, `vault/courses/`, `vault/resources/`, `vault/profile/`
- Purge: `data/extractions/` (keep only `bc8dd53d*` and `eb66e42f*`)
- Modify: `store/messages.db` (delete failed job rows)

- [ ] **Step 1: Delete legacy upload and vault directories**

```bash
rm -rf upload/.processed
rm -rf vault/attachments/_unsorted
rm -rf vault/_nav
rm -rf vault/courses
rm -rf vault/resources
rm -rf vault/profile
```

- [ ] **Step 2: Purge stale extraction directories**

Keep only the two completed jobs (`bc8dd53d`, `eb66e42f`). Delete everything else:

```bash
cd data/extractions
ls | grep -v -E '^(bc8dd53d|eb66e42f)' | xargs rm -rf
```

- [ ] **Step 3: Clean up failed job records from DB**

```bash
sqlite3 store/messages.db "DELETE FROM ingestion_jobs WHERE status = 'failed';"
sqlite3 store/messages.db "SELECT id, source_filename, status FROM ingestion_jobs;"
```

Expected: Only 2 rows remain (both `completed`): `bc8dd53d` (Mayer) and `eb66e42f` (Kirschner).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: clean up legacy bulk-upload artifacts

Remove upload/.processed (103 files), vault/_unsorted (130+ files),
empty vault subdirs, stale extraction dirs, and failed DB records."
```

---

### Task 2: DB Migration — content_hash Column + Dead Code Removal

Add the `content_hash` column, the new `getCompletedJobByHash()` query function, update `createIngestionJob()` signature, and remove dead functions.

**Files:**
- Modify: `src/db.ts` (migration block ~line 143-158, functions at ~726-767)
- Modify: `src/ingestion/db-ingestion.test.ts`

- [ ] **Step 1: Write tests for content-hash DB functions**

Add to `src/ingestion/db-ingestion.test.ts`:

```ts
// At the top, add getCompletedJobByHash to imports:
// import { ..., getCompletedJobByHash } from '../db.js';

// --- content hash dedup ---

describe('content hash dedup', () => {
  it('createIngestionJob stores content_hash', () => {
    createIngestionJob('hash-1', '/upload/a.pdf', 'a.pdf', 'abc123hash');
    const jobs = getIngestionJobs();
    const job = jobs.find((j) => (j as Record<string, unknown>).id === 'hash-1') as Record<string, unknown>;
    expect(job.content_hash).toBe('abc123hash');
  });

  it('getCompletedJobByHash finds completed job with matching hash', () => {
    createIngestionJob('hash-2', '/upload/b.pdf', 'b.pdf', 'deadbeef');
    updateIngestionJob('hash-2', { status: 'completed' });

    const found = getCompletedJobByHash('deadbeef');
    expect(found).toBeDefined();
    expect(found!.id).toBe('hash-2');
  });

  it('getCompletedJobByHash ignores non-completed jobs', () => {
    createIngestionJob('hash-3', '/upload/c.pdf', 'c.pdf', 'cafebabe');
    // status is still 'pending'

    const found = getCompletedJobByHash('cafebabe');
    expect(found).toBeUndefined();
  });

  it('getCompletedJobByHash returns undefined for unknown hash', () => {
    const found = getCompletedJobByHash('nonexistent');
    expect(found).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/ingestion/db-ingestion.test.ts
```

Expected: FAIL — `getCompletedJobByHash` is not exported, `createIngestionJob` has wrong arity.

- [ ] **Step 3: Add DB migration for content_hash column**

In `src/db.ts`, after the existing `updated_at` migration block (~line 156-158), add:

```ts
  try {
    database.exec(
      `ALTER TABLE ingestion_jobs ADD COLUMN content_hash TEXT`,
    );
    database.exec(
      `CREATE INDEX idx_ingestion_jobs_hash ON ingestion_jobs(content_hash)`,
    );
  } catch {
    /* column/index already exists */
  }
```

- [ ] **Step 4: Update createIngestionJob to accept contentHash**

In `src/db.ts`, replace the `createIngestionJob` function (~line 713-724):

```ts
export function createIngestionJob(
  id: string,
  sourcePath: string,
  sourceFilename: string,
  contentHash?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO ingestion_jobs (id, source_path, source_filename, content_hash)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, sourcePath, sourceFilename, contentHash ?? null);
}
```

Note: `contentHash` is optional so existing callers (tests) that pass 3 args still work.

- [ ] **Step 5: Add getCompletedJobByHash function**

In `src/db.ts`, after `getIngestionJobByPath` (~line 707), add:

```ts
export function getCompletedJobByHash(
  hash: string,
): { id: string } | undefined {
  return db
    .prepare(
      `SELECT id FROM ingestion_jobs WHERE content_hash = ? AND status = 'completed' LIMIT 1`,
    )
    .get(hash) as { id: string } | undefined;
}
```

- [ ] **Step 6: Delete dead functions**

In `src/db.ts`:
- Delete `updateIngestionJobStatus` (~line 726-735) — dead code, superseded by `updateIngestionJob`.
- Delete `getStaleJobs` (~line 758-767) — will have no callers after recovery rewrite.

- [ ] **Step 7: Update test imports — remove getStaleJobs references**

In `src/ingestion/db-ingestion.test.ts`:
- Remove `getStaleJobs` from imports.
- Delete the entire `describe('getStaleJobs', ...)` block (~line 159-168).
- Add `getCompletedJobByHash` to imports.

- [ ] **Step 8: Run tests**

```bash
npm test -- src/ingestion/db-ingestion.test.ts
```

Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/db.ts src/ingestion/db-ingestion.test.ts
git commit -m "feat: add content_hash column, dedup query, remove dead DB functions"
```

---

### Task 3: File Watcher — PDF Only

Restrict the file watcher to `.pdf` and filter `~$` temp files.

**Files:**
- Modify: `src/ingestion/file-watcher.ts`
- Modify: `src/ingestion/file-watcher.test.ts`

- [ ] **Step 1: Update tests for PDF-only behavior**

Replace the entire contents of `src/ingestion/file-watcher.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileWatcher } from './file-watcher.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('FileWatcher', () => {
  let tmpDir: string;
  let watcher: FileWatcher;
  let detectedFiles: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'file-watcher-test-'));
    detectedFiles = [];
    watcher = new FileWatcher(tmpDir, (filePath) => {
      detectedFiles.push(filePath);
    });
    await watcher.start();
    await wait(200);
  });

  afterEach(async () => {
    await watcher.stop();
  });

  it('detects new PDF files', async () => {
    const filePath = join(tmpDir, 'document.pdf');
    await writeFile(filePath, 'PDF content');
    await wait(2000);

    expect(detectedFiles).toContain(filePath);
  });

  it('detects PDFs in nested directories', async () => {
    const nestedDir = join(tmpDir, 'subdir');
    await mkdir(nestedDir, { recursive: true });
    const filePath = join(nestedDir, 'paper.pdf');
    await writeFile(filePath, 'PDF content');
    await wait(2000);

    expect(detectedFiles).toContain(filePath);
  });

  it('ignores non-PDF file types', async () => {
    const files = ['file.docx', 'file.pptx', 'file.txt', 'file.md', 'file.png', 'file.csv'];
    for (const name of files) {
      await writeFile(join(tmpDir, name), 'content');
    }
    await wait(2000);

    expect(detectedFiles).toHaveLength(0);
  });

  it('ignores ~$ temp files', async () => {
    const filePath = join(tmpDir, '~$document.pdf');
    await writeFile(filePath, 'lock file');
    await wait(2000);

    expect(detectedFiles).not.toContain(filePath);
  });

  it('ignores .DS_Store files', async () => {
    const ignoredPath = join(tmpDir, '.DS_Store');
    await writeFile(ignoredPath, '');
    await wait(2000);

    expect(detectedFiles).not.toContain(ignoredPath);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/ingestion/file-watcher.test.ts
```

Expected: "ignores non-PDF file types" FAILS (old code accepts `.docx`, `.pptx`, etc.), "ignores ~$ temp files" FAILS.

- [ ] **Step 3: Update file-watcher.ts**

Replace the entire contents of `src/ingestion/file-watcher.ts`:

```ts
import chokidar, { type FSWatcher } from 'chokidar';
import { extname } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.pdf']);

const IGNORED_FILES = new Set(['.ds_store', 'thumbs.db', '.gitkeep']);

export class FileWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly watchDir: string,
    private readonly onFile: (filePath: string) => void,
  ) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.watchDir, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
      depth: 10,
      ignored: [/[\\/]\.processed[\\/]/, /[\\/]processed[\\/]/],
    });
    this.watcher.on('add', (filePath: string) => {
      const fileName = filePath.split('/').pop() || '';
      if (fileName.startsWith('~$')) return;
      if (IGNORED_FILES.has(fileName.toLowerCase())) return;
      const ext = extname(fileName).toLowerCase();
      if (ext && SUPPORTED_EXTENSIONS.has(ext)) {
        this.onFile(filePath);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/ingestion/file-watcher.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/file-watcher.ts src/ingestion/file-watcher.test.ts
git commit -m "feat: restrict file watcher to PDF only, filter ~$ temp files"
```

---

### Task 4: Recovery Rewrite — Mark Failed, No Auto-Retry

Replace `recoverStaleJobs()` with `markInterruptedJobsFailed()`.

**Files:**
- Modify: `src/ingestion/job-recovery.ts`
- Modify: `src/ingestion/job-recovery.test.ts`
- Modify: `src/ingestion/index.ts` (~line 395-398)

- [ ] **Step 1: Rewrite test file**

Replace the entire contents of `src/ingestion/job-recovery.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { markInterruptedJobsFailed } from './job-recovery.js';
import {
  _initTestDatabase,
  createIngestionJob,
  updateIngestionJob,
  getJobsByStatus,
} from '../db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('markInterruptedJobsFailed', () => {
  it('marks extracting jobs as failed', () => {
    createIngestionJob('ext-1', '/tmp/ext-1.pdf', 'test.pdf');
    updateIngestionJob('ext-1', { status: 'extracting' });

    const count = markInterruptedJobsFailed();

    expect(count).toBe(1);
    const failed = getJobsByStatus('failed') as Array<Record<string, unknown>>;
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('ext-1');
    expect(failed[0].error).toBe('Interrupted: process restarted');
  });

  it('marks generating jobs as failed', () => {
    createIngestionJob('gen-1', '/tmp/gen-1.pdf', 'test.pdf');
    updateIngestionJob('gen-1', { status: 'generating' });

    const count = markInterruptedJobsFailed();

    expect(count).toBe(1);
    const failed = getJobsByStatus('failed') as Array<Record<string, unknown>>;
    expect(failed[0].id).toBe('gen-1');
  });

  it('marks promoting jobs as failed', () => {
    createIngestionJob('promo-1', '/tmp/promo-1.pdf', 'test.pdf');
    updateIngestionJob('promo-1', { status: 'promoting' });

    const count = markInterruptedJobsFailed();

    expect(count).toBe(1);
    const failed = getJobsByStatus('failed') as Array<Record<string, unknown>>;
    expect(failed[0].id).toBe('promo-1');
  });

  it('marks all in-progress jobs across statuses', () => {
    createIngestionJob('a', '/tmp/a.pdf', 'a.pdf');
    createIngestionJob('b', '/tmp/b.pdf', 'b.pdf');
    createIngestionJob('c', '/tmp/c.pdf', 'c.pdf');
    updateIngestionJob('a', { status: 'extracting' });
    updateIngestionJob('b', { status: 'generating' });
    updateIngestionJob('c', { status: 'promoting' });

    const count = markInterruptedJobsFailed();

    expect(count).toBe(3);
    const failed = getJobsByStatus('failed');
    expect(failed).toHaveLength(3);
  });

  it('does not touch pending, extracted, generated, or completed jobs', () => {
    createIngestionJob('p', '/tmp/p.pdf', 'p.pdf');
    createIngestionJob('e', '/tmp/e.pdf', 'e.pdf');
    createIngestionJob('g', '/tmp/g.pdf', 'g.pdf');
    createIngestionJob('c', '/tmp/c.pdf', 'c.pdf');
    updateIngestionJob('e', { status: 'extracted' });
    updateIngestionJob('g', { status: 'generated' });
    updateIngestionJob('c', { status: 'completed' });

    const count = markInterruptedJobsFailed();

    expect(count).toBe(0);
    expect(getJobsByStatus('pending')).toHaveLength(1);
    expect(getJobsByStatus('extracted')).toHaveLength(1);
    expect(getJobsByStatus('generated')).toHaveLength(1);
    expect(getJobsByStatus('completed')).toHaveLength(1);
  });

  it('returns 0 when no in-progress jobs exist', () => {
    const count = markInterruptedJobsFailed();
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/ingestion/job-recovery.test.ts
```

Expected: FAIL — `markInterruptedJobsFailed` is not exported from `job-recovery.js`.

- [ ] **Step 3: Rewrite job-recovery.ts**

Replace the entire contents of `src/ingestion/job-recovery.ts`:

```ts
import { getJobsByStatus, updateIngestionJob } from '../db.js';
import { logger } from '../logger.js';

/**
 * On startup, mark any in-progress jobs as failed.
 * No auto-retry — failures surface in the dashboard for manual re-upload.
 */
export function markInterruptedJobsFailed(): number {
  const inProgressStatuses = ['extracting', 'generating', 'promoting'];
  let count = 0;

  for (const status of inProgressStatuses) {
    const stuck = getJobsByStatus(status) as Array<{ id: string; source_path: string }>;
    for (const job of stuck) {
      logger.warn(
        { jobId: job.id, sourcePath: job.source_path, status },
        `Marking interrupted ${status} job as failed`,
      );
      updateIngestionJob(job.id, {
        status: 'failed',
        error: 'Interrupted: process restarted',
      });
      count++;
    }
  }

  if (count > 0) {
    logger.info({ count }, 'Marked interrupted jobs as failed on startup');
  }

  return count;
}
```

- [ ] **Step 4: Update index.ts startup call**

In `src/ingestion/index.ts`, replace the import and call:

Change the import (~line 8):
```ts
// Old:
import { recoverStaleJobs } from './job-recovery.js';
// New:
import { markInterruptedJobsFailed } from './job-recovery.js';
```

Change the startup call (~line 395-398):
```ts
// Old:
    recoverStaleJobs({
      extractingThresholdMin: 15,
      generatingThresholdMin: 60,
    });
// New:
    markInterruptedJobsFailed();
```

- [ ] **Step 5: Run tests**

```bash
npm test -- src/ingestion/job-recovery.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ingestion/job-recovery.ts src/ingestion/job-recovery.test.ts src/ingestion/index.ts
git commit -m "feat: replace stale-job recovery with mark-failed on startup"
```

---

### Task 5: Content-Hash Dedup in Enqueue

Wire up SHA-256 hashing in the enqueue path.

**Files:**
- Modify: `src/ingestion/index.ts` (~line 70-110, enqueue method)

- [ ] **Step 1: Add crypto import and hash computation to enqueue**

In `src/ingestion/index.ts`, add the import at the top of the file:

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
```

Note: `readFileSync` from `node:fs` is already imported via `fs` in some scope, but check — the current file uses `node:fs/promises`. Add a separate sync import.

Then update the `enqueue` method. Replace lines 70-110:

```ts
  private enqueue(filePath: string): void {
    const relativePath = relative(this.uploadDir, filePath);
    const fileName = basename(filePath);

    // Content-hash dedup: skip if identical file already completed
    let contentHash: string;
    try {
      const fileBuffer = readFileSync(filePath);
      contentHash = createHash('sha256').update(fileBuffer).digest('hex');
    } catch (err) {
      logger.warn({ filePath, err }, 'ingestion: Failed to hash file, skipping');
      return;
    }

    const completedDuplicate = getCompletedJobByHash(contentHash);
    if (completedDuplicate) {
      logger.info(
        { filePath: relativePath, duplicateOfJob: completedDuplicate.id },
        `ingestion: Skipping duplicate of completed job ${completedDuplicate.id}: ${relativePath}`,
      );
      return;
    }

    // Path-based dedup: skip if same path is already in-flight
    const existing = getIngestionJobByPath(filePath);
    if (existing) {
      if (
        existing.status === 'completed' ||
        existing.status === 'extracting' ||
        existing.status === 'generating' ||
        existing.status === 'promoting'
      ) {
        logger.info(
          `ingestion: Skipping (already ${existing.status}): ${relativePath}`,
        );
        return;
      }
      if (existing.status === 'failed') {
        updateIngestionJob(existing.id, { status: 'pending', error: null });
        logger.info(`ingestion: Retrying failed job: ${relativePath}`);
        return;
      }
      if (
        existing.status === 'pending' ||
        existing.status === 'extracted' ||
        existing.status === 'generated'
      ) {
        logger.info(
          `ingestion: Skipping (already ${existing.status}): ${relativePath}`,
        );
        return;
      }
    }

    const jobId = randomUUID();
    logger.info(
      { jobId, relativePath, contentHash },
      `ingestion: Enqueuing: ${relativePath}`,
    );
    createIngestionJob(jobId, filePath, fileName, contentHash);
  }
```

Also add `getCompletedJobByHash` to the imports from `../db.js` (~line 19-22):

```ts
import {
  createIngestionJob,
  getIngestionJobByPath,
  getCompletedJobByHash,
  updateIngestionJob,
} from '../db.js';
```

- [ ] **Step 2: Run full test suite to check nothing broke**

```bash
npm test -- src/ingestion/
```

Expected: All tests PASS. (The enqueue method isn't directly unit-tested — it's integration-level, tested via the pipeline.)

- [ ] **Step 3: Commit**

```bash
git add src/ingestion/index.ts
git commit -m "feat: add SHA-256 content-hash dedup to enqueue path"
```

---

### Task 6: Pre-Generation Draft Check + Skip Re-Extraction

Wire up the `hasArtifacts()` check in extraction and `validateDrafts()` check in generation. Also restructure the extraction handler to remove the redundant PDF copy and update figures destination.

**Files:**
- Modify: `src/ingestion/index.ts` (handleExtraction ~line 112-154, handleGeneration ~line 156-301)

- [ ] **Step 1: Update handleExtraction — skip re-extraction, remove PDF copy, fix figures dest**

In `src/ingestion/index.ts`, replace the entire `handleExtraction` method (~line 112-154):

```ts
  async handleExtraction(job: JobRow): Promise<void> {
    const fileName = job.source_filename;
    const relativePath = relative(this.uploadDir, job.source_path);

    // Skip if extraction artifacts already exist (recovery re-run)
    if (await this.extractor.hasArtifacts(job.id)) {
      logger.info(
        { jobId: job.id, relativePath },
        'ingestion: Extraction artifacts exist — skipping Docling',
      );
      updateIngestionJob(job.id, {
        status: 'extracted',
        extraction_path: this.extractor.getExtractionDir(job.id),
      });
      return;
    }

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Extracting: ${relativePath}`,
    );

    const result = await this.extractor.extract(job.id, job.source_path);

    // Copy figures to vault attachments (per-job directory)
    if (result.figures.length > 0) {
      const figuresAttachDir = join(this.vaultDir, 'attachments', job.id);
      await mkdir(figuresAttachDir, { recursive: true });
      for (const fig of result.figures) {
        await copyFile(
          join(result.figuresDir, fig),
          join(figuresAttachDir, fig),
        ).catch(() => {
          logger.warn({ jobId: job.id, figure: fig }, 'Failed to copy figure');
        });
      }
    }

    updateIngestionJob(job.id, {
      status: 'extracted',
      extraction_path: result.contentPath.replace(/\/content\.md$/, ''),
    });

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Extracted: ${relativePath}`,
    );
  }
```

- [ ] **Step 2: Add pre-generation draft check to handleGeneration**

In `src/ingestion/index.ts`, at the start of `handleGeneration` (~line 156), add the draft check after the `mkdir` call and before the logging. Replace from the method signature through to the `const extractionPath` line:

```ts
  async handleGeneration(job: JobRow): Promise<void> {
    const fileName = job.source_filename;
    const relativePath = relative(this.uploadDir, job.source_path);

    const draftsDir = join(this.vaultDir, 'drafts');
    await mkdir(draftsDir, { recursive: true });

    // Skip if valid drafts already exist (recovery re-run with prior output)
    const existingValidation = validateDrafts(draftsDir, job.id, fileName);
    if (existingValidation.valid) {
      logger.info(
        { jobId: job.id, relativePath },
        'ingestion: Valid drafts already exist — skipping agent',
      );
      updateIngestionJob(job.id, { status: 'generated' });
      return;
    }

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Generating: ${relativePath}`,
    );

    const extractionPath = job.extraction_path;
```

**Important:** The `updateIngestionJob(job.id, { status: 'generated' })` call in the early return is required. The drainer does NOT update status after `onGenerate` — the handler itself is responsible for setting `generated` status (see line 295 for the normal path). The early return must set it explicitly or the job will be stuck in `generating` forever.

- [ ] **Step 3: Fix the dynamic import of unlinkSync**

In `src/ingestion/index.ts`, add `unlinkSync` to the imports. There is no existing `node:fs` sync import in this file — only `node:fs/promises`. Add at the top with the other imports:

```ts
import { unlinkSync } from 'node:fs';
```

Note: `readFileSync` was added in Task 5 for the hash computation. Combine into one import:

```ts
import { readFileSync, unlinkSync } from 'node:fs';
```

Then replace the dynamic import block (~line 253-258):

```ts
        // Old:
        try {
          const { unlinkSync } = await import('fs');
          unlinkSync(sentinelPath);
        } catch {
          // Already gone
        }

        // New:
        try {
          unlinkSync(sentinelPath);
        } catch {
          // Already gone
        }
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/ingestion/
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/index.ts
git commit -m "feat: skip re-extraction, pre-generation draft check, fix figures dest"
```

---

### Task 7: Promoter — mkdirSync Safety

Ensure promotion doesn't crash if destination directories don't exist.

**Files:**
- Modify: `src/ingestion/promoter.ts`
- Modify: `src/ingestion/promoter.test.ts`

- [ ] **Step 1: Add test for promotion when destination dir doesn't exist**

Add to `src/ingestion/promoter.test.ts`, inside the `describe('promoteNote', ...)` block:

```ts
  it('creates destination directory if it does not exist', () => {
    // Don't create concepts/ dir — promoteNote should handle it
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(VAULT, 'drafts'), { recursive: true });
    // Note: concepts/ does NOT exist

    const draftPath = join(VAULT, 'drafts', 'job2-concept-001.md');
    writeFileSync(
      draftPath,
      '---\ntitle: Backpropagation\ntype: concept\n---\nContent',
    );

    const result = promoteNote(draftPath, VAULT, 'job2');

    expect(result).toBe('concepts/backpropagation.md');
    expect(existsSync(join(VAULT, 'concepts', 'backpropagation.md'))).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/ingestion/promoter.test.ts
```

Expected: FAIL — `ENOENT: no such file or directory` because `concepts/` doesn't exist.

- [ ] **Step 3: Add mkdirSync to promoter**

In `src/ingestion/promoter.ts`, add `mkdirSync` to the imports:

```ts
import { readFileSync, renameSync, existsSync, mkdirSync } from 'fs';
```

Then add directory creation before the rename. After `const destFolder = ...` and before `let filename = ...`:

```ts
  mkdirSync(join(vaultDir, destFolder), { recursive: true });
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/ingestion/promoter.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/promoter.ts src/ingestion/promoter.test.ts
git commit -m "fix: create destination directory in promoter if it doesn't exist"
```

---

### Task 8: Config — SENTINEL_TIMEOUT Consistency

Cosmetic fix for consistency.

**Files:**
- Modify: `src/config.ts` (~line 131-133)

- [ ] **Step 1: Update SENTINEL_TIMEOUT**

In `src/config.ts`, replace:

```ts
export const SENTINEL_TIMEOUT = Number(
  process.env.SENTINEL_TIMEOUT ?? 10 * 60 * 1000, // 10 minutes
);
```

With:

```ts
export const SENTINEL_TIMEOUT = parseInt(
  process.env.SENTINEL_TIMEOUT || '600000',
  10,
); // 10min default
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "fix: use parseInt for SENTINEL_TIMEOUT, consistent with other timeouts"
```

---

### Task 9: Final Verification

Run the full test suite and verify the build compiles.

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests PASS.

- [ ] **Step 2: Verify TypeScript compilation**

```bash
npm run build
```

Expected: No compilation errors.

- [ ] **Step 3: Verify no references to deleted functions**

```bash
grep -r "recoverStaleJobs\|updateIngestionJobStatus\|getStaleJobs" src/ --include="*.ts" | grep -v ".test.ts" | grep -v "node_modules"
```

Expected: No matches (only test files may reference old names if we missed updating them, but there should be none).

- [ ] **Step 4: Verify no references to old attachment path**

```bash
grep -r "_unsorted" src/ --include="*.ts"
```

Expected: No matches.

- [ ] **Step 5: Commit any remaining fixes if needed, then verify git status is clean**

```bash
git status
```

Expected: Clean working tree, all changes committed.
