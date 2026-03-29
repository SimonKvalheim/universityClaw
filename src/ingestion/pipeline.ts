import { getJobsByStatus, updateIngestionJob } from '../db.js';

export interface JobRow {
  id: string;
  source_path: string;
  source_filename: string;
  status: string;
  tier: number;
  extraction_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineDrainerOpts {
  onExtract: (job: JobRow) => Promise<void>;
  onGenerate: (job: JobRow) => Promise<void>;
  onComplete?: (job: JobRow) => Promise<void>;
  maxExtractionConcurrent: number;
  maxGenerationConcurrent: number;
  pollIntervalMs: number;
}

export class PipelineDrainer {
  private opts: PipelineDrainerOpts;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeExtractions = 0;
  private activeGenerations = 0;

  constructor(opts: PipelineDrainerOpts) {
    this.opts = opts;
  }

  drain(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.pollIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    await this.drainExtractions();
    await this.drainGenerations();
  }

  async drainExtractions(): Promise<void> {
    const slots = this.opts.maxExtractionConcurrent - this.activeExtractions;
    if (slots <= 0) return;

    const pending = getJobsByStatus('pending') as JobRow[];
    const batch = pending.slice(0, slots);

    for (const job of batch) {
      updateIngestionJob(job.id, { status: 'extracting' });
      this.activeExtractions++;
      this.opts
        .onExtract(job)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          updateIngestionJob(job.id, { status: 'failed', error: msg });
        })
        .finally(() => {
          this.activeExtractions--;
        });
    }
  }

  async drainGenerations(): Promise<void> {
    const slots = this.opts.maxGenerationConcurrent - this.activeGenerations;
    if (slots <= 0) return;

    const extracted = getJobsByStatus('extracted') as JobRow[];

    for (const job of extracted) {
      if (job.tier === 1) {
        // Tier 1: no AI needed, auto-complete
        updateIngestionJob(job.id, { status: 'completed' });
        this.opts.onComplete?.(job).catch(() => {});
        continue;
      }

      if (this.activeGenerations >= this.opts.maxGenerationConcurrent) break;

      updateIngestionJob(job.id, { status: 'generating' });
      this.activeGenerations++;
      this.opts
        .onGenerate(job)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          updateIngestionJob(job.id, { status: 'failed', error: msg });
        })
        .finally(() => {
          this.activeGenerations--;
        });
    }
  }
}
