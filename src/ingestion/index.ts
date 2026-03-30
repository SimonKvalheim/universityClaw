import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, rename, readdir, rmdir } from 'node:fs/promises';
import { join, relative, basename, dirname } from 'node:path';
import { FileWatcher } from './file-watcher.js';
import { AgentProcessor } from './agent-processor.js';
import { Extractor } from './extractor.js';
import { PipelineDrainer, JobRow } from './pipeline.js';
import { recoverStaleJobs } from './job-recovery.js';
import {
  createIngestionJob,
  getIngestionJobByPath,
  updateIngestionJob,
} from '../db.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import { MAX_EXTRACTION_CONCURRENT, EXTRACTIONS_DIR } from '../config.js';

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
      onComplete: (job) => this.handleCleanup(job),
      maxExtractionConcurrent: MAX_EXTRACTION_CONCURRENT,
      maxGenerationConcurrent: opts.maxGenerationConcurrent ?? 3,
      pollIntervalMs: 5000,
    });
  }

  private enqueue(filePath: string): void {
    const relativePath = relative(this.uploadDir, filePath);
    const fileName = basename(filePath);

    // Skip files that already have a completed or in-progress job
    const existing = getIngestionJobByPath(filePath);
    if (existing) {
      if (
        existing.status === 'completed' ||
        existing.status === 'extracting' ||
        existing.status === 'generating'
      ) {
        logger.info(
          `ingestion: Skipping (already ${existing.status}): ${relativePath}`,
        );
        return;
      }
      // Reset failed job for retry
      if (existing.status === 'failed') {
        updateIngestionJob(existing.id, { status: 'pending', error: null });
        logger.info(`ingestion: Retrying failed job: ${relativePath}`);
        return;
      }
      // Already pending or extracted — skip
      if (existing.status === 'pending' || existing.status === 'extracted') {
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
          // Non-fatal: log and continue
          logger.warn({ jobId: job.id, figure: fig }, 'Failed to copy figure');
        });
      }
    }

    // Update job with extraction path
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
    const draftId = randomUUID();

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Generating: ${relativePath}`,
    );

    // Ensure drafts directory exists
    await mkdir(join(this.vaultDir, 'drafts'), { recursive: true });

    const extractionPath = job.extraction_path;
    if (!extractionPath) {
      throw new Error(`No extraction path for job ${job.id}`);
    }

    // Minimal context — no path parsing, agent determines metadata from content
    const context = {
      semester: null,
      year: null,
      courseCode: null,
      courseName: null,
      type: null,
      fileName,
    };

    // Process with agent
    const result = await this.agentProcessor.process(
      extractionPath,
      fileName,
      context,
      draftId,
      this.reviewAgentGroup,
    );

    if (result.status === 'error') {
      throw new Error(result.error || 'Agent processing failed');
    }

    // Validate the agent actually wrote the draft file with _targetPath
    const draftPath = join(this.vaultDir, 'drafts', `${draftId}.md`);
    let draftContent: string;
    try {
      draftContent = readFileSync(draftPath, 'utf-8');
    } catch {
      throw new Error(
        `Agent completed but draft file not found at ${draftPath}`,
      );
    }

    if (!draftContent.includes('_targetPath')) {
      throw new Error(
        `Draft file missing _targetPath frontmatter field at ${draftPath}`,
      );
    }

    // Move original out of upload folder
    const processedDir = join(this.uploadDir, '.processed');
    await mkdir(processedDir, { recursive: true });
    await rename(job.source_path, join(processedDir, `${job.id}-${fileName}`));

    updateIngestionJob(job.id, { status: 'completed' });

    // Clean up extraction artifacts
    await this.extractor.cleanup(job.id);

    // Prune empty directories left behind in upload/
    await this.pruneEmptyDirs(dirname(job.source_path));

    logger.info(
      { jobId: job.id, draftId, relativePath },
      `ingestion: Completed: ${relativePath} → draft ${draftId}`,
    );
  }

  /**
   * Walk up from dir, removing empty directories until we hit uploadDir.
   */
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

  /**
   * Clean up after a job completes.
   */
  private async handleCleanup(job: {
    id: string;
    source_path: string;
  }): Promise<void> {
    await this.extractor.cleanup(job.id);
    await this.pruneEmptyDirs(dirname(job.source_path));
  }

  async start(): Promise<void> {
    await mkdir(this.uploadDir, { recursive: true });
    await mkdir(EXTRACTIONS_DIR, { recursive: true });

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
