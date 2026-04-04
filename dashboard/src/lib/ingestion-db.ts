/**
 * Dashboard-side DB access for ingestion jobs and settings.
 *
 * Opens a read-write connection to the same SQLite database as the main
 * process (store/messages.db). Because Next.js/Turbopack cannot bundle
 * TypeScript source from outside the project root, this module re-implements
 * the subset of src/shared/db-reader.ts that the dashboard API routes need,
 * using better-sqlite3 directly.
 *
 * The DB path is resolved via the STORE_DIR env var (set in next.config.ts
 * to <project-root>/store) with a fallback of process.cwd()/../store.
 */

import Database from 'better-sqlite3';
import { join } from 'path';

export interface JobSummary {
  id: string;
  filename: string;
  status: string;
  error: string | null;
  retryAfter: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface JobDetail extends JobSummary {
  promotedPaths: string[] | null;
}

type DbRow = Record<string, unknown>;

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    const storeDir =
      process.env.STORE_DIR ?? join(process.cwd(), '..', 'store');
    const dbPath = join(storeDir, 'messages.db');
    _db = new Database(dbPath, { readonly: false });
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
  }
  return _db;
}

function rowToSummary(row: DbRow): JobSummary {
  return {
    id: row.id as string,
    filename: row.source_filename as string,
    status: row.status as string,
    error: (row.error as string | null) ?? null,
    retryAfter: (row.retry_after as string | null) ?? null,
    retryCount: (row.retry_count as number) ?? 0,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

export function getRecentJobs(status?: string): JobSummary[] {
  const db = getDb();
  let rows: DbRow[];
  if (status) {
    rows = db
      .prepare(
        `SELECT * FROM ingestion_jobs WHERE status = ? ORDER BY created_at DESC LIMIT 100`,
      )
      .all(status) as DbRow[];
  } else {
    rows = db
      .prepare(`SELECT * FROM ingestion_jobs ORDER BY created_at DESC LIMIT 100`)
      .all() as DbRow[];
  }
  return rows.map(rowToSummary);
}

export function getJobDetail(id: string): JobDetail | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM ingestion_jobs WHERE id = ?`)
    .get(id) as DbRow | undefined;
  if (!row) return null;

  const summary = rowToSummary(row);
  let promotedPaths: string[] | null = null;
  if (row.promoted_paths && typeof row.promoted_paths === 'string') {
    try {
      promotedPaths = JSON.parse(row.promoted_paths) as string[];
    } catch {
      promotedPaths = null;
    }
  }
  return { ...summary, promotedPaths };
}

export function getJobSourcePath(id: string): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT source_path FROM ingestion_jobs WHERE id = ?`)
    .get(id) as { source_path: string } | undefined;
  return row ? row.source_path : null;
}

const STAGE_MAP: Record<string, string> = {
  extracting: 'pending',
  generating: 'extracted',
  promoting: 'generated',
};

export function retryJob(id: string): { ok: true } | { ok: false; error: string } {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM ingestion_jobs WHERE id = ?`)
    .get(id) as DbRow | undefined;

  if (!row) {
    return { ok: false, error: 'Job not found' };
  }

  if (row.status !== 'failed' && row.status !== 'rate_limited' && row.status !== 'oversized') {
    return {
      ok: false,
      error: `Job is not in a retryable state (status: ${row.status})`,
    };
  }

  let resetStatus: string;
  if (row.status === 'oversized') {
    resetStatus = 'extracted';
  } else {
    const errorStr = (row.error as string | null) ?? '';
    const prefix = errorStr.split(':')[0].toLowerCase().trim();
    resetStatus = STAGE_MAP[prefix] ?? 'pending';
  }

  db.prepare(
    `UPDATE ingestion_jobs SET status = ?, error = NULL, retry_after = NULL, updated_at = datetime('now') WHERE id = ?`,
  ).run(resetStatus, id);

  return { ok: true };
}

export function dismissJob(id: string): { ok: true; sourcePath: string | null } | { ok: false; error: string } {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM ingestion_jobs WHERE id = ?`)
    .get(id) as DbRow | undefined;

  if (!row) {
    return { ok: false, error: 'Job not found' };
  }

  if (!['failed', 'oversized', 'rate_limited'].includes(row.status as string)) {
    return {
      ok: false,
      error: `Job is not in a dismissable state (status: ${row.status})`,
    };
  }

  db.prepare(
    `UPDATE ingestion_jobs SET status = 'dismissed', error = NULL, retry_after = NULL, updated_at = datetime('now') WHERE id = ?`,
  ).run(id);

  return { ok: true, sourcePath: (row.source_path as string) ?? null };
}

export function getSettings(): { maxGenerationConcurrent: number } {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get('maxGenerationConcurrent') as { value: string } | undefined;
  const raw = row?.value ?? '1';
  const parsed = parseInt(raw, 10);
  const clamped = Math.min(5, Math.max(1, isNaN(parsed) ? 1 : parsed));
  return { maxGenerationConcurrent: clamped };
}

export function updateSettings(settings: {
  maxGenerationConcurrent: number;
}): void {
  const db = getDb();
  const clamped = Math.min(5, Math.max(1, settings.maxGenerationConcurrent));
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run('maxGenerationConcurrent', String(clamped));
}
