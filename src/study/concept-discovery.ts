import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { parseFrontmatter } from '../vault/frontmatter.js';
import type { NewConcept } from './queries.js';

/**
 * Reads promoted vault note paths, parses YAML frontmatter, and returns
 * NewConcept objects for every valid concept note. Pure file I/O — no DB calls.
 *
 * Skipped paths:
 *  - not starting with `concepts/`
 *  - file does not exist
 *  - frontmatter `type` !== 'concept'
 *  - frontmatter has no `title`
 */
export function discoverConcepts(
  promotedPaths: string[],
  vaultDir: string,
): NewConcept[] {
  const results: NewConcept[] = [];

  for (const notePath of promotedPaths) {
    // 1. Only process notes inside the concepts/ directory
    if (!notePath.startsWith('concepts/')) continue;

    // 2. Read the file — skip silently if it does not exist
    let raw: string;
    try {
      raw = readFileSync(join(vaultDir, notePath), 'utf-8');
    } catch {
      continue;
    }

    // 3. Parse frontmatter
    const { data } = parseFrontmatter(raw);

    // 4. Must be type=concept with a title
    if (data['type'] !== 'concept') continue;
    const title = data['title'];
    if (typeof title !== 'string' || title.trim() === '') continue;

    // 5. Map optional fields — fall back to null
    const domain = typeof data['domain'] === 'string' ? data['domain'] : null;
    const subdomain =
      typeof data['subdomain'] === 'string' ? data['subdomain'] : null;
    const course = typeof data['course'] === 'string' ? data['course'] : null;

    results.push({
      id: randomUUID(),
      title: title.trim(),
      domain,
      subdomain,
      course,
      vaultNotePath: notePath,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }

  return results;
}
