import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { RagClient, type RagConfig } from './rag-client.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

const baseConfig: RagConfig = {
  workingDir: '/tmp/rag-test',
  vaultDir: '/tmp/vault-test',
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

  it('query returns fallback result when python call fails', async () => {
    const client = new RagClient({
      ...baseConfig,
      pythonBin: 'nonexistent-python-bin-xyz',
    });

    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (callback) callback(new Error('spawn failed'), '', '');
      return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
    });

    const result = await client.query('What is integration?');
    expect(result.answer).toBe('');
    expect(result.sources).toEqual([]);
  });
});

describe('RagClient stdin safety', () => {
  let client: RagClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new RagClient({
      workingDir: '/tmp/rag',
      vaultDir: '/tmp/vault',
    });
  });

  it('passes content via stdin, not string interpolation', async () => {
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn();

    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (callback) callback(null, 'ok', '');
      return { stdin: { write: stdinWrite, end: stdinEnd } } as any;
    });

    const dangerousContent = 'Text with """triple quotes""" and $VARS and `backticks`';
    await client.index(dangerousContent);

    const pythonArg = mockExecFile.mock.calls[0]?.[1]?.[1] as string;
    expect(pythonArg).not.toContain('triple quotes');
    expect(pythonArg).toContain('sys.stdin.read()');
  });

  it('passes query via stdin, not string interpolation', async () => {
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn();

    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (callback) callback(null, 'some answer', '');
      return { stdin: { write: stdinWrite, end: stdinEnd } } as any;
    });

    const dangerousQuery = 'What about "injection" and ${code}?';
    await client.query(dangerousQuery);

    const pythonArg = mockExecFile.mock.calls[0]?.[1]?.[1] as string;
    expect(pythonArg).not.toContain('injection');
    expect(pythonArg).toContain('sys.stdin.read()');
  });

  it('writes content to child process stdin', async () => {
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn();

    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (callback) callback(null, 'ok', '');
      return { stdin: { write: stdinWrite, end: stdinEnd } } as any;
    });

    await client.index('hello world');

    expect(stdinWrite).toHaveBeenCalledWith('hello world');
    expect(stdinEnd).toHaveBeenCalled();
  });
});
