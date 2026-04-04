import { NextRequest, NextResponse } from 'next/server';
import { join, extname, resolve } from 'path';
import { readFile, stat } from 'fs/promises';

const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), '..', 'vault');

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  const relativePath = segments.join('/');

  // Path traversal protection
  const fullPath = resolve(join(VAULT_DIR, 'attachments', relativePath));
  if (!fullPath.startsWith(resolve(join(VAULT_DIR, 'attachments')))) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
  }

  try {
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) {
      return NextResponse.json({ error: 'Not a file' }, { status: 404 });
    }

    const ext = extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const data = await readFile(fullPath);

    return new NextResponse(data, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
