# Upload Page Redesign

Redesign the dashboard upload page from a minimal single-file drop zone into a full ingestion management interface with multi-file upload, real-time status tracking, retry controls, and vault output preview.

## Context

The current upload page (`dashboard/src/app/upload/page.tsx`) supports single-file drag-and-drop with no history, status tracking, or feedback beyond "Uploaded: filename". The ingestion pipeline already tracks full job lifecycle in the `ingestion_jobs` SQLite table, but this data is not exposed to the dashboard.

## Architecture: Approach B — Shared Hooks, Separated Concerns

New API routes expose ingestion data. Two custom React hooks handle upload management and job polling. The page component stays thin — layout and composition only.

## Database Access

The dashboard (Next.js) and main NanoClaw process (Node.js) share the same SQLite database (`store/messages.db`). SQLite WAL mode enables safe concurrent access — one writer with many readers.

A shared read-only DB module (`src/shared/db-reader.ts`) encapsulates the query functions needed by the dashboard. It opens the database in read-only mode (`readonly: true`) with a `busy_timeout` of 5000ms. The dashboard imports this module for all GET endpoints. Write operations (retry, settings) use a separate writer connection with `busy_timeout` to handle brief contention with the main process.

The shared module is a thin query layer — it imports the DB path from config and exports typed query functions. It does not duplicate schema definitions; those remain in `src/db.ts`. The dashboard's `next.config.ts` adds `better-sqlite3` to `serverExternalPackages`.

## API Layer

### New Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/ingestion/jobs` | GET | Last 20 jobs, ordered by `created_at` desc. Optional `?status=` filter. |
| `/api/ingestion/jobs/[id]` | GET | Single job with manifest data (generated note filenames) for completed jobs. Returns promoted vault paths. |
| `/api/ingestion/retry/[id]` | POST | Reset `failed` job to `pending` or to last successful stage (see Retry Semantics). Returns 409 if source file missing. |
| `/api/ingestion/settings` | GET | Current pipeline settings (maxGenerationConcurrent). |
| `/api/ingestion/settings` | PATCH | Update pipeline settings. Takes effect on next drainer poll cycle (~5s). |

### Existing Route Changes

`POST /api/upload` — accept multiple files in a single FormData request. Append a short random suffix to sanitized filenames to prevent collisions in a batch (e.g., `lecture-09_a3f2.pdf`). Return an array of `{ ok, filename, path }` results. Enforce a 100 MB per-file size limit (server-side check; client shows error for files exceeding this).

### Response Shapes

```typescript
// GET /api/ingestion/jobs
interface JobsResponse {
  jobs: JobSummary[];
}

interface JobSummary {
  id: string;
  filename: string;
  status: 'pending' | 'extracting' | 'extracted' | 'generating' | 'generated' | 'promoting' | 'completed' | 'failed' | 'rate_limited';
  error: string | null;
  retryAfter: string | null;  // ISO 8601, only for rate_limited jobs
  createdAt: string;           // ISO 8601
  updatedAt: string;
  completedAt: string | null;
}

// GET /api/ingestion/jobs/[id]
interface JobDetailResponse extends JobSummary {
  notes?: {
    sourceNote: string;       // promoted vault path (e.g., "sources/lecture-09.md")
    conceptNotes: string[];   // promoted vault paths (e.g., ["concepts/big-o.md", ...])
  };
}

// GET /api/ingestion/settings
interface SettingsResponse {
  maxGenerationConcurrent: number;
}
```

## Pipeline Changes

### New Status: `rate_limited`

When a job fails due to a session/rate limit, the pipeline sets status to `rate_limited` instead of `failed`.

**Detection:** The `onGenerate` callback in `src/ingestion/index.ts` catches errors and inspects the message for rate-limit signals ("rate limit", "session limit", "overloaded", HTTP 429, HTTP 529). If matched, it sets the job status to `rate_limited` directly and does **not** re-throw. The generic catch in `PipelineDrainer.drainGenerations()` only runs on re-thrown errors, so it won't override `rate_limited` with `failed`.

The `error` field stores the original error message. A separate `retry_after` TEXT column holds the ISO 8601 retry timestamp. A `retry_count` INTEGER column (default 0) tracks how many rate-limit retries have occurred for backoff calculation.

### Auto-retry Logic

On each drainer poll cycle, check for `rate_limited` jobs where `retry_after` has passed. Reset to the stage before failure (typically `extracted`, so the job re-enters generation without re-running Docling). Increment `retry_count`.

Backoff schedule when no explicit `retry-after` header is available:
- 1st rate limit (`retry_count` = 0): retry after 5 minutes
- 2nd rate limit (`retry_count` = 1): retry after 15 minutes
- 3rd+ rate limit (`retry_count` >= 2): retry after 60 minutes

### Retry Semantics

Manual retry (via the retry endpoint) and auto-retry are stage-aware:

| Failed during | Reset to | Effect |
|---------------|----------|--------|
| `extracting` | `pending` | Re-runs Docling extraction |
| `generating` | `extracted` | Skips extraction, re-runs agent note generation |
| `promoting` | `generated` | Skips extraction and generation, re-runs vault promotion |

The retry endpoint records the previous `status` before resetting, so the pipeline resumes at the correct stage. The `PipelineDrainer` already picks up jobs by status (`pending` → extract, `extracted` → generate, `generated` → promote), so stage-aware retry works naturally.

### Concurrency Setting

`maxGenerationConcurrent` is stored in a `settings` table in SQLite (key-value pairs). The `PipelineDrainer` constructor accepts a getter `() => number` instead of a fixed value, reading the current setting from the DB on each poll cycle. Default: 1.

### New DB Schema

```sql
-- New columns on ingestion_jobs
ALTER TABLE ingestion_jobs ADD COLUMN retry_after TEXT;
ALTER TABLE ingestion_jobs ADD COLUMN retry_count INTEGER DEFAULT 0;

-- New table for pipeline settings
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

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

- Validates on `addFiles`: PDF-only (extension check), max 100 MB per file. Rejects with per-file error.
- Uploads all staged files in a single multi-file FormData POST.
- After upload, the hook accepts a `jobs` array (passed in from `useIngestionJobs`) to check whether uploaded filenames appear as new jobs. If a file doesn't appear within ~15 seconds (5 poll cycles — accounts for write finalization + watcher + hash check), marks it as `duplicate` with "Already processed — duplicate content" message.

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
3. **In Progress group** — collapsible, open by default. Contains `pending`, `extracting`, `extracted`, `generating`, `generated`, `promoting`, and `rate_limited` jobs.
4. **Completed group** — collapsible, collapsed by default. Contains `completed` jobs.
5. **Failed group** — collapsible, collapsed by default. Contains `failed` jobs. Only visible when there are failed jobs.

### Job Row

| Element | Behavior |
|---------|----------|
| Filename | Always visible |
| Status badge | Color-coded: pending (gray), extracting (orange), generating (blue), promoting (indigo), completed (green), failed (red), rate_limited (amber) |
| Progress bar | Three visible stages: extracting (0–33%), generating (33–66%), promoting (66–100%). Transient statuses (`extracted`, `generated`) are treated as the start of the next stage — e.g., `extracted` shows as 33% (ready for generation). |
| Timestamp | Relative ("2 min ago") with absolute time in tooltip |
| Error message | Inline below filename on failed jobs |
| Rate-limit info | Amber badge: "Waiting for session reset — retries in ~Xm" with countdown based on `retryAfter` |
| Retry button | Failed jobs only. Rate-limited jobs show "Retry now" override. |
| Expand arrow | Completed jobs only |

### Expanded Completed Row

Shows the manifest output with promoted vault paths:
- Source note → links to `/vault?file=sources/{name}.md`
- Concept notes → each links to `/vault?file=concepts/{name}.md`
- Count: "1 source note + 3 concept notes"

The job detail endpoint (`GET /api/ingestion/jobs/[id]`) resolves promoted vault paths by scanning the vault for notes whose frontmatter `source_job` field matches the job ID. This is fetched on-demand when the user expands a row.

## File Validation

- PDF only (`.pdf` extension check on client, confirmed server-side)
- Max 100 MB per file (client-side check with server-side enforcement)
- Non-PDF files rejected with inline error: "Only PDF files are supported"
- Oversized files rejected with: "File exceeds 100 MB limit"
- Matches backend file watcher which also only processes `.pdf`

## Duplicate Detection

Handled by existing backend content-hash dedup in the file watcher. The watcher computes SHA256 of uploaded files and skips if an identical file already has a `completed` job.

Frontend detects this indirectly: if a file was uploaded but no corresponding job appears within ~15 seconds, the staging entry shows "Already processed — duplicate content" before clearing.

## Data Flow

```
User drops files
  → Client validates (PDF only, <100 MB)
  → Staging list shown
  → User clicks "Upload all"
  → POST /api/upload (multi-file FormData)
  → Files written to UPLOAD_DIR (with random suffix to avoid collisions)
  → File watcher detects new files (chokidar)
  → Dedup check (content hash)
  → Job created in ingestion_jobs table
  → Pipeline drainer picks up pending jobs
  → extracting → extracted → generating → generated → promoting → completed
  → Client polls GET /api/ingestion/jobs every 3s
  → UI updates in real-time
```

Rate-limit branch:
```
generating fails with rate limit
  → onGenerate callback detects rate-limit error
  → Status set to rate_limited (not re-thrown, so drainer catch doesn't override)
  → retry_after timestamp stored, retry_count stays unchanged
  → Drainer checks rate_limited jobs each cycle
  → When retry_after passes, reset to extracted, increment retry_count
  → Normal pipeline resumes from generation stage
```

## Files to Create/Modify

### New files
- `src/shared/db-reader.ts` — shared read-only DB query module for dashboard
- `dashboard/src/app/api/ingestion/jobs/route.ts` — jobs list endpoint
- `dashboard/src/app/api/ingestion/jobs/[id]/route.ts` — job detail endpoint
- `dashboard/src/app/api/ingestion/retry/[id]/route.ts` — retry endpoint
- `dashboard/src/app/api/ingestion/settings/route.ts` — settings endpoint
- `dashboard/src/hooks/useFileUpload.ts` — upload staging hook
- `dashboard/src/hooks/useIngestionJobs.ts` — job polling hook

### Modified files
- `dashboard/src/app/upload/page.tsx` — full rewrite with new layout
- `dashboard/src/app/api/upload/route.ts` — multi-file support, filename collision avoidance, size limit
- `dashboard/next.config.ts` — add `better-sqlite3` to `serverExternalPackages`
- `dashboard/package.json` — add `better-sqlite3` dependency
- `src/ingestion/pipeline.ts` — rate_limited handling in drainGenerations, auto-retry logic in new drainRateLimited method, dynamic concurrency via getter
- `src/ingestion/index.ts` — rate-limit detection in onGenerate callback
- `src/db.ts` — add `retry_after` and `retry_count` columns, `settings` table, new query helpers (getSettings, updateSettings, getJobDetail with manifest resolution)
