# Vault Organization Redesign

**Date:** 2026-03-30
**Status:** Approved
**Approach:** Atomic Pipeline with Staged Verification (Approach C)

## Context

The previous vault structure organized content by course and semester (`courses/{code}/{type}/`). This fragments related concepts across silos and doesn't optimize for RAG retrieval. The new design reorganizes the vault thematically with atomic concept notes, rich provenance tracking, and a lazy verification system for accuracy.

The vault will serve as a personal research library — lecture materials, scientific papers, textbook chapters, news articles — queried for deep conceptual questions, practical application, cross-source synthesis, and study review.

### Research Basis

Key findings that informed this design:

- **Atomic notes (~200-500 words) outperform long documents for retrieval.** Clinical RAG benchmark (2025) found ~250 tokens optimal at 87% accuracy / 93% relevance. Source: [PMC: Comparative Evaluation of Advanced Chunking for RAG](https://pmc.ncbi.nlm.nih.gov/articles/PMC12649634/)
- **Thematic organization > source-based.** LightRAG deduplicates entities across sources, but thematic grouping benefits both human navigation and naive retrieval. Source: [Neo4j: Under the Covers with LightRAG](https://neo4j.com/blog/developer/under-the-covers-with-lightrag-extraction/)
- **Rich YAML frontmatter is essential.** Metadata filtering narrows search space before vector similarity, improving speed and accuracy. Source: [Deepset: Leveraging Metadata in RAG](https://www.deepset.ai/blog/leveraging-metadata-in-rag-customization)
- **Cite-then-generate reduces hallucination.** Systems where citations are produced inline during generation are more faithful than post-hoc attribution. Source: [Tensorlake: Citation-Aware RAG](https://www.tensorlake.ai/blog/rag-citations)
- **Graph-based RAG improves precision up to 35%** over vector-only retrieval. Source: [AWS: Improving RAG Accuracy with GraphRAG](https://aws.amazon.com/blogs/machine-learning/improving-retrieval-augmented-generation-accuracy-with-graphrag/)
- **MOCs create false relevance** when indexed — they match many queries but provide shallow content. Source: [Substack: RAG in Practice for Connected Notes](https://nsavage.substack.com/p/retrieval-augmented-generation-in)
- **Folder depth is irrelevant to RAG** — retrieval is semantic, not path-based. Shallow structures preferred for maintainability. Source: [AWS RAG Best Practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/writing-best-practices-rag/best-practices.html)

---

## 1. Vault Structure

```
vault/
├── concepts/              # Atomic concept notes (~200-500 words each)
├── sources/               # One overview note per uploaded document
├── _nav/                  # MOCs, index notes (human navigation only, excluded from RAG)
├── attachments/           # Figures, images, extracted assets (excluded from RAG)
├── drafts/                # Staging area for unreviewed notes (excluded from RAG)
├── profile/
│   ├── student-profile.md     # Compact preferences + program info (always loaded)
│   ├── knowledge-map.md       # Topic -> confidence scores, compact (always loaded)
│   ├── study-log.md           # Rolling 30-day window (always loaded)
│   └── archive/               # Rotated logs + historical snapshots (RAG-indexed, not context-loaded)
└── .obsidian/             # Obsidian config (gitignored)
```

### Rules

- `concepts/` and `sources/` are flat — no subfolders
- Filenames are descriptive kebab-case: `self-attention-mechanism.md`, not UUIDs
- On filename collision (e.g., two papers both produce a note about "gradient descent"), append a short hash suffix: `gradient-descent-a3f1.md`. The suffix is derived from the source document's job ID.
- Drafts use UUIDs during processing, then get renamed when promoted to `concepts/` or `sources/`
- RAG indexer watches `concepts/`, `sources/`, and `profile/archive/` — ignores `_nav/`, `attachments/`, `drafts/`
- Profile rotation: a weekly scheduled job summarizes `study-log.md` entries older than 30 days into `profile/archive/study-log-YYYY-MM.md`, then trims the main file

---

## 2. Note Schemas

### Concept Note (atomic)

```yaml
---
title: Self-Attention Mechanism
type: concept
topics: [deep-learning, attention, transformers]
source_doc: "Vaswani et al. 2017 - Attention Is All You Need"
source_file: "upload/processed/papers/vaswani-2017-attention.pdf"
source_pages: [4, 5]
source_sections: ["SS3.2.1 Scaled Dot-Product Attention"]
generated_by: claude
verification_status: unverified  # unverified | agent-verified | human-verified
verified_at: null
created: 2026-03-30
---

Self-attention computes a weighted sum of value vectors, where weights are
determined by compatibility between query and key vectors. [^1]

Given input sequence X, three linear projections produce queries Q = XW_Q,
keys K = XW_K, and values V = XW_V. The attention output is:

Attention(Q, K, V) = softmax(QK^T / sqrt(d_k))V [^2]

The scaling factor sqrt(d_k) prevents dot products from growing too large in
high dimensions, which would push softmax into regions with vanishing
gradients. [^2]

## Related Concepts

Self-attention is the core building block of [[multi-head-attention]],
which runs multiple attention heads in parallel. The lack of inherent
sequence ordering requires [[positional-encoding]] to be added to inputs.

[^1]: Vaswani et al. 2017, SS3.2.1, p.4 P1-2
[^2]: Vaswani et al. 2017, SS3.2.1, p.4 P3
```

### Source Overview Note

```yaml
---
title: "Attention Is All You Need (Vaswani et al. 2017)"
type: source
source_type: paper  # paper | lecture | textbook-chapter | article | news
source_file: "upload/processed/papers/vaswani-2017-attention.pdf"
authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"]
published: 2017
concepts_generated:
  - self-attention-mechanism      # slugified titles, matching eventual filenames
  - multi-head-attention
  - positional-encoding
  - transformer-training-objectives
  - attention-computational-complexity
generated_by: claude
verification_status: unverified
created: 2026-03-30
---

## Summary

Proposes the Transformer architecture, replacing recurrence entirely with
[[self-attention-mechanism]] and [[positional-encoding]]. Demonstrates that
[[multi-head-attention]] achieves state-of-the-art on English-German and
English-French translation while being more parallelizable and requiring
significantly less training time. [^1]

## Key Contributions

- Introduced scaled dot-product [[self-attention-mechanism]] as the sole
  sequence modeling primitive [^2]
- Showed [[multi-head-attention]] captures different representational
  subspaces at different positions [^3]
- Achieved 28.4 BLEU on WMT 2014 EN-DE, surpassing all prior models [^4]

## Limitations & Context

The [[attention-computational-complexity]] is O(n^2) in sequence length,
making it expensive for very long sequences -- a limitation that spawned
subsequent work on efficient attention variants.

[^1]: Abstract, p.1
[^2]: SS3.2.1, p.4
[^3]: SS3.2.2, p.5
[^4]: SS6.1, Table 2, p.8
```

### Schema Design Decisions

- Every factual claim has a footnote citation pointing to source location (page, section, paragraph)
- `concepts_generated` in source notes links to spawned atomic notes for traceability
- `source_file` preserves path to original upload for QA verification. **Retention:** processed files must be retained as long as unverified notes reference them. Do not clean up `upload/processed/` without first checking for unverified notes that depend on those files.
- `verification_status` on both note types for lazy verification
- Related concepts mentioned in prose with `[[wikilinks]]` for LightRAG entity extraction
- `source_type` on overview notes distinguishes papers from lectures from news for query filtering

---

## 3. Ingestion Pipeline

### Flow

```
Upload file -> Docling extraction -> Agent decomposition -> Draft staging -> Auto-promotion -> Cleanup
```

### Step 1: File Detection

File watcher detects new file in `upload/`. Supports PDFs, DOCX, slides, and articles.

### Step 2: Docling Extraction

Extracts text with structure preservation — headings, sections, page numbers, paragraph boundaries. Figures extracted to `attachments/`.

**Implementation note:** The current Docling script (`scripts/docling-extract.py`) uses `doc.export_to_markdown()` which produces plain markdown without location markers. This must be enhanced to use Docling's `iterate_items()` API to emit structured location markers (e.g., `<!-- page:4 section:3.2.1 para:2 -->`) so the agent can produce precise citations. The `iterate_items()` API is already used for figure extraction and provides access to page numbers and document structure.

### Step 3: Agent Decomposition

A container agent receives the structured extraction and produces:

1. **One source overview note** — summary of the document's argument, key contributions, limitations
2. **N atomic concept notes** — one per distinct concept, ~200-500 words each

Both generated using **cite-then-generate prompting**:

```
For each claim you write, you MUST:
1. First identify the specific passage in the source that supports it
   (quote the relevant text internally)
2. Note the exact location (section, page, paragraph)
3. Only then write the claim with its citation

Do NOT write a claim first and then search for a citation to attach.
Do NOT make any factual statement without a supporting source passage.
If you cannot ground a claim in a specific passage, flag it as inference:
  "The scaling factor likely prevents gradient issues [inference, not stated in source]"
```

#### Multi-Note Output Contract

The current pipeline supports only one draft per job. This must be redesigned for 1:N output:

1. **Agent writes a manifest file** alongside notes: `drafts/{jobId}-manifest.json` containing:
   ```json
   {
     "source_note": "{jobId}-source.md",
     "concept_notes": ["{jobId}-concept-001.md", "{jobId}-concept-002.md", ...]
   }
   ```
2. **Draft filenames** use the pattern `{jobId}-source.md` and `{jobId}-concept-NNN.md` (UUID-prefixed for uniqueness, descriptive suffix for debugging).
3. **The pipeline reads the manifest** to discover all output files, validates each has proper frontmatter, and promotes them individually.
4. **The `ingestion_jobs` table** tracks overall job status. Individual notes are tracked via the manifest — the `review_items` table is removed (see Tier System Removal below).
5. **The `_targetPath` field is removed.** Promotion destination is determined by the `type` field in each note's frontmatter: `type: source` goes to `sources/`, `type: concept` goes to `concepts/`. The descriptive kebab-case filename is derived from the `title` field during promotion.

All notes land in `drafts/` and are promoted immediately with `verification_status: unverified`.

#### Agent Session Management

The current pipeline uses `singleTurn: true`, which sends one prompt and kills the container. This is replaced with a **multi-turn session** that allows the agent to self-review before completing:

1. **Generation phase** — Agent generates all notes (source overview + atomic concepts) and writes the manifest.
2. **Self-review phase** — Agent re-reads each generated note and checks:
   - Does every factual claim have a citation?
   - Are there concepts from the source document that were missed?
   - Are notes the right granularity (~200-500 words)? Split or merge as needed.
   - Do `[[wikilinks]]` reference actual other generated notes?
   - Is the source overview's `concepts_generated` list complete?
3. **Revision** — Agent fixes any issues found, adds missing concept notes, and updates the manifest.
4. **Completion signal** — Agent writes a sentinel file (`drafts/{jobId}-complete`) to signal it's done.

**Pipeline behavior:**
- The vault is bind-mounted writable into the container (`/workspace/extra/vault/`), so the sentinel file appears on the host at `vault/drafts/{jobId}-complete`.
- The pipeline polls for the sentinel file on the host filesystem. Once detected, it writes the IPC `_close` sentinel to the container's IPC namespace (`data/ipc/ingestion/{jobId}/input/_close`) to terminate the agent session, then proceeds with promotion.
- **Idle timeout** (configurable, default 10 minutes): if the sentinel doesn't appear within the timeout, the pipeline writes the IPC `_close` sentinel to kill the container. It then checks for the manifest file. If the manifest exists, it promotes whatever notes are listed. If no manifest exists (agent timed out before writing one), the pipeline globs `drafts/{jobId}-*.md`, infers note types from frontmatter, and promotes what it finds. If no notes exist at all, the job is marked as `failed`.
- The `singleTurn` flag is set to `false` for ingestion containers. The agent runner's existing multi-turn loop handles the session lifecycle.
- **Job status during agent session:** The `generating` status covers the entire agent session lifecycle — from container launch through self-review to sentinel detection. No additional status is needed; the pipeline awaits either the sentinel or the timeout before transitioning to `completed` or `failed`.

**Prompt addition for self-review:**
```
After generating all notes, review your own work:
1. Re-read each note you wrote
2. Check: does every claim have a grounded citation? Flag any that don't.
3. Check: are there important concepts from the source that you missed? Add them.
4. Check: are any notes too long (>500 words) or too short (<100 words)? Split or merge.
5. Check: do [[wikilinks]] point to notes you actually created? Fix broken links.
6. Update the manifest if you added or removed notes.
7. Write an empty file to drafts/{jobId}-complete to signal you are finished.
```

#### Tier System Removal

The current three-tier system (tier 1: no AI, tier 2: AI + auto-approve, tier 3: AI + manual review) is replaced entirely:

- **All uploaded documents get AI decomposition.** There is no "skip generation" tier.
- **The `classifyTier()` function, `tier` column, `review_items` table, and `ReviewQueue` class are removed.**
- **The approval endpoints (`/api/ingestion/:id/approve`, `/api/ingestion/:id/reject`) are removed.** Verification replaces manual approval.
- The dashboard's review queue UI is repurposed to show verification status and flagged notes instead.

### Step 4: Auto-Promotion

Notes are promoted immediately without manual review:

- Pipeline reads the manifest to discover all generated notes
- Each note's `type` frontmatter field determines destination: `concepts/` or `sources/`
- Filename is derived from the `title` field, converted to kebab-case (e.g., "Self-Attention Mechanism" -> `self-attention-mechanism.md`)
- On filename collision, a short hash suffix is appended (see Section 1 Rules)
- Notes move from `drafts/` to their destination
- RAG indexer picks them up and indexes them
- Verification happens lazily on retrieval (see Section 4)

### Step 5: Cleanup

- Docling extraction artifacts (temp markdown, intermediate files) are deleted
- Original upload file moves to `upload/processed/{jobId}-{original-filename}` (flat, no subdirectory preservation — keeps processed/ simple and scannable). The `source_file` frontmatter in generated notes references this path.
- Empty upload subdirectories are pruned
- The manifest and UUID-prefixed drafts are deleted after successful promotion

**Path convention note:** The current codebase uses `.processed/` (dot prefix). This spec standardizes on `processed/` (no dot). The file watcher's ignore pattern must be updated from `/[\\/]\.processed[\\/]/` to `/[\\/]processed[\\/]/` to match.

### Changes from Current Pipeline

- **Removed:** Manual review/approve step, tier classification system (`classifyTier()`, `tier` column), `review_items` table, `ReviewQueue` class, approval API endpoints, `_targetPath` field, `PathContext`/`parseUploadPath` system (no longer needed — uploads are not organized by course structure)
- **Added:** Cite-then-generate prompting, source location markers from Docling, atomic decomposition (multiple notes per document), source overview notes, multi-note manifest contract, filename collision handling
- **Changed:** Frontmatter schema (new fields: `source_pages`, `source_sections`, `verification_status`, etc.), flat vault structure instead of `courses/{code}/{type}/`, processed path convention (`.processed/` -> `processed/`), 1:N job-to-note relationship

---

## 4. Lazy Verification System

### Trigger

A concept or source note gets flagged for verification the first time it's retrieved as part of a query response. Verification runs asynchronously — the user gets their answer immediately.

### QA Agent Batch Processing

All unverified notes from a single query are batched into one QA agent call:

- Query retrieves 8 notes, 5 are unverified -> one QA agent call verifies all 5
- Cap at 10 notes per batch. Overflow queues for the next batch — processed when the next query returns unverified notes (no background polling).
- The QA agent can spot cross-note inconsistencies within a batch (e.g., two concept notes from the same paper contradicting each other)

### Verification Process

For each unverified note, the QA agent:

1. Reads the original source document (via `source_file` path)
2. For each footnote citation, locates the referenced passage (page, section, paragraph)
3. Checks whether the cited passage actually supports the claim
4. Produces a verdict per claim:
   - **supported** — citation matches
   - **partially supported** — claim is broadly correct but overstates or simplifies
   - **unsupported** — citation doesn't support the claim, or passage doesn't exist
   - **inference** — claim was already flagged as inference by the generation agent

### Outcomes

- All claims supported -> `verification_status: agent-verified`, `verified_at` timestamp set
- Any claim unsupported -> note stays `unverified`, warning added to frontmatter (`verification_issues: [...]`), note flagged in dashboard for human review
- Manual verification via dashboard -> `human-verified`

### Retrieval Weighting

RAG results are soft-boosted by verification status: `human-verified` > `agent-verified` > `unverified`. This is a ranking preference, not a hard filter — a highly relevant unverified note still gets returned, with a trust indicator in the response.

**Implementation:** This is a post-retrieval re-ranking step, not a LightRAG-native feature. After LightRAG returns results, the application layer reads each note's `verification_status` from frontmatter and applies a score multiplier before presenting results. The `RagClient` query method must be updated to return source paths alongside results so frontmatter can be read for re-ranking.

### Rate Limiting

- QA jobs queue and run one at a time (shares LLM resources with main agent)
- Max 10 notes per verification batch
- Already-verified notes skip the queue entirely

---

## 5. RAG Indexer Updates

### Metadata Prefix Format

Prepended to each document before LightRAG indexes it:

```
[Title: Self-Attention Mechanism | Type: concept | Topics: deep-learning, attention, transformers | Source: Vaswani et al. 2017 | Verification: unverified]
Source path: concepts/self-attention-mechanism.md
```

### Frontmatter Fields Indexed

| Field | Old Schema | New Schema |
|-------|-----------|------------|
| `title` | yes | yes |
| `course` | yes | removed from prefix (kept in frontmatter for provenance) |
| `type` | yes | yes (`concept`, `source`, `profile`) |
| `semester` | yes | removed from prefix |
| `topics` | -- | new: array of topic tags |
| `source_doc` | -- | new: human-readable source attribution |
| `verification_status` | -- | new: trust level |

### Watch Paths

**The indexer must switch from a blocklist to an allowlist.** The current implementation watches the entire vault and excludes `drafts/`, `attachments/`, and dotfiles. The new implementation should only watch explicitly listed paths:

| Path | Indexed | Reason |
|------|---------|--------|
| `concepts/` | yes | Core knowledge |
| `sources/` | yes | Document overviews with narrative context |
| `profile/archive/` | yes | Historical study logs, knowledge snapshots |
| `profile/student-profile.md` | no | Loaded into agent context directly |
| `profile/knowledge-map.md` | no | Loaded into agent context directly |
| `profile/study-log.md` | no | Loaded into agent context directly |
| `_nav/` | no | Human navigation only |
| `attachments/` | no | Binary assets |
| `drafts/` | no | Staging area |

### Query Filter Support

Queries can filter by:

- `type: concept` or `type: source`
- `topics: [specific-topic]`
- `verification_status: agent-verified` (for high-trust-only queries)

**Implementation note:** These filters are implemented via prompt-engineering — prepended as `[Context: ...]` to the LightRAG query string, same as the current approach. LightRAG does not natively support metadata filtering. If filtering precision becomes insufficient, a post-retrieval filter can be added as a fallback.

### Security: RAG Client Python Injection

The current `RagClient` interpolates content directly into Python code strings via template literals. With richer academic content (code blocks, special characters, unicode), this is a command injection risk. The `index()` and `query()` methods must be refactored to pass content via stdin or temporary files instead of string interpolation. This is a prerequisite for safely indexing the new note format.

---

## 6. Profile Management

### Context-Loaded Files

**`student-profile.md`** — Static. Program, preferences, active interests. Updated rarely, stays small. No rotation needed.

**`knowledge-map.md`** — Compact topic-confidence map with YAML frontmatter for programmatic access:

```markdown
---
title: Knowledge Map
type: profile
updated: 2026-03-30
---

## Topics
- data-structures: 0.7 (last assessed: 2026-03-28)
- transformer-architecture: 0.4 (last assessed: 2026-03-30)
- tcp-ip: 0.6 (last assessed: 2026-03-25)
```

Updated after quizzes and Q&A. Only stores current scores — one line per topic. No rotation needed. The format is `- {topic-slug}: {score} (last assessed: {date})` — parseable with a simple regex for programmatic updates.

**`study-log.md`** — Rolling 30-day window:

```markdown
## 2026-03-30
- Queried: self-attention mechanism, positional encoding
- Uploaded: Vaswani et al. 2017 (5 concept notes generated)

## 2026-03-29
- Quiz: data-structures (score: 7/10, weak on red-black trees)
```

Entries are terse — one line per interaction.

### Rotation Job

Weekly scheduled task:

1. Reads `study-log.md`
2. Entries older than 30 days are summarized into `profile/archive/study-log-YYYY-MM.md`
3. Old entries removed from main file
4. Archive files are RAG-indexed (queryable via "what did I study in January?")

When `knowledge-map.md` scores change, old scores are appended to `profile/archive/knowledge-history.md` with timestamps for progression tracking via RAG.

### Size Guardrails

- `study-log.md`: hard cap at 200 lines. If rotation hasn't run and the file exceeds this, oldest entries are force-archived.
- `knowledge-map.md`: no cap needed — one line per topic scales to hundreds in a few KB.
- `student-profile.md`: no cap needed — manually maintained.

---

## 7. Cleanup & Migration

### Delete

- `vault/courses/` — entire directory and all contents
- `vault/drafts/*.md` — all UUID draft files (keep `.gitkeep`)
- `upload/1. Semester/` — entire directory

### Create

- `vault/concepts/.gitkeep`
- `vault/sources/.gitkeep`
- `vault/_nav/.gitkeep`
- `vault/profile/archive/.gitkeep`
- `upload/processed/`

### Update

- Ingestion pipeline: new agent prompt (cite-then-generate, atomic decomposition, new frontmatter schema), multi-note manifest contract, 1:N job-to-note support
- RAG indexer: switch from blocklist to allowlist, new metadata prefix format, new filter fields
- RAG client: refactor Python string interpolation to stdin/tempfile to fix injection vulnerability
- File watcher: auto-promotion instead of review gate, move processed files to `upload/processed/`, update ignore pattern from `.processed/` to `processed/`
- Docling extraction script: enhance to emit location markers using `iterate_items()` API
- Profile files: update to match new formats (add frontmatter to knowledge-map.md)
- Profile rotation: implement weekly scheduled job for study-log rotation and knowledge-history archiving

### Remove

- Tier classification system: `classifyTier()`, `tier` column in `ingestion_jobs`
- Review queue: `review_items` table, `ReviewQueue` class, approval API endpoints
- Path parser: `PathContext` interface, `parseUploadPath()` function, `path-parser.ts`
- Old `_targetPath` logic in agent prompt and validation
- Obsolete `ingestion_jobs` columns: `course_code`, `course_name`, `semester`, `year`, `type` (all derived from the removed path parser). The `createIngestionJob()` function in `src/db.ts` simplifies to only require `fileName`, `filePath`, and `status`.
- Tests referencing removed concepts: `pipeline.test.ts`, `review-queue.test.ts`, `db-ingestion.test.ts`, `approval.test.ts` all need updating to reflect the new pipeline (no tiers, no review items, manifest-based promotion)

### LightRAG Reindex

Full reindex required. Delete existing LightRAG working directory data and rebuild from scratch as new notes enter the vault.
