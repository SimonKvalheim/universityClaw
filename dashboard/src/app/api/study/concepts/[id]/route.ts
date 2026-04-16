import { getConceptDetail } from '@/lib/study-db';

export async function GET(
  _request: Request,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const { id } = await ctx.params;
    const concept = getConceptDetail(id);
    if (!concept) {
      return Response.json({ error: 'Concept not found' }, { status: 404 });
    }
    return Response.json({ concept });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
