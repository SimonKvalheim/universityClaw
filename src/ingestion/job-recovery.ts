import { getJobsByStatus, updateIngestionJob } from '../db.js';
import { logger } from '../logger.js';

/**
 * On startup, mark any in-progress jobs as failed.
 * No auto-retry — failures surface in the dashboard for manual re-upload.
 */
export function markInterruptedJobsFailed(): number {
  const inProgressStatuses = ['extracting', 'generating', 'promoting'];
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
