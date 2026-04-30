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
