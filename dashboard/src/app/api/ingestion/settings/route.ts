import { getSettings, updateSettings } from '@/lib/ingestion-db';

export async function GET() {
  try {
    const settings = getSettings();
    return Response.json(settings);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as unknown;

    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>).maxGenerationConcurrent !==
        'number'
    ) {
      return Response.json(
        { error: 'Invalid body: maxGenerationConcurrent must be a number' },
        { status: 400 },
      );
    }

    const { maxGenerationConcurrent } = body as {
      maxGenerationConcurrent: number;
    };
    updateSettings({ maxGenerationConcurrent });
    const updated = getSettings();
    return Response.json(updated);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
