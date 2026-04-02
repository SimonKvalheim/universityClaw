import { describe, it, expect } from 'vitest';
import { cleanExtraction } from './extraction-cleaner.js';

describe('cleanExtraction', () => {
  describe('deduplicate adjacent identical blocks', () => {
    it('removes consecutive identical blocks on the same page', () => {
      const input = [
        '<!-- page:1 label:text -->',
        'This paragraph has enough content to exceed the fifty character noise threshold easily.',
        '',
        '<!-- page:1 label:text -->',
        'This paragraph has enough content to exceed the fifty character noise threshold easily.',
        '',
        '<!-- page:1 label:text -->',
        'A different paragraph that also exceeds the fifty character noise threshold for testing.',
      ].join('\n');

      const result = cleanExtraction(input);
      expect(result).toBe(
        [
          '<!-- page:1 label:text -->',
          'This paragraph has enough content to exceed the fifty character noise threshold easily.',
          '',
          '<!-- page:1 label:text -->',
          'A different paragraph that also exceeds the fifty character noise threshold for testing.',
        ].join('\n'),
      );
    });

    it('preserves identical blocks on different pages', () => {
      const input = [
        '<!-- page:1 label:text -->',
        'This paragraph has enough content to exceed the fifty character noise threshold easily.',
        '',
        '<!-- page:2 label:text -->',
        'This paragraph has enough content to exceed the fifty character noise threshold easily.',
      ].join('\n');

      const result = cleanExtraction(input);
      expect(result).toBe(input);
    });

    it('preserves blocks with different content', () => {
      const input = [
        '<!-- page:1 label:text -->',
        'First block has enough content to exceed the fifty character noise threshold easily.',
        '',
        '<!-- page:1 label:text -->',
        'Second block also has enough content to exceed the fifty character noise threshold.',
      ].join('\n');

      const result = cleanExtraction(input);
      expect(result).toBe(input);
    });
  });

  describe('collapse noise blocks', () => {
    it('merges consecutive short text blocks on the same page', () => {
      const input = [
        '<!-- page:1 label:text -->',
        'EEG',
        '',
        '<!-- page:1 label:text -->',
        'Alpha',
        '',
        '<!-- page:1 label:text -->',
        'Band lower',
      ].join('\n');

      const result = cleanExtraction(input);
      expect(result).toBe(
        ['<!-- page:1 label:text -->', 'EEG Alpha Band lower'].join('\n'),
      );
    });

    it('does not merge blocks on different pages', () => {
      const input = [
        '<!-- page:1 label:text -->',
        'EEG',
        '',
        '<!-- page:2 label:text -->',
        'Alpha',
      ].join('\n');

      const result = cleanExtraction(input);
      expect(result).toBe(input);
    });

    it('preserves text blocks over 50 chars', () => {
      const longText =
        'This is a long text block that exceeds fifty characters in total length.';
      const input = [
        '<!-- page:1 label:text -->',
        'Short',
        '',
        '<!-- page:1 label:text -->',
        longText,
      ].join('\n');

      const result = cleanExtraction(input);
      expect(result).toContain(longText);
      expect(result).toContain('Short');
    });

    it('does not merge non-text label blocks', () => {
      const input = [
        '<!-- page:1 label:section_header -->',
        '## Title',
        '',
        '<!-- page:1 label:section_header -->',
        '## Subtitle',
      ].join('\n');

      const result = cleanExtraction(input);
      expect(result).toBe(input);
    });
  });

  describe('passthrough', () => {
    it('returns clean documents unchanged', () => {
      const input = [
        '<!-- page:1 label:section_header -->',
        '## Introduction',
        '',
        '<!-- page:1 label:text -->',
        'This is a paragraph with enough content to be meaningful and well over the fifty character threshold for noise collapsing.',
      ].join('\n');

      const result = cleanExtraction(input);
      expect(result).toBe(input);
    });

    it('handles empty input', () => {
      expect(cleanExtraction('')).toBe('');
    });
  });
});
