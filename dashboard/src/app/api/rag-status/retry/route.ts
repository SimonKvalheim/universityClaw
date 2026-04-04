const LIGHTRAG_URL = process.env.LIGHTRAG_URL || 'http://localhost:9621';

export async function POST() {
  try {
    const res = await fetch(`${LIGHTRAG_URL}/documents/reprocess_failed`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text();
      return Response.json({ error: text }, { status: res.status });
    }
    const data = await res.json();
    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
