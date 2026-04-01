import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { parseFrontmatter, updateFrontmatter } from '../vault/frontmatter.js';
import { insertCitationEdge, deleteCitationEdges } from '../db.js';
import { logger } from '../logger.js';

export interface BibEntry {
  lastName: string;
  year: string;
}

/**
 * Normalize an author name: lowercase, strip diacritics, collapse whitespace.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a bibliography entry to extract the first author's last name and year.
 * Targets APA-style format: "LastName, Initials. (YYYY)"
 * Returns null if the entry doesn't match.
 */
export function parseBibEntry(text: string): BibEntry | null {
  // Match: starts with word chars (author last name), comma, then somewhere a (YYYY) year
  const match = text.match(/^([A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'\-.\s]*?),\s.*?\((\d{4})[a-z]?\)/);
  if (!match) return null;

  const lastName = normalizeName(match[1]);
  const year = match[2];

  return { lastName, year };
}

/**
 * Extract bibliography entries from Docling-extracted content.
 * Looks for a cluster of 3+ consecutive list_item markers at the end of the
 * document where at least 50% contain a 4-digit year in parentheses.
 */
export function extractBibliography(content: string): BibEntry[] {
  const lines = content.split('\n');

  // Find all list_item blocks: marker line followed by text content
  interface ListItemBlock {
    lineIndex: number;
    text: string;
  }
  const listItems: ListItemBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/<!-- page:\d+ label:list_item -->/.test(lines[i])) {
      // Collect text lines until next marker or empty line
      const textLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();
        if (line === '' || /<!-- page:\d+/.test(line)) break;
        textLines.push(line);
      }
      if (textLines.length > 0) {
        listItems.push({ lineIndex: i, text: textLines.join(' ') });
      }
    }
  }

  if (listItems.length < 3) return [];

  // Find the largest contiguous cluster (allowing up to 2 non-marker, non-empty
  // lines between items) scanning from the end of the document
  let clusterEnd = listItems.length - 1;
  let clusterStart = clusterEnd;

  for (let i = listItems.length - 2; i >= 0; i--) {
    // Count non-marker, non-empty lines between consecutive list_item blocks
    let nonMarkerLines = 0;
    for (let ln = listItems[i].lineIndex + 1; ln < listItems[i + 1].lineIndex; ln++) {
      const line = lines[ln].trim();
      if (line === '' || /<!-- page:\d+/.test(line)) continue;
      nonMarkerLines++;
    }
    if (nonMarkerLines > 2) break;
    clusterStart = i;
  }

  const cluster = listItems.slice(clusterStart, clusterEnd + 1);
  if (cluster.length < 3) return [];

  // Check: at least 50% contain a 4-digit year in parentheses
  const withYear = cluster.filter((item) => /\(\d{4}[a-z]?\)/.test(item.text));
  if (withYear.length / cluster.length < 0.5) return [];

  // Parse each entry
  const entries: BibEntry[] = [];
  for (const item of cluster) {
    const parsed = parseBibEntry(item.text);
    if (parsed) entries.push(parsed);
  }

  return entries;
}
