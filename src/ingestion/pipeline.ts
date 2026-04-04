import { getJobsByStatus, updateIngestionJob } from '../db.js';

export interface JobRow {
  id: string;
  source_path: string;
  source_filename: string;
  status: string;
  extraction_path: string | null;
  created_at: string;
  updated_at: string;
  retry_after?: string | null;
  retry_count?: number;
  error?: string | null;
  source_type?: string;
  zotero_key?: string | null;
  zotero_metadata?: string | null;
}

export interface PipelineDrainerOpts {
  onExtract: (job: JobRow) => Promise<void>;
  onGenerate: (job: JobRow) => Promise<void>;
  onPromote: (job: JobRow) => Promise<void>;
  onComplete?: (job: JobRow) => Promise<void>;
  maxExtractionConcurrent: number;
  maxGenerationConcurrent: number | (() => number);
  pollIntervalMs: number;
}

export class PipelineDrainer {
  private opts: PipelineDrainerOpts;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeExtractions = 0;
  private activeGenerations = 0;
  private inFlight: Set<Promise<void>> = new Set();

  constructor(opts: PipelineDrainerOpts) {
    this.opts = opts;
  }

  private getMaxGenerationConcurrent(): number {
    const val = this.opts.maxGenerationConcurrent;
    return typeof val === 'function' ? val() : val;
  }

  drain(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async tick(): Promise<void> {
    this.drainRateLimited();
    await this.drainExtractions();
    await this.drainGenerations();
    await this.drainPromotions();
  }

  private static readonly STAGE_RESET_MAP: Record<string, string> = {
    extracting: 'pending',
    generating: 'extracted',
    promoting: 'generated',
  };

  drainRateLimited(): void {
    const jobs = getJobsByStatus('rate_limited') as JobRow[];
    const now = Date.now();

    for (const job of jobs) {
      if (job.retry_after) {
        const retryAt = new Date(job.retry_after).getTime();
        if (retryAt > now) continue;
      }

      // Determine reset status from the error prefix (e.g. "generating:rate limit exceeded")
      let resetStatus = 'pending'; // fallback
      if (job.error) {
        const stage = job.error.split(':')[0];
        if (PipelineDrainer.STAGE_RESET_MAP[stage]) {
          resetStatus = PipelineDrainer.STAGE_RESET_MAP[stage];
        }
      }

      updateIngestionJob(job.id, {
        status: resetStatus,
        error: null,
        retry_after: null,
        retry_count: (job.retry_count ?? 0) + 1,
      });
    }
  }

  async drainExtractions(): Promise<void> {
    const slots = this.opts.maxExtractionConcurrent - this.activeExtractions;
    if (slots <= 0) return;

    const pending = getJobsByStatus('pending') as JobRow[];
    const batch = pending.slice(0, slots);

    for (const job of batch) {
      updateIngestionJob(job.id, { status: 'extracting' });
      this.activeExtractions++;
      const p = this.opts
        .onExtract(job)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          updateIngestionJob(job.id, {
            status: 'failed',
            error: `extracting:${msg}`,
          });
        })
        .finally(() => {
          this.activeExtractions--;
          this.inFlight.delete(p);
        });
      this.inFlight.add(p);
    }
  }

  async drainGenerations(): Promise<void> {
    const maxGen = this.getMaxGenerationConcurrent();
    const slots = maxGen - this.activeGenerations;
    if (slots <= 0) return;

    const extracted = getJobsByStatus('extracted') as JobRow[];

    for (const job of extracted) {
      if (this.activeGenerations >= maxGen) break;

      updateIngestionJob(job.id, { status: 'generating' });
      this.activeGenerations++;
      const p = this.opts
        .onGenerate(job)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          updateIngestionJob(job.id, {
            status: 'failed',
            error: `generating:${msg}`,
          });
        })
        .finally(() => {
          this.activeGenerations--;
          this.inFlight.delete(p);
        });
      this.inFlight.add(p);
    }
  }

  async drainPromotions(): Promise<void> {
    const generated = getJobsByStatus('generated') as JobRow[];
    for (const job of generated) {
      updateIngestionJob(job.id, { status: 'promoting' });
      try {
        await this.opts.onPromote(job);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        updateIngestionJob(job.id, {
          status: 'failed',
          error: `promoting:${msg}`,
        });
      }
    }
  }
}
