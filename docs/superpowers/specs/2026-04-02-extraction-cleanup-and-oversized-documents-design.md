# Extraction Cleanup and Oversized Document Handling

**Date:** 2026-04-02
**Status:** Approved

## Problem

Docling extracts large PDFs into noisy markdown that inflates token counts beyond what the agent can process in a single session. A 206-page academic paper produced 559KB of extracted content (~140K tokens), of which ~42% was structural noise (single-word table cell blocks, references, supplementary material). The agent hit rate limits and timed out.

This affects all documents to varying degrees — even shorter papers benefit from trimmed extractions that save tokens.

## Design

### Overview

1. A cleanup pass runs on every Docling extraction, trimming structural noise
2. A token budget gate checks the cleaned content before spawning the agent
3. Oversized documents are parked and the user is notified via Telegram
4. Failed/oversized jobs can be dismissed from the dashboard

### 1. Extraction Cleanup — `cleanExtraction()`

New file: `src/ingestion/extraction-cleaner.ts`

A pure function `cleanExtraction(markdown: string): string` that takes Docling markdown and returns a cleaned version. Stateless and deterministic.

**Cleanup rules, applied in order:**

1. **Collapse noise blocks** — consecutive `<!-- page:N label:text -->` blocks on the same page where the text content (excluding the marker itself) is under 50 chars get merged into a single block. The merged block keeps one page marker and joins the text fragments with spaces. This handles Docling's table-cell-as-text-block explosion.

2. **Strip references tail** — find a `## References` (or `## Bibliography`, `## Works Cited`) section header that appears at or after 60% through the document. Strip everything from that header onward. The position threshold prevents false positives on papers with an early "References" subsection.

3. **Strip supplementary tail** — same pattern for `## Appendix`, `## Supplementary`, `## Supporting Information` at or after 70% through the document.

4. **Deduplicate adjacent identical blocks** — if the same text content appears in consecutive blocks on the same page, keep only the first.

**What it does NOT do:**

- Does not touch tables (valuable structured content)
- Does not remove section headers (used for citation references)
- Does not modify content within blocks — only removes or merges whole blocks
- Does not guess about content semantics — operates solely on Docling's structural markers

### 2. Integration with Extraction

`Extractor.extract()` calls `cleanExtraction()` after Docling finishes. The cleaned output is written to `content.clean.md` alongside the original `content.md` (preserved for debugging).

`AgentProcessor.process()` currently receives the extraction directory path and reads `content.md` from it. This changes to read `content.clean.md` first, falling back to `content.md` if the clean file doesn't exist (backward compatibility with pre-existing extractions). No interface changes needed — just the filename it looks for.

### 3. Token Budget Gate

Located in `handleGeneration()` in `src/ingestion/index.ts`, before building the vault manifest or spawning the agent.

**Token estimation:** `Math.ceil(contentChars / 4)` — simple char-count heuristic, no tokenizer dependency.

**Budget:** 80,000 tokens for document content alone. This leaves headroom for the CLAUDE.md system prompt, vault manifest, job parameters, and multi-turn agent conversation within the 200K context window.

**When over budget:**

- Set job status to `oversized`
- Store token estimate in the job's error field for visibility
- Send a Telegram notification to the user's main chat with the document name and token count
- Do not retry automatically — the user decides what to do

**When under budget:** Proceed to agent generation as normal.

### 4. Pipeline Status Flow

```
pending → extracting → extracted → generating → generated → promoting → completed
                                  ↘ oversized (parked, user notified)
```

`oversized` is a new terminal-ish status. The `PipelineDrainer` ignores it (does not auto-retry). The user can retry or dismiss via the dashboard.

### 5. Dashboard Job Management

For jobs in `failed`, `oversized`, or `rate_limited` status, the dashboard provides two actions:

- **Retry** — resets job to `extracted` so the pipeline picks it up again
- **Dismiss** — sets job to `dismissed` status, moves the source file to `upload/dismissed/{jobId}-{filename}`, cleans up extraction artifacts

`dismissed` is a terminal status like `completed`. The drainer ignores it.

`upload/dismissed/` is a new directory. The file watcher ignores it (same as `upload/processed/`).

### 6. Database Changes

- Add `oversized` and `dismissed` as recognized job statuses
- No new columns needed — token estimate stored in existing `error` field

### 7. Notification

Uses existing Telegram channel infrastructure. The ingestion pipeline sends a message to the user's main registered chat when a job is parked as `oversized`.

Message format: `"Document '{filename}' is too large for single-pass processing (~{tokens}K tokens after cleanup). Retry or dismiss it from the dashboard."`

## Testing

### `extraction-cleaner.test.ts`

Each cleanup rule tested individually:

- Noise block collapsing: same-page short blocks merge; different-page blocks don't; blocks over 50 chars are preserved
- References stripping: various heading formats (`## References`, `## Bibliography`, `## Works Cited`); position threshold (early occurrence preserved, late occurrence stripped)
- Supplementary stripping: `## Appendix`, `## Supplementary`, `## Supporting Information`; position threshold
- Adjacent duplicate removal
- Passthrough: clean documents come through unchanged
- Composition: all rules applied together on realistic sample

### Extractor integration

- Verify `extract()` writes `content.clean.md` alongside `content.md`
- Verify `cleanContentPath` is set in `ExtractionResult`

### Budget gate

- Verify oversized jobs are parked with `oversized` status
- Verify under-budget jobs proceed normally
- Verify notification is triggered for oversized jobs

### Existing tests

Promoter, sentinel, validation, and pipeline tests should need no changes — the flow is unchanged for normal-sized documents.

## Future Work

- **Section-based chunking** for textbook-length documents: split at major headings, process each chunk as a separate agent session, merge manifests. Deferred until textbook uploads become a real use case.
- **Inline dashboard actions** on the Telegram notification (reply "skip" / "retry") — deferred, notification-only for now.
