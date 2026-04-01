import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  _initTestDatabase,
  createIngestionJob,
  getJobsByStatus,
  updateIngestionJob,
  setSetting,
} from '../db.js';
import { PipelineDrainer, JobRow } from './pipeline.js';

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
      onPromote: async () => {},
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
      onPromote: async () => {},
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

  it('picks up generated jobs and calls onPromote', async () => {
    createIngestionJob('job-3', '/uploads/job-3.pdf', 'job-3.pdf');
    updateIngestionJob('job-3', { status: 'generated' });

    const promoted: string[] = [];
    const drainer = new PipelineDrainer({
      onExtract: async () => {},
      onGenerate: async () => {},
      onPromote: async (job) => {
        promoted.push(job.id);
      },
      maxExtractionConcurrent: 2,
      maxGenerationConcurrent: 2,
      pollIntervalMs: 100,
    });

    drainer.drain();
    await vi.advanceTimersByTimeAsync(150);
    drainer.stop();

    expect(promoted).toContain('job-3');
    const jobs = getJobsByStatus('promoting') as Array<{ id: string }>;
    expect(jobs.some((j) => j.id === 'job-3')).toBe(true);
  });

  describe('drainRateLimited', () => {
    it('resets past-due rate_limited jobs to correct status based on error prefix', async () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();

      createIngestionJob('rl-1', '/uploads/rl-1.pdf', 'rl-1.pdf');
      updateIngestionJob('rl-1', {
        status: 'rate_limited',
        error: 'extracting:rate limit exceeded',
        retry_after: pastDate,
        retry_count: 0,
      });

      createIngestionJob('rl-2', '/uploads/rl-2.pdf', 'rl-2.pdf');
      updateIngestionJob('rl-2', {
        status: 'rate_limited',
        error: 'generating:429 too many requests',
        retry_after: pastDate,
        retry_count: 1,
      });

      createIngestionJob('rl-3', '/uploads/rl-3.pdf', 'rl-3.pdf');
      updateIngestionJob('rl-3', {
        status: 'rate_limited',
        error: 'promoting:overloaded',
        retry_after: pastDate,
        retry_count: 2,
      });

      const drainer = new PipelineDrainer({
        onExtract: async () => {},
        onGenerate: async () => {},
        onPromote: async () => {},
        maxExtractionConcurrent: 2,
        maxGenerationConcurrent: 2,
        pollIntervalMs: 100,
      });

      drainer.drainRateLimited();

      // rl-1 should be reset to 'pending' (extracting → pending)
      const pending = getJobsByStatus('pending') as JobRow[];
      expect(pending.some((j) => j.id === 'rl-1')).toBe(true);
      const rl1 = pending.find((j) => j.id === 'rl-1')!;
      expect(rl1.retry_count).toBe(1);
      expect(rl1.error).toBeNull();

      // rl-2 should be reset to 'extracted' (generating → extracted)
      const extracted = getJobsByStatus('extracted') as JobRow[];
      expect(extracted.some((j) => j.id === 'rl-2')).toBe(true);
      const rl2 = extracted.find((j) => j.id === 'rl-2')!;
      expect(rl2.retry_count).toBe(2);

      // rl-3 should be reset to 'generated' (promoting → generated)
      const generated = getJobsByStatus('generated') as JobRow[];
      expect(generated.some((j) => j.id === 'rl-3')).toBe(true);
      const rl3 = generated.find((j) => j.id === 'rl-3')!;
      expect(rl3.retry_count).toBe(3);
    });

    it('skips jobs whose retry_after is in the future', () => {
      const futureDate = new Date(Date.now() + 600_000).toISOString();

      createIngestionJob(
        'rl-future',
        '/uploads/rl-future.pdf',
        'rl-future.pdf',
      );
      updateIngestionJob('rl-future', {
        status: 'rate_limited',
        error: 'generating:rate limit',
        retry_after: futureDate,
        retry_count: 0,
      });

      const drainer = new PipelineDrainer({
        onExtract: async () => {},
        onGenerate: async () => {},
        onPromote: async () => {},
        maxExtractionConcurrent: 2,
        maxGenerationConcurrent: 2,
        pollIntervalMs: 100,
      });

      drainer.drainRateLimited();

      // Should still be rate_limited
      const rateLimited = getJobsByStatus('rate_limited') as JobRow[];
      expect(rateLimited.some((j) => j.id === 'rl-future')).toBe(true);
    });
  });

  describe('stage-prefixed errors', () => {
    it('prefixes extraction errors with extracting:', async () => {
      createIngestionJob('ext-err', '/uploads/ext-err.pdf', 'ext-err.pdf');

      const drainer = new PipelineDrainer({
        onExtract: async () => {
          throw new Error('disk full');
        },
        onGenerate: async () => {},
        onPromote: async () => {},
        maxExtractionConcurrent: 2,
        maxGenerationConcurrent: 2,
        pollIntervalMs: 100,
      });

      drainer.drain();
      await vi.advanceTimersByTimeAsync(150);
      await drainer.stop();

      const failed = getJobsByStatus('failed') as JobRow[];
      const job = failed.find((j) => j.id === 'ext-err');
      expect(job).toBeDefined();
      expect(job!.error).toBe('extracting:disk full');
    });

    it('prefixes generation errors with generating:', async () => {
      createIngestionJob('gen-err', '/uploads/gen-err.pdf', 'gen-err.pdf');
      updateIngestionJob('gen-err', { status: 'extracted' });

      const drainer = new PipelineDrainer({
        onExtract: async () => {},
        onGenerate: async () => {
          throw new Error('timeout');
        },
        onPromote: async () => {},
        maxExtractionConcurrent: 2,
        maxGenerationConcurrent: 2,
        pollIntervalMs: 100,
      });

      drainer.drain();
      await vi.advanceTimersByTimeAsync(150);
      await drainer.stop();

      const failed = getJobsByStatus('failed') as JobRow[];
      const job = failed.find((j) => j.id === 'gen-err');
      expect(job).toBeDefined();
      expect(job!.error).toBe('generating:timeout');
    });

    it('prefixes promotion errors with promoting:', async () => {
      createIngestionJob('prom-err', '/uploads/prom-err.pdf', 'prom-err.pdf');
      updateIngestionJob('prom-err', { status: 'generated' });

      const drainer = new PipelineDrainer({
        onExtract: async () => {},
        onGenerate: async () => {},
        onPromote: async () => {
          throw new Error('vault locked');
        },
        maxExtractionConcurrent: 2,
        maxGenerationConcurrent: 2,
        pollIntervalMs: 100,
      });

      drainer.drain();
      await vi.advanceTimersByTimeAsync(150);
      await drainer.stop();

      const failed = getJobsByStatus('failed') as JobRow[];
      const job = failed.find((j) => j.id === 'prom-err');
      expect(job).toBeDefined();
      expect(job!.error).toBe('promoting:vault locked');
    });
  });

  describe('dynamic concurrency', () => {
    it('calls getter function for maxGenerationConcurrent', async () => {
      createIngestionJob('dyn-1', '/uploads/dyn-1.pdf', 'dyn-1.pdf');
      updateIngestionJob('dyn-1', { status: 'extracted' });
      createIngestionJob('dyn-2', '/uploads/dyn-2.pdf', 'dyn-2.pdf');
      updateIngestionJob('dyn-2', { status: 'extracted' });
      createIngestionJob('dyn-3', '/uploads/dyn-3.pdf', 'dyn-3.pdf');
      updateIngestionJob('dyn-3', { status: 'extracted' });

      const getter = vi.fn().mockReturnValue(2);
      const generated: string[] = [];
      const drainer = new PipelineDrainer({
        onExtract: async () => {},
        onGenerate: async (job) => {
          generated.push(job.id);
        },
        onPromote: async () => {},
        maxExtractionConcurrent: 2,
        maxGenerationConcurrent: getter,
        pollIntervalMs: 100,
      });

      drainer.drain();
      await vi.advanceTimersByTimeAsync(150);
      await drainer.stop();

      expect(getter).toHaveBeenCalled();
      // Should start at most 2 jobs (the getter returns 2)
      const generating = getJobsByStatus('generating') as JobRow[];
      expect(generating.length).toBeLessThanOrEqual(2);
    });
  });

  describe('tick ordering', () => {
    it('calls drainRateLimited before other drain methods', async () => {
      // Set up a rate_limited job with generating error prefix
      // so it resets to 'extracted', which drainGenerations will then pick up
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      createIngestionJob('tick-rl', '/uploads/tick-rl.pdf', 'tick-rl.pdf');
      updateIngestionJob('tick-rl', {
        status: 'rate_limited',
        error: 'generating:rate limit',
        retry_after: pastDate,
        retry_count: 0,
        extraction_path: '/tmp/ext',
      });

      const generatedIds: string[] = [];
      const drainer = new PipelineDrainer({
        onExtract: async () => {},
        onGenerate: async (job) => {
          generatedIds.push(job.id);
        },
        onPromote: async () => {},
        maxExtractionConcurrent: 2,
        maxGenerationConcurrent: 2,
        pollIntervalMs: 100,
      });

      await drainer.tick();

      // drainRateLimited ran first, resetting to 'extracted',
      // then drainGenerations picked it up
      const rateLimited = getJobsByStatus('rate_limited') as JobRow[];
      expect(rateLimited).toHaveLength(0);

      // The job should have been picked up by onGenerate
      expect(generatedIds).toContain('tick-rl');
    });
  });
});
