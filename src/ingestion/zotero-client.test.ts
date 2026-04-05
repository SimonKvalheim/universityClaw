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
      expect.stringContaining(
        '/api/users/0/items?itemType=-attachment+-note&format=json',
      ),
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
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('ECONNREFUSED'),
    );

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
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            key: 'ABC12345',
            version: 100,
            data: { tags: [{ tag: 'existing' }] },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client.addTag('ABC12345', 'vault:ingested');
    const patchCall = vi.mocked(fetch).mock.calls[1];
    expect(patchCall[0]).toBe(
      'https://api.zotero.org/users/12345/items/ABC12345',
    );
    const body = JSON.parse(patchCall[1]!.body as string);
    expect(body.tags).toEqual([{ tag: 'existing' }, { tag: 'vault:ingested' }]);
  });

  it('addTag skips if tag already present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          key: 'ABC12345',
          version: 100,
          data: { tags: [{ tag: 'vault:ingested' }] },
        }),
      ),
    );

    await client.addTag('ABC12345', 'vault:ingested');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
