import { requestGeneration } from '@/lib/generation-trigger';
import { getConceptDetail } from '@/lib/study-db';

export async function POST(request: Request) {
  try {
    const { conceptId, bloomLevel } = (await request.json()) as {
      conceptId?: string;
      bloomLevel?: number;
    };

    if (!conceptId || typeof conceptId !== 'string') {
      return Response.json({ error: 'Missing conceptId' }, { status: 400 });
    }

    const concept = getConceptDetail(conceptId);
    if (!concept) {
      return Response.json({ error: 'Concept not found' }, { status: 404 });
    }

    // Default to the concept's current ceiling so generic callers still
    // target the right difficulty. Explicit override wins when valid.
    const level =
      typeof bloomLevel === 'number' && bloomLevel >= 1 && bloomLevel <= 6
        ? bloomLevel
        : Math.max(1, concept.bloomCeiling || 1);

    requestGeneration(conceptId, level);

    return Response.json({ success: true, conceptId, bloomLevel: level });
  } catch (err) {
    console.error('POST /api/study/generate failed:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
