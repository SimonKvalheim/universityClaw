import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { waitForSentinel } from './sentinel.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/sentinel');

describe('waitForSentinel', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  it('resolves true when sentinel file appears', async () => {
    const sentinelPath = join(TMP, 'job1-complete');

    // Write sentinel after 100ms
    setTimeout(() => writeFileSync(sentinelPath, ''), 100);

    const result = await waitForSentinel(sentinelPath, 5000, 50);
    expect(result).toBe(true);
  });

  it('resolves false on timeout', async () => {
    const sentinelPath = join(TMP, 'nonexistent-complete');

    const result = await waitForSentinel(sentinelPath, 200, 50);
    expect(result).toBe(false);
  });
});
