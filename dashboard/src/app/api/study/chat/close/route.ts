const WEB_CHANNEL_URL = process.env.WEB_CHANNEL_URL || 'http://127.0.0.1:3200';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { sessionId: string };
    const { sessionId } = body;

    if (!sessionId) {
      return Response.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const res = await fetch(`${WEB_CHANNEL_URL}/study-close/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      const errorText = await res.text();
      return Response.json(
        { error: `Web channel error: ${errorText}` },
        { status: res.status },
      );
    }

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
