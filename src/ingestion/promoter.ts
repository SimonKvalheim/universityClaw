import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  lstatSync,
} from 'fs';
import { join } from 'path';
import { parseFrontmatter, updateFrontmatter } from '../vault/frontmatter.js';
import { toKebabCase } from './utils.js';
import { logger } from '../logger.js';

export interface PromoteResult {
  notePath: string;
  figurePaths: string[];
}

export function promoteNote(
  draftPath: string,
  vaultDir: string,
  jobId: string,
  figuresDir?: string,
): PromoteResult {
  const content = readFileSync(draftPath, 'utf-8');
  const { data: fm } = parseFrontmatter(content);

  const type = fm.type as string;
  const title = fm.title as string;
  const destFolder = type === 'source' ? 'sources' : 'concepts';
  mkdirSync(join(vaultDir, destFolder), { recursive: true });
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

  const notePath = `${destFolder}/${filename}`;
  const noteSlug = filename.slice(0, -3);
  const figurePaths = figuresDir
    ? copyFigures(vaultDir, noteSlug, figuresDir)
    : [];

  // Bake figures into the draft's frontmatter before renaming so the
  // note never lands in the vault without its figure metadata.
  if (figurePaths.length > 0) {
    const updated = updateFrontmatter(content, { figures: figurePaths });
    writeFileSync(draftPath, updated);
  }

  renameSync(draftPath, destPath);

  return { notePath, figurePaths };
}

function copyFigures(
  vaultDir: string,
  slug: string,
  figuresDir: string,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(figuresDir).filter((f) => !f.startsWith('.'));
  } catch {
    logger.warn({ figuresDir, slug }, 'Figures directory not found — skipping');
    return [];
  }

  if (entries.length === 0) return [];

  const attachDir = join(vaultDir, 'attachments', slug);
  mkdirSync(attachDir, { recursive: true });

  const paths: string[] = [];
  for (const entry of entries.sort()) {
    const sourcePath = join(figuresDir, entry);
    try {
      const stat = lstatSync(sourcePath);
      if (!stat.isFile()) {
        logger.warn(
          { figuresDir, slug, entry },
          'Skipping non-regular file in figures dir',
        );
        continue;
      }
      copyFileSync(sourcePath, join(attachDir, entry));
      paths.push(`attachments/${slug}/${entry}`);
    } catch (err) {
      logger.warn({ figuresDir, slug, entry, err }, 'Failed to copy figure');
    }
  }

  return paths;
}
