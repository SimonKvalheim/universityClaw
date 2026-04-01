# Cross-Source Reference Detection

**Date:** 2026-04-01
**Status:** Draft
**Scope:** Ingestion pipeline enrichment — citation graph + concept manifest

## Problem

The ingestion pipeline treats each source as an isolated unit. When Source A cites Source B (which is already in the vault), no relationship is recorded. When a new concept overlaps with an existing vault concept, the agent has no awareness of it and cannot create cross-source wikilinks. Connections between sources are only discoverable at query time via RAG retrieval.

## Goals

1. **Citation graph** — Automatically detect when a newly ingested source's bibliography references other sources already in the vault. Record `cites` / `cited_by` relationships in both frontmatter and SQLite.
2. **Cross-source concept linking** — Give the ingestion agent awareness of existing vault notes so it can create wikilinks to concepts from other sources when writing new notes.
3. **Non-blocking** — Neither feature may prevent the pipeline from completing. Failures degrade gracefully to current behavior (no cross-references).

## Non-Goals

- Deduplicating concept notes across sources. Multiple perspectives on the same concept are valuable.
- RAG-assisted concept bridging. Query-time retrieval already covers this; ingestion-time RAG queries are too expensive and scale poorly.
- Modifying existing concept notes during ingestion. The agent is read-only with respect to previously promoted notes.
- Proactive cleanup of stale references on source deletion. Handled by lazy validation at read time.

## Design

### 1. Citation Graph (post-promotion)

**New module:** `src/ingestion/citation-linker.ts`

**Trigger:** Called in `handlePromotion()` after all notes are promoted and before any cleanup calls. In the current code (`src/ingestion/index.ts`), this means inserting the call between the last `promoteNote()` result (line ~410) and the first cleanup call (`cleanupSentinel`, line ~448). The extraction artifacts at `job.extraction_path` are still on disk at this point.

**Inputs:**
- Extracted document content: `content.md` from Docling at `job.extraction_path` — contains the bibliography section with `<!-- page:N label:list_item -->` markers
- List of existing source notes in `vault/sources/` with their `authors` and `published` frontmatter fields
- The promoted source note path (returned by `promoteNote()` for the source note) — needed to write `cites` frontmatter to the correct file

**Algorithm:**

1. **Locate the bibliography section.** Scan backward from the end of `content.md` for a contiguous cluster of lines preceded by `<!-- page:N label:list_item -->` markers where the text matches an academic reference pattern. A "cluster" is defined as 3+ consecutive `list_item` entries (allowing up to 2 non-`list_item` lines between them) where at least 50% of entries contain a 4-digit year in parentheses. This distinguishes bibliographies from in-body bullet lists.

2. **Parse bibliography entries.** For each entry in the cluster, extract `(last_name, year)` pairs using regex patterns targeting APA-style formats that Docling produces:
   - `LastName, Initials. (YYYY)` — e.g., `Sweller, J. (1999)`
   - `LastName, Initials., LastName, Initials., & LastName, Initials. (YYYY)` — multi-author
   - Extract the first author's last name (text before the first comma) and the 4-digit year in parentheses.
   - **Scope:** Targets APA-style bibliographies only. Non-APA formats (Vancouver, numbered) are not matched and will be skipped gracefully. This covers the majority of academic papers in the vault.

3. **Build lookup index for existing sources.** For each source note in `vault/sources/`, read its `authors` and `published` frontmatter. Extract last names from the `authors` array (each entry is a full name like `"Paul A. Kirschner"` — the last name is the final whitespace-delimited token, e.g., `Kirschner`). Build a map: `Map<string, SourceInfo[]>` keyed by `normalized_last_name + year`.

4. **Name normalization:** Lowercase, strip diacritics (NFD + remove combining marks), collapse whitespace. E.g., `Müller` → `muller`, `Van Merriënboer` → `van merrienboer`.

5. **Match:** For each parsed bibliography entry, look up `normalized_first_author_last_name + year` in the source map. A match requires the normalized last name AND year to match at least one existing source.

6. **Write edges.** For each match:
   - **SQLite:** Insert a row into the `citation_edges` table (see section 5 below)
   - **Frontmatter (new source note):** Read the promoted source note file, parse its existing `cites` array (or default to `[]`), append the matched source's filename stem, write back using `updateFrontmatter()`. The citation linker handles its own file I/O — `updateFrontmatter()` operates on strings, not files.
   - **Frontmatter (matched source note):** Same read-append-write pattern for `cited_by`. Must read existing array first to avoid overwriting — `updateFrontmatter()` uses shallow spread (`{ ...data, ...updates }`), so passing `{ cited_by: ['new'] }` would replace, not append.

**Frontmatter additions to source notes:**
```yaml
cites:
  - cognitive-load-theory-implications-for-instructional-design-kirschner-2002
cited_by:
  - some-later-paper-that-references-this-one
```

**Edge cases:**
- No bibliography section found (e.g., lecture slides, news articles) → skip gracefully, log info
- Bibliography parsing extracts no valid entries → skip gracefully
- Multiple sources by the same author in the same year → match all of them (may produce false positives, but these are low-cost and easily correctable during verification)
- Non-English or non-APA bibliographies → not matched, skipped silently
- Concurrent promotions writing `cited_by` to the same file → not a practical concern with current `maxGenerationConcurrent: 1` default. If concurrency increases, this becomes a known limitation (last-write-wins). The SQLite edges remain authoritative.

**Re-ingestion:** When a source is re-processed, delete all existing edges for that source from `citation_edges` before running the linker. This rebuilds the graph cleanly. Frontmatter `cites`/`cited_by` arrays are rebuilt from the new edges. Stale `cited_by` entries in other sources from the old version are cleaned up by lazy validation (see section 6).

**Error handling:** If citation linking throws at any point, log a warning and continue. Promotion is already complete; this is additive enrichment.

### 2. Concept Manifest (pre-generation)

**New module:** `src/ingestion/vault-manifest.ts`

**Exports:** `buildVaultManifest(vaultDir: string): string`

**Trigger:** Called in `handleGeneration()` before `agentProcessor.process()`.

**Algorithm:**
1. Scan `vault/concepts/` and `vault/sources/` for `.md` files
2. For each file, read frontmatter only (title, type, topics)
3. Derive slug from filename (strip `.md`)
4. Assemble a compact manifest string:

```xml
<existing_vault_notes>
## Sources
- cognitive-load-theory-implications-for-instructional-design-kirschner-2002 | "Cognitive Load Theory: Implications for Instructional Design (Kirschner 2002)"

## Concepts
- working-memory-architecture | topics: deep-learning, cognitive-architecture
- germane-cognitive-load | topics: cognitive-load, instructional-design
</existing_vault_notes>
```

Each line contains the **filename stem** (what the agent uses for wikilinks) and the **title** (for human recognition). Concept lines also include **topics** to help the agent judge relevance. The agent creates wikilinks using the filename stem, e.g., `[[germane-cognitive-load]]`.

**Token budget:** ~5 tokens per note. At current vault size (44 notes) this is ~220 tokens. At 500 notes, ~2,500 tokens — negligible relative to document content. No cap needed yet.

**Changes to `AgentProcessor`:**
- `buildPrompt()` accepts an optional `vaultManifest?: string` parameter as the 5th argument
- If provided, it is inserted after the document content / figures section and before "## Job Parameters"
- `process()` accepts an optional `vaultManifest?: string` parameter and forwards it to `buildPrompt()`

**Error handling:** If manifest building fails (e.g., corrupt frontmatter in a vault file), log a warning and call `process()` without a manifest. The agent works identically to today.

### 3. Agent Instructions Update

**File:** `groups/review_agent/CLAUDE.md`

**New section after "Cross-References":**

```markdown
## Existing Vault Notes

You may receive a list of existing vault notes in `<existing_vault_notes>`.
When a concept you are writing about relates to an existing note listed there,
create a `[[wikilink]]` to its filename stem in your prose — but only when the
relationship is genuine. Do not force connections.

You should still create your own concept notes even if similar ones exist in
the vault. Different sources provide different perspectives, and both are
valuable.

Do not modify existing notes. The manifest is informational only.
```

**Modification to self-review step 5:**
Current: "do `[[wikilinks]]` point to notes you actually created? Fix broken links."
Updated: "do `[[wikilinks]]` point to notes you created or to existing notes listed in `<existing_vault_notes>`? Fix any links that point to neither."

**Remove vault scanning instruction:** Line 8 currently says "check existing notes to avoid duplicates, reference existing concepts." This instruction is replaced by the manifest — the agent should use the manifest as its source of truth for existing notes, not scan the vault directory. Update line 8 to remove the "check existing notes" language; the "Existing Vault Notes" section covers this.

### 4. Integration Points

**Pipeline flow:**
```
enqueue → extracting → extracted → generating → generated → promoting → completed
                                      ↑                          ↑
                                 build vault              run citation
                                 manifest before          linker after
                                 agent runs               promotion
```

Both additions are non-blocking enrichments. The pipeline never fails due to either feature.

**`handleGeneration()` changes:**
1. Before calling `agentProcessor.process()`, call `buildVaultManifest(this.vaultDir)`
2. Pass the manifest string into `process(extractionPath, fileName, job.id, this.reviewAgentGroup, vaultManifest)`
3. On manifest failure: warn and proceed without it

**`handlePromotion()` changes:**
1. Track the promoted source note path from the `promoteNote()` return value
2. After promoting all notes and before cleanup calls, call the citation linker with: extraction content path (`job.extraction_path`), promoted source note path, and `vault/sources/` directory
3. On citation linker failure: warn and continue

### 5. Citation Edges Table

**New SQLite table** in `src/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS citation_edges (
  source_slug TEXT NOT NULL,      -- filename stem of the citing source
  target_slug TEXT NOT NULL,      -- filename stem of the cited source
  created_at  TEXT NOT NULL,      -- ISO 8601 timestamp
  PRIMARY KEY (source_slug, target_slug)
);
CREATE INDEX idx_citation_target ON citation_edges(target_slug);
```

**DB helper functions:**
- `insertCitationEdge(sourceSlug, targetSlug)` — insert or ignore
- `deleteCitationEdges(sourceSlug)` — delete all edges where this source is the citer (for re-ingestion rebuild)
- `getCitedBy(targetSlug): string[]` — all sources that cite this target
- `getCites(sourceSlug): string[]` — all sources this source cites

Frontmatter `cites`/`cited_by` fields are written alongside the database for Obsidian compatibility but the database is the authoritative store. The graph view and any future consumers should read from the database.

### 6. Lazy Validation

**New utility:** `src/ingestion/citation-linker.ts` exports `filterDeadReferences(slugs: string[], vaultSourcesDir: string): string[]`

Takes an array of source slugs and returns only those that correspond to existing files in `vault/sources/`. Consumers (graph view, agent, any read path) call this when reading `cites`/`cited_by` data to silently filter out stale references.

This is a safety net for edge cases: manual vault edits, interrupted re-ingestions, sources deleted outside the pipeline. It does not throw — it only filters.

## Testing

### Unit Tests

**`vault-manifest.test.ts`:**
- Empty vault → returns empty or minimal manifest
- Vault with mixed note types → correct grouping under Sources / Concepts
- Notes with missing frontmatter fields → skipped gracefully, others still included
- Slug derivation from filenames (including hash-suffixed filenames from promoter collision handling)
- Notes in flat directory structure only (subdirectories ignored)

**`citation-linker.test.ts`:**
- Bibliography detection: cluster of `list_item` entries with years → detected
- Bibliography detection: scattered `list_item` entries in body text → not detected as bibliography
- Bibliography parsing with Docling-formatted APA entries (single author, multi-author)
- Author name normalization (diacritics, casing, multi-token last names)
- Author+year matching against source note frontmatter (full name → last name extraction)
- No bibliography section → graceful skip, no errors
- Multiple matches (same author, different years) → correct discrimination
- Same author+year matching multiple vault sources → all matched
- Bidirectional frontmatter updates (cites + cited_by): read-append-write, not overwrite
- Existing `cites` / `cited_by` arrays → appended to, not replaced
- SQLite edge insertion and deletion (re-ingestion rebuild)
- `filterDeadReferences()` — filters out non-existent slugs, passes through valid ones

### Integration

- Existing pipeline tests pass unchanged (both features are additive)
- No new external dependencies

## Known Limitations

- **APA-only bibliography parsing.** Non-APA citation formats (Vancouver, numbered, Chicago) are not detected. This covers the majority of academic papers but may miss some sources.
- **Concurrent promotion.** If `maxGenerationConcurrent` is increased above 1, two promotions writing `cited_by` to the same source file could race (last-write-wins). The SQLite edges remain correct; only frontmatter may lose a write. Not a practical concern at current defaults.
- **No proactive stale reference cleanup.** When a source is deleted from the vault outside the pipeline, `cited_by` entries in other sources become stale. Lazy validation filters these at read time but does not actively clean frontmatter.

## Future Considerations

- If the vault grows beyond ~1,000 notes, the manifest could be filtered by topic relevance to the incoming document (using topics from the extracted content). Not needed now.
- The citation graph in SQLite is the foundation for a graph visualization in the web dashboard. Implementation TBD in a separate spec.
- RAG-assisted concept bridging (Approach 3 from brainstorming) remains available as an upgrade path if the lightweight manifest proves insufficient.
