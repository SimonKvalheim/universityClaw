import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, rename, readdir, rmdir } from 'node:fs/promises';
import { join, relative, basename, dirname } from 'node:path';
import { FileWatcher } from './file-watcher.js';
import { parseUploadPath } from './path-parser.js';
import { TypeMappings } from './type-mappings.js';
import { AgentProcessor } from './agent-processor.js';
import { Extractor } from './extractor.js';
import { PipelineDrainer, JobRow } from './pipeline.js';
import { classifyTier } from './tier-classifier.js';
import { recoverStaleJobs } from './job-recovery.js';
import {
  createIngestionJob,
  deleteIngestionJob,
  getIngestionJobByPath,
  updateIngestionJob,
  createReviewItem,
} from '../db.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import { MAX_EXTRACTION_CONCURRENT, EXTRACTIONS_DIR } from '../config.js';
import { ReviewQueue } from './review-queue.js';
import { VaultUtility } from '../vault/vault-utility.js';

export interface IngestionPipelineOpts {
  uploadDir: string;
  vaultDir: string;
  typeMappingsPath: string;
  getReviewAgentGroup: () => RegisteredGroup | undefined;
  maxGenerationConcurrent?: number;
}

export class IngestionPipeline {
  private watcher: FileWatcher;
  private agentProcessor: AgentProcessor;
  private extractor: Extractor;
  private typeMappings: TypeMappings;
  private uploadDir: string;
  private vaultDir: string;
  private getReviewAgentGroup: () => RegisteredGroup | undefined;
  private reviewQueue: ReviewQueue;
  private drainer: PipelineDrainer;

  constructor(opts: IngestionPipelineOpts) {
    this.uploadDir = opts.uploadDir;
    this.vaultDir = opts.vaultDir;
    this.getReviewAgentGroup = opts.getReviewAgentGroup;
    this.agentProcessor = new AgentProcessor({
      vaultDir: opts.vaultDir,
      uploadDir: opts.uploadDir,
    });
    this.extractor = new Extractor({ extractionsDir: EXTRACTIONS_DIR });
    this.reviewQueue = new ReviewQueue(new VaultUtility(opts.vaultDir));
    this.typeMappings = new TypeMappings(opts.typeMappingsPath);
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
      // Reset failed/pending job for retry instead of deleting
      // (deleting would violate FK constraint with review_items)
      if (existing.status === 'failed') {
        updateIngestionJob(existing.id, { status: 'pending', error: null });
        logger.info(`ingestion: Retrying failed job: ${relativePath}`);
        return;
      }
      // Already pending — skip
      if (
        existing.status === 'pending' ||
        existing.status === 'extracted' ||
        existing.status === 'reviewing'
      ) {
        logger.info(
          `ingestion: Skipping (already ${existing.status}): ${relativePath}`,
        );
        return;
      }
    }

    const jobId = randomUUID();
    const context = parseUploadPath(relativePath, this.typeMappings);
    const tier = classifyTier({ type: context.type });

    logger.info(
      { jobId, relativePath, tier },
      `ingestion: Enqueuing: ${relativePath}`,
    );

    createIngestionJob(
      jobId,
      filePath,
      fileName,
      context.courseCode,
      context.courseName,
      context.semester,
      context.year,
      context.type,
    );

    updateIngestionJob(jobId, { tier });
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
    const context = parseUploadPath(relativePath, this.typeMappings);
    const courseDir = context.courseCode || '_unsorted';
    const attachmentDir = join('attachments', courseDir);
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
      { jobId: job.id, relativePath, tier: job.tier },
      `ingestion: Generating: ${relativePath}`,
    );

    // Get the review agent group
    const reviewAgentGroup = this.getReviewAgentGroup();
    if (!reviewAgentGroup) {
      throw new Error('Review agent group not registered');
    }

    // Ensure drafts directory exists
    await mkdir(join(this.vaultDir, 'drafts'), { recursive: true });

    const extractionPath = job.extraction_path;
    if (!extractionPath) {
      throw new Error(`No extraction path for job ${job.id}`);
    }

    const context = parseUploadPath(relativePath, this.typeMappings);

    // Process with agent (extractionPath is the dir, agent-processor reads content.md from it)
    const result = await this.agentProcessor.process(
      extractionPath,
      fileName,
      context,
      draftId,
      reviewAgentGroup,
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

    // Create review item in DB
    createReviewItem(
      draftId,
      job.id,
      `drafts/${draftId}.md`,
      fileName,
      context.type,
      context.courseCode,
      [],
    );

    // Move original out of upload folder
    const processedDir = join(this.uploadDir, '.processed');
    await mkdir(processedDir, { recursive: true });
    await rename(job.source_path, join(processedDir, `${job.id}-${fileName}`));

    if (job.tier === 2) {
      // Tier 2: auto-approve — move draft from vault/drafts/ to final vault path
      try {
        const result = await this.reviewQueue.approveDraft(draftId);
        logger.info(
          { jobId: job.id, draftId, targetPath: result.targetPath, tier: 2 },
          `ingestion: Tier 2 auto-approved → ${result.targetPath}`,
        );
      } catch (err) {
        logger.warn(
          { jobId: job.id, draftId, err },
          'ingestion: Tier 2 auto-approve failed, leaving as draft for manual review',
        );
      }
      updateIngestionJob(job.id, { status: 'completed' });
    } else {
      // Tier 3: queue for manual review
      updateIngestionJob(job.id, { status: 'reviewing' });
      logger.info(
        { jobId: job.id, draftId, tier: 3 },
        `ingestion: Tier 3 queued for review`,
      );
    }

    // Clean up extraction artifacts (checkpoint no longer needed)
    await this.extractor.cleanup(job.id);

    // Prune empty directories left behind in upload/
    await this.pruneEmptyDirs(dirname(job.source_path));

    logger.info(
      { jobId: job.id, draftId, relativePath, tier: job.tier },
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
   * Clean up after a job completes (Tier 1 auto-complete or any other completion).
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
