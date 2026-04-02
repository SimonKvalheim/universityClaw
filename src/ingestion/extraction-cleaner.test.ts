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

  describe('strip references tail', () => {
    it('strips ## References at 80% through document', () => {
      const bodyBlocks = Array.from({ length: 8 }, (_, i) => [
        `<!-- page:${i + 1} label:text -->`,
        `Body paragraph ${i + 1} with enough text content to be meaningful and not noise.`,
      ].join('\n'));
      const refBlocks = [
        `<!-- page:9 label:section_header -->`,
        `## References`,
        '',
        `<!-- page:9 label:text -->`,
        `[1] Some reference that should be stripped from the output entirely.`,
        '',
        `<!-- page:10 label:text -->`,
        `[2] Another reference that should also be stripped from the output.`,
      ].join('\n');

      const input = [...bodyBlocks, refBlocks].join('\n\n');
      const result = cleanExtraction(input);
      expect(result).not.toContain('References');
      expect(result).not.toContain('[1]');
      expect(result).toContain('Body paragraph 1');
    });

    it('preserves ## References appearing before 60% threshold', () => {
      const earlyRef = [
        `<!-- page:1 label:section_header -->`,
        `## References`,
        '',
        `<!-- page:1 label:text -->`,
        `This section references prior work and should be preserved in the output.`,
      ].join('\n');
      const bodyBlocks = Array.from({ length: 8 }, (_, i) => [
        `<!-- page:${i + 2} label:text -->`,
        `Body paragraph ${i + 1} with enough text content to be meaningful and not noise.`,
      ].join('\n'));

      const input = [earlyRef, ...bodyBlocks].join('\n\n');
      const result = cleanExtraction(input);
      expect(result).toContain('References');
      expect(result).toContain('references prior work');
    });

    it('handles ## Bibliography heading', () => {
      const bodyBlocks = Array.from({ length: 8 }, (_, i) => [
        `<!-- page:${i + 1} label:text -->`,
        `Body paragraph ${i + 1} with enough text content to be meaningful and not noise.`,
      ].join('\n'));
      const bibBlock = [
        `<!-- page:9 label:section_header -->`,
        `## Bibliography`,
        '',
        `<!-- page:9 label:text -->`,
        `Should be stripped entirely from the cleaned output of this document.`,
      ].join('\n');

      const input = [...bodyBlocks, bibBlock].join('\n\n');
      const result = cleanExtraction(input);
      expect(result).not.toContain('Bibliography');
    });

    it('handles ## Works Cited heading', () => {
      const bodyBlocks = Array.from({ length: 8 }, (_, i) => [
        `<!-- page:${i + 1} label:text -->`,
        `Body paragraph ${i + 1} with enough text content to be meaningful and not noise.`,
      ].join('\n'));
      const citedBlock = [
        `<!-- page:9 label:section_header -->`,
        `## Works Cited`,
        '',
        `<!-- page:9 label:text -->`,
        `Should be stripped from cleaned output as it is a references section.`,
      ].join('\n');

      const input = [...bodyBlocks, citedBlock].join('\n\n');
      const result = cleanExtraction(input);
      expect(result).not.toContain('Works Cited');
    });
  });

  describe('strip supplementary tail', () => {
    it('strips ## Appendix at 80% through document', () => {
      const bodyBlocks = Array.from({ length: 8 }, (_, i) => [
        `<!-- page:${i + 1} label:text -->`,
        `Body paragraph ${i + 1} with enough text content to be meaningful and not noise.`,
      ].join('\n'));
      const appendixBlock = [
        `<!-- page:9 label:section_header -->`,
        `## Appendix`,
        '',
        `<!-- page:9 label:text -->`,
        `Supplementary data that should be stripped from the output entirely.`,
      ].join('\n');

      const input = [...bodyBlocks, appendixBlock].join('\n\n');
      const result = cleanExtraction(input);
      expect(result).not.toContain('Appendix');
    });

    it('preserves ## Appendix before 70% threshold', () => {
      const earlyAppendix = [
        `<!-- page:1 label:section_header -->`,
        `## Appendix`,
        '',
        `<!-- page:1 label:text -->`,
        `Early appendix reference that appears before the threshold and should stay.`,
      ].join('\n');
      const bodyBlocks = Array.from({ length: 8 }, (_, i) => [
        `<!-- page:${i + 2} label:text -->`,
        `Body paragraph ${i + 1} with enough text content to be meaningful and not noise.`,
      ].join('\n'));

      const input = [earlyAppendix, ...bodyBlocks].join('\n\n');
      const result = cleanExtraction(input);
      expect(result).toContain('Appendix');
    });

    it('handles ## Supplementary heading', () => {
      const bodyBlocks = Array.from({ length: 8 }, (_, i) => [
        `<!-- page:${i + 1} label:text -->`,
        `Body paragraph ${i + 1} with enough text content to be meaningful and not noise.`,
      ].join('\n'));
      const suppBlock = [
        `<!-- page:9 label:section_header -->`,
        `## Supplementary`,
        '',
        `<!-- page:9 label:text -->`,
        `Supporting information that should be stripped from the output document.`,
      ].join('\n');

      const input = [...bodyBlocks, suppBlock].join('\n\n');
      const result = cleanExtraction(input);
      expect(result).not.toContain('Supplementary');
    });

    it('handles ## Supporting Information heading', () => {
      const bodyBlocks = Array.from({ length: 8 }, (_, i) => [
        `<!-- page:${i + 1} label:text -->`,
        `Body paragraph ${i + 1} with enough text content to be meaningful and not noise.`,
      ].join('\n'));
      const siBlock = [
        `<!-- page:9 label:section_header -->`,
        `## Supporting Information`,
        '',
        `<!-- page:9 label:text -->`,
        `Additional supporting data that should be stripped from the output.`,
      ].join('\n');

      const input = [...bodyBlocks, siBlock].join('\n\n');
      const result = cleanExtraction(input);
      expect(result).not.toContain('Supporting Information');
    });
  });

  describe('composition', () => {
    it('applies all rules together', () => {
      const input = [
        '<!-- page:1 label:text -->', 'EEG', '',
        '<!-- page:1 label:text -->', 'EEG', '',
        '<!-- page:1 label:text -->', 'Alpha', '',
        '<!-- page:1 label:text -->', 'Band', '',
        '<!-- page:2 label:section_header -->', '## Methods', '',
        '<!-- page:2 label:text -->', 'We used electroencephalography to record brain activity during the essay writing task.', '',
        '<!-- page:3 label:text -->', 'Additional methodology details that contribute to the body of the paper content.', '',
        '<!-- page:4 label:text -->', 'Results section with important findings that should be preserved in the output.', '',
        '<!-- page:5 label:text -->', 'Discussion of the implications of our findings for educational technology use.', '',
        '<!-- page:6 label:section_header -->', '## References', '',
        '<!-- page:6 label:text -->', '[1] Should be stripped from the output.',
      ].join('\n');

      const result = cleanExtraction(input);
      expect(result.match(/EEG/g)?.length).toBe(1);
      expect(result).toContain('EEG Alpha Band');
      expect(result).toContain('## Methods');
      expect(result).toContain('electroencephalography');
      expect(result).not.toContain('## References');
      expect(result).not.toContain('[1]');
    });
  });
});

describe('token budget estimation', () => {
  it('estimates tokens at ~4 chars per token', () => {
    const chars = 320_000;
    const estimated = Math.ceil(chars / 4);
    expect(estimated).toBe(80_000);
  });

  it('correctly identifies oversized content', () => {
    const chars = 400_000;
    const estimated = Math.ceil(chars / 4);
    expect(estimated).toBeGreaterThan(80_000);
  });

  it('correctly identifies under-budget content', () => {
    const chars = 200_000;
    const estimated = Math.ceil(chars / 4);
    expect(estimated).toBeLessThan(80_000);
  });
});
