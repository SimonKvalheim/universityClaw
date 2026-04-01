import {
  getIngestionJobs,
  getSetting,
  setSetting,
  updateIngestionJob,
} from '../db.js';

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

/**
 * Returns up to 20 recent ingestion jobs, optionally filtered by status.
 * Results are ordered by created_at DESC (as returned by getIngestionJobs).
 */
export function getRecentJobs(status?: string): JobSummary[] {
  const rows = getIngestionJobs(status) as DbRow[];
  return rows.slice(0, 20).map(rowToSummary);
}

/**
 * Returns full job detail for a single job, or null if not found.
 * Parses the promoted_paths JSON string into a string array.
 */
export function getJobDetail(id: string): JobDetail | null {
  const rows = getIngestionJobs() as DbRow[];
  const row = rows.find((r) => r.id === id);
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

/**
 * Returns the source_path for a job (used by retry endpoint to check file exists).
 */
export function getJobSourcePath(id: string): string | null {
  const rows = getIngestionJobs() as DbRow[];
  const row = rows.find((r) => r.id === id);
  return row ? (row.source_path as string) : null;
}

const STAGE_MAP: Record<string, string> = {
  extracting: 'pending',
  generating: 'extracted',
  promoting: 'generated',
};

/**
 * Resets a failed job back to an appropriate status based on which stage it
 * failed at (determined by the error message prefix).
 */
export function retryJob(
  id: string,
): { ok: true } | { ok: false; error: string } {
  const rows = getIngestionJobs() as DbRow[];
  const row = rows.find((r) => r.id === id);

  if (!row) {
    return { ok: false, error: 'Job not found' };
  }

  if (row.status !== 'failed') {
    return { ok: false, error: `Job is not in failed state (status: ${row.status})` };
  }

  const errorStr = (row.error as string | null) ?? '';
  const prefix = errorStr.split(':')[0].toLowerCase().trim();
  const resetStatus = STAGE_MAP[prefix] ?? 'pending';

  updateIngestionJob(id, {
    status: resetStatus,
    error: null,
    retry_after: null,
  });

  return { ok: true };
}

/**
 * Returns settings for the dashboard. Reads maxGenerationConcurrent,
 * clamped to 1-5.
 */
export function getSettings(): { maxGenerationConcurrent: number } {
  const raw = getSetting('maxGenerationConcurrent', '1');
  const parsed = parseInt(raw, 10);
  const clamped = Math.min(5, Math.max(1, isNaN(parsed) ? 1 : parsed));
  return { maxGenerationConcurrent: clamped };
}

/**
 * Stores settings. Clamps maxGenerationConcurrent to 1-5.
 */
export function updateSettings(settings: {
  maxGenerationConcurrent: number;
}): void {
  const clamped = Math.min(5, Math.max(1, settings.maxGenerationConcurrent));
  setSetting('maxGenerationConcurrent', String(clamped));
}
