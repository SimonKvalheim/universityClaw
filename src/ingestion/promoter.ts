import { readFileSync, renameSync, existsSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../vault/frontmatter.js';
import { toKebabCase } from './utils.js';

export function promoteNote(
  draftPath: string,
  vaultDir: string,
  jobId: string,
): string {
  const content = readFileSync(draftPath, 'utf-8');
  const { data: fm } = parseFrontmatter(content);

  const type = fm.type as string;
  const title = fm.title as string;
  const destFolder = type === 'source' ? 'sources' : 'concepts';
  const slug = toKebabCase(title);

  let filename = `${slug}.md`;
  let destPath = join(vaultDir, destFolder, filename);

  if (existsSync(destPath)) {
    const hash = jobId.slice(0, 4);
    filename = `${slug}-${hash}.md`;
    destPath = join(vaultDir, destFolder, filename);
  }
  if (existsSync(destPath)) {
    let i = 2;
    do {
      filename = `${slug}-${jobId.slice(0, 4)}-${i}.md`;
      destPath = join(vaultDir, destFolder, filename);
      i++;
    } while (existsSync(destPath));
  }

  renameSync(draftPath, destPath);
  return `${destFolder}/${filename}`;
}
