import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _initTestDatabase, createIngestionJob, updateIngestionJob, getJobsByStatus } from '../db.js';
import { IngestionPipeline } from './index.js';
import type { RegisteredGroup } from '../types.js';

const stubGroup: RegisteredGroup = {
  name: 'test',
  folder: 'test',
  trigger: 'test',
  added_at: new Date().toISOString(),
};

describe('handleLibrarying', () => {
  let tmp: string;
  let vaultDir: string;
  let uploadDir: string;
  let extractionDir: string;

  beforeEach(() => {
    _initTestDatabase();
    tmp = mkdtempSync(join(tmpdir(), 'handle-librarying-'));
    vaultDir = join(tmp, 'vault');
    uploadDir = join(tmp, 'upload');
    extractionDir = join(tmp, 'extraction');
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(uploadDir, { recursive: true });
    mkdirSync(extractionDir, { recursive: true });
    writeFileSync(join(extractionDir, 'content.clean.md'), 'CLEAN BODY', 'utf-8');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes vault/library/{slug}.md when a job transitions extracted → libraried', async () => {
    createIngestionJob('j1', join(uploadDir, 'sample-paper.pdf'), 'sample-paper.pdf');
    updateIngestionJob('j1', {
      status: 'extracted',
      extraction_path: extractionDir,
      source_type: 'paper',
    });

    const pipeline = new IngestionPipeline({ vaultDir, uploadDir, reviewAgentGroup: stubGroup });
    const job = (getJobsByStatus('extracted') as Array<{ id: string }>).find((j) => j.id === 'j1')!;
    await pipeline.handleLibrarying(job as any);

    const libraryPath = join(vaultDir, 'library', 'sample-paper.md');
    expect(existsSync(libraryPath)).toBe(true);
    const content = readFileSync(libraryPath, 'utf-8');
    expect(content).toMatch(/^type:\s*library\s*$/m);
    expect(content).toContain('CLEAN BODY');
  });

  it('falls back to content.md when content.clean.md is missing', async () => {
    rmSync(join(extractionDir, 'content.clean.md'));
    writeFileSync(join(extractionDir, 'content.md'), 'RAW BODY', 'utf-8');

    createIngestionJob('j2', join(uploadDir, 'foo.pdf'), 'foo.pdf');
    updateIngestionJob('j2', { status: 'extracted', extraction_path: extractionDir });

    const pipeline = new IngestionPipeline({ vaultDir, uploadDir, reviewAgentGroup: stubGroup });
    const job = (getJobsByStatus('extracted') as Array<{ id: string }>).find((j) => j.id === 'j2')!;
    await pipeline.handleLibrarying(job as any);

    const written = readFileSync(join(vaultDir, 'library', 'foo.md'), 'utf-8');
    expect(written).toContain('RAW BODY');
  });

  it('uses zotero_metadata.title when available', async () => {
    createIngestionJob('j3', join(uploadDir, 'zot.pdf'), 'zot.pdf', undefined, {
      zotero_metadata: JSON.stringify({ title: 'Zotero Title' }),
    });
    updateIngestionJob('j3', {
      status: 'extracted',
      extraction_path: extractionDir,
    });

    const pipeline = new IngestionPipeline({ vaultDir, uploadDir, reviewAgentGroup: stubGroup });
    const job = (getJobsByStatus('extracted') as Array<{ id: string }>).find((j) => j.id === 'j3')!;
    await pipeline.handleLibrarying(job as any);

    const written = readFileSync(join(vaultDir, 'library', 'zot.md'), 'utf-8');
    expect(written).toMatch(/^title:\s*Zotero Title\s*$/m);
  });

  it('falls back to slug-Title-Case when no metadata title is available', async () => {
    createIngestionJob('j4', join(uploadDir, 'two-words.pdf'), 'two-words.pdf');
    updateIngestionJob('j4', { status: 'extracted', extraction_path: extractionDir });

    const pipeline = new IngestionPipeline({ vaultDir, uploadDir, reviewAgentGroup: stubGroup });
    const job = (getJobsByStatus('extracted') as Array<{ id: string }>).find((j) => j.id === 'j4')!;
    await pipeline.handleLibrarying(job as any);

    const written = readFileSync(join(vaultDir, 'library', 'two-words.md'), 'utf-8');
    expect(written).toMatch(/^title:\s*Two Words\s*$/m);
  });
});
