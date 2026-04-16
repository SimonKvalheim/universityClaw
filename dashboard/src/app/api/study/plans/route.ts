import { getAllPlans, createPlan } from '@/lib/study-db';

export async function GET() {
  try {
    const plans = getAllPlans();
    return Response.json({ plans });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.title || !Array.isArray(body.conceptIds) || body.conceptIds.length === 0) {
      return Response.json({ error: 'title and conceptIds required' }, { status: 400 });
    }

    const planId = crypto.randomUUID();
    const config = body.examDate ? JSON.stringify({ exam_date: body.examDate }) : undefined;

    createPlan(
      {
        id: planId,
        title: body.title,
        domain: body.domain,
        course: body.course,
        strategy: body.strategy ?? 'open',
        learningObjectives: body.learningObjectives,
        desiredOutcomes: body.desiredOutcomes,
        implementationIntention: body.implementationIntention,
        obstacle: body.obstacle,
        studySchedule: body.studySchedule,
        config,
        checkpointIntervalDays: body.checkpointIntervalDays,
      },
      body.conceptIds,
      body.targetBloom,
    );

    return Response.json({ planId });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
