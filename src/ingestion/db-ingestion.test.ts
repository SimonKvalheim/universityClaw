import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  _initTestDatabase,
  createIngestionJob,
  deleteIngestionJob,
  getCompletedJobByHash,
  getDb,
  getIngestionJobs,
  getJobsByStatus,
  getRecentlyCompletedJobs,
  updateIngestionJob,
} from '../db.js';

beforeEach(() => {
  _initTestDatabase();
});

function makeJob(id: string): void {
  createIngestionJob(id, `/uploads/${id}.pdf`, `${id}.pdf`);
}

// --- simplified schema ---

describe('simplified ingestion schema', () => {
  it('creates a job with only fileName, filePath, and status', () => {
    createIngestionJob('job-1', '/upload/paper.pdf', 'paper.pdf');
    const jobs = getIngestionJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'job-1',
      source_path: '/upload/paper.pdf',
      source_filename: 'paper.pdf',
      status: 'pending',
    });
    // Old columns should not exist
    expect(jobs[0]).not.toHaveProperty('tier');
    expect(jobs[0]).not.toHaveProperty('course_code');
  });

  it('does not have a review_items table', () => {
    const db = getDb();
    expect(() => {
      db.all(sql`SELECT * FROM review_items`);
    }).toThrow();
  });
});

// --- getJobsByStatus ---

describe('getJobsByStatus', () => {
  beforeEach(() => {
    makeJob('job-1'); // pending
    makeJob('job-2'); // pending
    makeJob('job-3'); // will be set to processing
    updateIngestionJob('job-3', { status: 'processing' });
  });

  it('returns all jobs matching the given status', () => {
    const pending = getJobsByStatus('pending') as Array<
      Record<string, unknown>
    >;
    expect(pending).toHaveLength(2);
    const ids = pending.map((j) => j.id);
    expect(ids).toContain('job-1');
    expect(ids).toContain('job-2');
  });

  it('returns jobs for a non-pending status', () => {
    const processing = getJobsByStatus('processing') as Array<
      Record<string, unknown>
    >;
    expect(processing).toHaveLength(1);
    expect(processing[0].id).toBe('job-3');
  });

  it('returns empty array when no jobs match status', () => {
    const failed = getJobsByStatus('failed');
    expect(failed).toHaveLength(0);
  });
});

// --- updateIngestionJob ---

describe('updateIngestionJob', () => {
  beforeEach(() => {
    makeJob('upd-1');
  });

  it('updates status', () => {
    updateIngestionJob('upd-1', { status: 'processing' });

    const jobs = getJobsByStatus('processing') as Array<
      Record<string, unknown>
    >;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('upd-1');
  });

  it('sets completed_at when status is completed', () => {
    updateIngestionJob('upd-1', { status: 'completed' });

    const completed = getRecentlyCompletedJobs(10) as Array<
      Record<string, unknown>
    >;
    expect(completed).toHaveLength(1);
    expect(completed[0].completed_at).not.toBeNull();
  });

  it('updates extraction_path', () => {
    updateIngestionJob('upd-1', { extraction_path: '/extractions/upd-1.json' });

    const jobs = getJobsByStatus('pending') as Array<Record<string, unknown>>;
    expect(jobs[0].extraction_path).toBe('/extractions/upd-1.json');
  });

  it('clears error when error: null is passed', () => {
    updateIngestionJob('upd-1', { error: 'some error' });
    updateIngestionJob('upd-1', { error: null });

    const jobs = getJobsByStatus('pending') as Array<Record<string, unknown>>;
    expect(jobs[0].error).toBeNull();
  });

  it('always sets updated_at', () => {
    const jobsBefore = getJobsByStatus('pending') as Array<
      Record<string, unknown>
    >;
    const updatedAtBefore = jobsBefore[0].updated_at as string;

    // Small sleep to ensure time difference
    const start = Date.now();
    while (Date.now() - start < 2) {
      /* spin */
    }

    updateIngestionJob('upd-1', { status: 'processing' });

    const jobsAfter = getJobsByStatus('processing') as Array<
      Record<string, unknown>
    >;
    // updated_at should be a valid datetime string
    expect(typeof jobsAfter[0].updated_at).toBe('string');
    expect(jobsAfter[0].updated_at).not.toBeNull();
  });
});

// --- deleteIngestionJob ---

describe('deleteIngestionJob', () => {
  it('deletes a job', () => {
    makeJob('del-job');
    deleteIngestionJob('del-job');
    const jobs = getJobsByStatus('pending');
    expect(jobs).toHaveLength(0);
  });
});

// --- getRecentlyCompletedJobs ---

describe('getRecentlyCompletedJobs', () => {
  it('returns completed jobs ordered by completed_at DESC', () => {
    makeJob('comp-1');
    makeJob('comp-2');
    makeJob('comp-3');

    updateIngestionJob('comp-1', { status: 'completed' });
    updateIngestionJob('comp-2', { status: 'completed' });
    // comp-3 remains pending

    const completed = getRecentlyCompletedJobs(10) as Array<
      Record<string, unknown>
    >;
    expect(completed).toHaveLength(2);
    const ids = completed.map((j) => j.id);
    expect(ids).toContain('comp-1');
    expect(ids).toContain('comp-2');
  });

  it('respects the limit', () => {
    for (let i = 1; i <= 5; i++) {
      makeJob(`lim-comp-${i}`);
      updateIngestionJob(`lim-comp-${i}`, { status: 'completed' });
    }

    const completed = getRecentlyCompletedJobs(3);
    expect(completed).toHaveLength(3);
  });

  it('returns empty when no completed jobs', () => {
    makeJob('pending-job');
    const completed = getRecentlyCompletedJobs(10);
    expect(completed).toHaveLength(0);
  });
});

// --- content hash dedup ---

describe('content hash dedup', () => {
  it('createIngestionJob stores content_hash', () => {
    createIngestionJob('hash-1', '/upload/a.pdf', 'a.pdf', 'abc123hash');
    const jobs = getIngestionJobs();
    const job = jobs.find(
      (j) => (j as Record<string, unknown>).id === 'hash-1',
    ) as Record<string, unknown>;
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
    const found = getCompletedJobByHash('cafebabe');
    expect(found).toBeUndefined();
  });

  it('getCompletedJobByHash returns undefined for unknown hash', () => {
    const found = getCompletedJobByHash('nonexistent');
    expect(found).toBeUndefined();
  });
});
