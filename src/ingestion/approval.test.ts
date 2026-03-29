import { describe, it, expect, beforeEach } from 'vitest';
import {
  createIngestionJob,
  createReviewItem,
  updateReviewItemStatus,
  updateIngestionJob,
  getReviewItemByJobId,
  deleteIngestionJob,
  _initTestDatabase,
} from '../db.js';

describe('approval codepath', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('updateReviewItemStatus sets approved status', () => {
    const jobId = 'approval-test-job-' + Date.now();
    const reviewId = 'approval-test-' + Date.now();
    createIngestionJob(jobId, '/tmp/test.pdf', 'test.pdf', null, null, null, null, null);
    createReviewItem(reviewId, jobId, 'drafts/test.md', 'test.pdf', null, null, []);

    updateReviewItemStatus(reviewId, 'approved');

    const item = getReviewItemByJobId(jobId);
    expect(item).toBeDefined();
    expect((item as { status: string })!.status).toBe('approved');
  });

  it('updateReviewItemStatus sets rejected status', () => {
    const jobId = 'reject-test-job-' + Date.now();
    const reviewId = 'reject-test-' + Date.now();
    createIngestionJob(jobId, '/tmp/reject.pdf', 'reject.pdf', null, null, null, null, null);
    createReviewItem(reviewId, jobId, 'drafts/reject.md', 'reject.pdf', null, null, []);

    updateReviewItemStatus(reviewId, 'rejected');

    const item = getReviewItemByJobId(jobId);
    expect(item).toBeDefined();
    expect((item as { status: string })!.status).toBe('rejected');
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

  it('review item persists across job status changes', () => {
    const jobId = 'persist-test-' + Date.now();
    const reviewId = 'persist-review-' + Date.now();
    createIngestionJob(jobId, '/tmp/persist.pdf', 'persist.pdf', 'TEST', null, 1, 1, 'lecture');
    createReviewItem(reviewId, jobId, 'drafts/persist.md', 'persist.pdf', 'lecture', 'TEST', []);

    // Simulate pipeline: job completes, then review approved
    updateIngestionJob(jobId, { status: 'completed' });
    updateReviewItemStatus(reviewId, 'approved');

    const item = getReviewItemByJobId(jobId);
    expect(item).toBeDefined();
    expect((item as { status: string })!.status).toBe('approved');
  });
});
