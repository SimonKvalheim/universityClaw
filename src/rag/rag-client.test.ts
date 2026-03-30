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

  it('index posts to /documents/text', async () => {
    fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));

    await client.index('Hello world');

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9621/documents/text');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.text).toBe('Hello world');
  });

  it('index throws on non-ok response', async () => {
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
});
