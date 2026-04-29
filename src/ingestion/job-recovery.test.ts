import { describe, it, expect, beforeEach } from 'vitest';
import {
  markInterruptedJobsFailed,
  resetRecoverableInProgress,
} from './job-recovery.js';
import {
  _initTestDatabase,
  createIngestionJob,
  updateIngestionJob,
  getJobsByStatus,
} from '../db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('markInterruptedJobsFailed', () => {
  it('marks extracting jobs as failed', () => {
    createIngestionJob('ext-1', '/tmp/ext-1.pdf', 'test.pdf');
    updateIngestionJob('ext-1', { status: 'extracting' });

    const count = markInterruptedJobsFailed();

    expect(count).toBe(1);
    const failed = getJobsByStatus('failed') as Array<Record<string, unknown>>;
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('ext-1');
    expect(failed[0].error).toBe('Interrupted: process restarted');
  });

  it('marks generating jobs as failed', () => {
    createIngestionJob('gen-1', '/tmp/gen-1.pdf', 'test.pdf');
    updateIngestionJob('gen-1', { status: 'generating' });

    const count = markInterruptedJobsFailed();

    expect(count).toBe(1);
    const failed = getJobsByStatus('failed') as Array<Record<string, unknown>>;
    expect(failed[0].id).toBe('gen-1');
  });

  it('marks promoting jobs as failed', () => {
    createIngestionJob('promo-1', '/tmp/promo-1.pdf', 'test.pdf');
    updateIngestionJob('promo-1', { status: 'promoting' });

    const count = markInterruptedJobsFailed();

    expect(count).toBe(1);
    const failed = getJobsByStatus('failed') as Array<Record<string, unknown>>;
    expect(failed[0].id).toBe('promo-1');
  });

  it('marks all in-progress jobs across statuses', () => {
    createIngestionJob('a', '/tmp/a.pdf', 'a.pdf');
    createIngestionJob('b', '/tmp/b.pdf', 'b.pdf');
    createIngestionJob('c', '/tmp/c.pdf', 'c.pdf');
    updateIngestionJob('a', { status: 'extracting' });
    updateIngestionJob('b', { status: 'generating' });
    updateIngestionJob('c', { status: 'promoting' });

    const count = markInterruptedJobsFailed();

    expect(count).toBe(3);
    const failed = getJobsByStatus('failed');
    expect(failed).toHaveLength(3);
  });

  it('does not touch pending, extracted, generated, or completed jobs', () => {
    createIngestionJob('p', '/tmp/p.pdf', 'p.pdf');
    createIngestionJob('e', '/tmp/e.pdf', 'e.pdf');
    createIngestionJob('g', '/tmp/g.pdf', 'g.pdf');
    createIngestionJob('c', '/tmp/c.pdf', 'c.pdf');
    updateIngestionJob('e', { status: 'extracted' });
    updateIngestionJob('g', { status: 'generated' });
    updateIngestionJob('c', { status: 'completed' });

    const count = markInterruptedJobsFailed();

    expect(count).toBe(0);
    expect(getJobsByStatus('pending')).toHaveLength(1);
    expect(getJobsByStatus('extracted')).toHaveLength(1);
    expect(getJobsByStatus('generated')).toHaveLength(1);
    expect(getJobsByStatus('completed')).toHaveLength(1);
  });

  it('returns 0 when no in-progress jobs exist', () => {
    const count = markInterruptedJobsFailed();
    expect(count).toBe(0);
  });
});

describe('resetRecoverableInProgress', () => {
  it('resets a stuck librarying job back to extracted', () => {
    createIngestionJob('lib-1', '/tmp/lib-1.pdf', 'lib-1.pdf');
    updateIngestionJob('lib-1', { status: 'librarying', error: 'stale' });

    const count = resetRecoverableInProgress();

    expect(count).toBe(1);
    const extracted = getJobsByStatus('extracted') as Array<{
      id: string;
      error: string | null;
    }>;
    const job = extracted.find((j) => j.id === 'lib-1');
    expect(job).toBeDefined();
    expect(job!.error).toBeNull();
  });

  it("does not touch other in-progress statuses (those are markInterruptedJobsFailed's job)", () => {
    createIngestionJob('ext-1', '/tmp/ext-1.pdf', 'ext-1.pdf');
    updateIngestionJob('ext-1', { status: 'extracting' });

    const count = resetRecoverableInProgress();

    expect(count).toBe(0);
    const extracting = getJobsByStatus('extracting') as Array<{ id: string }>;
    expect(extracting.some((j) => j.id === 'ext-1')).toBe(true);
  });

  it('does not touch terminal statuses', () => {
    createIngestionJob('done-1', '/tmp/done-1.pdf', 'done-1.pdf');
    updateIngestionJob('done-1', { status: 'completed' });

    const count = resetRecoverableInProgress();

    expect(count).toBe(0);
    expect(getJobsByStatus('completed')).toHaveLength(1);
  });

  it('transitions a librarying job past the retry cap to failed instead of resetting', () => {
    createIngestionJob('cap-1', '/tmp/cap-1.pdf', 'cap-1.pdf');
    updateIngestionJob('cap-1', { status: 'librarying', retry_count: 5 });

    const count = resetRecoverableInProgress();

    expect(count).toBe(0);
    const failed = getJobsByStatus('failed') as Array<{
      id: string;
      error: string | null;
    }>;
    const job = failed.find((j) => j.id === 'cap-1');
    expect(job).toBeDefined();
    expect(job!.error).toMatch(/exceeded retry cap/);
  });
});
