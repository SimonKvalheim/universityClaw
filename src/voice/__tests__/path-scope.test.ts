import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveReadPath,
  resolveWritePath,
  sanitizeSlug,
} from '../path-scope.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'voice-scope-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'x');
  await writeFile(path.join(root, '.env'), 'SECRET=1');
  await mkdir(path.join(root, 'docs', 'superpowers', 'specs'), {
    recursive: true,
  });
});

describe('sanitizeSlug', () => {
  it('accepts lowercase, digits, hyphen', () => {
    expect(sanitizeSlug('voice-chat-v1')).toBe('voice-chat-v1');
  });
  it.each([
    [''],
    ['a'.repeat(81)],
    ['has slash/bad'],
    ['UPPER'],
    ['dot.bad'],
    ['..'],
    [' pad '],
  ])('rejects invalid slug %s', (bad) => {
    expect(() => sanitizeSlug(bad)).toThrow();
  });
});

describe('resolveReadPath', () => {
  it('allows files under src/', async () => {
    const p = await resolveReadPath(root, 'src/a.ts');
    expect(p).toBe(path.join(root, 'src', 'a.ts'));
  });

  it('rejects .env', async () => {
    await expect(resolveReadPath(root, '.env')).rejects.toThrow(/out of scope/);
  });

  it('rejects absolute path outside root', async () => {
    await expect(resolveReadPath(root, '/etc/passwd')).rejects.toThrow(
      /out of scope/,
    );
  });

  it('rejects parent traversal', async () => {
    await expect(resolveReadPath(root, '../etc/passwd')).rejects.toThrow(
      /out of scope/,
    );
  });

  it('rejects symlink escapes', async () => {
    await symlink(path.join(root, '..'), path.join(root, 'src', 'escape'));
    await expect(resolveReadPath(root, 'src/escape/secret')).rejects.toThrow();
  });
});

describe('resolveWritePath', () => {
  it('returns a path under the targeted docs dir with server-generated date prefix', async () => {
    const p = await resolveWritePath(root, 'specs', 'my-slug', 'md');
    expect(p).toMatch(
      /docs\/superpowers\/specs\/\d{4}-\d{2}-\d{2}-my-slug\.md$/,
    );
  });

  it('rejects slug with path separator', async () => {
    await expect(
      resolveWritePath(root, 'specs', '../escape', 'md'),
    ).rejects.toThrow();
  });
});
