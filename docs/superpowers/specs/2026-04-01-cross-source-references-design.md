# Cross-Source Reference Detection

**Date:** 2026-04-01
**Status:** Draft
**Scope:** Ingestion pipeline enrichment — citation graph + concept manifest

## Problem

The ingestion pipeline treats each source as an isolated unit. When Source A cites Source B (which is already in the vault), no relationship is recorded. When a new concept overlaps with an existing vault concept, the agent has no awareness of it and cannot create cross-source wikilinks. Connections between sources are only discoverable at query time via RAG retrieval.

## Goals

1. **Citation graph** — Automatically detect when a newly ingested source's bibliography references other sources already in the vault. Record `cites` / `cited_by` relationships in source note frontmatter.
2. **Cross-source concept linking** — Give the ingestion agent awareness of existing vault notes so it can create wikilinks to concepts from other sources when writing new notes.
3. **Non-blocking** — Neither feature may prevent the pipeline from completing. Failures degrade gracefully to current behavior (no cross-references).

## Non-Goals

- Deduplicating concept notes across sources. Multiple perspectives on the same concept are valuable.
- RAG-assisted concept bridging. Query-time retrieval already covers this; ingestion-time RAG queries are too expensive and scale poorly.
- Modifying existing concept notes during ingestion. The agent is read-only with respect to previously promoted notes.

## Design

### 1. Citation Graph (post-promotion)

**New module:** `src/ingestion/citation-linker.ts`

**Trigger:** Called in `handlePromotion()` after all notes are promoted, before cleanup. The extraction artifacts (`job.extraction_path`) are still available at this point — `extractor.cleanup()` runs later.

**Inputs:**
- Extracted document content (`content.md` from Docling) — contains the bibliography section with `<!-- page:N label:list_item -->` markers
- List of existing source notes in `vault/sources/` with their `authors` and `published` frontmatter fields

**Algorithm:**
1. Locate the bibliography section in the extracted content. Heuristic: scan from the end of the document for a cluster of `<!-- page:N label:list_item -->` entries that match academic reference patterns (Author, Year).
2. Parse each bibliography entry to extract `(last_name, year)` pairs. Use regex patterns matching common APA-style formats that Docling produces (e.g., `AuthorName, Initials. (YYYY)` or `AuthorName, Initials (YYYY)`).
3. For each existing source note in `vault/sources/`, build a lookup key from its `authors` (last names) and `published` frontmatter fields.
4. Match bibliography entries against existing sources: a match requires at least one author last name AND the year to match.
5. For each match:
   - Add the matched source's filename stem (e.g., `cognitive-load-theory-implications-for-instructional-design-kirschner-2002`) to a `cites` array in the new source note's frontmatter
   - Add the new source's filename stem to a `cited_by` array in the matched source note's frontmatter (using `updateFrontmatter()` from `src/vault/frontmatter.ts`)

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
- Author name matching is fuzzy (OCR artifacts in Docling output) → match on normalized last names, tolerate minor variations
- Multiple sources by the same author in the same year → match all of them (may produce false positives, but these are low-cost and easily correctable during verification)

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

**Token budget:** ~5 tokens per note. At current vault size (44 notes) this is ~220 tokens. At 500 notes, ~2,500 tokens — negligible relative to document content. No cap needed yet.

**Changes to `AgentProcessor`:**
- `buildPrompt()` accepts an optional `vaultManifest?: string` parameter
- If provided, it is inserted after the document content / figures section and before "## Job Parameters"
- `process()` accepts and forwards the manifest to `buildPrompt()`

**Error handling:** If manifest building fails (e.g., corrupt frontmatter in a vault file), log a warning and call `process()` without a manifest. The agent works identically to today.

### 3. Agent Instructions Update

**File:** `groups/review_agent/CLAUDE.md`

**New section after "Cross-References":**

```markdown
## Existing Vault Notes

You may receive a list of existing vault notes in `<existing_vault_notes>`.
When a concept you are writing about relates to an existing note listed there,
create a `[[wikilink]]` to it in your prose — but only when the relationship
is genuine. Do not force connections.

You should still create your own concept notes even if similar ones exist in
the vault. Different sources provide different perspectives, and both are
valuable.

Do not modify existing notes. The manifest is informational only.
```

**Modification to self-review step 5:**
Current: "do `[[wikilinks]]` point to notes you actually created? Fix broken links."
Updated: "do `[[wikilinks]]` point to notes you created or to existing notes listed in `<existing_vault_notes>`? Fix any links that point to neither."

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
2. Pass the manifest string into `process()` → `buildPrompt()`
3. On manifest failure: warn and proceed without it

**`handlePromotion()` changes:**
1. After promoting all notes and before cleanup, call the citation linker
2. Pass it the extraction content path and `vault/sources/` directory
3. On citation linker failure: warn and continue

## Testing

### Unit Tests

**`vault-manifest.test.ts`:**
- Empty vault → returns empty or minimal manifest
- Vault with mixed note types → correct grouping under Sources / Concepts
- Notes with missing frontmatter fields → skipped gracefully, others still included
- Slug derivation from filenames

**`citation-linker.test.ts`:**
- Bibliography parsing with Docling-formatted entries (APA style with page markers)
- Fuzzy author+year matching against source note frontmatter
- No bibliography section → graceful skip, no errors
- Multiple matches (same author, different years) → correct discrimination
- Bidirectional frontmatter updates (cites + cited_by)
- Existing `cites` / `cited_by` arrays → appended to, not overwritten

### Integration

- Existing pipeline tests pass unchanged (both features are additive)
- No new external dependencies

## Future Considerations

- If the vault grows beyond ~1,000 notes, the manifest could be filtered by topic relevance to the incoming document (using topics from the extracted content). Not needed now.
- The citation graph data (`cites` / `cited_by`) is the foundation for a graph visualization in the web dashboard. Implementation TBD in a separate spec.
- RAG-assisted concept bridging (Approach 3 from brainstorming) remains available as an upgrade path if the lightweight manifest proves insufficient.
