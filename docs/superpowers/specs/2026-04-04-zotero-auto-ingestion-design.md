# Zotero Auto-Ingestion Pipeline

**Date:** 2026-04-04
**Status:** Approved
**Scope:** Add Zotero as an automatic ingestion source alongside manual upload

## Problem

The current ingestion pipeline requires manually dropping PDFs into the `upload/` folder. Since Simon already manages his academic library in Zotero, this creates unnecessary friction — every paper must be saved in Zotero *and* manually copied to `upload/` for processing.

## Solution

A `ZoteroWatcher` that polls the Zotero local API for new items, resolves their local PDF paths, and feeds them into the existing ingestion pipeline. After promotion, the source summary is written back to Zotero as a child note. Manual upload continues to work unchanged.

## Research Context

Research into existing Zotero integrations (zotero-mcp, Zotero AI Butler, PapersGPT, zotero-markdb-connect) informed several design decisions:

- **Dual-API pattern**: Local API (port 23119) is read-only; write-back requires the Zotero Web API with an API key. This is a fundamental constraint of Zotero's architecture, confirmed by multiple projects.
- **`since={version}` polling**: The standard approach used by all Zotero sync clients. Near-zero cost per poll when nothing has changed.
- **`vault:ingested` tag pattern**: Colored tags marking processed items is the established convention (used by zotero-markdb-connect and others).
- **No existing project** combines local API polling + Docling extraction + LLM generation + knowledge graph indexing. This pipeline is novel in scope.

## Architecture

```
                ┌─────────────────┐
                │  Zotero (local) │
                │  port 23119     │
                └────────┬────────┘
                         │ poll every 60s (since={version})
                         ▼
              ┌──────────────────────┐
              │   ZoteroWatcher      │
              │  - version tracking  │
              │  - exclude-collection│
              │  - PDF path resolve  │
              │  - metadata extract  │
              └──────────┬───────────┘
                         │                  ┌──────────────────┐
                         │                  │  FileWatcher     │
                         │                  │  (upload/ folder)│
                         │                  └────────┬─────────┘
                         │                           │
                         ▼                           ▼
                    ┌────────────────────────────────────┐
                    │         enqueue() — shared         │
                    │  (content hash dedup, DB insert)   │
                    └───────────────┬────────────────────┘
                                    │
                                    ▼
                    ┌────────────────────────────────┐
                    │   Existing Pipeline (unchanged) │
                    │   extract → generate → promote  │
                    └───────────────┬────────────────┘
                                    │
                         ┌──────────┴──────────┐
                         ▼                      ▼
                  ┌──────────────┐    ┌─────────────────┐
                  │ Vault notes  │    │ Zotero write-back│
                  │ (sources/,   │    │ (web API)        │
                  │  concepts/)  │    │ - child note     │
                  │      │       │    │ - vault:ingested │
                  │      ▼       │    │   tag            │
                  │ RAG indexer  │    └─────────────────┘
                  └──────────────┘
```

Both sources coexist. The core pipeline (`pipeline.ts`, `extractor.ts`, `promoter.ts`) is unchanged.

## Components

### 1. ZoteroWatcher (`src/ingestion/zotero-watcher.ts`)

Polls the Zotero local API for new items and enqueues them for processing.

**Polling mechanism:**
- 60-second interval (configurable via `ZOTERO_POLL_INTERVAL`)
- `GET /api/users/0/items?since={version}&itemType=-attachment+-note` for new/changed top-level items
- Stores `Last-Modified-Version` in `zotero_sync` SQLite table (persists across restarts)
- Graceful degradation: if Zotero isn't running, logs a warning and retries next cycle

**Exclude-collection filter:**
- Configured via `ZOTERO_EXCLUDE_COLLECTION` (collection name, e.g. "Do Not Process")
- On startup, resolves the collection name to its key via the collections endpoint
- Items belonging to the excluded collection are skipped
- Optional — if unset, all items with PDFs are ingested

**PDF resolution:**
- For each new item, fetch children to find PDF attachments
- If multiple PDFs, pick the largest (most likely the full text, not a supplement)
- Resolve local file path via `GET /api/users/0/items/{attachmentKey}/file/view/url` which returns a `file:///` URL pointing to the PDF on disk
- Items without a PDF attachment are skipped (logged as "no PDF available")

**Metadata extraction:**
- Pulls from the Zotero item: title, creators, date, DOI, URL, publication, tags, abstract
- Packaged as a `ZoteroMetadata` object that travels with the job

**Dedup:**
- Primary: check `zotero_key` column in `ingestion_jobs` — skip if already completed
- Secondary: content hash (same as existing pipeline) — catches identical PDFs from different sources

### 2. Zotero API Client (`src/ingestion/zotero-client.ts`)

Thin client wrapping both Zotero APIs.

**Local API (read):**
- `getItems(since?)` — fetch items modified since version
- `getCollections()` — list all collections
- `getChildren(itemKey)` — get child items (attachments, notes)
- `getFileUrl(attachmentKey)` — resolve local PDF path via `/items/{key}/file/view/url`
- No authentication required, no rate limits

**Web API (write):**
- `createChildNote(parentKey, htmlContent)` — attach summary note to item (single POST)
- `addTag(itemKey, tag)` — add `vault:ingested` tag to parent item. This is a read-modify-write cycle: fetch current item, append tag to `tags` array, PATCH back. Separate API call from note creation, with independent version conflict potential.
- Requires `ZOTERO_API_KEY` and `ZOTERO_USER_ID`
- Includes `If-Unmodified-Since-Version` header (Zotero-specific custom header, not standard HTTP) for conflict safety
- On 412 (version conflict): re-fetch version, retry once
- Rate limit handling: respect `Backoff` and `Retry-After` headers

### 3. Zotero Write-Back (`src/ingestion/zotero-writeback.ts`)

Post-promotion hook for Zotero-sourced jobs.

**What gets written:**
- A child note on the Zotero item containing the source summary (markdown to HTML)
- A `vault:ingested` tag on the parent item

**Note format:**
```html
<h2>Source Summary</h2>
<p>Generated by universityClaw on {date}</p>
<hr/>
{source note body as HTML}
<hr/>
<p><em>Vault notes: <a href="...">source</a>, {N} concepts</em></p>
```

**Failure handling:**
- Write-back is best-effort — if it fails, the vault notes are already promoted
- Logs warning on failure, does not fail the job
- If `ZOTERO_API_KEY` is missing, write-back is disabled entirely (logged once at startup)

### 4. Metadata-Enhanced Generation

When a job has `source_type: 'zotero'`, the agent processor injects a metadata preamble into the prompt:

```
## Source Document Metadata (from Zotero)
- Title: Venture capital financing and the growth of startup firms
- Authors: Davila, A.; Foster, G.; Gupta, M.
- Date: 2003-11-01
- Publication: Journal of Business Venturing
- DOI: 10.1016/S0883-9026(02)00127-1
- Tags: Entrepreneurship, Venture capital, Private equity
- Abstract: This paper examines the relationship between...
```

**Effects on note generation:**
- Frontmatter gets pre-populated with accurate citation data (no OCR guessing)
- `source_doc` in frontmatter uses Zotero URI: `zotero://select/items/YXSUPARC`
- `zotero_key: YXSUPARC` added to frontmatter for back-linking
- Zotero tags become topic hints for concept extraction
- Agent still generates freely — metadata is context, not a rigid template

Upload-sourced jobs are unaffected (no metadata preamble).

## Database Changes

**New columns on `ingestion_jobs`:**

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `source_type` | TEXT | `'upload'` | `'upload'` or `'zotero'` |
| `zotero_key` | TEXT | NULL | Zotero 8-char item key |
| `zotero_metadata` | TEXT | NULL | JSON blob (title, creators, date, DOI, etc.) |

**New table `zotero_sync`:**

| Column | Type | Purpose |
|--------|------|---------|
| `key` | TEXT (PK) | Setting name |
| `value` | TEXT | Setting value |

Single row: `key='library_version'`, `value='{version_number}'`

Migrations follow the existing try/catch `ALTER TABLE` pattern in `db.ts`.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ZOTERO_ENABLED` | `false` | Enable Zotero watcher |
| `ZOTERO_API_KEY` | — | Web API key (for write-back only) |
| `ZOTERO_USER_ID` | — | Zotero user ID |
| `ZOTERO_POLL_INTERVAL` | `60000` | Poll frequency in ms |
| `ZOTERO_EXCLUDE_COLLECTION` | — | Collection name to skip (optional) |
| `ZOTERO_LOCAL_URL` | `http://localhost:23119` | Local API base URL |

**Startup behavior:**
- `ZOTERO_ENABLED=true` → `ZoteroWatcher` starts alongside `FileWatcher`
- Zotero not running → logs warning, retries silently each interval
- `ZOTERO_API_KEY` missing → write-back disabled, polling and ingestion still work
- `ZOTERO_EXCLUDE_COLLECTION` unset → all items with PDFs are ingested

## File Structure

```
src/ingestion/
├── zotero-watcher.ts      # NEW — polls local API, filters, resolves PDFs
├── zotero-client.ts       # NEW — local + web API client
├── zotero-writeback.ts    # NEW — post-promotion summary note + tag
├── types.ts               # NEW — ZoteroMetadata interface, shared types
├── index.ts               # MODIFIED — start ZoteroWatcher alongside FileWatcher
├── agent-processor.ts     # MODIFIED — inject Zotero metadata into prompt
├── file-watcher.ts        # UNCHANGED
├── pipeline.ts            # UNCHANGED
├── extractor.ts           # UNCHANGED
└── promoter.ts            # UNCHANGED

src/
├── db.ts                  # MODIFIED — new columns + zotero_sync table
├── config.ts              # MODIFIED — new ZOTERO_* env vars
```

Three new files, three modified. Core pipeline untouched.

## Identifiers

Zotero's native 8-character item keys (e.g. `YXSUPARC`) are used as the stable identifier linking vault notes to Zotero items. Better BibTeX citekeys are not required. If BBT is installed later, citekey support can be added as a minor enhancement.

## Integration Notes

**Promotion must not move Zotero PDFs.** The existing `handlePromotion` renames the source file to `upload/processed/`. For Zotero-sourced jobs (`source_type === 'zotero'`), the file move MUST be skipped — moving a file out of Zotero's managed `storage/` directory would corrupt Zotero's database.

**`createIngestionJob` signature expansion.** The current function accepts `(id, sourcePath, sourceFilename, contentHash?)`. For Zotero jobs, it needs to also accept `source_type`, `zotero_key`, and `zotero_metadata`. Extend the existing function with optional parameters rather than creating a separate function.

**`JobRow` interface expansion.** The `JobRow` interface in `pipeline.ts` must include `source_type`, `zotero_key`, and `zotero_metadata` so that downstream consumers (promotion handler, agent processor, write-back) can make source-aware decisions.

**`AgentProcessor.buildPrompt` signature.** Currently receives `(extractedContent, fileName, jobId, figures, vaultManifest)` with no job metadata. Needs an additional parameter (or the full `JobRow`) to access Zotero metadata for prompt injection.

**First-run behavior.** On first connection (no stored library version), the watcher fetches the current `Last-Modified-Version` and stores it WITHOUT processing existing items. This avoids a burst of 60+ ingestion jobs. Only items added/changed after first connection are processed. A manual "backfill" can be triggered later if desired.

**Dashboard follow-up.** The dashboard likely displays ingestion jobs. Surfacing `source_type` and Zotero-specific fields in the UI is a follow-up, not part of this spec.

## Edge Cases

- **Item has no PDF attachment**: Skipped, logged as "no PDF available"
- **Multiple PDF attachments**: Largest file selected (most likely full text vs. supplement)
- **Item updated in Zotero after ingestion**: Version bump triggers re-poll, but dedup by `zotero_key` prevents re-processing. Metadata-only changes are ignored.
- **Zotero quits mid-session**: Watcher logs warning, resumes automatically when Zotero reopens
- **PDF is already in upload/ pipeline**: Content hash dedup prevents double-processing regardless of source
- **Web API rate limit**: Respect `Backoff` and `Retry-After` headers, exponential backoff
- **Version conflict on write-back (412)**: Re-fetch current version, retry once
- **Item moved to exclude collection after ingestion**: No effect — already processed, tag remains
- **Deleted items in `since` response**: The Zotero API returns both modified and deleted item keys in `since` responses. Deleted items are ignored (no action needed).
- **Attachment replaced without parent edit**: May not bump parent item version. Accepted limitation — re-adding the item to Zotero or manually uploading the PDF are workarounds.
