import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { mkdir, rename, readdir, rmdir } from 'node:fs/promises';
import { join, relative, basename, dirname } from 'node:path';
import { FileWatcher } from './file-watcher.js';
import { AgentProcessor } from './agent-processor.js';
import { Extractor } from './extractor.js';
import { PipelineDrainer, JobRow } from './pipeline.js';
import { markInterruptedJobsFailed } from './job-recovery.js';
import { readManifest, inferManifest } from './manifest.js';
import { buildVaultManifest } from './vault-manifest.js';
import { promoteNote } from './promoter.js';
import {
  waitForSentinel,
  sendIpcClose,
  sendIpcMessage,
  cleanupSentinel,
  cleanupDraftBundle,
} from './sentinel.js';
import { validateDrafts, formatValidationMessage } from './draft-validator.js';
import { extractBibliography, linkCitations } from './citation-linker.js';
import {
  createIngestionJob,
  getIngestionJobByPath,
  getCompletedJobByHash,
  updateIngestionJob,
  getSetting,
  getIngestionJobs,
  deleteCitationEdges,
  getIngestionJobByZoteroKey,
} from '../db.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import {
  DATA_DIR,
  MAX_EXTRACTION_CONCURRENT,
  EXTRACTIONS_DIR,
  SENTINEL_TIMEOUT,
  PROCESSED_DIR,
  ZOTERO_ENABLED,
  ZOTERO_API_KEY,
  ZOTERO_USER_ID,
  ZOTERO_POLL_INTERVAL,
  ZOTERO_EXCLUDE_COLLECTION,
  ZOTERO_LOCAL_URL,
  ZOTERO_GROUP_IDS,
} from '../config.js';
import { ZoteroWatcher } from './zotero-watcher.js';
import { ZoteroWriteBack } from './zotero-writeback.js';
import { ZoteroLocalClient, ZoteroWebClient } from './zotero-client.js';
import { ZoteroMetadata } from './types.js';
import { discoverConcepts } from '../study/concept-discovery.js';
import { createConcept, getConceptByVaultPath } from '../study/queries.js';

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /session.?limit/i,
  /overloaded/i,
  /429/,
  /529/,
  /too many requests/i,
  /capacity/i,
];
function isRateLimitError(msg: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(msg));
}

export interface IngestionPipelineOpts {
  uploadDir: string;
  vaultDir: string;
  reviewAgentGroup: RegisteredGroup;
  maxGenerationConcurrent?: number;
  notify?: (message: string) => void;
}

export class IngestionPipeline {
  private watcher: FileWatcher;
  private agentProcessor: AgentProcessor;
  private extractor: Extractor;
  private uploadDir: string;
  private vaultDir: string;
  private reviewAgentGroup: RegisteredGroup;
  private drainer: PipelineDrainer;
  private notify: ((message: string) => void) | undefined;
  private zoteroWatchers: ZoteroWatcher[] = [];
  private zoteroWriteBack: ZoteroWriteBack | null = null;

  constructor(opts: IngestionPipelineOpts) {
    this.uploadDir = opts.uploadDir;
    this.vaultDir = opts.vaultDir;
    this.reviewAgentGroup = opts.reviewAgentGroup;
    this.notify = opts.notify;
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
      maxGenerationConcurrent: () => {
        const fallback = String(opts.maxGenerationConcurrent ?? 1);
        const val = getSetting('maxGenerationConcurrent', fallback);
        return Math.max(1, Math.min(5, parseInt(val, 10) || 1));
      },
      pollIntervalMs: 5000,
    });
  }

  private enqueue(filePath: string): void {
    const relativePath = relative(this.uploadDir, filePath);
    const fileName = basename(filePath);

    // Content-hash dedup: skip if identical file already completed
    let contentHash: string;
    try {
      const fileBuffer = readFileSync(filePath);
      contentHash = createHash('sha256').update(fileBuffer).digest('hex');
    } catch (err) {
      logger.warn(
        { filePath, err },
        'ingestion: Failed to hash file, skipping',
      );
      return;
    }

    const completedDuplicate = getCompletedJobByHash(contentHash);
    if (completedDuplicate) {
      logger.info(
        { filePath: relativePath, duplicateOfJob: completedDuplicate.id },
        `ingestion: Skipping duplicate of completed job ${completedDuplicate.id}: ${relativePath}`,
      );
      return;
    }

    // Path-based dedup: skip if same path is already in-flight
    const existing = getIngestionJobByPath(filePath);
    if (existing) {
      // dismissed = terminal, allow re-enqueue
      if (existing.status === 'dismissed') {
        // Fall through to create a new job
      } else if (
        existing.status === 'completed' ||
        existing.status === 'extracting' ||
        existing.status === 'generating' ||
        existing.status === 'promoting' ||
        existing.status === 'oversized' ||
        existing.status === 'rate_limited'
      ) {
        logger.info(
          `ingestion: Skipping (already ${existing.status}): ${relativePath}`,
        );
        return;
      } else if (existing.status === 'failed') {
        updateIngestionJob(existing.id, { status: 'pending', error: null });
        logger.info(`ingestion: Retrying failed job: ${relativePath}`);
        return;
      } else if (
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
      { jobId, relativePath, contentHash },
      `ingestion: Enqueuing: ${relativePath}`,
    );
    createIngestionJob(jobId, filePath, fileName, contentHash);
  }

  private enqueueZotero(
    filePath: string,
    zoteroKey: string,
    metadata: ZoteroMetadata,
  ): void {
    // Content-hash dedup (same as enqueue)
    let contentHash: string;
    try {
      const fileBuffer = readFileSync(filePath);
      contentHash = createHash('sha256').update(fileBuffer).digest('hex');
    } catch (err) {
      logger.warn(
        { filePath, zoteroKey, err },
        'zotero: Failed to hash file, skipping',
      );
      return;
    }

    const completedDuplicate = getCompletedJobByHash(contentHash);
    if (completedDuplicate) {
      logger.info(
        { zoteroKey, duplicateOfJob: completedDuplicate.id },
        'zotero: Skipping duplicate of completed job',
      );
      return;
    }

    const jobId = randomUUID();
    logger.info(
      { jobId, zoteroKey, title: metadata.title },
      `zotero: Enqueuing: ${metadata.title}`,
    );
    createIngestionJob(jobId, filePath, basename(filePath), contentHash, {
      source_type: 'zotero',
      zotero_key: zoteroKey,
      zotero_metadata: JSON.stringify(metadata),
    });
  }

  async handleExtraction(job: JobRow): Promise<void> {
    const relativePath = relative(this.uploadDir, job.source_path);

    // Skip if extraction artifacts already exist (recovery re-run)
    if (await this.extractor.hasArtifacts(job.id)) {
      logger.info(
        { jobId: job.id, relativePath },
        'ingestion: Extraction artifacts exist — skipping Docling',
      );
      updateIngestionJob(job.id, {
        status: 'extracted',
        extraction_path: this.extractor.getExtractionDir(job.id),
      });
      return;
    }

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Extracting: ${relativePath}`,
    );

    const result = await this.extractor.extract(job.id, job.source_path);

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

    const draftsDir = join(this.vaultDir, 'drafts');
    await mkdir(draftsDir, { recursive: true });

    // Skip if valid drafts already exist (recovery re-run with prior output)
    const existingValidation = validateDrafts(draftsDir, job.id, fileName);
    if (existingValidation.valid) {
      logger.info(
        { jobId: job.id, relativePath },
        'ingestion: Valid drafts already exist — skipping agent',
      );
      updateIngestionJob(job.id, { status: 'generated' });
      return;
    }

    logger.info(
      { jobId: job.id, relativePath },
      `ingestion: Generating: ${relativePath}`,
    );

    const extractionPath = job.extraction_path;
    if (!extractionPath) {
      throw new Error(`No extraction path for job ${job.id}`);
    }

    // Token budget gate — park oversized documents before spawning agent
    const TOKEN_BUDGET = 80_000;
    const cleanContentPath = join(extractionPath, 'content.clean.md');
    const rawContentPath = join(extractionPath, 'content.md');
    const contentForBudget = existsSync(cleanContentPath)
      ? cleanContentPath
      : rawContentPath;
    let contentChars: number;
    try {
      contentChars = readFileSync(contentForBudget, 'utf-8').length;
    } catch {
      contentChars = 0;
    }
    const estimatedTokens = Math.ceil(contentChars / 4);

    if (estimatedTokens > TOKEN_BUDGET) {
      const tokensK = Math.round(estimatedTokens / 1000);
      updateIngestionJob(job.id, {
        status: 'oversized',
        error: `oversized:~${tokensK}K tokens after cleanup`,
      });
      logger.warn(
        { jobId: job.id, estimatedTokens, budget: TOKEN_BUDGET },
        `ingestion: Document oversized (~${tokensK}K tokens), parking job`,
      );
      if (this.notify) {
        this.notify(
          `Document '${fileName}' is too large for single-pass processing (~${tokensK}K tokens after cleanup). Retry or dismiss it from the dashboard.`,
        );
      }
      return; // Do NOT throw — prevent drainer catch from overriding status
    }

    let vaultManifest: string | undefined;
    try {
      vaultManifest = buildVaultManifest(this.vaultDir);
    } catch (err) {
      logger.warn(
        { jobId: job.id, err },
        'Failed to build vault manifest — proceeding without it',
      );
    }

    const sentinelPath = join(draftsDir, `${job.id}-complete`);

    // Shared abort controller — either side can signal the other to stop.
    const ac = new AbortController();

    // Validation loop — runs concurrently with the container.
    // Polls for sentinel, validates drafts, sends IPC corrections or _close.
    const validationLoop = async (): Promise<void> => {
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (ac.signal.aborted) return;

        const sentinelFound = await waitForSentinel(
          sentinelPath,
          SENTINEL_TIMEOUT,
          1000,
          ac.signal,
        );

        if (ac.signal.aborted) return;

        if (!sentinelFound) {
          logger.warn(
            { jobId: job.id },
            'Sentinel timeout — sending IPC close',
          );
          sendIpcClose(job.id, DATA_DIR);
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
            DATA_DIR,
            'Output validation passed. Your work is complete. Shutting down.',
          );
          // Small delay so the agent receives the message before _close
          await new Promise((r) => setTimeout(r, 500));
          sendIpcClose(job.id, DATA_DIR);
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
            DATA_DIR,
            `Validation failed after ${maxAttempts} attempts. Shutting down.\n\n${formatValidationMessage(validation)}`,
          );
          await new Promise((r) => setTimeout(r, 500));
          sendIpcClose(job.id, DATA_DIR);
          // Signal the container to stop waiting
          ac.abort();
          throw new Error(
            `Draft validation failed after ${maxAttempts} attempts: ${validation.errors.map((e) => e.message).join('; ')}`,
          );
        }

        // Delete sentinel so we can wait for a new one
        try {
          unlinkSync(sentinelPath);
        } catch {
          // Already gone
        }

        // Send corrections to agent via IPC — agent fixes and writes new sentinel
        sendIpcMessage(job.id, DATA_DIR, formatValidationMessage(validation));
      }
    };

    // Run container and validation concurrently.
    // When the container exits (success or error), abort the validation loop.
    // When validation fails terminally, it aborts before throwing.
    const containerPromise = this.agentProcessor
      .process(
        extractionPath,
        fileName,
        job.id,
        this.reviewAgentGroup,
        vaultManifest,
        {
          source_type: job.source_type,
          zotero_key: job.zotero_key,
          zotero_metadata: job.zotero_metadata,
        },
      )
      .finally(() => ac.abort());

    const validationPromise = validationLoop();

    // Use allSettled so we can inspect both outcomes regardless of which threw.
    const [containerSettled, validationSettled] = await Promise.allSettled([
      containerPromise,
      validationPromise,
    ]);

    // Collect the error (if any) from either promise.
    let error: Error | undefined;
    if (containerSettled.status === 'rejected') {
      error =
        containerSettled.reason instanceof Error
          ? containerSettled.reason
          : new Error(String(containerSettled.reason));
    } else if (validationSettled.status === 'rejected') {
      error =
        validationSettled.reason instanceof Error
          ? validationSettled.reason
          : new Error(String(validationSettled.reason));
    } else {
      const result = containerSettled.value;
      if (result.status === 'error') {
        error = new Error(result.error || 'Agent processing failed');
      }
    }

    if (error) {
      const msg = error.message;
      if (isRateLimitError(msg)) {
        // Look up current retry_count from DB
        const allJobs = getIngestionJobs('generating') as JobRow[];
        const current = allJobs.find((j) => j.id === job.id);
        const retryCount = current?.retry_count ?? 0;
        const delays = [5 * 60_000, 15 * 60_000, 60 * 60_000]; // 5min, 15min, 60min
        const delay = delays[Math.min(retryCount, delays.length - 1)];
        const retryAfter = new Date(Date.now() + delay).toISOString();

        updateIngestionJob(job.id, {
          status: 'rate_limited',
          error: `generating:${msg}`,
          retry_after: retryAfter,
        });
        logger.warn(
          { jobId: job.id, retryAfter, retryCount: retryCount + 1 },
          `ingestion: Rate limited, will retry after ${retryAfter}`,
        );
        return; // Do NOT re-throw — prevent drainer catch from overriding to 'failed'
      }
      throw error;
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

    let promotedSourcePath: string | undefined;

    // Promote source note (with figures from the extraction artifacts)
    const promotedPaths: string[] = [];
    if (manifest.source_note) {
      const sourceDraftPath = join(draftsDir, manifest.source_note);
      const figuresDir = job.extraction_path
        ? join(job.extraction_path, 'figures')
        : undefined;
      try {
        const { notePath, figurePaths } = promoteNote(
          sourceDraftPath,
          this.vaultDir,
          job.id,
          figuresDir,
        );
        promotedPaths.push(notePath);
        promotedSourcePath = join(this.vaultDir, notePath);
        logger.info(
          { jobId: job.id, promoted: notePath, figures: figurePaths.length },
          'Promoted source note',
        );
      } catch (err) {
        logger.warn(
          { jobId: job.id, file: manifest.source_note, err },
          'Failed to promote source note',
        );
      }
    }

    // Promote concept notes (no figures — only source notes get them)
    for (const conceptFile of manifest.concept_notes) {
      const conceptDraftPath = join(draftsDir, conceptFile);
      try {
        const { notePath } = promoteNote(
          conceptDraftPath,
          this.vaultDir,
          job.id,
        );
        promotedPaths.push(notePath);
        logger.info(
          { jobId: job.id, promoted: notePath },
          'Promoted concept note',
        );
      } catch (err) {
        logger.warn(
          { jobId: job.id, file: conceptFile, err },
          'Failed to promote concept note',
        );
      }
    }

    // --- Citation linking (non-blocking enrichment) ---
    if (promotedSourcePath && job.extraction_path) {
      try {
        const newSlug = promotedSourcePath
          .split('/')
          .pop()!
          .replace(/\.md$/, '');

        // Re-ingestion: clear old edges before rebuilding
        deleteCitationEdges(newSlug);

        const contentPath = join(job.extraction_path, 'content.md');
        const extractedContent = readFileSync(contentPath, 'utf-8');
        const bibEntries = extractBibliography(extractedContent);
        if (bibEntries.length > 0) {
          const sourcesDir = join(this.vaultDir, 'sources');
          linkCitations(bibEntries, promotedSourcePath, sourcesDir);
          logger.info(
            { jobId: job.id, bibEntries: bibEntries.length },
            'Citation linking completed',
          );
        } else {
          logger.info(
            { jobId: job.id },
            'No bibliography entries found — skipping citation linking',
          );
        }
      } catch (err) {
        logger.warn(
          { jobId: job.id, err },
          'Citation linking failed — continuing without it',
        );
      }
    }

    // --- Concept discovery (non-blocking) ---
    try {
      const discovered = discoverConcepts(promotedPaths, this.vaultDir);
      let inserted = 0;
      for (const concept of discovered) {
        if (!concept.vaultNotePath) continue;
        const existing = getConceptByVaultPath(concept.vaultNotePath);
        if (!existing) {
          createConcept(concept);
          inserted++;
        }
      }
      if (inserted > 0) {
        logger.info(
          { jobId: job.id, discovered: discovered.length, inserted },
          `study: Discovered ${inserted} new concept(s)`,
        );
      }
    } catch (err) {
      logger.warn(
        { jobId: job.id, err },
        'Concept discovery failed — continuing without it',
      );
    }

    // Move source file to processed/ (skip for Zotero — file is managed by Zotero)
    if (job.source_type !== 'zotero') {
      await mkdir(PROCESSED_DIR, { recursive: true });
      try {
        await rename(
          job.source_path,
          join(PROCESSED_DIR, `${job.id}-${fileName}`),
        );
      } catch {
        logger.warn({ jobId: job.id }, 'Failed to move source to processed/');
      }
    }

    // Cleanup — sentinel, manifest, any remaining draft files, extraction artifacts
    cleanupSentinel(draftsDir, job.id);
    cleanupDraftBundle(draftsDir, job.id);
    await this.extractor.cleanup(job.id);
    if (job.source_type !== 'zotero') {
      await this.pruneEmptyDirs(dirname(job.source_path));
    }

    updateIngestionJob(job.id, {
      status: 'completed',
      promoted_paths: JSON.stringify(promotedPaths),
    });

    // Zotero write-back: post summary note + tag
    if (
      job.source_type === 'zotero' &&
      job.zotero_key &&
      this.zoteroWriteBack
    ) {
      const sourceNotePath = promotedPaths.find((p) =>
        p.startsWith('sources/'),
      );
      if (sourceNotePath) {
        try {
          const fullPath = join(this.vaultDir, sourceNotePath);
          const noteContent = readFileSync(fullPath, 'utf-8');
          await this.zoteroWriteBack.writeBack(
            job.zotero_key,
            noteContent,
            promotedPaths,
          );
        } catch (err) {
          logger.warn(
            { jobId: job.id, zoteroKey: job.zotero_key, err },
            'Zotero write-back failed',
          );
        }
      }
    }

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

    markInterruptedJobsFailed();

    await this.watcher.start();
    this.drainer.drain();

    // Start Zotero watchers if enabled — one per library (user + each configured group)
    if (ZOTERO_ENABLED) {
      if (ZOTERO_API_KEY && ZOTERO_USER_ID) {
        const webClient = new ZoteroWebClient(ZOTERO_API_KEY, ZOTERO_USER_ID);
        this.zoteroWriteBack = new ZoteroWriteBack(webClient);
      } else {
        logger.warn(
          'Zotero write-back disabled — ZOTERO_API_KEY or ZOTERO_USER_ID not set',
        );
      }

      const libraries: { libraryPath: string; syncKey: string; label: string }[] = [
        { libraryPath: 'users/0', syncKey: 'library_version', label: 'user' },
        ...ZOTERO_GROUP_IDS.map((id) => ({
          libraryPath: `groups/${id}`,
          syncKey: `group:${id}:library_version`,
          label: `group:${id}`,
        })),
      ];

      for (const lib of libraries) {
        const client = new ZoteroLocalClient(ZOTERO_LOCAL_URL, lib.libraryPath);
        const watcher = new ZoteroWatcher({
          client,
          excludeCollection: ZOTERO_EXCLUDE_COLLECTION,
          onItem: (filePath, zoteroKey, metadata) => {
            this.enqueueZotero(filePath, zoteroKey, metadata);
          },
          pollIntervalMs: ZOTERO_POLL_INTERVAL,
          syncKey: lib.syncKey,
          label: lib.label,
        });
        await watcher.start();
        this.zoteroWatchers.push(watcher);
      }
      logger.info(
        { libraries: libraries.map((l) => l.label) },
        'Zotero integration enabled',
      );
    }

    logger.info(`Watching ${this.uploadDir} for new files`);
  }

  async stop(): Promise<void> {
    for (const w of this.zoteroWatchers) {
      w.stop();
    }
    this.zoteroWatchers = [];
    await this.drainer.stop();
    await this.watcher.stop();
  }
}
