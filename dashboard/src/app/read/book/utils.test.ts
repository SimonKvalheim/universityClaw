import { describe, it, expect } from 'vitest';
import { extractCurrentSentence } from './utils';

describe('extractCurrentSentence', () => {
  it('extracts a simple sentence around the given word index', () => {
    const words = ['The', 'cat', 'sat.', 'The', 'dog', 'ran.'];
    expect(extractCurrentSentence(words, 1)).toBe('The cat sat.');
  });

  it('extracts the second sentence when index is in it', () => {
    const words = ['The', 'cat', 'sat.', 'The', 'dog', 'ran.'];
    expect(extractCurrentSentence(words, 4)).toBe('The dog ran.');
  });

  it('handles index at the very start', () => {
    const words = ['Hello', 'world.'];
    expect(extractCurrentSentence(words, 0)).toBe('Hello world.');
  });

  it('handles text with no sentence-ending punctuation', () => {
    const words = ['no', 'punctuation', 'here'];
    expect(extractCurrentSentence(words, 1)).toBe('no punctuation here');
  });

  it('handles index at sentence boundary word', () => {
    const words = ['First.', 'Second.'];
    expect(extractCurrentSentence(words, 0)).toBe('First.');
  });

  it('handles exclamation marks', () => {
    const words = ['Wow!', 'That', 'was', 'great.'];
    expect(extractCurrentSentence(words, 2)).toBe('That was great.');
  });

  it('handles question marks', () => {
    const words = ['Is', 'it?', 'Yes.'];
    expect(extractCurrentSentence(words, 0)).toBe('Is it?');
  });

  it('truncates to 200 chars with ellipsis when sentence is too long', () => {
    const words = Array.from({ length: 50 }, (_, i) => `longword${i.toString().padStart(2, '0')}`);
    words[49] = words[49] + '.';
    const result = extractCurrentSentence(words, 25);
    expect(result.length).toBeLessThanOrEqual(203);
    expect(result.startsWith('...')).toBe(true);
  });

  it('returns empty string for empty words array', () => {
    expect(extractCurrentSentence([], 0)).toBe('');
  });

  it('clamps index to valid range', () => {
    const words = ['Hello', 'world.'];
    expect(extractCurrentSentence(words, 99)).toBe('Hello world.');
  });
});
