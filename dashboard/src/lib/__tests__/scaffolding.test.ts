import { describe, it, expect } from 'vitest';
import { computeScaffoldingLevel, generateHint } from '../scaffolding';

describe('computeScaffoldingLevel', () => {
  it('returns currentLevel when fewer than 3 data points', () => {
    expect(computeScaffoldingLevel([], 2)).toBe(2);
    expect(computeScaffoldingLevel([5], 1)).toBe(1);
    expect(computeScaffoldingLevel([3, 4], 3)).toBe(3);
  });

  it('decreases level when success rate > 85%', () => {
    // 9/10 successes = 90% > 85% → level decreases
    const qualities = [5, 5, 5, 5, 4, 5, 5, 5, 5, 5];
    expect(computeScaffoldingLevel(qualities, 1)).toBe(0);
    expect(computeScaffoldingLevel(qualities, 3)).toBe(2);
  });

  it('never decreases below 0', () => {
    const qualities = [5, 5, 5, 5, 4, 5, 5, 5, 5, 5];
    expect(computeScaffoldingLevel(qualities, 0)).toBe(0);
  });

  it('increases level when success rate < 70%', () => {
    // 1/10 success (only quality=3) = 10% < 70% → level increases
    const qualities = [1, 2, 1, 2, 3, 1, 2, 1, 2, 1];
    expect(computeScaffoldingLevel(qualities, 1)).toBe(2);
    expect(computeScaffoldingLevel(qualities, 0)).toBe(1);
  });

  it('never increases above 5', () => {
    const qualities = [1, 2, 1, 2, 3, 1, 2, 1, 2, 1];
    expect(computeScaffoldingLevel(qualities, 5)).toBe(5);
  });

  it('maintains level when success rate is between 70% and 85%', () => {
    // 7/10 successes = 70% — on boundary, maintained
    const qualities = [3, 4, 5, 2, 3, 4, 1, 3, 4, 3];
    // 7 out of 10 are >= 3: 3,4,5,3,4,3,4,3 — let's count: 3✓,4✓,5✓,2✗,3✓,4✓,1✗,3✓,4✓,3✓ = 8/10 = 80%
    // That's within 70-85% range, so level stays
    expect(computeScaffoldingLevel(qualities, 2)).toBe(2);
    expect(computeScaffoldingLevel(qualities, 0)).toBe(0);
  });

  it('handles exactly 3 data points', () => {
    // 3/3 successes = 100% > 85%
    expect(computeScaffoldingLevel([3, 4, 5], 2)).toBe(1);
    // 0/3 successes = 0% < 70%
    expect(computeScaffoldingLevel([0, 1, 2], 1)).toBe(2);
  });
});

describe('generateHint', () => {
  it('returns null for level 0', () => {
    expect(generateHint('Some answer text.', 0)).toBeNull();
  });

  it('returns null when referenceAnswer is null', () => {
    expect(generateHint(null, 3)).toBeNull();
  });

  it('returns null when referenceAnswer is empty string', () => {
    expect(generateHint('', 1)).toBeNull();
  });

  it('level 1: returns first sentence as contextual hint', () => {
    const hint = generateHint('First sentence. Second sentence.', 1);
    expect(hint).toBe('Hint: Think about "First sentence..."');
  });

  it('level 2: returns structural summary', () => {
    const hint = generateHint('Point one. Point two. Point three.', 2);
    expect(hint).toBe('Hint: The answer covers 3 key points.');
  });

  it('level 2: uses singular "point" for single sentence', () => {
    const hint = generateHint('Just one point here', 2);
    expect(hint).toBe('Hint: The answer covers 1 key point.');
  });

  it('level 3: returns ~30% of answer', () => {
    const answer = 'A'.repeat(100);
    const hint = generateHint(answer, 3);
    expect(hint).toBe('A'.repeat(30) + '...');
  });

  it('level 4: returns ~60% of answer', () => {
    const answer = 'A'.repeat(100);
    const hint = generateHint(answer, 4);
    expect(hint).toBe('A'.repeat(60) + '...');
  });

  it('level 5: returns full answer', () => {
    const answer = 'The complete and full reference answer.';
    expect(generateHint(answer, 5)).toBe(answer);
  });

  it('level 3 uses minimum cutoff of 20 for very short answers', () => {
    const shortAnswer = 'Short answer text.'; // 18 chars
    const hint = generateHint(shortAnswer, 3);
    // cutoff = max(20, floor(18 * 0.3)) = max(20, 5) = 20
    // but answer is only 18 chars, so slice(0,20) = full answer
    expect(hint).toBe(shortAnswer + '...');
  });
});
