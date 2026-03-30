import { beforeEach, describe, expect, it } from 'vitest';
import {
  _initTestDatabase,
  createIngestionJob,
  getDb,
  getJobsByStatus,
  updateIngestionJob,
} from '../db.js';
import { recoverStaleJobs } from './job-recovery.js';

describe('pipeline integration', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('job state machine enforces correct transitions', () => {
    const id = 'integration-states-' + Date.now();
    createIngestionJob(id, '/tmp/states.pdf', 'states.pdf');

    // pending → extracting → extracted → generating → completed
    updateIngestionJob(id, { status: 'extracting' });
    updateIngestionJob(id, {
      status: 'extracted',
      extraction_path: '/tmp/ext/' + id,
    });
    updateIngestionJob(id, { status: 'generating' });
    updateIngestionJob(id, { status: 'completed' });

    const completed = getJobsByStatus('completed').find(
      (j) => (j as { id: string }).id === id,
    );
    expect(completed).toBeDefined();
    expect((completed as { extraction_path: string }).extraction_path).toBe(
      '/tmp/ext/' + id,
    );
  });

  it('recovery resets stale generating jobs to extracted', () => {
    const id = 'integration-recovery-' + Date.now();
    createIngestionJob(id, '/tmp/recovery.pdf', 'recovery.pdf');
    updateIngestionJob(id, {
      status: 'generating',
      extraction_path: '/tmp/ext/' + id,
    });

    // Backdate to simulate staleness
    getDb()
      .prepare(
        "UPDATE ingestion_jobs SET updated_at = datetime('now', '-60 minutes') WHERE id = ?",
      )
      .run(id);

    const result = recoverStaleJobs({
      extractingThresholdMin: 10,
      generatingThresholdMin: 45,
    });
    expect(result.generating).toBeGreaterThan(0);

    // Should be reset to extracted (preserving extraction artifacts)
    const jobs = getJobsByStatus('extracted');
    expect(jobs.find((j) => (j as { id: string }).id === id)).toBeDefined();
  });

  it('full pipeline: pending → extracting → extracted → generating → completed', () => {
    const id = 'integration-full-' + Date.now();
    createIngestionJob(id, '/tmp/lecture.pdf', 'lecture.pdf');

    updateIngestionJob(id, { status: 'extracting' });
    updateIngestionJob(id, {
      status: 'extracted',
      extraction_path: '/tmp/ext/' + id,
    });
    updateIngestionJob(id, { status: 'generating' });
    updateIngestionJob(id, { status: 'completed' });

    const job = getJobsByStatus('completed').find(
      (j) => (j as { id: string }).id === id,
    );
    expect(job).toBeDefined();
  });
});
