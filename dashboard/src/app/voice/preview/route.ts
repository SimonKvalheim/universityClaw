import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveReadPath } from '../../../../../src/voice/path-scope';

function isLoopback(host: string | null): boolean {
  if (!host) return false;
  let h = host.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end >= 0 ? h.slice(1, end) : h;
  } else {
    h = h.split(':')[0];
  }
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function getRepoRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith(path.sep + 'dashboard') || cwd.endsWith('/dashboard')
    ? path.resolve(cwd, '..')
    : cwd;
}

export async function GET(req: Request) {
  if (!isLoopback(req.headers.get('host'))) {
    return NextResponse.json(
      { error: 'voice endpoints are localhost-only' },
      { status: 403 },
    );
  }
  const url = new URL(req.url);
  const file = url.searchParams.get('file');
  if (!file) {
    return NextResponse.json({ error: 'file param required' }, { status: 400 });
  }
  const normalized = path.posix.normalize(file);
  if (!normalized.startsWith('docs/superpowers/mockups/')) {
    return NextResponse.json({ error: 'out of scope' }, { status: 403 });
  }
  const repoRoot = getRepoRoot();
  try {
    const abs = await resolveReadPath(repoRoot, normalized);
    const content = await fs.readFile(abs, 'utf8');
    const contentType = abs.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : abs.endsWith('.md')
        ? 'text/markdown; charset=utf-8'
        : 'text/plain; charset=utf-8';
    return new Response(content, { headers: { 'content-type': contentType } });
  } catch {
    return NextResponse.json({ error: 'not found or out of scope' }, { status: 404 });
  }
}
