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
  const match = text.match(
    /^([A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'\-.\s]*?),\s.*?\((\d{4})[a-z]?\)/,
  );
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
    for (
      let ln = listItems[i].lineIndex + 1;
      ln < listItems[i + 1].lineIndex;
      ln++
    ) {
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

interface SourceInfo {
  slug: string;
  filePath: string;
}

/**
 * Build an index of existing source notes keyed by normalized "lastname:year".
 * Each author in the source's authors array gets their own key.
 */
export function buildSourceIndex(
  sourcesDir: string,
): Map<string, SourceInfo[]> {
  const index = new Map<string, SourceInfo[]>();

  let files: string[];
  try {
    files = readdirSync(sourcesDir).filter((f) => f.endsWith('.md'));
  } catch {
    return index;
  }

  for (const file of files) {
    try {
      const content = readFileSync(join(sourcesDir, file), 'utf-8');
      const { data: fm } = parseFrontmatter(content);

      const authors = fm.authors as string[] | undefined;
      const published = fm.published as number | undefined;
      if (!Array.isArray(authors) || !published) continue;

      const slug = file.replace(/\.md$/, '');
      const info: SourceInfo = { slug, filePath: join(sourcesDir, file) };

      for (const author of authors) {
        const parts = author.trim().split(/\s+/);
        const lastName = normalizeName(parts[parts.length - 1]);
        const key = `${lastName}:${published}`;

        const existing = index.get(key) ?? [];
        existing.push(info);
        index.set(key, existing);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return index;
}

/**
 * Append a value to an array frontmatter field, avoiding duplicates.
 * Reads the file, updates, writes back.
 */
function appendFrontmatterArray(
  filePath: string,
  field: string,
  value: string,
): void {
  const content = readFileSync(filePath, 'utf-8');
  const { data: fm } = parseFrontmatter(content);
  const existing = Array.isArray(fm[field]) ? (fm[field] as string[]) : [];
  if (existing.includes(value)) return;
  const updated = updateFrontmatter(content, {
    [field]: [...existing, value],
  });
  writeFileSync(filePath, updated);
}

/**
 * Link bibliography entries to existing vault sources.
 * Writes cites/cited_by frontmatter and SQLite edges.
 */
export function linkCitations(
  bibEntries: BibEntry[],
  newSourcePath: string,
  sourcesDir: string,
): void {
  const index = buildSourceIndex(sourcesDir);
  const newSlug = basename(newSourcePath).replace(/\.md$/, '');
  const matched = new Set<string>();

  for (const entry of bibEntries) {
    const key = `${entry.lastName}:${entry.year}`;
    const sources = index.get(key);
    if (!sources) continue;

    for (const source of sources) {
      // Don't self-cite
      if (source.slug === newSlug) continue;
      if (matched.has(source.slug)) continue;
      matched.add(source.slug);

      // SQLite edge
      try {
        insertCitationEdge(newSlug, source.slug);
      } catch (err) {
        logger.warn(
          { err, newSlug, targetSlug: source.slug },
          'Failed to insert citation edge',
        );
      }

      // Frontmatter: cites on new source
      appendFrontmatterArray(newSourcePath, 'cites', source.slug);

      // Frontmatter: cited_by on matched source
      appendFrontmatterArray(source.filePath, 'cited_by', newSlug);
    }
  }
}

/**
 * Filter out slugs that don't correspond to existing files.
 * Safety net for stale references.
 */
export function filterDeadReferences(
  slugs: string[],
  sourcesDir: string,
): string[] {
  return slugs.filter((slug) => existsSync(join(sourcesDir, `${slug}.md`)));
}
