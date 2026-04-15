/**
 * Weighted Evidence Mastery Model
 * Implements spec Section 4.2 pseudocode exactly.
 *
 * Constants (non-negotiable per spec):
 *   BLOOM_WEIGHTS     — higher Bloom levels carry more weight
 *   MASTERY_THRESHOLD — raw evidence score that equals "fully mastered"
 *   DECAY_HALF_LIFE_DAYS — time constant for exponential decay
 */

import type {
  BloomLevel,
  MasteryActivityInput,
  MasteryLevels,
  MasteryResult,
} from './types.js';

// ─── Constants ─────────────────────────────────────────────────────────────

export const BLOOM_WEIGHTS: Record<BloomLevel, number> = {
  1: 1.0,
  2: 1.5,
  3: 2.0,
  4: 2.5,
  5: 3.0,
  6: 4.0,
};

export const MASTERY_THRESHOLD = 10.0;
export const DECAY_HALF_LIFE_DAYS = 30;

// ─── Internal helpers ──────────────────────────────────────────────────────

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysSince(reviewedAt: string, now: Date): number {
  const reviewed = new Date(reviewedAt).getTime();
  const elapsed = now.getTime() - reviewed;
  return Math.max(0, elapsed / MS_PER_DAY);
}

function decayFactor(days: number): number {
  return Math.pow(0.5, days / DECAY_HALF_LIFE_DAYS);
}

// ─── Core functions ────────────────────────────────────────────────────────

/**
 * computeMastery — spec Section 4.2, step 1.
 *
 * For each Bloom level accumulates:
 *   evidence += (quality / 5.0) * 0.5^(daysSince / 30)
 */
export function computeMastery(
  activities: MasteryActivityInput[],
  now?: string,
): MasteryLevels {
  const nowDate = now ? new Date(now) : new Date();
  const levels: MasteryLevels = { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0, L6: 0 };

  for (const activity of activities) {
    const days = daysSince(activity.reviewedAt, nowDate);
    const contribution = (activity.quality / 5.0) * decayFactor(days);
    const key = `L${activity.bloomLevel}` as keyof MasteryLevels;
    levels[key] += contribution;
  }

  return levels;
}

/**
 * computeBloomCeiling — spec Section 4.2, step 2.
 *
 * Walks L1 → L6 and stops at the first level where
 *   evidence / MASTERY_THRESHOLD < 0.7
 * Returns the last level that passed (0 if none).
 * Levels must be contiguous — a gap caps the ceiling.
 */
export function computeBloomCeiling(levels: MasteryLevels): number {
  const order: BloomLevel[] = [1, 2, 3, 4, 5, 6];
  let ceiling = 0;

  for (const level of order) {
    const key = `L${level}` as keyof MasteryLevels;
    const evidence = levels[key];
    if (evidence / MASTERY_THRESHOLD < 0.7) {
      break;
    }
    ceiling = level;
  }

  return ceiling;
}

/**
 * computeOverallMastery — spec Section 4.2, step 3.
 *
 * Weighted sum:
 *   Σ min(evidence / threshold, 1.0) * weight[level]  /  Σ weights
 */
export function computeOverallMastery(levels: MasteryLevels): number {
  const order: BloomLevel[] = [1, 2, 3, 4, 5, 6];
  let weightedSum = 0;
  let totalWeight = 0;

  for (const level of order) {
    const key = `L${level}` as keyof MasteryLevels;
    const evidence = levels[key];
    const weight = BLOOM_WEIGHTS[level];
    const capped = Math.min(evidence / MASTERY_THRESHOLD, 1.0);
    weightedSum += capped * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
}

/**
 * computeFullMastery — convenience wrapper.
 *
 * Calls all three functions and returns a composite MasteryResult.
 */
export function computeFullMastery(
  activities: MasteryActivityInput[],
  now?: string,
): MasteryResult {
  const levels = computeMastery(activities, now);
  return {
    levels,
    bloomCeiling: computeBloomCeiling(levels),
    overall: computeOverallMastery(levels),
  };
}
