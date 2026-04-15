import { getStreakDays } from '@/lib/study-db';

export async function GET() {
  try {
    const streak = getStreakDays();
    return Response.json({ streak });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
