import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { assertNoLiveNanoclaw, runBackfill } from './backfill-library.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
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

describe('backfill execute path (non-dry-run)', () => {
  let tmp: string;
  let vaultDir: string;
  let uploadProcessedDir: string;
  let reportPath: string;
  let extractedBody: string;

  // Test extractor stub: writes cleanedContent to a tmp content.clean.md and returns its path.
  function makeStubExtractor() {
    return {
      extract: async (
        jobId: string,
        inputPath: string,
      ): Promise<{ cleanContentPath: string }> => {
        const extractDir = join(tmp, 'extractions', jobId);
        mkdirSync(extractDir, { recursive: true });
        const cleanContentPath = join(extractDir, 'content.clean.md');
        writeFileSync(cleanContentPath, extractedBody, 'utf-8');
        return { cleanContentPath };
      },
    };
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backfill-exec-'));
    vaultDir = join(tmp, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    uploadProcessedDir = join(tmp, 'upload', 'processed');
    mkdirSync(uploadProcessedDir, { recursive: true });
    reportPath = join(tmp, 'report.json');
    extractedBody = 'CLEAN BACKFILL BODY';
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes library, patches source frontmatter, deletes tracker row', async () => {
    // Arrange: source note with no `library:` field, real source_file present
    writeSource(vaultDir, 'paper', {
      title: 'Paper',
      source_file: 'upload/processed/jx-paper.pdf',
    });
    writeFileSync(join(uploadProcessedDir, 'jx-paper.pdf'), 'fake pdf', 'utf-8');

    // Seed a tracker row that should get deleted
    const dbModule = await import('../src/db/index.js');
    dbModule._initTestDatabase();
    dbModule.upsertTrackedDoc('sources/paper.md', 'docid-old', 'hash-old');

    await runBackfill({
      vaultDir,
      uploadProcessedDir,
      reportPath,
      dryRun: false,
      force: true,
      extractor: makeStubExtractor(),
    });

    // Assert: library file written
    const libraryPath = join(vaultDir, 'library', 'paper.md');
    expect(existsSync(libraryPath)).toBe(true);
    const libraryContent = readFileSync(libraryPath, 'utf-8');
    expect(libraryContent).toContain('CLEAN BACKFILL BODY');
    expect(libraryContent).toMatch(/^type:\s*library\s*$/m);

    // Assert: source frontmatter patched with `library:` wikilink
    const patched = readFileSync(join(vaultDir, 'sources', 'paper.md'), 'utf-8');
    expect(patched).toMatch(/^library:\s*['"]?\[\[library\/paper\]\]['"]?\s*$/m);

    // Assert: tracker row deleted
    expect(dbModule.getTrackedDoc('sources/paper.md')).toBeNull();
  });

  it('--no-patch-source preserves source frontmatter and tracker row', async () => {
    writeSource(vaultDir, 'p', {
      title: 'P',
      source_file: 'upload/processed/jx-p.pdf',
    });
    writeFileSync(join(uploadProcessedDir, 'jx-p.pdf'), 'fake', 'utf-8');

    const dbModule = await import('../src/db/index.js');
    dbModule._initTestDatabase();
    dbModule.upsertTrackedDoc('sources/p.md', 'd', 'h');

    await runBackfill({
      vaultDir,
      uploadProcessedDir,
      reportPath,
      dryRun: false,
      noPatchSource: true,
      force: true,
      extractor: makeStubExtractor(),
    });

    // Library file is still written
    expect(existsSync(join(vaultDir, 'library', 'p.md'))).toBe(true);

    // Source NOT patched, tracker row preserved
    const sourceContent = readFileSync(join(vaultDir, 'sources', 'p.md'), 'utf-8');
    expect(sourceContent).not.toMatch(/^library:/m);
    expect(dbModule.getTrackedDoc('sources/p.md')).not.toBeNull();
  });
});

describe('backfill direct indexing', () => {
  let tmp: string;
  let vaultDir: string;
  let uploadProcessedDir: string;
  let reportPath: string;

  function makeStubExtractor(body: string) {
    return {
      extract: async (jobId: string): Promise<{ cleanContentPath: string }> => {
        const extractDir = join(tmp, 'extractions', jobId);
        mkdirSync(extractDir, { recursive: true });
        const cleanContentPath = join(extractDir, 'content.clean.md');
        writeFileSync(cleanContentPath, body, 'utf-8');
        return { cleanContentPath };
      },
    };
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backfill-index-'));
    vaultDir = join(tmp, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    uploadProcessedDir = join(tmp, 'upload', 'processed');
    mkdirSync(uploadProcessedDir, { recursive: true });
    reportPath = join(tmp, 'report.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('directly indexes the new library file and the patched source note', async () => {
    writeSource(vaultDir, 'p', { title: 'P', source_file: 'upload/processed/jx-p.pdf' });
    writeFileSync(join(uploadProcessedDir, 'jx-p.pdf'), 'fake', 'utf-8');

    const dbModule = await import('../src/db/index.js');
    dbModule._initTestDatabase();

    const indexFileSpy = vi.fn().mockResolvedValue(undefined);
    const startSpy = vi.fn();
    const indexer = { start: startSpy, indexFile: indexFileSpy };

    await runBackfill({
      vaultDir,
      uploadProcessedDir,
      reportPath,
      dryRun: false,
      force: true,
      extractor: makeStubExtractor('BODY'),
      indexer,
    });

    expect(startSpy).toHaveBeenCalled();
    const indexedPaths = indexFileSpy.mock.calls.map((c) => c[0]);
    // Library file path absolute under vaultDir
    expect(indexedPaths.some((p) => p.endsWith('library/p.md'))).toBe(true);
    // Patched source path
    expect(indexedPaths.some((p) => p.endsWith('sources/p.md'))).toBe(true);
  });

  it('--no-patch-source still indexes the library file but not the source note', async () => {
    writeSource(vaultDir, 'p', { title: 'P', source_file: 'upload/processed/jx-p.pdf' });
    writeFileSync(join(uploadProcessedDir, 'jx-p.pdf'), 'fake', 'utf-8');

    const dbModule = await import('../src/db/index.js');
    dbModule._initTestDatabase();

    const indexFileSpy = vi.fn().mockResolvedValue(undefined);
    const indexer = { start: vi.fn(), indexFile: indexFileSpy };

    await runBackfill({
      vaultDir,
      uploadProcessedDir,
      reportPath,
      dryRun: false,
      noPatchSource: true,
      force: true,
      extractor: makeStubExtractor('BODY'),
      indexer,
    });

    const indexedPaths = indexFileSpy.mock.calls.map((c) => c[0]);
    expect(indexedPaths.some((p) => p.endsWith('library/p.md'))).toBe(true);
    expect(indexedPaths.some((p) => p.endsWith('sources/p.md'))).toBe(false);
  });

  it('indexer.start() is called once even with multiple sources', async () => {
    writeSource(vaultDir, 'a', { title: 'A', source_file: 'upload/processed/jx-a.pdf' });
    writeSource(vaultDir, 'b', { title: 'B', source_file: 'upload/processed/jx-b.pdf' });
    writeFileSync(join(uploadProcessedDir, 'jx-a.pdf'), 'fake', 'utf-8');
    writeFileSync(join(uploadProcessedDir, 'jx-b.pdf'), 'fake', 'utf-8');

    const dbModule = await import('../src/db/index.js');
    dbModule._initTestDatabase();

    const startSpy = vi.fn();
    const indexer = { start: startSpy, indexFile: vi.fn().mockResolvedValue(undefined) };

    await runBackfill({
      vaultDir,
      uploadProcessedDir,
      reportPath,
      dryRun: false,
      force: true,
      extractor: makeStubExtractor('BODY'),
      indexer,
    });

    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('skips indexer in dry-run', async () => {
    writeSource(vaultDir, 'p', { title: 'P', source_file: 'upload/processed/jx-p.pdf' });
    writeFileSync(join(uploadProcessedDir, 'jx-p.pdf'), 'fake', 'utf-8');

    const indexer = { start: vi.fn(), indexFile: vi.fn().mockResolvedValue(undefined) };

    await runBackfill({
      vaultDir,
      uploadProcessedDir,
      reportPath,
      dryRun: true,
      force: true,
      indexer,
    });

    expect(indexer.start).not.toHaveBeenCalled();
    expect(indexer.indexFile).not.toHaveBeenCalled();
  });
});
