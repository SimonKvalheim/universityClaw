/**
 * Dashboard-side DB access for ingestion jobs and settings.
 *
 * Opens a read-write connection to the same SQLite database as the main
 * process (store/messages.db). Because Next.js/Turbopack cannot bundle
 * TypeScript source from outside the project root, this module re-implements
 * the subset of src/shared/db-reader.ts that the dashboard API routes need,
 * using Drizzle ORM over better-sqlite3.
 *
 * The DB path is resolved via the STORE_DIR env var (set in next.config.ts
 * to <project-root>/store) with a fallback of process.cwd()/../store.
 */

import { eq, desc, sql } from 'drizzle-orm';
import { getDb } from './db/index';
import { ingestion_jobs, settings } from './db/schema';

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

type JobRow = typeof ingestion_jobs.$inferSelect;

function rowToSummary(row: JobRow): JobSummary {
  return {
    id: row.id,
    filename: row.source_filename,
    status: row.status ?? 'pending',
    error: row.error ?? null,
    retryAfter: row.retry_after ?? null,
    retryCount: row.retry_count ?? 0,
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
    completedAt: row.completed_at ?? null,
  };
}

export function getRecentJobs(status?: string): JobSummary[] {
  const db = getDb();
  let rows: JobRow[];
  if (status) {
    rows = db
      .select()
      .from(ingestion_jobs)
      .where(eq(ingestion_jobs.status, status))
      .orderBy(desc(ingestion_jobs.created_at))
      .limit(100)
      .all();
  } else {
    rows = db
      .select()
      .from(ingestion_jobs)
      .orderBy(desc(ingestion_jobs.created_at))
      .limit(100)
      .all();
  }
  return rows.map(rowToSummary);
}

export function getJobDetail(id: string): JobDetail | null {
  const db = getDb();
  const row = db
    .select()
    .from(ingestion_jobs)
    .where(eq(ingestion_jobs.id, id))
    .get();
  if (!row) return null;

  const summary = rowToSummary(row);
  let promotedPaths: string[] | null = null;
  if (row.promoted_paths) {
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
    .select({ source_path: ingestion_jobs.source_path })
    .from(ingestion_jobs)
    .where(eq(ingestion_jobs.id, id))
    .get();
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
    .select()
    .from(ingestion_jobs)
    .where(eq(ingestion_jobs.id, id))
    .get();

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
    const errorStr = row.error ?? '';
    const prefix = errorStr.split(':')[0].toLowerCase().trim();
    resetStatus = STAGE_MAP[prefix] ?? 'pending';
  }

  db.update(ingestion_jobs)
    .set({
      status: resetStatus,
      error: null,
      retry_after: null,
      updated_at: sql`datetime('now')`,
    })
    .where(eq(ingestion_jobs.id, id))
    .run();

  return { ok: true };
}

export function dismissJob(id: string): { ok: true; sourcePath: string | null } | { ok: false; error: string } {
  const db = getDb();
  const row = db
    .select()
    .from(ingestion_jobs)
    .where(eq(ingestion_jobs.id, id))
    .get();

  if (!row) {
    return { ok: false, error: 'Job not found' };
  }

  if (!['failed', 'oversized', 'rate_limited'].includes(row.status ?? '')) {
    return {
      ok: false,
      error: `Job is not in a dismissable state (status: ${row.status})`,
    };
  }

  db.update(ingestion_jobs)
    .set({
      status: 'dismissed',
      error: null,
      retry_after: null,
      updated_at: sql`datetime('now')`,
    })
    .where(eq(ingestion_jobs.id, id))
    .run();

  return { ok: true, sourcePath: row.source_path };
}

export function getSettings(): { maxGenerationConcurrent: number } {
  const db = getDb();
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'maxGenerationConcurrent'))
    .get();
  const raw = row?.value ?? '1';
  const parsed = parseInt(raw, 10);
  const clamped = Math.min(5, Math.max(1, isNaN(parsed) ? 1 : parsed));
  return { maxGenerationConcurrent: clamped };
}

export function updateSettings(config: {
  maxGenerationConcurrent: number;
}): void {
  const db = getDb();
  const clamped = Math.min(5, Math.max(1, config.maxGenerationConcurrent));
  db.insert(settings)
    .values({
      key: 'maxGenerationConcurrent',
      value: String(clamped),
      updated_at: sql`datetime('now')`,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: sql`excluded.value`,
        updated_at: sql`excluded.updated_at`,
      },
    })
    .run();
}
