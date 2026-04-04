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

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
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
    expect(enqueuedItems).toHaveLength(0);
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

    mockClient.getChildren.mockResolvedValue([
      {
        key: 'ATT_EXCL',
        data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'paper.pdf' },
        links: { enclosure: { length: 500000 } },
      },
    ]);
    mockClient.getFileUrl.mockResolvedValue('/Users/test/Zotero/storage/ATT_EXCL/paper.pdf');

    // Must call start() so resolveExcludeCollection runs before polling
    await watcherWithExclude.start();
    watcherWithExclude.stop();

    expect(enqueuedItems).toHaveLength(0);
    // Verify getChildren was NOT called — item was filtered before PDF resolution
    expect(mockClient.getChildren).not.toHaveBeenCalled();
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
