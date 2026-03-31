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
});
