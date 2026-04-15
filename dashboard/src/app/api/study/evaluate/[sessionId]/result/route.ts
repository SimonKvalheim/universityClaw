import { getLogByActivityIdAndMethod } from '@/lib/study-db';

export async function GET(
  request: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  try {
    await ctx.params; // Await params even though we don't use sessionId directly here

    const { searchParams } = new URL(request.url);
    const activityId = searchParams.get('activityId');

    if (!activityId) {
      return Response.json({ error: 'activityId query param is required' }, { status: 400 });
    }

    const log = getLogByActivityIdAndMethod(activityId, 'ai_evaluated');

    if (log) {
      return Response.json({
        status: 'complete',
        quality: log.ai_quality,
        aiFeedback: log.ai_feedback,
      });
    }

    return Response.json({ status: 'pending' });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
