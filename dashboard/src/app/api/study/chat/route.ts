import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/index';
import { concepts } from '@/lib/db/schema';

const WEB_CHANNEL_URL = process.env.WEB_CHANNEL_URL || 'http://127.0.0.1:3200';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sessionId: string;
      text: string;
      conceptId?: string;
      method?: string;
      bloomLevel?: number;
    };

    const { sessionId, conceptId, method, bloomLevel } = body;
    let { text } = body;

    if (!sessionId || !text) {
      return Response.json({ error: 'sessionId and text are required' }, { status: 400 });
    }

    // First-message injection: prepend context if conceptId and method are provided
    if (conceptId && method) {
      const concept = getDb()
        .select()
        .from(concepts)
        .where(eq(concepts.id, conceptId))
        .get();

      const conceptTitle = concept?.title ?? conceptId;
      const level = bloomLevel ?? 1;

      text =
        `[CONTEXT] Concept: ${conceptTitle} | Bloom's Level: L${level} | Method: ${method}\n\n${text}`;
    }

    const res = await fetch(`${WEB_CHANNEL_URL}/study-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
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
