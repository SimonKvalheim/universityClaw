import { describe, it, expect } from 'vitest';
import { pearsonCorrelation } from '../study-db';

// ---------------------------------------------------------------------------
// pearsonCorrelation
// ---------------------------------------------------------------------------

describe('pearsonCorrelation', () => {
  it('returns 1 for perfectly positively correlated data', () => {
    const pts = [
      { confidence: 1, quality: 1 },
      { confidence: 2, quality: 2 },
      { confidence: 3, quality: 3 },
      { confidence: 4, quality: 4 },
      { confidence: 5, quality: 5 },
    ];
    expect(pearsonCorrelation(pts)).toBeCloseTo(1, 5);
  });

  it('returns -1 for perfectly negatively correlated data', () => {
    const pts = [
      { confidence: 1, quality: 5 },
      { confidence: 2, quality: 4 },
      { confidence: 3, quality: 3 },
      { confidence: 4, quality: 2 },
      { confidence: 5, quality: 1 },
    ];
    expect(pearsonCorrelation(pts)).toBeCloseTo(-1, 5);
  });

  it('returns 0 for constant X values (no variance)', () => {
    const pts = [
      { confidence: 3, quality: 1 },
      { confidence: 3, quality: 2 },
      { confidence: 3, quality: 3 },
      { confidence: 3, quality: 4 },
      { confidence: 3, quality: 5 },
    ];
    expect(pearsonCorrelation(pts)).toBe(0);
  });

  it('returns a value in [-1, 1] for real-world-style data', () => {
    const pts = [
      { confidence: 2, quality: 3 },
      { confidence: 4, quality: 4 },
      { confidence: 3, quality: 2 },
      { confidence: 5, quality: 5 },
      { confidence: 1, quality: 1 },
      { confidence: 4, quality: 3 },
    ];
    const r = pearsonCorrelation(pts);
    expect(r).toBeGreaterThanOrEqual(-1);
    expect(r).toBeLessThanOrEqual(1);
    // Positive correlation expected
    expect(r).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Gap-filling logic (time series)
// ---------------------------------------------------------------------------
// We test the gap-filling logic in isolation without hitting the database by
// re-implementing the same deterministic algorithm used in getActivityTimeSeries.

function fillGaps(
  resultMap: Map<string, { count: number; avgQuality: number }>,
  days: number,
): Array<{ date: string; count: number; avgQuality: number }> {
  const msPerDay = 86400000;
  const today = new Date('2026-04-16T00:00:00.000Z');
  const series: Array<{ date: string; count: number; avgQuality: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * msPerDay);
    const dateStr = d.toISOString().slice(0, 10);
    const existing = resultMap.get(dateStr);
    series.push({
      date: dateStr,
      count: existing?.count ?? 0,
      avgQuality: existing?.avgQuality ?? 0,
    });
  }
  return series;
}

describe('getActivityTimeSeries gap-filling', () => {
  it('produces an entry for every day in the window', () => {
    const map = new Map<string, { count: number; avgQuality: number }>();
    map.set('2026-04-14', { count: 3, avgQuality: 4 });
    const result = fillGaps(map, 3);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.date)).toEqual(['2026-04-14', '2026-04-15', '2026-04-16']);
  });

  it('fills days with no data as count=0, avgQuality=0', () => {
    const map = new Map<string, { count: number; avgQuality: number }>();
    map.set('2026-04-16', { count: 5, avgQuality: 3.5 });
    const result = fillGaps(map, 3);
    const emptyDays = result.filter((r) => r.count === 0);
    expect(emptyDays).toHaveLength(2);
    for (const d of emptyDays) {
      expect(d.avgQuality).toBe(0);
    }
  });

  it('preserves existing data for days that have activity', () => {
    const map = new Map<string, { count: number; avgQuality: number }>();
    map.set('2026-04-15', { count: 7, avgQuality: 3.8 });
    const result = fillGaps(map, 3);
    const active = result.find((r) => r.date === '2026-04-15');
    expect(active?.count).toBe(7);
    expect(active?.avgQuality).toBeCloseTo(3.8);
  });

  it('returns a single-day series for days=1', () => {
    const map = new Map<string, { count: number; avgQuality: number }>();
    const result = fillGaps(map, 1);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-04-16');
    expect(result[0].count).toBe(0);
  });
});
