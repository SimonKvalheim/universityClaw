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

#### Block definition

Docling output is structured as a sequence of **blocks**. Each block consists of a `<!-- page:N label:TYPE -->` comment marker on its own line, followed by one or more lines of text content, terminated by a blank line (or end of file). Blocks are separated by blank lines. Example:

```markdown
<!-- page:3 label:text -->
Some content here

<!-- page:3 label:section_header -->
## Next Section
```

The cleanup rules operate on these blocks as atomic units.

#### Cleanup rules, applied in order:

1. **Deduplicate adjacent identical blocks** — if the same text content appears in consecutive blocks on the same page, keep only the first. Runs first so subsequent rules operate on fewer blocks.

2. **Collapse noise blocks** — consecutive `label:text` blocks on the same page where the text content (excluding the marker line) is under 50 chars get merged into a single block. The merged block keeps one page marker and joins the text fragments with spaces. This handles Docling's table-cell-as-text-block explosion.

3. **Strip references tail** — find a `## References` (or `## Bibliography`, `## Works Cited`) section header that appears at or after 60% through the document. Strip everything from that header onward. The 60% threshold is a conservative starting point — if false negatives are observed with documents where references start earlier, this can be tuned down. The position check prevents false positives on papers with an early "References" subsection within the body.

4. **Strip supplementary tail** — same pattern for `## Appendix`, `## Supplementary`, `## Supporting Information` at or after 70% through the document.

**What it does NOT do:**

- Does not touch tables (valuable structured content)
- Does not remove section headers (used for citation references)
- Does not modify content within blocks — only removes or merges whole blocks
- Does not guess about content semantics — operates solely on Docling's structural markers

### 2. Integration with Extraction

`Extractor.extract()` calls `cleanExtraction()` after Docling finishes. The cleaned output is written to `content.clean.md` alongside the original `content.md` (preserved for debugging).

The `ExtractionResult` interface gains a `cleanContentPath: string` field pointing to the cleaned file.

The extractor logs the cleanup ratio (original size vs cleaned size) after each cleanup run for visibility into how effective the rules are across document types.

**Crash recovery:** `Extractor.hasArtifacts()` currently checks for `content.md` and `metadata.json`. It must also check for `content.clean.md`. If the process crashed after Docling wrote `content.md` but before cleanup ran, `hasArtifacts()` returns false and extraction re-runs (including cleanup). This ensures cleanup is never skipped.

`AgentProcessor.process()` currently receives the extraction directory path and reads `content.md` from it. This changes to read `content.clean.md` first, falling back to `content.md` if the clean file doesn't exist (backward compatibility with pre-existing extractions). No interface changes needed — just the filename it looks for.

### 3. Token Budget Gate

Located at the top of `handleGeneration()` in `src/ingestion/index.ts`, before building the vault manifest or spawning the agent.

**Token estimation:** `Math.ceil(contentChars / 4)` — simple char-count heuristic, no tokenizer dependency. This tends to slightly overestimate for English academic text (real ratio is ~3.5-3.8 chars/token), making the gate conservative. For Norwegian text with compound words the ratio may differ, but erring on the side of caution is the safer direction. This is a known approximation — do not "fix" it with a tighter ratio without understanding the trade-off.

**Budget:** 80,000 tokens for document content alone. This leaves headroom for the CLAUDE.md system prompt, vault manifest, job parameters, and multi-turn agent conversation within the 200K context window.

**When over budget:**

- Set job status to `oversized` and return normally (do NOT throw). This matches the existing rate-limit pattern in `handleGeneration` where the handler returns without throwing to prevent the drainer's `.catch()` from overwriting the status to `failed`.
- Store token estimate in the job's error field for visibility (e.g. `"oversized:~120K tokens after cleanup"`)
- Send a Telegram notification to the user's main chat

**When under budget:** Proceed to agent generation as normal.

### 4. Pipeline Status Flow

```
pending → extracting → extracted → generating → generated → promoting → completed
                                  ↘ oversized (parked, user notified)
```

`oversized` is a new terminal-ish status. The `PipelineDrainer` ignores it (does not auto-retry). The user can retry or dismiss via the dashboard.

**`enqueue()` dedup handling:** The `enqueue()` method in `src/ingestion/index.ts` checks for existing jobs by source path. It must handle the new statuses:
- `dismissed` — treat like `completed` (allow re-enqueue of the same file)
- `oversized` — treat as already queued (skip, do not create a duplicate job)

### 5. Dashboard Job Management

For jobs in `failed`, `oversized`, or `rate_limited` status, the dashboard provides two actions:

- **Retry** — resets job to `extracted` so the pipeline picks it up again
- **Dismiss** — sets job to `dismissed` status, moves the source file to `upload/dismissed/{jobId}-{filename}`, cleans up extraction artifacts

`dismissed` is a terminal status like `completed`. The drainer ignores it.

`upload/dismissed/` is a new directory. The file watcher ignores it (same as `upload/processed/`).

**Dashboard status config:** Add entries for `oversized` and `dismissed` to the `STATUS_CONFIG` map in `JobRow.tsx`:
- `oversized`: label "Oversized", distinct color (e.g. purple), non-active
- `dismissed`: label "Dismissed", muted color, non-active

Update the `isActive` check (currently `!['completed', 'failed'].includes(status)`) to also exclude `oversized` and `dismissed`, so they don't show progress bars.

### 6. Database Changes

- Add `oversized` and `dismissed` as recognized job statuses
- No new columns needed — token estimate stored in existing `error` field

### 7. Notification

The ingestion pipeline sends a Telegram notification when a job is parked as `oversized`. The pipeline uses the router's `sendMessage()` function (from `src/router.ts`) to deliver the message to the user's main registered Telegram chat. The ingestion pipeline constructor receives a `notify` callback that the orchestrator wires to the router — keeping the ingestion module decoupled from channel specifics.

Message format: `"Document '{filename}' is too large for single-pass processing (~{tokens}K tokens after cleanup). Retry or dismiss it from the dashboard."`

## Testing

### `extraction-cleaner.test.ts`

Each cleanup rule tested individually:

- Deduplication: identical adjacent blocks on same page collapsed; different pages preserved; different content preserved
- Noise block collapsing: same-page short blocks merge; different-page blocks don't; blocks over 50 chars preserved
- References stripping: various heading formats (`## References`, `## Bibliography`, `## Works Cited`); position threshold (early occurrence preserved, late occurrence stripped)
- Supplementary stripping: `## Appendix`, `## Supplementary`, `## Supporting Information`; position threshold
- Passthrough: clean documents come through unchanged
- Composition: all rules applied together on realistic sample
- Cleanup ratio logging: verify log output includes original and cleaned sizes

### Extractor integration

- Verify `extract()` writes `content.clean.md` alongside `content.md`
- Verify `cleanContentPath` is set in `ExtractionResult`
- Verify `hasArtifacts()` returns false when `content.clean.md` is missing (triggers re-extraction with cleanup)

### Budget gate

- Verify oversized jobs are parked with `oversized` status and handler returns normally (no throw)
- Verify under-budget jobs proceed normally
- Verify notification callback is invoked for oversized jobs

### Dashboard

- Verify retry action resets job to `extracted`
- Verify dismiss action sets `dismissed`, moves source file to `upload/dismissed/`
- Verify `oversized` and `dismissed` are rendered as non-active terminal states

### Existing tests

Promoter, sentinel, validation, and pipeline tests should need no changes — the flow is unchanged for normal-sized documents.

## Future Work

- **Section-based chunking** for textbook-length documents: split at major headings, process each chunk as a separate agent session, merge manifests. Deferred until textbook uploads become a real use case.
- **Inline dashboard actions** on the Telegram notification (reply "skip" / "retry") — deferred, notification-only for now.
- **Threshold tuning** — the 60%/70% position thresholds for references/supplementary stripping may need adjustment as more document types are processed. Monitor cleanup ratio logs.
