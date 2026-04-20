import { logger } from '../logger.js';

export interface RagConfig {
  serverUrl: string;
  /** @deprecated kept for indexer compatibility, not used by HTTP client */
  workingDir?: string;
  /** @deprecated kept for indexer compatibility, not used by HTTP client */
  vaultDir?: string;
}

export interface RagResult {
  answer: string;
  sources: string[];
}

export class RagClient {
  private serverUrl: string;

  constructor(private config: RagConfig) {
    this.serverUrl = config.serverUrl.replace(/\/$/, '');
  }

  buildQuery(query: string, filters?: Record<string, string>): string {
    let enriched = query;
    if (filters) {
      const filterStr = Object.entries(filters)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      enriched = `[Context: ${filterStr}] ${query}`;
    }
    return enriched;
  }

  async query(
    question: string,
    mode: 'naive' | 'local' | 'global' | 'hybrid' | 'mix' = 'hybrid',
    filters?: Record<string, string>,
  ): Promise<RagResult> {
    const enriched = this.buildQuery(question, filters);
    try {
      const res = await fetch(`${this.serverUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: enriched,
          mode,
          only_need_context: true,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LightRAG query failed (${res.status}): ${text}`);
      }
      const data: unknown = await res.json();
      // Server returns { response: "..." } when only_need_context is true
      const answer =
        typeof data === 'string'
          ? data
          : ((data as Record<string, unknown>).response ?? '');
      return { answer: String(answer).trim(), sources: [] };
    } catch (err) {
      logger.warn({ err }, 'RAG query failed');
      return { answer: '', sources: [] };
    }
  }

  async index(
    text: string,
    options: {
      fileSource?: string;
      pollIntervalMs?: number;
      pollTimeoutMs?: number;
    } = {},
  ): Promise<void> {
    const {
      fileSource,
      pollIntervalMs = 2000,
      pollTimeoutMs = 300_000,
    } = options;

    const res = await fetch(`${this.serverUrl}/documents/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, file_source: fileSource }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LightRAG index failed (${res.status}): ${body}`);
    }

    const { status, track_id, message } = (await res.json()) as {
      status: 'success' | 'duplicated' | 'partial_success' | 'failure';
      track_id: string;
      message: string;
    };

    if (status === 'failure') {
      throw new Error(`LightRAG index rejected: ${message}`);
    }
    if (status === 'duplicated') {
      return;
    }
    if (status === 'partial_success') {
      logger.warn(
        { track_id, message },
        'LightRAG reported partial_success on insert; polling for final status',
      );
    }

    const deadline = Date.now() + pollTimeoutMs;
    while (Date.now() < deadline) {
      const statusRes = await fetch(
        `${this.serverUrl}/documents/track_status/${encodeURIComponent(track_id)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!statusRes.ok) {
        const body = await statusRes.text().catch(() => '');
        throw new Error(
          `LightRAG track_status failed (${statusRes.status}): ${body}`,
        );
      }
      const { status_summary } = (await statusRes.json()) as {
        status_summary: Record<string, number>;
      };
      const pending =
        (status_summary['DocStatus.PENDING'] ?? 0) +
        (status_summary['DocStatus.PROCESSING'] ?? 0) +
        (status_summary['DocStatus.PREPROCESSED'] ?? 0);
      const failed = status_summary['DocStatus.FAILED'] ?? 0;
      const processed = status_summary['DocStatus.PROCESSED'] ?? 0;
      const total = pending + failed + processed;

      // Empty summary means the doc hasn't been registered with the track_id
      // yet — LightRAG processes POSTs asynchronously. Keep polling.
      if (total > 0 && pending === 0) {
        if (failed > 0) {
          throw new Error(
            `LightRAG indexing failed for track ${track_id}: ${JSON.stringify(status_summary)}`,
          );
        }
        if (processed > 0) return;
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(
      `LightRAG indexing timed out after ${pollTimeoutMs}ms for track ${track_id}`,
    );
  }

  async deleteDocument(docId: string): Promise<void> {
    const res = await fetch(`${this.serverUrl}/documents`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [docId] }),
      signal: AbortSignal.timeout(30_000),
    });
    // 404 is fine — doc may already be gone
    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => '');
      throw new Error(`LightRAG delete failed (${res.status}): ${body}`);
    }
  }

  async entityExists(name: string): Promise<boolean> {
    try {
      const url = `${this.serverUrl}/graph/entity/exists?name=${encodeURIComponent(name)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return false;
      const data: unknown = await res.json();
      // API returns { exists: true/false }
      return (data as Record<string, unknown>).exists === true;
    } catch {
      return false;
    }
  }

  async createRelation(
    sourceEntity: string,
    targetEntity: string,
    relationData: Record<string, unknown>,
  ): Promise<void> {
    const res = await fetch(`${this.serverUrl}/graph/relation/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_entity: sourceEntity,
        target_entity: targetEntity,
        relation_data: relationData,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `LightRAG create relation failed (${res.status}): ${body}`,
      );
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
