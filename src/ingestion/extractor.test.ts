import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

  it('returns false when content.clean.md is missing', async () => {
    const jobDir = join(baseDir, 'partial-job3');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, 'content.md'), 'raw content');
    writeFileSync(join(jobDir, 'metadata.json'), '{}');
    const result = await extractor.hasArtifacts('partial-job3');
    expect(result).toBe(false);
  });

  it('returns true when content.md, content.clean.md, and metadata.json exist', async () => {
    const jobDir = join(baseDir, 'complete-job');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, 'content.md'), '# hello');
    writeFileSync(join(jobDir, 'content.clean.md'), '# hello');
    writeFileSync(join(jobDir, 'metadata.json'), '{}');
    const result = await extractor.hasArtifacts('complete-job');
    expect(result).toBe(true);
  });
});

describe('cleanAndWrite', () => {
  it('writes content.clean.md alongside content.md', () => {
    const jobId = 'cleanwrite-job-1';
    const dir = join(baseDir, jobId);
    mkdirSync(dir, { recursive: true });
    const rawContent = [
      '<!-- page:1 label:text -->',
      'EEG',
      '',
      '<!-- page:1 label:text -->',
      'EEG',
      '',
      '<!-- page:1 label:text -->',
      'Real content that is long enough to not be considered noise by the cleaner rules.',
    ].join('\n');
    writeFileSync(join(dir, 'content.md'), rawContent);

    extractor.cleanAndWrite(jobId);

    const cleanPath = join(dir, 'content.clean.md');
    expect(existsSync(cleanPath)).toBe(true);
    const cleaned = readFileSync(cleanPath, 'utf-8');
    expect(cleaned.match(/EEG/g)?.length).toBe(1);
    expect(cleaned).toContain('Real content');
  });

  it('returns the clean content path', () => {
    const jobId = 'cleanwrite-job-2';
    const dir = join(baseDir, jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'content.md'), '<!-- page:1 label:text -->\nHello');

    const cleanPath = extractor.cleanAndWrite(jobId);
    expect(cleanPath).toBe(join(dir, 'content.clean.md'));
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
