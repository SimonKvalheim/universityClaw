import { approveConcepts, approveDomain } from '@/lib/study-db';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { conceptIds?: string[]; domain?: string };

    if (typeof body.domain === 'string' && body.domain.length > 0) {
      const ids = approveDomain(body.domain);
      return Response.json({ approved: ids.length, ids });
    }

    if (Array.isArray(body.conceptIds) && body.conceptIds.length > 0) {
      const approved = approveConcepts(body.conceptIds);
      return Response.json({ approved });
    }

    return Response.json({ error: 'Provide domain or conceptIds' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
