import { describe, it, expect } from 'vitest';
import { classifyTier } from './tier-classifier.js';

describe('classifyTier', () => {
  it('returns tier 1 for assignments', () => {
    expect(classifyTier({ type: 'assignment' })).toBe(1);
  });
  it('returns tier 1 for reference documents', () => {
    expect(classifyTier({ type: 'reference' })).toBe(1);
  });
  it('returns tier 2 for lectures', () => {
    expect(classifyTier({ type: 'lecture' })).toBe(2);
  });
  it('returns tier 2 for exam-prep', () => {
    expect(classifyTier({ type: 'exam-prep' })).toBe(2);
  });
  it('returns tier 3 for null type (unknown)', () => {
    expect(classifyTier({ type: null })).toBe(3);
  });
  it('returns tier 3 for research type', () => {
    expect(classifyTier({ type: 'research' })).toBe(3);
  });
  it('respects explicit tier override', () => {
    expect(classifyTier({ type: 'lecture', tierOverride: 3 })).toBe(3);
  });
  it('returns tier 2 as default for known but unmapped types', () => {
    expect(classifyTier({ type: 'lab' })).toBe(2);
  });
});
