import { describe, it, expect, beforeEach } from 'vitest';
import { recoverStaleJobs } from './job-recovery.js';
import {
  _initTestDatabase,
  createIngestionJob,
  updateIngestionJob,
  getJobsByStatus,
  getDb,
} from '../db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('recoverStaleJobs', () => {
  it('resets stale extracting jobs to pending', () => {
    const id = 'stale-extracting-' + Date.now();
    createIngestionJob(id, `/tmp/${id}.pdf`, 'test.pdf');
    updateIngestionJob(id, { status: 'extracting' });
    // Manually backdate updated_at for test
    getDb()
      .prepare(
        "UPDATE ingestion_jobs SET updated_at = datetime('now', '-60 minutes') WHERE id = ?",
      )
      .run(id);

    const recovered = recoverStaleJobs({
      extractingThresholdMin: 10,
      generatingThresholdMin: 45,
    });
    expect(recovered.extracting).toBeGreaterThan(0);

    const jobs = getJobsByStatus('pending');
    expect(jobs.find((j) => (j as { id: string }).id === id)).toBeDefined();
  });

  it('resets stale generating jobs to extracted (with extraction path)', () => {
    const id = 'stale-generating-' + Date.now();
    createIngestionJob(id, `/tmp/${id}.pdf`, 'test.pdf');
    updateIngestionJob(id, {
      status: 'generating',
      extraction_path: '/tmp/extractions/' + id,
    });
    getDb()
      .prepare(
        "UPDATE ingestion_jobs SET updated_at = datetime('now', '-60 minutes') WHERE id = ?",
      )
      .run(id);

    const recovered = recoverStaleJobs({
      extractingThresholdMin: 10,
      generatingThresholdMin: 45,
    });
    expect(recovered.generating).toBeGreaterThan(0);

    const jobs = getJobsByStatus('extracted');
    expect(jobs.find((j) => (j as { id: string }).id === id)).toBeDefined();
  });

  it('resets stale generating jobs to pending (without extraction path)', () => {
    const id = 'stale-gen-noext-' + Date.now();
    createIngestionJob(id, `/tmp/${id}.pdf`, 'test.pdf');
    updateIngestionJob(id, { status: 'generating' });
    getDb()
      .prepare(
        "UPDATE ingestion_jobs SET updated_at = datetime('now', '-60 minutes') WHERE id = ?",
      )
      .run(id);

    const recovered = recoverStaleJobs({
      extractingThresholdMin: 10,
      generatingThresholdMin: 45,
    });
    expect(recovered.generating).toBeGreaterThan(0);

    const jobs = getJobsByStatus('pending');
    expect(jobs.find((j) => (j as { id: string }).id === id)).toBeDefined();
  });

  it('resets stale promoting jobs to generated', () => {
    const id = 'stale-promoting-' + Date.now();
    createIngestionJob(id, `/tmp/${id}.pdf`, 'test.pdf');
    updateIngestionJob(id, { status: 'promoting' });
    getDb()
      .prepare(
        "UPDATE ingestion_jobs SET updated_at = datetime('now', '-60 minutes') WHERE id = ?",
      )
      .run(id);

    const recovered = recoverStaleJobs({
      extractingThresholdMin: 10,
      generatingThresholdMin: 45,
    });
    expect(recovered.promoting).toBeGreaterThan(0);

    const jobs = getJobsByStatus('generated');
    expect(jobs.find((j) => (j as { id: string }).id === id)).toBeDefined();
  });

  it('does not reset recent jobs', () => {
    const id = 'recent-generating-' + Date.now();
    createIngestionJob(id, `/tmp/${id}.pdf`, 'test.pdf');
    updateIngestionJob(id, { status: 'generating' });
    // Don't backdate — this job is fresh

    const before = getJobsByStatus('generating').length;
    recoverStaleJobs({
      extractingThresholdMin: 10,
      generatingThresholdMin: 45,
    });
    const after = getJobsByStatus('generating').length;

    // Fresh job should still be in generating
    expect(after).toBe(before);
  });
});
