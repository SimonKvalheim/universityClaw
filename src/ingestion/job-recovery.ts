import { getStaleJobs, updateIngestionJob } from '../db.js';
import { logger } from '../logger.js';

interface RecoveryOpts {
  extractingThresholdMin: number;
  generatingThresholdMin: number;
}

interface RecoveryResult {
  extracting: number;
  generating: number;
  promoting: number;
}

interface IngestionJob {
  id: string;
  source_path: string;
  extraction_path?: string | null;
}

export function recoverStaleJobs(opts: RecoveryOpts): RecoveryResult {
  const result: RecoveryResult = { extracting: 0, generating: 0, promoting: 0 };

  // Reset stale extracting → pending (retry extraction from scratch)
  const staleExtracting = getStaleJobs(
    'extracting',
    opts.extractingThresholdMin,
  ) as IngestionJob[];
  for (const job of staleExtracting) {
    logger.warn(
      { jobId: job.id, sourcePath: job.source_path },
      'Recovering stale extracting job → pending',
    );
    updateIngestionJob(job.id, {
      status: 'pending',
      error: 'Reset: stale extracting state on startup',
    });
    result.extracting++;
  }

  // Reset stale generating → extracted (retry only AI stage, keep extraction)
  const staleGenerating = getStaleJobs(
    'generating',
    opts.generatingThresholdMin,
  ) as IngestionJob[];
  for (const job of staleGenerating) {
    if (job.extraction_path) {
      logger.warn(
        { jobId: job.id, sourcePath: job.source_path },
        'Recovering stale generating job → extracted',
      );
      updateIngestionJob(job.id, {
        status: 'extracted',
        error: 'Reset: stale generating state on startup',
      });
    } else {
      logger.warn(
        { jobId: job.id, sourcePath: job.source_path },
        'Recovering stale generating job → pending (no extraction)',
      );
      updateIngestionJob(job.id, {
        status: 'pending',
        error: 'Reset: stale generating state, no extraction artifacts',
      });
    }
    result.generating++;
  }

  // Reset stale promoting → generated (retry promotion)
  const stalePromoting = getStaleJobs(
    'promoting',
    opts.generatingThresholdMin,
  ) as IngestionJob[];
  for (const job of stalePromoting) {
    logger.warn(
      { jobId: job.id, sourcePath: job.source_path },
      'Recovering stale promoting job → generated',
    );
    updateIngestionJob(job.id, {
      status: 'generated',
      error: 'Reset: stale promoting state on startup',
    });
    result.promoting++;
  }

  if (result.extracting > 0 || result.generating > 0 || result.promoting > 0) {
    logger.info({ ...result }, 'Recovered stale jobs on startup');
  }

  return result;
}
