import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../vault/frontmatter.js';

interface NoteEntry {
  slug: string;
  title: string;
  topics?: string[];
}

function scanDir(dir: string): NoteEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const entries: NoteEntry[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const { data: fm } = parseFrontmatter(content);
      if (!fm.title) continue;

      entries.push({
        slug: file.replace(/\.md$/, ''),
        title: fm.title as string,
        topics: Array.isArray(fm.topics) ? (fm.topics as string[]) : undefined,
      });
    } catch {
      // Skip unreadable files
    }
  }
  return entries;
}

export function buildVaultManifest(vaultDir: string): string {
  const sources = scanDir(join(vaultDir, 'sources'));
  const concepts = scanDir(join(vaultDir, 'concepts'));

  const lines: string[] = ['<existing_vault_notes>', '## Sources'];

  for (const s of sources) {
    lines.push(`- ${s.slug} | "${s.title}"`);
  }

  lines.push('', '## Concepts');

  for (const c of concepts) {
    const topicsSuffix = c.topics?.length
      ? ` | topics: ${c.topics.join(', ')}`
      : '';
    lines.push(`- ${c.slug} | "${c.title}"${topicsSuffix}`);
  }

  lines.push('</existing_vault_notes>');
  return lines.join('\n');
}
