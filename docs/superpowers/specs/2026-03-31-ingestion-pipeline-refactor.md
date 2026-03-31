# Ingestion Pipeline Refactor

**Date:** 2026-03-31
**Status:** Approved
**Scope:** `src/ingestion/`, `src/db.ts`, `src/config.ts`, vault/upload filesystem cleanup

## Problem

The ingestion pipeline was built for bulk upload of mixed file types across university courses. The project has since shifted to single-document upload of research articles (PDF only). Several subsystems are outdated:

- **Stale-job recovery** auto-retries crashed jobs, which caused a completed job (Kirschner 2002) to re-run an expensive agent container unnecessarily. The agent found its own prior output, reported "already completed," but the pipeline didn't advance the job — leaving it stuck in `generating` and blocking promotion.
- **No duplicate detection** — re-uploading the same PDF creates a new job and duplicate vault notes.
- **No pre-generation check** — even when valid drafts exist from a prior run, the pipeline spawns a new agent container instead of skipping to promotion.
- **File watcher accepts 14 file types** including Word temp files (`~$*.docx`) that immediately fail extraction.
- **Attachment copy is redundant** — the original PDF is preserved in `upload/processed/`, but also copied to `vault/attachments/_unsorted/`.
- **Dead code** in `db.ts` (`updateIngestionJobStatus`, duplicate `getIngestionJobs`).
- **Legacy filesystem clutter** — `upload/.processed/` (103 files), `vault/attachments/_unsorted/` (130+ files), empty vault subdirectories, 100+ stale extraction directories.

## Design

### 1. File watcher — PDF only

**File:** `src/ingestion/file-watcher.ts`

Restrict `SUPPORTED_EXTENSIONS` to `['.pdf']`. Add `~$` prefix check to the ignored-files filter so Word/Excel lock files are rejected even if `.pdf` is somehow appended.

```ts
const SUPPORTED_EXTENSIONS = new Set(['.pdf']);

// In the add handler:
if (fileName.startsWith('~$')) return;
```

### 2. Content-hash dedup

**Files:** `src/db.ts`, `src/ingestion/index.ts`

Add `content_hash TEXT` column to `ingestion_jobs`. On enqueue:

1. Compute SHA-256 of the file bytes (cheap — runs in <100ms for typical PDFs).
2. Query: `SELECT id FROM ingestion_jobs WHERE content_hash = ? AND status = 'completed' LIMIT 1`.
3. If found → log `"Skipping duplicate of completed job {id}: {filename}"` and return without creating a job.
4. If not found → proceed with existing path-based dedup, then create the job with the hash stored.

New DB function:

```ts
export function getCompletedJobByHash(hash: string): { id: string } | undefined {
  return db
    .prepare(
      `SELECT id FROM ingestion_jobs WHERE content_hash = ? AND status = 'completed' LIMIT 1`,
    )
    .get(hash) as { id: string } | undefined;
}
```

Schema migration (in `runMigrations`):

```ts
database.exec(`ALTER TABLE ingestion_jobs ADD COLUMN content_hash TEXT`);
database.exec(`CREATE INDEX idx_ingestion_jobs_hash ON ingestion_jobs(content_hash)`);
```

### 3. Recovery — mark failed, no auto-retry

**File:** `src/ingestion/job-recovery.ts`

Replace `recoverStaleJobs()` with `markInterruptedJobsFailed()`. On startup:

- Find all jobs in `extracting`, `generating`, or `promoting` status.
- Set each to `failed` with error `"Interrupted: process restarted"`.
- No thresholds, no conditional reset, no re-queuing.

```ts
export function markInterruptedJobsFailed(): number {
  const statuses = ['extracting', 'generating', 'promoting'];
  let count = 0;
  for (const status of statuses) {
    const stuck = getJobsByStatus(status);
    for (const job of stuck) {
      updateIngestionJob(job.id, {
        status: 'failed',
        error: 'Interrupted: process restarted',
      });
      count++;
    }
  }
  return count;
}
```

Update `index.ts` startup call to use the new function.

### 4. Pre-generation draft check

**File:** `src/ingestion/index.ts`, in `handleGeneration()`

Before spawning the agent container, check whether valid drafts already exist:

```ts
const draftsDir = join(this.vaultDir, 'drafts');
const existingValidation = validateDrafts(draftsDir, job.id, fileName);
if (existingValidation.valid) {
  logger.info({ jobId: job.id }, 'Valid drafts already exist — skipping agent');
  updateIngestionJob(job.id, { status: 'generated' });
  return;
}
```

This catches the exact scenario that caused the Kirschner re-run: recovery resets a job, but drafts from the prior run are still valid.

### 5. Skip re-extraction when artifacts exist

**File:** `src/ingestion/index.ts`, in `handleExtraction()`

The `Extractor` class already has `hasArtifacts(jobId)`. Wire it up:

```ts
if (await this.extractor.hasArtifacts(job.id)) {
  logger.info({ jobId: job.id }, 'Extraction artifacts exist — skipping Docling');
  const dir = this.extractor.getExtractionDir(job.id);
  updateIngestionJob(job.id, {
    status: 'extracted',
    extraction_path: dir,
  });
  return;
}
```

Remove the redundant original-PDF copy to `vault/attachments/_unsorted/` (lines 123-143). The original is preserved in `upload/processed/` after promotion.

### 6. Figures destination

**File:** `src/ingestion/index.ts`, in `handleExtraction()`

Change figures copy destination from `vault/attachments/_unsorted/figures/` to `vault/attachments/{jobId}/`:

```ts
if (result.figures.length > 0) {
  const figuresAttachDir = join(this.vaultDir, 'attachments', job.id);
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
```

### 7. Small fixes

| File | Fix |
|------|-----|
| `src/ingestion/index.ts:254` | Remove dynamic `import('fs')`, use top-level `unlinkSync` (already available via other imports in the file) |
| `src/ingestion/promoter.ts` | Add `mkdirSync(join(vaultDir, destFolder), { recursive: true })` before `renameSync` |
| `src/db.ts:726-735` | Delete `updateIngestionJobStatus()` — dead code, superseded by `updateIngestionJob()` |
| `src/db.ts:737-748` | Delete `getIngestionJobs()` — duplicate of `getJobsByStatus()`. Update any callers (dashboard API) to use `getJobsByStatus()` or `getRecentlyCompletedJobs()` |
| `src/config.ts:131-133` | Change `SENTINEL_TIMEOUT` to use `parseInt(..., 10)` consistent with other timeouts |

### 8. One-time filesystem cleanup

Execute manually (not in code):

| Target | Action |
|--------|--------|
| `upload/.processed/` | Delete entirely (103 legacy bulk-upload files) |
| `vault/attachments/_unsorted/` | Delete entirely (130+ legacy files, no figures present) |
| `vault/_nav/` | Delete (empty) |
| `vault/courses/` | Delete (empty with empty `_unsorted/` subdir) |
| `vault/resources/` | Delete (empty subdirs: `articles/`, `books/`, `external/`) |
| `vault/profile/` | Delete (example templates + empty `archive/`) |
| `data/extractions/` | Purge all directories except those belonging to the 2 completed jobs (`bc8dd53d`, `eb66e42f`) |
| DB: `ingestion_jobs` | Delete all rows where `status = 'failed'`. Keep the 2 completed jobs. |

### 9. Post-cleanup vault structure

```
vault/
  sources/          ← promoted source overview notes
  concepts/         ← promoted atomic concept notes
  drafts/           ← temporary, cleared after promotion
  attachments/      ← {jobId}/ subdirs for extracted figures (when present)

upload/
  processed/        ← {jobId}-{filename}.pdf originals
```

## Out of scope

- **Content-level dedup** (comparing extracted text to detect same article from different PDF sources) — future vault maintenance project.
- **Dashboard retry button** — could be added later to let you re-queue a failed job from the web UI.
- **Web platform upload restrictions** — enforcing PDF-only in the dashboard upload form is a separate change.

## Testing

- Existing unit tests for `draft-validator`, `manifest`, `promoter`, `pipeline`, `extractor`, `file-watcher`, `job-recovery` should be updated to match the new behavior.
- Key scenarios to verify:
  - Re-uploading an identical PDF → skipped with "duplicate" log
  - Re-uploading a renamed copy of the same PDF → skipped (same hash)
  - Job interrupted mid-extraction → marked `failed` on restart, not retried
  - Job with valid drafts from prior run → skips agent, advances to `generated`
  - PDF with figures → figures copied to `vault/attachments/{jobId}/`
  - Non-PDF file dropped in `upload/` → ignored by watcher
