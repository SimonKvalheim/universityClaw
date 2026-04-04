import { getJobDetail } from '@/lib/ingestion-db';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const job = getJobDetail(id);
    if (!job) {
      return Response.json({ error: 'Job not found' }, { status: 404 });
    }
    return Response.json(job);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
