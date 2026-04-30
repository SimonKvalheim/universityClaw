import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RagIndexer } from './indexer.js';
import { readFileSync } from 'fs';
import { computeDocId } from './doc-id.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, readFileSync: vi.fn() };
});
vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn(),
  })),
}));

const mockReadFile = vi.mocked(readFileSync);

// Mock DB helpers
const mockGetTrackedDoc = vi.fn();
const mockUpsertTrackedDoc = vi.fn();
const mockDeleteTrackedDoc = vi.fn();
vi.mock('../db.js', () => ({
  getTrackedDoc: (...args: unknown[]) => mockGetTrackedDoc(...args),
  upsertTrackedDoc: (...args: unknown[]) => mockUpsertTrackedDoc(...args),
  deleteTrackedDoc: (...args: unknown[]) => mockDeleteTrackedDoc(...args),
}));

const CONCEPT_NOTE = `---
title: Self-Attention
type: concept
topics: [deep-learning, transformers]
source_doc: "Vaswani et al. 2017"
verification_status: unverified
---

Content here.`;

describe('RagIndexer', () => {
  let indexer: RagIndexer;
  let mockRagClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRagClient = {
      index: vi.fn().mockResolvedValue(undefined),
      deleteDocument: vi.fn().mockResolvedValue(undefined),
      entityExists: vi.fn().mockResolvedValue(false),
      createRelation: vi.fn().mockResolvedValue(undefined),
    };
    mockGetTrackedDoc.mockReturnValue(null);
    indexer = new RagIndexer('/vault', mockRagClient);
  });

  // --- Allowlist tests (preserved from original) ---

  it('indexes files in concepts/', async () => {
    mockReadFile.mockReturnValue(CONCEPT_NOTE);

    await indexer.indexFile('/vault/concepts/self-attention.md');

    expect(mockRagClient.index).toHaveBeenCalledOnce();
    const indexed = mockRagClient.index.mock.calls[0][0] as string;
    expect(indexed).toContain(
      '[Title: Self-Attention | Type: concept | Topics: deep-learning, transformers | Source: Vaswani et al. 2017 | Verification: unverified]',
    );
    expect(indexed).toContain('Source path: concepts/self-attention.md');
  });

  it('skips files in _nav/', async () => {
    await indexer.indexFile('/vault/_nav/index.md');
    expect(mockRagClient.index).not.toHaveBeenCalled();
  });

  it('skips files in drafts/', async () => {
    await indexer.indexFile('/vault/drafts/abc.md');
    expect(mockRagClient.index).not.toHaveBeenCalled();
  });

  it('indexes files in profile/archive/', async () => {
    mockReadFile.mockReturnValue(`---
title: Study Log January
type: profile
---

Archived content.`);

    await indexer.indexFile('/vault/profile/archive/study-log-2026-01.md');
    expect(mockRagClient.index).toHaveBeenCalledOnce();
  });

  it('skips profile files outside archive/', async () => {
    await indexer.indexFile('/vault/profile/student-profile.md');
    expect(mockRagClient.index).not.toHaveBeenCalled();
  });

  it('indexes files in library/', async () => {
    mockReadFile.mockReturnValue(`---
title: Foo
type: library
---

body`);

    await indexer.indexFile('/vault/library/foo.md');

    expect(mockRagClient.index).toHaveBeenCalledOnce();
    const indexed = mockRagClient.index.mock.calls[0][0] as string;
    expect(indexed).toContain('Source path: library/foo.md');
  });

  // --- Hash tracking tests ---

  it('skips indexing when content hash matches tracker', async () => {
    mockReadFile.mockReturnValue(CONCEPT_NOTE);

    // Simulate: build the indexed text to get its hash
    await indexer.indexFile('/vault/concepts/self-attention.md');
    const indexedText = mockRagClient.index.mock.calls[0][0] as string;
    const { hash, docId } = computeDocId(indexedText);

    // Reset and set up tracker to return matching hash
    vi.clearAllMocks();
    mockReadFile.mockReturnValue(CONCEPT_NOTE);
    mockGetTrackedDoc.mockReturnValue({
      vault_path: 'concepts/self-attention.md',
      doc_id: docId,
      content_hash: hash,
      indexed_at: '2026-01-01T00:00:00Z',
    });

    await indexer.indexFile('/vault/concepts/self-attention.md');

    expect(mockRagClient.index).not.toHaveBeenCalled();
    expect(mockRagClient.deleteDocument).not.toHaveBeenCalled();
    expect(mockUpsertTrackedDoc).not.toHaveBeenCalled();
  });

  it('deletes old doc and reindexes when content hash differs', async () => {
    mockReadFile.mockReturnValue(CONCEPT_NOTE);
    mockGetTrackedDoc.mockReturnValue({
      vault_path: 'concepts/self-attention.md',
      doc_id: 'doc-oldhash',
      content_hash: 'oldhash',
      indexed_at: '2026-01-01T00:00:00Z',
    });

    await indexer.indexFile('/vault/concepts/self-attention.md');

    expect(mockRagClient.deleteDocument).toHaveBeenCalledWith('doc-oldhash');
    expect(mockRagClient.index).toHaveBeenCalledOnce();
    expect(mockUpsertTrackedDoc).toHaveBeenCalledOnce();
    expect(mockUpsertTrackedDoc.mock.calls[0][0]).toBe(
      'concepts/self-attention.md',
    );
    // Verify the stored docId matches what was actually indexed
    const expectedDocId = computeDocId(
      mockRagClient.index.mock.calls[0][0] as string,
    ).docId;
    expect(mockUpsertTrackedDoc.mock.calls[0][1]).toBe(expectedDocId);
  });

  it('indexes and tracks new file (not in tracker)', async () => {
    mockReadFile.mockReturnValue(CONCEPT_NOTE);
    mockGetTrackedDoc.mockReturnValue(null);

    await indexer.indexFile('/vault/concepts/self-attention.md');

    expect(mockRagClient.deleteDocument).not.toHaveBeenCalled();
    expect(mockRagClient.index).toHaveBeenCalledOnce();
    expect(mockUpsertTrackedDoc).toHaveBeenCalledOnce();
  });

  it('does not update tracker when index fails', async () => {
    mockReadFile.mockReturnValue(CONCEPT_NOTE);
    mockGetTrackedDoc.mockReturnValue(null);
    mockRagClient.index.mockRejectedValue(new Error('LightRAG down'));

    await indexer.indexFile('/vault/concepts/self-attention.md');

    expect(mockUpsertTrackedDoc).not.toHaveBeenCalled();
  });

  it('proceeds with reindex when deleteDocument fails', async () => {
    mockReadFile.mockReturnValue(CONCEPT_NOTE);
    mockGetTrackedDoc.mockReturnValue({
      vault_path: 'concepts/self-attention.md',
      doc_id: 'doc-old',
      content_hash: 'old',
      indexed_at: '2026-01-01T00:00:00Z',
    });
    mockRagClient.deleteDocument.mockRejectedValue(new Error('delete failed'));

    await indexer.indexFile('/vault/concepts/self-attention.md');

    expect(mockRagClient.index).toHaveBeenCalledOnce();
    expect(mockUpsertTrackedDoc).toHaveBeenCalledOnce();
  });

  // --- Unlink tests ---

  it('handleUnlink deletes from LightRAG and tracker', async () => {
    mockGetTrackedDoc.mockReturnValue({
      vault_path: 'concepts/removed.md',
      doc_id: 'doc-deadbeef',
      content_hash: 'deadbeef',
      indexed_at: '2026-01-01T00:00:00Z',
    });

    await indexer.handleUnlink('/vault/concepts/removed.md');

    expect(mockRagClient.deleteDocument).toHaveBeenCalledWith('doc-deadbeef');
    expect(mockDeleteTrackedDoc).toHaveBeenCalledWith('concepts/removed.md');
  });

  it('handleUnlink is a no-op for untracked files', async () => {
    mockGetTrackedDoc.mockReturnValue(null);

    await indexer.handleUnlink('/vault/concepts/unknown.md');

    expect(mockRagClient.deleteDocument).not.toHaveBeenCalled();
    expect(mockDeleteTrackedDoc).not.toHaveBeenCalled();
  });

  it('handleUnlink removes tracker even if LightRAG delete fails', async () => {
    mockGetTrackedDoc.mockReturnValue({
      vault_path: 'concepts/gone.md',
      doc_id: 'doc-gone',
      content_hash: 'gone',
      indexed_at: '2026-01-01T00:00:00Z',
    });
    mockRagClient.deleteDocument.mockRejectedValue(new Error('timeout'));

    await indexer.handleUnlink('/vault/concepts/gone.md');

    expect(mockDeleteTrackedDoc).toHaveBeenCalledWith('concepts/gone.md');
  });

  // --- Draft skip test ---

  it('skips draft notes and does not track them', async () => {
    mockReadFile.mockReturnValue(`---
title: WIP
status: draft
---

Draft content.`);

    await indexer.indexFile('/vault/concepts/wip.md');

    expect(mockRagClient.index).not.toHaveBeenCalled();
    expect(mockUpsertTrackedDoc).not.toHaveBeenCalled();
  });

  // --- Wikilink injection tests ---

  it('injects wikilink relations after successful indexing', async () => {
    mockReadFile.mockReturnValue(`---
title: Self-Attention
type: concept
---

Self-attention is a key component of [[transformers]].`);
    mockRagClient.entityExists.mockResolvedValue(true);
    mockRagClient.createRelation.mockResolvedValue(undefined);

    await indexer.indexFile('/vault/concepts/self-attention.md');

    expect(mockRagClient.createRelation).toHaveBeenCalledWith(
      'Self-Attention',
      'Transformers',
      expect.objectContaining({
        keywords: 'references, wikilink',
        weight: 1.0,
      }),
    );
  });

  it('skips wikilink injection when target entity does not exist', async () => {
    mockReadFile.mockReturnValue(`---
title: Self-Attention
type: concept
---

See [[nonexistent-concept]].`);
    mockRagClient.entityExists.mockImplementation(async (name: string) =>
      name === 'Self-Attention' ? true : false,
    );

    await indexer.indexFile('/vault/concepts/self-attention.md');

    expect(mockRagClient.createRelation).not.toHaveBeenCalled();
  });

  it('skips wikilink injection when note has no title', async () => {
    mockReadFile.mockReturnValue(`---
type: concept
---

Content with [[some-link]].`);

    await indexer.indexFile('/vault/concepts/untitled.md');

    expect(mockRagClient.entityExists).not.toHaveBeenCalled();
    expect(mockRagClient.createRelation).not.toHaveBeenCalled();
  });

  it('wikilink injection failure does not block indexing', async () => {
    mockReadFile.mockReturnValue(`---
title: Attention
type: concept
---

See [[transformers]].`);
    mockRagClient.entityExists.mockResolvedValue(true);
    mockRagClient.createRelation.mockRejectedValue(new Error('LightRAG down'));

    await indexer.indexFile('/vault/concepts/attention.md');

    // Indexing itself should still succeed
    expect(mockRagClient.index).toHaveBeenCalledOnce();
    expect(mockUpsertTrackedDoc).toHaveBeenCalledOnce();
  });

  it('injects multiple wikilinks from the same note', async () => {
    mockReadFile.mockReturnValue(`---
title: Transformer Architecture
type: concept
---

Uses [[self-attention]] and [[feed-forward-networks]].`);
    mockRagClient.entityExists.mockResolvedValue(true);
    mockRagClient.createRelation.mockResolvedValue(undefined);

    await indexer.indexFile('/vault/concepts/transformer-architecture.md');

    expect(mockRagClient.createRelation).toHaveBeenCalledTimes(2);
    expect(mockRagClient.createRelation).toHaveBeenCalledWith(
      'Transformer Architecture',
      'Self Attention',
      expect.objectContaining({ keywords: 'references, wikilink' }),
    );
    expect(mockRagClient.createRelation).toHaveBeenCalledWith(
      'Transformer Architecture',
      'Feed Forward Networks',
      expect.objectContaining({ keywords: 'references, wikilink' }),
    );
  });
});

describe('library prefix shape', () => {
  let indexer: RagIndexer;
  let mockRagClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRagClient = {
      index: vi.fn().mockResolvedValue(undefined),
      deleteDocument: vi.fn().mockResolvedValue(undefined),
      entityExists: vi.fn().mockResolvedValue(false),
      createRelation: vi.fn().mockResolvedValue(undefined),
    };
    mockGetTrackedDoc.mockReturnValue(null);
    indexer = new RagIndexer('/vault', mockRagClient);
  });

  it('emits Title | Type | Source summary when source_summary present', async () => {
    mockReadFile.mockReturnValue(`---
title: Foo
type: library
source_summary: "[[foo]]"
---

BODY`);

    await indexer.indexFile('/vault/library/foo.md');

    expect(mockRagClient.index).toHaveBeenCalledOnce();
    const indexed = mockRagClient.index.mock.calls[0][0] as string;
    const firstLine = indexed.split('\n')[0];
    expect(firstLine).toBe(
      '[Title: Foo | Type: library | Source summary: foo]',
    );
  });

  it('omits Source summary when missing (over-budget case)', async () => {
    mockReadFile.mockReturnValue(`---
title: Big
type: library
---

BODY`);

    await indexer.indexFile('/vault/library/big.md');

    expect(mockRagClient.index).toHaveBeenCalledOnce();
    const indexed = mockRagClient.index.mock.calls[0][0] as string;
    const firstLine = indexed.split('\n')[0];
    expect(firstLine).toBe('[Title: Big | Type: library]');
  });
});

describe('slug→title map (behavioral)', () => {
  let indexer: RagIndexer;
  let mockRagClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRagClient = {
      index: vi.fn().mockResolvedValue(undefined),
      deleteDocument: vi.fn().mockResolvedValue(undefined),
      entityExists: vi.fn().mockResolvedValue(false),
      createRelation: vi.fn().mockResolvedValue(undefined),
    };
    mockGetTrackedDoc.mockReturnValue(null);
    indexer = new RagIndexer('/vault', mockRagClient);
  });

  it('handleAdd populates the map; subsequent injectWikilinks resolves via map', async () => {
    const targetContent = `---
title: TargetTitle
type: source
---

`;
    const originContent = `---
title: OriginTitle
type: source
---

body refs [[target]]`;

    mockReadFile.mockImplementation((path: any) => {
      if (path.includes('target.md')) return targetContent;
      if (path.includes('origin.md')) return originContent;
      throw new Error(`unexpected read: ${path}`);
    });
    mockRagClient.entityExists = vi.fn().mockResolvedValue(true);
    mockRagClient.createRelation = vi.fn().mockResolvedValue(undefined);

    await indexer.handleAdd('/vault/sources/target.md');
    await indexer.indexFile('/vault/sources/origin.md');

    // entityExists should have been called for the target with the map-resolved title
    expect(mockRagClient.entityExists).toHaveBeenCalledWith('TargetTitle');
  });

  it('handleChange refreshes the map', async () => {
    let titleVersion = 'OldTitle';
    mockReadFile.mockImplementation((path: any) => {
      if (path.includes('thing.md')) {
        return `---\ntitle: ${titleVersion}\ntype: source\n---\n`;
      }
      if (path.includes('origin.md')) {
        return `---\ntitle: O\ntype: source\n---\nrefs [[thing]]`;
      }
      throw new Error(`unexpected: ${path}`);
    });
    mockRagClient.entityExists = vi.fn().mockResolvedValue(true);
    mockRagClient.createRelation = vi.fn().mockResolvedValue(undefined);

    await indexer.handleAdd('/vault/sources/thing.md');
    titleVersion = 'NewTitle';
    await indexer.handleChange('/vault/sources/thing.md');
    await indexer.indexFile('/vault/sources/origin.md');

    expect(mockRagClient.entityExists).toHaveBeenCalledWith('NewTitle');
  });

  it('handleUnlink forgets the slug; subsequent injectWikilinks falls back to slugToTitle and warns', async () => {
    const goneContent = `---
title: GoneTitle
type: source
---

`;
    const originContent = `---
title: O
type: source
---

refs [[gone]]`;

    mockReadFile.mockImplementation((path: any) => {
      if (path.includes('gone.md')) return goneContent;
      if (path.includes('origin.md')) return originContent;
      throw new Error(`unexpected: ${path}`);
    });
    // Tracker doesn't have gone.md, so handleUnlink will return early after map delete
    mockGetTrackedDoc.mockReturnValue(null);
    mockRagClient.entityExists = vi.fn().mockResolvedValue(true);
    mockRagClient.createRelation = vi.fn().mockResolvedValue(undefined);

    // Import logger and spy on it
    const loggerModule = await import('../logger.js');
    const warnSpy = vi.spyOn(loggerModule.logger, 'warn');

    await indexer.handleAdd('/vault/sources/gone.md');
    await indexer.handleUnlink('/vault/sources/gone.md');
    await indexer.indexFile('/vault/sources/origin.md');

    // After unlink, entityExists is called with the slugToTitle fallback ('Gone'), not 'GoneTitle'
    expect(mockRagClient.entityExists).toHaveBeenCalledWith('Gone');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'gone' }),
      expect.stringContaining('not in slug-title map'),
    );
    warnSpy.mockRestore();
  });
});

describe('frontmatter wikilink allowlist', () => {
  let indexer: RagIndexer;
  let mockRagClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRagClient = {
      index: vi.fn().mockResolvedValue(undefined),
      deleteDocument: vi.fn().mockResolvedValue(undefined),
      entityExists: vi.fn().mockResolvedValue(false),
      createRelation: vi.fn().mockResolvedValue(undefined),
    };
    mockGetTrackedDoc.mockReturnValue(null);
    indexer = new RagIndexer('/vault', mockRagClient);
  });

  it('does not produce edges from arbitrary frontmatter fields', async () => {
    mockReadFile.mockReturnValue(`---
title: Origin
type: source
description: "see [[ghost]]"
---

body without links`);
    mockRagClient.entityExists = vi.fn().mockResolvedValue(true);
    mockRagClient.createRelation = vi.fn().mockResolvedValue(undefined);

    await indexer.indexFile('/vault/sources/origin.md');

    expect(mockRagClient.createRelation).not.toHaveBeenCalled();
  });

  it('produces edges from allowlisted frontmatter wikilinks', async () => {
    mockReadFile.mockImplementation((path: any) => {
      const p = String(path);
      if (p.includes('foo.md'))
        return '---\ntitle: FooTitle\ntype: source\n---\n';
      return '---\ntitle: Origin\ntype: library\nsource_summary: "[[foo]]"\n---\nbody';
    });
    mockRagClient.entityExists = vi.fn().mockResolvedValue(true);
    mockRagClient.createRelation = vi.fn().mockResolvedValue(undefined);

    await indexer.handleAdd('/vault/sources/foo.md');
    await indexer.indexFile('/vault/sources/origin.md');

    expect(mockRagClient.createRelation).toHaveBeenCalledWith(
      'Origin',
      'FooTitle',
      expect.any(Object),
    );
  });
});

describe('bidirectional source↔library edges', () => {
  let indexer: RagIndexer;
  let mockRagClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRagClient = {
      index: vi.fn().mockResolvedValue(undefined),
      deleteDocument: vi.fn().mockResolvedValue(undefined),
      entityExists: vi.fn().mockResolvedValue(false),
      createRelation: vi.fn().mockResolvedValue(undefined),
    };
    mockGetTrackedDoc.mockReturnValue(null);
    indexer = new RagIndexer('/vault', mockRagClient);
  });

  it('source.library → library uses summarizes/full_text keywords', async () => {
    // Source note has frontmatter `library: "[[foolib]]"`. Unique slugs avoid
    // map collisions between sources/ and library/ files with the same basename.
    mockReadFile.mockImplementation((path: any) => {
      const p = String(path);
      if (p.includes('foolib.md')) return '---\ntitle: FooLib\ntype: library\n---\nbody';
      if (p.includes('foosrc.md')) return '---\ntitle: FooSrc\ntype: source\nlibrary: "[[foolib]]"\n---\n';
      throw new Error(`unexpected: ${p}`);
    });
    mockGetTrackedDoc.mockReturnValue(null);
    mockRagClient.entityExists = vi.fn().mockResolvedValue(true);
    mockRagClient.createRelation = vi.fn().mockResolvedValue(undefined);

    // Pre-populate the map for both files then index the source
    await indexer.handleAdd('/vault/library/foolib.md');
    await indexer.handleAdd('/vault/sources/foosrc.md');

    expect(mockRagClient.createRelation).toHaveBeenCalledWith(
      'FooSrc',
      'FooLib',
      expect.objectContaining({ keywords: 'summarizes, full_text' }),
    );
  });

  it('library.source_summary → source uses summarized_by/summary', async () => {
    // Library note links back to the source via source_summary: "[[barsrc]]"
    mockReadFile.mockImplementation((path: any) => {
      const p = String(path);
      if (p.includes('barsrc.md')) return '---\ntitle: BarSrc\ntype: source\n---\nbody';
      if (p.includes('barlib.md')) return '---\ntitle: BarLib\ntype: library\nsource_summary: "[[barsrc]]"\n---\n';
      throw new Error(`unexpected: ${p}`);
    });
    mockGetTrackedDoc.mockReturnValue(null);
    mockRagClient.entityExists = vi.fn().mockResolvedValue(true);
    mockRagClient.createRelation = vi.fn().mockResolvedValue(undefined);

    await indexer.handleAdd('/vault/sources/barsrc.md');
    await indexer.handleAdd('/vault/library/barlib.md');

    expect(mockRagClient.createRelation).toHaveBeenCalledWith(
      'BarLib',
      'BarSrc',
      expect.objectContaining({ keywords: 'summarized_by, summary' }),
    );
  });

  it('body wikilinks still use references/wikilink', async () => {
    mockReadFile.mockImplementation((path: any) => {
      const p = String(path);
      if (p.includes('sources/a.md')) return '---\ntitle: A\ntype: source\n---\n';
      if (p.includes('sources/b.md')) return '---\ntitle: B\ntype: source\n---\nrefs [[a]]';
      throw new Error(`unexpected: ${p}`);
    });
    mockGetTrackedDoc.mockReturnValue(null);
    mockRagClient.entityExists = vi.fn().mockResolvedValue(true);
    mockRagClient.createRelation = vi.fn().mockResolvedValue(undefined);

    await indexer.handleAdd('/vault/sources/a.md');
    await indexer.handleAdd('/vault/sources/b.md');

    expect(mockRagClient.createRelation).toHaveBeenCalledWith(
      'B',
      'A',
      expect.objectContaining({ keywords: 'references, wikilink' }),
    );
  });

  it('frontmatter library wikilink on a non-source file falls back to references/wikilink', async () => {
    // The library→summarizes keywords only fire when fileType === 'source'.
    // A concept file with `library:` frontmatter (unusual but possible) gets default keywords.
    mockReadFile.mockImplementation((path: any) => {
      const p = String(path);
      if (p.includes('xlib.md')) return '---\ntitle: XLib\ntype: library\n---\n';
      if (p.includes('concepts/y.md')) return '---\ntitle: Y\ntype: concept\nlibrary: "[[xlib]]"\n---\n';
      throw new Error(`unexpected: ${p}`);
    });
    mockGetTrackedDoc.mockReturnValue(null);
    mockRagClient.entityExists = vi.fn().mockResolvedValue(true);
    mockRagClient.createRelation = vi.fn().mockResolvedValue(undefined);

    await indexer.handleAdd('/vault/library/xlib.md');
    await indexer.handleAdd('/vault/concepts/y.md');

    // The relation should be created (since both entities exist and it's an allowlisted field),
    // but with the fallback keywords because fileType is 'concept', not 'source'.
    expect(mockRagClient.createRelation).toHaveBeenCalledWith(
      'Y',
      'XLib',
      expect.objectContaining({ keywords: 'references, wikilink' }),
    );
  });
});
