import { getPendingConcepts } from '@/lib/study-db';

export async function GET() {
  try {
    const groups = getPendingConcepts();
    return Response.json({ groups });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
