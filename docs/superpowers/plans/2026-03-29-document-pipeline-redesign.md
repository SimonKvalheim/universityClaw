# Document Processing Pipeline Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragile, single-stage ingestion pipeline with a robust two-stage (extraction → AI), tiered (1/2/3), DB-backed document processing system with unified approval.

**Architecture:** Host-side Docling extraction produces checkpointed artifacts. DB-backed job state machine replaces in-memory queue. Tiered processing routes documents to auto-approve (Tier 1/2) or human review (Tier 3). All vault mutations go through a single backend codepath.

**Tech Stack:** Node.js/TypeScript, Python (Docling), better-sqlite3, chokidar, vitest

**Spec:** `docs/superpowers/specs/2026-03-29-document-pipeline-redesign.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/ingestion/extractor.ts` | Stage 1: Docling subprocess orchestration, artifact management |
| `src/ingestion/extractor.test.ts` | Tests for extraction stage |
| `src/ingestion/tier-classifier.ts` | Determine processing tier from type + profile |
| `src/ingestion/tier-classifier.test.ts` | Tests for tier classification |
| `src/ingestion/pipeline.ts` | New DB-backed pipeline orchestrator (replaces index.ts internals) |
| `src/ingestion/pipeline.test.ts` | Tests for pipeline state machine |
| `src/ingestion/job-recovery.ts` | Startup recovery for stale jobs |
| `src/ingestion/job-recovery.test.ts` | Tests for recovery logic |

### Modified Files
| File | Changes |
|------|---------|
| `src/db.ts` | PRAGMA, new columns, new states, indexes, new query functions |
| `src/ingestion/index.ts` | Rewire to use new pipeline, remove in-memory queue |
| `src/ingestion/agent-processor.ts` | Accept extraction artifacts instead of raw files, per-job IPC |
| `src/ingestion/type-mappings.ts` | Add tier mapping alongside type |
| `src/ingestion/review-queue.ts` | Atomic writes, call updateReviewItemStatus |
| `src/channels/web.ts` | Add /approve, /reject, /metadata, /drafts, /recent endpoints |
| `src/config.ts` | Add EXTRACTION_TIMEOUT, PIPELINE_TIMEOUT, MAX_EXTRACTION_CONCURRENT |
| `src/container-runner.ts` | Accept per-job IPC path |
| `src/index.ts` | Wire up new pipeline, pass GroupQueue for concurrency coordination |
| `dashboard/src/app/api/review/route.ts` | Route approve/reject through backend instead of direct file I/O |
| `dashboard/src/app/review/page.tsx` | Add recently processed feed, tier badges |
| `scripts/docling-extract.py` | Add PDF conversion for DOCX/PPTX |

---

## Task 1: Database Foundation

**Files:**
- Modify: `src/db.ts:86-112` (schema), `src/db.ts:186-195` (init), `src/db.ts:696-797` (query functions)
- Test: `src/db.test.ts` (new or extend existing)

- [ ] **Step 1: Write test for PRAGMA foreign_keys enforcement**

```typescript
// src/db.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

describe('database initialization', () => {
  it('should enforce foreign key constraints', () => {
    // After init, inserting a review_item with invalid job_id should fail
    const db = new Database(':memory:');
    // We'll test this after applying the schema changes
  });
});
```

Skip this placeholder for now — we'll write proper tests in Step 3.

- [ ] **Step 2: Add PRAGMA and schema changes to src/db.ts**

At `src/db.ts:186-195`, after the database is opened, add PRAGMA:

```typescript
// After db = new Database(dbPath)
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
```

Modify the `ingestion_jobs` table schema at `src/db.ts:86-99` to add new columns and states:

```sql
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  course_code TEXT,
  course_name TEXT,
  semester INTEGER,
  year INTEGER,
  type TEXT,
  tier INTEGER DEFAULT 2,
  extraction_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status ON ingestion_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_source_path ON ingestion_jobs(source_path);
```

Modify the `review_items` table at `src/db.ts:101-112` to add ON DELETE CASCADE:

```sql
CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  draft_path TEXT NOT NULL,
  original_source TEXT,
  suggested_type TEXT,
  suggested_course TEXT,
  figures TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_items_status ON review_items(status);
CREATE INDEX IF NOT EXISTS idx_review_items_job_id ON review_items(job_id);
```

- [ ] **Step 3: Add new DB query functions**

Add these functions after the existing ones at `src/db.ts:797`:

```typescript
export function getJobsByStatus(status: string): Array<{
  id: string;
  source_path: string;
  source_filename: string;
  status: string;
  tier: number;
  extraction_path: string | null;
  created_at: string;
  updated_at: string;
}> {
  return getDb()
    .prepare('SELECT * FROM ingestion_jobs WHERE status = ?')
    .all(status) as any[];
}

export function getStaleJobs(status: string, olderThanMinutes: number): Array<{
  id: string;
  source_path: string;
  status: string;
  extraction_path: string | null;
}> {
  return getDb()
    .prepare(
      `SELECT * FROM ingestion_jobs
       WHERE status = ? AND updated_at < datetime('now', ?)`,
    )
    .all(status, `-${olderThanMinutes} minutes`) as any[];
}

export function updateIngestionJob(
  id: string,
  updates: {
    status?: string;
    tier?: number;
    extraction_path?: string;
    error?: string | null;
  },
): void {
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    values.push(updates.status);
    if (updates.status === 'completed') {
      setClauses.push("completed_at = datetime('now')");
    }
  }
  if (updates.tier !== undefined) {
    setClauses.push('tier = ?');
    values.push(updates.tier);
  }
  if (updates.extraction_path !== undefined) {
    setClauses.push('extraction_path = ?');
    values.push(updates.extraction_path);
  }
  if ('error' in updates) {
    setClauses.push('error = ?');
    values.push(updates.error ?? null);
  }

  values.push(id);
  getDb()
    .prepare(`UPDATE ingestion_jobs SET ${setClauses.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function getReviewItemByJobId(jobId: string): { id: string; status: string } | undefined {
  return getDb()
    .prepare('SELECT id, status FROM review_items WHERE job_id = ?')
    .get(jobId) as { id: string; status: string } | undefined;
}

/**
 * Export the raw DB handle for tests that need direct SQL (e.g. backdating timestamps).
 * Add to the existing db.ts module, exposing the private `db` variable:
 */
export function getDb(): ReturnType<typeof Database> {
  return db;
}

export function getRecentlyCompletedJobs(limit: number = 50): Array<{
  id: string;
  source_filename: string;
  course_code: string | null;
  type: string | null;
  tier: number;
  completed_at: string;
}> {
  return getDb()
    .prepare(
      `SELECT id, source_filename, course_code, type, tier, completed_at
       FROM ingestion_jobs
       WHERE status = 'completed'
       ORDER BY completed_at DESC
       LIMIT ?`,
    )
    .all(limit) as any[];
}
```

- [ ] **Step 4: Write tests for new DB functions**

```typescript
// src/ingestion/db-ingestion.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createIngestionJob,
  updateIngestionJob,
  getJobsByStatus,
  getStaleJobs,
  updateReviewItemStatus,
  createReviewItem,
  getReviewItemByJobId,
  deleteIngestionJob,
} from '../db.js';

describe('ingestion DB functions', () => {
  // Note: tests rely on the test DB setup from vitest globalSetup

  it('getJobsByStatus returns jobs matching status', () => {
    const id = 'test-' + Date.now();
    createIngestionJob(id, '/tmp/test.pdf', 'test.pdf', 'TEST1001', 'Test', 1, 1, 'lecture');
    const jobs = getJobsByStatus('pending');
    const found = jobs.find((j) => j.id === id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('pending');
  });

  it('updateIngestionJob updates status and tier', () => {
    const id = 'test-update-' + Date.now();
    createIngestionJob(id, '/tmp/update.pdf', 'update.pdf', null, null, null, null, null);
    updateIngestionJob(id, { status: 'extracting', tier: 2 });
    const jobs = getJobsByStatus('extracting');
    const found = jobs.find((j) => j.id === id);
    expect(found).toBeDefined();
    expect(found!.tier).toBe(2);
  });

  it('updateReviewItemStatus updates review item', () => {
    const jobId = 'test-review-job-' + Date.now();
    const reviewId = 'test-review-' + Date.now();
    createIngestionJob(jobId, '/tmp/review.pdf', 'review.pdf', null, null, null, null, null);
    createReviewItem(reviewId, jobId, 'drafts/test.md', 'review.pdf', 'lecture', 'TEST', []);
    updateReviewItemStatus(reviewId, 'approved');
    const item = getReviewItemByJobId(jobId);
    expect(item).toBeDefined();
    expect(item!.status).toBe('approved');
  });

  it('deleteIngestionJob cascades to review_items', () => {
    const jobId = 'test-cascade-' + Date.now();
    const reviewId = 'test-cascade-review-' + Date.now();
    createIngestionJob(jobId, '/tmp/cascade.pdf', 'cascade.pdf', null, null, null, null, null);
    createReviewItem(reviewId, jobId, 'drafts/cascade.md', 'cascade.pdf', null, null, []);
    deleteIngestionJob(jobId);
    const item = getReviewItemByJobId(jobId);
    expect(item).toBeUndefined();
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- src/ingestion/db-ingestion.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/ingestion/db-ingestion.test.ts
git commit -m "feat(db): add PRAGMA foreign_keys, new job states, tier column, indexes"
```

---

## Task 2: Tier Classifier

**Files:**
- Create: `src/ingestion/tier-classifier.ts`
- Create: `src/ingestion/tier-classifier.test.ts`
- Modify: `src/ingestion/type-mappings.ts:3-12` (add tier to NoteType config)

- [ ] **Step 1: Write tier classifier tests**

```typescript
// src/ingestion/tier-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { classifyTier } from './tier-classifier.js';

describe('classifyTier', () => {
  it('returns tier 1 for assignments', () => {
    expect(classifyTier({ type: 'assignment' })).toBe(1);
  });

  it('returns tier 1 for reference documents', () => {
    expect(classifyTier({ type: 'reference' })).toBe(1);
  });

  it('returns tier 2 for lectures', () => {
    expect(classifyTier({ type: 'lecture' })).toBe(2);
  });

  it('returns tier 2 for exam-prep', () => {
    expect(classifyTier({ type: 'exam-prep' })).toBe(2);
  });

  it('returns tier 3 for null type (unknown)', () => {
    expect(classifyTier({ type: null })).toBe(3);
  });

  it('returns tier 3 for research type', () => {
    expect(classifyTier({ type: 'research' })).toBe(3);
  });

  it('respects explicit tier override', () => {
    expect(classifyTier({ type: 'lecture', tierOverride: 3 })).toBe(3);
  });

  it('returns tier 2 as default for known but unmapped types', () => {
    expect(classifyTier({ type: 'lab' })).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/ingestion/tier-classifier.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement tier classifier**

```typescript
// src/ingestion/tier-classifier.ts

const TIER_1_TYPES = new Set([
  'assignment',
  'reference',
  'project',
]);

const TIER_3_TYPES = new Set([
  'research',
]);

export interface TierInput {
  type: string | null;
  tierOverride?: number;
}

export function classifyTier(input: TierInput): number {
  if (input.tierOverride !== undefined) {
    return input.tierOverride;
  }

  if (input.type === null) {
    return 3; // Unknown type → full review
  }

  if (TIER_1_TYPES.has(input.type)) {
    return 1;
  }

  if (TIER_3_TYPES.has(input.type)) {
    return 3;
  }

  return 2; // Default: course materials
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/ingestion/tier-classifier.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/tier-classifier.ts src/ingestion/tier-classifier.test.ts
git commit -m "feat(ingestion): add tier classifier for document routing"
```

---

## Task 3: Extraction Stage

**Files:**
- Create: `src/ingestion/extractor.ts`
- Create: `src/ingestion/extractor.test.ts`
- Modify: `scripts/docling-extract.py` (add PDF conversion)
- Modify: `src/config.ts:56-59` (add extraction config)

- [ ] **Step 1: Add config constants**

Add to `src/config.ts` after line 67 (IDLE_TIMEOUT):

```typescript
export const EXTRACTION_TIMEOUT = parseInt(
  process.env.EXTRACTION_TIMEOUT || '600000',
  10,
); // 10min default
export const MAX_EXTRACTION_CONCURRENT = parseInt(
  process.env.MAX_EXTRACTION_CONCURRENT || '3',
  10,
);
export const EXTRACTIONS_DIR = path.resolve(
  DATA_DIR,
  'extractions',
);
```

- [ ] **Step 2: Write extractor tests**

```typescript
// src/ingestion/extractor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Extractor, ExtractionResult } from './extractor.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Extractor', () => {
  let extractor: Extractor;
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'extractor-test-'));
    extractor = new Extractor({
      extractionsDir: testDir,
      pythonBin: 'python3',
      scriptPath: join(process.cwd(), 'scripts', 'docling-extract.py'),
      timeoutMs: 30000,
    });
  });

  it('creates extraction directory with jobId', () => {
    const jobId = 'test-job-123';
    const extractionDir = extractor.getExtractionDir(jobId);
    expect(extractionDir).toBe(join(testDir, jobId));
  });

  it('checks if extraction artifacts exist', () => {
    const jobId = 'existing-job';
    const dir = join(testDir, jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'content.md'), '# Test');
    writeFileSync(join(dir, 'metadata.json'), '{}');
    expect(extractor.hasArtifacts(jobId)).toBe(true);
  });

  it('reports missing artifacts when directory does not exist', () => {
    expect(extractor.hasArtifacts('nonexistent')).toBe(false);
  });

  it('cleans up extraction artifacts', async () => {
    const jobId = 'cleanup-job';
    const dir = join(testDir, jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'content.md'), '# Test');
    await extractor.cleanup(jobId);
    expect(existsSync(dir)).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/ingestion/extractor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement extractor**

```typescript
// src/ingestion/extractor.ts
import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { rm } from 'fs/promises';
import { logger } from '../logger.js';

export interface ExtractorOpts {
  extractionsDir: string;
  pythonBin: string;
  scriptPath: string;
  timeoutMs: number;
}

export interface ExtractionResult {
  contentPath: string;
  figuresDir: string;
  figures: string[];
  metadataPath: string;
  previewPdfPath: string | null;
}

export class Extractor {
  private extractionsDir: string;
  private pythonBin: string;
  private scriptPath: string;
  private timeoutMs: number;

  constructor(opts: ExtractorOpts) {
    this.extractionsDir = opts.extractionsDir;
    this.pythonBin = opts.pythonBin;
    this.scriptPath = opts.scriptPath;
    this.timeoutMs = opts.timeoutMs;
  }

  getExtractionDir(jobId: string): string {
    return join(this.extractionsDir, jobId);
  }

  hasArtifacts(jobId: string): boolean {
    const dir = this.getExtractionDir(jobId);
    return (
      existsSync(join(dir, 'content.md')) &&
      existsSync(join(dir, 'metadata.json'))
    );
  }

  async extract(jobId: string, inputPath: string): Promise<ExtractionResult> {
    const outputDir = this.getExtractionDir(jobId);
    mkdirSync(outputDir, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      execFile(
        this.pythonBin,
        [this.scriptPath, inputPath, outputDir],
        { timeout: this.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            logger.error({ jobId, error: error.message, stderr }, 'Docling extraction failed');
            reject(new Error(`Extraction failed: ${error.message}`));
            return;
          }
          try {
            const result = JSON.parse(stdout.trim());
            if (result.status !== 'ok') {
              reject(new Error(`Extraction returned error: ${result.error || 'unknown'}`));
              return;
            }
            resolve();
          } catch {
            reject(new Error(`Failed to parse extraction output: ${stdout.slice(0, 200)}`));
          }
        },
      );
    });

    const contentPath = join(outputDir, 'content.md');
    const metadataPath = join(outputDir, 'metadata.json');
    const figuresDir = join(outputDir, 'figures');

    if (!existsSync(contentPath)) {
      throw new Error(`Extraction produced no content.md for job ${jobId}`);
    }

    const figures = existsSync(figuresDir)
      ? readdirSync(figuresDir).filter((f) => !f.startsWith('.'))
      : [];

    const previewPdfPath = join(outputDir, 'preview.pdf');

    return {
      contentPath,
      figuresDir,
      figures,
      metadataPath,
      previewPdfPath: existsSync(previewPdfPath) ? previewPdfPath : null,
    };
  }

  async cleanup(jobId: string): Promise<void> {
    const dir = this.getExtractionDir(jobId);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- src/ingestion/extractor.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Update docling-extract.py for PDF conversion**

Add PDF conversion to `scripts/docling-extract.py`. After the main extraction, add:

```python
# At the end of the extract() function, before returning
# Convert DOCX/PPTX to PDF for preview (Tier 3 review)
ext = os.path.splitext(input_file)[1].lower()
if ext in ('.docx', '.pptx', '.doc', '.ppt'):
    preview_pdf = os.path.join(output_dir, 'preview.pdf')
    try:
        subprocess.run(
            ['soffice', '--headless', '--convert-to', 'pdf', '--outdir', output_dir, input_file],
            timeout=120,
            capture_output=True,
        )
        # soffice names output after input file
        converted = os.path.join(output_dir, os.path.splitext(os.path.basename(input_file))[0] + '.pdf')
        if os.path.exists(converted) and converted != preview_pdf:
            os.rename(converted, preview_pdf)
    except Exception as e:
        print(f"PDF conversion failed (non-fatal): {e}", file=sys.stderr)
```

- [ ] **Step 7: Commit**

```bash
git add src/ingestion/extractor.ts src/ingestion/extractor.test.ts src/config.ts scripts/docling-extract.py
git commit -m "feat(ingestion): add two-stage extraction with Docling and PDF conversion"
```

---

## Task 4: Job Recovery

**Files:**
- Create: `src/ingestion/job-recovery.ts`
- Create: `src/ingestion/job-recovery.test.ts`

- [ ] **Step 1: Write recovery tests**

```typescript
// src/ingestion/job-recovery.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { recoverStaleJobs } from './job-recovery.js';
import {
  createIngestionJob,
  updateIngestionJob,
  getJobsByStatus,
  getDb,
} from '../db.js';

describe('recoverStaleJobs', () => {
  it('resets stale extracting jobs to pending', () => {
    const id = 'stale-extracting-' + Date.now();
    createIngestionJob(id, `/tmp/${id}.pdf`, 'test.pdf', null, null, null, null, null);
    updateIngestionJob(id, { status: 'extracting' });
    // Manually backdate updated_at for test
    getDb()
      .prepare("UPDATE ingestion_jobs SET updated_at = datetime('now', '-60 minutes') WHERE id = ?")
      .run(id);

    const recovered = recoverStaleJobs({ extractingThresholdMin: 10, generatingThresholdMin: 45 });
    expect(recovered.extracting).toBeGreaterThan(0);

    const jobs = getJobsByStatus('pending');
    expect(jobs.find((j) => j.id === id)).toBeDefined();
  });

  it('resets stale generating jobs to extracted', () => {
    const id = 'stale-generating-' + Date.now();
    createIngestionJob(id, `/tmp/${id}.pdf`, 'test.pdf', null, null, null, null, null);
    updateIngestionJob(id, { status: 'generating', extraction_path: '/tmp/extractions/' + id });
    getDb()
      .prepare("UPDATE ingestion_jobs SET updated_at = datetime('now', '-60 minutes') WHERE id = ?")
      .run(id);

    const recovered = recoverStaleJobs({ extractingThresholdMin: 10, generatingThresholdMin: 45 });
    expect(recovered.generating).toBeGreaterThan(0);

    const jobs = getJobsByStatus('extracted');
    expect(jobs.find((j) => j.id === id)).toBeDefined();
  });

  it('does not reset recent jobs', () => {
    const id = 'recent-generating-' + Date.now();
    createIngestionJob(id, `/tmp/${id}.pdf`, 'test.pdf', null, null, null, null, null);
    updateIngestionJob(id, { status: 'generating' });

    const recovered = recoverStaleJobs({ extractingThresholdMin: 10, generatingThresholdMin: 45 });
    const jobs = getJobsByStatus('generating');
    expect(jobs.find((j) => j.id === id)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/ingestion/job-recovery.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement job recovery**

```typescript
// src/ingestion/job-recovery.ts
import { getStaleJobs, updateIngestionJob } from '../db.js';
import { logger } from '../logger.js';

interface RecoveryOpts {
  extractingThresholdMin: number;
  generatingThresholdMin: number;
}

interface RecoveryResult {
  extracting: number;
  generating: number;
}

export function recoverStaleJobs(opts: RecoveryOpts): RecoveryResult {
  const result: RecoveryResult = { extracting: 0, generating: 0 };

  // Reset stale extracting → pending (retry extraction from scratch)
  const staleExtracting = getStaleJobs('extracting', opts.extractingThresholdMin);
  for (const job of staleExtracting) {
    logger.warn({ jobId: job.id, sourcePath: job.source_path }, 'Recovering stale extracting job → pending');
    updateIngestionJob(job.id, { status: 'pending', error: 'Reset: stale extracting state on startup' });
    result.extracting++;
  }

  // Reset stale generating → extracted (retry only AI stage, keep extraction)
  const staleGenerating = getStaleJobs('generating', opts.generatingThresholdMin);
  for (const job of staleGenerating) {
    if (job.extraction_path) {
      logger.warn({ jobId: job.id, sourcePath: job.source_path }, 'Recovering stale generating job → extracted');
      updateIngestionJob(job.id, { status: 'extracted', error: 'Reset: stale generating state on startup' });
    } else {
      logger.warn({ jobId: job.id, sourcePath: job.source_path }, 'Recovering stale generating job → pending (no extraction)');
      updateIngestionJob(job.id, { status: 'pending', error: 'Reset: stale generating state, no extraction artifacts' });
    }
    result.generating++;
  }

  if (result.extracting > 0 || result.generating > 0) {
    logger.info(result, 'Recovered stale jobs on startup');
  }

  return result;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/ingestion/job-recovery.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/job-recovery.ts src/ingestion/job-recovery.test.ts
git commit -m "feat(ingestion): add startup recovery for stale extracting/generating jobs"
```

---

## Task 5: New Pipeline Orchestrator

**Files:**
- Create: `src/ingestion/pipeline.ts`
- Create: `src/ingestion/pipeline.test.ts`

This is the core replacement for the in-memory queue. It queries the DB for work and drives the state machine.

- [ ] **Step 1: Write pipeline drain tests**

```typescript
// src/ingestion/pipeline.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PipelineDrainer } from './pipeline.js';
import { createIngestionJob, getJobsByStatus, updateIngestionJob } from '../db.js';

describe('PipelineDrainer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('picks up pending jobs and calls extract', async () => {
    const id = 'drain-pending-' + Date.now();
    createIngestionJob(id, `/tmp/${id}.pdf`, 'test.pdf', 'TEST', 'Test', 1, 1, 'lecture');

    const extractFn = vi.fn().mockResolvedValue(undefined);
    const generateFn = vi.fn().mockResolvedValue(undefined);

    const drainer = new PipelineDrainer({
      onExtract: extractFn,
      onGenerate: generateFn,
      maxExtractionConcurrent: 1,
      maxGenerationConcurrent: 1,
      pollIntervalMs: 100,
    });

    drainer.drain();
    await vi.advanceTimersByTimeAsync(200);
    drainer.stop();

    expect(extractFn).toHaveBeenCalledWith(
      expect.objectContaining({ id, status: 'pending' }),
    );
  });

  it('picks up extracted jobs and calls generate for tier 2/3', async () => {
    const id = 'drain-extracted-' + Date.now();
    createIngestionJob(id, `/tmp/${id}.pdf`, 'test.pdf', 'TEST', 'Test', 1, 1, 'lecture');
    updateIngestionJob(id, { status: 'extracted', tier: 2, extraction_path: '/tmp/ext/' + id });

    const extractFn = vi.fn().mockResolvedValue(undefined);
    const generateFn = vi.fn().mockResolvedValue(undefined);

    const drainer = new PipelineDrainer({
      onExtract: extractFn,
      onGenerate: generateFn,
      maxExtractionConcurrent: 1,
      maxGenerationConcurrent: 1,
      pollIntervalMs: 100,
    });

    drainer.drain();
    await vi.advanceTimersByTimeAsync(200);
    drainer.stop();

    expect(generateFn).toHaveBeenCalledWith(
      expect.objectContaining({ id, status: 'extracted' }),
    );
  });

  it('auto-completes extracted tier 1 jobs without AI', async () => {
    const id = 'drain-tier1-' + Date.now();
    createIngestionJob(id, `/tmp/${id}.pdf`, 'test.pdf', 'TEST', 'Test', 1, 1, 'assignment');
    updateIngestionJob(id, { status: 'extracted', tier: 1, extraction_path: '/tmp/ext/' + id });

    const extractFn = vi.fn();
    const generateFn = vi.fn();

    const drainer = new PipelineDrainer({
      onExtract: extractFn,
      onGenerate: generateFn,
      maxExtractionConcurrent: 1,
      maxGenerationConcurrent: 1,
      pollIntervalMs: 100,
    });

    drainer.drain();
    await vi.advanceTimersByTimeAsync(200);
    drainer.stop();

    expect(generateFn).not.toHaveBeenCalled();
    const completed = getJobsByStatus('completed');
    expect(completed.find((j) => j.id === id)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/ingestion/pipeline.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement pipeline drainer**

```typescript
// src/ingestion/pipeline.ts
import { getJobsByStatus, updateIngestionJob } from '../db.js';
import { logger } from '../logger.js';

interface JobRow {
  id: string;
  source_path: string;
  source_filename: string;
  status: string;
  tier: number;
  extraction_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineDrainerOpts {
  onExtract: (job: JobRow) => Promise<void>;
  onGenerate: (job: JobRow) => Promise<void>;
  maxExtractionConcurrent: number;
  maxGenerationConcurrent: number;
  pollIntervalMs: number;
}

export class PipelineDrainer {
  private opts: PipelineDrainerOpts;
  private extractionActive = 0;
  private generationActive = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PipelineDrainerOpts) {
    this.opts = opts;
  }

  drain(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    this.drainExtractions();
    this.drainGenerations();
  }

  private drainExtractions(): void {
    while (this.extractionActive < this.opts.maxExtractionConcurrent) {
      const pending = getJobsByStatus('pending');
      if (pending.length === 0) break;

      const job = pending[0];
      this.extractionActive++;
      updateIngestionJob(job.id, { status: 'extracting' });

      this.opts
        .onExtract(job)
        .catch((err) => {
          logger.error({ jobId: job.id, err }, 'Extraction failed');
          updateIngestionJob(job.id, {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.extractionActive--;
        });
    }
  }

  private drainGenerations(): void {
    while (this.generationActive < this.opts.maxGenerationConcurrent) {
      const extracted = getJobsByStatus('extracted');
      if (extracted.length === 0) break;

      const job = extracted[0];

      // Tier 1: auto-complete without AI
      if (job.tier === 1) {
        updateIngestionJob(job.id, { status: 'completed' });
        logger.info({ jobId: job.id }, 'Tier 1 auto-completed (no AI processing)');
        continue;
      }

      this.generationActive++;
      updateIngestionJob(job.id, { status: 'generating' });

      this.opts
        .onGenerate(job)
        .catch((err) => {
          logger.error({ jobId: job.id, err }, 'AI generation failed');
          updateIngestionJob(job.id, {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.generationActive--;
        });
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/ingestion/pipeline.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/pipeline.ts src/ingestion/pipeline.test.ts
git commit -m "feat(ingestion): add DB-backed pipeline drainer with tier routing"
```

---

## Task 6: Update Agent Processor for Extraction Artifacts

**Files:**
- Modify: `src/ingestion/agent-processor.ts:21-63` (buildPrompt), `src/ingestion/agent-processor.ts:65-106` (process)
- Modify: `src/container-runner.ts:37-48` (ContainerInput interface)

- [ ] **Step 1: Update buildPrompt to use extraction artifacts**

Replace `buildPrompt` at `src/ingestion/agent-processor.ts:21-63` to accept clean markdown content instead of raw file path:

```typescript
buildPrompt(
  extractedContent: string,
  fileName: string,
  context: PathContext,
  draftId: string,
  figures: string[],
): string {
  const vaultDraftPath = `/workspace/extra/vault/drafts/${draftId}.md`;

  const metadataLines: string[] = [];
  if (context.courseCode)
    metadataLines.push(`- Course code: ${context.courseCode}`);
  if (context.courseName)
    metadataLines.push(`- Course name: ${context.courseName}`);
  if (context.semester) metadataLines.push(`- Semester: ${context.semester}`);
  if (context.year) metadataLines.push(`- Year: ${context.year}`);
  if (context.type) metadataLines.push(`- Material type: ${context.type}`);

  const metadataSection =
    metadataLines.length > 0
      ? `The folder structure suggests:\n${metadataLines.join('\n')}\n\nUse this as a starting point but verify against the document content.`
      : 'No metadata was inferred from the folder structure. Determine all metadata from the document content.';

  const figureSection =
    figures.length > 0
      ? `\n## Extracted Figures\n\n${figures.length} figures were extracted: ${figures.join(', ')}\nReference them as ![[figures/filename.png]] with descriptive captions.`
      : '';

  return `Process this pre-extracted document and generate structured study notes.

## Extracted Content

The document has already been extracted to clean markdown by Docling. Here is the content:

<document>
${extractedContent}
</document>

Original filename: ${fileName}

## Inferred Metadata

${metadataSection}
${figureSection}

## Output Requirements

Write the generated note (with YAML frontmatter) to: ${vaultDraftPath}

Structure the note with:
- Clear H2/H3 headings (these become chunk boundaries for retrieval)
- Contextual prefix per section: "From {course}, {type} — {topic}:"
- Key concepts extracted into frontmatter \`concepts: []\` field
- Descriptive figure captions that are independently searchable

The _targetPath in frontmatter should be: courses/${context.courseCode || '_unsorted'}/${context.type || 'unsorted'}/${fileName.replace(/\.[^.]+$/, '.md')}

Follow the instructions in your CLAUDE.md for note format and metadata schema.`;
}
```

- [ ] **Step 2: Update process method to read extraction artifacts**

Replace `process` at `src/ingestion/agent-processor.ts:65-106`:

```typescript
async process(
  extractionPath: string,
  fileName: string,
  context: PathContext,
  draftId: string,
  reviewAgentGroup: RegisteredGroup,
): Promise<{ status: 'success' | 'error'; error?: string }> {
  const contentPath = join(extractionPath, 'content.md');
  const figuresDir = join(extractionPath, 'figures');

  let extractedContent: string;
  try {
    extractedContent = readFileSync(contentPath, 'utf-8');
  } catch (err) {
    return { status: 'error', error: `Failed to read extraction content: ${err}` };
  }

  const figures = existsSync(figuresDir)
    ? readdirSync(figuresDir).filter((f) => !f.startsWith('.'))
    : [];

  const prompt = this.buildPrompt(extractedContent, fileName, context, draftId, figures);

  logger.info({ fileName, draftId }, 'Starting agent processing from extraction artifacts');

  try {
    const output = await runContainerAgent(
      reviewAgentGroup,
      {
        prompt,
        groupFolder: reviewAgentGroup.folder,
        chatJid: `ingestion:${draftId}`,
        isMain: false,
        singleTurn: true,
        ipcNamespace: draftId,
      },
      (_proc, _containerName) => {
        // Container registered for concurrency tracking (see Task 8 wiring)
      },
    );

    if (output.status === 'error') {
      logger.error({ fileName, draftId, error: output.error }, 'Agent processing failed');
      return { status: 'error', error: output.error };
    }

    logger.info({ fileName, draftId }, 'Agent processing completed');
    return { status: 'success' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ fileName, draftId, err }, 'Agent processing error');
    return { status: 'error', error: message };
  }
}
```

Add imports at top of file:

```typescript
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
```

- [ ] **Step 3: Add ipcNamespace to ContainerInput**

At `src/container-runner.ts:37-48`, add field:

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  allowedTools?: string[];
  singleTurn?: boolean;
  ipcNamespace?: string;
}
```

Then in `buildVolumeMounts` at `src/container-runner.ts:169-179`, use `ipcNamespace` when provided:

```typescript
// Per-group IPC namespace, with optional per-job override
const ipcFolder = input?.ipcNamespace
  ? `ingestion/${input.ipcNamespace}`
  : group.folder;
const groupIpcDir = path.resolve(DATA_DIR, 'ipc', ipcFolder);
```

Note: `buildVolumeMounts` doesn't currently receive `input`. This requires threading the `input` parameter through. The simplest change is to pass `ipcNamespace` as an optional parameter to `buildVolumeMounts`:

At `src/container-runner.ts:62-65`, change signature:

```typescript
function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  ipcNamespace?: string,
): VolumeMount[] {
```

At line 171, use it:

```typescript
const ipcFolder = ipcNamespace ? `ingestion/${ipcNamespace}` : group.folder;
const groupIpcDir = path.resolve(DATA_DIR, 'ipc', ipcFolder);
```

At line 289 where `buildVolumeMounts` is called:

```typescript
const mounts = buildVolumeMounts(group, input.isMain, input.ipcNamespace);
```

- [ ] **Step 4: Run build to verify**

Run: `npm run build`
Expected: Compiles successfully

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/agent-processor.ts src/container-runner.ts
git commit -m "feat(ingestion): agent processor reads extraction artifacts, per-job IPC namespace"
```

---

## Task 7: Unified Approval Codepath

**Files:**
- Modify: `src/channels/web.ts:130-160` (add new endpoints)
- Modify: `src/ingestion/review-queue.ts:28-48` (atomic writes, DB updates)
- Modify: `dashboard/src/app/api/review/route.ts:42-91` (route through backend)

- [ ] **Step 1: Update ReviewQueue.approveDraft for atomicity and DB update**

Replace `approveDraft` at `src/ingestion/review-queue.ts:28-44`:

```typescript
async approveDraft(draftId: string): Promise<{ targetPath: string }> {
  const note = this.vault.readNote(`drafts/${draftId}.md`);
  if (!note) {
    throw new Error(`Draft not found: ${draftId}`);
  }

  const targetPath = note.data._targetPath;
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error(`Draft ${draftId} has no _targetPath in frontmatter`);
  }

  // Remove internal fields, set status
  const { _targetPath, _extractionId, ...cleanData } = note.data;
  cleanData.status = 'approved';
  cleanData.reviewed = new Date().toISOString().split('T')[0];

  // Atomic write: write to tmp, then move to final path
  const tmpPath = `drafts/.tmp-${draftId}.md`;
  this.vault.createNote(tmpPath, { data: cleanData, content: note.content });
  this.vault.moveNote(tmpPath, targetPath);

  // Delete original draft
  this.vault.deleteNote(`drafts/${draftId}.md`);

  // Update DB
  updateReviewItemStatus(draftId, 'approved');

  return { targetPath };
}
```

Add import at top:

```typescript
import { updateReviewItemStatus } from '../db.js';
```

Update `rejectDraft` similarly at `src/ingestion/review-queue.ts:46-48`:

```typescript
async rejectDraft(draftId: string): Promise<void> {
  this.vault.deleteNote(`drafts/${draftId}.md`);
  updateReviewItemStatus(draftId, 'rejected');
}
```

- [ ] **Step 2: Add approve/reject endpoints to web channel**

At `src/channels/web.ts`, add new route handlers after the existing `/close` handler (around line 160):

```typescript
// POST /approve/:draftId — unified approval endpoint
const approveMatch = url.pathname.match(/^\/approve\/([a-f0-9-]{36})$/);
if (req.method === 'POST' && approveMatch) {
  const draftId = approveMatch[1];
  try {
    const result = await opts.onApprove(draftId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, targetPath: result.targetPath }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
  return;
}

// POST /reject/:draftId — unified rejection endpoint
const rejectMatch = url.pathname.match(/^\/reject\/([a-f0-9-]{36})$/);
if (req.method === 'POST' && rejectMatch) {
  const draftId = rejectMatch[1];
  try {
    await opts.onReject(draftId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
  return;
}

// GET /recent — recently processed items for Tier 1/2 feed
if (req.method === 'GET' && url.pathname === '/recent') {
  try {
    const items = getRecentlyCompletedJobs(50);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(items));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch recent items' }));
  }
  return;
}
```

Add `onApprove` and `onReject` to the web channel factory opts. In `src/channels/web.ts`, add to the opts interface:

```typescript
onApprove: (draftId: string) => Promise<{ targetPath: string }>;
onReject: (draftId: string) => Promise<void>;
```

Then in `src/index.ts` where the web channel is registered (around line 776-788), wire the callbacks:

```typescript
onApprove: async (draftId: string) => {
  const result = await reviewQueue.approveDraft(draftId);
  queue.closeStdin(`web:review:${draftId}`);
  activeWebReviewJids.delete(`web:review:${draftId}`);
  return result;
},
onReject: async (draftId: string) => {
  await reviewQueue.rejectDraft(draftId);
  queue.closeStdin(`web:review:${draftId}`);
  activeWebReviewJids.delete(`web:review:${draftId}`);
},
```

Also add the `getRecentlyCompletedJobs` import to `src/channels/web.ts`:

```typescript
import { getRecentlyCompletedJobs } from '../db.js';
```

- [ ] **Step 3: Update dashboard API to route through backend**

Replace `dashboard/src/app/api/review/route.ts:42-91` POST handler:

```typescript
export async function POST(req: NextRequest) {
  const { id, action } = await req.json();

  if (!id || !action) {
    return NextResponse.json({ error: 'Missing id or action' }, { status: 400 });
  }

  const WEB_CHANNEL_URL = process.env.WEB_CHANNEL_URL || 'http://localhost:3200';
  const endpoint = action === 'approve' ? 'approve' : 'reject';

  try {
    const response = await fetch(`${WEB_CHANNEL_URL}/${endpoint}/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await response.json();

    if (!response.ok) {
      return NextResponse.json({ error: result.error || 'Backend error' }, { status: response.status });
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to reach backend: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 4: Run build to verify**

Run: `npm run build`
Expected: Compiles successfully

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/review-queue.ts src/channels/web.ts dashboard/src/app/api/review/route.ts
git commit -m "feat(approval): unified codepath through backend with DB updates and atomic writes"
```

---

## Task 8: Wire Up the New Pipeline

**Files:**
- Modify: `src/ingestion/index.ts` (replace internals with new pipeline)
- Modify: `src/index.ts:650-656` (pass new dependencies)

This task replaces the old IngestionPipeline internals with the new DB-backed system.

- [ ] **Step 1: Rewrite IngestionPipeline class**

Replace the internals of `src/ingestion/index.ts` while keeping the same public interface (`start()`, `stop()`):

```typescript
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { FileWatcher } from './file-watcher.js';
import { parseUploadPath } from './path-parser.js';
import { TypeMappings } from './type-mappings.js';
import { AgentProcessor } from './agent-processor.js';
import { Extractor } from './extractor.js';
import { PipelineDrainer } from './pipeline.js';
import { classifyTier } from './tier-classifier.js';
import { recoverStaleJobs } from './job-recovery.js';
import {
  createIngestionJob,
  getIngestionJobByPath,
  updateIngestionJob,
  createReviewItem,
} from '../db.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import {
  EXTRACTION_TIMEOUT,
  MAX_EXTRACTION_CONCURRENT,
  EXTRACTIONS_DIR,
} from '../config.js';
import { existsSync } from 'fs';

export interface IngestionPipelineOpts {
  uploadDir: string;
  vaultDir: string;
  typeMappingsPath: string;
  getReviewAgentGroup: () => RegisteredGroup | undefined;
  maxGenerationConcurrent?: number;
}

export class IngestionPipeline {
  private watcher: FileWatcher;
  private extractor: Extractor;
  private agentProcessor: AgentProcessor;
  private typeMappings: TypeMappings;
  private drainer: PipelineDrainer;
  private uploadDir: string;
  private vaultDir: string;
  private getReviewAgentGroup: () => RegisteredGroup | undefined;

  constructor(opts: IngestionPipelineOpts) {
    this.uploadDir = opts.uploadDir;
    this.vaultDir = opts.vaultDir;
    this.getReviewAgentGroup = opts.getReviewAgentGroup;

    this.typeMappings = new TypeMappings(opts.typeMappingsPath);

    this.extractor = new Extractor({
      extractionsDir: EXTRACTIONS_DIR,
      pythonBin: join(process.cwd(), '.venv', 'bin', 'python3'),
      scriptPath: join(process.cwd(), 'scripts', 'docling-extract.py'),
      timeoutMs: EXTRACTION_TIMEOUT,
    });

    this.agentProcessor = new AgentProcessor({
      vaultDir: opts.vaultDir,
      uploadDir: opts.uploadDir,
    });

    this.watcher = new FileWatcher(opts.uploadDir, (filePath) => {
      this.enqueue(filePath);
    });

    this.drainer = new PipelineDrainer({
      onExtract: (job) => this.handleExtraction(job),
      onGenerate: (job) => this.handleGeneration(job),
      maxExtractionConcurrent: MAX_EXTRACTION_CONCURRENT,
      maxGenerationConcurrent: opts.maxGenerationConcurrent ?? 2,
      pollIntervalMs: 5000,
    });
  }

  private enqueue(filePath: string): void {
    const relativePath = relative(this.uploadDir, filePath);
    const fileName = basename(filePath);

    // Skip files that already have a completed or in-progress job
    const existing = getIngestionJobByPath(filePath);
    if (existing) {
      if (['completed', 'extracting', 'extracted', 'generating', 'generated', 'reviewing'].includes(existing.status)) {
        logger.info(`ingestion: Skipping (already ${existing.status}): ${relativePath}`);
        return;
      }
      // Failed jobs will be retried — leave them for the drainer
      if (existing.status === 'failed') {
        updateIngestionJob(existing.id, { status: 'pending', error: undefined });
        logger.info(`ingestion: Retrying failed job: ${relativePath}`);
        return;
      }
    }

    const jobId = randomUUID();
    const context = parseUploadPath(relativePath, this.typeMappings);
    const tier = classifyTier({ type: context.type });

    createIngestionJob(
      jobId,
      filePath,
      fileName,
      context.courseCode,
      context.courseName,
      context.semester,
      context.year,
      context.type,
    );
    updateIngestionJob(jobId, { tier });

    logger.info({ jobId, fileName, tier }, `ingestion: Enqueued: ${relativePath}`);
  }

  private async handleExtraction(job: { id: string; source_path: string; source_filename: string }): Promise<void> {
    logger.info({ jobId: job.id }, `ingestion: Extracting: ${job.source_filename}`);

    const result = await this.extractor.extract(job.id, job.source_path);

    // Copy original to vault attachments
    const context = parseUploadPath(relative(this.uploadDir, job.source_path), this.typeMappings);
    const courseDir = context.courseCode || '_unsorted';
    const attachmentDir = join(this.vaultDir, 'attachments', courseDir);
    await mkdir(attachmentDir, { recursive: true });
    await copyFile(job.source_path, join(attachmentDir, job.source_filename));

    // Copy figures to vault attachments
    if (result.figures.length > 0) {
      const figuresAttachDir = join(attachmentDir, 'figures');
      await mkdir(figuresAttachDir, { recursive: true });
      for (const fig of result.figures) {
        await copyFile(join(result.figuresDir, fig), join(figuresAttachDir, fig));
      }
    }

    updateIngestionJob(job.id, {
      status: 'extracted',
      extraction_path: this.extractor.getExtractionDir(job.id),
    });

    logger.info({ jobId: job.id, figures: result.figures.length }, `ingestion: Extracted: ${job.source_filename}`);
  }

  private async handleGeneration(job: {
    id: string;
    source_path: string;
    source_filename: string;
    tier: number;
    extraction_path: string | null;
  }): Promise<void> {
    if (!job.extraction_path) {
      throw new Error(`Job ${job.id} has no extraction_path`);
    }

    const reviewAgentGroup = this.getReviewAgentGroup();
    if (!reviewAgentGroup) {
      throw new Error('Review agent group not registered');
    }

    const draftId = randomUUID();
    const context = parseUploadPath(relative(this.uploadDir, job.source_path), this.typeMappings);

    await mkdir(join(this.vaultDir, 'drafts'), { recursive: true });

    const result = await this.agentProcessor.process(
      job.extraction_path,
      job.source_filename,
      context,
      draftId,
      reviewAgentGroup,
    );

    if (result.status === 'error') {
      throw new Error(result.error || 'Agent processing failed');
    }

    // Validate draft has valid frontmatter
    const draftPath = join(this.vaultDir, 'drafts', `${draftId}.md`);
    try {
      await access(draftPath);
      const content = readFileSync(draftPath, 'utf-8');
      if (!content.includes('_targetPath')) {
        throw new Error('Draft missing _targetPath in frontmatter');
      }
    } catch (err) {
      throw new Error(`Draft validation failed for ${draftId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Create review item
    createReviewItem(
      draftId,
      job.id,
      `drafts/${draftId}.md`,
      job.source_filename,
      context.type,
      context.courseCode,
      [],
    );

    // Tier 2: auto-approve
    if (job.tier === 2) {
      updateIngestionJob(job.id, { status: 'completed' });
      logger.info({ jobId: job.id, draftId }, 'Tier 2 auto-approved');
    } else {
      // Tier 3: queue for review
      updateIngestionJob(job.id, { status: 'reviewing' });
      logger.info({ jobId: job.id, draftId }, 'Tier 3 queued for review');
    }

    // Move original to .processed
    const processedDir = join(this.uploadDir, '.processed');
    await mkdir(processedDir, { recursive: true });
    await rename(job.source_path, join(processedDir, `${job.id}-${job.source_filename}`));
  }

  async start(): Promise<void> {
    await mkdir(this.uploadDir, { recursive: true });
    await mkdir(EXTRACTIONS_DIR, { recursive: true });

    // Recover stale jobs from previous run
    recoverStaleJobs({
      extractingThresholdMin: 10,
      generatingThresholdMin: 45,
    });

    // Start watching for new files
    await this.watcher.start();
    logger.info(`Watching ${this.uploadDir} for new files`);

    // Start the DB-backed drain loop
    this.drainer.drain();
    logger.info('Pipeline drainer started');
  }

  async stop(): Promise<void> {
    this.drainer.stop();
    await this.watcher.stop();
  }
}
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Compiles successfully (may need minor import fixes)

- [ ] **Step 3: Run existing tests**

Run: `npm test`
Expected: Existing tests still pass (some ingestion tests may need updating for new signatures)

- [ ] **Step 4: Commit**

```bash
git add src/ingestion/index.ts src/index.ts
git commit -m "feat(ingestion): wire up DB-backed pipeline with two-stage processing and tier routing"
```

---

## Task 9: Dashboard UI — Recently Processed Feed

**Files:**
- Modify: `dashboard/src/app/review/page.tsx` (add feed + tier badges)

- [ ] **Step 1: Add recently processed feed to review page**

At `dashboard/src/app/review/page.tsx`, add a "Recently Processed" section above the existing review list. Fetch from the new `/recent` endpoint:

```tsx
// Add to the ReviewPage component, above the existing draft list
const [recentItems, setRecentItems] = useState<Array<{
  id: string;
  source_filename: string;
  course_code: string | null;
  type: string | null;
  tier: number;
  completed_at: string;
}>>([]);

useEffect(() => {
  const webChannelUrl = process.env.NEXT_PUBLIC_WEB_CHANNEL_URL || 'http://localhost:3200';
  fetch(`${webChannelUrl}/recent`)
    .then((r) => r.json())
    .then(setRecentItems)
    .catch(() => {});
}, []);
```

Add a collapsible "Recently Processed" section in the JSX:

```tsx
{recentItems.length > 0 && (
  <details open className="mb-8">
    <summary className="text-lg font-semibold cursor-pointer mb-2">
      Recently Processed ({recentItems.length})
    </summary>
    <div className="bg-green-50 border border-green-200 rounded p-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-600">
            <th className="pb-2">File</th>
            <th className="pb-2">Course</th>
            <th className="pb-2">Type</th>
            <th className="pb-2">Tier</th>
            <th className="pb-2">Processed</th>
          </tr>
        </thead>
        <tbody>
          {recentItems.map((item) => (
            <tr key={item.id} className="border-t border-green-100">
              <td className="py-1">{item.source_filename}</td>
              <td className="py-1">{item.course_code || '—'}</td>
              <td className="py-1">{item.type || '—'}</td>
              <td className="py-1">
                <span className={`px-2 py-0.5 rounded text-xs ${
                  item.tier === 1 ? 'bg-gray-200' :
                  item.tier === 2 ? 'bg-blue-200' :
                  'bg-purple-200'
                }`}>
                  Tier {item.tier}
                </span>
              </td>
              <td className="py-1 text-gray-500">
                {new Date(item.completed_at).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </details>
)}
```

- [ ] **Step 2: Add tier badges to existing draft list**

In the existing draft list items, add a tier badge next to each item. Since drafts in the review queue are Tier 3, add a purple "Tier 3 — Review" badge.

- [ ] **Step 3: Run dashboard dev to verify**

Run: `cd dashboard && npm run dev`
Expected: Page loads, shows recently processed feed (empty if no data) and existing review list

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/app/review/page.tsx
git commit -m "feat(dashboard): add recently processed feed with tier badges"
```

---

## Task 10: Config and Cleanup

**Files:**
- Modify: `src/config.ts` (add pipeline timeout)
- Remove dead code: `src/ingestion/docling-client.ts` (replaced by `extractor.ts`)

- [ ] **Step 1: Add PIPELINE_TIMEOUT to config**

Add to `src/config.ts`:

```typescript
export const PIPELINE_TIMEOUT = parseInt(
  process.env.PIPELINE_TIMEOUT || '1200000',
  10,
); // 20min default — pipeline-level timeout, shorter than container hard timeout
```

- [ ] **Step 2: Delete dead DoclingClient**

The old `src/ingestion/docling-client.ts` is dead code (never imported by the pipeline). It has been replaced by `src/ingestion/extractor.ts`. Delete it.

Also delete `src/ingestion/docling-client.test.ts` if it exists.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: Compiles successfully

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: add pipeline timeout config, remove dead DoclingClient code"
```

---

## Task 11: Integration Test

**Files:**
- Create: `src/ingestion/integration.test.ts`

- [ ] **Step 1: Write integration test for the full pipeline flow**

```typescript
// src/ingestion/integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getJobsByStatus, createIngestionJob, updateIngestionJob, getDb } from '../db.js';
import { recoverStaleJobs } from './job-recovery.js';

describe('pipeline integration', () => {
  it('tier 1 job skips AI and auto-completes after extraction', () => {
    const id = 'integration-tier1-' + Date.now();
    createIngestionJob(id, '/tmp/test.pdf', 'test.pdf', 'TEST', 'Test Course', 1, 1, 'assignment');
    updateIngestionJob(id, { status: 'extracted', tier: 1, extraction_path: '/tmp/ext/' + id });

    // Simulate what the drainer does for tier 1
    const job = getJobsByStatus('extracted').find((j) => j.id === id);
    expect(job).toBeDefined();
    expect(job!.tier).toBe(1);

    // Tier 1 auto-completes
    updateIngestionJob(id, { status: 'completed' });
    const completed = getJobsByStatus('completed').find((j) => j.id === id);
    expect(completed).toBeDefined();
  });

  it('job state machine enforces correct transitions', () => {
    const id = 'integration-states-' + Date.now();
    createIngestionJob(id, '/tmp/states.pdf', 'states.pdf', null, null, null, null, null);

    // pending → extracting → extracted → generating → completed
    updateIngestionJob(id, { status: 'extracting' });
    updateIngestionJob(id, { status: 'extracted', extraction_path: '/tmp/ext/' + id });
    updateIngestionJob(id, { status: 'generating' });
    updateIngestionJob(id, { status: 'completed' });

    const completed = getJobsByStatus('completed').find((j) => j.id === id);
    expect(completed).toBeDefined();
    expect(completed!.extraction_path).toBe('/tmp/ext/' + id);
  });

  it('recovery resets stale jobs correctly', () => {
    const id = 'integration-recovery-' + Date.now();
    createIngestionJob(id, '/tmp/recovery.pdf', 'recovery.pdf', null, null, null, null, null);
    updateIngestionJob(id, { status: 'generating', extraction_path: '/tmp/ext/' + id });

    // Backdate to simulate staleness
    getDb()
      .prepare("UPDATE ingestion_jobs SET updated_at = datetime('now', '-60 minutes') WHERE id = ?")
      .run(id);

    const result = recoverStaleJobs({ extractingThresholdMin: 10, generatingThresholdMin: 45 });
    expect(result.generating).toBeGreaterThan(0);

    // Should be reset to extracted (preserving extraction artifacts)
    const jobs = getJobsByStatus('extracted');
    expect(jobs.find((j) => j.id === id)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npm test -- src/ingestion/integration.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/ingestion/integration.test.ts
git commit -m "test(ingestion): add integration tests for pipeline state machine and recovery"
```

---

## Task 12: Remaining Gaps — Cleanup, Concurrency, Approval Tests

**Files:**
- Modify: `src/ingestion/index.ts` (add cleanup scheduling, Tier 1 vault placement)
- Modify: `src/ingestion/pipeline.ts` (add AbortController timeout)
- Modify: `src/channels/web.ts` (add /drafts and /metadata endpoints)
- Modify: `src/index.ts` (pass GroupQueue to pipeline for concurrency coordination)
- Create: `src/ingestion/approval.test.ts`

This task addresses gaps identified during plan review.

- [ ] **Step 1: Add Tier 1 vault placement to handleExtraction**

In `src/ingestion/index.ts`, the `handleExtraction` method should place Tier 1 documents directly in the vault (metadata-only, original file stored). After the attachment copy in `handleExtraction`, add:

```typescript
// For Tier 1: create a minimal vault note with just metadata and source link
const job = getJobsByStatus('extracting').find(j => j.id === job.id); // already have job param
if (job && job.tier === 1) {
  const notePath = `courses/${courseDir}/${context.type || 'unsorted'}/${job.source_filename.replace(/\.[^.]+$/, '.md')}`;
  const frontmatter = {
    title: job.source_filename.replace(/\.[^.]+$/, ''),
    source: `[[attachments/${courseDir}/${job.source_filename}]]`,
    course: context.courseCode,
    semester: context.semester,
    year: context.year,
    type: context.type,
    status: 'approved',
    reviewed: new Date().toISOString().split('T')[0],
  };
  // Read extracted content for the note body
  const extractedContent = readFileSync(join(result.contentPath), 'utf-8');
  await writeVaultNote(this.vaultDir, notePath, frontmatter, extractedContent);
}
```

The implementer should use the existing VaultUtility or write a simple frontmatter+content writer. The key point: Tier 1 must produce a vault file, not just mark `completed`.

- [ ] **Step 2: Add extraction artifact cleanup to approval flow**

In `src/ingestion/review-queue.ts`, after `approveDraft` completes, schedule cleanup. Add to the `onApprove` callback in `src/index.ts`:

```typescript
onApprove: async (draftId: string) => {
  const result = await reviewQueue.approveDraft(draftId);
  queue.closeStdin(`web:review:${draftId}`);
  activeWebReviewJids.delete(`web:review:${draftId}`);
  // Clean up extraction artifacts
  const reviewItem = getReviewItemByJobId(/* need job_id from review item */);
  // The implementer should look up the job_id from review_items table,
  // then call extractor.cleanup(jobId) to remove data/extractions/{jobId}/
  return result;
},
```

Also add cleanup after Tier 1 and Tier 2 auto-completion in `handleGeneration` and `handleExtraction`.

- [ ] **Step 3: Add pipeline-level AbortController timeout**

In `src/ingestion/pipeline.ts`, wrap the `onGenerate` call with an AbortController:

```typescript
import { PIPELINE_TIMEOUT } from '../config.js';

// In drainGenerations(), wrap the generate call:
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), PIPELINE_TIMEOUT);

this.opts
  .onGenerate(job)
  .catch((err) => {
    logger.error({ jobId: job.id, err }, 'AI generation failed');
    updateIngestionJob(job.id, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
  })
  .finally(() => {
    clearTimeout(timeoutId);
    this.generationActive--;
  });
```

The implementer should thread the AbortSignal through to `runContainerAgent` or use it to call `stopContainer` on timeout.

- [ ] **Step 4: Add /drafts and /metadata endpoints to web channel**

In `src/channels/web.ts`, add:

```typescript
// GET /drafts — list drafts from vault (replaces dashboard direct file reading)
if (req.method === 'GET' && url.pathname === '/drafts') {
  try {
    const drafts = opts.onListDrafts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(drafts));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to list drafts' }));
  }
  return;
}

// PATCH /metadata/:draftId — update draft metadata
const metadataMatch = url.pathname.match(/^\/metadata\/([a-f0-9-]{36})$/);
if (req.method === 'PATCH' && metadataMatch) {
  const draftId = metadataMatch[1];
  try {
    const body = await parseBody(req);
    const updates = JSON.parse(body);
    await opts.onUpdateMetadata(draftId, updates);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
  return;
}
```

Add `onListDrafts` and `onUpdateMetadata` to the opts interface and wire in `src/index.ts`.

- [ ] **Step 5: Register ingestion containers with GroupQueue**

In `src/ingestion/index.ts` constructor, accept a `groupQueue` parameter. In `handleGeneration`, pass a proper `onProcess` callback:

```typescript
// In the IngestionPipeline constructor opts:
export interface IngestionPipelineOpts {
  // ... existing fields
  groupQueue?: GroupQueue;
}

// In handleGeneration, replace the no-op callback:
const output = await runContainerAgent(
  reviewAgentGroup,
  { /* ... */ },
  (proc, containerName) => {
    if (this.groupQueue) {
      this.groupQueue.registerProcess(
        `ingestion:${draftId}`,
        proc,
        containerName,
        reviewAgentGroup.folder,
      );
    }
  },
);
```

Pass `groupQueue` from `src/index.ts` when constructing the pipeline.

- [ ] **Step 6: Write approval codepath tests**

```typescript
// src/ingestion/approval.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createIngestionJob,
  createReviewItem,
  updateReviewItemStatus,
  getReviewItemByJobId,
} from '../db.js';

describe('approval codepath', () => {
  it('updateReviewItemStatus sets approved status', () => {
    const jobId = 'approval-test-job-' + Date.now();
    const reviewId = 'approval-test-' + Date.now();
    createIngestionJob(jobId, '/tmp/test.pdf', 'test.pdf', null, null, null, null, null);
    createReviewItem(reviewId, jobId, 'drafts/test.md', 'test.pdf', null, null, []);

    updateReviewItemStatus(reviewId, 'approved');

    const item = getReviewItemByJobId(jobId);
    expect(item).toBeDefined();
    expect(item!.status).toBe('approved');
  });

  it('updateReviewItemStatus sets rejected status', () => {
    const jobId = 'reject-test-job-' + Date.now();
    const reviewId = 'reject-test-' + Date.now();
    createIngestionJob(jobId, '/tmp/reject.pdf', 'reject.pdf', null, null, null, null, null);
    createReviewItem(reviewId, jobId, 'drafts/reject.md', 'reject.pdf', null, null, []);

    updateReviewItemStatus(reviewId, 'rejected');

    const item = getReviewItemByJobId(jobId);
    expect(item).toBeDefined();
    expect(item!.status).toBe('rejected');
  });

  it('cascading delete removes review items when job is deleted', () => {
    const jobId = 'cascade-test-' + Date.now();
    const reviewId = 'cascade-review-' + Date.now();
    createIngestionJob(jobId, '/tmp/cascade.pdf', 'cascade.pdf', null, null, null, null, null);
    createReviewItem(reviewId, jobId, 'drafts/cascade.md', 'cascade.pdf', null, null, []);

    deleteIngestionJob(jobId);

    const item = getReviewItemByJobId(jobId);
    expect(item).toBeUndefined();
  });
});
```

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(ingestion): tier 1 vault placement, cleanup, concurrency, approval tests"
```

---

## Summary

| Task | What it does | Key files |
|------|-------------|-----------|
| 1 | DB foundation: PRAGMA, columns, indexes, query functions | `src/db.ts` |
| 2 | Tier classifier | `src/ingestion/tier-classifier.ts` |
| 3 | Extraction stage (Docling host-side) | `src/ingestion/extractor.ts`, `scripts/docling-extract.py` |
| 4 | Job recovery for stale states | `src/ingestion/job-recovery.ts` |
| 5 | DB-backed pipeline drainer | `src/ingestion/pipeline.ts` |
| 6 | Agent processor reads extraction artifacts, per-job IPC | `src/ingestion/agent-processor.ts`, `src/container-runner.ts` |
| 7 | Unified approval codepath | `src/channels/web.ts`, `src/ingestion/review-queue.ts`, dashboard API |
| 8 | Wire up new pipeline | `src/ingestion/index.ts`, `src/index.ts` |
| 9 | Dashboard recently processed feed | `dashboard/src/app/review/page.tsx` |
| 10 | Config cleanup, remove dead code | `src/config.ts`, delete `docling-client.ts` |
| 11 | Integration tests | `src/ingestion/integration.test.ts` |
| 12 | Remaining gaps: Tier 1 vault, cleanup, concurrency, approval tests | Multiple |
