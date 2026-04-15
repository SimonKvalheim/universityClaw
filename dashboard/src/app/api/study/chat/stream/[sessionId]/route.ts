const WEB_CHANNEL_URL = process.env.WEB_CHANNEL_URL || 'http://127.0.0.1:3200';

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await ctx.params;

    const upstream = await fetch(
      `${WEB_CHANNEL_URL}/study-stream/${sessionId}`,
    );

    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { error: 'Failed to connect to upstream SSE stream' },
        { status: upstream.status || 502 },
      );
    }

    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    return Response.json(
      { error: `Web channel unreachable: ${err}` },
      { status: 502 },
    );
  }
}
