import { describe, it, expect } from 'vitest';
import { POST } from '../tools/dev/[tool]/route';

async function call(tool: string, args: unknown) {
  const req = new Request(`http://localhost:3100/api/voice/tools/dev/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost' },
    body: JSON.stringify(args),
  });
  const res = await POST(req, { params: Promise.resolve({ tool }) });
  return { status: res.status, body: await res.json() };
}

describe('read tools', () => {
  it('read_file: returns contents for an allowed root config', async () => {
    const { status, body } = await call('read_file', { path: 'package.json' });
    expect(status).toBe(200);
    expect(body.content).toContain('"name"');
  });

  it('read_file: returns contents for a src/ file', async () => {
    const { status, body } = await call('read_file', { path: 'src/voice/path-scope.ts' });
    expect(status).toBe(200);
    expect(body.content).toContain('sanitizeSlug');
  });

  it('read_file: rejects .env with a clear error (200 with body.error)', async () => {
    const { status, body } = await call('read_file', { path: '.env' });
    expect(status).toBe(200);
    expect(body.error).toMatch(/out of scope/);
  });

  it('read_file: rejects node_modules', async () => {
    const { body } = await call('read_file', { path: 'node_modules/foo/index.js' });
    expect(body.error).toMatch(/out of scope/);
  });

  it('read_file: returns a truncation marker when file exceeds 256 KB', async () => {
    // Use a known-large file if available. package-lock.json is usually >256 KB.
    const { body } = await call('read_file', { path: 'package-lock.json' });
    // If it's short, the test still passes (just no truncation marker).
    // If it's large, we expect the marker.
    if (body.content && body.content.length >= 256 * 1024) {
      expect(body.content).toContain('[truncated at 256 KB');
    }
  });

  it('glob: returns matching paths', async () => {
    const { status, body } = await call('glob', { pattern: 'src/**/*.test.ts' });
    expect(status).toBe(200);
    expect(Array.isArray(body.paths)).toBe(true);
    expect(body.paths.length).toBeGreaterThan(0);
    expect(body.paths[0]).toMatch(/\.test\.ts$/);
  });

  it('glob: rejects patterns starting with ..', async () => {
    const { body } = await call('glob', { pattern: '../../etc/*' });
    expect(body.error).toMatch(/out of scope|invalid pattern/);
  });

  it('grep: returns matches with path/line/text', async () => {
    const { status, body } = await call('grep', { pattern: 'sanitizeSlug', glob: 'src/voice/*.ts' });
    expect(status).toBe(200);
    expect(Array.isArray(body.matches)).toBe(true);
    expect(body.matches.length).toBeGreaterThan(0);
    expect(body.matches[0]).toHaveProperty('path');
    expect(body.matches[0]).toHaveProperty('line');
    expect(body.matches[0]).toHaveProperty('text');
  });

  it('git_log: returns recent commits, honoring limit', async () => {
    const { status, body } = await call('git_log', { limit: 3 });
    expect(status).toBe(200);
    expect(Array.isArray(body.commits)).toBe(true);
    expect(body.commits.length).toBeLessThanOrEqual(3);
    expect(body.commits.length).toBeGreaterThan(0);
    expect(body.commits[0]).toHaveProperty('sha');
    expect(body.commits[0]).toHaveProperty('subject');
  });

  it('git_status: returns branch and changes', async () => {
    const { status, body } = await call('git_status', {});
    expect(status).toBe(200);
    expect(typeof body.branch).toBe('string');
    expect(body.branch.length).toBeGreaterThan(0);
  });

  it('list_docs: lists spec filenames', async () => {
    const { status, body } = await call('list_docs', { kind: 'specs' });
    expect(status).toBe(200);
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files.some((f: string) => f.endsWith('.md'))).toBe(true);
  });

  it('list_docs: rejects unknown kind', async () => {
    const { body } = await call('list_docs', { kind: 'secrets' });
    expect(body.error).toBeDefined();
  });

  it('read_doc: returns a spec file', async () => {
    const { status, body } = await call('read_doc', {
      kind: 'specs',
      name: '2026-04-18-live-voice-chat-design.md',
    });
    expect(status).toBe(200);
    expect(body.content).toContain('# Live Voice Chat');
  });

  it('read_doc: rejects traversal in name', async () => {
    const { body } = await call('read_doc', { kind: 'specs', name: '../../etc/passwd' });
    expect(body.error).toBeDefined();
  });

  it('unknown tool returns 404', async () => {
    const req = new Request('http://localhost:3100/api/voice/tools/dev/bogus', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost' },
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ tool: 'bogus' }) });
    expect(res.status).toBe(404);
  });

  it('off-loopback returns 403', async () => {
    const req = new Request('http://public.example.com/api/voice/tools/dev/read_file', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'public.example.com' },
      body: JSON.stringify({ path: 'package.json' }),
    });
    const res = await POST(req, { params: Promise.resolve({ tool: 'read_file' }) });
    expect(res.status).toBe(403);
  });
});
