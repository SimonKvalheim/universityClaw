# RAG Auto-Indexing Pipeline

**Date:** 2026-03-31
**Status:** Approved
**Approach:** Stateful Watcher with SQLite Tracker (Approach A)

## Context

LightRAG is running and queryable, but vault notes aren't reliably indexed into it. The existing `RagIndexer` watches `concepts/`, `sources/`, and `profile/archive/` via chokidar and POSTs content to LightRAG's `/documents/text` endpoint. Three problems:

1. **No dedup tracking.** Every restart re-indexes all files (chokidar fires `add` with `ignoreInitial: false`). LightRAG's internal content-hash dedup prevents true duplicates, but the redundant API calls are wasteful.
2. **Stale entities on edits.** When a note is edited, the new content gets a new doc ID (LightRAG uses `md5(content.strip())`). The old doc ID's entities remain in the graph. Over time, stale knowledge accumulates.
3. **No delete handling.** Removed vault files leave orphaned entities in the graph.

### Research Basis

- LightRAG doc IDs are deterministic: `"doc-" + md5(content.strip())`. Identical content posted twice is detected and skipped. Source: [HKUDS/LightRAG source](https://github.com/HKUDS/LightRAG)
- LightRAG has no "update" operation — it's delete + re-insert. The `DELETE /documents/` endpoint cascades, removing the doc and its extracted entities/relations. Source: [LightRAG API README](https://github.com/HKUDS/LightRAG/blob/main/lightrag/api/README.md)
- Entity merging across separate insertion calls works correctly with the default storage backend. Source: [Issue #485](https://github.com/HKUDS/LightRAG/issues/485)

---

## 1. Data Model

New SQLite table in `src/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS rag_index_tracker (
  vault_path   TEXT PRIMARY KEY,  -- relative to vaultDir, e.g. "concepts/self-attention.md"
  doc_id       TEXT NOT NULL,     -- LightRAG doc ID: "doc-" + md5(content.strip())
  content_hash TEXT NOT NULL,     -- md5 hex, without "doc-" prefix
  indexed_at   TEXT NOT NULL      -- ISO timestamp
);
CREATE INDEX IF NOT EXISTS idx_rag_tracker_doc_id ON rag_index_tracker(doc_id);
```

Helper functions:

- `getTrackedDoc(vaultPath: string)` — returns `{ vault_path, doc_id, content_hash, indexed_at }` or null
- `upsertTrackedDoc(vaultPath: string, docId: string, contentHash: string)` — insert or replace, sets `indexed_at` to now
- `deleteTrackedDoc(vaultPath: string)` — remove row

---

## 2. RagClient Changes

One new method on `RagClient` (`src/rag/rag-client.ts`):

```ts
async deleteDocument(docId: string): Promise<void>
```

Calls `DELETE /documents` on the LightRAG HTTP API with a JSON body `{"ids": ["<docId>"]}`. Cascades — LightRAG removes the document and its extracted entities/relations from the knowledge graph. Must verify the exact endpoint format against the running LightRAG version at implementation time.

### Hash Computation

Doc IDs are computed locally to avoid parsing API responses:

```ts
/** Strip only ASCII whitespace to match Python's str.strip(). */
function pythonStrip(s: string): string {
  return s.replace(/^[\t\n\r\f\v ]+|[\t\n\r\f\v ]+$/g, '');
}

function computeDocId(content: string): { hash: string; docId: string } {
  const hash = md5(pythonStrip(content));
  return { hash, docId: `doc-${hash}` };
}
```

Uses Node's built-in `crypto.createHash('md5')`. **Important:** JavaScript's `.trim()` strips Unicode whitespace (e.g., U+00A0 non-breaking spaces) that Python's `str.strip()` does not. Since LightRAG computes doc IDs in Python, we must match its exact behavior. The `pythonStrip` helper strips only ASCII whitespace characters `\t\n\r\f\v` and space. The hash is computed on the final indexed text (metadata prefix + body), matching what LightRAG receives and hashes server-side.

---

## 3. Indexer Lifecycle

### On `add` or `change` event:

1. Read file, parse frontmatter, skip if `status: draft`
2. Build indexed text (metadata prefix + body) — same format as current
3. Compute `md5(indexedText.trim())` -> `hash`, `docId`
4. Look up `getTrackedDoc(relPath)` from SQLite
5. **If tracked and hash matches** -> skip (already indexed with identical content)
6. **If tracked and hash differs** -> `deleteDocument(oldDocId)` -> `index(indexedText)` -> `upsertTrackedDoc(relPath, docId, hash)`
7. **If not tracked** -> `index(indexedText)` -> `upsertTrackedDoc(relPath, docId, hash)`

### On `unlink` event (file deleted):

1. Look up `getTrackedDoc(relPath)`
2. If tracked -> `deleteDocument(docId)` -> `deleteTrackedDoc(relPath)`

### On `unlink` via rename:

File renames in the vault (e.g., `self-attention.md` -> `self-attention-mechanism.md`) emit `unlink` for the old path then `add` for the new path. This is handled correctly by the existing event handlers — the old path gets deleted from LightRAG and tracker, the new path gets indexed and tracked as a new file.

### On startup:

Chokidar with `ignoreInitial: false` fires `add` for every existing file. The hash comparison in step 5 makes this cheap — only genuinely new or changed files hit the LightRAG API. First-ever startup indexes everything (empty tracker). Note: first-ever bulk index of a large vault (hundreds of notes) will be slow since each `index()` call involves LLM extraction on the LightRAG side — expect minutes, not seconds.

**Crash recovery dependency:** If the process crashes between a `deleteDocument` and the subsequent `index` call (step 6), the content is temporarily missing from LightRAG. On next restart, `ignoreInitial: false` ensures chokidar fires `add` for the file, and since the tracker was not updated (crash happened before step 6 completes), the file gets reindexed. This recovery path depends entirely on `ignoreInitial: false` — changing it would break crash recovery.

### Error Handling

- **`deleteDocument` fails** (LightRAG down, doc already gone) -> log warning, proceed with reindex anyway. Stale entities are better than missing content.
- **`index` fails** -> log warning, don't update tracker. File will be retried on next event or restart.
- **DB write fails** -> log error. Next restart will re-index the file (safe, just redundant).

### Partial-write safety

The existing chokidar config uses `awaitWriteFinish: { stabilityThreshold: 500 }`, which delays events until the file has been stable for 500ms. This prevents hashing a partially-written file. This setting must be preserved — without it, a `change` event on a half-written file could produce a hash that differs from the final content, causing a spurious delete+reindex cycle on the next event.

### Concurrency

File events can fire rapidly (startup walk, bulk promotions). Index calls are serialized with a simple async queue — an array of pending operations chained sequentially — to avoid overwhelming LightRAG.

---

## 4. Files Changed

| File | Change |
|------|--------|
| `src/db.ts` | `rag_index_tracker` table creation in schema init + 3 helper functions |
| `src/rag/rag-client.ts` | `deleteDocument(docId)` method |
| `src/rag/indexer.ts` | Hash tracking, delete-before-reinsert, `unlink` handler, serial queue, `computeDocId` utility |

### Files NOT changed

- `src/index.ts` — already calls `ragIndexer.start()` / `stop()`, interface unchanged
- `src/ingestion/*` — pipeline promotes to `concepts/`/`sources/`, watcher picks them up, no coupling
- `src/config.ts` — no new config, watch paths stay hardcoded as `ALLOWED_PATHS`

### Not in scope

- Reconciliation loop (upgrade path to Approach C if chokidar proves unreliable)
- Query-side changes or verification re-ranking (separate concern in vault redesign spec)
- LightRAG data wipe (operational step in vault redesign spec Section 7)
- Ingestion pipeline changes

---

## 5. Testing

- **`computeDocId` unit test:** Verify output matches LightRAG's Python `md5(content.strip())` for various inputs (ASCII, UTF-8, trailing whitespace, non-breaking spaces U+00A0 at boundaries)
- **Indexer logic unit tests:** Mock `RagClient` + DB helpers, verify correct behavior for each scenario:
  - New file -> index + track
  - Unchanged file -> skip
  - Changed file -> delete old + index new + update track
  - Deleted file -> delete from LightRAG + remove track
- **Integration sanity:** Start indexer against a temp vault dir, verify tracker rows match files on disk after startup walk
