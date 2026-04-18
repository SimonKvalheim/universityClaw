import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { glob } from 'glob';
import {
  resolveReadPath,
  resolveWritePath,
} from '../../../../../../../../src/voice/path-scope';

const execFileP = promisify(execFile);

const READ_MAX = 256 * 1024;
const WRITE_MAX = 256 * 1024;
const TRUNC_MARKER = '\n\n[truncated at 256 KB — use grep/glob for larger files]';
const DOC_KINDS = new Set(['specs', 'plans', 'mockups', 'sessions']);

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

// ---------- read tools ----------

async function readFileTool(repoRoot: string, args: { path?: string }) {
  if (!args.path) throw new Error('out of scope: missing path');
  const abs = await resolveReadPath(repoRoot, args.path);
  const raw = await fs.readFile(abs, 'utf8');
  if (raw.length > READ_MAX) {
    return { content: raw.slice(0, READ_MAX) + TRUNC_MARKER, truncated: true };
  }
  return { content: raw };
}

function rejectPattern(pattern: string) {
  // Must not start with "/" or contain ".." segments.
  if (!pattern || typeof pattern !== 'string') return true;
  if (pattern.startsWith('/')) return true;
  const normalized = path.posix.normalize(pattern);
  if (normalized.startsWith('..')) return true;
  return false;
}

async function globTool(repoRoot: string, args: { pattern?: string }) {
  if (!args.pattern) throw new Error('out of scope: missing pattern');
  if (rejectPattern(args.pattern)) throw new Error('out of scope: invalid pattern');
  const matches = await glob(args.pattern, {
    cwd: repoRoot,
    nodir: false,
    ignore: [
      'node_modules/**',
      'dashboard/node_modules/**',
      '.git/**',
      '.venv/**',
      'store/**',
      'onecli/**',
      'groups/**',
      'data/**',
      '.env',
      '.env.*',
    ],
    dot: false,
  });
  return { paths: matches.slice(0, 500) };
}

async function grepTool(
  repoRoot: string,
  args: { pattern?: string; glob?: string; path?: string },
) {
  if (!args.pattern) throw new Error('out of scope: missing pattern');
  const globPattern = args.glob || args.path || 'src/**/*.{ts,tsx,md}';
  if (rejectPattern(globPattern)) throw new Error('out of scope: invalid pattern');

  const files = await glob(globPattern, {
    cwd: repoRoot,
    nodir: true,
    ignore: [
      'node_modules/**',
      'dashboard/node_modules/**',
      '.git/**',
      '.venv/**',
      'store/**',
      'onecli/**',
      'groups/**',
      'data/**',
    ],
  });

  const re = new RegExp(args.pattern);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const MAX = 200;

  for (const relFile of files) {
    if (matches.length >= MAX) break;
    try {
      const abs = await resolveReadPath(repoRoot, relFile);
      const body = await fs.readFile(abs, 'utf8');
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push({
            path: relFile,
            line: i + 1,
            text: lines[i].slice(0, 500),
          });
          if (matches.length >= MAX) break;
        }
      }
    } catch {
      // scope rejection or unreadable — skip
    }
  }

  return { matches };
}

async function gitLogTool(
  repoRoot: string,
  args: { limit?: number; path?: string },
) {
  const limit = Math.max(1, Math.min(200, args.limit ?? 10));
  const gitArgs = [
    'log',
    '-n',
    String(limit),
    '--pretty=format:%h%x09%ae%x09%ad%x09%s',
    '--date=iso',
  ];
  if (args.path) {
    // Scope-check the path.
    await resolveReadPath(repoRoot, args.path);
    gitArgs.push('--', args.path);
  }
  try {
    const { stdout } = await execFileP('git', gitArgs, { cwd: repoRoot });
    const commits = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, author, date, ...rest] = line.split('\t');
        return { sha, author, date, subject: rest.join('\t') };
      });
    return { commits };
  } catch {
    return { commits: [] };
  }
}

async function gitStatusTool(repoRoot: string) {
  const branch = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
  })
    .then((r) => r.stdout.trim())
    .catch(() => '');
  const statusOut = await execFileP('git', ['status', '--porcelain'], {
    cwd: repoRoot,
  })
    .then((r) => r.stdout)
    .catch(() => '');
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of statusOut.split('\n')) {
    if (!line) continue;
    const x = line.charAt(0);
    const y = line.charAt(1);
    const file = line.slice(3);
    if (x === '?' && y === '?') untracked.push(file);
    else {
      if (x !== ' ') staged.push(file);
      if (y !== ' ') modified.push(file);
    }
  }
  return { branch, staged, modified, untracked };
}

async function listDocsTool(repoRoot: string, args: { kind?: string }) {
  if (!args.kind || !DOC_KINDS.has(args.kind)) {
    throw new Error('out of scope: unknown kind');
  }
  const map: Record<string, string[]> = {
    specs: ['docs', 'superpowers', 'specs'],
    plans: ['docs', 'superpowers', 'plans'],
    mockups: ['docs', 'superpowers', 'mockups'],
    sessions: ['docs', 'superpowers', 'brainstorm-sessions'],
  };
  const dir = path.join(repoRoot, ...map[args.kind]);
  try {
    const entries = await fs.readdir(dir);
    return { files: entries.filter((n) => !n.startsWith('.')).sort() };
  } catch {
    return { files: [] };
  }
}

async function readDocTool(
  repoRoot: string,
  args: { kind?: string; name?: string },
) {
  if (!args.kind || !DOC_KINDS.has(args.kind)) {
    throw new Error('out of scope: unknown kind');
  }
  if (!args.name || args.name.includes('/') || args.name.includes('..')) {
    throw new Error('out of scope: invalid name');
  }
  const dirMap: Record<string, string[]> = {
    specs: ['docs', 'superpowers', 'specs'],
    plans: ['docs', 'superpowers', 'plans'],
    mockups: ['docs', 'superpowers', 'mockups'],
    sessions: ['docs', 'superpowers', 'brainstorm-sessions'],
  };
  const relative = path.join(...dirMap[args.kind], args.name);
  const abs = await resolveReadPath(repoRoot, relative);
  const raw = await fs.readFile(abs, 'utf8');
  if (raw.length > READ_MAX) {
    return { content: raw.slice(0, READ_MAX) + TRUNC_MARKER, truncated: true };
  }
  return { content: raw };
}

// ---------- write tools ----------

type WriteDocResult =
  | { path: string }
  | { error: string; existingContent?: string };

async function writeDoc(
  repoRoot: string,
  kind: 'specs' | 'plans' | 'mockups',
  slug: string,
  ext: string,
  body: string,
): Promise<WriteDocResult> {
  if (body.length > WRITE_MAX) {
    return {
      error: `content too large: ${body.length} bytes (max ${WRITE_MAX})`,
    };
  }
  const dest = await resolveWritePath(repoRoot, kind, slug, ext);
  try {
    const existing = await fs.readFile(dest, 'utf8');
    if (existing === body) {
      return { path: path.relative(repoRoot, dest) };
    }
    return {
      error: `would overwrite ${dest}`,
      existingContent: existing.slice(0, WRITE_MAX),
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await fs.writeFile(dest, body, 'utf8');
  return { path: path.relative(repoRoot, dest) };
}

function withPreview(
  result: WriteDocResult,
): WriteDocResult & { previewUrl?: string } {
  if ('path' in result) {
    return {
      ...result,
      previewUrl: `/voice/preview?file=${encodeURIComponent(result.path)}`,
    };
  }
  return result;
}

async function writeSpecTool(
  repoRoot: string,
  args: { slug?: string; content?: string },
) {
  if (typeof args.slug !== 'string') throw new Error('invalid slug: missing');
  if (typeof args.content !== 'string')
    throw new Error('out of scope: missing content');
  return writeDoc(repoRoot, 'specs', args.slug, 'md', args.content);
}

async function writePlanTool(
  repoRoot: string,
  args: { slug?: string; content?: string },
) {
  if (typeof args.slug !== 'string') throw new Error('invalid slug: missing');
  if (typeof args.content !== 'string')
    throw new Error('out of scope: missing content');
  return writeDoc(repoRoot, 'plans', args.slug, 'md', args.content);
}

async function writeMockupTool(
  repoRoot: string,
  args: { slug?: string; html?: string },
) {
  if (typeof args.slug !== 'string') throw new Error('invalid slug: missing');
  if (typeof args.html !== 'string')
    throw new Error('out of scope: missing html');
  return withPreview(
    await writeDoc(repoRoot, 'mockups', args.slug, 'html', args.html),
  );
}

async function writeDiagramTool(
  repoRoot: string,
  args: { slug?: string; mermaid?: string; title?: string },
) {
  if (typeof args.slug !== 'string') throw new Error('invalid slug: missing');
  if (typeof args.mermaid !== 'string')
    throw new Error('out of scope: missing mermaid');
  const titleBlock = args.title ? `# ${args.title}\n\n` : '';
  const md = titleBlock + '```mermaid\n' + args.mermaid + '\n```\n';
  return withPreview(
    await writeDoc(repoRoot, 'mockups', args.slug, 'md', md),
  );
}

// ---------- dispatcher ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolFn = (repoRoot: string, args: any) => Promise<unknown>;

const TOOLS: Record<string, ToolFn> = {
  read_file: readFileTool,
  glob: globTool,
  grep: grepTool,
  git_log: gitLogTool,
  git_status: gitStatusTool,
  list_docs: listDocsTool,
  read_doc: readDocTool,
  write_spec: writeSpecTool,
  write_plan: writePlanTool,
  write_mockup: writeMockupTool,
  write_diagram: writeDiagramTool,
};

export async function POST(
  req: Request,
  ctx: { params: Promise<{ tool: string }> },
) {
  if (!isLoopback(req.headers.get('host'))) {
    return NextResponse.json(
      { error: 'voice endpoints are localhost-only' },
      { status: 403 },
    );
  }

  const { tool } = await ctx.params;
  if (!(tool in TOOLS)) {
    return NextResponse.json({ error: 'unknown tool' }, { status: 404 });
  }

  let args: unknown;
  try {
    args = await req.json();
  } catch {
    args = {};
  }

  const repoRoot = getRepoRoot();
  try {
    const out = await TOOLS[tool](repoRoot, args);
    return NextResponse.json(out);
  } catch (err) {
    const message = (err as Error).message ?? 'unknown';
    if (
      message.startsWith('out of scope') ||
      message.startsWith('invalid slug')
    ) {
      return NextResponse.json({ error: message });
    }
    return NextResponse.json(
      { error: 'tool execution failed: ' + message },
      { status: 500 },
    );
  }
}
