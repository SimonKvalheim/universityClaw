import { getActiveConcepts, getConceptStats } from '@/lib/study-db';

export async function GET() {
  try {
    const concepts = getActiveConcepts();
    const stats = getConceptStats();
    return Response.json({ concepts, stats });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
