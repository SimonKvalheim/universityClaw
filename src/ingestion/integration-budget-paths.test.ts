import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _initTestDatabase,
  createIngestionJob,
  getJobsByStatus,
  updateIngestionJob,
} from '../db.js';
import { IngestionPipeline } from './index.js';
import type { JobRow } from './pipeline.js';
import type { RegisteredGroup } from '../types.js';

const stubGroup: RegisteredGroup = {
  name: 'test',
  folder: 'test',
  trigger: 'test',
  added_at: new Date().toISOString(),
};

const SMALL_CONTENT = 'small body content';
// ~800K chars ≈ 200K estimated tokens, well above the 80K budget
const OVERSIZED_CONTENT = 'x'.repeat(800_000);

describe('end-to-end pipeline (under + over budget)', () => {
  let tmp: string;
  let vaultDir: string;
  let uploadDir: string;
  let extractionSmall: string;
  let extractionHuge: string;

  beforeEach(() => {
    _initTestDatabase();
    tmp = mkdtempSync(join(tmpdir(), 'e2e-budget-paths-'));
    vaultDir = join(tmp, 'vault');
    uploadDir = join(tmp, 'upload');
    extractionSmall = join(tmp, 'extraction', 'small');
    extractionHuge = join(tmp, 'extraction', 'huge');
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(uploadDir, { recursive: true });
    mkdirSync(extractionSmall, { recursive: true });
    mkdirSync(extractionHuge, { recursive: true });
    writeFileSync(
      join(extractionSmall, 'content.clean.md'),
      SMALL_CONTENT,
      'utf-8',
    );
    writeFileSync(
      join(extractionHuge, 'content.clean.md'),
      OVERSIZED_CONTENT,
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('produces library files for both paths; over-budget writes stub draft, not oversized status', async () => {
    // Seed two extracted jobs — one small (under budget), one huge (over budget)
    createIngestionJob('small', join(uploadDir, 'small.pdf'), 'small.pdf');
    updateIngestionJob('small', {
      status: 'extracted',
      extraction_path: extractionSmall,
    });
    createIngestionJob('huge', join(uploadDir, 'huge.pdf'), 'huge.pdf');
    updateIngestionJob('huge', {
      status: 'extracted',
      extraction_path: extractionHuge,
    });

    const service = new IngestionPipeline({
      vaultDir,
      uploadDir,
      reviewAgentGroup: stubGroup,
    });

    // Replace agentProcessor so the under-budget path does not spawn a real container.
    // The over-budget path returns before reaching agentProcessor at all.
    const agentProcessSpy = vi.fn().mockResolvedValue({ status: 'success' });
    (service as unknown as { agentProcessor: unknown }).agentProcessor = {
      process: agentProcessSpy,
    };

    // Accumulate every status observed for both jobs so we can assert 'oversized' never appears
    const statusLog: { jobId: string; status: string }[] = [];

    function snapshotStatuses(): void {
      const allStatuses = [
        'extracted',
        'librarying',
        'libraried',
        'generating',
        'generated',
        'completed',
        'oversized',
        'failed',
      ] as const;
      for (const id of ['small', 'huge']) {
        for (const st of allStatuses) {
          const jobs = getJobsByStatus(st) as Array<{
            id: string;
            status: string;
          }>;
          const found = jobs.find((j) => j.id === id);
          if (found) {
            statusLog.push({ jobId: id, status: st });
          }
        }
      }
    }

    // ── Step 1: librarying ──────────────────────────────────────────────────
    snapshotStatuses();

    const smallJob = (getJobsByStatus('extracted') as JobRow[]).find(
      (j) => j.id === 'small',
    )!;
    const hugeJob = (getJobsByStatus('extracted') as JobRow[]).find(
      (j) => j.id === 'huge',
    )!;

    await service.handleLibrarying(smallJob);
    // Mimic what the drainer does after onLibrary resolves
    updateIngestionJob('small', { status: 'libraried' });

    await service.handleLibrarying(hugeJob);
    updateIngestionJob('huge', { status: 'libraried' });

    // Both library files must exist
    expect(existsSync(join(vaultDir, 'library', 'small.md'))).toBe(true);
    expect(existsSync(join(vaultDir, 'library', 'huge.md'))).toBe(true);

    // Library file for the under-budget job has correct frontmatter and body
    const smallLib = readFileSync(
      join(vaultDir, 'library', 'small.md'),
      'utf-8',
    );
    expect(smallLib).toMatch(/^type:\s*library\s*$/m);
    expect(smallLib).toContain(SMALL_CONTENT);

    // Library file for the over-budget job has correct frontmatter and large body
    const hugeLib = readFileSync(join(vaultDir, 'library', 'huge.md'), 'utf-8');
    expect(hugeLib).toMatch(/^type:\s*library\s*$/m);
    expect(hugeLib.length).toBeGreaterThan(800_000);

    // ── Step 2: generation (over-budget path only) ──────────────────────────
    // We drive only the over-budget job through handleGeneration.
    // The under-budget job would invoke a real container agent, which we cannot run here.
    // Instead we verify that for under-budget, the budget gate passes (agent IS invoked
    // via the spy), by running handleGeneration on it too — the spy makes it safe.
    snapshotStatuses();

    const smallJobAfterLib = (getJobsByStatus('libraried') as JobRow[]).find(
      (j) => j.id === 'small',
    )!;
    const hugeJobAfterLib = (getJobsByStatus('libraried') as JobRow[]).find(
      (j) => j.id === 'huge',
    )!;

    // Run over-budget first — agent must NOT be invoked
    await service.handleGeneration(hugeJobAfterLib);

    expect(agentProcessSpy).not.toHaveBeenCalled();

    // Stub draft must exist at drafts/{jobId}-source.md
    const draftsDir = join(vaultDir, 'drafts');
    const stubDraftPath = join(draftsDir, `${hugeJobAfterLib.id}-source.md`);
    expect(existsSync(stubDraftPath)).toBe(true);

    const stubContent = readFileSync(stubDraftPath, 'utf-8');
    expect(stubContent).toContain('auto_generated: true');
    expect(stubContent).toContain('library:');

    // Over-budget job must be in 'generated' status
    const hugeGenerated = (
      getJobsByStatus('generated') as Array<{ id: string }>
    ).find((j) => j.id === 'huge');
    expect(hugeGenerated).toBeDefined();

    // Run under-budget — budget gate passes, so agent IS invoked via the spy.
    // The spy returns { status: 'success' } and the validation/sentinel loop
    // will time out; we catch that gracefully by having the spy resolve and
    // checking the spy was called at least once.
    // NOTE: because validationLoop waits on a sentinel file that will never appear,
    // we need to let the abort controller short-circuit. The container promise resolves
    // immediately (spy), which aborts the validation loop, so handleGeneration returns.
    await service.handleGeneration(smallJobAfterLib);

    expect(agentProcessSpy).toHaveBeenCalledOnce();

    // ── Step 3: status invariant ────────────────────────────────────────────
    snapshotStatuses();

    const oversizedSeen = statusLog.some(
      (entry) => entry.status === 'oversized',
    );
    expect(oversizedSeen).toBe(false);

    agentProcessSpy.mockRestore();
  });
});
