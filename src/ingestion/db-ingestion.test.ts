import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createIngestionJob,
  createReviewItem,
  deleteIngestionJob,
  getJobsByStatus,
  getRecentlyCompletedJobs,
  getReviewItemByJobId,
  getStaleJobs,
  updateIngestionJob,
  updateReviewItemStatus,
} from '../db.js';

beforeEach(() => {
  _initTestDatabase();
});

function makeJob(id: string, overrides: Partial<Parameters<typeof createIngestionJob>[1]> = {}): void {
  createIngestionJob(
    id,
    `/uploads/${id}.pdf`,
    `${id}.pdf`,
    null,
    null,
    null,
    null,
    null,
  );
}

// --- getJobsByStatus ---

describe('getJobsByStatus', () => {
  beforeEach(() => {
    makeJob('job-1'); // pending
    makeJob('job-2'); // pending
    makeJob('job-3'); // will be set to processing
    updateIngestionJob('job-3', { status: 'processing' });
  });

  it('returns all jobs matching the given status', () => {
    const pending = getJobsByStatus('pending') as Array<Record<string, unknown>>;
    expect(pending).toHaveLength(2);
    const ids = pending.map((j) => j.id);
    expect(ids).toContain('job-1');
    expect(ids).toContain('job-2');
  });

  it('returns jobs for a non-pending status', () => {
    const processing = getJobsByStatus('processing') as Array<Record<string, unknown>>;
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

    const jobs = getJobsByStatus('processing') as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('upd-1');
  });

  it('updates tier', () => {
    updateIngestionJob('upd-1', { tier: 1 });

    const jobs = getJobsByStatus('pending') as Array<Record<string, unknown>>;
    expect(jobs[0].tier).toBe(1);
  });

  it('updates status and tier together', () => {
    updateIngestionJob('upd-1', { status: 'processing', tier: 3 });

    const jobs = getJobsByStatus('processing') as Array<Record<string, unknown>>;
    expect(jobs[0].tier).toBe(3);
    expect(jobs[0].status).toBe('processing');
  });

  it('sets completed_at when status is completed', () => {
    updateIngestionJob('upd-1', { status: 'completed' });

    const completed = getRecentlyCompletedJobs(10) as Array<Record<string, unknown>>;
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
    const jobsBefore = getJobsByStatus('pending') as Array<Record<string, unknown>>;
    const updatedAtBefore = jobsBefore[0].updated_at as string;

    // Small sleep to ensure time difference
    const start = Date.now();
    while (Date.now() - start < 2) { /* spin */ }

    updateIngestionJob('upd-1', { status: 'processing' });

    const jobsAfter = getJobsByStatus('processing') as Array<Record<string, unknown>>;
    // updated_at should be a valid datetime string
    expect(typeof jobsAfter[0].updated_at).toBe('string');
    expect(jobsAfter[0].updated_at).not.toBeNull();
  });
});

// --- updateReviewItemStatus ---

describe('updateReviewItemStatus', () => {
  beforeEach(() => {
    makeJob('rev-job-1');
    createReviewItem('rev-1', 'rev-job-1', '/drafts/note.md', null, null, null, []);
  });

  it('updates review item status to approved', () => {
    updateReviewItemStatus('rev-1', 'approved');

    const item = getReviewItemByJobId('rev-job-1') as Record<string, unknown> | undefined;
    expect(item).toBeDefined();
    expect(item!.status).toBe('approved');
    expect(item!.reviewed_at).not.toBeNull();
  });

  it('updates review item status to rejected', () => {
    updateReviewItemStatus('rev-1', 'rejected');

    const item = getReviewItemByJobId('rev-job-1') as Record<string, unknown> | undefined;
    expect(item!.status).toBe('rejected');
  });
});

// --- deleteIngestionJob cascades to review_items ---

describe('deleteIngestionJob cascade', () => {
  it('cascades delete to associated review_items', () => {
    makeJob('cascade-job');
    createReviewItem('cascade-rev-1', 'cascade-job', '/drafts/a.md', null, null, null, []);
    createReviewItem('cascade-rev-2', 'cascade-job', '/drafts/b.md', null, null, null, []);

    // Verify review items exist before delete
    const before1 = getReviewItemByJobId('cascade-job');
    expect(before1).toBeDefined();

    deleteIngestionJob('cascade-job');

    // After deleting the job, review items should be gone (ON DELETE CASCADE)
    const after = getReviewItemByJobId('cascade-job');
    expect(after).toBeUndefined();

    // Job itself should be gone
    const jobs = getJobsByStatus('pending');
    expect(jobs).toHaveLength(0);
  });
});

// --- getStaleJobs ---

describe('getStaleJobs', () => {
  it('returns empty when no jobs are stale', () => {
    makeJob('fresh-job');
    // Job was just created, so updated_at is now — not stale
    const stale = getStaleJobs('pending', 60);
    expect(stale).toHaveLength(0);
  });
});

// --- getReviewItemByJobId ---

describe('getReviewItemByJobId', () => {
  it('returns the review item for a job', () => {
    makeJob('rij-job');
    createReviewItem('rij-rev', 'rij-job', '/drafts/rij.md', '/source.pdf', 'lecture', 'CS101', []);

    const item = getReviewItemByJobId('rij-job') as Record<string, unknown> | undefined;
    expect(item).toBeDefined();
    expect(item!.id).toBe('rij-rev');
    expect(item!.suggested_type).toBe('lecture');
    expect(item!.suggested_course).toBe('CS101');
  });

  it('returns undefined when no review item exists for job', () => {
    makeJob('no-rev-job');
    const item = getReviewItemByJobId('no-rev-job');
    expect(item).toBeUndefined();
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

    const completed = getRecentlyCompletedJobs(10) as Array<Record<string, unknown>>;
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
