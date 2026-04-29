import { describe, expect, it } from 'vitest';
import { slugFromFilename } from './slug.js';

describe('slugFromFilename', () => {
  it('strips extension and kebab-cases', () => {
    expect(slugFromFilename('Foo Bar.pdf')).toBe('foo-bar');
    expect(slugFromFilename('A_Review_of_Cloud_Computing.pdf')).toBe('a-review-of-cloud-computing');
  });

  it('handles multiple dots in filename', () => {
    expect(slugFromFilename('paper.v2.final.pdf')).toBe('paper-v2-final');
  });

  it('handles no extension', () => {
    expect(slugFromFilename('paper')).toBe('paper');
  });

  it('handles existing kebab-case', () => {
    expect(slugFromFilename('already-kebab.pdf')).toBe('already-kebab');
  });

  it('strips trailing/leading hyphens after normalization', () => {
    expect(slugFromFilename('--weird--.pdf')).toBe('weird');
  });
});
