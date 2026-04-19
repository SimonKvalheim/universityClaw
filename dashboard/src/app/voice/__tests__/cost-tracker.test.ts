import { describe, it, expect } from 'vitest';
import { CostTracker } from '../cost-tracker';
import { RATES } from '../rates';

describe('CostTracker', () => {
  it('starts at zero', () => {
    const t = new CostTracker(RATES);
    expect(t.totals).toEqual({ textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 });
    expect(t.costUsd).toBe(0);
  });

  it('accumulates token counts across turns', () => {
    const t = new CostTracker(RATES);
    t.addUsage({ textIn: 10, textOut: 20, audioIn: 100, audioOut: 200 });
    t.addUsage({ textIn: 5, textOut: 0, audioIn: 0, audioOut: 50 });
    expect(t.totals).toEqual({ textIn: 15, textOut: 20, audioIn: 100, audioOut: 250 });
  });

  it('exposes a live cost figure', () => {
    const rates = { textInPerM: 1_000_000, textOutPerM: 0, audioInPerM: 0, audioOutPerM: 0, asOf: 'x', version: 'x' };
    const t = new CostTracker(rates);
    t.addUsage({ textIn: 1, textOut: 0, audioIn: 0, audioOut: 0 });
    expect(t.costUsd).toBeCloseTo(1, 6);
  });

  it('emits change events on addUsage', () => {
    const t = new CostTracker(RATES);
    const seen: number[] = [];
    t.onChange((c) => seen.push(c));
    t.addUsage({ textIn: 100, textOut: 0, audioIn: 0, audioOut: 0 });
    t.addUsage({ textIn: 0, textOut: 50, audioIn: 0, audioOut: 0 });
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeGreaterThanOrEqual(0);
    expect(seen[1]).toBeGreaterThan(seen[0]);
  });

  it('stops emitting when listener is removed', () => {
    const t = new CostTracker(RATES);
    const seen: number[] = [];
    const cb = (c: number) => seen.push(c);
    t.onChange(cb);
    t.addUsage({ textIn: 100, textOut: 0, audioIn: 0, audioOut: 0 });
    t.offChange(cb);
    t.addUsage({ textIn: 100, textOut: 0, audioIn: 0, audioOut: 0 });
    expect(seen.length).toBe(1);
  });

  it('resets totals and cost', () => {
    const t = new CostTracker(RATES);
    t.addUsage({ textIn: 100, textOut: 200, audioIn: 300, audioOut: 400 });
    t.reset();
    expect(t.totals).toEqual({ textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 });
    expect(t.costUsd).toBe(0);
  });

  it('fires onChange on reset', () => {
    const t = new CostTracker(RATES);
    t.addUsage({ textIn: 1000, textOut: 0, audioIn: 0, audioOut: 0 });
    const seen: number[] = [];
    t.onChange((c) => seen.push(c));
    t.reset();
    expect(seen).toEqual([0]);
  });

  it('treats addUsage with all zeros as a no-op for totals but still emits', () => {
    const t = new CostTracker(RATES);
    const seen: number[] = [];
    t.onChange((c) => seen.push(c));
    t.addUsage({ textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 });
    // The contract: emit on every addUsage call, even zeros. This keeps the
    // UI in sync whenever the server pings us with a usage turn.
    expect(seen.length).toBe(1);
    expect(t.totals).toEqual({ textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 });
  });
});
