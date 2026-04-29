import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeFrontmatter } from '../vault/frontmatter.js';

let _tmpSeq = 0;

export interface LibraryJobMeta {
  title: string;
  sourceType: string;
  ingestedFrom: string;
  jobId: string;
  sourceSummarySlug: string | undefined;
}

export interface WriteLibraryFileInput {
  libraryDir: string;
  slug: string;
  jobMeta: LibraryJobMeta;
  cleanedBody: string;
}

export function writeLibraryFile(input: WriteLibraryFileInput): string {
  const { libraryDir, slug, jobMeta, cleanedBody } = input;
  mkdirSync(libraryDir, { recursive: true });

  const fm: Record<string, unknown> = {
    title: jobMeta.title,
    type: 'library',
    source_type: jobMeta.sourceType,
    ingested_from: jobMeta.ingestedFrom,
    job_id: jobMeta.jobId,
    indexed: false,
  };
  if (jobMeta.sourceSummarySlug) {
    fm.source_summary = `[[${jobMeta.sourceSummarySlug}]]`;
  }

  const finalPath = join(libraryDir, `${slug}.md`);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${++_tmpSeq}`;
  const content = serializeFrontmatter(fm, cleanedBody);

  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, finalPath);
  return finalPath;
}
