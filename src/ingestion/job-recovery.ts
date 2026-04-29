import { getJobsByStatus, updateIngestionJob } from '../db.js';
import { logger } from '../logger.js';

const RECOVERABLE_STATUSES = ['librarying'] as const;

/**
 * On startup, reset jobs stuck in idempotent in-progress stages back to their
 * pre-stage status so they get retried rather than failed. Library writes are
 * atomic rename + content-equivalent overwrite, so re-running is safe.
 *
 * Must run BEFORE markInterruptedJobsFailed.
 */
export function resetRecoverableInProgress(): number {
  let count = 0;
  for (const status of RECOVERABLE_STATUSES) {
    const stuck = getJobsByStatus(status) as Array<{ id: string }>;
    for (const job of stuck) {
      logger.info(
        { jobId: job.id, fromStatus: status, toStatus: 'extracted' },
        'recovery: resetting recoverable in-progress job',
      );
      updateIngestionJob(job.id, { status: 'extracted', error: null });
      count++;
    }
  }
  if (count > 0) {
    logger.info({ count }, 'Reset recoverable in-progress jobs on startup');
  }
  return count;
}

/**
 * On startup, mark any in-progress jobs as failed.
 * No auto-retry — failures surface in the dashboard for manual re-upload.
 */
export function markInterruptedJobsFailed(): number {
  const inProgressStatuses = [
    'extracting',
    'generating',
    'promoting',
    'rate_limited',
  ];
  let count = 0;

  for (const status of inProgressStatuses) {
    const stuck = getJobsByStatus(status) as Array<{
      id: string;
      source_path: string;
    }>;
    for (const job of stuck) {
      logger.warn(
        { jobId: job.id, sourcePath: job.source_path, status },
        `Marking interrupted ${status} job as failed`,
      );
      updateIngestionJob(job.id, {
        status: 'failed',
        error: 'Interrupted: process restarted',
      });
      count++;
    }
  }

  if (count > 0) {
    logger.info({ count }, 'Marked interrupted jobs as failed on startup');
  }

  return count;
}
