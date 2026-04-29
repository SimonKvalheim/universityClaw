# Library + Dual-Graph Design

**Status:** Approved (sections 1–6), ready for implementation plan
**Date:** 2026-04-29

## Problem

Two related gaps in the current ingestion pipeline:

1. **Oversized documents are parked, not ingested.** When a PDF exceeds the agent's token budget, the pipeline currently transitions to `oversized` and fires a Telegram "retry/dismiss" notification. The user has to act for the doc to enter the vault at all. Result: large books and papers don't reach the vault even though Docling extraction succeeded.
2. **Only agent-written summaries are indexed in LightRAG.** Raw extracted source text never enters the RAG store. The graph contains only the agent's curated `vault/sources/*.md` and `vault/concepts/*.md`, so retrieval can't reach passages, figures, or sections that the agent didn't deem worth summarizing. Citations point at summaries instead of primary text.

## Design overview

Introduce `vault/library/` for raw cleaned Docling extractions and make the system's two graphs explicit:

- **Graph A — Vault graph.** Curated wikilinks and frontmatter relationships authored by the user and the ingestion agent. Visible in Obsidian graph view. Used by the agent for navigating "logical flow" between sources, concepts, and now library entries.
- **Graph B — LightRAG entity graph.** Latent entities and relationships extracted by LightRAG over indexed content. Used for hybrid semantic + graph retrieval. Receives library entries (raw text) in addition to source/concept notes.

Both graphs gain a new node type (`library`), and edges between source and library entries make the relationship explicit in both graphs.

The over-budget path no longer skips the vault — it skips the agent. Every successfully extracted document produces a library file regardless of size; under-budget documents additionally get an agent-authored source summary.

## Section 1 — Architecture

### Vault layout

New directory `vault/library/` alongside existing `vault/concepts/`, `vault/sources/`, `vault/profile/`. Flat structure, one markdown file per ingested source. Filename matches source slug: `vault/library/{slug}.md` ↔ `vault/sources/{slug}.md`.

### Library file format

```markdown
---
title: "<original document title>"
type: library
source_summary: "[[<slug>]]"          # wikilink to the curated source note (if one exists)
source_type: paper | book | article | …
ingested_from: "upload/processed/{jobId}-{filename}.pdf"
job_id: "<uuid>"
indexed: false                         # flipped to true after RAG round-trip
---

<cleaned Docling markdown — full body>
```

- `type: library` distinguishes from `source` and `concept` for downstream filtering.
- `source_summary` may be missing when the doc was over-budget and no source note was generated; that's expected and the agent-prompt copy below covers it.
- `indexed` is set by the indexer after a successful round-trip, mirroring how source notes track verification.

### Dual-graph wiring

| Edge | Graph A (vault) | Graph B (LightRAG) |
|---|---|---|
| `source → library` | `library: "[[library/{slug}]]"` in source frontmatter + `Full text: [[library/{slug}]]` in source body | Edge keywords `summarizes, full_text` |
| `library → source` | `source_summary: "[[{slug}]]"` in library frontmatter | Edge keywords `summarized_by, summary` |

Library files appear in Obsidian graph view; no exclusion. Visual clutter is acceptable — they form a clearly distinguishable branch off each source node.

## Section 2 — Pipeline changes

### Status transitions

Add two new ingestion job statuses between `extracted` and `generating`:

```
queued → extracting → extracted → librarying → libraried → generating → completed
                                                       ↓
                                                    (over-budget) → completed (stub source note only)
```

`oversized` is removed as a terminal status. Migration: any existing `oversized` rows transition to `libraried` so they auto-retry through the new path. Confirmed during brainstorm — there are <10 such rows and re-running through the new path is the right behavior.

### `librarying` stage

Runs immediately after `extracted`, before the token-budget gate. Inputs: cleaned Docling markdown, job metadata. Outputs:

- `vault/library/{slug}.md` written with the frontmatter shape above.
- Job updated to `libraried`.
- The watcher's `add` event fires; `RagIndexer.indexFile` indexes the library file in the next tick (no explicit invocation here — chokidar handles it).

### Under-budget path (post-`libraried`)

The agent runs as today. The agent's source-note prompt gains a new instruction:

> When the source note refers to the originating document at length, include both:
>
> - Frontmatter field: `library: "[[library/{slug}]]"`
> - Body line near the top: `**Full text:** [[library/{slug}]]`
>
> The library file holds the raw extracted text and is the canonical place to read passages verbatim. Your source note remains the curated overarching logical flow.

The "overarching logical flow" framing is deliberate — the user emphasized that source summaries stay the agent-authored synthesis layer; the library is the raw substrate, not a replacement.

### Over-budget path

The agent is skipped. A deterministic stub source note is written from job metadata only:

```markdown
---
title: "<title from extraction or filename>"
type: source
source_type: <inferred>
source_file: "<ingested_from>"
library: "[[library/{slug}]]"
verification_status: unverified
auto_generated: true                   # marks this as stub, no agent synthesis
created: <date>
---

# <title>

This document was ingested but exceeded the agent's token budget for full synthesis.
The complete extracted text is available at [[library/{slug}]].

**Full text:** [[library/{slug}]]
```

- Same wikilinks as the under-budget path, so dual-graph edges work uniformly.
- No concepts are generated for over-budget docs — that's the trade-off for skipping the agent. They can be retroactively summarized later by re-queueing through the agent path explicitly.

### User notification

The "oversized — retry/dismiss" Telegram notification is removed. Replaced with a quieter dashboard badge surfacing recently-libraried docs that don't have a source summary, so the user can choose to re-queue any they want fully synthesized. Dashboard implementation is out of scope for this spec — flagged for the post-v1 follow-up. The badge is a known gap until then; over-budget docs land in the vault silently in v1.

## Section 3 — RAG indexer changes

### Allowed paths

`ALLOWED_PATHS` (in `src/rag/indexer.ts`) gains `library`. Currently: `['concepts', 'sources']`. New: `['concepts', 'sources', 'library']`.

### Indexed prefix shape for library

Library files use a distinct prefix so retrieval can filter by type:

```
[Title: <title> | Type: library | Source summary: <source-slug>]
Source path: library/{slug}.md

<cleaned body>
```

When `source_summary` is missing (over-budget docs without a curated source note), `Source summary:` is omitted entirely from the prefix rather than emitted as empty.

### In-memory `slug → title` map

Replace per-wikilink disk reads with a single in-memory map:

- Built once on `RagIndexer.start()` by walking `vault/concepts/`, `vault/sources/`, `vault/library/` and reading each file's frontmatter title.
- Maintained on `add`, `change`, `unlink` chokidar events: insert/update on add/change, delete on unlink.
- `injectWikilinks` resolves bare wikilink targets via the map; falls back to `slugToTitle(target)` with a warning log on miss.
- Eliminates the indexing race (target file written but not yet readable) and N disk reads per indexed note.

### Frontmatter wikilink scan — restricted fields

Currently `extractWikilinks(content)` scans the entire raw file content, which includes arbitrary frontmatter values. Tighten this:

- Body wikilinks: still scanned in full.
- Frontmatter wikilinks: only walked from a known allowlist of fields: `source_summary`, `library`, `links_to`, `related`. Other frontmatter values (titles, descriptions, tags, etc.) are not scanned. This avoids spurious edges from quoted text inside frontmatter strings.

### Bidirectional edges with distinct semantics

| Direction | Source → Target | Keywords |
|---|---|---|
| Source note's `library:` field | source → library | `summarizes, full_text` |
| Library file's `source_summary:` field | library → source | `summarized_by, summary` |
| Any other body wikilink | as today | `references, wikilink` |

Distinct keyword strings let LightRAG hybrid retrieval distinguish "give me the summary of X" from "give me the full text of X" via keyword match.

### Library file timeouts

LightRAG round-trips for library files take longer (full book text). Bump from defaults:

- `POST` timeout: 60s (from default 30s)
- `pollTimeoutMs`: 1.2M ms / 20 min (from default 5min)

Apply only to library files. Detect by `relPath.startsWith('library/')` in the indexer before invoking `ragClient.index`.

### Logging

On every library index, log body length (chars) and total LightRAG round-trip elapsed ms. This gives us data to tune timeouts after some real usage.

### Missing-title fallback

When the in-memory map has no entry for a wikilink target, fall back to `slugToTitle(slug)` (existing helper) and emit a warning log. Applies uniformly across all file types — not library-specific.

## Section 4 — Search-agent guidance and `vault_section` MCP tool

### New MCP server: `vault-mcp-stdio`

Sibling to the existing rag MCP. Located at `container/agent-runner/src/vault-mcp-stdio.ts`. Tools namespaced `mcp__vault__*` to make the dual-graph distinction syntactically obvious in agent prompts and traces:

- `mcp__vault__*` — Graph A primitives (vault file I/O, structured navigation)
- `mcp__rag__*` — Graph B primitives (LightRAG hybrid retrieval)

Mounted from `container/agent-runner/src/index.ts:432` alongside the rag MCP.

### `vault_section(path, locator)` tool

Single tool exposed by the new MCP server. Takes a vault-relative path and one of three locator forms:

| Locator | Behavior |
|---|---|
| `section: "<heading text>"` | Returns the H1/H2/H3 section matching `<heading text>` (case-insensitive substring match against rendered heading). |
| `page: <number>` | Returns the page based on Docling page markers in the cleaned text. |
| `range: { start: <line>, end: <line> }` | Returns the line range. Capped at 500 lines; over-cap returns truncated content + a `truncated: true` note. |

Every successful response includes a header line:

```
File: <path> / Section: <heading or page or range> / Page <N> / Lines <A>-<B>

<content>
```

On miss (heading not found, page out of range, etc.) the tool returns the available section list with a "not found" message — never an empty result. This avoids the agent silently retrieving nothing.

### Group-prompt updates: "Reading library files"

New section added to:

- `groups/main/CLAUDE.md`
- `groups/study/CLAUDE.md`
- `groups/study-generator/CLAUDE.md`

Content (paraphrased — final wording during implementation):

> Library files (`vault/library/*.md`) hold raw cleaned source text. They're long. To read them effectively:
>
> 1. Start with the source note (`vault/sources/{slug}.md`) for the agent-authored synthesis and the document's logical flow.
> 2. Use `mcp__vault__vault_section` with a section heading or page number to pull just the part you need.
> 3. For full-document analysis (summarization, broad searches), dispatch a `Task` subagent with the library path — don't read the whole file inline.
> 4. When citing, include section + page from the `vault_section` header line.

## Section 5 — Backfill of existing sources

### One-shot script: `scripts/backfill-library.ts`

Walks `vault/sources/*.md`. For each source note:

1. Locate the original file:
   - Primary: parse `source_file` field from frontmatter (e.g. `upload/processed/{uuid}-{filename}.pdf`), check it exists.
   - Fallback: if `source_file` is missing or stale, look up the source by Zotero `citation_key` if present in frontmatter and resolve via the Zotero adapter.
   - On miss: log + skip + record in JSON report.
2. Re-extract via `Extractor.extract()` — same path the live pipeline uses. Outputs a fresh cleaned markdown.
3. Write `vault/library/{slug}.md` with the frontmatter shape from Section 1.
4. Patch the source note frontmatter to add `library: "[[library/{slug}]]"`. Body left untouched (back-patching body wikilinks risks duplicating an existing reference; a body link can be added during the agent's next interaction with the note).
5. Force re-index the patched source note. Because adding `library:` to frontmatter doesn't change the indexed prefix (which uses only `title|type|topics|source_doc|verification_status`), the content hash won't change. Workaround: delete the tracker row for the source path in `store/messages.db` before invoking `indexer.indexFile()`. Hash check then misses → reindex → `injectWikilinks` fires → source→library edge created.
6. The library file's own `add` event will trigger normal indexing and produce the library→source edge.

### CLI flags

| Flag | Behavior |
|---|---|
| `--dry-run` | Walks everything, emits the JSON report, but writes nothing and patches nothing. |
| `--source <slug>` | Process a single source by slug. Useful for re-testing a specific case. |
| `--report <path>` | JSON report destination (default: `store/backfill-library-report.json`). |
| `--no-patch-source` | Writes library files but skips the frontmatter patch + tracker delete step. Useful for sanity-checking before committing to the patch. |

### Edge cases

| Case | Behavior |
|---|---|
| Original PDF missing | Skip, record `missing_original` in report |
| Zotero `citation_key` present but Zotero adapter can't resolve | Skip, record `zotero_lookup_failed` |
| Slug collision (two sources with same slug) | Skip second, record `slug_collision` with both source paths |
| Library file already exists | Skip, record `skipped_existing` (idempotent re-runs) |
| Source frontmatter already has `library:` field | Treat as `skipped_existing` (don't repatch, don't re-extract) |

### JSON report shape

```json
{
  "started_at": "<iso>",
  "ended_at": "<iso>",
  "total_sources": 47,
  "processed": 38,
  "skipped": [
    { "slug": "foo-bar", "reason": "missing_original", "details": "…" }
  ],
  "errors": []
}
```

Dashboard "Backfill library" button: deferred to post-v1.

## Section 6 — Testing strategy

### Existing tests to extend

- `extraction-cleaner.test.ts` — already covers Docling output cleanup. Add cases asserting that the cleaned-and-written output (used by the `librarying` stage) matches the body indexed downstream.
- `extractor.test.ts` / `pipeline.test.ts` — add the library-write step:
  - After `extract()`, the pipeline writes `vault/library/{slug}.md` with the correct frontmatter shape.
  - Job status transitions `extracted → librarying → libraried`.
  - `oversized` no longer appears as a transition (assert via state-machine fixture).

### `src/rag/indexer.test.ts`

- `library/` is in `ALLOWED_PATHS`.
- In-memory `slug → title` map:
  - Built on `start()` from existing concepts/sources/library files.
  - Updated on `add` event (new file → new map entry).
  - Updated on `change` event (renamed title → entry value updated).
  - Removed on `unlink` event.
  - Direct test of the map structure — no disk reads after init.
- Bidirectional edge creation:
  - Index a source note with `library: "[[library/foo]]"` → assert `source→library` edge with keywords `summarizes, full_text`.
  - Index a library file with `source_summary: "[[foo]]"` → assert `library→source` edge with keywords `summarized_by, summary`.
- Frontmatter wikilink scan restricted to known fields: confirm a wikilink-shaped string in an arbitrary frontmatter field (e.g. `description: "see [[foo]]"`) does NOT produce an edge.
- Library files use bumped timeouts: assert `ragClient.index` and poll calls receive 60s / 1.2M ms when path starts with `library/`.
- Missing-title fallback: bare wikilink target absent from map → `slugToTitle` used, warning log emitted.

### `container/agent-runner/src/vault-mcp-stdio.test.ts` (new)

- `vault_section(path, section: "Introduction")` returns the section under that heading, header line includes `Section: Introduction`.
- `vault_section(path, page: 4)` returns content between Docling page-4 and page-5 markers.
- `vault_section(path, range: { start: 100, end: 200 })` returns those lines.
- Range over 500 lines: response truncated, includes `truncated: true` and a note.
- Heading miss: returns available sections list, "not found" message.
- Page miss: returns total page count, "page N not found" message.
- Tools registered under `mcp__vault__*` namespace (sanity check).

### `scripts/backfill-library.test.ts` (new)

- `--dry-run`: walks fixtures, writes nothing, JSON report still produced.
- Idempotency: running twice → second run reports all entries as `skipped_existing`, no writes.
- Missing original (fixture has stale `source_file`): logged + skipped, JSON report has `missing_original` entry, exit code 0.
- Slug collision: two source fixtures with same slug → second logged + skipped.
- Frontmatter patch round-trip: source frontmatter gains `library: "[[library/{slug}]]"`, body unchanged byte-for-byte, gray-matter re-parses cleanly after patch.
- Tracker delete: after patch, the source note's row in `rag_tracker` is removed (asserts the force-reindex prerequisite is met).
- `--no-patch-source`: library file written, source frontmatter unchanged, tracker row preserved.

### Integration test (`pipeline.integration.test.ts` extension)

Two fixtures: one under-budget PDF, one over-budget PDF. Single test run end-to-end:

- Both produce `vault/library/{slug}.md` with correct frontmatter.
- Both library files index in LightRAG (mocked client).
- Under-budget produces an agent-written source summary with `library:` frontmatter and `Full text: [[library/{slug}]]` body link.
- Over-budget produces the deterministic stub source note with the same wikilinks.
- `oversized` is never observed in the pipeline state-transition log.
- Both bidirectional edges are created (assert via mocked LightRAG `createRelation` calls).

## Out of scope

- Dashboard "Backfill library" button (deferred to post-v1).
- Body-wikilink patching during backfill (the script only patches frontmatter; agent-style body edits during a future interaction are fine).
- Retroactive concept extraction for over-budget docs (re-queue through agent path explicitly when wanted).
- Library file de-duplication across re-ingests (each ingest overwrites the library file for that slug; no historical library snapshots).
- Visual indicator in dashboard distinguishing library-only sources from agent-summarized sources.
