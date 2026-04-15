import { processCompletion } from '@/lib/study-db';
import { requestGeneration } from '@/lib/generation-trigger';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = processCompletion({
      activityId: body.activityId,
      quality: body.quality,
      sessionId: body.sessionId,
      responseText: body.responseText,
      responseTimeMs: body.responseTimeMs,
      confidenceRating: body.confidenceRating,
      surface: 'dashboard_ui',
    });

    if (result.generationNeeded && result.advancement) {
      try {
        requestGeneration(
          result.advancement.conceptId,
          result.advancement.newCeiling,
        );
      } catch (genErr) {
        console.warn('Post-completion generation trigger failed:', genErr);
      }
    }

    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
