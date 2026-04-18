import fs from 'node:fs/promises';
import path from 'node:path';

const SLUG_RE = /^[a-z0-9-]{1,80}$/;

const ALLOWED_TOP_DIRS = new Set([
  'src',
  'container',
  'docs',
  'scripts',
  'public',
]);

const ALLOWED_ROOT_CONFIGS = new Set([
  'package.json',
  'tsconfig.json',
  'next.config.ts',
  'vitest.config.ts',
  'eslint.config.mjs',
  'postcss.config.mjs',
  'README.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
]);

const DENIED_SEGMENTS = new Set([
  'store',
  'onecli',
  'groups',
  'data',
  'node_modules',
  '.venv',
  '.git',
]);

export function sanitizeSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    const truncated = slug.length > 40 ? slug.slice(0, 40) + '...' : slug;
    throw new Error('invalid slug: ' + truncated);
  }
  return slug;
}

/**
 * Resolve the longest existing prefix of `p` via fs.realpath, then re-append
 * any non-existent suffix. Prevents ENOENT crashes on missing final segments
 * while still following symlinks for existing portions.
 */
async function safeRealpath(p: string): Promise<string> {
  const parts = p.split(path.sep);
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join(path.sep) || path.sep;
    try {
      const real = await fs.realpath(prefix);
      return path.join(real, ...parts.slice(i));
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw e;
    }
  }
  return p;
}

function isDeniedSegment(seg: string): boolean {
  if (seg.startsWith('.env')) return true;
  return DENIED_SEGMENTS.has(seg);
}

export async function resolveReadPath(
  repoRoot: string,
  requested: string,
): Promise<string> {
  const outOfScope = (): never => {
    throw new Error('out of scope: ' + requested);
  };

  if (typeof requested !== 'string' || requested.length === 0) outOfScope();

  // Reject absolute paths outright.
  if (path.isAbsolute(requested)) outOfScope();

  // Reject parent traversal after normalization.
  const normalized = path.normalize(requested);
  if (normalized.startsWith('..' + path.sep) || normalized === '..')
    outOfScope();

  const candidate = path.join(repoRoot, requested);

  let resolved: string;
  try {
    resolved = await safeRealpath(candidate);
  } catch {
    outOfScope();
    return ''; // unreachable
  }

  const realRoot = await fs.realpath(repoRoot);

  // Must be within the repo root.
  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
    outOfScope();
  }

  const relative = path.relative(realRoot, resolved);
  if (relative === '' || relative === '.') outOfScope();

  const segments = relative.split(path.sep);

  // Denied-segment check first (defense in depth).
  for (const seg of segments) {
    if (isDeniedSegment(seg)) outOfScope();
  }

  const first = segments[0];

  // Allow-list check.
  let allowed = false;
  if (ALLOWED_TOP_DIRS.has(first)) {
    allowed = true;
  } else if (first === 'dashboard') {
    if (segments.length >= 2 && segments[1] === 'src') {
      allowed = true;
    }
  } else if (segments.length === 1 && ALLOWED_ROOT_CONFIGS.has(first)) {
    allowed = true;
  }

  if (!allowed) outOfScope();

  // Return the joined candidate (preserving caller's root form) rather than
  // the realpath — we've already verified via realpath that this points to
  // an in-scope location.
  return candidate;
}

export async function resolveWritePath(
  repoRoot: string,
  kind: 'specs' | 'plans' | 'mockups',
  slug: string,
  ext: string,
): Promise<string> {
  sanitizeSlug(slug);

  const today = new Date().toISOString().slice(0, 10);
  const targetDir = path.join(repoRoot, 'docs', 'superpowers', kind);
  await fs.mkdir(targetDir, { recursive: true });

  const dest = path.join(targetDir, today + '-' + slug + '.' + ext);

  const realTarget = await fs.realpath(targetDir);
  const expectedRoot = await fs.realpath(repoRoot);
  const expectedTarget = path.join(expectedRoot, 'docs', 'superpowers', kind);

  if (
    realTarget !== expectedTarget &&
    !realTarget.startsWith(expectedTarget + path.sep)
  ) {
    throw new Error('out of scope: ' + kind + '/' + slug);
  }

  return dest;
}
