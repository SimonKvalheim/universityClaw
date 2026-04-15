import { approveConcepts, approveDomain } from '@/lib/study-db';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { conceptIds?: string[]; domain?: string };

    if (body.domain !== undefined) {
      const ids = approveDomain(body.domain);
      return Response.json({ approved: ids.length, ids });
    }

    if (body.conceptIds !== undefined) {
      const approved = approveConcepts(body.conceptIds);
      return Response.json({ approved });
    }

    return Response.json({ error: 'Provide domain or conceptIds' }, { status: 400 });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
