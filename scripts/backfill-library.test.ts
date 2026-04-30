import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { assertNoLiveNanoclaw, runBackfill } from './backfill-library.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function writeSource(vaultDir: string, slug: string, fm: Record<string, unknown>): void {
  const sourcesDir = join(vaultDir, 'sources');
  mkdirSync(sourcesDir, { recursive: true });
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === 'string') lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', `# ${fm.title ?? slug}`, '', 'body');
  writeFileSync(join(sourcesDir, `${slug}.md`), lines.join('\n'), 'utf-8');
}

describe('backfill walker', () => {
  let tmp: string;
  let vaultDir: string;
  let reportPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backfill-walker-'));
    vaultDir = join(tmp, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(join(tmp, 'upload', 'processed'), { recursive: true });
    reportPath = join(tmp, 'report.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports a skip for already-libraried sources', async () => {
    writeSource(vaultDir, 'a', {
      title: 'A',
      source_file: 'upload/processed/x-a.pdf',
      library: '[[library/a]]',
    });
    const report = await runBackfill({
      vaultDir,
      uploadProcessedDir: join(tmp, 'upload', 'processed'),
      reportPath,
      dryRun: true,
      force: true,
    });
    expect(report.skipped).toContainEqual(
      expect.objectContaining({ slug: 'a', reason: 'skipped_existing' }),
    );
  });

  it('reports missing_original when source_file is gone', async () => {
    writeSource(vaultDir, 'b', {
      title: 'B',
      source_file: 'upload/processed/missing.pdf',
    });
    const report = await runBackfill({
      vaultDir,
      uploadProcessedDir: join(tmp, 'upload', 'processed'),
      reportPath,
      dryRun: true,
      force: true,
    });
    expect(report.skipped).toContainEqual(
      expect.objectContaining({ slug: 'b', reason: 'missing_original' }),
    );
  });

  it('--source filters to a single slug', async () => {
    writeSource(vaultDir, 'a', { title: 'A', source_file: 'x.pdf' });
    writeSource(vaultDir, 'b', { title: 'B', source_file: 'y.pdf' });
    const report = await runBackfill({
      vaultDir,
      uploadProcessedDir: join(tmp, 'upload', 'processed'),
      reportPath,
      dryRun: true,
      source: 'a',
      force: true,
    });
    expect(report.totalSources).toBe(1);
  });

  it('writes JSON report to --report path', async () => {
    writeSource(vaultDir, 'a', { title: 'A', source_file: 'x.pdf' });
    await runBackfill({
      vaultDir,
      uploadProcessedDir: join(tmp, 'upload', 'processed'),
      reportPath,
      dryRun: true,
      force: true,
    });
    const parsed = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(parsed).toMatchObject({
      totalSources: expect.any(Number),
      processed: expect.any(Number),
      startedAt: expect.any(String),
      endedAt: expect.any(String),
    });
  });

  it('counts processed in dry-run for jobs that would be backfilled', async () => {
    const uploadFile = join(tmp, 'upload', 'processed', 'real.pdf');
    writeFileSync(uploadFile, 'fake pdf content', 'utf-8');
    writeSource(vaultDir, 'realdoc', {
      title: 'Real Doc',
      source_file: 'upload/processed/real.pdf',
    });
    const report = await runBackfill({
      vaultDir,
      uploadProcessedDir: join(tmp, 'upload', 'processed'),
      reportPath,
      dryRun: true,
      force: true,
    });
    expect(report.processed).toBe(1);
    expect(report.skipped).toEqual([]);
  });
});
