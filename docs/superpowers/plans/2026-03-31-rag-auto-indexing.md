# RAG Auto-Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite-based content-hash tracking to the RAG indexer so it skips unchanged files, deletes stale entities before reindexing changed files, and cleans up orphaned entities when files are deleted.

**Architecture:** Enhance the existing `RagIndexer` (chokidar watcher) with a `rag_index_tracker` SQLite table that maps vault paths to LightRAG doc IDs. On each file event, compute the content hash locally (matching LightRAG's Python `md5(content.strip())`), compare against the tracker, and only call the LightRAG API when content has actually changed. Add `deleteDocument` to `RagClient` for the delete-before-reinsert lifecycle.

**Tech Stack:** TypeScript, better-sqlite3, Node crypto (md5), chokidar (existing), LightRAG HTTP API

**Spec:** `docs/superpowers/specs/2026-03-31-rag-auto-indexing-design.md`

---

### Task 1: Add `deleteDocument` to RagClient

**Files:**
- Modify: `src/rag/rag-client.ts`
- Modify: `src/rag/rag-client.test.ts`

- [ ] **Step 1: Write failing test for deleteDocument**

Add to the `RagClient HTTP` describe block in `src/rag/rag-client.test.ts`:

```ts
it('deleteDocument sends DELETE /documents with doc ID', async () => {
  fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));

  await client.deleteDocument('doc-abc123');

  const [url, opts] = fetchSpy.mock.calls[0];
  expect(url).toBe('http://localhost:9621/documents');
  expect(opts?.method).toBe('DELETE');
  const body = JSON.parse(opts?.body as string);
  expect(body.ids).toEqual(['doc-abc123']);
});

it('deleteDocument does not throw on 404 (already deleted)', async () => {
  fetchSpy.mockResolvedValue(new Response('Not found', { status: 404 }));

  // Should not throw — doc may already be gone
  await expect(client.deleteDocument('doc-gone')).resolves.toBeUndefined();
});

it('deleteDocument throws on server error', async () => {
  fetchSpy.mockResolvedValue(new Response('Server Error', { status: 500 }));

  await expect(client.deleteDocument('doc-x')).rejects.toThrow(
    'LightRAG delete failed',
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/rag/rag-client.test.ts`
Expected: 3 new tests FAIL with `client.deleteDocument is not a function`

- [ ] **Step 3: Implement deleteDocument**

Add to `RagClient` class in `src/rag/rag-client.ts`, after the `index` method:

```ts
async deleteDocument(docId: string): Promise<void> {
  const res = await fetch(`${this.serverUrl}/documents`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [docId] }),
    signal: AbortSignal.timeout(30_000),
  });
  // 404 is fine — doc may already be gone
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`LightRAG delete failed (${res.status}): ${body}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/rag/rag-client.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/rag/rag-client.ts src/rag/rag-client.test.ts
git commit -m "feat(rag): add deleteDocument method to RagClient"
```

---

### Task 2: Add rag_index_tracker table and DB helpers

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

- [ ] **Step 1: Write failing tests for DB helpers**

Add a new describe block at the end of `src/db.test.ts`:

```ts
describe('rag_index_tracker', () => {
  it('getTrackedDoc returns null for unknown path', () => {
    expect(getTrackedDoc('concepts/foo.md')).toBeNull();
  });

  it('upsertTrackedDoc inserts and getTrackedDoc retrieves', () => {
    upsertTrackedDoc('concepts/foo.md', 'doc-abc', 'abc');
    const row = getTrackedDoc('concepts/foo.md');
    expect(row).not.toBeNull();
    expect(row!.doc_id).toBe('doc-abc');
    expect(row!.content_hash).toBe('abc');
    expect(row!.indexed_at).toBeTruthy();
  });

  it('upsertTrackedDoc updates existing row', () => {
    upsertTrackedDoc('concepts/bar.md', 'doc-111', '111');
    upsertTrackedDoc('concepts/bar.md', 'doc-222', '222');
    const row = getTrackedDoc('concepts/bar.md');
    expect(row!.doc_id).toBe('doc-222');
    expect(row!.content_hash).toBe('222');
  });

  it('deleteTrackedDoc removes the row', () => {
    upsertTrackedDoc('concepts/baz.md', 'doc-xyz', 'xyz');
    deleteTrackedDoc('concepts/baz.md');
    expect(getTrackedDoc('concepts/baz.md')).toBeNull();
  });

  it('deleteTrackedDoc is safe for nonexistent path', () => {
    expect(() => deleteTrackedDoc('nope.md')).not.toThrow();
  });
});
```

Also add the imports at the top of `src/db.test.ts`:

```ts
import { getTrackedDoc, upsertTrackedDoc, deleteTrackedDoc } from './db.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts`
Expected: FAIL — `getTrackedDoc` is not exported

- [ ] **Step 3: Add table creation to createSchema**

In `src/db.ts`, inside `createSchema()`, add after the `ingestion_jobs` table creation (before the closing `);` of the main `database.exec` template literal):

```sql
CREATE TABLE IF NOT EXISTS rag_index_tracker (
  vault_path   TEXT PRIMARY KEY,
  doc_id       TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rag_tracker_doc_id ON rag_index_tracker(doc_id);
```

- [ ] **Step 4: Add helper functions**

Add to `src/db.ts` after the ingestion job functions (before `migrateJsonState`):

```ts
// --- RAG index tracker ---

export interface TrackedDoc {
  vault_path: string;
  doc_id: string;
  content_hash: string;
  indexed_at: string;
}

export function getTrackedDoc(vaultPath: string): TrackedDoc | null {
  return (
    (db
      .prepare('SELECT * FROM rag_index_tracker WHERE vault_path = ?')
      .get(vaultPath) as TrackedDoc | undefined) ?? null
  );
}

export function upsertTrackedDoc(
  vaultPath: string,
  docId: string,
  contentHash: string,
): void {
  db.prepare(
    `INSERT INTO rag_index_tracker (vault_path, doc_id, content_hash, indexed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(vault_path) DO UPDATE SET
       doc_id = excluded.doc_id,
       content_hash = excluded.content_hash,
       indexed_at = excluded.indexed_at`,
  ).run(vaultPath, docId, contentHash, new Date().toISOString());
}

export function deleteTrackedDoc(vaultPath: string): void {
  db.prepare('DELETE FROM rag_index_tracker WHERE vault_path = ?').run(
    vaultPath,
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): add rag_index_tracker table and helpers"
```

---

### Task 3: Add computeDocId utility with hash parity tests

**Files:**
- Create: `src/rag/doc-id.ts`
- Create: `src/rag/doc-id.test.ts`

- [ ] **Step 1: Write failing tests for computeDocId**

Create `src/rag/doc-id.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/rag/doc-id.test.ts`
Expected: FAIL — module `./doc-id.js` not found

- [ ] **Step 3: Implement computeDocId**

Create `src/rag/doc-id.ts`:

```ts
import { createHash } from 'crypto';

/**
 * Strip only ASCII whitespace to match Python's str.strip().
 * JS .trim() also strips Unicode whitespace (U+00A0, U+2003, etc.)
 * which Python's strip() does not — causing hash divergence on
 * PDF-sourced content with non-breaking spaces.
 */
export function pythonStrip(s: string): string {
  return s.replace(/^[\t\n\r\f\v ]+|[\t\n\r\f\v ]+$/g, '');
}

/**
 * Compute a LightRAG-compatible document ID.
 * LightRAG uses: "doc-" + md5(content.strip())
 */
export function computeDocId(content: string): {
  hash: string;
  docId: string;
} {
  const stripped = pythonStrip(content);
  const hash = createHash('md5').update(stripped).digest('hex');
  return { hash, docId: `doc-${hash}` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/rag/doc-id.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/rag/doc-id.ts src/rag/doc-id.test.ts
git commit -m "feat(rag): add computeDocId with Python-compatible strip"
```

---

### Task 4: Rewrite RagIndexer with hash tracking and delete lifecycle

**Files:**
- Modify: `src/rag/indexer.ts`
- Modify: `src/rag/indexer.test.ts`

- [ ] **Step 1: Write failing tests for the new indexer behavior**

Replace the contents of `src/rag/indexer.test.ts` with:

```ts
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
    // We need to call indexFile once to see what text gets built,
    // then set up the mock to return that hash
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
    // Verify upsert was called with the new hash, not the old one
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

    // Should still attempt to index despite delete failure
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

    // Tracker should still be cleaned up
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/rag/indexer.test.ts`
Expected: Multiple FAILs — `handleUnlink` doesn't exist, tracker mocks not wired up

- [ ] **Step 3: Rewrite indexer.ts**

Replace `src/rag/indexer.ts` with:

```ts
import { watch, type FSWatcher } from 'chokidar';
import { readFileSync } from 'fs';
import { relative, resolve } from 'path';
import { logger } from '../logger.js';
import {
  getTrackedDoc,
  upsertTrackedDoc,
  deleteTrackedDoc,
} from '../db.js';
import type { RagClient } from './rag-client.js';
import { parseFrontmatter } from '../vault/frontmatter.js';
import { computeDocId } from './doc-id.js';

/** Paths relative to vaultDir that should be indexed. */
const ALLOWED_PATHS = ['concepts', 'sources', 'profile/archive'];

export class RagIndexer {
  private vaultDir: string;
  private ragClient: RagClient;
  private watcher: FSWatcher | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(vaultDir: string, ragClient: RagClient) {
    this.vaultDir = resolve(vaultDir);
    this.ragClient = ragClient;
  }

  start(): void {
    const watchPaths = ALLOWED_PATHS.map((p) => resolve(this.vaultDir, p));
    this.watcher = watch(watchPaths, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500 },
      ignored: [/(^|[/\\])\./],
    });
    this.watcher.on('add', (fp) => this.enqueue(() => this.indexFile(fp)));
    this.watcher.on('change', (fp) => this.enqueue(() => this.indexFile(fp)));
    this.watcher.on('unlink', (fp) => this.enqueue(() => this.handleUnlink(fp)));
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Serialize operations to avoid overwhelming LightRAG. */
  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn, fn);
  }

  async indexFile(filePath: string): Promise<void> {
    if (!filePath.endsWith('.md')) return;

    const relPath = relative(this.vaultDir, filePath);

    const isAllowed = ALLOWED_PATHS.some(
      (p) => relPath.startsWith(p + '/') || relPath.startsWith(p + '\\'),
    );
    if (!isAllowed) return;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const { data: fm, content: body } = parseFrontmatter(content);
    if (fm.status === 'draft') return;

    const title = fm.title || relPath;
    const type = fm.type || 'unknown';
    const topics = Array.isArray(fm.topics) ? fm.topics.join(', ') : '';
    const sourceDoc = fm.source_doc || '';
    const verification = fm.verification_status || 'unverified';

    const parts = [`Title: ${title}`, `Type: ${type}`];
    if (topics) parts.push(`Topics: ${topics}`);
    if (sourceDoc) parts.push(`Source: ${sourceDoc}`);
    parts.push(`Verification: ${verification}`);

    const prefix = `[${parts.join(' | ')}]`;
    const indexed = `${prefix}\nSource path: ${relPath}\n\n${body}`;

    // Compute hash and check tracker
    const { hash, docId } = computeDocId(indexed);
    const tracked = getTrackedDoc(relPath);

    if (tracked && tracked.content_hash === hash) {
      return; // Already indexed with identical content
    }

    // Delete old doc if content changed
    if (tracked) {
      try {
        await this.ragClient.deleteDocument(tracked.doc_id);
      } catch (err) {
        logger.warn({ err, relPath }, 'Failed to delete old doc from LightRAG');
      }
    }

    // Index new content
    try {
      await this.ragClient.index(indexed);
    } catch (err) {
      logger.warn({ err, relPath }, 'Failed to index file');
      return; // Don't update tracker — will retry on next event/restart
    }

    upsertTrackedDoc(relPath, docId, hash);
  }

  async handleUnlink(filePath: string): Promise<void> {
    if (!filePath.endsWith('.md')) return;

    const relPath = relative(this.vaultDir, filePath);
    const tracked = getTrackedDoc(relPath);
    if (!tracked) return;

    try {
      await this.ragClient.deleteDocument(tracked.doc_id);
    } catch (err) {
      logger.warn({ err, relPath }, 'Failed to delete doc from LightRAG on unlink');
    }

    deleteTrackedDoc(relPath);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/rag/indexer.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests still PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/rag/indexer.ts src/rag/indexer.test.ts
git commit -m "feat(rag): add hash tracking, delete lifecycle, and unlink handling to indexer"
```

---

### Task 5: Verify end-to-end behavior

**Files:**
- No new files — verification only

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS, no regressions

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run build`
Expected: Clean compile, no errors

- [ ] **Step 3: Commit build verification (if any format changes)**

If prettier reformatted anything during the build:

```bash
git add -A
git commit -m "chore: format fixes from build"
```
