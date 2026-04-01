# Cross-Source Reference Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add citation graph detection and cross-source concept linking to the ingestion pipeline so that sources and concepts are interconnected in the vault.

**Architecture:** Two additive, non-blocking enrichments to the existing pipeline. A post-promotion citation linker parses bibliographies and writes `cites`/`cited_by` edges (SQLite + frontmatter). A pre-generation vault manifest gives the ingestion agent awareness of existing notes for cross-source wikilinks.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, gray-matter (existing deps only)

**Spec:** `docs/superpowers/specs/2026-04-01-cross-source-references-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/ingestion/vault-manifest.ts` | Create | Build compact manifest of existing vault notes |
| `src/ingestion/vault-manifest.test.ts` | Create | Tests for vault manifest builder |
| `src/ingestion/citation-linker.ts` | Create | Bibliography parsing, author matching, edge writing |
| `src/ingestion/citation-linker.test.ts` | Create | Tests for citation linker |
| `src/db.ts` | Modify | Add `citation_edges` table + CRUD helpers |
| `src/db.test.ts` | Modify | Tests for citation edge helpers |
| `src/ingestion/agent-processor.ts` | Modify | Accept and inject vault manifest into prompt |
| `src/ingestion/agent-processor.test.ts` | Modify | Test manifest injection |
| `src/ingestion/index.ts` | Modify | Wire manifest into generation, citation linker into promotion |
| `groups/review_agent/CLAUDE.md` | Modify | Agent instructions for existing vault notes |

---

### Task 1: Citation Edges Table + DB Helpers

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

- [ ] **Step 1: Write failing tests for citation edge helpers**

Add to `src/db.test.ts`:

```typescript
describe('citation edges', () => {
  it('inserts and retrieves citation edges', () => {
    insertCitationEdge('source-a', 'source-b');
    insertCitationEdge('source-a', 'source-c');

    expect(getCites('source-a')).toEqual(['source-b', 'source-c']);
    expect(getCitedBy('source-b')).toEqual(['source-a']);
    expect(getCitedBy('source-c')).toEqual(['source-a']);
  });

  it('ignores duplicate edges', () => {
    insertCitationEdge('source-a', 'source-b');
    insertCitationEdge('source-a', 'source-b');

    expect(getCites('source-a')).toEqual(['source-b']);
  });

  it('deletes all edges for a source (re-ingestion rebuild)', () => {
    insertCitationEdge('source-a', 'source-b');
    insertCitationEdge('source-a', 'source-c');
    insertCitationEdge('source-d', 'source-a');

    deleteCitationEdges('source-a');

    expect(getCites('source-a')).toEqual([]);
    // Edges where source-a is the target are untouched
    expect(getCitedBy('source-a')).toEqual(['source-d']);
  });

  it('returns empty arrays for unknown slugs', () => {
    expect(getCites('nonexistent')).toEqual([]);
    expect(getCitedBy('nonexistent')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `insertCitationEdge` is not exported

- [ ] **Step 3: Add citation_edges table and helpers to db.ts**

In `src/db.ts`, add to `createSchema()` after the `settings` table creation (~line 201):

```typescript
  database.exec(`
    CREATE TABLE IF NOT EXISTS citation_edges (
      source_slug TEXT NOT NULL,
      target_slug TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (source_slug, target_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_citation_target ON citation_edges(target_slug);
  `);
```

Add exported helper functions at the bottom of `src/db.ts`, before the `// --- JSON migration ---` comment:

```typescript
// --- Citation edges ---

export function insertCitationEdge(
  sourceSlug: string,
  targetSlug: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO citation_edges (source_slug, target_slug, created_at)
     VALUES (?, ?, ?)`,
  ).run(sourceSlug, targetSlug, new Date().toISOString());
}

export function deleteCitationEdges(sourceSlug: string): void {
  db.prepare('DELETE FROM citation_edges WHERE source_slug = ?').run(
    sourceSlug,
  );
}

export function getCites(sourceSlug: string): string[] {
  const rows = db
    .prepare('SELECT target_slug FROM citation_edges WHERE source_slug = ?')
    .all(sourceSlug) as { target_slug: string }[];
  return rows.map((r) => r.target_slug);
}

export function getCitedBy(targetSlug: string): string[] {
  const rows = db
    .prepare('SELECT source_slug FROM citation_edges WHERE target_slug = ?')
    .all(targetSlug) as { source_slug: string }[];
  return rows.map((r) => r.source_slug);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: add citation_edges table and CRUD helpers"
```

---

### Task 2: Vault Manifest Builder

**Files:**
- Create: `src/ingestion/vault-manifest.ts`
- Create: `src/ingestion/vault-manifest.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/ingestion/vault-manifest.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { buildVaultManifest } from './vault-manifest.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/vault-manifest');
const VAULT = join(TMP, 'vault');

describe('buildVaultManifest', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(VAULT, 'concepts'), { recursive: true });
    mkdirSync(join(VAULT, 'sources'), { recursive: true });
  });

  it('returns empty manifest for empty vault', () => {
    const manifest = buildVaultManifest(VAULT);

    expect(manifest).toContain('<existing_vault_notes>');
    expect(manifest).toContain('</existing_vault_notes>');
    expect(manifest).toContain('## Sources');
    expect(manifest).toContain('## Concepts');
  });

  it('lists source notes with title', () => {
    writeFileSync(
      join(VAULT, 'sources', 'kirschner-2002.md'),
      '---\ntitle: "Cognitive Load Theory (Kirschner 2002)"\ntype: source\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    expect(manifest).toContain(
      '- kirschner-2002 | "Cognitive Load Theory (Kirschner 2002)"',
    );
  });

  it('lists concept notes with title and topics', () => {
    writeFileSync(
      join(VAULT, 'concepts', 'working-memory.md'),
      '---\ntitle: Working Memory Architecture\ntype: concept\ntopics:\n  - cognitive-load\n  - memory\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    expect(manifest).toContain(
      '- working-memory | "Working Memory Architecture" | topics: cognitive-load, memory',
    );
  });

  it('skips notes with missing frontmatter gracefully', () => {
    writeFileSync(join(VAULT, 'concepts', 'no-frontmatter.md'), 'Just text');
    writeFileSync(
      join(VAULT, 'concepts', 'has-frontmatter.md'),
      '---\ntitle: Valid Note\ntype: concept\ntopics:\n  - test\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    expect(manifest).toContain('has-frontmatter');
    expect(manifest).not.toContain('no-frontmatter');
  });

  it('groups sources and concepts under separate headings', () => {
    writeFileSync(
      join(VAULT, 'sources', 'paper-a.md'),
      '---\ntitle: Paper A\ntype: source\n---\nContent',
    );
    writeFileSync(
      join(VAULT, 'concepts', 'concept-b.md'),
      '---\ntitle: Concept B\ntype: concept\ntopics:\n  - test\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    const sourcesIdx = manifest.indexOf('## Sources');
    const conceptsIdx = manifest.indexOf('## Concepts');
    const paperIdx = manifest.indexOf('paper-a');
    const conceptIdx = manifest.indexOf('concept-b');

    expect(paperIdx).toBeGreaterThan(sourcesIdx);
    expect(paperIdx).toBeLessThan(conceptsIdx);
    expect(conceptIdx).toBeGreaterThan(conceptsIdx);
  });

  it('handles hash-suffixed filenames from promoter collision', () => {
    writeFileSync(
      join(VAULT, 'concepts', 'gradient-descent-a1b2.md'),
      '---\ntitle: Gradient Descent\ntype: concept\ntopics:\n  - ml\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    expect(manifest).toContain('gradient-descent-a1b2');
  });

  it('ignores non-md files', () => {
    writeFileSync(join(VAULT, 'concepts', '.DS_Store'), '');
    writeFileSync(
      join(VAULT, 'concepts', 'valid.md'),
      '---\ntitle: Valid\ntype: concept\ntopics:\n  - test\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    expect(manifest).not.toContain('.DS_Store');
    expect(manifest).toContain('valid');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ingestion/vault-manifest.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — module not found

- [ ] **Step 3: Implement vault-manifest.ts**

Create `src/ingestion/vault-manifest.ts`:

```typescript
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../vault/frontmatter.js';

interface NoteEntry {
  slug: string;
  title: string;
  topics?: string[];
}

function scanDir(dir: string): NoteEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const entries: NoteEntry[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const { data: fm } = parseFrontmatter(content);
      if (!fm.title) continue;

      entries.push({
        slug: file.replace(/\.md$/, ''),
        title: fm.title as string,
        topics: Array.isArray(fm.topics) ? (fm.topics as string[]) : undefined,
      });
    } catch {
      // Skip unreadable files
    }
  }
  return entries;
}

export function buildVaultManifest(vaultDir: string): string {
  const sources = scanDir(join(vaultDir, 'sources'));
  const concepts = scanDir(join(vaultDir, 'concepts'));

  const lines: string[] = ['<existing_vault_notes>', '## Sources'];

  for (const s of sources) {
    lines.push(`- ${s.slug} | "${s.title}"`);
  }

  lines.push('', '## Concepts');

  for (const c of concepts) {
    const topicsSuffix = c.topics?.length
      ? ` | topics: ${c.topics.join(', ')}`
      : '';
    lines.push(`- ${c.slug} | "${c.title}"${topicsSuffix}`);
  }

  lines.push('</existing_vault_notes>');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ingestion/vault-manifest.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/vault-manifest.ts src/ingestion/vault-manifest.test.ts
git commit -m "feat: add vault manifest builder for cross-source concept linking"
```

---

### Task 3: Inject Vault Manifest into Agent Prompt

**Files:**
- Modify: `src/ingestion/agent-processor.ts`
- Modify: `src/ingestion/agent-processor.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/ingestion/agent-processor.test.ts`:

```typescript
  it('includes vault manifest when provided', () => {
    const manifest =
      '<existing_vault_notes>\n## Sources\n- paper-a | "Paper A"\n</existing_vault_notes>';
    const prompt = processor.buildPrompt(
      'Content',
      'paper.pdf',
      'job-123',
      [],
      manifest,
    );

    expect(prompt).toContain('<existing_vault_notes>');
    expect(prompt).toContain('paper-a');

    // Manifest should be between document content and job parameters
    const manifestIdx = prompt.indexOf('<existing_vault_notes>');
    const docEnd = prompt.indexOf('</document>');
    const jobParams = prompt.indexOf('## Job Parameters');
    expect(manifestIdx).toBeGreaterThan(docEnd);
    expect(manifestIdx).toBeLessThan(jobParams);
  });

  it('omits manifest section when not provided', () => {
    const prompt = processor.buildPrompt(
      'Content',
      'paper.pdf',
      'job-123',
      [],
    );

    expect(prompt).not.toContain('<existing_vault_notes>');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ingestion/agent-processor.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — manifest not included in prompt

- [ ] **Step 3: Update buildPrompt and process to accept manifest**

In `src/ingestion/agent-processor.ts`, update `buildPrompt` signature:

```typescript
  buildPrompt(
    extractedContent: string,
    fileName: string,
    jobId: string,
    figures: string[],
    vaultManifest?: string,
  ): string {
```

Add the manifest section after the figures section and before the `## Job Parameters` return. Replace the return statement with:

```typescript
    const manifestSection = vaultManifest ? `\n${vaultManifest}\n` : '';

    return `<document>
<source>${fileName}</source>
<document_content>
${extractedContent}
</document_content>
</document>
${figuresSection}${manifestSection}
## Job Parameters
...rest unchanged...`;
```

Update `process()` signature to accept and forward the manifest:

```typescript
  async process(
    extractionPath: string,
    fileName: string,
    jobId: string,
    reviewAgentGroup: RegisteredGroup,
    vaultManifest?: string,
  ): Promise<{ status: 'success' | 'error'; error?: string }> {
```

And update the `buildPrompt` call inside `process()`:

```typescript
    const prompt = this.buildPrompt(extractedContent, fileName, jobId, figures, vaultManifest);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ingestion/agent-processor.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/agent-processor.ts src/ingestion/agent-processor.test.ts
git commit -m "feat: inject vault manifest into ingestion agent prompt"
```

---

### Task 4: Wire Vault Manifest into Pipeline

**Files:**
- Modify: `src/ingestion/index.ts`

- [ ] **Step 1: Add import**

At the top of `src/ingestion/index.ts`, add:

```typescript
import { buildVaultManifest } from './vault-manifest.js';
```

- [ ] **Step 2: Build and pass manifest in handleGeneration**

In `handleGeneration()`, after the line `const extractionPath = job.extraction_path;` (~line 210) and before the agent call, add:

```typescript
    let vaultManifest: string | undefined;
    try {
      vaultManifest = buildVaultManifest(this.vaultDir);
    } catch (err) {
      logger.warn({ jobId: job.id, err }, 'Failed to build vault manifest — proceeding without it');
    }
```

Update the `this.agentProcessor.process()` call (~line 308) to pass the manifest:

```typescript
      const output = await runContainerAgent(
```

Wait — the manifest needs to go through `AgentProcessor.process()`. Update the call on ~line 308:

```typescript
    const containerPromise = this.agentProcessor
      .process(extractionPath, fileName, job.id, this.reviewAgentGroup, vaultManifest)
      .finally(() => ac.abort());
```

- [ ] **Step 3: Run existing pipeline tests to verify nothing broke**

Run: `npx vitest run src/ingestion/ --reporter=verbose 2>&1 | tail -30`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/ingestion/index.ts
git commit -m "feat: wire vault manifest into ingestion pipeline generation step"
```

---

### Task 5: Citation Linker — Bibliography Parsing + Author Matching

**Files:**
- Create: `src/ingestion/citation-linker.ts`
- Create: `src/ingestion/citation-linker.test.ts`

- [ ] **Step 1: Write failing tests for bibliography detection and parsing**

Create `src/ingestion/citation-linker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  extractBibliography,
  parseBibEntry,
  normalizeName,
} from './citation-linker.js';

describe('normalizeName', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeName('Müller')).toBe('muller');
    expect(normalizeName('Van Merriënboer')).toBe('van merrienboer');
  });

  it('collapses whitespace', () => {
    expect(normalizeName('De  la   Cruz')).toBe('de la cruz');
  });

  it('handles plain ascii', () => {
    expect(normalizeName('Kirschner')).toBe('kirschner');
  });
});

describe('parseBibEntry', () => {
  it('parses single-author APA entry', () => {
    const result = parseBibEntry('Sweller, J. (1999). Instructional design in technical areas.');
    expect(result).toEqual({ lastName: 'sweller', year: '1999' });
  });

  it('parses multi-author APA entry', () => {
    const result = parseBibEntry(
      'Plass, J. L., Chun, D. M., Mayer, R. E., & Leutner, D. (1998). Supporting visual preferences.',
    );
    expect(result).toEqual({ lastName: 'plass', year: '1998' });
  });

  it('parses entry with diacritics', () => {
    const result = parseBibEntry(
      'Mousavi, S., Low, R., & Sweller, J. (1995). Reducing cognitive load.',
    );
    expect(result).toEqual({ lastName: 'mousavi', year: '1995' });
  });

  it('returns null for non-APA text', () => {
    expect(parseBibEntry('This is just a sentence.')).toBeNull();
    expect(parseBibEntry('1. First item in a list')).toBeNull();
  });

  it('handles OCR artifacts in author names', () => {
    const result = parseBibEntry('Paas, E G. W. C., & Van Merrienboer, J. J, G. (1994). Measurement of cognitive load.');
    expect(result).toEqual({ lastName: 'paas', year: '1994' });
  });
});

describe('extractBibliography', () => {
  it('detects bibliography cluster at end of document', () => {
    const content = `
Some body text here.

<!-- page:50 label:section_header -->
## References

<!-- page:50 label:list_item -->
Sweller, J. (1999). Instructional design in technical areas.

<!-- page:50 label:list_item -->
Mayer, R. E. (2002). Multimedia learning. Cambridge University Press.

<!-- page:51 label:list_item -->
Kirschner, P. A. (2002). Cognitive load theory. Learning and Instruction, 12, 1-10.
`;

    const entries = extractBibliography(content);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ lastName: 'sweller', year: '1999' });
    expect(entries[1]).toEqual({ lastName: 'mayer', year: '2002' });
    expect(entries[2]).toEqual({ lastName: 'kirschner', year: '2002' });
  });

  it('ignores scattered list_item entries in body text', () => {
    const content = `
<!-- page:5 label:list_item -->
First bullet point about methods.

<!-- page:5 label:list_item -->
Second bullet point about results.

Some text in between that breaks the cluster.

<!-- page:20 label:list_item -->
Another unrelated bullet point.
`;

    const entries = extractBibliography(content);

    expect(entries).toEqual([]);
  });

  it('returns empty array when no bibliography found', () => {
    const content = '# Lecture Slides\n\nSlide 1: Introduction\nSlide 2: Methods';
    const entries = extractBibliography(content);
    expect(entries).toEqual([]);
  });

  it('handles real Docling output format', () => {
    const content = `
Body of the paper.

<!-- page:53 label:list_item -->
Moreno, R., & Mayer, R. E. (1999a). Multimedia-supported metaphors for meaning making in mathematics. Cognition and Instruction, 17, 215-248.

<!-- page:53 label:list_item -->
Moreno, R., & Mayer, R. E. (1999b). Cognitive principles of multimedia learning: The role of modality and contiguity. Journal of Educational Psychology, 91, 358-368.

<!-- page:54 label:list_item -->
Sweller, J., Chandler, P., Tierney, P., & Cooper, M. (1990). Cognitive load and selective attention. Journal of Experimental Psychology: General, 119, 176-192.

<!-- page:54 label:list_item -->
Piaget, J. (1954). The construction of reality in the child. New York: Basic Books.
`;

    const entries = extractBibliography(content);

    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ lastName: 'moreno', year: '1999' });
    expect(entries[1]).toEqual({ lastName: 'moreno', year: '1999' });
    expect(entries[2]).toEqual({ lastName: 'sweller', year: '1990' });
    expect(entries[3]).toEqual({ lastName: 'piaget', year: '1954' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ingestion/citation-linker.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — module not found

- [ ] **Step 3: Implement bibliography parsing**

Create `src/ingestion/citation-linker.ts`:

```typescript
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { parseFrontmatter, updateFrontmatter } from '../vault/frontmatter.js';
import { insertCitationEdge, deleteCitationEdges } from '../db.js';
import { logger } from '../logger.js';

export interface BibEntry {
  lastName: string;
  year: string;
}

/**
 * Normalize an author name: lowercase, strip diacritics, collapse whitespace.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a bibliography entry to extract the first author's last name and year.
 * Targets APA-style format: "LastName, Initials. (YYYY)"
 * Returns null if the entry doesn't match.
 */
export function parseBibEntry(text: string): BibEntry | null {
  // Match: starts with word chars (author last name), comma, then somewhere a (YYYY) year
  const match = text.match(/^([A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'\-.\s]*?),\s.*?\((\d{4})[a-z]?\)/);
  if (!match) return null;

  const lastName = normalizeName(match[1]);
  const year = match[2];

  return { lastName, year };
}

/**
 * Extract bibliography entries from Docling-extracted content.
 * Looks for a cluster of 3+ consecutive list_item markers at the end of the
 * document where at least 50% contain a 4-digit year in parentheses.
 */
export function extractBibliography(content: string): BibEntry[] {
  const lines = content.split('\n');

  // Find all list_item blocks: marker line followed by text content
  interface ListItemBlock {
    lineIndex: number;
    text: string;
  }
  const listItems: ListItemBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/<!-- page:\d+ label:list_item -->/.test(lines[i])) {
      // Collect text lines until next marker or empty line
      const textLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();
        if (line === '' || /<!-- page:\d+/.test(line)) break;
        textLines.push(line);
      }
      if (textLines.length > 0) {
        listItems.push({ lineIndex: i, text: textLines.join(' ') });
      }
    }
  }

  if (listItems.length < 3) return [];

  // Find the largest contiguous cluster (allowing up to 2 non-list_item lines gap)
  // scanning from the end of the document
  let clusterEnd = listItems.length - 1;
  let clusterStart = clusterEnd;

  for (let i = listItems.length - 2; i >= 0; i--) {
    // Check gap: count non-list_item lines between this item and the next
    const gap = listItems[i + 1].lineIndex - listItems[i].lineIndex;
    // A "gap" of more than ~4 lines (marker + text + blank + marker) means they're separate
    if (gap > 6) break;
    clusterStart = i;
  }

  const cluster = listItems.slice(clusterStart, clusterEnd + 1);
  if (cluster.length < 3) return [];

  // Check: at least 50% contain a 4-digit year in parentheses
  const withYear = cluster.filter((item) => /\(\d{4}[a-z]?\)/.test(item.text));
  if (withYear.length / cluster.length < 0.5) return [];

  // Parse each entry
  const entries: BibEntry[] = [];
  for (const item of cluster) {
    const parsed = parseBibEntry(item.text);
    if (parsed) entries.push(parsed);
  }

  return entries;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ingestion/citation-linker.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/citation-linker.ts src/ingestion/citation-linker.test.ts
git commit -m "feat: add bibliography parsing and author name normalization"
```

---

### Task 6: Citation Linker — Source Matching + Edge Writing

**Files:**
- Modify: `src/ingestion/citation-linker.ts`
- Modify: `src/ingestion/citation-linker.test.ts`

- [ ] **Step 1: Write failing tests for source matching and frontmatter updates**

Add to `src/ingestion/citation-linker.test.ts`:

```typescript
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  extractBibliography,
  parseBibEntry,
  normalizeName,
  buildSourceIndex,
  linkCitations,
  filterDeadReferences,
} from './citation-linker.js';

// Add after existing describe blocks:

const TMP = join(import.meta.dirname, '../../.test-tmp/citation-linker');
const VAULT = join(TMP, 'vault');
const SOURCES = join(VAULT, 'sources');

describe('buildSourceIndex', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(SOURCES, { recursive: true });
  });

  it('builds index from source note frontmatter', () => {
    writeFileSync(
      join(SOURCES, 'kirschner-2002.md'),
      '---\ntitle: "CLT (Kirschner 2002)"\ntype: source\nauthors:\n  - "Paul A. Kirschner"\npublished: 2002\n---\nContent',
    );

    const index = buildSourceIndex(SOURCES);

    expect(index.get('kirschner:2002')).toEqual([
      { slug: 'kirschner-2002', filePath: join(SOURCES, 'kirschner-2002.md') },
    ]);
  });

  it('extracts last name from full name (final whitespace token)', () => {
    writeFileSync(
      join(SOURCES, 'van-merrienboer-2003.md'),
      '---\ntitle: "Complex Learning"\ntype: source\nauthors:\n  - "Jeroen J.G. Van Merriënboer"\npublished: 2003\n---\nContent',
    );

    const index = buildSourceIndex(SOURCES);

    // Last token of "Jeroen J.G. Van Merriënboer" is "Merriënboer" → normalized "merrienboer"
    expect(index.has('merrienboer:2003')).toBe(true);
  });

  it('indexes multiple authors from same source', () => {
    writeFileSync(
      join(SOURCES, 'abdous-2012.md'),
      '---\ntitle: "Podcasting"\ntype: source\nauthors:\n  - "M\'hammed Abdous"\n  - "Betty Rose Facer"\npublished: 2012\n---\nContent',
    );

    const index = buildSourceIndex(SOURCES);

    expect(index.has('abdous:2012')).toBe(true);
    expect(index.has('facer:2012')).toBe(true);
  });

  it('skips source notes without authors or published fields', () => {
    writeFileSync(
      join(SOURCES, 'no-authors.md'),
      '---\ntitle: "No Authors"\ntype: source\n---\nContent',
    );

    const index = buildSourceIndex(SOURCES);

    expect(index.size).toBe(0);
  });
});

describe('linkCitations', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(SOURCES, { recursive: true });
  });

  it('writes cites to new source and cited_by to matched source', () => {
    // Existing source
    writeFileSync(
      join(SOURCES, 'kirschner-2002.md'),
      '---\ntitle: "CLT"\ntype: source\nauthors:\n  - "Paul A. Kirschner"\npublished: 2002\n---\nContent',
    );

    // New source (already promoted)
    const newSourcePath = join(SOURCES, 'mayer-2005.md');
    writeFileSync(
      newSourcePath,
      '---\ntitle: "Multimedia"\ntype: source\nauthors:\n  - "Richard E. Mayer"\npublished: 2005\n---\nContent',
    );

    const bibEntries: BibEntry[] = [{ lastName: 'kirschner', year: '2002' }];

    linkCitations(bibEntries, newSourcePath, SOURCES);

    // Check new source has cites
    const { data: newFm } = parseFrontmatter(readFileSync(newSourcePath, 'utf-8'));
    expect(newFm.cites).toEqual(['kirschner-2002']);

    // Check existing source has cited_by
    const { data: existingFm } = parseFrontmatter(
      readFileSync(join(SOURCES, 'kirschner-2002.md'), 'utf-8'),
    );
    expect(existingFm.cited_by).toEqual(['mayer-2005']);
  });

  it('appends to existing cites/cited_by arrays', () => {
    writeFileSync(
      join(SOURCES, 'kirschner-2002.md'),
      '---\ntitle: "CLT"\ntype: source\nauthors:\n  - "Paul A. Kirschner"\npublished: 2002\ncited_by:\n  - "earlier-paper"\n---\nContent',
    );

    const newSourcePath = join(SOURCES, 'mayer-2005.md');
    writeFileSync(
      newSourcePath,
      '---\ntitle: "Multimedia"\ntype: source\nauthors:\n  - "Richard E. Mayer"\npublished: 2005\ncites:\n  - "other-source"\n---\nContent',
    );

    const bibEntries: BibEntry[] = [{ lastName: 'kirschner', year: '2002' }];

    linkCitations(bibEntries, newSourcePath, SOURCES);

    const { data: newFm } = parseFrontmatter(readFileSync(newSourcePath, 'utf-8'));
    expect(newFm.cites).toEqual(['other-source', 'kirschner-2002']);

    const { data: existingFm } = parseFrontmatter(
      readFileSync(join(SOURCES, 'kirschner-2002.md'), 'utf-8'),
    );
    expect(existingFm.cited_by).toEqual(['earlier-paper', 'mayer-2005']);
  });

  it('does not duplicate existing entries', () => {
    writeFileSync(
      join(SOURCES, 'kirschner-2002.md'),
      '---\ntitle: "CLT"\ntype: source\nauthors:\n  - "Paul A. Kirschner"\npublished: 2002\ncited_by:\n  - "mayer-2005"\n---\nContent',
    );

    const newSourcePath = join(SOURCES, 'mayer-2005.md');
    writeFileSync(
      newSourcePath,
      '---\ntitle: "Multimedia"\ntype: source\ncites:\n  - "kirschner-2002"\n---\nContent',
    );

    const bibEntries: BibEntry[] = [{ lastName: 'kirschner', year: '2002' }];

    linkCitations(bibEntries, newSourcePath, SOURCES);

    const { data: newFm } = parseFrontmatter(readFileSync(newSourcePath, 'utf-8'));
    expect(newFm.cites).toEqual(['kirschner-2002']);

    const { data: existingFm } = parseFrontmatter(
      readFileSync(join(SOURCES, 'kirschner-2002.md'), 'utf-8'),
    );
    expect(existingFm.cited_by).toEqual(['mayer-2005']);
  });

  it('handles no matches gracefully', () => {
    const newSourcePath = join(SOURCES, 'lonely-paper.md');
    writeFileSync(
      newSourcePath,
      '---\ntitle: "Lonely"\ntype: source\n---\nContent',
    );

    const bibEntries: BibEntry[] = [{ lastName: 'nobody', year: '2099' }];

    linkCitations(bibEntries, newSourcePath, SOURCES);

    const { data: fm } = parseFrontmatter(readFileSync(newSourcePath, 'utf-8'));
    expect(fm.cites).toBeUndefined();
  });
});

describe('filterDeadReferences', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(SOURCES, { recursive: true });
  });

  it('filters out slugs that do not have corresponding files', () => {
    writeFileSync(join(SOURCES, 'exists.md'), '---\ntitle: Exists\n---\nContent');

    const result = filterDeadReferences(['exists', 'gone'], SOURCES);

    expect(result).toEqual(['exists']);
  });

  it('returns empty array when all references are dead', () => {
    const result = filterDeadReferences(['gone-a', 'gone-b'], SOURCES);
    expect(result).toEqual([]);
  });

  it('returns all slugs when all exist', () => {
    writeFileSync(join(SOURCES, 'a.md'), 'content');
    writeFileSync(join(SOURCES, 'b.md'), 'content');

    const result = filterDeadReferences(['a', 'b'], SOURCES);
    expect(result).toEqual(['a', 'b']);
  });
});
```

Add `beforeEach` import at the top if not already present. Also add imports for `parseFrontmatter` from `../vault/frontmatter.js` and `BibEntry`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ingestion/citation-linker.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `buildSourceIndex`, `linkCitations`, `filterDeadReferences` not exported

- [ ] **Step 3: Implement source matching, edge writing, and lazy validation**

Add to `src/ingestion/citation-linker.ts`:

```typescript
interface SourceInfo {
  slug: string;
  filePath: string;
}

/**
 * Build an index of existing source notes keyed by normalized "lastname:year".
 * Each author in the source's authors array gets their own key.
 */
export function buildSourceIndex(
  sourcesDir: string,
): Map<string, SourceInfo[]> {
  const index = new Map<string, SourceInfo[]>();

  let files: string[];
  try {
    files = readdirSync(sourcesDir).filter((f) => f.endsWith('.md'));
  } catch {
    return index;
  }

  for (const file of files) {
    try {
      const content = readFileSync(join(sourcesDir, file), 'utf-8');
      const { data: fm } = parseFrontmatter(content);

      const authors = fm.authors as string[] | undefined;
      const published = fm.published as number | undefined;
      if (!Array.isArray(authors) || !published) continue;

      const slug = file.replace(/\.md$/, '');
      const info: SourceInfo = { slug, filePath: join(sourcesDir, file) };

      for (const author of authors) {
        const parts = author.trim().split(/\s+/);
        const lastName = normalizeName(parts[parts.length - 1]);
        const key = `${lastName}:${published}`;

        const existing = index.get(key) ?? [];
        existing.push(info);
        index.set(key, existing);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return index;
}

/**
 * Append a value to an array frontmatter field, avoiding duplicates.
 * Reads the file, updates, writes back.
 */
function appendFrontmatterArray(
  filePath: string,
  field: string,
  value: string,
): void {
  const content = readFileSync(filePath, 'utf-8');
  const { data: fm } = parseFrontmatter(content);
  const existing = Array.isArray(fm[field]) ? (fm[field] as string[]) : [];
  if (existing.includes(value)) return;
  const updated = updateFrontmatter(content, {
    [field]: [...existing, value],
  });
  writeFileSync(filePath, updated);
}

/**
 * Link bibliography entries to existing vault sources.
 * Writes cites/cited_by frontmatter and SQLite edges.
 */
export function linkCitations(
  bibEntries: BibEntry[],
  newSourcePath: string,
  sourcesDir: string,
): void {
  const index = buildSourceIndex(sourcesDir);
  const newSlug = basename(newSourcePath).replace(/\.md$/, '');
  const matched = new Set<string>();

  for (const entry of bibEntries) {
    const key = `${entry.lastName}:${entry.year}`;
    const sources = index.get(key);
    if (!sources) continue;

    for (const source of sources) {
      // Don't self-cite
      if (source.slug === newSlug) continue;
      if (matched.has(source.slug)) continue;
      matched.add(source.slug);

      // SQLite edge
      try {
        insertCitationEdge(newSlug, source.slug);
      } catch (err) {
        logger.warn({ err, newSlug, targetSlug: source.slug }, 'Failed to insert citation edge');
      }

      // Frontmatter: cites on new source
      appendFrontmatterArray(newSourcePath, 'cites', source.slug);

      // Frontmatter: cited_by on matched source
      appendFrontmatterArray(source.filePath, 'cited_by', newSlug);
    }
  }
}

/**
 * Filter out slugs that don't correspond to existing files.
 * Safety net for stale references.
 */
export function filterDeadReferences(
  slugs: string[],
  sourcesDir: string,
): string[] {
  return slugs.filter((slug) => existsSync(join(sourcesDir, `${slug}.md`)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ingestion/citation-linker.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS (note: `linkCitations` tests that call `insertCitationEdge` will need the DB initialized — if they fail because the DB isn't set up in the test environment, mock the DB calls or wrap them in try/catch in the test. The frontmatter tests should pass regardless.)

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/citation-linker.ts src/ingestion/citation-linker.test.ts
git commit -m "feat: add citation source matching, edge writing, and lazy validation"
```

---

### Task 7: Wire Citation Linker into Pipeline

**Files:**
- Modify: `src/ingestion/index.ts`

- [ ] **Step 1: Add import**

At the top of `src/ingestion/index.ts`, add:

```typescript
import { extractBibliography, linkCitations } from './citation-linker.js';
```

And add `deleteCitationEdges` to the existing `../db.js` import:

```typescript
import {
  createIngestionJob,
  getIngestionJobByPath,
  getCompletedJobByHash,
  updateIngestionJob,
  deleteCitationEdges,
} from '../db.js';
```

Note: `readFileSync` is already imported from `node:fs` at the top.

- [ ] **Step 2: Track promoted source path in handlePromotion**

In `handlePromotion()`, the source note promotion block (~line 359) already returns a path. Store it:

```typescript
    let promotedSourcePath: string | undefined;

    // Promote source note
    if (manifest.source_note) {
      const sourceDraftPath = join(draftsDir, manifest.source_note);
      try {
        const promoted = promoteNote(sourceDraftPath, this.vaultDir, job.id);
        promotedPaths.push(promoted);
        promotedSourcePath = join(this.vaultDir, promoted);
        logger.info({ jobId: job.id, promoted }, 'Promoted source note');
      } catch (err) {
        logger.warn(
          { jobId: job.id, file: manifest.source_note, err },
          'Failed to promote source note',
        );
      }
    }
```

- [ ] **Step 3: Add citation linking after all promotions, before cleanup**

After the concept note promotion loop and before the `// Move source file to processed/` block (~line 396), add:

```typescript
    // --- Citation linking (non-blocking enrichment) ---
    if (promotedSourcePath && job.extraction_path) {
      try {
        const newSlug = promotedSourcePath
          .split('/')
          .pop()!
          .replace(/\.md$/, '');

        // Re-ingestion: clear old edges before rebuilding
        deleteCitationEdges(newSlug);

        const contentPath = join(job.extraction_path, 'content.md');
        const extractedContent = readFileSync(contentPath, 'utf-8');
        const bibEntries = extractBibliography(extractedContent);
        if (bibEntries.length > 0) {
          const sourcesDir = join(this.vaultDir, 'sources');
          linkCitations(bibEntries, promotedSourcePath, sourcesDir);
          logger.info(
            { jobId: job.id, bibEntries: bibEntries.length },
            'Citation linking completed',
          );
        } else {
          logger.info({ jobId: job.id }, 'No bibliography entries found — skipping citation linking');
        }
      } catch (err) {
        logger.warn({ jobId: job.id, err }, 'Citation linking failed — continuing without it');
      }
    }
```

- [ ] **Step 4: Run all ingestion tests**

Run: `npx vitest run src/ingestion/ --reporter=verbose 2>&1 | tail -30`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/index.ts
git commit -m "feat: wire citation linker into ingestion pipeline promotion step"
```

---

### Task 8: Update Agent Instructions

**Files:**
- Modify: `groups/review_agent/CLAUDE.md`

- [ ] **Step 1: Update vault workspace description**

Change line 8 from:
```
- **Vault (read):** `/workspace/extra/vault/` — check existing notes to avoid duplicates, reference existing concepts
```
To:
```
- **Vault (read):** `/workspace/extra/vault/` — reference for vault structure
```

- [ ] **Step 2: Add Existing Vault Notes section**

After the "## Cross-References" section (after line 95), add:

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

- [ ] **Step 3: Update self-review step 5**

Change line 116 from:
```
5. Check: do `[[wikilinks]]` point to notes you actually created? Fix broken links.
```
To:
```
5. Check: do `[[wikilinks]]` point to notes you created or to existing notes listed in `<existing_vault_notes>`? Fix any links that point to neither.
```

- [ ] **Step 4: Commit**

```bash
git add groups/review_agent/CLAUDE.md
git commit -m "feat: update agent instructions for cross-source concept linking"
```

---

### Task 9: Run Full Test Suite + Manual Verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test 2>&1 | tail -30`
Expected: All tests PASS

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npm run build 2>&1 | tail -20`
Expected: Clean compilation

- [ ] **Step 3: Commit any remaining fixes**

If any tests or build issues were found and fixed, commit them:

```bash
git add -A
git commit -m "fix: resolve test/build issues from cross-source references"
```
