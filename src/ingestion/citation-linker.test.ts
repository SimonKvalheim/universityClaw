import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  extractBibliography,
  parseBibEntry,
  normalizeName,
  buildSourceIndex,
  linkCitations,
  filterDeadReferences,
  BibEntry,
} from './citation-linker.js';
import { parseFrontmatter } from '../vault/frontmatter.js';
import { _initTestDatabase, getCites, deleteCitationEdges } from '../db.js';

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
    const result = parseBibEntry(
      'Sweller, J. (1999). Instructional design in technical areas.',
    );
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
    const result = parseBibEntry(
      'Paas, E G. W. C., & Van Merrienboer, J. J, G. (1994). Measurement of cognitive load.',
    );
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
    const content =
      '# Lecture Slides\n\nSlide 1: Introduction\nSlide 2: Methods';
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

const TMP = join(import.meta.dirname, '../../.test-tmp/citation-linker');
const VAULT = join(TMP, 'vault');
const SOURCES = join(VAULT, 'sources');

describe('buildSourceIndex', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(SOURCES, { recursive: true });
  });

  it('builds index from source note frontmatter', () => {
    writeFileSync(
      join(SOURCES, 'kirschner-2002.md'),
      '---\ntitle: "CLT (Kirschner 2002)"\ntype: source\nauthors:\n  - "Paul A. Kirschner"\npublished: 2002\n---\nContent',
    );

    const index = buildSourceIndex(SOURCES);

    expect(index.get('kirschner:2002')).toEqual([
      { slug: 'kirschner-2002', filePath: join(SOURCES, 'kirschner-2002.md') },
    ]);
  });

  it('extracts last name from full name (final whitespace token)', () => {
    writeFileSync(
      join(SOURCES, 'van-merrienboer-2003.md'),
      '---\ntitle: "Complex Learning"\ntype: source\nauthors:\n  - "Jeroen J.G. Van Merriënboer"\npublished: 2003\n---\nContent',
    );

    const index = buildSourceIndex(SOURCES);
    expect(index.has('merrienboer:2003')).toBe(true);
  });

  it('indexes multiple authors from same source', () => {
    writeFileSync(
      join(SOURCES, 'abdous-2012.md'),
      '---\ntitle: "Podcasting"\ntype: source\nauthors:\n  - "M\'hammed Abdous"\n  - "Betty Rose Facer"\npublished: 2012\n---\nContent',
    );

    const index = buildSourceIndex(SOURCES);

    expect(index.has('abdous:2012')).toBe(true);
    expect(index.has('facer:2012')).toBe(true);
  });

  it('skips source notes without authors or published fields', () => {
    writeFileSync(
      join(SOURCES, 'no-authors.md'),
      '---\ntitle: "No Authors"\ntype: source\n---\nContent',
    );

    const index = buildSourceIndex(SOURCES);
    expect(index.size).toBe(0);
  });
});

describe('linkCitations', () => {
  beforeEach(() => {
    _initTestDatabase();
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(SOURCES, { recursive: true });
  });

  it('writes cites to new source and cited_by to matched source', () => {
    writeFileSync(
      join(SOURCES, 'kirschner-2002.md'),
      '---\ntitle: "CLT"\ntype: source\nauthors:\n  - "Paul A. Kirschner"\npublished: 2002\n---\nContent',
    );

    const newSourcePath = join(SOURCES, 'mayer-2005.md');
    writeFileSync(
      newSourcePath,
      '---\ntitle: "Multimedia"\ntype: source\nauthors:\n  - "Richard E. Mayer"\npublished: 2005\n---\nContent',
    );

    const bibEntries: BibEntry[] = [{ lastName: 'kirschner', year: '2002' }];
    linkCitations(bibEntries, newSourcePath, SOURCES);

    const { data: newFm } = parseFrontmatter(readFileSync(newSourcePath, 'utf-8'));
    expect(newFm.cites).toEqual(['kirschner-2002']);

    const { data: existingFm } = parseFrontmatter(
      readFileSync(join(SOURCES, 'kirschner-2002.md'), 'utf-8'),
    );
    expect(existingFm.cited_by).toEqual(['mayer-2005']);
  });

  it('appends to existing cites/cited_by arrays', () => {
    writeFileSync(
      join(SOURCES, 'kirschner-2002.md'),
      '---\ntitle: "CLT"\ntype: source\nauthors:\n  - "Paul A. Kirschner"\npublished: 2002\ncited_by:\n  - "earlier-paper"\n---\nContent',
    );

    const newSourcePath = join(SOURCES, 'mayer-2005.md');
    writeFileSync(
      newSourcePath,
      '---\ntitle: "Multimedia"\ntype: source\nauthors:\n  - "Richard E. Mayer"\npublished: 2005\ncites:\n  - "other-source"\n---\nContent',
    );

    const bibEntries: BibEntry[] = [{ lastName: 'kirschner', year: '2002' }];
    linkCitations(bibEntries, newSourcePath, SOURCES);

    const { data: newFm } = parseFrontmatter(readFileSync(newSourcePath, 'utf-8'));
    expect(newFm.cites).toEqual(['other-source', 'kirschner-2002']);

    const { data: existingFm } = parseFrontmatter(
      readFileSync(join(SOURCES, 'kirschner-2002.md'), 'utf-8'),
    );
    expect(existingFm.cited_by).toEqual(['earlier-paper', 'mayer-2005']);
  });

  it('does not duplicate existing entries', () => {
    writeFileSync(
      join(SOURCES, 'kirschner-2002.md'),
      '---\ntitle: "CLT"\ntype: source\nauthors:\n  - "Paul A. Kirschner"\npublished: 2002\ncited_by:\n  - "mayer-2005"\n---\nContent',
    );

    const newSourcePath = join(SOURCES, 'mayer-2005.md');
    writeFileSync(
      newSourcePath,
      '---\ntitle: "Multimedia"\ntype: source\ncites:\n  - "kirschner-2002"\n---\nContent',
    );

    const bibEntries: BibEntry[] = [{ lastName: 'kirschner', year: '2002' }];
    linkCitations(bibEntries, newSourcePath, SOURCES);

    const { data: newFm } = parseFrontmatter(readFileSync(newSourcePath, 'utf-8'));
    expect(newFm.cites).toEqual(['kirschner-2002']);

    const { data: existingFm } = parseFrontmatter(
      readFileSync(join(SOURCES, 'kirschner-2002.md'), 'utf-8'),
    );
    expect(existingFm.cited_by).toEqual(['mayer-2005']);
  });

  it('handles no matches gracefully', () => {
    const newSourcePath = join(SOURCES, 'lonely-paper.md');
    writeFileSync(
      newSourcePath,
      '---\ntitle: "Lonely"\ntype: source\n---\nContent',
    );

    const bibEntries: BibEntry[] = [{ lastName: 'nobody', year: '2099' }];
    linkCitations(bibEntries, newSourcePath, SOURCES);

    const { data: fm } = parseFrontmatter(readFileSync(newSourcePath, 'utf-8'));
    expect(fm.cites).toBeUndefined();
  });

  it('re-ingestion: deleteCitationEdges clears old edges before rebuild', () => {
    writeFileSync(
      join(SOURCES, 'kirschner-2002.md'),
      '---\ntitle: "CLT"\ntype: source\nauthors:\n  - "Paul A. Kirschner"\npublished: 2002\n---\nContent',
    );
    writeFileSync(
      join(SOURCES, 'sweller-1999.md'),
      '---\ntitle: "Instructional Design"\ntype: source\nauthors:\n  - "John Sweller"\npublished: 1999\n---\nContent',
    );

    const newSourcePath = join(SOURCES, 'mayer-2005.md');
    writeFileSync(
      newSourcePath,
      '---\ntitle: "Multimedia"\ntype: source\nauthors:\n  - "Richard E. Mayer"\npublished: 2005\n---\nContent',
    );

    // First ingestion: cites kirschner
    linkCitations([{ lastName: 'kirschner', year: '2002' }], newSourcePath, SOURCES);
    expect(getCites('mayer-2005')).toEqual(['kirschner-2002']);

    // Re-ingestion: clear old edges, now cites sweller instead
    deleteCitationEdges('mayer-2005');

    // Rewrite the source file fresh (simulating re-promotion)
    writeFileSync(
      newSourcePath,
      '---\ntitle: "Multimedia"\ntype: source\nauthors:\n  - "Richard E. Mayer"\npublished: 2005\n---\nContent',
    );

    linkCitations([{ lastName: 'sweller', year: '1999' }], newSourcePath, SOURCES);
    expect(getCites('mayer-2005')).toEqual(['sweller-1999']);
  });
});

describe('filterDeadReferences', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(SOURCES, { recursive: true });
  });

  it('filters out slugs that do not have corresponding files', () => {
    writeFileSync(join(SOURCES, 'exists.md'), '---\ntitle: Exists\n---\nContent');
    const result = filterDeadReferences(['exists', 'gone'], SOURCES);
    expect(result).toEqual(['exists']);
  });

  it('returns empty array when all references are dead', () => {
    const result = filterDeadReferences(['gone-a', 'gone-b'], SOURCES);
    expect(result).toEqual([]);
  });

  it('returns all slugs when all exist', () => {
    writeFileSync(join(SOURCES, 'a.md'), 'content');
    writeFileSync(join(SOURCES, 'b.md'), 'content');
    const result = filterDeadReferences(['a', 'b'], SOURCES);
    expect(result).toEqual(['a', 'b']);
  });
});
