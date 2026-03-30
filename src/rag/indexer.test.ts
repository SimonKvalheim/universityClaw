import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RagIndexer } from './indexer.js';
import { readFileSync } from 'fs';

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

describe('RagIndexer allowlist and metadata prefix', () => {
  let indexer: RagIndexer;
  let mockRagClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRagClient = { index: vi.fn().mockResolvedValue(undefined) };
    indexer = new RagIndexer('/vault', mockRagClient);
  });

  it('indexes files in concepts/', async () => {
    mockReadFile.mockReturnValue(`---
title: Self-Attention
type: concept
topics: [deep-learning, transformers]
source_doc: "Vaswani et al. 2017"
verification_status: unverified
---

Content here.`);

    await indexer.indexFile('/vault/concepts/self-attention.md');

    expect(mockRagClient.index).toHaveBeenCalledOnce();
    const indexed = mockRagClient.index.mock.calls[0][0] as string;
    expect(indexed).toContain('[Title: Self-Attention | Type: concept | Topics: deep-learning, transformers | Source: Vaswani et al. 2017 | Verification: unverified]');
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
});
