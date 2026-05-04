import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  _initTestDatabase,
  createIngestionJob,
  updateIngestionJob,
  getJobsByStatus,
} from '../db.js';
import { IngestionPipeline } from './index.js';
import type { RegisteredGroup } from '../types.js';
import { parseFrontmatter } from '../vault/frontmatter.js';

const stubGroup: RegisteredGroup = {
  name: 'test',
  folder: 'test',
  trigger: 'test',
  added_at: new Date().toISOString(),
};

// ~800K chars = ~200K estimated tokens, well above the 80K budget
const OVERSIZED_CONTENT = 'x'.repeat(800_000);

describe('handleGeneration over-budget path', () => {
  let tmp: string;
  let vaultDir: string;
  let uploadDir: string;
  let extractionDir: string;

  beforeEach(() => {
    _initTestDatabase();
    tmp = mkdtempSync(join(tmpdir(), 'handle-generation-oversized-'));
    vaultDir = join(tmp, 'vault');
    uploadDir = join(tmp, 'upload');
    extractionDir = join(tmp, 'extraction');
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(uploadDir, { recursive: true });
    mkdirSync(extractionDir, { recursive: true });
    writeFileSync(
      join(extractionDir, 'content.clean.md'),
      OVERSIZED_CONTENT,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a stub source draft to drafts/, transitions to generated, never calls the agent', async () => {
    createIngestionJob(
      'ov1',
      join(uploadDir, 'big-paper.pdf'),
      'big-paper.pdf',
      undefined,
      { source_type: 'paper' },
    );
    updateIngestionJob('ov1', {
      status: 'libraried',
      extraction_path: extractionDir,
    });

    const pipeline = new IngestionPipeline({
      vaultDir,
      uploadDir,
      reviewAgentGroup: stubGroup,
    });

    // Spy on agentProcessor so we can confirm it was never called
    const agentRunSpy = vi.fn().mockResolvedValue(undefined);
    (pipeline as any).agentProcessor = { run: agentRunSpy };

    const job = (getJobsByStatus('libraried') as Array<{ id: string }>).find(
      (j) => j.id === 'ov1',
    )!;
    await pipeline.handleGeneration(job as any);

    // Draft file must exist at drafts/{jobId}-source.md
    const draftPath = join(vaultDir, 'drafts', 'ov1-source.md');
    expect(existsSync(draftPath)).toBe(true);

    // Parse and verify frontmatter
    const content = readFileSync(draftPath, 'utf-8');
    const { data: fm, content: body } = parseFrontmatter(content);
    expect(fm.type).toBe('source');
    expect(fm.library).toBe('[[library/big-paper]]');
    expect(fm.auto_generated).toBe(true);
    expect(Array.isArray(fm.concepts_generated)).toBe(true);
    expect((fm.concepts_generated as unknown[]).length).toBe(0);

    // Body must have a heading and the over-budget explanation
    expect(body).toMatch(/^#\s+/m);
    expect(body).toContain('token budget');

    // Job must be in 'generated' status (NOT 'oversized')
    const generated = (
      getJobsByStatus('generated') as Array<{ id: string }>
    ).find((j) => j.id === 'ov1');
    expect(generated).toBeDefined();

    // Agent must not have been invoked
    expect(agentRunSpy).not.toHaveBeenCalled();
  });

  it('does not send a Telegram notification on over-budget', async () => {
    createIngestionJob(
      'ov2',
      join(uploadDir, 'huge-doc.pdf'),
      'huge-doc.pdf',
      undefined,
      {
        source_type: 'paper',
      },
    );
    updateIngestionJob('ov2', {
      status: 'libraried',
      extraction_path: extractionDir,
    });

    const notifySpy = vi.fn();
    const pipeline = new IngestionPipeline({
      vaultDir,
      uploadDir,
      reviewAgentGroup: stubGroup,
      notify: notifySpy,
    });
    (pipeline as any).agentProcessor = {
      run: vi.fn().mockResolvedValue(undefined),
    };

    const job = (getJobsByStatus('libraried') as Array<{ id: string }>).find(
      (j) => j.id === 'ov2',
    )!;
    await pipeline.handleGeneration(job as any);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('duplicate-check: libraried job is treated as in-progress and blocks re-enqueue', () => {
    // Seed a file and create a job at 'libraried' status
    const filePath = join(uploadDir, 'in-flight.pdf');
    writeFileSync(filePath, 'dummy content', 'utf-8');
    createIngestionJob('ov3', filePath, 'in-flight.pdf');
    updateIngestionJob('ov3', { status: 'libraried' });

    const pipeline = new IngestionPipeline({
      vaultDir,
      uploadDir,
      reviewAgentGroup: stubGroup,
    });

    // Calling private enqueue with same path should not create a second job —
    // 'libraried' status lands in the completed/extracting/libraried/... in-progress skip branch.
    (pipeline as any).enqueue(filePath);

    // Only one job with this path should exist
    const allJobs = getJobsByStatus('libraried') as Array<{ id: string }>;
    const matching = allJobs.filter((j) => j.id === 'ov3');
    expect(matching.length).toBe(1);

    // No new pending job was created for the same path
    const pending = getJobsByStatus('pending') as Array<{ id: string }>;
    const newPending = pending.filter((j) => j.id !== 'ov3');
    expect(newPending.length).toBe(0);
  });
});
