import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SUBSYSTEMS } from '../../../../../../../src/voice/subsystem-map';

const execFileP = promisify(execFile);

function isLoopback(host: string | null): boolean {
  if (!host) return false;
  let h = host.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end >= 0 ? h.slice(1, end) : h;
  } else {
    h = h.split(':')[0];
  }
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function getRepoRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith(path.sep + 'dashboard') || cwd.endsWith('/dashboard')
    ? path.resolve(cwd, '..')
    : cwd;
}

async function readOrEmpty(p: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return '';
  }
}

async function readJsonScripts(p: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

async function gitLine(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function listDir(p: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(p);
    return entries.filter((n) => !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  if (!isLoopback(req.headers.get('host'))) {
    return NextResponse.json(
      { error: 'voice endpoints are localhost-only' },
      { status: 403 },
    );
  }

  const repoRoot = getRepoRoot();
  const warnings: string[] = [];

  const claudeMd = await readOrEmpty(path.join(repoRoot, 'CLAUDE.md'));
  if (!claudeMd) warnings.push('CLAUDE.md missing');

  const architecture = await readOrEmpty(
    path.join(repoRoot, 'docs', 'ARCHITECTURE.md'),
  );
  if (!architecture) warnings.push('docs/ARCHITECTURE.md missing');

  const rootScripts = await readJsonScripts(path.join(repoRoot, 'package.json'));
  const dashboardScripts = await readJsonScripts(
    path.join(repoRoot, 'dashboard', 'package.json'),
  );

  const branch = await gitLine(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const statusShort = await gitLine(repoRoot, ['status', '--short']);
  const logOut = await gitLine(repoRoot, [
    'log',
    '-n',
    '10',
    '--pretty=format:%h%x09%s',
  ]);
  const recentCommits = logOut
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split('\t');
      return { sha, subject: rest.join('\t') };
    });

  const specNames = await listDir(
    path.join(repoRoot, 'docs', 'superpowers', 'specs'),
  );
  const planNames = await listDir(
    path.join(repoRoot, 'docs', 'superpowers', 'plans'),
  );

  const body = {
    claudeMd,
    architecture,
    subsystemMap: SUBSYSTEMS,
    scripts: { root: rootScripts, dashboard: dashboardScripts },
    repoState: {
      branch,
      statusShort,
      recentCommits,
      specNames,
      planNames,
    },
    sessionMeta: {
      generatedAt: new Date().toISOString(),
    },
    ...(warnings.length ? { warnings } : {}),
  };

  return NextResponse.json(body);
}
