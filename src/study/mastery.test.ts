import { describe, it, expect } from 'vitest';
import {
  computeMastery,
  computeBloomCeiling,
  computeOverallMastery,
  computeFullMastery,
} from './mastery.js';
import type { MasteryActivityInput, MasteryLevels } from './types.js';

// Constants from spec Section 4.2
const MASTERY_THRESHOLD = 10.0;

// Helper: build an ISO string N days before a reference date
function daysAgo(days: number, from = '2026-04-15T12:00:00.000Z'): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

const NOW = '2026-04-15T12:00:00.000Z';

// ─── computeMastery ────────────────────────────────────────────────────────

describe('computeMastery', () => {
  it('returns all zeros when there are no activities', () => {
    const result = computeMastery([], NOW);
    expect(result).toEqual({ L1: 0, L2: 0, L3: 0, L4: 0, L5: 0, L6: 0 });
  });

  it('sums two L1 activities done today (q=5, q=3)', () => {
    const activities: MasteryActivityInput[] = [
      { bloomLevel: 1, quality: 5, reviewedAt: NOW },
      { bloomLevel: 1, quality: 3, reviewedAt: NOW },
    ];
    const result = computeMastery(activities, NOW);
    // (5/5)*0.5^(0/30) + (3/5)*0.5^(0/30) = 1.0 + 0.6 = 1.6
    expect(result.L1).toBeCloseTo(1.6, 5);
    expect(result.L2).toBe(0);
    expect(result.L3).toBe(0);
    expect(result.L4).toBe(0);
    expect(result.L5).toBe(0);
    expect(result.L6).toBe(0);
  });

  it('applies half-life decay for an activity 30 days ago (q=5)', () => {
    const activities: MasteryActivityInput[] = [
      { bloomLevel: 1, quality: 5, reviewedAt: daysAgo(30, NOW) },
    ];
    const result = computeMastery(activities, NOW);
    // (5/5)*0.5^(30/30) = 1.0 * 0.5 = 0.5
    expect(result.L1).toBeCloseTo(0.5, 5);
    expect(result.L2).toBe(0);
  });

  it('places evidence only at the respective Bloom level', () => {
    const activities: MasteryActivityInput[] = [
      { bloomLevel: 3, quality: 5, reviewedAt: NOW },
      { bloomLevel: 5, quality: 4, reviewedAt: NOW },
    ];
    const result = computeMastery(activities, NOW);
    expect(result.L1).toBe(0);
    expect(result.L2).toBe(0);
    expect(result.L3).toBeCloseTo(1.0, 5); // (5/5)*1
    expect(result.L4).toBe(0);
    expect(result.L5).toBeCloseTo(0.8, 5); // (4/5)*1
    expect(result.L6).toBe(0);
  });

  it('uses current date when now is omitted', () => {
    // No activities → always zeros regardless of now
    const result = computeMastery([]);
    expect(result).toEqual({ L1: 0, L2: 0, L3: 0, L4: 0, L5: 0, L6: 0 });
  });
});

// ─── computeBloomCeiling ───────────────────────────────────────────────────

describe('computeBloomCeiling', () => {
  const zero: MasteryLevels = { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0, L6: 0 };

  it('returns 0 when there is no mastery', () => {
    expect(computeBloomCeiling(zero)).toBe(0);
  });

  it('returns 1 when only L1 ≥ 70% of threshold (7.0)', () => {
    const levels: MasteryLevels = { ...zero, L1: 7.0 };
    expect(computeBloomCeiling(levels)).toBe(1);
  });

  it('returns 3 when L1, L2, L3 all have ≥ 70% of threshold', () => {
    const levels: MasteryLevels = { ...zero, L1: 7.0, L2: 8.5, L3: 10.0 };
    expect(computeBloomCeiling(levels)).toBe(3);
  });

  it('returns 6 when all levels are at or above threshold', () => {
    const levels: MasteryLevels = {
      L1: 10.0,
      L2: 10.0,
      L3: 10.0,
      L4: 10.0,
      L5: 10.0,
      L6: 10.0,
    };
    expect(computeBloomCeiling(levels)).toBe(6);
  });

  it('caps at L1 when there is a gap at L2 (L1=8, L2=1, L3=9)', () => {
    const levels: MasteryLevels = { ...zero, L1: 8.0, L2: 1.0, L3: 9.0 };
    expect(computeBloomCeiling(levels)).toBe(1);
  });

  it('returns 0 when L1 is below 70% of threshold even if L2+ are mastered', () => {
    const levels: MasteryLevels = {
      L1: 0.0,
      L2: 10.0,
      L3: 10.0,
      L4: 10.0,
      L5: 10.0,
      L6: 10.0,
    };
    expect(computeBloomCeiling(levels)).toBe(0);
  });

  it('treats exactly 70% as passing (boundary)', () => {
    // 70% of 10.0 = 7.0
    const levels: MasteryLevels = { ...zero, L1: 7.0 };
    expect(computeBloomCeiling(levels)).toBe(1);
  });

  it('treats just below 70% as failing (boundary)', () => {
    // 69.9% of 10.0 = 6.99
    const levels: MasteryLevels = { ...zero, L1: 6.99 };
    expect(computeBloomCeiling(levels)).toBe(0);
  });
});

// ─── computeOverallMastery ────────────────────────────────────────────────

describe('computeOverallMastery', () => {
  const zero: MasteryLevels = { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0, L6: 0 };

  it('returns 0 when there is no evidence', () => {
    expect(computeOverallMastery(zero)).toBe(0);
  });

  it('returns 1.0 when all levels are fully mastered', () => {
    const levels: MasteryLevels = {
      L1: MASTERY_THRESHOLD,
      L2: MASTERY_THRESHOLD,
      L3: MASTERY_THRESHOLD,
      L4: MASTERY_THRESHOLD,
      L5: MASTERY_THRESHOLD,
      L6: MASTERY_THRESHOLD,
    };
    expect(computeOverallMastery(levels)).toBeCloseTo(1.0, 5);
  });

  it('L6-only mastery produces higher overall than L1-only mastery', () => {
    const l6Only: MasteryLevels = { ...zero, L6: MASTERY_THRESHOLD };
    const l1Only: MasteryLevels = { ...zero, L1: MASTERY_THRESHOLD };
    expect(computeOverallMastery(l6Only)).toBeGreaterThan(
      computeOverallMastery(l1Only),
    );
  });

  it('caps per-level contribution at 1.0 even when evidence exceeds threshold', () => {
    // L1 at 2x threshold
    const withExcess: MasteryLevels = { ...zero, L1: MASTERY_THRESHOLD * 2 };
    const atThreshold: MasteryLevels = { ...zero, L1: MASTERY_THRESHOLD };
    expect(computeOverallMastery(withExcess)).toBeCloseTo(
      computeOverallMastery(atThreshold),
      5,
    );
  });

  it('returns a value between 0 and 1 for partial mastery', () => {
    const partial: MasteryLevels = { ...zero, L1: 5.0, L3: 8.0 };
    const result = computeOverallMastery(partial);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });
});

// ─── computeFullMastery (convenience wrapper) ─────────────────────────────

describe('computeFullMastery', () => {
  it('returns a MasteryResult with levels, overall, and bloomCeiling', () => {
    const activities: MasteryActivityInput[] = [
      { bloomLevel: 1, quality: 5, reviewedAt: NOW },
    ];
    const result = computeFullMastery(activities, NOW);
    expect(result).toHaveProperty('levels');
    expect(result).toHaveProperty('overall');
    expect(result).toHaveProperty('bloomCeiling');
    expect(typeof result.overall).toBe('number');
    expect(typeof result.bloomCeiling).toBe('number');
  });

  it('is consistent with calling the three functions individually', () => {
    const activities: MasteryActivityInput[] = [
      { bloomLevel: 2, quality: 4, reviewedAt: daysAgo(10, NOW) },
      { bloomLevel: 3, quality: 5, reviewedAt: NOW },
    ];
    const full = computeFullMastery(activities, NOW);
    const levels = computeMastery(activities, NOW);
    expect(full.levels).toEqual(levels);
    expect(full.bloomCeiling).toBe(computeBloomCeiling(levels));
    expect(full.overall).toBeCloseTo(computeOverallMastery(levels), 10);
  });

  it('handles empty activity list gracefully', () => {
    const result = computeFullMastery([], NOW);
    expect(result.levels).toEqual({ L1: 0, L2: 0, L3: 0, L4: 0, L5: 0, L6: 0 });
    expect(result.overall).toBe(0);
    expect(result.bloomCeiling).toBe(0);
  });
});
