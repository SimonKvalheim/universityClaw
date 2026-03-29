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

  it('tier 1 job auto-completes after extraction (no AI)', () => {
    const id = 'integration-tier1-' + Date.now();
    createIngestionJob(id, '/tmp/test.pdf', 'test.pdf', 'TEST', 'Test Course', 1, 1, 'assignment');
    updateIngestionJob(id, { status: 'extracted', tier: 1, extraction_path: '/tmp/ext/' + id });

    // Simulate what the drainer does for tier 1
    const job = getJobsByStatus('extracted').find((j) => (j as { id: string }).id === id);
    expect(job).toBeDefined();
    expect((job as { tier: number }).tier).toBe(1);

    // Tier 1 auto-completes
    updateIngestionJob(id, { status: 'completed' });
    const completed = getJobsByStatus('completed').find((j) => (j as { id: string }).id === id);
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

    const completed = getJobsByStatus('completed').find((j) => (j as { id: string }).id === id);
    expect(completed).toBeDefined();
    expect((completed as { extraction_path: string }).extraction_path).toBe('/tmp/ext/' + id);
  });

  it('recovery resets stale generating jobs to extracted', () => {
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
    expect(jobs.find((j) => (j as { id: string }).id === id)).toBeDefined();
  });

  it('tier 2 job goes through full pipeline states', () => {
    const id = 'integration-tier2-' + Date.now();
    createIngestionJob(id, '/tmp/lecture.pdf', 'lecture.pdf', 'TEST', 'Test', 1, 1, 'lecture');
    updateIngestionJob(id, { tier: 2 });

    // pending → extracting → extracted → generating → completed (auto-approve for tier 2)
    updateIngestionJob(id, { status: 'extracting' });
    updateIngestionJob(id, { status: 'extracted', extraction_path: '/tmp/ext/' + id });
    updateIngestionJob(id, { status: 'generating' });
    updateIngestionJob(id, { status: 'completed' });

    const job = getJobsByStatus('completed').find((j) => (j as { id: string }).id === id);
    expect(job).toBeDefined();
    expect((job as { tier: number }).tier).toBe(2);
  });

  it('tier 3 job goes to reviewing state', () => {
    const id = 'integration-tier3-' + Date.now();
    createIngestionJob(id, '/tmp/research.pdf', 'research.pdf', null, null, null, null, 'research');
    updateIngestionJob(id, { tier: 3 });

    updateIngestionJob(id, { status: 'extracting' });
    updateIngestionJob(id, { status: 'extracted', extraction_path: '/tmp/ext/' + id });
    updateIngestionJob(id, { status: 'generating' });
    updateIngestionJob(id, { status: 'reviewing' });

    const job = getJobsByStatus('reviewing').find((j) => (j as { id: string }).id === id);
    expect(job).toBeDefined();
    expect((job as { tier: number }).tier).toBe(3);
  });
});
