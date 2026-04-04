import { getRecentJobs } from '@/lib/ingestion-db';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') ?? undefined;
    const jobs = getRecentJobs(status);
    return Response.json({ jobs });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
