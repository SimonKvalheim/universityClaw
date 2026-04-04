const LIGHTRAG_URL = process.env.LIGHTRAG_URL || 'http://localhost:9621';

async function fetchJson(path: string) {
  const res = await fetch(`${LIGHTRAG_URL}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`LightRAG ${path}: ${res.status}`);
  return res.json();
}

export async function GET() {
  try {
    const [health, counts, pipeline] = await Promise.all([
      fetchJson('/health'),
      fetchJson('/documents/status_counts'),
      fetchJson('/documents/pipeline_status'),
    ]);

    // When there are failed docs, fetch their details
    let failedDocs: unknown[] = [];
    if (counts.status_counts?.failed > 0) {
      try {
        const res = await fetch(`${LIGHTRAG_URL}/documents/paginated`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status_filter: 'failed',
            page: 1,
            page_size: 50,
            sort_field: 'updated_at',
            sort_direction: 'desc',
          }),
          cache: 'no-store',
        });
        if (res.ok) {
          const data = await res.json();
          failedDocs = data.documents || [];
        }
      } catch {
        // non-critical
      }
    }

    // When processing, fetch those docs too
    let processingDocs: unknown[] = [];
    const inProgress =
      (counts.status_counts?.processing || 0) +
      (counts.status_counts?.pending || 0) +
      (counts.status_counts?.preprocessed || 0);
    if (inProgress > 0) {
      try {
        const fetches = [];
        if (counts.status_counts?.processing > 0)
          fetches.push(
            fetch(`${LIGHTRAG_URL}/documents/paginated`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status_filter: 'processing', page: 1, page_size: 50 }),
              cache: 'no-store',
            }).then((r) => (r.ok ? r.json() : { documents: [] })),
          );
        if (counts.status_counts?.pending > 0)
          fetches.push(
            fetch(`${LIGHTRAG_URL}/documents/paginated`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status_filter: 'pending', page: 1, page_size: 50 }),
              cache: 'no-store',
            }).then((r) => (r.ok ? r.json() : { documents: [] })),
          );
        if (counts.status_counts?.preprocessed > 0)
          fetches.push(
            fetch(`${LIGHTRAG_URL}/documents/paginated`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status_filter: 'preprocessed', page: 1, page_size: 50 }),
              cache: 'no-store',
            }).then((r) => (r.ok ? r.json() : { documents: [] })),
          );
        const results = await Promise.all(fetches);
        processingDocs = results.flatMap((r) => r.documents || []);
      } catch {
        // non-critical
      }
    }

    return Response.json({
      health: {
        status: health.status,
        pipeline_busy: health.pipeline_busy,
        llm_binding: health.configuration?.llm_binding,
        llm_model: health.configuration?.llm_model,
        embedding_binding: health.configuration?.embedding_binding,
        embedding_model: health.configuration?.embedding_model,
      },
      counts: counts.status_counts,
      pipeline: {
        busy: pipeline.busy,
        job_name: pipeline.job_name,
        job_start: pipeline.job_start,
        docs: pipeline.docs,
        cur_batch: pipeline.cur_batch,
        batchs: pipeline.batchs,
        latest_message: pipeline.latest_message,
      },
      failedDocs,
      processingDocs,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
