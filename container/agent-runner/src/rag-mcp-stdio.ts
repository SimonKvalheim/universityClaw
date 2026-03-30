/**
 * Stdio MCP Server for LightRAG vault search.
 * Runs inside agent containers, proxies queries to the LightRAG HTTP server
 * running on the host via LIGHTRAG_URL (default: http://host.docker.internal:9621).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const LIGHTRAG_URL = (process.env.LIGHTRAG_URL || 'http://host.docker.internal:9621').replace(/\/$/, '');

const server = new McpServer({
  name: 'rag',
  version: '1.0.0',
});

server.tool(
  'vault_search',
  `Search the Obsidian vault using semantic graph+vector search (LightRAG).
Returns relevant context from indexed vault notes — concepts, sources, and archived profile entries.

Query modes:
• "hybrid" (default) — combines local entity relationships + global themes. Best for most questions.
• "local" — focuses on specific entities and their direct relationships. Good for "what is X?" questions.
• "global" — high-level thematic search. Good for broad "how does X relate to Y?" questions.
• "naive" — simple vector similarity search without knowledge graph. Fastest, but less precise.

The response contains retrieved context from the vault, with source attributions. Use this to ground your answers in vault content.`,
  {
    query: z.string().min(3).describe('The search query (natural language question or topic)'),
    mode: z.enum(['naive', 'local', 'global', 'hybrid']).default('hybrid').describe('Search mode'),
  },
  async (args) => {
    try {
      const res = await fetch(`${LIGHTRAG_URL}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: args.query,
          mode: args.mode,
          only_need_context: true,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          content: [{ type: 'text' as const, text: `LightRAG query failed (${res.status}): ${body}` }],
          isError: true,
        };
      }

      const data = await res.json();
      const answer = typeof data === 'string' ? data : (data.response ?? JSON.stringify(data));

      if (!answer || answer.trim() === '') {
        return {
          content: [{ type: 'text' as const, text: 'No relevant results found in the vault for this query.' }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: answer }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `LightRAG search error: ${msg}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'vault_index',
  `Index new text content into the vault's semantic search database.
Use this after creating or significantly updating vault notes, so they become searchable.
The text should include metadata context (title, type, topics) for better retrieval.`,
  {
    text: z.string().min(10).describe('The text content to index (include title/metadata context for best results)'),
  },
  async (args) => {
    try {
      const res = await fetch(`${LIGHTRAG_URL}/documents/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: args.text }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          content: [{ type: 'text' as const, text: `LightRAG index failed (${res.status}): ${body}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: 'Content indexed successfully.' }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `LightRAG index error: ${msg}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
