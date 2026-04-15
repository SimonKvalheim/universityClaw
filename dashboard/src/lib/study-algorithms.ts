/**
 * Pure algorithm functions ported verbatim from the backend.
 * Source: src/study/sm2.ts and src/study/mastery.ts
 *
 * No DB access. No side effects. Safe to import in both server and client code.
 */

// ---------------------------------------------------------------------------
// SM-2 Spaced Repetition Algorithm
// ---------------------------------------------------------------------------

export interface SM2Input {
  quality: number;
  repetitions: number;
  easeFactor: number;
  intervalDays: number;
}

export interface SM2Result {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
}

export function sm2(input: SM2Input): SM2Result {
  const { quality, repetitions, easeFactor, intervalDays } = input;
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const newEaseFactor = Math.max(easeFactor + delta, 1.3);
  let newRepetitions: number;
  let newIntervalDays: number;
  if (quality >= 3) {
    if (repetitions === 0) { newIntervalDays = 1; }
    else if (repetitions === 1) { newIntervalDays = 6; }
    else { newIntervalDays = Math.round(intervalDays * newEaseFactor); }
    newRepetitions = repetitions + 1;
  } else {
    newRepetitions = 0;
    newIntervalDays = 1;
  }
  return { easeFactor: newEaseFactor, intervalDays: newIntervalDays, repetitions: newRepetitions };
}

export function computeDueDate(intervalDays: number, fromDate?: string): string {
  const base = fromDate ? new Date(`${fromDate}T00:00:00`) : new Date();
  if (!fromDate) { base.setHours(0, 0, 0, 0); }
  base.setDate(base.getDate() + intervalDays);
  const year = base.getFullYear();
  const month = String(base.getMonth() + 1).padStart(2, '0');
  const day = String(base.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Weighted Evidence Mastery Model
// ---------------------------------------------------------------------------

export type BloomLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface MasteryActivityInput {
  bloomLevel: BloomLevel;
  quality: number;
  reviewedAt: string;
}

export interface MasteryLevels {
  L1: number; L2: number; L3: number; L4: number; L5: number; L6: number;
}

export const BLOOM_WEIGHTS: Record<BloomLevel, number> = { 1: 1.0, 2: 1.5, 3: 2.0, 4: 2.5, 5: 3.0, 6: 4.0 };
export const MASTERY_THRESHOLD = 10.0;
export const DECAY_HALF_LIFE_DAYS = 30;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysSince(reviewedAt: string, now: Date): number {
  const reviewed = new Date(reviewedAt).getTime();
  const elapsed = now.getTime() - reviewed;
  return Math.max(0, elapsed / MS_PER_DAY);
}

function decayFactor(days: number): number {
  return Math.pow(0.5, days / DECAY_HALF_LIFE_DAYS);
}

export function computeMastery(activities: MasteryActivityInput[], now?: string): MasteryLevels {
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

export function computeBloomCeiling(levels: MasteryLevels): number {
  const order: BloomLevel[] = [1, 2, 3, 4, 5, 6];
  let ceiling = 0;
  for (const level of order) {
    const key = `L${level}` as keyof MasteryLevels;
    if (levels[key] / MASTERY_THRESHOLD < 0.7) break;
    ceiling = level;
  }
  return ceiling;
}

export function computeOverallMastery(levels: MasteryLevels): number {
  const order: BloomLevel[] = [1, 2, 3, 4, 5, 6];
  let weightedSum = 0;
  let totalWeight = 0;
  for (const level of order) {
    const key = `L${level}` as keyof MasteryLevels;
    const weight = BLOOM_WEIGHTS[level];
    weightedSum += Math.min(levels[key] / MASTERY_THRESHOLD, 1.0) * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : weightedSum / totalWeight;
}
