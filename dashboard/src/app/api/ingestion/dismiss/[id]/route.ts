import { existsSync } from 'fs';
import { rename, mkdir, rm } from 'fs/promises';
import { join, basename } from 'path';
import { dismissJob } from '@/lib/ingestion-db';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(process.cwd(), '..', 'upload');
const DISMISSED_DIR = join(UPLOAD_DIR, 'dismissed');
const EXTRACTIONS_DIR = join(process.cwd(), '..', 'data', 'extractions');

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = dismissJob(id);

    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 409 });
    }

    // Move source file to upload/dismissed/{jobId}-{filename}
    if (result.sourcePath && existsSync(result.sourcePath)) {
      await mkdir(DISMISSED_DIR, { recursive: true });
      const fileName = basename(result.sourcePath);
      try {
        await rename(result.sourcePath, join(DISMISSED_DIR, `${id}-${fileName}`));
      } catch {
        // Source already moved or inaccessible — non-fatal
      }
    }

    // Clean up extraction artifacts
    const extractionDir = join(EXTRACTIONS_DIR, id);
    if (existsSync(extractionDir)) {
      await rm(extractionDir, { recursive: true, force: true }).catch(() => {});
    }

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
