import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/index';
import { concepts } from '@/lib/db/schema';

const WEB_CHANNEL_URL = process.env.WEB_CHANNEL_URL || 'http://127.0.0.1:3200';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sessionId: string;
      activityId: string;
      responseText: string;
      conceptId: string;
      bloomLevel: number;
      prompt: string;
      referenceAnswer: string;
    };

    const {
      sessionId,
      activityId,
      responseText,
      conceptId,
      bloomLevel,
      prompt,
      referenceAnswer,
    } = body;

    if (!sessionId || !activityId || !responseText || !conceptId) {
      return Response.json(
        { error: 'sessionId, activityId, responseText, and conceptId are required' },
        { status: 400 },
      );
    }

    // Look up concept title from DB
    const concept = getDb()
      .select()
      .from(concepts)
      .where(eq(concepts.id, conceptId))
      .get();

    const conceptTitle = concept?.title ?? conceptId;

    // Build evaluation message
    const evaluationMessage =
      `[EVALUATE] Activity: ${activityId}\n` +
      `Concept: ${conceptTitle}\n` +
      `Bloom's Level: L${bloomLevel ?? 1}\n` +
      `Prompt: ${prompt}\n` +
      `Reference Answer: ${referenceAnswer}\n\n` +
      `Student Response:\n${responseText}`;

    const res = await fetch(`${WEB_CHANNEL_URL}/study-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text: evaluationMessage }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return Response.json(
        { error: `Web channel error: ${errorText}` },
        { status: res.status },
      );
    }

    return Response.json({ ok: true, sessionId });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
