import { addConceptsToPlan, removeConceptFromPlan } from '@/lib/study-db';

export async function POST(
  request: Request,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    if (!Array.isArray(body.conceptIds) || body.conceptIds.length === 0) {
      return Response.json({ error: 'conceptIds required' }, { status: 400 });
    }
    addConceptsToPlan(id, body.conceptIds, body.targetBloom);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    if (!body.conceptId) {
      return Response.json({ error: 'conceptId required' }, { status: 400 });
    }
    removeConceptFromPlan(id, body.conceptId);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
