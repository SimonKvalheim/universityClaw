import { buildSessionComposition } from '@/lib/session-builder';
import {
  getActivityById,
  createSession,
  getActiveSession,
  updateSession,
  getRecentLogs,
} from '@/lib/study-db';
import { getPrerequisiteWarnings, getStalenessWarnings } from '@/lib/session-warnings';
import { computeScaffoldingLevel, generateHint } from '@/lib/scaffolding';

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
            sourceNotePath: full.source_note_path ?? null,
            generatedAt: full.generated_at,
            scaffoldingLevel: 0,
            hint: null as string | null,
          };
        })
        .filter(Boolean),
    }));

    // Compute scaffolding levels per concept (cached to avoid redundant queries)
    const scaffoldingCache = new Map<string, number>();
    for (const block of enrichedBlocks) {
      for (const activity of block.activities) {
        if (!activity) continue;
        let level = scaffoldingCache.get(activity.conceptId);
        if (level === undefined) {
          const logs = getRecentLogs(activity.conceptId, 10);
          const qualities = logs.map(l => l.quality);
          level = computeScaffoldingLevel(qualities, 0);
          scaffoldingCache.set(activity.conceptId, level);
        }
        activity.scaffoldingLevel = level;
        activity.hint = generateHint(activity.referenceAnswer, level);
      }
    }

    const totalActivities = enrichedBlocks.reduce(
      (sum, b) => sum + b.activities.length,
      0,
    );

    // Extract unique concept IDs from session for prerequisite warnings
    const conceptIds = [
      ...new Set(enrichedBlocks.flatMap((b) => b.activities.map((a) => a!.conceptId))),
    ];
    const prerequisiteWarnings = getPrerequisiteWarnings(conceptIds);

    // Extract activity staleness data
    const activityData = enrichedBlocks.flatMap((b) =>
      b.activities.map((a) => ({
        activityId: a!.activityId,
        sourceNotePath: a!.sourceNotePath,
        generatedAt: a!.generatedAt,
      })),
    );
    const staleActivities = getStalenessWarnings(activityData);

    return Response.json({
      session: {
        ...composition,
        blocks: enrichedBlocks,
        totalActivities,
      },
      warnings: {
        prerequisites: prerequisiteWarnings,
        staleActivities,
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
