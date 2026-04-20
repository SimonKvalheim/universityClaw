import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RagClient, type RagConfig } from './rag-client.js';

const baseConfig: RagConfig = {
  serverUrl: 'http://localhost:9621',
};

describe('RagClient', () => {
  it('constructs with config', () => {
    const client = new RagClient(baseConfig);
    expect(client).toBeInstanceOf(RagClient);
  });

  it('buildQuery returns original query when no filters', () => {
    const client = new RagClient(baseConfig);
    const result = client.buildQuery('What is calculus?');
    expect(result).toBe('What is calculus?');
  });

  it('buildQuery adds metadata filter when filters provided', () => {
    const client = new RagClient(baseConfig);
    const result = client.buildQuery('What is calculus?', {
      course: 'MAT101',
      semester: 'Fall 2024',
    });
    expect(result).toContain('[Context:');
    expect(result).toContain('course: MAT101');
    expect(result).toContain('semester: Fall 2024');
    expect(result).toContain('What is calculus?');
  });

  it('buildQuery with empty filters object returns original query', () => {
    const client = new RagClient(baseConfig);
    const result = client.buildQuery('Some question', {});
    expect(result).toBe('[Context: ] Some question');
  });
});

describe('RagClient HTTP', () => {
  let client: RagClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new RagClient(baseConfig);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('query posts to /query with correct body', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ response: 'The answer is 42.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await client.query('What is the answer?');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9621/query');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.query).toBe('What is the answer?');
    expect(body.mode).toBe('hybrid');
    expect(body.only_need_context).toBe(true);
    expect(result.answer).toBe('The answer is 42.');
  });

  it('query returns empty result on fetch failure', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));

    const result = await client.query('Something');
    expect(result.answer).toBe('');
    expect(result.sources).toEqual([]);
  });

  it('query returns empty result on non-ok response', async () => {
    fetchSpy.mockResolvedValue(new Response('Server Error', { status: 500 }));

    const result = await client.query('Something');
    expect(result.answer).toBe('');
  });

  const jsonResponse = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('index posts to /documents/text and polls until processed', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ status: 'success', track_id: 't1', message: 'ok' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status_summary: { 'DocStatus.PENDING': 1 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status_summary: { 'DocStatus.PROCESSED': 1 } }),
      );

    await client.index('Hello world', { pollIntervalMs: 1 });

    const [postUrl, postOpts] = fetchSpy.mock.calls[0];
    expect(postUrl).toBe('http://localhost:9621/documents/text');
    expect(postOpts?.method).toBe('POST');
    const body = JSON.parse(postOpts?.body as string);
    expect(body.text).toBe('Hello world');

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1][0]).toBe(
      'http://localhost:9621/documents/track_status/t1',
    );
  });

  it('index sends file_source when provided', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ status: 'success', track_id: 't2', message: 'ok' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status_summary: { 'DocStatus.PROCESSED': 1 } }),
      );

    await client.index('text', {
      fileSource: 'concepts/foo.md',
      pollIntervalMs: 1,
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.file_source).toBe('concepts/foo.md');
  });

  it('index returns immediately on duplicated (no polling)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        status: 'duplicated',
        track_id: 't3',
        message: 'already exists',
      }),
    );

    await client.index('duplicate', { pollIntervalMs: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('index throws on failure status from POST', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        status: 'failure',
        track_id: 't4',
        message: 'empty text',
      }),
    );

    await expect(client.index('bad', { pollIntervalMs: 1 })).rejects.toThrow(
      'LightRAG index rejected: empty text',
    );
  });

  it('index throws when track_status reports FAILED', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ status: 'success', track_id: 't5', message: 'ok' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status_summary: { 'DocStatus.FAILED': 1 } }),
      );

    await expect(
      client.index('will-fail', { pollIntervalMs: 1 }),
    ).rejects.toThrow('LightRAG indexing failed for track t5');
  });

  it('index keeps polling when track_status summary is initially empty', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ status: 'success', track_id: 't7', message: 'ok' }),
      )
      .mockResolvedValueOnce(jsonResponse({ status_summary: {} }))
      .mockResolvedValueOnce(
        jsonResponse({ status_summary: { 'DocStatus.PROCESSING': 1 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status_summary: { 'DocStatus.PROCESSED': 1 } }),
      );

    await client.index('eventual', { pollIntervalMs: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('index throws on polling timeout', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ status: 'success', track_id: 't6', message: 'ok' }),
      )
      .mockImplementation(async () =>
        jsonResponse({ status_summary: { 'DocStatus.PROCESSING': 1 } }),
      );

    await expect(
      client.index('stuck', { pollIntervalMs: 5, pollTimeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms for track t6/);
  });

  it('index throws on non-ok HTTP response from POST', async () => {
    fetchSpy.mockResolvedValue(new Response('Bad', { status: 400 }));

    await expect(client.index('test')).rejects.toThrow('LightRAG index failed');
  });

  it('healthy returns true when server responds ok', async () => {
    fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));
    expect(await client.healthy()).toBe(true);
  });

  it('healthy returns false when server is down', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await client.healthy()).toBe(false);
  });

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
    await expect(client.deleteDocument('doc-gone')).resolves.toBeUndefined();
  });

  it('deleteDocument throws on server error', async () => {
    fetchSpy.mockResolvedValue(new Response('Server Error', { status: 500 }));
    await expect(client.deleteDocument('doc-x')).rejects.toThrow(
      'LightRAG delete failed',
    );
  });

  it('entityExists returns true when entity is found', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ exists: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(await client.entityExists('Self-Attention')).toBe(true);

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      'http://localhost:9621/graph/entity/exists?name=Self-Attention',
    );
  });

  it('entityExists returns false when entity not found', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ exists: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(await client.entityExists('Nonexistent')).toBe(false);
  });

  it('entityExists returns false on network error', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await client.entityExists('Whatever')).toBe(false);
  });

  it('createRelation posts to /graph/relation/create', async () => {
    fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));

    await client.createRelation('Self-Attention', 'Transformers', {
      description: 'Test relation',
      keywords: 'references, wikilink',
      weight: 1.0,
    });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9621/graph/relation/create');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.source_entity).toBe('Self-Attention');
    expect(body.target_entity).toBe('Transformers');
    expect(body.relation_data.keywords).toBe('references, wikilink');
  });

  it('createRelation throws on non-ok response', async () => {
    fetchSpy.mockResolvedValue(new Response('Bad', { status: 400 }));
    await expect(
      client.createRelation('A', 'B', { description: 'test' }),
    ).rejects.toThrow('LightRAG create relation failed');
  });
});
