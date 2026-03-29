import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
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
    this.typeMappings = new TypeMappings(opts.typeMappingsPath);
    this.watcher = new FileWatcher(opts.uploadDir, (filePath) => {
      this.enqueue(filePath);
    });
    this.drainer = new PipelineDrainer({
      onExtract: (job) => this.handleExtraction(job),
      onGenerate: (job) => this.handleGeneration(job),
      maxExtractionConcurrent: MAX_EXTRACTION_CONCURRENT,
      maxGenerationConcurrent: opts.maxGenerationConcurrent ?? 2,
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
      // Remove failed/pending job so it can be retried
      deleteIngestionJob(existing.id);
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

    // Tier 2: queue for review (default — leave status as completed after review is created)
    // Tier 3: also queue for review (manual review required)
    // Both tiers get a review item; tier distinction is surfaced in the review UI

    // Move original out of upload folder
    const processedDir = join(this.uploadDir, '.processed');
    await mkdir(processedDir, { recursive: true });
    await rename(
      job.source_path,
      join(processedDir, `${job.id}-${fileName}`),
    );

    updateIngestionJob(job.id, { status: 'completed' });

    logger.info(
      { jobId: job.id, draftId, relativePath, tier: job.tier },
      `ingestion: Completed: ${relativePath} → draft ${draftId}`,
    );
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
