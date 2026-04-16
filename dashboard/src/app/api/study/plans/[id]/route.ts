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

// Maps camelCase request keys to snake_case DB columns
const ALLOWED_FIELDS: Record<string, string> = {
  title: 'title',
  strategy: 'strategy',
  status: 'status',
  domain: 'domain',
  course: 'course',
  learningObjectives: 'learning_objectives',
  desiredOutcomes: 'desired_outcomes',
  implementationIntention: 'implementation_intention',
  obstacle: 'obstacle',
  studySchedule: 'study_schedule',
  config: 'config',
  checkpointIntervalDays: 'checkpoint_interval_days',
  nextCheckpointAt: 'next_checkpoint_at',
};

export async function PATCH(
  request: Request,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const safeUpdates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      const col = ALLOWED_FIELDS[key];
      if (col) safeUpdates[col] = value;
    }
    if (Object.keys(safeUpdates).length === 0) {
      return Response.json({ error: 'No valid fields to update' }, { status: 400 });
    }
    updatePlan(id, safeUpdates);
    const updated = getPlanById(id);
    return Response.json({ plan: updated });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
