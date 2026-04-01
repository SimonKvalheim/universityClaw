# Upload Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the dashboard upload page into a full ingestion management interface with multi-file upload, real-time status polling, rate-limit recovery, retry controls, and vault output preview.

**Architecture:** Shared SQLite DB reader for dashboard API routes, two React hooks (`useFileUpload`, `useIngestionJobs`) composing a thin page component, pipeline changes for `rate_limited` status and dynamic concurrency. All progress tracking via HTTP polling at 3-second intervals.

**Tech Stack:** Next.js 16, React 19, better-sqlite3, Tailwind CSS 4, Vitest

**Spec:** `docs/superpowers/specs/2026-04-01-upload-page-redesign.md`

**Important:** This Next.js version returns `params` as a **Promise** — always `await params` in route handlers. Check `dashboard/node_modules/next/dist/docs/` for API reference if unsure about any Next.js API.

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/shared/db-reader.ts` | Read-only + limited-write SQLite access for dashboard; opens `store/messages.db` with `readonly` for queries, separate writer for mutations |
| `dashboard/src/app/api/ingestion/jobs/route.ts` | `GET` — list last 20 jobs with optional `?status=` filter |
| `dashboard/src/app/api/ingestion/jobs/[id]/route.ts` | `GET` — single job detail with promoted vault paths |
| `dashboard/src/app/api/ingestion/retry/[id]/route.ts` | `POST` — stage-aware retry for failed jobs |
| `dashboard/src/app/api/ingestion/settings/route.ts` | `GET` + `PATCH` — pipeline concurrency setting |
| `dashboard/src/hooks/useFileUpload.ts` | Multi-file staging, validation, batch upload, duplicate detection |
| `dashboard/src/hooks/useIngestionJobs.ts` | Job status polling with tab-visibility pause, retry action |
| `dashboard/src/app/upload/components/DropZone.tsx` | Drop zone with staging list UI |
| `dashboard/src/app/upload/components/JobList.tsx` | Grouped collapsible job list (In Progress / Completed / Failed) |
| `dashboard/src/app/upload/components/JobRow.tsx` | Single job row with status badge, progress bar, actions |

### Modified files
| File | Changes |
|------|---------|
| `src/db.ts` | Add `retry_after` + `retry_count` column migrations, `settings` table, new query helpers |
| `src/ingestion/pipeline.ts` | Add `drainRateLimited()`, dynamic concurrency getter, `JobRow` interface update |
| `src/ingestion/index.ts` | Rate-limit detection in `handleGeneration`, store promoted paths in DB |
| `src/ingestion/job-recovery.ts` | Also mark `rate_limited` jobs as failed on restart |
| `dashboard/src/app/api/upload/route.ts` | Multi-file support, filename collision avoidance, 100 MB limit |
| `dashboard/src/app/upload/page.tsx` | Full rewrite composing hooks + components |
| `dashboard/package.json` | Add `better-sqlite3` + `@types/better-sqlite3` |

---

## Task 1: DB Schema — Add `retry_after`, `retry_count`, and `settings` table

**Files:**
- Modify: `src/db.ts:167-174` (after existing ingestion migrations)
- Test: `src/db.test.ts`

- [ ] **Step 1: Write failing test for new columns and settings table**

```typescript
// In src/db.test.ts — add at end of file
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDb,
  createIngestionJob,
  updateIngestionJob,
  getIngestionJobs,
  getSetting,
  setSetting,
} from './db.js';

describe('ingestion job retry columns', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  it('stores and retrieves retry_after and retry_count', () => {
    createIngestionJob('job-1', '/tmp/test.pdf', 'test.pdf');
    updateIngestionJob('job-1', {
      status: 'rate_limited',
      error: 'rate limit exceeded',
      retry_after: '2026-04-01T12:00:00Z',
      retry_count: 1,
    });
    const jobs = getIngestionJobs('rate_limited') as Array<{
      id: string;
      retry_after: string;
      retry_count: number;
    }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].retry_after).toBe('2026-04-01T12:00:00Z');
    expect(jobs[0].retry_count).toBe(1);
  });
});

describe('settings table', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  it('returns default when setting does not exist', () => {
    expect(getSetting('maxGenerationConcurrent', '1')).toBe('1');
  });

  it('stores and retrieves a setting', () => {
    setSetting('maxGenerationConcurrent', '3');
    expect(getSetting('maxGenerationConcurrent', '1')).toBe('3');
  });

  it('overwrites existing setting', () => {
    setSetting('maxGenerationConcurrent', '3');
    setSetting('maxGenerationConcurrent', '5');
    expect(getSetting('maxGenerationConcurrent', '1')).toBe('5');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts --reporter=verbose`
Expected: FAIL — `getSetting` and `setSetting` are not exported, `retry_after`/`retry_count` not recognized.

- [ ] **Step 3: Add migrations and new functions to db.ts**

In `src/db.ts`, after the `content_hash` migration block (line ~174), add:

```typescript
  // Add retry_after and retry_count columns for rate-limit recovery
  try {
    database.exec(`ALTER TABLE ingestion_jobs ADD COLUMN retry_after TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE ingestion_jobs ADD COLUMN retry_count INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add promoted_paths column to store vault paths after promotion
  try {
    database.exec(
      `ALTER TABLE ingestion_jobs ADD COLUMN promoted_paths TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Settings table (key-value)
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
```

Update `updateIngestionJob` to accept the new fields. In `src/db.ts`, change the `updates` parameter type (line ~776):

```typescript
export function updateIngestionJob(
  id: string,
  updates: {
    status?: string;
    extraction_path?: string | null;
    error?: string | null;
    content_hash?: string;
    retry_after?: string | null;
    retry_count?: number;
    promoted_paths?: string | null;
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
  if (updates.extraction_path !== undefined) {
    setClauses.push('extraction_path = ?');
    values.push(updates.extraction_path);
  }
  if (updates.error !== undefined) {
    setClauses.push('error = ?');
    values.push(updates.error);
  }
  if (updates.content_hash !== undefined) {
    setClauses.push('content_hash = ?');
    values.push(updates.content_hash);
  }
  if (updates.retry_after !== undefined) {
    setClauses.push('retry_after = ?');
    values.push(updates.retry_after);
  }
  if (updates.retry_count !== undefined) {
    setClauses.push('retry_count = ?');
    values.push(updates.retry_count);
  }
  if (updates.promoted_paths !== undefined) {
    setClauses.push('promoted_paths = ?');
    values.push(updates.promoted_paths);
  }

  values.push(id);
  getDb()
    .prepare(`UPDATE ingestion_jobs SET ${setClauses.join(', ')} WHERE id = ?`)
    .run(...values);
}
```

Add settings functions after the ingestion job section:

```typescript
// --- Settings ---

export function getSetting(key: string, defaultValue: string): string {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? defaultValue;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): add retry_after, retry_count, promoted_paths columns and settings table"
```

---

## Task 2: Pipeline — Rate-limit detection and `drainRateLimited`

**Files:**
- Modify: `src/ingestion/pipeline.ts`
- Modify: `src/ingestion/index.ts:186-341`
- Modify: `src/ingestion/job-recovery.ts`
- Test: `src/ingestion/pipeline.test.ts`

- [ ] **Step 1: Write failing test for rate-limit auto-retry in PipelineDrainer**

```typescript
// Add to src/ingestion/pipeline.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db module before importing pipeline
vi.mock('../db.js', () => ({
  getJobsByStatus: vi.fn().mockReturnValue([]),
  updateIngestionJob: vi.fn(),
  getSetting: vi.fn().mockReturnValue('1'),
}));

import { PipelineDrainer } from './pipeline.js';
import { getJobsByStatus, updateIngestionJob } from '../db.js';

describe('drainRateLimited', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resets rate_limited jobs past retry_after to their pre-failure status', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    vi.mocked(getJobsByStatus).mockImplementation((status: string) => {
      if (status === 'rate_limited') {
        return [
          {
            id: 'job-1',
            source_path: '/tmp/a.pdf',
            source_filename: 'a.pdf',
            status: 'rate_limited',
            extraction_path: '/data/extractions/job-1',
            retry_after: pastDate,
            retry_count: 0,
            error: 'generating:rate limit exceeded',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ];
      }
      return [];
    });

    const drainer = new PipelineDrainer({
      onExtract: vi.fn(),
      onGenerate: vi.fn(),
      onPromote: vi.fn(),
      maxExtractionConcurrent: 1,
      maxGenerationConcurrent: () => 1,
      pollIntervalMs: 5000,
    });

    await drainer.tick();

    expect(updateIngestionJob).toHaveBeenCalledWith('job-1', {
      status: 'extracted',
      error: null,
      retry_after: null,
      retry_count: 1,
    });
  });

  it('skips rate_limited jobs whose retry_after is in the future', async () => {
    const futureDate = new Date(Date.now() + 300_000).toISOString();
    vi.mocked(getJobsByStatus).mockImplementation((status: string) => {
      if (status === 'rate_limited') {
        return [
          {
            id: 'job-2',
            status: 'rate_limited',
            retry_after: futureDate,
            retry_count: 0,
            error: 'generating:rate limit exceeded',
          },
        ];
      }
      return [];
    });

    const drainer = new PipelineDrainer({
      onExtract: vi.fn(),
      onGenerate: vi.fn(),
      onPromote: vi.fn(),
      maxExtractionConcurrent: 1,
      maxGenerationConcurrent: () => 1,
      pollIntervalMs: 5000,
    });

    await drainer.tick();

    expect(updateIngestionJob).not.toHaveBeenCalledWith(
      'job-2',
      expect.objectContaining({ status: 'extracted' }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ingestion/pipeline.test.ts --reporter=verbose`
Expected: FAIL — `maxGenerationConcurrent` is not a function, `drainRateLimited` doesn't exist.

- [ ] **Step 3: Update PipelineDrainer to support dynamic concurrency and rate-limit recovery**

Replace `src/ingestion/pipeline.ts` entirely:

```typescript
import { getJobsByStatus, updateIngestionJob, getSetting } from '../db.js';

export interface JobRow {
  id: string;
  source_path: string;
  source_filename: string;
  status: string;
  extraction_path: string | null;
  created_at: string;
  updated_at: string;
  retry_after?: string | null;
  retry_count?: number;
  error?: string | null;
}

export interface PipelineDrainerOpts {
  onExtract: (job: JobRow) => Promise<void>;
  onGenerate: (job: JobRow) => Promise<void>;
  onPromote: (job: JobRow) => Promise<void>;
  onComplete?: (job: JobRow) => Promise<void>;
  maxExtractionConcurrent: number;
  maxGenerationConcurrent: number | (() => number);
  pollIntervalMs: number;
}

/** Map from the "error: stage:message" prefix to the status to reset to on retry. */
const STAGE_RETRY_MAP: Record<string, string> = {
  extracting: 'pending',
  generating: 'extracted',
  promoting: 'generated',
};

export class PipelineDrainer {
  private opts: PipelineDrainerOpts;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeExtractions = 0;
  private activeGenerations = 0;
  private inFlight: Set<Promise<void>> = new Set();

  constructor(opts: PipelineDrainerOpts) {
    this.opts = opts;
  }

  private getMaxGenerationConcurrent(): number {
    const val = this.opts.maxGenerationConcurrent;
    return typeof val === 'function' ? val() : val;
  }

  drain(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async tick(): Promise<void> {
    this.drainRateLimited();
    await this.drainExtractions();
    await this.drainGenerations();
    await this.drainPromotions();
  }

  drainRateLimited(): void {
    const jobs = getJobsByStatus('rate_limited') as JobRow[];
    const now = Date.now();

    for (const job of jobs) {
      if (!job.retry_after) continue;
      if (new Date(job.retry_after).getTime() > now) continue;

      // Determine which stage to reset to from the error prefix
      const errorPrefix = job.error?.split(':')[0] ?? '';
      const resetStatus = STAGE_RETRY_MAP[errorPrefix] ?? 'pending';

      updateIngestionJob(job.id, {
        status: resetStatus,
        error: null,
        retry_after: null,
        retry_count: (job.retry_count ?? 0) + 1,
      });
    }
  }

  async drainExtractions(): Promise<void> {
    const slots = this.opts.maxExtractionConcurrent - this.activeExtractions;
    if (slots <= 0) return;

    const pending = getJobsByStatus('pending') as JobRow[];
    const batch = pending.slice(0, slots);

    for (const job of batch) {
      updateIngestionJob(job.id, { status: 'extracting' });
      this.activeExtractions++;
      const p = this.opts
        .onExtract(job)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          updateIngestionJob(job.id, { status: 'failed', error: `extracting:${msg}` });
        })
        .finally(() => {
          this.activeExtractions--;
          this.inFlight.delete(p);
        });
      this.inFlight.add(p);
    }
  }

  async drainGenerations(): Promise<void> {
    const maxConcurrent = this.getMaxGenerationConcurrent();
    const slots = maxConcurrent - this.activeGenerations;
    if (slots <= 0) return;

    const extracted = getJobsByStatus('extracted') as JobRow[];

    for (const job of extracted) {
      if (this.activeGenerations >= maxConcurrent) break;

      updateIngestionJob(job.id, { status: 'generating' });
      this.activeGenerations++;
      const p = this.opts
        .onGenerate(job)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          updateIngestionJob(job.id, { status: 'failed', error: `generating:${msg}` });
        })
        .finally(() => {
          this.activeGenerations--;
          this.inFlight.delete(p);
        });
      this.inFlight.add(p);
    }
  }

  async drainPromotions(): Promise<void> {
    const generated = getJobsByStatus('generated') as JobRow[];
    for (const job of generated) {
      updateIngestionJob(job.id, { status: 'promoting' });
      try {
        await this.opts.onPromote(job);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        updateIngestionJob(job.id, { status: 'failed', error: `promoting:${msg}` });
      }
    }
  }
}
```

Key changes:
- `maxGenerationConcurrent` accepts `number | (() => number)`
- Error messages are now prefixed with the stage name (`extracting:`, `generating:`, `promoting:`) for stage-aware retry
- `drainRateLimited()` runs at start of each tick, resets eligible jobs
- `JobRow` includes `retry_after`, `retry_count`, `error`

- [ ] **Step 4: Update IngestionPipeline constructor to use dynamic concurrency getter**

In `src/ingestion/index.ts`, change line 68 in the constructor:

```typescript
// Before:
maxGenerationConcurrent: opts.maxGenerationConcurrent ?? 1,

// After:
maxGenerationConcurrent: () => {
  const val = getSetting('maxGenerationConcurrent', '1');
  return Math.max(1, Math.min(5, parseInt(val, 10) || 1));
},
```

Add the import at the top of `src/ingestion/index.ts`:

```typescript
import { getSetting } from '../db.js';
```

- [ ] **Step 5: Add rate-limit detection to handleGeneration**

In `src/ingestion/index.ts`, in `handleGeneration` (around line 320-333), the error is currently thrown up to the drainer's catch handler. We need to intercept rate-limit errors before they throw. Wrap the error-throwing section:

After the `Promise.allSettled` block (around line 315-333), replace with:

```typescript
    const [containerSettled, validationSettled] = await Promise.allSettled([
      containerPromise,
      validationPromise,
    ]);

    // Check for rate-limit errors before re-throwing
    const errorToCheck =
      containerSettled.status === 'rejected'
        ? containerSettled.reason
        : validationSettled.status === 'rejected'
          ? validationSettled.reason
          : containerSettled.status === 'fulfilled' &&
              containerSettled.value.status === 'error'
            ? new Error(containerSettled.value.error || 'Agent processing failed')
            : null;

    if (errorToCheck) {
      const msg =
        errorToCheck instanceof Error ? errorToCheck.message : String(errorToCheck);
      if (isRateLimitError(msg)) {
        const retryCount = (
          getIngestionJobs() as Array<{ id: string; retry_count: number }>
        ).find((j) => j.id === job.id)?.retry_count ?? 0;
        const delayMs =
          retryCount === 0 ? 5 * 60_000 : retryCount === 1 ? 15 * 60_000 : 60 * 60_000;
        const retryAfter = new Date(Date.now() + delayMs).toISOString();
        updateIngestionJob(job.id, {
          status: 'rate_limited',
          error: `generating:${msg}`,
          retry_after: retryAfter,
        });
        logger.warn(
          { jobId: job.id, retryAfter, retryCount },
          `ingestion: Rate limited — will retry after ${retryAfter}`,
        );
        // Do NOT re-throw — the drainer catch would override to 'failed'
        return;
      }
      throw errorToCheck;
    }

    updateIngestionJob(job.id, { status: 'generated' });

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Generated: ${relativePath}`,
    );
```

Add the helper function above the class:

```typescript
const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /session.?limit/i,
  /overloaded/i,
  /429/,
  /529/,
  /too many requests/i,
  /capacity/i,
];

function isRateLimitError(msg: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(msg));
}
```

- [ ] **Step 6: Store promoted paths in handlePromotion**

In `src/ingestion/index.ts`, in `handlePromotion` (around line 405), change the final status update:

```typescript
// Before:
updateIngestionJob(job.id, { status: 'completed' });

// After:
updateIngestionJob(job.id, {
  status: 'completed',
  promoted_paths: JSON.stringify(promotedPaths),
});
```

- [ ] **Step 7: Update job-recovery.ts to include rate_limited**

In `src/ingestion/job-recovery.ts`, change line 9:

```typescript
// Before:
const inProgressStatuses = ['extracting', 'generating', 'promoting'];

// After:
const inProgressStatuses = ['extracting', 'generating', 'promoting', 'rate_limited'];
```

- [ ] **Step 8: Run all ingestion tests**

Run: `npx vitest run src/ingestion/ --reporter=verbose`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/ingestion/pipeline.ts src/ingestion/index.ts src/ingestion/job-recovery.ts src/ingestion/pipeline.test.ts
git commit -m "feat(ingestion): add rate_limited status, stage-aware retry, dynamic concurrency"
```

---

## Task 3: Shared DB Reader for Dashboard

**Files:**
- Create: `src/shared/db-reader.ts`
- Test: `src/shared/db-reader.test.ts`

- [ ] **Step 1: Write failing test for the shared DB reader**

```typescript
// src/shared/db-reader.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, createIngestionJob, updateIngestionJob, setSetting } from '../db.js';
import { getRecentJobs, getJobDetail, getSettings, retryJob, updateSettings } from './db-reader.js';

describe('db-reader', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  describe('getRecentJobs', () => {
    it('returns jobs ordered by created_at desc', () => {
      createIngestionJob('a', '/tmp/a.pdf', 'a.pdf');
      createIngestionJob('b', '/tmp/b.pdf', 'b.pdf');
      const jobs = getRecentJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs[0].id).toBe('b');
    });

    it('filters by status', () => {
      createIngestionJob('a', '/tmp/a.pdf', 'a.pdf');
      createIngestionJob('b', '/tmp/b.pdf', 'b.pdf');
      updateIngestionJob('a', { status: 'completed' });
      const jobs = getRecentJobs('completed');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('a');
    });

    it('limits to 20 results', () => {
      for (let i = 0; i < 25; i++) {
        createIngestionJob(`j${i}`, `/tmp/${i}.pdf`, `${i}.pdf`);
      }
      expect(getRecentJobs()).toHaveLength(20);
    });
  });

  describe('getJobDetail', () => {
    it('returns null for non-existent job', () => {
      expect(getJobDetail('nope')).toBeNull();
    });

    it('returns promoted paths for completed jobs', () => {
      createIngestionJob('a', '/tmp/a.pdf', 'a.pdf');
      updateIngestionJob('a', {
        status: 'completed',
        promoted_paths: JSON.stringify(['sources/a.md', 'concepts/b.md']),
      });
      const detail = getJobDetail('a');
      expect(detail).not.toBeNull();
      expect(detail!.promotedPaths).toEqual(['sources/a.md', 'concepts/b.md']);
    });
  });

  describe('retryJob', () => {
    it('resets a failed extracting job to pending', () => {
      createIngestionJob('a', '/tmp/a.pdf', 'a.pdf');
      updateIngestionJob('a', { status: 'failed', error: 'extracting:timeout' });
      const result = retryJob('a');
      expect(result.ok).toBe(true);
      const jobs = getRecentJobs('pending');
      expect(jobs).toHaveLength(1);
    });

    it('resets a failed generating job to extracted', () => {
      createIngestionJob('a', '/tmp/a.pdf', 'a.pdf');
      updateIngestionJob('a', { status: 'failed', error: 'generating:crash' });
      const result = retryJob('a');
      expect(result.ok).toBe(true);
      const jobs = getRecentJobs('extracted');
      expect(jobs).toHaveLength(1);
    });

    it('returns error for non-failed jobs', () => {
      createIngestionJob('a', '/tmp/a.pdf', 'a.pdf');
      const result = retryJob('a');
      expect(result.ok).toBe(false);
    });
  });

  describe('settings', () => {
    it('reads and writes maxGenerationConcurrent', () => {
      expect(getSettings()).toEqual({ maxGenerationConcurrent: 1 });
      updateSettings({ maxGenerationConcurrent: 3 });
      expect(getSettings()).toEqual({ maxGenerationConcurrent: 3 });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/db-reader.test.ts --reporter=verbose`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the shared DB reader**

```typescript
// src/shared/db-reader.ts
import {
  getIngestionJobs,
  updateIngestionJob,
  getSetting,
  setSetting,
} from '../db.js';

export interface JobSummary {
  id: string;
  filename: string;
  status: string;
  error: string | null;
  retryAfter: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface JobDetail extends JobSummary {
  promotedPaths: string[] | null;
}

interface RawJob {
  id: string;
  source_filename: string;
  status: string;
  error: string | null;
  retry_after: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  promoted_paths: string | null;
}

function toJobSummary(row: RawJob): JobSummary {
  return {
    id: row.id,
    filename: row.source_filename,
    status: row.status,
    error: row.error,
    retryAfter: row.retry_after,
    retryCount: row.retry_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function getRecentJobs(status?: string): JobSummary[] {
  const rows = getIngestionJobs(status) as RawJob[];
  return rows.slice(0, 20).map(toJobSummary);
}

export function getJobDetail(id: string): JobDetail | null {
  const rows = getIngestionJobs() as RawJob[];
  const row = rows.find((r) => r.id === id);
  if (!row) return null;

  let promotedPaths: string[] | null = null;
  if (row.promoted_paths) {
    try {
      promotedPaths = JSON.parse(row.promoted_paths);
    } catch {
      promotedPaths = null;
    }
  }

  return { ...toJobSummary(row), promotedPaths };
}

const STAGE_RETRY_MAP: Record<string, string> = {
  extracting: 'pending',
  generating: 'extracted',
  promoting: 'generated',
};

export function retryJob(
  id: string,
): { ok: true } | { ok: false; error: string } {
  const rows = getIngestionJobs() as RawJob[];
  const job = rows.find((r) => r.id === id);
  if (!job) return { ok: false, error: 'Job not found' };
  if (job.status !== 'failed') return { ok: false, error: 'Job is not failed' };

  const errorPrefix = job.error?.split(':')[0] ?? '';
  const resetStatus = STAGE_RETRY_MAP[errorPrefix] ?? 'pending';

  updateIngestionJob(id, {
    status: resetStatus,
    error: null,
    retry_after: null,
  });

  return { ok: true };
}

export function getSettings(): { maxGenerationConcurrent: number } {
  const val = getSetting('maxGenerationConcurrent', '1');
  return { maxGenerationConcurrent: Math.max(1, Math.min(5, parseInt(val, 10) || 1)) };
}

export function updateSettings(settings: {
  maxGenerationConcurrent: number;
}): void {
  const clamped = Math.max(1, Math.min(5, settings.maxGenerationConcurrent));
  setSetting('maxGenerationConcurrent', String(clamped));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/db-reader.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/db-reader.ts src/shared/db-reader.test.ts
git commit -m "feat: add shared db-reader module for dashboard API routes"
```

---

## Task 4: Dashboard API Routes — Jobs, Retry, Settings

**Files:**
- Create: `dashboard/src/app/api/ingestion/jobs/route.ts`
- Create: `dashboard/src/app/api/ingestion/jobs/[id]/route.ts`
- Create: `dashboard/src/app/api/ingestion/retry/[id]/route.ts`
- Create: `dashboard/src/app/api/ingestion/settings/route.ts`
- Modify: `dashboard/package.json`

- [ ] **Step 1: Add better-sqlite3 dependency to dashboard**

Run: `cd dashboard && npm install better-sqlite3 @types/better-sqlite3`

`next.config.ts` already has `serverExternalPackages: ['better-sqlite3']` so no change needed there.

- [ ] **Step 2: Ensure the main DB is initialized when dashboard API routes import shared module**

The dashboard's API routes need the DB to be initialized. Since `src/db.ts` uses `initDb()` which is called by the main process on startup, the shared reader needs to handle initialization. Add an auto-init guard to `src/shared/db-reader.ts`:

At the top of `src/shared/db-reader.ts`, add:

```typescript
import { initDb } from '../db.js';

// Auto-initialize DB if not already done (for dashboard process)
try {
  initDb();
} catch {
  // Already initialized
}
```

- [ ] **Step 3: Create GET /api/ingestion/jobs**

```typescript
// dashboard/src/app/api/ingestion/jobs/route.ts
import { getRecentJobs } from '../../../../shared/db-reader.js';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? undefined;
  const jobs = getRecentJobs(status);
  return Response.json({ jobs });
}
```

Note: The import path goes from `dashboard/src/app/api/ingestion/jobs/` up to `src/shared/`. Since the dashboard's `tsconfig.json` has `"@/*": ["./src/*"]`, and `src/shared/` is in the parent project, we use a relative path. This may need adjustment — check at build time. If the relative import fails, add a path alias in `dashboard/tsconfig.json`:

```json
"paths": {
  "@/*": ["./src/*"],
  "@shared/*": ["../src/shared/*"]
}
```

- [ ] **Step 4: Create GET /api/ingestion/jobs/[id]**

```typescript
// dashboard/src/app/api/ingestion/jobs/[id]/route.ts
import { getJobDetail } from '../../../../../shared/db-reader.js';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = getJobDetail(id);
  if (!job) {
    return Response.json({ error: 'Job not found' }, { status: 404 });
  }
  return Response.json(job);
}
```

- [ ] **Step 5: Create POST /api/ingestion/retry/[id]**

```typescript
// dashboard/src/app/api/ingestion/retry/[id]/route.ts
import { existsSync } from 'fs';
import { retryJob, getJobDetail } from '../../../../../shared/db-reader.js';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Check job exists
  const job = getJobDetail(id);
  if (!job) {
    return Response.json({ error: 'Job not found' }, { status: 404 });
  }

  // For retry, we need the source_path — get from raw DB
  // The shared module doesn't expose source_path, so read it directly
  const { getIngestionJobs } = await import('../../../../shared/db-reader.js');
  // Actually, let's add a source path check. We need to import from db.ts:
  const { getIngestionJobByPath } = await import('../../../../../db.js');

  // Simplified: retryJob already checks if status is 'failed'
  const result = retryJob(id);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 409 });
  }
  return Response.json({ ok: true });
}
```

Wait — we need the source file check. Let me revise. Add `getJobSourcePath` to `db-reader.ts`:

Add to `src/shared/db-reader.ts`:

```typescript
export function getJobSourcePath(id: string): string | null {
  const rows = getIngestionJobs() as RawJob[];
  const job = rows.find((r) => r.id === id);
  return (job as unknown as { source_path: string })?.source_path ?? null;
}
```

Update the RawJob type to include `source_path`:
```typescript
interface RawJob {
  id: string;
  source_path: string;
  source_filename: string;
  // ... rest unchanged
}
```

Then the retry route:

```typescript
// dashboard/src/app/api/ingestion/retry/[id]/route.ts
import { existsSync } from 'fs';
import { retryJob, getJobSourcePath } from '../../../../../shared/db-reader.js';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sourcePath = getJobSourcePath(id);
  if (!sourcePath) {
    return Response.json({ error: 'Job not found' }, { status: 404 });
  }

  // Check source file still exists on disk for extraction retry
  if (!existsSync(sourcePath)) {
    return Response.json(
      { error: 'Source file missing — re-upload required' },
      { status: 409 },
    );
  }

  const result = retryJob(id);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 409 });
  }

  return Response.json({ ok: true });
}
```

- [ ] **Step 6: Create GET + PATCH /api/ingestion/settings**

```typescript
// dashboard/src/app/api/ingestion/settings/route.ts
import { getSettings, updateSettings } from '../../../../shared/db-reader.js';

export async function GET() {
  return Response.json(getSettings());
}

export async function PATCH(request: Request) {
  const body = await request.json();
  const maxGenerationConcurrent = Number(body.maxGenerationConcurrent);
  if (!Number.isFinite(maxGenerationConcurrent) || maxGenerationConcurrent < 1) {
    return Response.json({ error: 'Invalid value' }, { status: 400 });
  }
  updateSettings({ maxGenerationConcurrent });
  return Response.json(getSettings());
}
```

- [ ] **Step 7: Build dashboard to verify routes compile**

Run: `cd dashboard && npm run build`
Expected: Build succeeds. If import paths fail, adjust the path alias strategy.

- [ ] **Step 8: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json dashboard/src/app/api/ingestion/ src/shared/db-reader.ts
git commit -m "feat(dashboard): add ingestion API routes for jobs, retry, settings"
```

---

## Task 5: Update Upload API — Multi-file, Collision Avoidance, Size Limit

**Files:**
- Modify: `dashboard/src/app/api/upload/route.ts`

- [ ] **Step 1: Rewrite the upload route**

```typescript
// dashboard/src/app/api/upload/route.ts
import { join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { randomBytes } from 'crypto';

const UPLOAD_DIR = process.env.UPLOAD_DIR || join(process.cwd(), '..', 'upload');
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const files = formData.getAll('file') as File[];

    if (files.length === 0) {
      return Response.json({ error: 'No files provided' }, { status: 400 });
    }

    await mkdir(UPLOAD_DIR, { recursive: true });

    const results: Array<{ ok: boolean; filename: string; path?: string; error?: string }> = [];

    for (const file of files) {
      // Validate PDF
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        results.push({ ok: false, filename: file.name, error: 'Only PDF files are supported' });
        continue;
      }

      // Validate size
      if (file.size > MAX_FILE_SIZE) {
        results.push({ ok: false, filename: file.name, error: 'File exceeds 100 MB limit' });
        continue;
      }

      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      const sanitized = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = sanitized.endsWith('.pdf') ? '' : '.pdf';
      const suffix = randomBytes(3).toString('hex');
      const base = sanitized.replace(/\.pdf$/i, '');
      const filename = `${base}_${suffix}.pdf${ext}`;
      const destPath = join(UPLOAD_DIR, filename);

      await writeFile(destPath, buffer);
      results.push({ ok: true, filename, path: destPath });
    }

    return Response.json({ results });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd dashboard && npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/api/upload/route.ts
git commit -m "feat(upload): multi-file support, collision avoidance, 100MB size limit"
```

---

## Task 6: React Hook — `useIngestionJobs`

**Files:**
- Create: `dashboard/src/hooks/useIngestionJobs.ts`

- [ ] **Step 1: Create the hook**

```typescript
// dashboard/src/hooks/useIngestionJobs.ts
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export interface JobSummary {
  id: string;
  filename: string;
  status: string;
  error: string | null;
  retryAfter: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export function useIngestionJobs(pollInterval = 3000) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchJobs = useCallback(async () => {
    if (document.hidden) return;
    try {
      const res = await fetch('/api/ingestion/jobs');
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs);
      }
    } catch {
      // Network error — keep previous state
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchJobs();
    timerRef.current = setInterval(() => void fetchJobs(), pollInterval);

    const handleVisibility = () => {
      if (!document.hidden) void fetchJobs();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchJobs, pollInterval]);

  const retry = useCallback(
    async (jobId: string) => {
      const res = await fetch(`/api/ingestion/retry/${jobId}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Retry failed');
      }
      // Immediate re-poll
      await fetchJobs();
    },
    [fetchJobs],
  );

  return { jobs, isLoading, retry };
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/hooks/useIngestionJobs.ts
git commit -m "feat(dashboard): add useIngestionJobs polling hook"
```

---

## Task 7: React Hook — `useFileUpload`

**Files:**
- Create: `dashboard/src/hooks/useFileUpload.ts`

- [ ] **Step 1: Create the hook**

```typescript
// dashboard/src/hooks/useFileUpload.ts
'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { JobSummary } from './useIngestionJobs';

export interface StagedFile {
  name: string;
  file: File;
  status: 'staged' | 'uploading' | 'uploaded' | 'upload-failed' | 'duplicate';
  error?: string;
}

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export function useFileUpload(jobs: JobSummary[]) {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const uploadedNamesRef = useRef<Map<string, number>>(new Map());

  // Track uploaded files that haven't appeared as jobs yet
  useEffect(() => {
    if (uploadedNamesRef.current.size === 0) return;

    const now = Date.now();
    const updated = new Map(uploadedNamesRef.current);
    const toMarkDuplicate: string[] = [];

    for (const [name, timestamp] of updated) {
      // Check if this file appeared as a job
      const found = jobs.some(
        (j) =>
          j.filename === name &&
          new Date(j.createdAt).getTime() > timestamp - 5000,
      );
      if (found) {
        updated.delete(name);
      } else if (now - timestamp > 15_000) {
        toMarkDuplicate.push(name);
        updated.delete(name);
      }
    }

    uploadedNamesRef.current = updated;

    if (toMarkDuplicate.length > 0) {
      setFiles((prev) =>
        prev.map((f) =>
          toMarkDuplicate.includes(f.name)
            ? { ...f, status: 'duplicate' as const, error: 'Already processed — duplicate content' }
            : f,
        ),
      );
      // Clear duplicate entries after a delay
      setTimeout(() => {
        setFiles((prev) => prev.filter((f) => f.status !== 'duplicate'));
      }, 5000);
    }
  }, [jobs]);

  const addFiles = useCallback((newFiles: File[]) => {
    const staged: StagedFile[] = [];
    for (const file of newFiles) {
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        staged.push({
          name: file.name,
          file,
          status: 'staged',
          error: 'Only PDF files are supported',
        });
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        staged.push({
          name: file.name,
          file,
          status: 'staged',
          error: 'File exceeds 100 MB limit',
        });
        continue;
      }
      staged.push({ name: file.name, file, status: 'staged' });
    }
    setFiles((prev) => [...prev, ...staged]);
  }, []);

  const removeFile = useCallback((name: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  }, []);

  const uploadAll = useCallback(async () => {
    const valid = files.filter((f) => f.status === 'staged' && !f.error);
    if (valid.length === 0) return;

    setIsUploading(true);
    setFiles((prev) =>
      prev.map((f) =>
        f.status === 'staged' && !f.error ? { ...f, status: 'uploading' as const } : f,
      ),
    );

    try {
      const formData = new FormData();
      for (const f of valid) {
        formData.append('file', f.file);
      }

      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();

      if (data.results) {
        const resultMap = new Map<string, { ok: boolean; filename?: string; error?: string }>();
        for (const r of data.results) {
          // Map original name to result
          resultMap.set(r.filename || r.error, r);
        }

        // Track uploaded filenames for duplicate detection
        const now = Date.now();
        for (const r of data.results) {
          if (r.ok && r.filename) {
            uploadedNamesRef.current.set(r.filename, now);
          }
        }

        setFiles((prev) =>
          prev.map((f) => {
            if (f.status !== 'uploading') return f;
            // Find matching result by checking if any result succeeded
            const matchingResult = data.results.find(
              (r: { ok: boolean; filename: string }) =>
                r.ok && r.filename.startsWith(f.name.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_')),
            );
            if (matchingResult) {
              return { ...f, status: 'uploaded' as const };
            }
            const failedResult = data.results.find(
              (r: { ok: boolean; error?: string; filename: string }) => !r.ok && r.filename === f.name,
            );
            if (failedResult) {
              return { ...f, status: 'upload-failed' as const, error: failedResult.error };
            }
            return { ...f, status: 'uploaded' as const };
          }),
        );

        // Clear uploaded files after a delay
        setTimeout(() => {
          setFiles((prev) => prev.filter((f) => f.status !== 'uploaded'));
        }, 3000);
      }
    } catch (err) {
      setFiles((prev) =>
        prev.map((f) =>
          f.status === 'uploading'
            ? { ...f, status: 'upload-failed' as const, error: String(err) }
            : f,
        ),
      );
    } finally {
      setIsUploading(false);
    }
  }, [files]);

  const clearErrors = useCallback(() => {
    setFiles((prev) => prev.filter((f) => f.status === 'staged' && !f.error));
  }, []);

  return { files, addFiles, removeFile, uploadAll, clearErrors, isUploading };
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/hooks/useFileUpload.ts
git commit -m "feat(dashboard): add useFileUpload multi-file staging hook"
```

---

## Task 8: Upload Page — UI Components

**Files:**
- Create: `dashboard/src/app/upload/components/DropZone.tsx`
- Create: `dashboard/src/app/upload/components/JobList.tsx`
- Create: `dashboard/src/app/upload/components/JobRow.tsx`

- [ ] **Step 1: Create DropZone component**

```tsx
// dashboard/src/app/upload/components/DropZone.tsx
'use client';

import { useRef, DragEvent } from 'react';
import type { StagedFile } from '../../../hooks/useFileUpload';

interface DropZoneProps {
  files: StagedFile[];
  isUploading: boolean;
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (name: string) => void;
  onUploadAll: () => void;
}

export function DropZone({
  files,
  isUploading,
  onAddFiles,
  onRemoveFile,
  onUploadAll,
}: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const [dragging, setDragging] = useState(false);

  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    dragCounter.current++;
    setDragging(true);
  }
  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }
  function handleDragOver(e: DragEvent) {
    e.preventDefault();
  }
  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) onAddFiles(dropped);
  }
  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    if (selected.length > 0) onAddFiles(selected);
    e.target.value = '';
  }

  const staged = files.filter((f) => f.status === 'staged' && !f.error);
  const hasValidFiles = staged.length > 0;

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
        dragging
          ? 'border-blue-500 bg-blue-950/30'
          : 'border-gray-700 hover:border-gray-500 bg-gray-900/50'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        multiple
        className="hidden"
        onChange={handleInputChange}
      />

      {files.length === 0 ? (
        <div>
          <p className="text-gray-400">Drop PDFs here or click to browse</p>
          <p className="text-gray-600 text-sm mt-1">PDF only · Multiple files supported</p>
        </div>
      ) : (
        <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
          {files.map((f) => (
            <div
              key={f.name}
              className="flex items-center justify-between px-3 py-2 rounded bg-gray-800/50 text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate text-gray-200">{f.name}</span>
                {f.error && (
                  <span className="text-red-400 text-xs shrink-0">{f.error}</span>
                )}
                {f.status === 'uploading' && (
                  <span className="text-blue-400 text-xs shrink-0">Uploading...</span>
                )}
                {f.status === 'uploaded' && (
                  <span className="text-green-400 text-xs shrink-0">Uploaded</span>
                )}
                {f.status === 'duplicate' && (
                  <span className="text-yellow-400 text-xs shrink-0">{f.error}</span>
                )}
              </div>
              {f.status === 'staged' && (
                <button
                  onClick={() => onRemoveFile(f.name)}
                  className="text-gray-500 hover:text-gray-300 ml-2 shrink-0"
                >
                  ✕
                </button>
              )}
            </div>
          ))}

          {hasValidFiles && (
            <button
              onClick={onUploadAll}
              disabled={isUploading}
              className="mt-2 w-full px-4 py-2 rounded bg-blue-700 hover:bg-blue-600 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isUploading ? 'Uploading...' : `Upload ${staged.length} file${staged.length > 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

Add the missing import at top:
```tsx
import { useRef, useState, DragEvent } from 'react';
```

- [ ] **Step 2: Create JobRow component**

```tsx
// dashboard/src/app/upload/components/JobRow.tsx
'use client';

import { useState } from 'react';
import type { JobSummary } from '../../../hooks/useIngestionJobs';

interface JobRowProps {
  job: JobSummary;
  onRetry: (id: string) => Promise<void>;
}

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; bgColor: string; progress: number }
> = {
  pending: { label: 'Pending', color: 'text-gray-400', bgColor: 'bg-gray-500', progress: 0 },
  extracting: { label: 'Extracting', color: 'text-orange-400', bgColor: 'bg-orange-500', progress: 16 },
  extracted: { label: 'Extracted', color: 'text-orange-400', bgColor: 'bg-orange-500', progress: 33 },
  generating: { label: 'Generating notes', color: 'text-blue-400', bgColor: 'bg-blue-500', progress: 50 },
  generated: { label: 'Generated', color: 'text-blue-400', bgColor: 'bg-blue-500', progress: 66 },
  promoting: { label: 'Promoting to vault', color: 'text-indigo-400', bgColor: 'bg-indigo-500', progress: 83 },
  completed: { label: 'Completed', color: 'text-green-400', bgColor: 'bg-green-500', progress: 100 },
  failed: { label: 'Failed', color: 'text-red-400', bgColor: 'bg-red-500', progress: 0 },
  rate_limited: { label: 'Rate limited', color: 'text-amber-400', bgColor: 'bg-amber-500', progress: 50 },
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function retryCountdown(retryAfter: string): string {
  const diff = new Date(retryAfter).getTime() - Date.now();
  if (diff <= 0) return 'retrying soon';
  const mins = Math.ceil(diff / 60_000);
  return `retries in ~${mins}m`;
}

export function JobRow({ job, onRetry }: JobRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState<{ promotedPaths: string[] | null } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const config = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.pending;
  const isActive = !['completed', 'failed'].includes(job.status);

  async function handleExpand() {
    if (job.status !== 'completed') return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!notes) {
      const res = await fetch(`/api/ingestion/jobs/${job.id}`);
      if (res.ok) {
        const data = await res.json();
        setNotes({ promotedPaths: data.promotedPaths });
      }
    }
    setExpanded(true);
  }

  async function handleRetry() {
    setRetrying(true);
    try {
      await onRetry(job.id);
    } catch {
      // Error handled by parent
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="px-4 py-3 border-b border-gray-800 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {job.status === 'completed' && (
              <button
                onClick={handleExpand}
                className="text-gray-500 hover:text-gray-300 text-xs shrink-0"
              >
                {expanded ? '▾' : '▸'}
              </button>
            )}
            <span className="text-sm text-gray-200 truncate">{job.filename}</span>
          </div>

          {/* Error message */}
          {job.status === 'failed' && job.error && (
            <p className="text-xs text-red-400 mt-1 truncate">
              {job.error.includes(':') ? job.error.split(':').slice(1).join(':') : job.error}
            </p>
          )}

          {/* Rate-limit countdown */}
          {job.status === 'rate_limited' && job.retryAfter && (
            <p className="text-xs text-amber-400 mt-1">
              Waiting for session reset — {retryCountdown(job.retryAfter)}
            </p>
          )}

          {/* Progress bar for active jobs */}
          {isActive && config.progress > 0 && (
            <div className="mt-1.5 h-1 rounded-full bg-gray-800 overflow-hidden">
              <div
                className={`h-full rounded-full ${config.bgColor} transition-all duration-500`}
                style={{ width: `${config.progress}%` }}
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className={`text-xs ${config.color}`}>{config.label}</span>
          <span
            className="text-xs text-gray-600"
            title={new Date(job.updatedAt).toLocaleString()}
          >
            {relativeTime(job.updatedAt)}
          </span>

          {job.status === 'failed' && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50"
            >
              {retrying ? '...' : 'Retry'}
            </button>
          )}
          {job.status === 'rate_limited' && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-amber-300 border border-gray-700 disabled:opacity-50"
            >
              {retrying ? '...' : 'Retry now'}
            </button>
          )}
        </div>
      </div>

      {/* Expanded: show promoted notes */}
      {expanded && notes?.promotedPaths && (
        <div className="mt-2 ml-6 space-y-1">
          <p className="text-xs text-gray-500">
            {notes.promotedPaths.length} note{notes.promotedPaths.length !== 1 ? 's' : ''} generated
          </p>
          {notes.promotedPaths.map((path) => (
            <a
              key={path}
              href={`/vault?file=${encodeURIComponent(path)}`}
              className="block text-xs text-blue-400 hover:text-blue-300 truncate"
            >
              {path}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create JobList component**

```tsx
// dashboard/src/app/upload/components/JobList.tsx
'use client';

import { useState } from 'react';
import type { JobSummary } from '../../../hooks/useIngestionJobs';
import { JobRow } from './JobRow';

interface JobListProps {
  jobs: JobSummary[];
  onRetry: (id: string) => Promise<void>;
}

const IN_PROGRESS_STATUSES = new Set([
  'pending',
  'extracting',
  'extracted',
  'generating',
  'generated',
  'promoting',
  'rate_limited',
]);

export function JobList({ jobs, onRetry }: JobListProps) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    inProgress: true,
    completed: false,
    failed: false,
  });

  const inProgress = jobs.filter((j) => IN_PROGRESS_STATUSES.has(j.status));
  const completed = jobs.filter((j) => j.status === 'completed');
  const failed = jobs.filter((j) => j.status === 'failed');

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  if (jobs.length === 0) {
    return (
      <p className="text-sm text-gray-600 text-center py-8">
        No uploads yet. Drop a PDF above to get started.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* In Progress */}
      {inProgress.length > 0 && (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <button
            onClick={() => toggleGroup('inProgress')}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-900/50 hover:bg-gray-800/50 transition-colors"
          >
            <span className="text-sm font-medium text-gray-300">
              {expandedGroups.inProgress ? '▾' : '▸'} In Progress ({inProgress.length})
            </span>
          </button>
          {expandedGroups.inProgress && (
            <div>
              {inProgress.map((job) => (
                <JobRow key={job.id} job={job} onRetry={onRetry} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Completed */}
      {completed.length > 0 && (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <button
            onClick={() => toggleGroup('completed')}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-900/50 hover:bg-gray-800/50 transition-colors"
          >
            <span className="text-sm font-medium text-gray-300">
              {expandedGroups.completed ? '▾' : '▸'} Completed ({completed.length})
            </span>
          </button>
          {expandedGroups.completed && (
            <div>
              {completed.map((job) => (
                <JobRow key={job.id} job={job} onRetry={onRetry} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Failed */}
      {failed.length > 0 && (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <button
            onClick={() => toggleGroup('failed')}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-900/50 hover:bg-gray-800/50 transition-colors"
          >
            <span className="text-sm font-medium text-red-400">
              {expandedGroups.failed ? '▾' : '▸'} Failed ({failed.length})
            </span>
          </button>
          {expandedGroups.failed && (
            <div>
              {failed.map((job) => (
                <JobRow key={job.id} job={job} onRetry={onRetry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/app/upload/components/
git commit -m "feat(dashboard): add DropZone, JobRow, JobList UI components"
```

---

## Task 9: Upload Page — Compose Everything

**Files:**
- Modify: `dashboard/src/app/upload/page.tsx`

- [ ] **Step 1: Rewrite the upload page**

```tsx
// dashboard/src/app/upload/page.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useIngestionJobs } from '../../hooks/useIngestionJobs';
import { useFileUpload } from '../../hooks/useFileUpload';
import { DropZone } from './components/DropZone';
import { JobList } from './components/JobList';

export default function UploadPage() {
  const { jobs, isLoading, retry } = useIngestionJobs();
  const { files, addFiles, removeFile, uploadAll, isUploading } = useFileUpload(jobs);
  const [concurrency, setConcurrency] = useState(1);

  useEffect(() => {
    fetch('/api/ingestion/settings')
      .then((r) => r.json())
      .then((data) => setConcurrency(data.maxGenerationConcurrent))
      .catch(() => {});
  }, []);

  const handleConcurrencyChange = useCallback(async (value: number) => {
    setConcurrency(value);
    await fetch('/api/ingestion/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxGenerationConcurrent: value }),
    });
  }, []);

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Upload</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Parallel jobs:</span>
          <div className="flex rounded-md overflow-hidden border border-gray-700">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => handleConcurrencyChange(n)}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  concurrency === n
                    ? 'bg-blue-700 text-white'
                    : 'bg-gray-900 text-gray-400 hover:bg-gray-800'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      <DropZone
        files={files}
        isUploading={isUploading}
        onAddFiles={addFiles}
        onRemoveFile={removeFile}
        onUploadAll={uploadAll}
      />

      <div className="mt-6">
        {isLoading ? (
          <p className="text-sm text-gray-600 text-center py-4">Loading...</p>
        ) : (
          <JobList jobs={jobs} onRetry={retry} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build and verify**

Run: `cd dashboard && npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/upload/page.tsx
git commit -m "feat(dashboard): rewrite upload page with multi-file, status tracking, retry"
```

---

## Task 10: Integration Testing and Polish

- [ ] **Step 1: Run all tests across the project**

Run: `npm test`
Expected: All existing + new tests pass.

- [ ] **Step 2: Run dashboard build**

Run: `cd dashboard && npm run build`
Expected: Clean build, no type errors.

- [ ] **Step 3: Manual smoke test**

Start the stack:
```bash
npm run dev &
cd dashboard && npm run dev &
```

Verify:
1. Open http://localhost:3100/upload
2. Concurrency selector shows and persists changes
3. Drop a PDF → appears in staging → click Upload → appears in "In Progress"
4. Drop a non-PDF → inline error
5. Drop a >100 MB file → inline error
6. Job progresses through stages (extracting → generating → completed)
7. Completed jobs show expand arrow → click shows vault links
8. If pipeline is stopped, failed jobs show retry button

- [ ] **Step 4: Fix any issues found during testing**

Address type errors, import path issues, or visual bugs.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "fix: address integration issues from upload page testing"
```
