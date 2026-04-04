import { existsSync } from 'fs';

import { getJobSourcePath, retryJob } from '@/lib/ingestion-db';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const sourcePath = getJobSourcePath(id);
    if (!sourcePath || !existsSync(sourcePath)) {
      return Response.json(
        { error: 'Source file not found — cannot retry' },
        { status: 409 },
      );
    }

    const result = retryJob(id);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 409 });
    }

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
