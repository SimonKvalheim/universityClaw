import { requestGeneration } from '@/lib/generation-trigger';

export async function POST(request: Request) {
  try {
    const { conceptId, bloomLevel } = (await request.json()) as {
      conceptId?: string;
      bloomLevel?: number;
    };

    if (!conceptId) {
      return Response.json({ error: 'Missing conceptId' }, { status: 400 });
    }

    const level = typeof bloomLevel === 'number' && bloomLevel >= 1 && bloomLevel <= 6
      ? bloomLevel
      : 1;

    requestGeneration(conceptId, level);

    return Response.json({ success: true, conceptId, bloomLevel: level });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
