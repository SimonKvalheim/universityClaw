import { describe, expect, it, vi } from 'vitest';
import { assertNoLiveNanoclaw } from './backfill-library.js';

describe('assertNoLiveNanoclaw', () => {
  it('throws when a tsx src/index.ts process is running', async () => {
    const spawnStub = vi.fn().mockResolvedValue({
      stdout: '12345 node tsx src/index.ts\n67890 node something-else\n',
    });
    await expect(assertNoLiveNanoclaw({ spawn: spawnStub })).rejects.toThrow(/NanoClaw is running/);
  });

  it('passes when no nanoclaw process is detected', async () => {
    const spawnStub = vi.fn().mockResolvedValue({ stdout: '12345 node something-else\n' });
    await expect(assertNoLiveNanoclaw({ spawn: spawnStub })).resolves.toBeUndefined();
  });

  it('--force-unsafe-concurrent bypasses the guard', async () => {
    const spawnStub = vi.fn().mockResolvedValue({ stdout: '12345 node tsx src/index.ts\n' });
    await expect(assertNoLiveNanoclaw({ spawn: spawnStub, force: true })).resolves.toBeUndefined();
  });
});
