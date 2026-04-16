import { getPlanById, updatePlan } from '@/lib/study-db';

export async function GET(
  _request: Request,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const { id } = await ctx.params;
    const plan = getPlanById(id);
    if (!plan) {
      return Response.json({ error: 'Plan not found' }, { status: 404 });
    }
    return Response.json({ plan });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    updatePlan(id, body);
    const updated = getPlanById(id);
    return Response.json({ plan: updated });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
