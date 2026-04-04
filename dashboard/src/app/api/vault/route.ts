import { NextRequest, NextResponse } from 'next/server';
import { join, resolve, relative } from 'path';
import { stat, readdir, readFile } from 'fs/promises';
import matter from 'gray-matter';

const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), '..', 'vault');

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const pathParam = searchParams.get('path') || '';

    // Prevent path traversal
    const safePath = resolve(join(VAULT_DIR, pathParam));
    if (!safePath.startsWith(resolve(VAULT_DIR))) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    let stats;
    try {
      stats = await stat(safePath);
    } catch {
      return NextResponse.json({ error: 'Path not found' }, { status: 404 });
    }

    if (stats.isDirectory()) {
      const entries = await readdir(safePath, { withFileTypes: true });
      const items = entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        path: relative(VAULT_DIR, join(safePath, entry.name)),
      }));
      return NextResponse.json({ type: 'directory', path: pathParam, entries: items });
    } else if (safePath.endsWith('.md')) {
      const raw = await readFile(safePath, 'utf-8');
      const { data, content } = matter(raw);
      return NextResponse.json({
        type: 'note',
        path: pathParam,
        frontmatter: data,
        content,
      });
    } else {
      return NextResponse.json({ error: 'Not a markdown file or directory' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
