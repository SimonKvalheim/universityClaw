# Document Processing Pipeline Redesign

**Date**: 2026-03-29
**Status**: Draft
**Scope**: Replace the existing ingestion pipeline with a robust, two-stage, tiered document processing system

## Problem Statement

The current pipeline has critical reliability issues identified by a specialist review team:

1. **DB never updated on approval** — `updateReviewItemStatus()` defined but never called; all review items permanently show as `pending`
2. **In-memory queue + stuck jobs = permanent file loss** — Process crash loses queued files; `generating` jobs skipped forever on restart
3. **Shared IPC directory** — Concurrent ingestion containers share one IPC namespace; `_close` sentinels consumed by wrong container
4. **No atomicity** — 6 sequential operations in `processFile()` with no transactional guarantees
5. **Two independent approval codepaths** — Dashboard API and `ReviewQueue` class both approve drafts through different code, neither updating the DB
6. **Uncoordinated concurrency** — Ingestion containers invisible to GroupQueue; total containers can reach 8

The pipeline was built as a happy-path linear flow with no recovery mechanisms. Each step assumes the previous succeeded and the next will succeed.

## Design Principles

- **Research-grounded**: Architecture based on RAG best practices from Anthropic's contextual retrieval, RAPTOR (ICLR 2024), and patterns from Khoj/Smart Connections
- **Two-stage processing**: Separate deterministic extraction from AI summarization
- **DB as source of truth**: All state transitions go through the database; no in-memory-only queues
- **Idempotent operations**: Every step can be safely retried without side effects
- **Single codepath for mutations**: One approval path, one extraction path, one place where vault files are created
- **Tiered by value**: Spend review effort where it matters (research articles), not where it doesn't (admin docs)

## Architecture Overview

```
Upload (dashboard or filesystem)
  → FileWatcher detects file
  → DB job created (status: pending)
  → Stage 1: Extraction (Docling, host-side Python)
     - PDF/DOCX/PPTX → clean markdown + figures
     - DOCX/PPTX → PDF conversion (for preview, on-demand for Tier 3)
     - Metadata inference from folder structure + student profile
     - Extraction artifacts stored on disk as checkpoint
  → Tier Classification (type + source + profile priority)
  → Stage 2: AI Processing (container, Tier 2/3 only)
     - Reads extraction artifact (not raw file)
     - Generates structured notes with heading hierarchy
     - Extracts key concepts for metadata enrichment
     - singleTurn container with per-job IPC namespace
  → Tier routing:
     - Tier 1: auto-approved, lands in vault immediately
     - Tier 2: auto-approved, appears in "Recently Processed" feed
     - Tier 3: queued for full review with three-panel UI
```

## Job State Machine

The `ingestion_jobs` table is the single source of truth. No in-memory queue.

```
pending → extracting → extracted → generating → generated → reviewing → completed
              ↘ failed      ↘ failed      ↘ failed                ↘ rejected
```

Transitions:
- `pending → extracting`: Extraction subprocess spawned
- `extracting → extracted`: Docling completed, artifacts on disk
- `extracted → generating`: Container spawned for AI processing (Tier 2/3 only)
- `extracted → completed`: Tier 1 auto-approve (skip AI)
- `generating → generated`: Container exited successfully, draft on disk
- `generated → reviewing`: Tier 3 only — queued for human review
- `generated → completed`: Tier 2 auto-approve
- `reviewing → completed`: Human approved
- `reviewing → rejected`: Human rejected

Each transition is gated on the previous step's artifacts existing on disk.

### Startup Recovery

On startup, scan `ingestion_jobs` for stale in-flight states:
- `extracting` older than 10 minutes → reset to `pending`
- `generating` older than 45 minutes → reset to `extracted` (preserves extraction, retries only AI)
- `reviewing` → left alone (human will handle)

The drain loop queries the DB for `pending` and `extracted` jobs instead of popping from an in-memory array.

## Stage 1: Extraction

**Executor**: Host-side Python subprocess (`scripts/docling-extract.py`)
**Concurrency**: Up to 3 parallel Docling processes (CPU-bound, no API cost)
**Input**: Raw uploaded file
**Output**: Extraction artifacts directory

### Artifact Structure

```
data/extractions/{jobId}/
  content.md          — Clean markdown from Docling
  figures/            — Extracted images
    figure-001.png
    figure-002.png
  metadata.json       — Page count, detected language, extraction stats
  preview.pdf         — PDF conversion of DOCX/PPTX (Tier 3 only, on-demand)
```

This directory is a **checkpoint**. If anything after extraction fails, extraction is never redone. Artifacts persist until the job reaches `completed`, then cleaned up.

### PDF Conversion

DOCX and PPTX files are converted to PDF for preview only when they reach Tier 3 review. Uses LibreOffice CLI (`soffice --headless --convert-to pdf`). The preview PDF is stored in the extraction artifacts directory.

Tier 1/2 documents skip PDF conversion entirely.

### Metadata Inference

During extraction, metadata is inferred from multiple sources (in priority order):
1. Upload form fields (if provided via dashboard)
2. Folder structure parsing (existing `path-parser.ts` logic)
3. Document content analysis (Docling metadata output)
4. Student profile (course priority/interest level)

Result stored in `metadata.json` alongside extraction artifacts.

## Tier Classification

Determined after extraction, based on document type + source. Configurable via `type-mappings.ts`.

| Tier | Document Types | Processing | Review |
|------|---------------|------------|--------|
| 1 | Assignments, contracts, admin docs, exercises | Metadata + store original | Auto-approve → vault |
| 2 | Lectures, exam prep, course materials, labs | Full AI notes | Auto-approve → "Recently Processed" feed |
| 3 | Research articles, books, unknown/unclassified | Full AI notes | Three-panel review with agent chat |

Default for unknown types: **Tier 2**.

User can override tier:
- Per-folder via `type-mappings.ts` custom mappings
- Per-document via upload form
- Per-course via student profile

## Stage 2: AI Processing

**Executor**: Container agent (existing `container-runner.ts`)
**Concurrency**: Shared pool with GroupQueue (ingestion containers register properly)
**Input**: Extraction artifacts (clean markdown + figures + metadata)
**Output**: Draft markdown file with structured frontmatter

### Container Isolation

Each ingestion container gets its own IPC namespace keyed by `jobId`:
```
data/ipc/ingestion/{jobId}/input/
```

This eliminates cross-container signal interference. The `singleTurn: true` flag ensures the container exits after producing its result.

### Concurrency Coordination

Ingestion containers register with GroupQueue via the `onProcess` callback (no longer a no-op). Total concurrent containers (chat + ingestion) are bounded by `MAX_CONCURRENT_CONTAINERS`.

The ingestion pipeline checks available capacity before spawning:
```typescript
const available = MAX_CONCURRENT_CONTAINERS - groupQueue.activeCount();
const ingestionSlots = Math.min(available, MAX_INGESTION_CONCURRENT);
```

### Prompt Design

The container receives clean markdown (not raw files) and is instructed to:

1. **Structure with clear H2/H3 headings** — these become chunk boundaries for RAG
2. **Prepend contextual prefix per section** — e.g. "From DIFT1002, Lecture 3 — Network Protocols:"
3. **Extract key concepts** into frontmatter `concepts: []` field
4. **Note relationships** to other courses/topics if apparent
5. **Write descriptive figure captions** — searchable text linked to extracted images
6. **Use the extraction metadata** — don't re-infer what Docling already detected

### Timeout

Pipeline-level `AbortController` with 20-minute deadline, independent of container hard timeout (30 min). If the pipeline timeout fires first, the job is marked `failed` at the `generating` stage and the container is stopped. Extraction artifacts are preserved for retry.

## Vault Output Format

### Note Structure

```markdown
---
title: "Network Protocols and OSI Model"
source: "[[attachments/DIFT1002/03_Nettverk.pdf]]"
course: DIFT1002
semester: 1
year: 1
type: lecture
language: "no"
concepts: ["OSI model", "TCP/IP", "network layers", "routing"]
priority: medium
status: approved
reviewed: 2026-03-29
_extractionId: "abc-123"
---

## Introduction
> Context: DIFT1002, Lecture 3 — Network Protocols

Content with clear heading hierarchy for chunk boundaries...

## Key Concepts

### OSI Model
Seven-layer network architecture model...

## Figures

![[figures/osi-model-diagram.png]]
**Figure 1:** The seven layers of the OSI model showing data encapsulation at each layer, from physical (Layer 1) through application (Layer 7).

## Source Document

![[attachments/DIFT1002/03_Nettverk.pdf]]
```

### Design Rationale (RAG-optimized)

- **H2/H3 headings**: Natural chunk boundaries that outperform fixed-size and semantic chunking (Vectara/NAACL 2025)
- **Contextual prefix per section**: Follows Anthropic's contextual retrieval pattern (49-67% fewer retrieval failures)
- **`concepts` array**: Enables metadata-filtered retrieval ("sorting algorithms in DIFT1002") via self-query pattern
- **`priority` field**: Inherited from student profile; weights RAG retrieval results
- **Descriptive figure captions**: Searchable text linked to images; supports multimodal queries
- **Source document appended**: Ground truth always accessible alongside summary
- **`_extractionId`**: Links back to extraction artifacts for debugging/reprocessing

### Priority Field

Course priority is stored in the student profile (`src/profile/`), not per-document:

```json
{
  "coursePriorities": {
    "DCST2002": "high",
    "DIFT1003": "low",
    "DCST1002": "high"
  }
}
```

Values: `high` | `medium` (default) | `low` | `archive`

- **high**: Interesting for revision and cross-referencing
- **medium**: Default for all courses
- **low**: Less interesting but still searchable
- **archive**: Stored but excluded from active retrieval

Documents inherit priority from their course. Individual documents can override via frontmatter. The pipeline reads the profile during metadata enrichment.

## Review UI

### Recently Processed Feed (Tier 1/2)

A lightweight feed in the dashboard showing auto-approved items. Not a blocking review queue — a notification stream:

- Table with: filename, course, type, priority, tier, timestamp
- Inline-editable metadata fields (course code, type, priority)
- "Confirm Batch" button to acknowledge a set of items
- Items that aren't confirmed within 7 days are assumed fine (no action needed)
- Click any item to expand and see the generated note content

### Three-Panel Review (Tier 3)

Existing layout, used only for research articles and complex documents:

- **Left**: Source document preview (PDF iframe, with DOCX/PPTX converted to PDF)
- **Center**: Draft note with editable metadata
- **Right**: Agent chat for discussing the draft

### Unified Approval Codepath

All mutations go through a single backend endpoint on the NanoClaw process:

```
Dashboard → POST to NanoClaw web channel → single handler that:
  1. ReviewQueue.approveDraft() — atomic file write (.tmp + rename)
  2. updateReviewItemStatus(id, 'approved') — DB update
  3. Signal container shutdown (if review agent is running)
  4. Schedule extraction artifact cleanup
```

The dashboard never reads or writes vault files directly. All vault mutations go through the backend. The dashboard communicates with the NanoClaw backend via the existing web channel HTTP API (port 3200). New endpoints are added to the web channel:

- `POST /approve/:id` — approve a draft (replaces dashboard's direct file I/O)
- `POST /reject/:id` — reject a draft
- `PATCH /metadata/:id` — update draft metadata
- `GET /drafts` — list drafts with status (replaces dashboard reading vault/drafts/ directly)
- `GET /recent` — recently processed items for Tier 1/2 feed

For rejections, the same codepath:
```
  1. Delete draft file
  2. updateReviewItemStatus(id, 'rejected')
  3. Signal container shutdown
  4. Preserve extraction artifacts (allows re-processing with different prompt)
```

## Error Recovery

| Failure | Recovery |
|---------|----------|
| Crash during extraction | Startup scan resets `extracting` → `pending`; watcher re-fires |
| Crash during AI processing | Startup scan resets `generating` → `extracted`; only reruns Stage 2 |
| Extraction timeout (10 min) | Job marked `failed`, original stays in upload dir |
| AI timeout (20 min pipeline / 30 min container) | Job marked `failed` at `generating`, extraction preserved |
| Anthropic API outage | Containers time out after 20 min (pipeline level), slots freed, queue drains from DB on recovery |
| Partial file write | Atomic writes: `.tmp` + `rename()` for all vault operations |
| Container killed mid-write | Draft validation checks for valid frontmatter with `_targetPath`, not just file existence |
| Approval partial failure | DB update + file write in try/catch; rollback on failure |
| Process restart | DB scan for stale states; no in-memory state to lose |

## Database Changes

### Schema Updates

```sql
-- Add tier and extraction_path columns to ingestion_jobs
ALTER TABLE ingestion_jobs ADD COLUMN tier INTEGER DEFAULT 2;
ALTER TABLE ingestion_jobs ADD COLUMN extraction_path TEXT;

-- Add indexes for queue queries
CREATE INDEX idx_ingestion_jobs_status ON ingestion_jobs(status);
CREATE INDEX idx_review_items_status ON review_items(status);
CREATE INDEX idx_review_items_job_id ON review_items(job_id);
```

### Enforcement

```sql
PRAGMA foreign_keys = ON;
```

Set after database open in `src/db.ts`. Add `ON DELETE CASCADE` to `review_items.job_id` foreign key.

### New States

The `status` column in `ingestion_jobs` gains new values: `extracting`, `extracted`, `generated`, `reviewing`. These replace the current `pending` → `generating` → `completed` flow.

## Concurrency Model

```
Global pool: MAX_CONCURRENT_CONTAINERS (default 5)
  ├── Chat containers (managed by GroupQueue)
  └── Ingestion containers (registered with GroupQueue)

Extraction pool: MAX_EXTRACTION_CONCURRENT (default 3)
  └── Docling Python subprocesses (independent of container pool)
```

Extraction runs in parallel with containers since it's CPU-only (no API calls). Container slots are shared and bounded.

## File Lifecycle

```
upload/{path}/{file.pdf}
  → [extraction] data/extractions/{jobId}/content.md + figures/
  → [AI processing] vault/drafts/{draftId}.md (Tier 2/3)
  → [approval] vault/courses/{course}/{type}/{title}.md
  → [cleanup] upload/{path}/{file.pdf} → upload/.processed/{jobId}-{file.pdf}
  → [cleanup] data/extractions/{jobId}/ deleted after completion
  → [Tier 1] vault/courses/{course}/{type}/{title}.md (direct, no draft stage)
```

Original files are preserved in `vault/attachments/{course}/` at extraction time. The upload original moves to `.processed/` only after the job reaches `completed`.

## What This Replaces

| Current | New |
|---------|-----|
| In-memory `queue: string[]` | DB-backed drain loop querying `ingestion_jobs` |
| Single `processFile()` with 6 steps | Two-stage pipeline with checkpoints |
| `DoclingClient` (dead code) | Docling called directly in extraction stage |
| Container reads raw files | Container reads clean extraction artifacts |
| Shared IPC directory for all ingestion containers | Per-job IPC namespace (`data/ipc/ingestion/{jobId}/`) |
| No-op `onProcess` callback | Containers registered with GroupQueue |
| Dashboard directly manipulates vault files | All vault mutations through backend API |
| `updateReviewItemStatus()` never called | Called on every approve/reject |
| Single review queue for all documents | Tiered: auto-approve (Tier 1/2) + review queue (Tier 3) |
| Existence-only draft validation | Frontmatter validation with required fields |
| 30-min container timeout only | 20-min pipeline timeout + 30-min container hard limit |

## Out of Scope

- RAG chunking strategy (separate concern, operates on vault contents)
- Vault search/browse UI improvements
- Multi-user support
- Webhook/callback for external integrations
- Document versioning (edit history)
