import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, readdir, rmdir } from 'node:fs/promises';
import { join, relative, basename, dirname } from 'node:path';
import { FileWatcher } from './file-watcher.js';
import { AgentProcessor } from './agent-processor.js';
import { Extractor } from './extractor.js';
import { PipelineDrainer, JobRow } from './pipeline.js';
import { recoverStaleJobs } from './job-recovery.js';
import { readManifest, inferManifest } from './manifest.js';
import { promoteNote } from './promoter.js';
import {
  waitForSentinel,
  sendIpcClose,
  sendIpcMessage,
  cleanupSentinel,
} from './sentinel.js';
import { validateDrafts, formatValidationMessage } from './draft-validator.js';
import {
  createIngestionJob,
  getIngestionJobByPath,
  updateIngestionJob,
} from '../db.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import {
  MAX_EXTRACTION_CONCURRENT,
  EXTRACTIONS_DIR,
  SENTINEL_TIMEOUT,
  PROCESSED_DIR,
} from '../config.js';

export interface IngestionPipelineOpts {
  uploadDir: string;
  vaultDir: string;
  reviewAgentGroup: RegisteredGroup;
  maxGenerationConcurrent?: number;
}

export class IngestionPipeline {
  private watcher: FileWatcher;
  private agentProcessor: AgentProcessor;
  private extractor: Extractor;
  private uploadDir: string;
  private vaultDir: string;
  private reviewAgentGroup: RegisteredGroup;
  private drainer: PipelineDrainer;

  constructor(opts: IngestionPipelineOpts) {
    this.uploadDir = opts.uploadDir;
    this.vaultDir = opts.vaultDir;
    this.reviewAgentGroup = opts.reviewAgentGroup;
    this.agentProcessor = new AgentProcessor({
      vaultDir: opts.vaultDir,
      uploadDir: opts.uploadDir,
    });
    this.extractor = new Extractor({ extractionsDir: EXTRACTIONS_DIR });
    this.watcher = new FileWatcher(opts.uploadDir, (filePath) => {
      this.enqueue(filePath);
    });
    this.drainer = new PipelineDrainer({
      onExtract: (job) => this.handleExtraction(job),
      onGenerate: (job) => this.handleGeneration(job),
      onPromote: (job) => this.handlePromotion(job),
      maxExtractionConcurrent: MAX_EXTRACTION_CONCURRENT,
      maxGenerationConcurrent: opts.maxGenerationConcurrent ?? 1,
      pollIntervalMs: 5000,
    });
  }

  private enqueue(filePath: string): void {
    const relativePath = relative(this.uploadDir, filePath);
    const fileName = basename(filePath);

    const existing = getIngestionJobByPath(filePath);
    if (existing) {
      if (
        existing.status === 'completed' ||
        existing.status === 'extracting' ||
        existing.status === 'generating' ||
        existing.status === 'promoting'
      ) {
        logger.info(
          `ingestion: Skipping (already ${existing.status}): ${relativePath}`,
        );
        return;
      }
      if (existing.status === 'failed') {
        updateIngestionJob(existing.id, { status: 'pending', error: null });
        logger.info(`ingestion: Retrying failed job: ${relativePath}`);
        return;
      }
      if (
        existing.status === 'pending' ||
        existing.status === 'extracted' ||
        existing.status === 'generated'
      ) {
        logger.info(
          `ingestion: Skipping (already ${existing.status}): ${relativePath}`,
        );
        return;
      }
    }

    const jobId = randomUUID();
    logger.info(
      { jobId, relativePath },
      `ingestion: Enqueuing: ${relativePath}`,
    );
    createIngestionJob(jobId, filePath, fileName);
  }

  async handleExtraction(job: JobRow): Promise<void> {
    const fileName = job.source_filename;
    const relativePath = relative(this.uploadDir, job.source_path);

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Extracting: ${relativePath}`,
    );

    const result = await this.extractor.extract(job.id, job.source_path);

    // Copy original file to vault attachments
    const attachmentDir = join('attachments', '_unsorted');
    await mkdir(join(this.vaultDir, attachmentDir), { recursive: true });
    await copyFile(
      job.source_path,
      join(this.vaultDir, attachmentDir, fileName),
    );

    // Copy figures to vault attachments if any exist
    if (result.figures.length > 0) {
      const figuresAttachDir = join(this.vaultDir, attachmentDir, 'figures');
      await mkdir(figuresAttachDir, { recursive: true });
      for (const fig of result.figures) {
        await copyFile(
          join(result.figuresDir, fig),
          join(figuresAttachDir, fig),
        ).catch(() => {
          logger.warn({ jobId: job.id, figure: fig }, 'Failed to copy figure');
        });
      }
    }

    updateIngestionJob(job.id, {
      status: 'extracted',
      extraction_path: result.contentPath.replace(/\/content\.md$/, ''),
    });

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Extracted: ${relativePath}`,
    );
  }

  async handleGeneration(job: JobRow): Promise<void> {
    const fileName = job.source_filename;
    const relativePath = relative(this.uploadDir, job.source_path);

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Generating: ${relativePath}`,
    );

    const draftsDir = join(this.vaultDir, 'drafts');
    await mkdir(draftsDir, { recursive: true });

    const extractionPath = job.extraction_path;
    if (!extractionPath) {
      throw new Error(`No extraction path for job ${job.id}`);
    }

    const dataDir = process.cwd();
    const sentinelPath = join(draftsDir, `${job.id}-complete`);

    // Validation loop — runs concurrently with the container.
    // Polls for sentinel, validates drafts, sends IPC corrections or _close.
    const validationLoop = async (): Promise<void> => {
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const sentinelFound = await waitForSentinel(
          sentinelPath,
          SENTINEL_TIMEOUT,
        );

        if (!sentinelFound) {
          logger.warn(
            { jobId: job.id },
            'Sentinel timeout — sending IPC close',
          );
          sendIpcClose(job.id, dataDir);
          throw new Error('Agent did not complete within sentinel timeout');
        }

        // Validate the generated drafts
        const validation = validateDrafts(draftsDir, job.id, fileName);

        if (validation.valid) {
          if (validation.warnings.length > 0) {
            logger.info(
              { jobId: job.id, warnings: validation.warnings.length },
              'Draft validation passed with warnings',
            );
          }
          // Tell the agent validation passed, then close the session
          sendIpcMessage(
            job.id,
            dataDir,
            'Output validation passed. Your work is complete. Shutting down.',
          );
          // Small delay so the agent receives the message before _close
          await new Promise((r) => setTimeout(r, 500));
          sendIpcClose(job.id, dataDir);
          return;
        }

        // Validation failed
        logger.warn(
          { jobId: job.id, errors: validation.errors.length, attempt },
          'Draft validation failed, sending corrections to agent',
        );

        if (attempt === maxAttempts) {
          logger.error(
            { jobId: job.id, errors: validation.errors },
            'Draft validation failed after max attempts — closing agent',
          );
          sendIpcMessage(
            job.id,
            dataDir,
            `Validation failed after ${maxAttempts} attempts. Shutting down.\n\n${formatValidationMessage(validation)}`,
          );
          await new Promise((r) => setTimeout(r, 500));
          sendIpcClose(job.id, dataDir);
          throw new Error(
            `Draft validation failed after ${maxAttempts} attempts: ${validation.errors.map((e) => e.message).join('; ')}`,
          );
        }

        // Delete sentinel so we can wait for a new one
        try {
          const { unlinkSync } = await import('fs');
          unlinkSync(sentinelPath);
        } catch {
          // Already gone
        }

        // Send corrections to agent via IPC — agent fixes and writes new sentinel
        sendIpcMessage(job.id, dataDir, formatValidationMessage(validation));
      }
    };

    // Run container and validation concurrently.
    // validationLoop sends _close when done, which causes the container to exit,
    // which causes process() to return.
    const [result] = await Promise.all([
      this.agentProcessor.process(
        extractionPath,
        fileName,
        job.id,
        this.reviewAgentGroup,
      ),
      validationLoop(),
    ]);

    if (result.status === 'error') {
      throw new Error(result.error || 'Agent processing failed');
    }

    updateIngestionJob(job.id, { status: 'generated' });

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Generated: ${relativePath}`,
    );
  }

  async handlePromotion(job: JobRow): Promise<void> {
    const fileName = job.source_filename;
    const relativePath = relative(this.uploadDir, job.source_path);
    const draftsDir = join(this.vaultDir, 'drafts');

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Promoting: ${relativePath}`,
    );

    // Read or infer manifest
    const manifest =
      readManifest(draftsDir, job.id) ?? inferManifest(draftsDir, job.id);

    // Promote source note
    const promotedPaths: string[] = [];
    if (manifest.source_note) {
      const sourceDraftPath = join(draftsDir, manifest.source_note);
      try {
        const promoted = promoteNote(sourceDraftPath, this.vaultDir, job.id);
        promotedPaths.push(promoted);
        logger.info({ jobId: job.id, promoted }, 'Promoted source note');
      } catch (err) {
        logger.warn(
          { jobId: job.id, file: manifest.source_note, err },
          'Failed to promote source note',
        );
      }
    }

    // Promote concept notes
    for (const conceptFile of manifest.concept_notes) {
      const conceptDraftPath = join(draftsDir, conceptFile);
      try {
        const promoted = promoteNote(conceptDraftPath, this.vaultDir, job.id);
        promotedPaths.push(promoted);
        logger.info({ jobId: job.id, promoted }, 'Promoted concept note');
      } catch (err) {
        logger.warn(
          { jobId: job.id, file: conceptFile, err },
          'Failed to promote concept note',
        );
      }
    }

    // Move source file to processed/
    await mkdir(PROCESSED_DIR, { recursive: true });
    try {
      await rename(
        job.source_path,
        join(PROCESSED_DIR, `${job.id}-${fileName}`),
      );
    } catch {
      logger.warn({ jobId: job.id }, 'Failed to move source to processed/');
    }

    // Cleanup
    cleanupSentinel(draftsDir, job.id);
    await this.extractor.cleanup(job.id);
    await this.pruneEmptyDirs(dirname(job.source_path));

    updateIngestionJob(job.id, { status: 'completed' });

    logger.info(
      { jobId: job.id, relativePath, notes: promotedPaths.length },
      `ingestion: Completed: ${relativePath} → ${promotedPaths.length} notes promoted`,
    );
  }

  private async pruneEmptyDirs(dir: string): Promise<void> {
    let current = dir;
    while (current !== this.uploadDir && current.startsWith(this.uploadDir)) {
      try {
        const entries = await readdir(current);
        const meaningful = entries.filter(
          (e) => e !== '.DS_Store' && e !== 'Thumbs.db',
        );
        if (meaningful.length > 0) break;
        await rmdir(current);
        current = dirname(current);
      } catch {
        break;
      }
    }
  }

  async start(): Promise<void> {
    await mkdir(this.uploadDir, { recursive: true });
    await mkdir(EXTRACTIONS_DIR, { recursive: true });
    await mkdir(PROCESSED_DIR, { recursive: true });
    await mkdir(join(this.vaultDir, 'drafts'), { recursive: true });

    recoverStaleJobs({
      extractingThresholdMin: 15,
      generatingThresholdMin: 60,
    });

    await this.watcher.start();
    this.drainer.drain();

    logger.info(`Watching ${this.uploadDir} for new files`);
  }

  async stop(): Promise<void> {
    this.drainer.stop();
    await this.watcher.stop();
  }
}
