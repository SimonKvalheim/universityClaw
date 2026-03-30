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

  async index(text: string): Promise<void> {
    const res = await fetch(`${this.serverUrl}/documents/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LightRAG index failed (${res.status}): ${body}`);
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
