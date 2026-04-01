import { describe, it, expect } from 'vitest';
import {
  extractBibliography,
  parseBibEntry,
  normalizeName,
} from './citation-linker.js';

describe('normalizeName', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeName('Müller')).toBe('muller');
    expect(normalizeName('Van Merriënboer')).toBe('van merrienboer');
  });

  it('collapses whitespace', () => {
    expect(normalizeName('De  la   Cruz')).toBe('de la cruz');
  });

  it('handles plain ascii', () => {
    expect(normalizeName('Kirschner')).toBe('kirschner');
  });
});

describe('parseBibEntry', () => {
  it('parses single-author APA entry', () => {
    const result = parseBibEntry('Sweller, J. (1999). Instructional design in technical areas.');
    expect(result).toEqual({ lastName: 'sweller', year: '1999' });
  });

  it('parses multi-author APA entry', () => {
    const result = parseBibEntry(
      'Plass, J. L., Chun, D. M., Mayer, R. E., & Leutner, D. (1998). Supporting visual preferences.',
    );
    expect(result).toEqual({ lastName: 'plass', year: '1998' });
  });

  it('parses entry with diacritics', () => {
    const result = parseBibEntry(
      'Mousavi, S., Low, R., & Sweller, J. (1995). Reducing cognitive load.',
    );
    expect(result).toEqual({ lastName: 'mousavi', year: '1995' });
  });

  it('returns null for non-APA text', () => {
    expect(parseBibEntry('This is just a sentence.')).toBeNull();
    expect(parseBibEntry('1. First item in a list')).toBeNull();
  });

  it('handles OCR artifacts in author names', () => {
    const result = parseBibEntry('Paas, E G. W. C., & Van Merrienboer, J. J, G. (1994). Measurement of cognitive load.');
    expect(result).toEqual({ lastName: 'paas', year: '1994' });
  });
});

describe('extractBibliography', () => {
  it('detects bibliography cluster at end of document', () => {
    const content = `
Some body text here.

<!-- page:50 label:section_header -->
## References

<!-- page:50 label:list_item -->
Sweller, J. (1999). Instructional design in technical areas.

<!-- page:50 label:list_item -->
Mayer, R. E. (2002). Multimedia learning. Cambridge University Press.

<!-- page:51 label:list_item -->
Kirschner, P. A. (2002). Cognitive load theory. Learning and Instruction, 12, 1-10.
`;

    const entries = extractBibliography(content);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ lastName: 'sweller', year: '1999' });
    expect(entries[1]).toEqual({ lastName: 'mayer', year: '2002' });
    expect(entries[2]).toEqual({ lastName: 'kirschner', year: '2002' });
  });

  it('ignores scattered list_item entries in body text', () => {
    const content = `
<!-- page:5 label:list_item -->
First bullet point about methods.

<!-- page:5 label:list_item -->
Second bullet point about results.

Some text in between that breaks the cluster.

<!-- page:20 label:list_item -->
Another unrelated bullet point.
`;

    const entries = extractBibliography(content);

    expect(entries).toEqual([]);
  });

  it('returns empty array when no bibliography found', () => {
    const content = '# Lecture Slides\n\nSlide 1: Introduction\nSlide 2: Methods';
    const entries = extractBibliography(content);
    expect(entries).toEqual([]);
  });

  it('handles real Docling output format', () => {
    const content = `
Body of the paper.

<!-- page:53 label:list_item -->
Moreno, R., & Mayer, R. E. (1999a). Multimedia-supported metaphors for meaning making in mathematics. Cognition and Instruction, 17, 215-248.

<!-- page:53 label:list_item -->
Moreno, R., & Mayer, R. E. (1999b). Cognitive principles of multimedia learning: The role of modality and contiguity. Journal of Educational Psychology, 91, 358-368.

<!-- page:54 label:list_item -->
Sweller, J., Chandler, P., Tierney, P., & Cooper, M. (1990). Cognitive load and selective attention. Journal of Experimental Psychology: General, 119, 176-192.

<!-- page:54 label:list_item -->
Piaget, J. (1954). The construction of reality in the child. New York: Basic Books.
`;

    const entries = extractBibliography(content);

    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ lastName: 'moreno', year: '1999' });
    expect(entries[1]).toEqual({ lastName: 'moreno', year: '1999' });
    expect(entries[2]).toEqual({ lastName: 'sweller', year: '1990' });
    expect(entries[3]).toEqual({ lastName: 'piaget', year: '1954' });
  });
});
