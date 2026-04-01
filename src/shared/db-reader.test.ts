import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createIngestionJob,
  updateIngestionJob,
} from '../db.js';
import {
  getRecentJobs,
  getJobDetail,
  getJobSourcePath,
  retryJob,
  getSettings,
  updateSettings,
} from './db-reader.js';

beforeEach(() => {
  _initTestDatabase();
});

// --- getRecentJobs ---

describe('getRecentJobs', () => {
  it('returns jobs ordered by created_at desc', () => {
    createIngestionJob('job-a', '/upload/a.pdf', 'a.pdf');
    createIngestionJob('job-b', '/upload/b.pdf', 'b.pdf');
    createIngestionJob('job-c', '/upload/c.pdf', 'c.pdf');

    const jobs = getRecentJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(3);
    // All three jobs should be present (order by created_at DESC)
    const ids = jobs.map((j) => j.id);
    expect(ids).toContain('job-a');
    expect(ids).toContain('job-b');
    expect(ids).toContain('job-c');
    // Verify DESC ordering: no job's createdAt should be before the next job's
    for (let i = 0; i < jobs.length - 1; i++) {
      expect(jobs[i].createdAt >= jobs[i + 1].createdAt).toBe(true);
    }
  });

  it('filters by status', () => {
    createIngestionJob('pend-1', '/upload/p1.pdf', 'p1.pdf');
    createIngestionJob('pend-2', '/upload/p2.pdf', 'p2.pdf');
    createIngestionJob('comp-1', '/upload/c1.pdf', 'c1.pdf');
    updateIngestionJob('comp-1', { status: 'completed' });

    const pending = getRecentJobs('pending');
    expect(pending).toHaveLength(2);
    expect(pending.every((j) => j.status === 'pending')).toBe(true);

    const completed = getRecentJobs('completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe('comp-1');
  });

  it('limits results to 20', () => {
    for (let i = 1; i <= 25; i++) {
      createIngestionJob(`limit-job-${i}`, `/upload/f${i}.pdf`, `f${i}.pdf`);
    }

    const jobs = getRecentJobs();
    expect(jobs).toHaveLength(20);
  });
});

// --- getJobDetail ---

describe('getJobDetail', () => {
  it('returns null for a non-existent job', () => {
    const detail = getJobDetail('no-such-id');
    expect(detail).toBeNull();
  });

  it('returns promoted paths parsed from JSON for completed jobs', () => {
    createIngestionJob('detail-1', '/upload/d1.pdf', 'd1.pdf');
    updateIngestionJob('detail-1', {
      status: 'completed',
      promoted_paths: JSON.stringify(['vault/sources/d1.md', 'vault/concepts/topic.md']),
    });

    const detail = getJobDetail('detail-1');
    expect(detail).not.toBeNull();
    expect(detail!.promotedPaths).toEqual([
      'vault/sources/d1.md',
      'vault/concepts/topic.md',
    ]);
    expect(detail!.status).toBe('completed');
  });

  it('returns promotedPaths as null when promoted_paths is not set', () => {
    createIngestionJob('detail-2', '/upload/d2.pdf', 'd2.pdf');
    const detail = getJobDetail('detail-2');
    expect(detail).not.toBeNull();
    expect(detail!.promotedPaths).toBeNull();
  });

  it('maps all camelCase fields correctly', () => {
    createIngestionJob('detail-3', '/upload/d3.pdf', 'd3.pdf');
    const detail = getJobDetail('detail-3');
    expect(detail).not.toBeNull();
    expect(detail!.filename).toBe('d3.pdf');
    expect(detail!.status).toBe('pending');
    expect(detail!.error).toBeNull();
    expect(detail!.retryAfter).toBeNull();
    expect(typeof detail!.retryCount).toBe('number');
    expect(typeof detail!.createdAt).toBe('string');
    expect(typeof detail!.updatedAt).toBe('string');
    expect(detail!.completedAt).toBeNull();
  });
});

// --- retryJob ---

describe('retryJob', () => {
  it('resets a failed extracting job to pending', () => {
    createIngestionJob('retry-1', '/upload/r1.pdf', 'r1.pdf');
    updateIngestionJob('retry-1', {
      status: 'failed',
      error: 'extracting: Docling timed out',
    });

    const result = retryJob('retry-1');
    expect(result).toEqual({ ok: true });

    const detail = getJobDetail('retry-1');
    expect(detail!.status).toBe('pending');
    expect(detail!.error).toBeNull();
    expect(detail!.retryAfter).toBeNull();
  });

  it('resets a failed generating job to extracted', () => {
    createIngestionJob('retry-2', '/upload/r2.pdf', 'r2.pdf');
    updateIngestionJob('retry-2', {
      status: 'failed',
      error: 'generating: Claude API error',
    });

    const result = retryJob('retry-2');
    expect(result).toEqual({ ok: true });

    const detail = getJobDetail('retry-2');
    expect(detail!.status).toBe('extracted');
  });

  it('resets a failed promoting job to generated', () => {
    createIngestionJob('retry-3', '/upload/r3.pdf', 'r3.pdf');
    updateIngestionJob('retry-3', {
      status: 'failed',
      error: 'promoting: vault write failed',
    });

    const result = retryJob('retry-3');
    expect(result).toEqual({ ok: true });

    const detail = getJobDetail('retry-3');
    expect(detail!.status).toBe('generated');
  });

  it('resets a failed job with unknown prefix to pending', () => {
    createIngestionJob('retry-4', '/upload/r4.pdf', 'r4.pdf');
    updateIngestionJob('retry-4', {
      status: 'failed',
      error: 'unknown error occurred',
    });

    const result = retryJob('retry-4');
    expect(result).toEqual({ ok: true });

    const detail = getJobDetail('retry-4');
    expect(detail!.status).toBe('pending');
  });

  it('returns error for a non-failed job', () => {
    createIngestionJob('retry-5', '/upload/r5.pdf', 'r5.pdf');
    // status is 'pending' by default

    const result = retryJob('retry-5');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/not in failed/i);
  });

  it('returns error for a non-existent job', () => {
    const result = retryJob('no-such-job');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/not found/i);
  });
});

// --- getSettings ---

describe('getSettings', () => {
  it('returns default maxGenerationConcurrent of 1 when no setting exists', () => {
    const settings = getSettings();
    expect(settings.maxGenerationConcurrent).toBe(1);
  });
});

// --- updateSettings ---

describe('updateSettings', () => {
  it('stores and retrieves the maxGenerationConcurrent value', () => {
    updateSettings({ maxGenerationConcurrent: 3 });
    const settings = getSettings();
    expect(settings.maxGenerationConcurrent).toBe(3);
  });

  it('clamps value to minimum of 1', () => {
    updateSettings({ maxGenerationConcurrent: 0 });
    expect(getSettings().maxGenerationConcurrent).toBe(1);
  });

  it('clamps value to maximum of 5', () => {
    updateSettings({ maxGenerationConcurrent: 10 });
    expect(getSettings().maxGenerationConcurrent).toBe(5);
  });
});
