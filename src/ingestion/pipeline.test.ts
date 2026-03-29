import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { _initTestDatabase, createIngestionJob, getJobsByStatus } from '../db.js';
import { PipelineDrainer } from './pipeline.js';

beforeEach(() => {
  _initTestDatabase();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeJob(
  id: string,
  status: string,
  tier: number,
  sourcePath = `/uploads/${id}.pdf`,
): void {
  createIngestionJob(id, sourcePath, `${id}.pdf`, null, null, null, null, null);
  // Set tier and status after creation (default is pending/tier 2)
  const { updateIngestionJob } = require('../db.js');
  updateIngestionJob(id, { status, tier });
}

describe('PipelineDrainer', () => {
  it('picks up pending jobs and calls onExtract', async () => {
    createIngestionJob(
      'job-1',
      '/uploads/job-1.pdf',
      'job-1.pdf',
      null,
      null,
      null,
      null,
      null,
    );

    const extracted: string[] = [];
    const drainer = new PipelineDrainer({
      onExtract: async (job) => {
        extracted.push(job.id);
      },
      onGenerate: async () => {},
      maxExtractionConcurrent: 2,
      maxGenerationConcurrent: 2,
      pollIntervalMs: 100,
    });

    drainer.drain();
    await vi.advanceTimersByTimeAsync(150);
    drainer.stop();

    expect(extracted).toContain('job-1');
    // Job should be in extracting state
    const jobs = getJobsByStatus('extracting') as Array<{ id: string }>;
    expect(jobs.some((j) => j.id === 'job-1')).toBe(true);
  });

  it('picks up extracted tier 2/3 jobs and calls onGenerate', async () => {
    createIngestionJob(
      'job-2',
      '/uploads/job-2.pdf',
      'job-2.pdf',
      null,
      null,
      null,
      null,
      null,
    );
    const { updateIngestionJob } = await import('../db.js');
    updateIngestionJob('job-2', { status: 'extracted', tier: 2 });

    const generated: string[] = [];
    const drainer = new PipelineDrainer({
      onExtract: async () => {},
      onGenerate: async (job) => {
        generated.push(job.id);
      },
      maxExtractionConcurrent: 2,
      maxGenerationConcurrent: 2,
      pollIntervalMs: 100,
    });

    drainer.drain();
    await vi.advanceTimersByTimeAsync(150);
    drainer.stop();

    expect(generated).toContain('job-2');
    const jobs = getJobsByStatus('generating') as Array<{ id: string }>;
    expect(jobs.some((j) => j.id === 'job-2')).toBe(true);
  });

  it('auto-completes extracted tier 1 jobs without AI', async () => {
    createIngestionJob(
      'job-3',
      '/uploads/job-3.pdf',
      'job-3.pdf',
      null,
      null,
      null,
      null,
      null,
    );
    const { updateIngestionJob } = await import('../db.js');
    updateIngestionJob('job-3', { status: 'extracted', tier: 1 });

    const generated: string[] = [];
    const drainer = new PipelineDrainer({
      onExtract: async () => {},
      onGenerate: async (job) => {
        generated.push(job.id);
      },
      maxExtractionConcurrent: 2,
      maxGenerationConcurrent: 2,
      pollIntervalMs: 100,
    });

    drainer.drain();
    await vi.advanceTimersByTimeAsync(150);
    drainer.stop();

    // onGenerate should NOT have been called
    expect(generated).not.toContain('job-3');
    // Job should be completed
    const jobs = getJobsByStatus('completed') as Array<{ id: string }>;
    expect(jobs.some((j) => j.id === 'job-3')).toBe(true);
  });
});
