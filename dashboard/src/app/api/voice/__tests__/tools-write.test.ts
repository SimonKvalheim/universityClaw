import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
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

const UNIQUE_SLUG = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Absolute paths for cleanup
const REPO_ROOT = process.cwd().endsWith('/dashboard')
  ? path.resolve(process.cwd(), '..')
  : process.cwd();

const DIRS = {
  specs: path.join(REPO_ROOT, 'docs', 'superpowers', 'specs'),
  plans: path.join(REPO_ROOT, 'docs', 'superpowers', 'plans'),
  mockups: path.join(REPO_ROOT, 'docs', 'superpowers', 'mockups'),
};

function cleanup() {
  for (const dir of Object.values(DIRS)) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.includes(UNIQUE_SLUG)) {
        rmSync(path.join(dir, name), { force: true });
      }
    }
  }
}

afterAll(() => cleanup());

describe('write tools', () => {
  it("write_spec: writes to docs/superpowers/specs/ with today's date", async () => {
    const { status, body } = await call('write_spec', {
      slug: UNIQUE_SLUG,
      content: '# Hello\n',
    });
    expect(status).toBe(200);
    expect(body.path).toMatch(
      new RegExp(`docs/superpowers/specs/\\d{4}-\\d{2}-\\d{2}-${UNIQUE_SLUG}\\.md$`),
    );
    const abs = path.join(REPO_ROOT, body.path);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe('# Hello\n');
  });

  it('write_plan: writes to docs/superpowers/plans/', async () => {
    const slug = UNIQUE_SLUG + '-plan';
    const { body } = await call('write_plan', { slug, content: '# Plan\n' });
    expect(body.path).toMatch(
      new RegExp(`docs/superpowers/plans/\\d{4}-\\d{2}-\\d{2}-${slug}\\.md$`),
    );
  });

  it('write_mockup: writes .html and returns previewUrl', async () => {
    const slug = UNIQUE_SLUG + '-m';
    const { body } = await call('write_mockup', {
      slug,
      html: '<!doctype html><html><body>hi</body></html>',
    });
    expect(body.path).toMatch(/\.html$/);
    expect(body.previewUrl).toContain('/voice/preview?file=');
    expect(body.previewUrl).toContain(encodeURIComponent(body.path));
  });

  it('write_diagram: wraps mermaid in a fenced code block', async () => {
    const slug = UNIQUE_SLUG + '-d';
    const { body } = await call('write_diagram', {
      slug,
      mermaid: 'graph TD; A-->B;',
      title: 'Test',
    });
    expect(body.path).toMatch(/\.md$/);
    const abs = path.join(REPO_ROOT, body.path);
    const contents = readFileSync(abs, 'utf8');
    expect(contents).toContain('```mermaid');
    expect(contents).toContain('graph TD; A-->B;');
    expect(contents).toContain('# Test');
    expect(body.previewUrl).toContain('/voice/preview?file=');
  });

  it('rejects slug with path separator', async () => {
    const { body } = await call('write_spec', { slug: 'bad/slug', content: 'x' });
    expect(body.error).toBeDefined();
  });

  it('rejects uppercase slug', async () => {
    const { body } = await call('write_spec', { slug: 'BAD-SLUG', content: 'x' });
    expect(body.error).toBeDefined();
  });

  it('rejects oversized content (> 256 KB)', async () => {
    const { body } = await call('write_spec', {
      slug: UNIQUE_SLUG + '-big',
      content: 'x'.repeat(260 * 1024),
    });
    expect(body.error).toMatch(/too large/i);
  });

  it('refuses to overwrite existing file with different content', async () => {
    const slug = UNIQUE_SLUG + '-dup';
    const first = (await call('write_spec', { slug, content: 'A' })).body;
    expect(first.path).toBeDefined();

    const second = (await call('write_spec', { slug, content: 'B' })).body;
    expect(second.error).toMatch(/would overwrite/);
    expect(second.existingContent).toBe('A');
  });

  it('no-op when re-writing identical content', async () => {
    const slug = UNIQUE_SLUG + '-idem';
    const first = (await call('write_spec', { slug, content: 'same' })).body;
    const second = (await call('write_spec', { slug, content: 'same' })).body;
    expect(second.error).toBeUndefined();
    expect(second.path).toBe(first.path);
  });
});
