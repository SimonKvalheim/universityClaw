import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../vault/frontmatter.js';

export interface NoteManifest {
  source_note: string;
  concept_notes: string[];
}

export function readManifest(
  draftsDir: string,
  jobId: string,
): NoteManifest | null {
  const manifestPath = join(draftsDir, `${jobId}-manifest.json`);
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as NoteManifest;
  } catch {
    return null;
  }
}

export function inferManifest(draftsDir: string, jobId: string): NoteManifest {
  const files = readdirSync(draftsDir).filter(
    (f) => f.startsWith(`${jobId}-`) && f.endsWith('.md'),
  );

  let sourceNote = '';
  const conceptNotes: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(draftsDir, file), 'utf-8');
    const { data: fm } = parseFrontmatter(content);
    if (fm.type === 'source') {
      sourceNote = file;
    } else {
      conceptNotes.push(file);
    }
  }

  return { source_note: sourceNote, concept_notes: conceptNotes };
}
