# Zotero Auto-Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Zotero as an automatic ingestion source that polls for new items, feeds their PDFs into the existing pipeline, and writes summaries back to Zotero.

**Architecture:** A `ZoteroWatcher` polls the Zotero local API (port 23119) every 60s using `since={version}` for incremental changes. New items get their PDF path resolved locally and enqueued into the existing `PipelineDrainer`. After promotion, a write-back step posts the source summary as a Zotero child note via the web API. The existing `FileWatcher` and upload workflow are untouched.

**Tech Stack:** TypeScript, Node.js fetch API, Zotero local REST API (read), Zotero web API (write), better-sqlite3, vitest

**Spec:** `docs/superpowers/specs/2026-04-04-zotero-auto-ingestion-design.md`

---

### Task 1: Types and Configuration

**Files:**
- Create: `src/ingestion/types.ts`
- Modify: `src/config.ts:47-85`
- Modify: `.env.example`
- Test: `src/ingestion/zotero-client.test.ts` (placeholder — tests added in Task 2)

- [ ] **Step 1: Create `src/ingestion/types.ts` with shared interfaces**

```typescript
export interface ZoteroMetadata {
  title: string;
  creators: { firstName: string; lastName: string; creatorType: string }[];
  date: string;
  DOI?: string;
  url?: string;
  publicationTitle?: string;
  tags: string[];
  abstractNote?: string;
  itemType: string;
}

export interface ZoteroItem {
  key: string;
  version: number;
  data: ZoteroItemData;
  meta: { numChildren?: number };
  links?: {
    attachment?: { href: string; type: string; attachmentType?: string; attachmentSize?: number };
  };
}

export interface ZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  title: string;
  creators: { firstName: string; lastName: string; creatorType: string }[];
  date: string;
  DOI?: string;
  url?: string;
  publicationTitle?: string;
  tags: { tag: string; type?: number }[];
  abstractNote?: string;
  collections: string[];
  [k: string]: unknown;
}

export interface ZoteroAttachment {
  key: string;
  data: {
    key: string;
    itemType: 'attachment';
    contentType: string;
    filename?: string;
    path?: string;
    parentItem: string;
    [k: string]: unknown;
  };
  links?: {
    enclosure?: { href: string; type: string; length?: number };
  };
}
```

- [ ] **Step 2: Add Zotero config exports to `src/config.ts`**

Add after line 137 (`export const PROCESSED_DIR = ...`):

```typescript
export const ZOTERO_ENABLED =
  (process.env.ZOTERO_ENABLED || '').toLowerCase() === 'true';
export const ZOTERO_API_KEY = process.env.ZOTERO_API_KEY || '';
export const ZOTERO_USER_ID = process.env.ZOTERO_USER_ID || '';
export const ZOTERO_POLL_INTERVAL = parseInt(
  process.env.ZOTERO_POLL_INTERVAL || '60000',
  10,
);
export const ZOTERO_EXCLUDE_COLLECTION =
  process.env.ZOTERO_EXCLUDE_COLLECTION || '';
export const ZOTERO_LOCAL_URL =
  process.env.ZOTERO_LOCAL_URL || 'http://localhost:23119';
```

- [ ] **Step 3: Update `.env.example`**

Add at the end:

```
# --- Zotero Integration ---
ZOTERO_ENABLED=false
ZOTERO_API_KEY=
ZOTERO_USER_ID=
# ZOTERO_POLL_INTERVAL=60000
# ZOTERO_EXCLUDE_COLLECTION=Do Not Process
```

- [ ] **Step 4: Commit**

```bash
git add src/ingestion/types.ts src/config.ts .env.example
git commit -m "feat(zotero): add types and configuration for Zotero integration"
```

---

### Task 2: Zotero API Client

**Files:**
- Create: `src/ingestion/zotero-client.ts`
- Test: `src/ingestion/zotero-client.test.ts`

- [ ] **Step 1: Write failing tests for local API client**

Create `src/ingestion/zotero-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZoteroLocalClient, ZoteroWebClient } from './zotero-client.js';

describe('ZoteroLocalClient', () => {
  let client: ZoteroLocalClient;

  beforeEach(() => {
    client = new ZoteroLocalClient('http://localhost:23119');
    vi.restoreAllMocks();
  });

  it('getItems fetches items with since parameter', async () => {
    const mockItems = [{ key: 'ABC12345', data: { title: 'Test' } }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockItems), {
        headers: { 'Last-Modified-Version': '100' },
      }),
    );

    const result = await client.getItems(50);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:23119/api/users/0/items?since=50&itemType=-attachment+-note&format=json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.items).toEqual(mockItems);
    expect(result.version).toBe(100);
  });

  it('getItems without since fetches all items', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        headers: { 'Last-Modified-Version': '200' },
      }),
    );

    const result = await client.getItems();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/users/0/items?itemType=-attachment+-note&format=json'),
      expect.any(Object),
    );
    expect(result.version).toBe(200);
  });

  it('getChildren fetches child items', async () => {
    const mockChildren = [{ key: 'ATT1', data: { itemType: 'attachment' } }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockChildren)),
    );

    const result = await client.getChildren('ABC12345');
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:23119/api/users/0/items/ABC12345/children?format=json',
      expect.any(Object),
    );
    expect(result).toEqual(mockChildren);
  });

  it('getCollections fetches all collections', async () => {
    const mockCollections = [{ key: 'COL1', data: { name: 'Test' } }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockCollections)),
    );

    const result = await client.getCollections();
    expect(result).toEqual(mockCollections);
  });

  it('getFileUrl resolves local PDF path', async () => {
    const fileUrl = 'file:///Users/test/Zotero/storage/ABC12345/paper.pdf';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(fileUrl, { status: 200 }),
    );

    const result = await client.getFileUrl('ATT1');
    expect(result).toBe('/Users/test/Zotero/storage/ABC12345/paper.pdf');
  });

  it('getFileUrl returns null on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Not found', { status: 404 }),
    );

    const result = await client.getFileUrl('MISSING');
    expect(result).toBeNull();
  });

  it('throws on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(client.getItems()).rejects.toThrow('ECONNREFUSED');
  });
});

describe('ZoteroWebClient', () => {
  let client: ZoteroWebClient;

  beforeEach(() => {
    client = new ZoteroWebClient('testApiKey', '12345');
    vi.restoreAllMocks();
  });

  it('createChildNote posts to web API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ successful: { 0: {} } }), {
        status: 200,
        headers: { 'Last-Modified-Version': '101' },
      }),
    );

    await client.createChildNote('ABC12345', '<p>Summary</p>', 100);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.zotero.org/users/12345/items',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Zotero-API-Key': 'testApiKey',
          'If-Unmodified-Since-Version': '100',
        }),
      }),
    );
  });

  it('addTag reads item, appends tag, patches back', async () => {
    // First call: GET current item
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ key: 'ABC12345', version: 100, data: { tags: [{ tag: 'existing' }] } }),
        ),
      )
      // Second call: PATCH with updated tags
      .mockResolvedValueOnce(
        new Response('', { status: 204 }),
      );

    await client.addTag('ABC12345', 'vault:ingested');
    const patchCall = vi.mocked(fetch).mock.calls[1];
    expect(patchCall[0]).toBe('https://api.zotero.org/users/12345/items/ABC12345');
    const body = JSON.parse(patchCall[1]!.body as string);
    expect(body.tags).toEqual([{ tag: 'existing' }, { tag: 'vault:ingested' }]);
  });

  it('addTag skips if tag already present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ key: 'ABC12345', version: 100, data: { tags: [{ tag: 'vault:ingested' }] } }),
      ),
    );

    await client.addTag('ABC12345', 'vault:ingested');
    expect(fetch).toHaveBeenCalledTimes(1); // Only GET, no PATCH
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ingestion/zotero-client.test.ts`
Expected: FAIL — module `./zotero-client.js` not found

- [ ] **Step 3: Implement `src/ingestion/zotero-client.ts`**

```typescript
import { logger } from '../logger.js';

const REQUEST_TIMEOUT = 10_000;

export class ZoteroLocalClient {
  constructor(private readonly baseUrl: string) {}

  async getItems(since?: number): Promise<{ items: unknown[]; version: number }> {
    const params = new URLSearchParams({
      itemType: '-attachment+-note',
      format: 'json',
    });
    if (since !== undefined) params.set('since', String(since));

    const res = await fetch(`${this.baseUrl}/api/users/0/items?${params}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!res.ok) throw new Error(`Zotero local API error: ${res.status}`);

    const items = await res.json();
    const version = parseInt(res.headers.get('Last-Modified-Version') || '0', 10);
    return { items, version };
  }

  async getChildren(itemKey: string): Promise<unknown[]> {
    const res = await fetch(
      `${this.baseUrl}/api/users/0/items/${itemKey}/children?format=json`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT) },
    );
    if (!res.ok) throw new Error(`Zotero children fetch error: ${res.status}`);
    return res.json();
  }

  async getCollections(): Promise<unknown[]> {
    const res = await fetch(
      `${this.baseUrl}/api/users/0/collections?format=json`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT) },
    );
    if (!res.ok) throw new Error(`Zotero collections fetch error: ${res.status}`);
    return res.json();
  }

  async getFileUrl(attachmentKey: string): Promise<string | null> {
    const res = await fetch(
      `${this.baseUrl}/api/users/0/items/${attachmentKey}/file/view/url`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT) },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Zotero file URL error: ${res.status}`);

    const url = (await res.text()).trim();
    // Convert file:// URL to local path
    if (url.startsWith('file://')) {
      return decodeURIComponent(new URL(url).pathname);
    }
    return url;
  }
}

export class ZoteroWebClient {
  private readonly baseUrl = 'https://api.zotero.org';

  constructor(
    private readonly apiKey: string,
    private readonly userId: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      'Zotero-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  async createChildNote(
    parentKey: string,
    htmlContent: string,
    libraryVersion: number,
  ): Promise<void> {
    const body = [
      {
        itemType: 'note',
        parentItem: parentKey,
        note: htmlContent,
        tags: [],
      },
    ];

    const res = await fetch(`${this.baseUrl}/users/${this.userId}/items`, {
      method: 'POST',
      headers: {
        ...this.headers,
        'If-Unmodified-Since-Version': String(libraryVersion),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (res.status === 412) {
      throw new Error('Zotero version conflict (412)');
    }
    if (!res.ok) {
      throw new Error(`Zotero create note error: ${res.status}`);
    }
  }

  async addTag(itemKey: string, tag: string): Promise<void> {
    // Step 1: GET current item to read existing tags
    const getRes = await fetch(
      `${this.baseUrl}/users/${this.userId}/items/${itemKey}`,
      {
        headers: this.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      },
    );
    if (!getRes.ok) throw new Error(`Zotero get item error: ${getRes.status}`);

    const item = (await getRes.json()) as {
      version: number;
      data: { tags: { tag: string }[] };
    };

    // Skip if tag already present
    if (item.data.tags.some((t) => t.tag === tag)) return;

    // Step 2: PATCH with appended tag
    const updatedTags = [...item.data.tags, { tag }];
    const patchRes = await fetch(
      `${this.baseUrl}/users/${this.userId}/items/${itemKey}`,
      {
        method: 'PATCH',
        headers: {
          ...this.headers,
          'If-Unmodified-Since-Version': String(item.version),
        },
        body: JSON.stringify({ tags: updatedTags }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      },
    );

    if (patchRes.status === 412) {
      throw new Error('Zotero version conflict on tag update (412)');
    }
    if (!patchRes.ok) {
      throw new Error(`Zotero tag update error: ${patchRes.status}`);
    }
  }

  async getLibraryVersion(): Promise<number> {
    const res = await fetch(
      `${this.baseUrl}/users/${this.userId}/items?limit=0`,
      {
        headers: this.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      },
    );
    if (!res.ok) throw new Error(`Zotero version fetch error: ${res.status}`);
    return parseInt(res.headers.get('Last-Modified-Version') || '0', 10);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ingestion/zotero-client.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/zotero-client.ts src/ingestion/zotero-client.test.ts
git commit -m "feat(zotero): add local and web API clients with tests"
```

---

### Task 3: Database Changes

**Files:**
- Modify: `src/db.ts:86-98` (CREATE TABLE), `src/db.ts:151-194` (migrations), `src/db.ts:750-788` (ingestion functions)
- Modify: `src/ingestion/pipeline.ts:3-14` (JobRow interface)

- [ ] **Step 1: Write failing test for new DB functions**

Create `src/ingestion/zotero-db.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createIngestionJob,
  getIngestionJobByZoteroKey,
  getZoteroSyncVersion,
  setZoteroSyncVersion,
  getIngestionJobById,
} from '../db.js';
import { initDb, closeDb } from '../db.js';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Zotero DB functions', () => {
  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'zotero-db-test-'));
    closeDb();
    process.env.STORE_DIR = tmpDir;
    initDb();
  });

  it('createIngestionJob stores zotero fields', () => {
    createIngestionJob('job-1', '/path/to/file.pdf', 'file.pdf', 'hash123', {
      source_type: 'zotero',
      zotero_key: 'ABCD1234',
      zotero_metadata: JSON.stringify({ title: 'Test Paper' }),
    });
    const job = getIngestionJobById('job-1') as Record<string, unknown>;
    expect(job.source_type).toBe('zotero');
    expect(job.zotero_key).toBe('ABCD1234');
    expect(JSON.parse(job.zotero_metadata as string)).toEqual({ title: 'Test Paper' });
  });

  it('createIngestionJob defaults source_type to upload', () => {
    createIngestionJob('job-2', '/path/to/file.pdf', 'file.pdf', 'hash456');
    const job = getIngestionJobById('job-2') as Record<string, unknown>;
    expect(job.source_type).toBe('upload');
    expect(job.zotero_key).toBeNull();
  });

  it('getIngestionJobByZoteroKey finds completed job', () => {
    createIngestionJob('job-3', '/path/to/file.pdf', 'file.pdf', 'hash789', {
      source_type: 'zotero',
      zotero_key: 'EFGH5678',
    });
    // Manually update to completed
    const { updateIngestionJob } = require('../db.js');
    updateIngestionJob('job-3', { status: 'completed' });

    const result = getIngestionJobByZoteroKey('EFGH5678');
    expect(result).toBeDefined();
    expect(result!.id).toBe('job-3');
  });

  it('getIngestionJobByZoteroKey returns undefined for non-existent key', () => {
    const result = getIngestionJobByZoteroKey('NONEXIST');
    expect(result).toBeUndefined();
  });

  it('get/setZoteroSyncVersion persists version', () => {
    expect(getZoteroSyncVersion()).toBeNull();
    setZoteroSyncVersion(1834);
    expect(getZoteroSyncVersion()).toBe(1834);
    setZoteroSyncVersion(1900);
    expect(getZoteroSyncVersion()).toBe(1900);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ingestion/zotero-db.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Add migrations to `src/db.ts`**

After the existing `promoted_paths` migration (around line 194), add:

```typescript
  // Add Zotero columns if they don't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE ingestion_jobs ADD COLUMN source_type TEXT DEFAULT 'upload'`,
    );
  } catch {
    /* column exists */
  }
  try {
    database.exec(`ALTER TABLE ingestion_jobs ADD COLUMN zotero_key TEXT`);
  } catch {
    /* column exists */
  }
  try {
    database.exec(
      `ALTER TABLE ingestion_jobs ADD COLUMN zotero_metadata TEXT`,
    );
  } catch {
    /* column exists */
  }

  // Zotero sync state
  database.exec(`
    CREATE TABLE IF NOT EXISTS zotero_sync (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
```

- [ ] **Step 4: Expand `createIngestionJob` signature**

Replace the existing `createIngestionJob` function (lines 776-788) with:

```typescript
export function createIngestionJob(
  id: string,
  sourcePath: string,
  sourceFilename: string,
  contentHash?: string,
  zoteroOpts?: {
    source_type?: string;
    zotero_key?: string;
    zotero_metadata?: string;
  },
): void {
  getDb()
    .prepare(
      `INSERT INTO ingestion_jobs (id, source_path, source_filename, content_hash, source_type, zotero_key, zotero_metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sourcePath,
      sourceFilename,
      contentHash ?? null,
      zoteroOpts?.source_type ?? 'upload',
      zoteroOpts?.zotero_key ?? null,
      zoteroOpts?.zotero_metadata ?? null,
    );
}
```

- [ ] **Step 5: Add new query functions to `src/db.ts`**

After `getCompletedJobByHash` (around line 770), add:

```typescript
export function getIngestionJobByZoteroKey(
  zoteroKey: string,
): { id: string; status: string } | undefined {
  return db
    .prepare(
      `SELECT id, status FROM ingestion_jobs WHERE zotero_key = ? AND status NOT IN ('dismissed', 'failed') ORDER BY created_at DESC LIMIT 1`,
    )
    .get(zoteroKey) as { id: string; status: string } | undefined;
}

export function getZoteroSyncVersion(): number | null {
  const row = db
    .prepare(`SELECT value FROM zotero_sync WHERE key = 'library_version'`)
    .get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : null;
}

export function setZoteroSyncVersion(version: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO zotero_sync (key, value) VALUES ('library_version', ?)`,
  ).run(String(version));
}
```

- [ ] **Step 6: Expand `JobRow` in `src/ingestion/pipeline.ts`**

Add three fields to the `JobRow` interface (after `error?: string | null;` on line 13):

```typescript
  source_type?: string;
  zotero_key?: string | null;
  zotero_metadata?: string | null;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/ingestion/zotero-db.test.ts`
Expected: All 5 tests PASS

Also run existing tests to verify no regressions:

Run: `npx vitest run src/db.test.ts src/ingestion/pipeline.test.ts`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add src/db.ts src/ingestion/pipeline.ts src/ingestion/zotero-db.test.ts
git commit -m "feat(zotero): add database schema, migrations, and query functions"
```

---

### Task 4: ZoteroWatcher

**Files:**
- Create: `src/ingestion/zotero-watcher.ts`
- Test: `src/ingestion/zotero-watcher.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/ingestion/zotero-watcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZoteroWatcher } from './zotero-watcher.js';
import { ZoteroLocalClient } from './zotero-client.js';

// Mock db functions
vi.mock('../db.js', () => ({
  getZoteroSyncVersion: vi.fn(),
  setZoteroSyncVersion: vi.fn(),
  getIngestionJobByZoteroKey: vi.fn(),
  getCompletedJobByHash: vi.fn(),
}));

import {
  getZoteroSyncVersion,
  setZoteroSyncVersion,
  getIngestionJobByZoteroKey,
} from '../db.js';

describe('ZoteroWatcher', () => {
  let watcher: ZoteroWatcher;
  let mockClient: {
    getItems: ReturnType<typeof vi.fn>;
    getChildren: ReturnType<typeof vi.fn>;
    getCollections: ReturnType<typeof vi.fn>;
    getFileUrl: ReturnType<typeof vi.fn>;
  };
  let enqueuedItems: { filePath: string; zoteroKey: string; metadata: unknown }[];

  beforeEach(() => {
    vi.restoreAllMocks();
    mockClient = {
      getItems: vi.fn().mockResolvedValue({ items: [], version: 100 }),
      getChildren: vi.fn().mockResolvedValue([]),
      getCollections: vi.fn().mockResolvedValue([]),
      getFileUrl: vi.fn().mockResolvedValue(null),
    };
    enqueuedItems = [];

    watcher = new ZoteroWatcher({
      client: mockClient as unknown as ZoteroLocalClient,
      excludeCollection: '',
      onItem: (filePath, zoteroKey, metadata) => {
        enqueuedItems.push({ filePath, zoteroKey, metadata });
      },
    });
  });

  afterEach(() => {
    watcher.stop();
  });

  it('first run stores version without processing items', async () => {
    vi.mocked(getZoteroSyncVersion).mockReturnValue(null);
    mockClient.getItems.mockResolvedValue({
      items: [{ key: 'ABC', data: { title: 'Paper', collections: [], creators: [], date: '', tags: [] } }],
      version: 200,
    });

    await watcher.poll();

    expect(setZoteroSyncVersion).toHaveBeenCalledWith(200);
    expect(enqueuedItems).toHaveLength(0); // First run: observe only
  });

  it('subsequent poll processes new items with PDFs', async () => {
    vi.mocked(getZoteroSyncVersion).mockReturnValue(100);
    vi.mocked(getIngestionJobByZoteroKey).mockReturnValue(undefined);

    mockClient.getItems.mockResolvedValue({
      items: [
        {
          key: 'NEW1',
          data: {
            title: 'New Paper',
            itemType: 'journalArticle',
            collections: [],
            creators: [{ firstName: 'John', lastName: 'Doe', creatorType: 'author' }],
            date: '2025-01-01',
            tags: [{ tag: 'AI' }],
            abstractNote: 'Abstract text',
          },
          meta: { numChildren: 1 },
        },
      ],
      version: 150,
    });

    // Child: one PDF attachment
    mockClient.getChildren.mockResolvedValue([
      {
        key: 'ATT1',
        data: {
          itemType: 'attachment',
          contentType: 'application/pdf',
          filename: 'paper.pdf',
        },
        links: { enclosure: { length: 500000 } },
      },
    ]);

    mockClient.getFileUrl.mockResolvedValue('/Users/test/Zotero/storage/ATT1/paper.pdf');

    await watcher.poll();

    expect(enqueuedItems).toHaveLength(1);
    expect(enqueuedItems[0].filePath).toBe('/Users/test/Zotero/storage/ATT1/paper.pdf');
    expect(enqueuedItems[0].zoteroKey).toBe('NEW1');
    expect(setZoteroSyncVersion).toHaveBeenCalledWith(150);
  });

  it('skips items already ingested (dedup by zotero_key)', async () => {
    vi.mocked(getZoteroSyncVersion).mockReturnValue(100);
    vi.mocked(getIngestionJobByZoteroKey).mockReturnValue({ id: 'existing', status: 'completed' });

    mockClient.getItems.mockResolvedValue({
      items: [{ key: 'OLD1', data: { title: 'Old', collections: [], creators: [], date: '', tags: [] } }],
      version: 150,
    });

    await watcher.poll();

    expect(enqueuedItems).toHaveLength(0);
  });

  it('skips items without PDF attachments', async () => {
    vi.mocked(getZoteroSyncVersion).mockReturnValue(100);
    vi.mocked(getIngestionJobByZoteroKey).mockReturnValue(undefined);

    mockClient.getItems.mockResolvedValue({
      items: [{ key: 'NOPDF', data: { title: 'Webpage', collections: [], creators: [], date: '', tags: [] }, meta: { numChildren: 0 } }],
      version: 150,
    });

    mockClient.getChildren.mockResolvedValue([]);

    await watcher.poll();

    expect(enqueuedItems).toHaveLength(0);
  });

  it('skips items in excluded collection', async () => {
    vi.mocked(getZoteroSyncVersion).mockReturnValue(100);
    vi.mocked(getIngestionJobByZoteroKey).mockReturnValue(undefined);

    // Set up exclude collection
    mockClient.getCollections.mockResolvedValue([
      { key: 'EXCL1', data: { name: 'Do Not Process' } },
    ]);

    const watcherWithExclude = new ZoteroWatcher({
      client: mockClient as unknown as ZoteroLocalClient,
      excludeCollection: 'Do Not Process',
      onItem: (filePath, zoteroKey, metadata) => {
        enqueuedItems.push({ filePath, zoteroKey, metadata });
      },
    });

    mockClient.getItems.mockResolvedValue({
      items: [
        { key: 'EXCL_ITEM', data: { title: 'Excluded', collections: ['EXCL1'], creators: [], date: '', tags: [] }, meta: { numChildren: 1 } },
      ],
      version: 150,
    });

    await watcherWithExclude.poll();

    expect(enqueuedItems).toHaveLength(0);
    watcherWithExclude.stop();
  });

  it('picks largest PDF when multiple attachments exist', async () => {
    vi.mocked(getZoteroSyncVersion).mockReturnValue(100);
    vi.mocked(getIngestionJobByZoteroKey).mockReturnValue(undefined);

    mockClient.getItems.mockResolvedValue({
      items: [{ key: 'MULTI', data: { title: 'Multi', collections: [], creators: [], date: '', tags: [] }, meta: { numChildren: 2 } }],
      version: 150,
    });

    mockClient.getChildren.mockResolvedValue([
      {
        key: 'SMALL',
        data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'supplement.pdf' },
        links: { enclosure: { length: 100000 } },
      },
      {
        key: 'BIG',
        data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'full-text.pdf' },
        links: { enclosure: { length: 5000000 } },
      },
    ]);

    mockClient.getFileUrl.mockResolvedValue('/path/to/full-text.pdf');

    await watcher.poll();

    expect(mockClient.getFileUrl).toHaveBeenCalledWith('BIG');
    expect(enqueuedItems).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ingestion/zotero-watcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/ingestion/zotero-watcher.ts`**

```typescript
import { ZoteroLocalClient } from './zotero-client.js';
import { ZoteroMetadata } from './types.js';
import {
  getZoteroSyncVersion,
  setZoteroSyncVersion,
  getIngestionJobByZoteroKey,
} from '../db.js';
import { logger } from '../logger.js';

export interface ZoteroWatcherOpts {
  client: ZoteroLocalClient;
  excludeCollection: string;
  onItem: (filePath: string, zoteroKey: string, metadata: ZoteroMetadata) => void;
  pollIntervalMs?: number;
}

export class ZoteroWatcher {
  private client: ZoteroLocalClient;
  private excludeCollection: string;
  private excludeCollectionKey: string | null = null;
  private onItem: ZoteroWatcherOpts['onItem'];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;

  constructor(opts: ZoteroWatcherOpts) {
    this.client = opts.client;
    this.excludeCollection = opts.excludeCollection;
    this.onItem = opts.onItem;
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
  }

  async start(): Promise<void> {
    // Resolve exclude collection name → key
    if (this.excludeCollection) {
      await this.resolveExcludeCollection();
    }

    // Initial poll, then interval
    await this.poll();
    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        logger.warn({ err }, 'Zotero poll error');
      });
    }, this.pollIntervalMs);

    logger.info('Zotero watcher started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async resolveExcludeCollection(): Promise<void> {
    try {
      const collections = (await this.client.getCollections()) as {
        key: string;
        data: { name: string };
      }[];
      const match = collections.find(
        (c) => c.data.name === this.excludeCollection,
      );
      if (match) {
        this.excludeCollectionKey = match.key;
        logger.info(
          { collection: this.excludeCollection, key: match.key },
          'Resolved Zotero exclude collection',
        );
      } else {
        logger.warn(
          { collection: this.excludeCollection },
          'Zotero exclude collection not found — all items will be processed',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to resolve exclude collection');
    }
  }

  async poll(): Promise<void> {
    const storedVersion = getZoteroSyncVersion();

    let result: { items: unknown[]; version: number };
    try {
      result = await this.client.getItems(storedVersion ?? undefined);
    } catch (err) {
      logger.warn({ err }, 'Zotero not reachable — will retry next cycle');
      return;
    }

    // First run: store version, don't process existing items
    if (storedVersion === null) {
      setZoteroSyncVersion(result.version);
      logger.info(
        { version: result.version, itemCount: result.items.length },
        'Zotero first connect — stored version, skipping existing items',
      );
      return;
    }

    if (result.items.length === 0) {
      setZoteroSyncVersion(result.version);
      return;
    }

    const items = result.items as {
      key: string;
      data: {
        title: string;
        itemType: string;
        collections: string[];
        creators: { firstName: string; lastName: string; creatorType: string }[];
        date: string;
        DOI?: string;
        url?: string;
        publicationTitle?: string;
        tags: { tag: string }[];
        abstractNote?: string;
      };
      meta: { numChildren?: number };
    }[];

    for (const item of items) {
      try {
        await this.processItem(item);
      } catch (err) {
        logger.warn(
          { key: item.key, title: item.data.title, err },
          'Failed to process Zotero item',
        );
      }
    }

    setZoteroSyncVersion(result.version);
  }

  private async processItem(item: {
    key: string;
    data: {
      title: string;
      itemType: string;
      collections: string[];
      creators: { firstName: string; lastName: string; creatorType: string }[];
      date: string;
      DOI?: string;
      url?: string;
      publicationTitle?: string;
      tags: { tag: string }[];
      abstractNote?: string;
    };
    meta: { numChildren?: number };
  }): Promise<void> {
    // Skip attachments and notes (shouldn't appear due to filter, but safety check)
    if (item.data.itemType === 'attachment' || item.data.itemType === 'note') return;

    // Exclude collection check
    if (
      this.excludeCollectionKey &&
      item.data.collections.includes(this.excludeCollectionKey)
    ) {
      logger.debug({ key: item.key }, 'Skipping item in excluded collection');
      return;
    }

    // Dedup by zotero_key
    const existing = getIngestionJobByZoteroKey(item.key);
    if (existing) {
      logger.debug(
        { key: item.key, existingJob: existing.id },
        'Skipping already-processed Zotero item',
      );
      return;
    }

    // Find PDF attachment
    const filePath = await this.resolvePdf(item.key);
    if (!filePath) {
      logger.debug({ key: item.key }, 'No PDF attachment — skipping');
      return;
    }

    // Build metadata
    const metadata: ZoteroMetadata = {
      title: item.data.title,
      creators: item.data.creators,
      date: item.data.date,
      DOI: item.data.DOI,
      url: item.data.url,
      publicationTitle: item.data.publicationTitle,
      tags: item.data.tags.map((t) => t.tag),
      abstractNote: item.data.abstractNote,
      itemType: item.data.itemType,
    };

    logger.info(
      { key: item.key, title: item.data.title, filePath },
      'Zotero: enqueuing item for ingestion',
    );

    this.onItem(filePath, item.key, metadata);
  }

  private async resolvePdf(itemKey: string): Promise<string | null> {
    const children = (await this.client.getChildren(itemKey)) as {
      key: string;
      data: { itemType: string; contentType: string; filename?: string };
      links?: { enclosure?: { length?: number } };
    }[];

    const pdfAttachments = children.filter(
      (c) =>
        c.data.itemType === 'attachment' &&
        c.data.contentType === 'application/pdf',
    );

    if (pdfAttachments.length === 0) return null;

    // Pick largest PDF
    const sorted = pdfAttachments.sort(
      (a, b) =>
        (b.links?.enclosure?.length ?? 0) - (a.links?.enclosure?.length ?? 0),
    );

    return this.client.getFileUrl(sorted[0].key);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ingestion/zotero-watcher.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/zotero-watcher.ts src/ingestion/zotero-watcher.test.ts
git commit -m "feat(zotero): add ZoteroWatcher with polling, filtering, and PDF resolution"
```

---

### Task 5: Zotero Write-Back

**Files:**
- Create: `src/ingestion/zotero-writeback.ts`
- Test: `src/ingestion/zotero-writeback.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/ingestion/zotero-writeback.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZoteroWriteBack } from './zotero-writeback.js';
import { ZoteroWebClient } from './zotero-client.js';

describe('ZoteroWriteBack', () => {
  let writeBack: ZoteroWriteBack;
  let mockWebClient: {
    createChildNote: ReturnType<typeof vi.fn>;
    addTag: ReturnType<typeof vi.fn>;
    getLibraryVersion: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockWebClient = {
      createChildNote: vi.fn().mockResolvedValue(undefined),
      addTag: vi.fn().mockResolvedValue(undefined),
      getLibraryVersion: vi.fn().mockResolvedValue(100),
    };
    writeBack = new ZoteroWriteBack(mockWebClient as unknown as ZoteroWebClient);
  });

  it('writes summary note and tag to Zotero', async () => {
    const sourceContent = '---\ntitle: Test Paper\n---\n\nThis is the summary body.';
    const promotedPaths = ['sources/test-paper.md', 'concepts/concept-1.md', 'concepts/concept-2.md'];

    await writeBack.writeBack('ABC12345', sourceContent, promotedPaths);

    expect(mockWebClient.createChildNote).toHaveBeenCalledWith(
      'ABC12345',
      expect.stringContaining('This is the summary body.'),
      100,
    );
    expect(mockWebClient.createChildNote).toHaveBeenCalledWith(
      'ABC12345',
      expect.stringContaining('2 concepts'),
      100,
    );
    expect(mockWebClient.addTag).toHaveBeenCalledWith('ABC12345', 'vault:ingested');
  });

  it('converts markdown to basic HTML', async () => {
    const sourceContent = '---\ntitle: Test\n---\n\n**Bold** and *italic* text.\n\nSecond paragraph.';

    await writeBack.writeBack('ABC12345', sourceContent, ['sources/test.md']);

    const noteHtml = mockWebClient.createChildNote.mock.calls[0][1] as string;
    expect(noteHtml).toContain('<strong>Bold</strong>');
    expect(noteHtml).toContain('<em>italic</em>');
    expect(noteHtml).toContain('<p>Second paragraph.</p>');
  });

  it('retries once on version conflict (412)', async () => {
    mockWebClient.createChildNote
      .mockRejectedValueOnce(new Error('Zotero version conflict (412)'))
      .mockResolvedValueOnce(undefined);
    mockWebClient.getLibraryVersion
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(101);

    const sourceContent = '---\ntitle: Test\n---\n\nBody.';
    await writeBack.writeBack('ABC12345', sourceContent, ['sources/test.md']);

    expect(mockWebClient.createChildNote).toHaveBeenCalledTimes(2);
    expect(mockWebClient.getLibraryVersion).toHaveBeenCalledTimes(2);
  });

  it('does not throw on write-back failure', async () => {
    mockWebClient.createChildNote.mockRejectedValue(new Error('Network error'));

    const sourceContent = '---\ntitle: Test\n---\n\nBody.';
    // Should not throw
    await writeBack.writeBack('ABC12345', sourceContent, ['sources/test.md']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ingestion/zotero-writeback.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/ingestion/zotero-writeback.ts`**

```typescript
import { ZoteroWebClient } from './zotero-client.js';
import { logger } from '../logger.js';

export class ZoteroWriteBack {
  constructor(private readonly webClient: ZoteroWebClient) {}

  async writeBack(
    zoteroKey: string,
    sourceNoteContent: string,
    promotedPaths: string[],
  ): Promise<void> {
    try {
      const body = this.extractBody(sourceNoteContent);
      const html = this.buildNoteHtml(body, promotedPaths);

      await this.createNoteWithRetry(zoteroKey, html);
      await this.webClient.addTag(zoteroKey, 'vault:ingested');

      logger.info({ zoteroKey }, 'Zotero write-back completed');
    } catch (err) {
      logger.warn({ zoteroKey, err }, 'Zotero write-back failed — continuing');
    }
  }

  private async createNoteWithRetry(
    zoteroKey: string,
    html: string,
  ): Promise<void> {
    let version = await this.webClient.getLibraryVersion();
    try {
      await this.webClient.createChildNote(zoteroKey, html, version);
    } catch (err) {
      if (err instanceof Error && err.message.includes('412')) {
        // Retry once with fresh version
        version = await this.webClient.getLibraryVersion();
        await this.webClient.createChildNote(zoteroKey, html, version);
      } else {
        throw err;
      }
    }
  }

  private extractBody(content: string): string {
    // Strip YAML frontmatter
    const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return (match ? match[1] : content).trim();
  }

  private buildNoteHtml(markdownBody: string, promotedPaths: string[]): string {
    const date = new Date().toISOString().split('T')[0];
    const conceptCount = promotedPaths.filter((p) =>
      p.startsWith('concepts/'),
    ).length;
    const sourcePath = promotedPaths.find((p) => p.startsWith('sources/'));

    const bodyHtml = this.markdownToHtml(markdownBody);

    const parts = [
      '<h2>Source Summary</h2>',
      `<p>Generated by universityClaw on ${date}</p>`,
      '<hr/>',
      bodyHtml,
      '<hr/>',
    ];

    const links: string[] = [];
    if (sourcePath) links.push(`source: ${sourcePath}`);
    if (conceptCount > 0) links.push(`${conceptCount} concepts`);
    if (links.length > 0) {
      parts.push(`<p><em>Vault notes: ${links.join(', ')}</em></p>`);
    }

    return parts.join('\n');
  }

  private markdownToHtml(md: string): string {
    return md
      .split(/\n\n+/)
      .map((block) => {
        const trimmed = block.trim();
        if (!trimmed) return '';

        // Headings
        const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
          const level = headingMatch[1].length;
          return `<h${level}>${this.inlineFormat(headingMatch[2])}</h${level}>`;
        }

        // List items
        if (trimmed.match(/^[-*]\s/m)) {
          const items = trimmed
            .split(/\n/)
            .filter((l) => l.trim())
            .map((l) => `<li>${this.inlineFormat(l.replace(/^[-*]\s+/, ''))}</li>`)
            .join('\n');
          return `<ul>\n${items}\n</ul>`;
        }

        // Regular paragraph
        return `<p>${this.inlineFormat(trimmed.replace(/\n/g, ' '))}</p>`;
      })
      .filter(Boolean)
      .join('\n');
  }

  private inlineFormat(text: string): string {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\[\[(.+?)\]\]/g, '$1'); // Strip wikilinks
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ingestion/zotero-writeback.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/zotero-writeback.ts src/ingestion/zotero-writeback.test.ts
git commit -m "feat(zotero): add write-back for summary note and tag"
```

---

### Task 6: Wire Into Ingestion Pipeline

**Files:**
- Modify: `src/ingestion/index.ts`
- Modify: `src/ingestion/agent-processor.ts`

This task integrates all new components into the existing pipeline. No new test files — the existing pipeline tests plus a manual integration test cover this.

- [ ] **Step 1: Add Zotero imports to `src/ingestion/index.ts`**

Add to the import block (after the existing imports around line 1-39):

```typescript
import { ZoteroWatcher } from './zotero-watcher.js';
import { ZoteroWriteBack } from './zotero-writeback.js';
import { ZoteroLocalClient, ZoteroWebClient } from './zotero-client.js';
import { ZoteroMetadata } from './types.js';
import {
  ZOTERO_ENABLED,
  ZOTERO_API_KEY,
  ZOTERO_USER_ID,
  ZOTERO_POLL_INTERVAL,
  ZOTERO_EXCLUDE_COLLECTION,
  ZOTERO_LOCAL_URL,
} from '../config.js';
```

Also add to the existing db imports:

```typescript
import { getIngestionJobByZoteroKey } from '../db.js';
```

- [ ] **Step 2: Add Zotero members to IngestionPipeline class**

After the existing private members (around line 63-70), add:

```typescript
  private zoteroWatcher: ZoteroWatcher | null = null;
  private zoteroWriteBack: ZoteroWriteBack | null = null;
```

- [ ] **Step 3: Add `enqueueZotero` method**

Add after the existing `enqueue` method (after line 165):

```typescript
  private enqueueZotero(
    filePath: string,
    zoteroKey: string,
    metadata: ZoteroMetadata,
  ): void {
    // Content-hash dedup (same as enqueue)
    let contentHash: string;
    try {
      const fileBuffer = readFileSync(filePath);
      contentHash = createHash('sha256').update(fileBuffer).digest('hex');
    } catch (err) {
      logger.warn(
        { filePath, zoteroKey, err },
        'zotero: Failed to hash file, skipping',
      );
      return;
    }

    const completedDuplicate = getCompletedJobByHash(contentHash);
    if (completedDuplicate) {
      logger.info(
        { zoteroKey, duplicateOfJob: completedDuplicate.id },
        'zotero: Skipping duplicate of completed job',
      );
      return;
    }

    const jobId = randomUUID();
    logger.info(
      { jobId, zoteroKey, title: metadata.title },
      `zotero: Enqueuing: ${metadata.title}`,
    );
    createIngestionJob(jobId, filePath, basename(filePath), contentHash, {
      source_type: 'zotero',
      zotero_key: zoteroKey,
      zotero_metadata: JSON.stringify(metadata),
    });
  }
```

- [ ] **Step 4: Modify `handlePromotion` to skip file move for Zotero jobs**

In `handlePromotion` (around lines 532-541), wrap the file move in a source_type check. Replace:

```typescript
    // Move source file to processed/
    await mkdir(PROCESSED_DIR, { recursive: true });
    try {
      await rename(
        job.source_path,
        join(PROCESSED_DIR, `${job.id}-${fileName}`),
      );
    } catch {
      logger.warn({ jobId: job.id }, 'Failed to move source to processed/');
    }
```

With:

```typescript
    // Move source file to processed/ (skip for Zotero — file is managed by Zotero)
    if (job.source_type !== 'zotero') {
      await mkdir(PROCESSED_DIR, { recursive: true });
      try {
        await rename(
          job.source_path,
          join(PROCESSED_DIR, `${job.id}-${fileName}`),
        );
      } catch {
        logger.warn({ jobId: job.id }, 'Failed to move source to processed/');
      }
    }
```

- [ ] **Step 5: Add Zotero write-back call after promotion completes**

In `handlePromotion`, after `updateIngestionJob(job.id, { status: 'completed', ... })` (around line 552) and before the final logger.info, add:

```typescript
    // Zotero write-back: post summary note + tag
    if (job.source_type === 'zotero' && job.zotero_key && this.zoteroWriteBack) {
      const sourceNotePath = promotedPaths.find((p) => p.startsWith('sources/'));
      if (sourceNotePath) {
        try {
          const fullPath = join(this.vaultDir, sourceNotePath);
          const noteContent = readFileSync(fullPath, 'utf-8');
          await this.zoteroWriteBack.writeBack(
            job.zotero_key,
            noteContent,
            promotedPaths,
          );
        } catch (err) {
          logger.warn(
            { jobId: job.id, zoteroKey: job.zotero_key, err },
            'Zotero write-back failed',
          );
        }
      }
    }
```

- [ ] **Step 6: Initialize Zotero components in `start()`**

In the `start()` method (around line 577), after the existing `this.drainer.drain()` call, add:

```typescript
    // Start Zotero watcher if enabled
    if (ZOTERO_ENABLED) {
      const localClient = new ZoteroLocalClient(ZOTERO_LOCAL_URL);

      if (ZOTERO_API_KEY && ZOTERO_USER_ID) {
        const webClient = new ZoteroWebClient(ZOTERO_API_KEY, ZOTERO_USER_ID);
        this.zoteroWriteBack = new ZoteroWriteBack(webClient);
      } else {
        logger.warn(
          'Zotero write-back disabled — ZOTERO_API_KEY or ZOTERO_USER_ID not set',
        );
      }

      this.zoteroWatcher = new ZoteroWatcher({
        client: localClient,
        excludeCollection: ZOTERO_EXCLUDE_COLLECTION,
        onItem: (filePath, zoteroKey, metadata) => {
          this.enqueueZotero(filePath, zoteroKey, metadata);
        },
        pollIntervalMs: ZOTERO_POLL_INTERVAL,
      });
      await this.zoteroWatcher.start();
      logger.info('Zotero integration enabled');
    }
```

- [ ] **Step 7: Add Zotero cleanup in `stop()`**

In the `stop()` method, add before the existing lines:

```typescript
    if (this.zoteroWatcher) {
      this.zoteroWatcher.stop();
    }
```

- [ ] **Step 8: Also skip `pruneEmptyDirs` for Zotero jobs**

In `handlePromotion`, wrap the `pruneEmptyDirs` call (around line 547):

```typescript
    if (job.source_type !== 'zotero') {
      await this.pruneEmptyDirs(dirname(job.source_path));
    }
```

- [ ] **Step 9: Commit**

```bash
git add src/ingestion/index.ts
git commit -m "feat(zotero): wire ZoteroWatcher and write-back into ingestion pipeline"
```

---

### Task 7: Metadata-Enhanced Prompt

**Files:**
- Modify: `src/ingestion/agent-processor.ts`
- Test: `src/ingestion/agent-processor.test.ts` (existing file)

- [ ] **Step 1: Read existing agent-processor tests**

Run: `npx vitest run src/ingestion/agent-processor.test.ts`
Note the existing test structure.

- [ ] **Step 2: Add test for metadata preamble**

Add to `src/ingestion/agent-processor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AgentProcessor } from './agent-processor.js';

describe('AgentProcessor.buildPrompt', () => {
  const processor = new AgentProcessor({
    vaultDir: '/vault',
    uploadDir: '/upload',
  });

  it('includes Zotero metadata preamble when provided', () => {
    const metadata = JSON.stringify({
      title: 'Test Paper',
      creators: [
        { firstName: 'Jane', lastName: 'Doe', creatorType: 'author' },
        { firstName: 'John', lastName: 'Smith', creatorType: 'author' },
      ],
      date: '2025-06-15',
      DOI: '10.1234/test',
      publicationTitle: 'Journal of Testing',
      tags: ['AI', 'Education'],
      abstractNote: 'This paper examines...',
      itemType: 'journalArticle',
    });

    const prompt = processor.buildPrompt('content', 'file.pdf', 'job-1', [], undefined, {
      source_type: 'zotero',
      zotero_key: 'ABCD1234',
      zotero_metadata: metadata,
    });

    expect(prompt).toContain('## Source Document Metadata (from Zotero)');
    expect(prompt).toContain('Doe, J.; Smith, J.');
    expect(prompt).toContain('2025-06-15');
    expect(prompt).toContain('10.1234/test');
    expect(prompt).toContain('Journal of Testing');
    expect(prompt).toContain('AI, Education');
    expect(prompt).toContain('zotero://select/items/ABCD1234');
    expect(prompt).toContain('zotero_key: ABCD1234');
  });

  it('omits metadata preamble for upload-sourced jobs', () => {
    const prompt = processor.buildPrompt('content', 'file.pdf', 'job-2', []);

    expect(prompt).not.toContain('Source Document Metadata');
    expect(prompt).toContain('upload/processed/job-2-file.pdf');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/ingestion/agent-processor.test.ts`
Expected: FAIL — `buildPrompt` doesn't accept 6th argument

- [ ] **Step 4: Modify `buildPrompt` to accept job metadata**

Update the `buildPrompt` method signature and body in `src/ingestion/agent-processor.ts`:

Replace the existing `buildPrompt` method (lines 21-62) with:

```typescript
  buildPrompt(
    extractedContent: string,
    fileName: string,
    jobId: string,
    figures: string[],
    vaultManifest?: string,
    jobMeta?: {
      source_type?: string;
      zotero_key?: string | null;
      zotero_metadata?: string | null;
    },
  ): string {
    const draftsPath = `/workspace/extra/vault/drafts`;
    const isZotero = jobMeta?.source_type === 'zotero';

    const figuresSection =
      figures.length > 0
        ? `\n<figures>\n${figures.map((f) => `- ${f}`).join('\n')}\n</figures>\n\nReference these figures in your notes with descriptive captions.`
        : '';

    const manifestSection = vaultManifest ? `\n${vaultManifest}\n` : '';

    // Zotero metadata preamble
    let metadataSection = '';
    if (isZotero && jobMeta?.zotero_metadata) {
      try {
        const meta = JSON.parse(jobMeta.zotero_metadata);
        const creators = (meta.creators || [])
          .map(
            (c: { lastName: string; firstName: string }) =>
              `${c.lastName}, ${c.firstName?.[0] || ''}.`,
          )
          .join('; ');
        const tags = (meta.tags || []).join(', ');

        const lines = ['## Source Document Metadata (from Zotero)'];
        if (meta.title) lines.push(`- Title: ${meta.title}`);
        if (creators) lines.push(`- Authors: ${creators}`);
        if (meta.date) lines.push(`- Date: ${meta.date}`);
        if (meta.publicationTitle) lines.push(`- Publication: ${meta.publicationTitle}`);
        if (meta.DOI) lines.push(`- DOI: ${meta.DOI}`);
        if (tags) lines.push(`- Tags: ${tags}`);
        if (meta.abstractNote) lines.push(`- Abstract: ${meta.abstractNote}`);

        metadataSection = '\n' + lines.join('\n') + '\n';
      } catch {
        // Non-fatal: skip metadata if JSON is malformed
      }
    }

    // Source file reference for frontmatter
    const sourceFileValue = isZotero && jobMeta?.zotero_key
      ? `zotero://select/items/${jobMeta.zotero_key}`
      : `upload/processed/${jobId}-${fileName}`;

    // Extra frontmatter hint for Zotero
    const zoteroKeyLine = isZotero && jobMeta?.zotero_key
      ? `\n- **zotero_key for frontmatter:** ${jobMeta.zotero_key}`
      : '';

    // Document content first (top of prompt) for better attention quality,
    // then slim task parameters. Workflow instructions live in CLAUDE.md.
    // See docs/research/2026-03-30-agent-prompt-architecture.md
    return `<document>
<source>${fileName}</source>
<document_content>
${extractedContent}
</document_content>
</document>
${figuresSection}${metadataSection}${manifestSection}
## Job Parameters

- **Job ID:** ${jobId}
- **Source filename:** ${fileName}
- **Drafts path:** ${draftsPath}
- **source_file value for frontmatter:** ${sourceFileValue}${zoteroKeyLine}
- **Source note filename:** ${draftsPath}/${jobId}-source.md
- **Concept note pattern:** ${draftsPath}/${jobId}-concept-NNN.md
- **Manifest path:** ${draftsPath}/${jobId}-manifest.json
- **Completion sentinel:** ${draftsPath}/${jobId}-complete

The content above has been pre-extracted by Docling. Do NOT read the original file.
Location markers like \`<!-- page:N label:TYPE -->\` indicate source positions — use them for citations.

Process this document following your ingestion workflow.`;
  }
```

- [ ] **Step 5: Update `process` method to pass job metadata through**

Update the `process` method signature (line 64) to accept an optional `jobMeta` parameter:

```typescript
  async process(
    extractionPath: string,
    fileName: string,
    jobId: string,
    reviewAgentGroup: RegisteredGroup,
    vaultManifest?: string,
    jobMeta?: {
      source_type?: string;
      zotero_key?: string | null;
      zotero_metadata?: string | null;
    },
  ): Promise<{ status: 'success' | 'error'; error?: string }> {
```

Then update the `buildPrompt` call (around line 99) to pass `jobMeta`:

```typescript
    const prompt = this.buildPrompt(
      extractedContent,
      fileName,
      jobId,
      figures,
      vaultManifest,
      jobMeta,
    );
```

- [ ] **Step 6: Update `handleGeneration` in `src/ingestion/index.ts` to pass job metadata**

In `handleGeneration` (around line 379), update the `agentProcessor.process()` call to pass job metadata:

```typescript
    const containerPromise = this.agentProcessor
      .process(
        extractionPath,
        fileName,
        job.id,
        this.reviewAgentGroup,
        vaultManifest,
        {
          source_type: job.source_type,
          zotero_key: job.zotero_key,
          zotero_metadata: job.zotero_metadata,
        },
      )
      .finally(() => ac.abort());
```

- [ ] **Step 7: Run all tests**

Run: `npx vitest run src/ingestion/`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/ingestion/agent-processor.ts src/ingestion/agent-processor.test.ts src/ingestion/index.ts
git commit -m "feat(zotero): inject Zotero metadata into agent prompt"
```

---

### Task 8: Final Integration and Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npm run build`
Expected: No errors

- [ ] **Step 3: Verify .env.example has all new variables**

Run: `grep ZOTERO .env.example`
Expected: Shows ZOTERO_ENABLED, ZOTERO_API_KEY, ZOTERO_USER_ID, ZOTERO_POLL_INTERVAL, ZOTERO_EXCLUDE_COLLECTION

- [ ] **Step 4: Commit any fixes from verification**

If any issues found, fix and commit:

```bash
git add -A
git commit -m "fix(zotero): address integration issues from verification"
```

- [ ] **Step 5: Create feature branch and PR**

The work should already be on a feature branch. If not:

```bash
git checkout -b feat/zotero-ingestion
```

Push and create PR targeting `main` at `SimonKvalheim/universityClaw`.
