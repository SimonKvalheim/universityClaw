import {
  getSessionById,
  updateSession,
  getLogsBySession,
} from '@/lib/study-db';
import { requestPostSessionGeneration } from '@/lib/generation-trigger';

export async function POST(
  request: Request,
  ctx: { params: Promise<Record<string, string>> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json()) as { reflection: string };

    // Step 1: Get session by ID
    const session = getSessionById(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    // Step 2: Compute calibration score
    let calibrationScore: number | null = null;

    const preConfidenceRaw = session.pre_confidence;
    if (preConfidenceRaw) {
      const preConfidence = JSON.parse(preConfidenceRaw) as Record<
        string,
        number
      >;
      const logs = getLogsBySession(id);

      // Group logs by concept_id
      const byConceptId = new Map<string, number[]>();
      for (const log of logs) {
        if (!byConceptId.has(log.concept_id)) {
          byConceptId.set(log.concept_id, []);
        }
        byConceptId.get(log.concept_id)!.push(log.quality);
      }

      // Compute calibration: compare pre-confidence with actual performance
      const diffs: number[] = [];
      for (const [conceptId, qualities] of byConceptId.entries()) {
        const confidence = preConfidence[conceptId];
        if (confidence === undefined) continue;
        const avgQuality =
          qualities.reduce((sum, q) => sum + q, 0) / qualities.length;
        // Both normalized to 0-1 scale: confidence is 1-5, quality is 0-5
        diffs.push(Math.abs(confidence / 5 - avgQuality / 5));
      }

      if (diffs.length > 0) {
        const avgDiff = diffs.reduce((sum, d) => sum + d, 0) / diffs.length;
        calibrationScore = 1 - avgDiff;
      }
    }

    // Step 3: Update session
    const now = new Date().toISOString();
    const totalTimeMs = Date.parse(now) - Date.parse(session.started_at);
    updateSession(id, {
      ended_at: now,
      post_reflection: body.reflection,
      calibration_score: calibrationScore,
      total_time_ms: totalTimeMs,
    });

    // Step 4: Trigger post-session generation
    try {
      requestPostSessionGeneration(id);
    } catch (genErr) {
      console.warn('Post-session generation trigger failed:', genErr);
    }

    // Step 5: Return result
    return Response.json({
      calibrationScore,
      activitiesCompleted: session.activities_completed ?? 0,
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
