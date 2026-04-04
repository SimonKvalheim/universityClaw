import { NextRequest, NextResponse } from 'next/server';

const WEB_CHANNEL_URL = process.env.WEB_CHANNEL_URL || 'http://127.0.0.1:3200';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { draftId, text } = body as { draftId?: string; text?: string };

    if (!draftId || !text) {
      return NextResponse.json({ error: 'Missing draftId or text' }, { status: 400 });
    }

    const res = await fetch(`${WEB_CHANNEL_URL}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId, text }),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json({ error: data.error || 'Failed to send message' }, { status: res.status });
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: `Web channel unreachable: ${err}` }, { status: 502 });
  }
}
