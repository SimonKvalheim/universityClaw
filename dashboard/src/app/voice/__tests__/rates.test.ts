import { describe, it, expect } from 'vitest';
import { computeCostUsd, RATES } from '../rates';

describe('rates', () => {
  it('computes zero cost for zero tokens', () => {
    expect(computeCostUsd({ textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 }, RATES)).toBe(0);
  });

  it('computes cost as the sum of per-modality rates (per million tokens)', () => {
    const rates = { textInPerM: 1, textOutPerM: 2, audioInPerM: 4, audioOutPerM: 8, asOf: '2026-04-18', version: 'test' };
    const usage = { textIn: 500_000, textOut: 1_000_000, audioIn: 2_000_000, audioOut: 500_000 };
    // 0.5 * 1 + 1 * 2 + 2 * 4 + 0.5 * 8 = 0.5 + 2 + 8 + 4 = 14.5
    expect(computeCostUsd(usage, rates)).toBeCloseTo(14.5, 6);
  });

  it('exposes a rates version string for persistence', () => {
    expect(RATES.version).toMatch(/^[a-z0-9-]+$/);
    expect(RATES.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
