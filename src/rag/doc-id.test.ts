import { describe, it, expect } from 'vitest';
import { computeDocId, pythonStrip } from './doc-id.js';
import { createHash } from 'crypto';

describe('pythonStrip', () => {
  it('strips ASCII whitespace from both ends', () => {
    expect(pythonStrip('  hello  ')).toBe('hello');
    expect(pythonStrip('\t\n\r\f\vhello\v\f\r\n\t')).toBe('hello');
  });

  it('does NOT strip non-breaking space (U+00A0)', () => {
    // Python str.strip() does not strip U+00A0
    // JS .trim() DOES strip U+00A0 — this is the critical difference
    expect(pythonStrip('\u00A0hello\u00A0')).toBe('\u00A0hello\u00A0');
  });

  it('does NOT strip other Unicode whitespace', () => {
    // U+2003 em space, U+3000 ideographic space
    expect(pythonStrip('\u2003hello\u3000')).toBe('\u2003hello\u3000');
  });

  it('handles empty string', () => {
    expect(pythonStrip('')).toBe('');
  });

  it('handles whitespace-only string', () => {
    expect(pythonStrip('  \t\n  ')).toBe('');
  });
});

describe('computeDocId', () => {
  it('returns hash and doc-prefixed ID', () => {
    const { hash, docId } = computeDocId('hello world');
    const expected = createHash('md5').update('hello world').digest('hex');
    expect(hash).toBe(expected);
    expect(docId).toBe(`doc-${expected}`);
  });

  it('strips ASCII whitespace before hashing', () => {
    const clean = computeDocId('hello');
    const padded = computeDocId('  hello  ');
    expect(clean.hash).toBe(padded.hash);
  });

  it('preserves non-breaking spaces in hash (matches Python)', () => {
    const withNbsp = computeDocId('\u00A0hello\u00A0');
    const without = computeDocId('hello');
    // These should differ because Python's strip() keeps U+00A0
    expect(withNbsp.hash).not.toBe(without.hash);
  });

  it('produces consistent results', () => {
    const a = computeDocId('test content');
    const b = computeDocId('test content');
    expect(a.hash).toBe(b.hash);
    expect(a.docId).toBe(b.docId);
  });
});
