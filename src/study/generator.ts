import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';

import { VAULT_DIR } from '../config.js';
import { runContainerAgent } from '../container-runner.js';
import type { ContainerInput } from '../container-runner.js';
import type { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import { getConceptById } from './queries.js';
import type { BloomLevel } from './types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_CONCEPTS_PER_CYCLE = 10;

/** Activity count per bloom level band */
const ACTIVITY_COUNT: Record<number, number> = {
  1: 5,
  2: 5,
  3: 3,
  4: 3,
  5: 2,
  6: 2,
};

// ── Module state ──────────────────────────────────────────────────────────────

let conceptsGeneratedThisCycle = 0;

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Reset the per-cycle generation counter (call at the start of each study cycle).
 */
export function resetGenerationCycle(): void {
  conceptsGeneratedThisCycle = 0;
}

/**
 * Orchestrate activity generation for a concept at a given Bloom level.
 * Reads vault content, builds a generation prompt, and fires a container agent.
 * Does NOT parse or insert activities — the IPC handler handles that.
 */
export async function generateActivities(
  conceptId: string,
  bloomLevel: BloomLevel,
): Promise<void> {
  // 1. Rate-limit check
  if (conceptsGeneratedThisCycle >= MAX_CONCEPTS_PER_CYCLE) {
    logger.info(
      { conceptId, bloomLevel, conceptsGeneratedThisCycle },
      'Generation cycle limit reached — skipping',
    );
    return;
  }

  // 2. Load concept
  const concept = getConceptById(conceptId);
  if (!concept) {
    throw new Error(`Concept not found: ${conceptId}`);
  }
  if (concept.status !== 'active') {
    throw new Error(
      `Cannot generate activities for concept with status "${concept.status}": ${conceptId}`,
    );
  }

  // 3. Read vault note content
  let vaultContent: string;
  if (concept.vaultNotePath) {
    const fullPath = path.join(VAULT_DIR, concept.vaultNotePath);
    if (fs.existsSync(fullPath)) {
      vaultContent = fs.readFileSync(fullPath, 'utf-8');
    } else {
      logger.warn(
        { conceptId, vaultNotePath: concept.vaultNotePath },
        'Vault note not found — proceeding with title-only generation',
      );
      vaultContent = 'No vault note available — generate from title only';
    }
  } else {
    vaultContent = 'No vault note available — generate from title only';
  }

  // 4. Build generation prompt
  const activityCount = ACTIVITY_COUNT[bloomLevel] ?? 3;
  const prompt = buildGenerationPrompt({
    conceptId,
    title: concept.title,
    vaultContent,
    bloomLevel,
    activityCount,
    vaultNotePath: concept.vaultNotePath ?? null,
  });

  // 5. Construct the generator group descriptor
  const generatorGroup: RegisteredGroup = {
    name: 'Study Generator',
    folder: 'study-generator',
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
  };

  // 6. Construct container input
  const input: ContainerInput = {
    prompt,
    groupFolder: 'study-generator',
    singleTurn: true,
    chatJid: 'internal:study-generator',
    isMain: false,
    ipcNamespace: 'study-generator',
  };

  // 7. Fire and forget — IPC handler processes the output asynchronously
  const onProcess = (_proc: ChildProcess, containerName: string): void => {
    logger.info(
      { conceptId, bloomLevel, containerName },
      'Generator container spawned',
    );
  };

  runContainerAgent(generatorGroup, input, onProcess).catch((err) => {
    logger.error(
      { conceptId, bloomLevel, err },
      'Generator container dispatch failed',
    );
  });

  // 8. Increment cycle counter
  conceptsGeneratedThisCycle++;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface PromptParams {
  conceptId: string;
  title: string;
  vaultContent: string;
  bloomLevel: BloomLevel;
  activityCount: number;
  vaultNotePath: string | null;
}

function buildGenerationPrompt(params: PromptParams): string {
  const {
    conceptId,
    title,
    vaultContent,
    bloomLevel,
    activityCount,
    vaultNotePath,
  } = params;
  return [
    `## Activity Generation Request`,
    ``,
    `**Concept ID:** ${conceptId}`,
    `**Concept Title:** ${title}`,
    `**Target Bloom Level:** L${bloomLevel}`,
    `**Recommended Activity Count:** ${activityCount}`,
    `**Source Note Path:** ${vaultNotePath ?? 'none'}`,
    ``,
    `## Vault Note Content`,
    ``,
    vaultContent,
  ].join('\n');
}
