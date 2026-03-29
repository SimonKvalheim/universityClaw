import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';

import { Extractor } from './extractor.js';

let baseDir: string;
let extractor: Extractor;

beforeEach(async () => {
  baseDir = join(tmpdir(), `extractor-test-${Date.now()}`);
  await mkdir(baseDir, { recursive: true });
  extractor = new Extractor({ extractionsDir: baseDir });
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('getExtractionDir', () => {
  it('returns the expected path for a job id', () => {
    const dir = extractor.getExtractionDir('job-abc');
    expect(dir).toBe(join(baseDir, 'job-abc'));
  });
});

describe('hasArtifacts', () => {
  it('returns false when directory does not exist', async () => {
    const result = await extractor.hasArtifacts('nonexistent-job');
    expect(result).toBe(false);
  });

  it('returns false when content.md is missing', async () => {
    const jobDir = join(baseDir, 'partial-job');
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, 'metadata.json'), '{}');
    const result = await extractor.hasArtifacts('partial-job');
    expect(result).toBe(false);
  });

  it('returns false when metadata.json is missing', async () => {
    const jobDir = join(baseDir, 'partial-job2');
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, 'content.md'), '# hello');
    const result = await extractor.hasArtifacts('partial-job2');
    expect(result).toBe(false);
  });

  it('returns true when both content.md and metadata.json exist', async () => {
    const jobDir = join(baseDir, 'complete-job');
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, 'content.md'), '# hello');
    await writeFile(join(jobDir, 'metadata.json'), '{}');
    const result = await extractor.hasArtifacts('complete-job');
    expect(result).toBe(true);
  });
});

describe('cleanup', () => {
  it('removes the extraction directory', async () => {
    const jobDir = join(baseDir, 'cleanup-job');
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, 'content.md'), '# data');

    await extractor.cleanup('cleanup-job');

    const result = await extractor.hasArtifacts('cleanup-job');
    expect(result).toBe(false);
  });

  it('does not throw when directory does not exist', async () => {
    await expect(extractor.cleanup('ghost-job')).resolves.not.toThrow();
  });
});
