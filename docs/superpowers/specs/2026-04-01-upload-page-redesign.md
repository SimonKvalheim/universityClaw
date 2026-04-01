# Upload Page Redesign

Redesign the dashboard upload page from a minimal single-file drop zone into a full ingestion management interface with multi-file upload, real-time status tracking, retry controls, and vault output preview.

## Context

The current upload page (`dashboard/src/app/upload/page.tsx`) supports single-file drag-and-drop with no history, status tracking, or feedback beyond "Uploaded: filename". The ingestion pipeline already tracks full job lifecycle in the `ingestion_jobs` SQLite table, but this data is not exposed to the dashboard.

## Architecture: Approach B — Shared Hooks, Separated Concerns

New API routes expose ingestion data. Two custom React hooks handle upload management and job polling. The page component stays thin — layout and composition only.

## API Layer

### New Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/ingestion/jobs` | GET | Last 20 jobs, ordered by `created_at` desc. Optional `?status=` filter. |
| `/api/ingestion/jobs/[id]` | GET | Single job with manifest data (generated note filenames) for completed jobs. |
| `/api/ingestion/retry/[id]` | POST | Reset `failed` job to `pending`, clear error. Returns 409 if source file missing from disk. |
| `/api/ingestion/settings` | GET | Current pipeline settings (maxGenerationConcurrent). |
| `/api/ingestion/settings` | PATCH | Update pipeline settings. Takes effect on next drainer poll cycle (~5s). |

### Existing Route Changes

`POST /api/upload` — accept multiple files in a single FormData request. Return an array of `{ ok, filename, path }` results.

### Response Shapes

```typescript
// GET /api/ingestion/jobs
interface JobsResponse {
  jobs: JobSummary[];
}

interface JobSummary {
  id: string;
  filename: string;
  status: 'pending' | 'extracting' | 'extracted' | 'generating' | 'promoting' | 'completed' | 'failed' | 'rate_limited';
  error: string | null;
  createdAt: string;   // ISO 8601
  updatedAt: string;
  completedAt: string | null;
}

// GET /api/ingestion/jobs/[id]
interface JobDetailResponse extends JobSummary {
  notes?: {
    sourceNote: string;       // filename
    conceptNotes: string[];   // filenames
  };
}

// GET /api/ingestion/settings
interface SettingsResponse {
  maxGenerationConcurrent: number;
}
```

## Pipeline Changes

### New Status: `rate_limited`

When a job fails due to a session/rate limit (detected by matching error strings: "rate limit", "session limit", "overloaded", or specific API error codes), the pipeline sets status to `rate_limited` instead of `failed`.

The `error` field stores the original error message. A separate `retry_after` TEXT column is added to `ingestion_jobs` to hold the ISO 8601 timestamp for the next retry attempt.

### Auto-retry Logic

On each drainer poll cycle, check for `rate_limited` jobs where `retryAfter` has passed. Reset to `pending` for normal pipeline pickup.

Backoff schedule when no explicit `retry-after` header is available:
- 1st rate limit: retry after 5 minutes
- 2nd rate limit: retry after 15 minutes
- 3rd+ rate limit: retry after 60 minutes

### Concurrency Setting

`maxGenerationConcurrent` is stored in a `settings` table in SQLite (key-value pairs). Read on each drainer poll cycle. Changes via the PATCH endpoint take effect within ~5 seconds. Default: 1.

## React Hooks

### `useFileUpload()`

Manages the staging → upload flow for multi-file drops.

```typescript
interface UseFileUploadReturn {
  files: StagedFile[];         // files waiting to be uploaded
  addFiles: (files: File[]) => void;  // validate and stage
  removeFile: (name: string) => void; // remove from staging
  uploadAll: () => Promise<void>;     // submit batch
  isUploading: boolean;
}

interface StagedFile {
  file: File;
  status: 'staged' | 'uploading' | 'uploaded' | 'upload-failed' | 'duplicate';
  error?: string;
}
```

- Validates PDF-only on `addFiles`. Rejects others with per-file error.
- Uploads all staged files in a single multi-file FormData POST.
- After upload, the hook accepts a `jobs` array (passed in from `useIngestionJobs`) to check whether uploaded filenames appear as new jobs. If a file doesn't appear within ~10 seconds (3 poll cycles), marks it as `duplicate` with "Already processed — duplicate content" message.

### `useIngestionJobs(pollInterval = 3000)`

Polls job status from the API.

```typescript
interface UseIngestionJobsReturn {
  jobs: JobSummary[];
  isLoading: boolean;
  retry: (jobId: string) => Promise<void>;
}
```

- Polls `GET /api/ingestion/jobs` on interval.
- Pauses polling when `document.hidden` is true (tab backgrounded).
- `retry()` calls `POST /api/ingestion/retry/:id`, then forces immediate re-poll.

## UI Layout

### Structure

Grouped & collapsible layout:

1. **Header area** — page title, concurrency selector ("Parallel jobs: 1 2 3 4 5" segmented control)
2. **Drop zone** — compact, always visible. Shows staging list when files are added, with per-file remove buttons and "Upload all" action.
3. **In Progress group** — collapsible, open by default. Contains `pending`, `extracting`, `generating`, `promoting`, and `rate_limited` jobs.
4. **Completed group** — collapsible, collapsed by default. Contains `completed` jobs.
5. **Failed group** — collapsible, collapsed by default. Contains `failed` jobs. Only visible when there are failed jobs.

### Job Row

| Element | Behavior |
|---------|----------|
| Filename | Always visible |
| Status badge | Color-coded: pending (gray), extracting (orange), generating (blue), promoting (blue), completed (green), failed (red), rate_limited (amber) |
| Progress bar | Segmented: pending=0%, extracting=25%, extracted=50%, generating=75%, completed=100% |
| Timestamp | Relative ("2 min ago") with absolute time in tooltip |
| Error message | Inline below filename on failed jobs |
| Rate-limit info | Amber badge: "Waiting for session reset — retries in ~Xm" |
| Retry button | Failed jobs only. Rate-limited jobs show "Retry now" override. |
| Expand arrow | Completed jobs only |

### Expanded Completed Row

Shows the manifest output:
- Source note filename → links to `/vault?file=sources/{name}.md`
- Concept note filenames → each links to `/vault?file=concepts/{name}.md`
- Count: "1 source note + 3 concept notes"

Manifest data fetched on-demand from `GET /api/ingestion/jobs/[id]` when the user expands the row.

## File Validation

- PDF only (`.pdf` extension check on client)
- Non-PDF files rejected with inline error: "Only PDF files are supported"
- Matches backend file watcher which also only processes `.pdf`

## Duplicate Detection

Handled by existing backend content-hash dedup in the file watcher. The watcher computes SHA256 of uploaded files and skips if an identical file already has a `completed` job.

Frontend detects this indirectly: if a file was uploaded but no corresponding job appears within ~10 seconds, the staging entry shows "Already processed — duplicate content" before clearing.

## Data Flow

```
User drops files
  → Client validates (PDF only)
  → Staging list shown
  → User clicks "Upload all"
  → POST /api/upload (multi-file FormData)
  → Files written to UPLOAD_DIR
  → File watcher detects new files (chokidar)
  → Dedup check (content hash)
  → Job created in ingestion_jobs table
  → Pipeline drainer picks up pending jobs
  → extracting → generating → promoting → completed
  → Client polls GET /api/ingestion/jobs every 3s
  → UI updates in real-time
```

Rate-limit branch:
```
generating fails with rate limit
  → Status set to rate_limited (not failed)
  → retryAfter timestamp stored
  → Drainer checks rate_limited jobs each cycle
  → When retryAfter passes, reset to pending
  → Normal pipeline resumes
```

## Files to Create/Modify

### New files
- `dashboard/src/app/api/ingestion/jobs/route.ts` — jobs list endpoint
- `dashboard/src/app/api/ingestion/jobs/[id]/route.ts` — job detail endpoint
- `dashboard/src/app/api/ingestion/retry/[id]/route.ts` — retry endpoint
- `dashboard/src/app/api/ingestion/settings/route.ts` — settings endpoint
- `dashboard/src/hooks/useFileUpload.ts` — upload staging hook
- `dashboard/src/hooks/useIngestionJobs.ts` — job polling hook

### Modified files
- `dashboard/src/app/upload/page.tsx` — full rewrite with new layout
- `dashboard/src/app/api/upload/route.ts` — multi-file support
- `src/ingestion/pipeline.ts` — rate_limited status, auto-retry logic, dynamic concurrency
- `src/db.ts` — add `retry_after` column, `rate_limited` status handling, `settings` table, read/write helpers
