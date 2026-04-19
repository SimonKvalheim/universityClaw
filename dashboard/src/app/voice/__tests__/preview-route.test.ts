import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { GET } from '../preview/route';

const REPO_ROOT = process.cwd().endsWith('/dashboard')
  ? path.resolve(process.cwd(), '..')
  : process.cwd();

const MOCKUP_DIR = path.join(REPO_ROOT, 'docs', 'superpowers', 'mockups');
const SLUG = `preview-route-test-${Date.now()}`;
const TEST_HTML = path.join(MOCKUP_DIR, `2026-04-19-${SLUG}.html`);
const TEST_MD = path.join(MOCKUP_DIR, `2026-04-19-${SLUG}.md`);

beforeAll(() => {
  mkdirSync(MOCKUP_DIR, { recursive: true });
  writeFileSync(TEST_HTML, '<!doctype html><html><body>preview</body></html>');
  writeFileSync(TEST_MD, '```mermaid\ngraph TD; A-->B;\n```\n');
});

afterAll(() => {
  for (const p of [TEST_HTML, TEST_MD]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

function reqWith(qs: string, host = 'localhost:3100'): Request {
  return new Request(`http://localhost:3100/voice/preview?${qs}`, {
    headers: { host },
  });
}

describe('GET /voice/preview', () => {
  it('403 off loopback', async () => {
    const res = await GET(reqWith('file=docs/superpowers/mockups/x.html', 'public.example.com'));
    expect(res.status).toBe(403);
  });

  it('400 when file param is missing', async () => {
    const res = await GET(reqWith(''));
    expect(res.status).toBe(400);
  });

  it('403 when file is not under docs/superpowers/mockups/', async () => {
    const res = await GET(reqWith('file=src/config.ts'));
    expect(res.status).toBe(403);
  });

  it('403 on parent-traversal attempt', async () => {
    const res = await GET(
      reqWith('file=docs/superpowers/mockups/../../sources/secret.md'),
    );
    expect(res.status).toBe(403);
  });

  it('403 on absolute path', async () => {
    const res = await GET(reqWith('file=/etc/passwd'));
    expect(res.status).toBe(403);
  });

  it('200 with text/html for a real mockup', async () => {
    const rel = path.relative(REPO_ROOT, TEST_HTML);
    const res = await GET(reqWith('file=' + encodeURIComponent(rel)));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('preview');
  });

  it('200 with text/markdown for a real diagram', async () => {
    const rel = path.relative(REPO_ROOT, TEST_MD);
    const res = await GET(reqWith('file=' + encodeURIComponent(rel)));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/markdown/);
  });

  it('404 for a non-existent file under the mockup dir', async () => {
    const res = await GET(
      reqWith('file=docs/superpowers/mockups/2026-01-01-does-not-exist.html'),
    );
    expect(res.status).toBe(404);
  });
});
