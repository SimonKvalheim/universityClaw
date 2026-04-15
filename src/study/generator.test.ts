import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { _initTestDatabase, _closeDatabase } from '../db/index.js';
import { createConcept, type NewConcept } from './queries.js';
import {
  generateActivities,
  resetGenerationCycle,
  MAX_CONCEPTS_PER_CYCLE,
} from './generator.js';
import type { ContainerOutput } from '../container-runner.js';

// ── Mock container-runner ──────────────────────────────────────────────────────

vi.mock('../container-runner.js', () => ({
  runContainerAgent: vi.fn().mockResolvedValue({
    status: 'success',
    result: null,
  } satisfies ContainerOutput),
}));

// Lazy import so we can inspect the mock after it's wired up
import { runContainerAgent } from '../container-runner.js';
const mockRunContainer = vi.mocked(runContainerAgent);

// ── Mock config to point VAULT_DIR at a temp directory ────────────────────────

let vaultDir: string;

vi.mock('../config.js', () => ({
  get VAULT_DIR() {
    return vaultDir;
  },
  // Provide minimal stubs for other named exports used transitively
  GROUPS_DIR: '/tmp/groups',
  DATA_DIR: '/tmp/data',
  CONTAINER_IMAGE: 'test-image',
  CONTAINER_TIMEOUT: 60000,
  IDLE_TIMEOUT: 30000,
  CONTAINER_MAX_OUTPUT_SIZE: 1000000,
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'UTC',
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = '2026-04-15T12:00:00.000Z';

function makeConcept(overrides: Partial<NewConcept> = {}): NewConcept {
  return {
    id: 'concept-1',
    title: 'Action Research',
    createdAt: NOW,
    status: 'active',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateActivities', () => {
  beforeEach(() => {
    _initTestDatabase();
    resetGenerationCycle();
    mockRunContainer.mockClear();

    vaultDir = join(tmpdir(), `generator-test-vault-${Date.now()}`);
    mkdirSync(join(vaultDir, 'concepts'), { recursive: true });
  });

  afterEach(() => {
    _closeDatabase();
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('prompt includes concept title and vault content', async () => {
    const vaultNotePath = 'concepts/action-research.md';
    const noteContent =
      '# Action Research\n\nIterative cycles of action and reflection.';

    writeFileSync(join(vaultDir, vaultNotePath), noteContent);
    createConcept(makeConcept({ vaultNotePath }));

    await generateActivities('concept-1', 1);

    expect(mockRunContainer).toHaveBeenCalledOnce();
    const [, input] = mockRunContainer.mock.calls[0];
    expect(input.prompt).toContain('Action Research');
    expect(input.prompt).toContain(noteContent);
  });

  it('prompt includes bloom level', async () => {
    createConcept(makeConcept());

    await generateActivities('concept-1', 3);

    const [, input] = mockRunContainer.mock.calls[0];
    expect(input.prompt).toContain('L3');
  });

  it('missing vault note: generation proceeds with title only', async () => {
    // vaultNotePath points at a file that does not exist
    createConcept(makeConcept({ vaultNotePath: 'concepts/ghost.md' }));

    await expect(generateActivities('concept-1', 2)).resolves.toBeUndefined();

    expect(mockRunContainer).toHaveBeenCalledOnce();
    const [, input] = mockRunContainer.mock.calls[0];
    expect(input.prompt).toContain('No vault note available');
  });

  it('throws when concept is not found', async () => {
    await expect(generateActivities('nonexistent-id', 1)).rejects.toThrow(
      'Concept not found',
    );

    expect(mockRunContainer).not.toHaveBeenCalled();
  });

  it('throws when concept status is not active', async () => {
    createConcept(makeConcept({ status: 'archived' }));

    await expect(generateActivities('concept-1', 1)).rejects.toThrow(
      'archived',
    );

    expect(mockRunContainer).not.toHaveBeenCalled();
  });

  it('rate limit: 11th call is skipped, container called exactly 10 times', async () => {
    // Seed 11 distinct active concepts
    for (let i = 1; i <= 11; i++) {
      createConcept(makeConcept({ id: `concept-${i}`, title: `Concept ${i}` }));
    }

    for (let i = 1; i <= 11; i++) {
      await generateActivities(`concept-${i}`, 1);
    }

    expect(mockRunContainer).toHaveBeenCalledTimes(MAX_CONCEPTS_PER_CYCLE);
  });

  it('resetGenerationCycle resets the counter so generation proceeds again', async () => {
    // Exhaust the cycle limit
    for (let i = 1; i <= MAX_CONCEPTS_PER_CYCLE; i++) {
      createConcept(makeConcept({ id: `concept-${i}`, title: `Concept ${i}` }));
      await generateActivities(`concept-${i}`, 1);
    }

    expect(mockRunContainer).toHaveBeenCalledTimes(MAX_CONCEPTS_PER_CYCLE);
    mockRunContainer.mockClear();

    // Reset and try another generation — should proceed
    resetGenerationCycle();
    createConcept(
      makeConcept({ id: 'concept-new', title: 'New Concept After Reset' }),
    );
    await generateActivities('concept-new', 1);

    expect(mockRunContainer).toHaveBeenCalledOnce();
  });
});
