import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseFrontmatter } from '../src/vault/frontmatter.js';

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
}

export async function runBackfill(
  opts: RunBackfillOptions,
): Promise<BackfillReport> {
  await assertNoLiveNanoclaw({ force: opts.force });

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
      // (implementation continues in T23)
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
