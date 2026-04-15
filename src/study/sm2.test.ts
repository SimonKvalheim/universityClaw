import { describe, it, expect } from 'vitest';
import { sm2, computeDueDate } from './sm2';

describe('sm2', () => {
  // Helper: check EF to 2 decimal places
  const expectEF = (actual: number, expected: number) =>
    expect(Math.round(actual * 100) / 100).toBeCloseTo(expected, 2);

  describe('correct responses (quality >= 3)', () => {
    it('first correct answer (reps=0) → interval=1, reps=1, EF unchanged', () => {
      const result = sm2({ quality: 4, repetitions: 0, easeFactor: 2.5, intervalDays: 0 });
      expect(result.intervalDays).toBe(1);
      expect(result.repetitions).toBe(1);
      expectEF(result.easeFactor, 2.5);
    });

    it('second correct answer (reps=1) → interval=6, reps=2, EF unchanged', () => {
      const result = sm2({ quality: 4, repetitions: 1, easeFactor: 2.5, intervalDays: 1 });
      expect(result.intervalDays).toBe(6);
      expect(result.repetitions).toBe(2);
      expectEF(result.easeFactor, 2.5);
    });

    it('third correct answer (reps=2) → interval=round(6*2.5)=15, reps=3, EF unchanged', () => {
      const result = sm2({ quality: 4, repetitions: 2, easeFactor: 2.5, intervalDays: 6 });
      expect(result.intervalDays).toBe(15);
      expect(result.repetitions).toBe(3);
      expectEF(result.easeFactor, 2.5);
    });
  });

  describe('incorrect responses (quality < 3)', () => {
    it('incorrect answer resets reps to 0 and interval to 1', () => {
      const result = sm2({ quality: 2, repetitions: 5, easeFactor: 2.5, intervalDays: 30 });
      expect(result.intervalDays).toBe(1);
      expect(result.repetitions).toBe(0);
      // EF is still calculated (just may be lower); at least check it's >= 1.3
      expect(result.easeFactor).toBeGreaterThanOrEqual(1.3);
    });
  });

  describe('EF floor enforcement', () => {
    it('EF never drops below 1.3', () => {
      // quality=0, EF=1.3 — formula would push below floor
      const result = sm2({ quality: 0, repetitions: 0, easeFactor: 1.3, intervalDays: 1 });
      expect(result.easeFactor).toBe(1.3);
    });
  });

  describe('quality edge cases', () => {
    it('perfect score (q=5) increases EF', () => {
      const result = sm2({ quality: 5, repetitions: 0, easeFactor: 2.5, intervalDays: 0 });
      expect(result.intervalDays).toBe(1);
      expect(result.repetitions).toBe(1);
      expectEF(result.easeFactor, 2.6);
    });

    it('barely correct (q=3) decreases EF slightly', () => {
      const result = sm2({ quality: 3, repetitions: 0, easeFactor: 2.5, intervalDays: 0 });
      expect(result.intervalDays).toBe(1);
      expect(result.repetitions).toBe(1);
      expectEF(result.easeFactor, 2.36);
    });

    it('blackout (q=0) resets and applies maximum EF penalty', () => {
      const result = sm2({ quality: 0, repetitions: 0, easeFactor: 2.5, intervalDays: 0 });
      expect(result.intervalDays).toBe(1);
      expect(result.repetitions).toBe(0);
      expectEF(result.easeFactor, 1.7);
    });
  });

  describe('all quality values 0-5 produce valid output', () => {
    for (let q = 0; q <= 5; q++) {
      it(`quality=${q} produces interval>=1, reps>=0, EF>=1.3`, () => {
        const result = sm2({ quality: q, repetitions: 0, easeFactor: 2.5, intervalDays: 0 });
        expect(result.intervalDays).toBeGreaterThanOrEqual(1);
        expect(result.repetitions).toBeGreaterThanOrEqual(0);
        expect(result.easeFactor).toBeGreaterThanOrEqual(1.3);
      });
    }
  });
});

describe('computeDueDate', () => {
  it('adds days correctly within the same month', () => {
    const result = computeDueDate(5, '2026-01-10');
    expect(result).toBe('2026-01-15');
  });

  it('handles month boundaries correctly', () => {
    const result = computeDueDate(6, '2026-01-28');
    expect(result).toBe('2026-02-03');
  });

  it('handles year boundaries correctly', () => {
    const result = computeDueDate(3, '2026-12-30');
    expect(result).toBe('2027-01-02');
  });

  it('handles interval of 1 day', () => {
    const result = computeDueDate(1, '2026-04-15');
    expect(result).toBe('2026-04-16');
  });

  it('defaults fromDate to today (YYYY-MM-DD format)', () => {
    const result = computeDueDate(1);
    // Must be a valid date string YYYY-MM-DD
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Must be after today (or equal, but interval=1 → tomorrow)
    const today = new Date().toISOString().slice(0, 10);
    expect(result > today).toBe(true);
  });
});
