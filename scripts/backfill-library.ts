import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseFrontmatter, serializeFrontmatter } from '../src/vault/frontmatter.js';
import { writeLibraryFile } from '../src/ingestion/library-writer.js';
import { deleteTrackedDoc } from '../src/db/index.js';

export interface ExtractorLike {
  extract(
    jobId: string,
    inputPath: string,
  ): Promise<{ cleanContentPath: string }>;
}

export interface IndexerLike {
  start(): Promise<void> | void;
  indexFile(filePath: string): Promise<void>;
}

export interface AssertOptions {
  spawn?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  force?: boolean;
}

async function defaultSpawn(
  cmd: string,
  args: string[],
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.on('close', (code) =>
      code === 0 ? resolve({ stdout }) : reject(new Error(`exit ${code}`)),
    );
    child.on('error', (err) => reject(err));
  });
}

export async function assertNoLiveNanoclaw(
  opts: AssertOptions = {},
): Promise<void> {
  if (opts.force) return;
  const sp = opts.spawn ?? defaultSpawn;
  const { stdout } = await sp('ps', ['-axo', 'pid=,command=']);
  if (/tsx src\/index\.ts/.test(stdout)) {
    throw new Error(
      'NanoClaw is running. Stop it before running backfill (or pass --force-unsafe-concurrent for testing).',
    );
  }
}

export interface BackfillReport {
  startedAt: string;
  endedAt: string;
  totalSources: number;
  processed: number;
  skipped: { slug: string; reason: string; details?: string }[];
  errors: { slug: string; message: string }[];
}

export interface RunBackfillOptions {
  vaultDir: string;
  uploadProcessedDir: string;
  reportPath: string;
  dryRun: boolean;
  source?: string; // single slug
  noPatchSource?: boolean;
  force?: boolean;
  extractor?: ExtractorLike; // injected for testability; CLI builds a real Extractor adapter
  indexer?: IndexerLike; // injected for testability; CLI builds a real RagIndexer
}

export async function runBackfill(
  opts: RunBackfillOptions,
): Promise<BackfillReport> {
  await assertNoLiveNanoclaw({ force: opts.force });

  if (!opts.dryRun && opts.indexer) {
    await opts.indexer.start();
  }

  const sourcesDir = join(opts.vaultDir, 'sources');
  const allSources = readdirSync(sourcesDir).filter((f) => f.endsWith('.md'));
  const targets = opts.source
    ? allSources.filter((f) => f === `${opts.source}.md`)
    : allSources;

  const report: BackfillReport = {
    startedAt: new Date().toISOString(),
    endedAt: '',
    totalSources: targets.length,
    processed: 0,
    skipped: [],
    errors: [],
  };

  for (const file of targets) {
    const slug = file.replace(/\.md$/, '');
    try {
      const raw = readFileSync(join(sourcesDir, file), 'utf-8');
      const { data: fm } = parseFrontmatter(raw);

      if (fm.library) {
        report.skipped.push({ slug, reason: 'skipped_existing' });
        continue;
      }

      const sourceFile = String(fm.source_file || '');
      // The source_file is vault-relative (e.g. "upload/processed/...pdf").
      // Resolve it to an absolute path: opts.vaultDir is .../vault, so join with
      // ".." to get the project root.
      const originalPath = sourceFile
        ? join(opts.vaultDir, '..', sourceFile)
        : '';
      if (!originalPath || !existsSync(originalPath)) {
        report.skipped.push({
          slug,
          reason: 'missing_original',
          details: sourceFile,
        });
        continue;
      }

      // T22 ships dry-run-only counting; T23 adds extract + write + patch.
      if (opts.dryRun) {
        report.processed++;
        continue;
      }

      // Execute path (non-dry-run): re-extract, write library, patch source, delete tracker.
      if (!opts.extractor) {
        // Configuration error — should have been caught by the CLI/caller.
        throw new Error('runBackfill: extractor is required when dryRun is false');
      }

      const jobId = `backfill-${Date.now()}-${slug}`;
      const { cleanContentPath } = await opts.extractor.extract(jobId, originalPath);
      const cleanedBody = readFileSync(cleanContentPath, 'utf-8');

      writeLibraryFile({
        libraryDir: join(opts.vaultDir, 'library'),
        slug,
        jobMeta: {
          title: String(fm.title || slug),
          sourceType: String(fm.source_type || 'paper'),
          ingestedFrom: sourceFile,
          jobId,
          sourceSummarySlug: slug,
        },
        cleanedBody,
      });

      if (!opts.noPatchSource) {
        const { content: body } = parseFrontmatter(raw);
        const patchedFm = { ...fm, library: `[[library/${slug}]]` };
        const patched = serializeFrontmatter(patchedFm, body);
        const sourcePath = join(sourcesDir, file);
        const tmpPath = `${sourcePath}.tmp.${process.pid}.${Date.now()}`;
        writeFileSync(tmpPath, patched, 'utf-8');
        renameSync(tmpPath, sourcePath);
        deleteTrackedDoc(`sources/${slug}.md`);
      }

      report.processed++;

      if (opts.indexer) {
        const libraryPath = join(opts.vaultDir, 'library', `${slug}.md`);
        await opts.indexer.indexFile(libraryPath);
        if (!opts.noPatchSource) {
          const sourcePath = join(sourcesDir, file);
          await opts.indexer.indexFile(sourcePath);
        }
      }
    } catch (err) {
      report.errors.push({
        slug,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  report.endedAt = new Date().toISOString();
  writeFileSync(opts.reportPath, JSON.stringify(report, null, 2), 'utf-8');
  return report;
}

// CLI entry — invoked via tsx scripts/backfill-library.ts
// T21 ships only the guard + skeleton; T22-T25 will add the walker, extract,
// patch, indexing, and CLI flag parsing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes('--force-unsafe-concurrent');
  await assertNoLiveNanoclaw({ force });
  console.log(
    'backfill skeleton: guard passed. Logic added in T22-T25.',
  );
}
