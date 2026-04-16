import { buildSessionComposition } from '@/lib/session-builder';
import {
  getActivityById,
  createSession,
  getActiveSession,
  updateSession,
} from '@/lib/study-db';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const planId = url.searchParams.get('planId') ?? undefined;
    const composition = buildSessionComposition({ planId });
    const enrichedBlocks = composition.blocks.map((block) => ({
      ...block,
      activities: block.activities
        .map((a) => {
          const full = getActivityById(a.activityId);
          if (!full) return null;
          return {
            ...a,
            prompt: full.prompt,
            referenceAnswer: full.reference_answer ?? null,
            cardType: full.card_type ?? null,
          };
        })
        .filter(Boolean),
    }));
    const totalActivities = enrichedBlocks.reduce(
      (sum, b) => sum + b.activities.length,
      0,
    );
    return Response.json({
      session: {
        ...composition,
        blocks: enrichedBlocks,
        totalActivities,
      },
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sessionType?: string;
      preConfidence?: Record<string, number>;
      planId?: string;
    };

    // End any orphaned active session
    const active = getActiveSession();
    if (active) {
      updateSession(active.id, { ended_at: new Date().toISOString() });
    }

    const sessionId = crypto.randomUUID();
    createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      sessionType: body.sessionType ?? 'daily',
      preConfidence: body.preConfidence
        ? JSON.stringify(body.preConfidence)
        : undefined,
      surface: 'dashboard_ui',
      planId: body.planId,
    });
    return Response.json({ sessionId });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
