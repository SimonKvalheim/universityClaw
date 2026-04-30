import { spawn } from 'node:child_process';

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
