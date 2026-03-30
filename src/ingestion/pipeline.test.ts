import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  _initTestDatabase,
  createIngestionJob,
  getJobsByStatus,
  updateIngestionJob,
} from '../db.js';
import { PipelineDrainer } from './pipeline.js';

beforeEach(() => {
  _initTestDatabase();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PipelineDrainer', () => {
  it('picks up pending jobs and calls onExtract', async () => {
    createIngestionJob('job-1', '/uploads/job-1.pdf', 'job-1.pdf');

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

  it('picks up extracted jobs and calls onGenerate', async () => {
    createIngestionJob('job-2', '/uploads/job-2.pdf', 'job-2.pdf');
    updateIngestionJob('job-2', { status: 'extracted' });

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
});
