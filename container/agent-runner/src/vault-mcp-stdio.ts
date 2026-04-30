import { readFileSync } from 'node:fs';

const MAX_RANGE_LINES = 500;

export interface VaultSectionResult {
  header: string;
  content: string;
  multipleMatches?: number;
  matchingHeadings?: string[];
  notFound?: boolean;
  availableSections?: string[];
  truncated?: boolean;
}

export type VaultSectionLocator =
  | { section: string }
  | { page: number }
  | { range: { start: number; end: number } };

interface ParsedHeading {
  line: number;
  text: string;
  level: number;
}

function parseHeadings(lines: string[]): ParsedHeading[] {
  const heads: ParsedHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) heads.push({ line: i, text: m[2], level: m[1].length });
  }
  return heads;
}

// Verified Docling marker format:
//   <!-- page:1 label:section_header -->
// Multiple markers per page (one per chunk). Capture the integer after `page:`.
const PAGE_MARKER_RE = /^<!-- page:(\d+) /;

function pageOfLine(lines: string[], targetLine: number): number {
  for (let i = Math.min(targetLine, lines.length - 1); i >= 0; i--) {
    const m = lines[i].match(PAGE_MARKER_RE);
    if (m) return parseInt(m[1], 10);
  }
  return 1;
}

function findPageBoundaries(lines: string[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PAGE_MARKER_RE);
    if (m) {
      const page = parseInt(m[1], 10);
      if (!map.has(page)) map.set(page, i); // keep first marker only
    }
  }
  return map;
}

function nearestHeadingAtOrBefore(
  headings: ParsedHeading[],
  line: number,
): string | undefined {
  for (let i = headings.length - 1; i >= 0; i--) {
    if (headings[i].line <= line) return headings[i].text;
  }
  return undefined;
}

export function vaultSection(
  filePath: string,
  locator: VaultSectionLocator,
): VaultSectionResult {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const headings = parseHeadings(lines);

  if ('section' in locator) {
    const needle = locator.section.toLowerCase();
    const matches = headings.filter((h) =>
      h.text.toLowerCase().includes(needle),
    );
    if (matches.length === 0) {
      return {
        header: `File: ${filePath} / Section: <not found>`,
        content: '',
        notFound: true,
        availableSections: headings.map((h) => h.text),
      };
    }
    const chosen = matches[0];
    const next = headings.find(
      (h) => h.line > chosen.line && h.level <= chosen.level,
    );
    const startLine = chosen.line;
    const endLine = next ? next.line - 1 : lines.length - 1;
    const content = lines.slice(startLine, endLine + 1).join('\n');
    const page = pageOfLine(lines, startLine);
    const result: VaultSectionResult = {
      header: `File: ${filePath} / Section: ${chosen.text} / Page ${page} / Lines ${startLine + 1}-${endLine + 1}`,
      content,
    };
    if (matches.length > 1) {
      result.multipleMatches = matches.length;
      result.matchingHeadings = matches.map((m) => m.text);
    }
    return result;
  }

  if ('page' in locator) {
    const boundaries = findPageBoundaries(lines);
    const totalPages = boundaries.size;
    const start = boundaries.get(locator.page);
    if (start === undefined) {
      return {
        header: `File: ${filePath} / Section: <not found> / Page <not found> / total pages: ${totalPages}`,
        content: '',
        notFound: true,
      };
    }
    const next = boundaries.get(locator.page + 1);
    const endLine = next !== undefined ? next - 1 : lines.length - 1;
    const section = nearestHeadingAtOrBefore(headings, start) ?? '<page-only>';
    return {
      header: `File: ${filePath} / Section: ${section} / Page ${locator.page} / Lines ${start + 1}-${endLine + 1}`,
      content: lines.slice(start, endLine + 1).join('\n'),
    };
  }

  if ('range' in locator) {
    const startIdx = Math.max(0, locator.range.start - 1);
    const requestedEnd = Math.max(startIdx, locator.range.end - 1);
    const cappedEnd = Math.min(
      requestedEnd,
      startIdx + MAX_RANGE_LINES - 1,
      lines.length - 1,
    );
    const truncated = cappedEnd < requestedEnd;
    const content = lines.slice(startIdx, cappedEnd + 1).join('\n');
    const section = nearestHeadingAtOrBefore(headings, startIdx) ?? '<range>';
    const page = pageOfLine(lines, startIdx);
    return {
      header: `File: ${filePath} / Section: ${section} / Page ${page} / Lines ${startIdx + 1}-${cappedEnd + 1}`,
      content,
      truncated: truncated || undefined,
    };
  }

  const _exhaust: never = locator;
  throw new Error(`Unhandled locator: ${JSON.stringify(_exhaust)}`);
}

// ---------------------------------------------------------------------------
// Stdio entry point — matches sibling rag-mcp-stdio.ts pattern.
// Guarded so that importing vaultSection from tests does NOT trigger the
// server bootstrap (rag-mcp-stdio.ts has no guard because it's never imported
// from tests — our file IS, so we need one).
// ---------------------------------------------------------------------------

const isMainModule = import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const { join } = await import('node:path');

  const VAULT_DIR = process.env.VAULT_DIR;
  if (!VAULT_DIR) throw new Error('VAULT_DIR env var required');

  const server = new McpServer({
    name: 'vault',
    version: '1.0.0',
  });

  server.tool(
    'vault_section',
    `Extract a section, page, or line range from a vault markdown file.
Returns a header line + content. Use exactly one of \`section\`, \`page\`, or \`range\` per call.

Use this for reading library files (vault/library/*.md), which can be very large — section/page lookups
let you read targeted parts without exhausting context. The header line includes File, Section, Page,
and Lines so you can cite precisely.

Behavior:
• section — case-insensitive substring match on H1/H2/H3 headings. First match wins on collision;
  multipleMatches and matchingHeadings are populated. Miss returns availableSections list.
• page — uses Docling page markers in the file. Returns content from the start of page N to the
  start of page N+1. Section field is the nearest heading at-or-before the page start, or "<page-only>".
• range — line range, capped at 500 lines (truncated:true is set when capped).`,
    {
      path: z
        .string()
        .describe('Vault-relative path, e.g. "library/foo.md"'),
      section: z
        .string()
        .optional()
        .describe('Heading text (case-insensitive substring match)'),
      page: z
        .number()
        .int()
        .optional()
        .describe('Page number (uses Docling page markers)'),
      range: z
        .object({
          start: z.number().int().describe('Start line (1-based, inclusive)'),
          end: z.number().int().describe('End line (1-based, inclusive)'),
        })
        .optional()
        .describe('Line range; capped at 500 lines'),
    },
    async (args) => {
      const fullPath = join(VAULT_DIR, args.path);
      let locator: VaultSectionLocator;
      if (args.section !== undefined) {
        locator = { section: args.section };
      } else if (args.page !== undefined) {
        locator = { page: args.page };
      } else if (args.range !== undefined) {
        locator = { range: args.range };
      } else {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: provide exactly one of: section, page, range',
            },
          ],
          isError: true,
        };
      }

      try {
        const result = vaultSection(fullPath, locator);
        return {
          content: [{ type: 'text' as const, text: formatResult(result) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: 'text' as const, text: `vault_section error: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  function formatResult(r: VaultSectionResult): string {
    const lines = [r.header];
    if (r.notFound && r.availableSections) {
      lines.push('', 'Available sections:', ...r.availableSections.map((s) => `- ${s}`));
    } else {
      if (r.multipleMatches) {
        lines.push(
          `(multiple_matches: ${r.multipleMatches}, matching: ${r.matchingHeadings?.join(', ')})`,
        );
      }
      if (r.truncated) lines.push('(truncated to 500 lines)');
      lines.push('', r.content);
    }
    return lines.join('\n');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
