# Vault Organization Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the vault from course-based to thematic atomic notes, with cite-then-generate prompting, multi-note output, and lazy verification.

**Architecture:** Replace the tier/review pipeline with a simpler flow: file watcher → Docling extraction with location markers → multi-turn agent session producing N atomic notes + 1 source overview via manifest → auto-promotion to flat vault folders → lazy QA verification on first retrieval. RAG indexer switches to allowlist with new metadata prefix.

**Tech Stack:** TypeScript/Node.js, Vitest, SQLite (better-sqlite3), Python (Docling), LightRAG, Claude Agent SDK containers

**Spec:** `docs/superpowers/specs/2026-03-30-vault-organization-redesign.md`

---

## File Structure

### Files to Create
| File | Responsibility |
|------|---------------|
| `src/ingestion/manifest.ts` | Manifest reading, validation, and draft discovery |
| `src/ingestion/manifest.test.ts` | Manifest tests |
| `src/ingestion/promoter.ts` | Draft → vault promotion (rename, move, collision handling) |
| `src/ingestion/promoter.test.ts` | Promoter tests |
| `src/ingestion/sentinel.ts` | Sentinel file polling and IPC close signaling |
| `src/ingestion/sentinel.test.ts` | Sentinel tests |
| `src/ingestion/verifier.ts` | Lazy QA verification system |
| `src/ingestion/verifier.test.ts` | Verifier tests |
| `src/profile/rotation.ts` | Study log rotation and knowledge history archiving |
| `src/profile/rotation.test.ts` | Rotation tests |
| `vault/concepts/.gitkeep` | New vault folder |
| `vault/sources/.gitkeep` | New vault folder |
| `vault/_nav/.gitkeep` | New vault folder |
| `vault/profile/archive/.gitkeep` | New vault folder |

### Files to Modify
| File | Changes |
|------|---------|
| `src/db.ts` | Remove review_items table, obsolete columns; simplify createIngestionJob |
| `src/ingestion/index.ts` | Rewrite pipeline orchestration for multi-note, sentinel, auto-promotion |
| `src/ingestion/pipeline.ts` | Remove tier branching, simplify drainer |
| `src/ingestion/agent-processor.ts` | New prompt (cite-then-generate, atomic decomposition, manifest) |
| `src/ingestion/file-watcher.ts` | Update ignore pattern `.processed/` → `processed/` |
| `src/ingestion/extractor.ts` | No changes (extraction enhancement is Python-side) |
| `src/ingestion/job-recovery.ts` | Remove tier references, update stale job handling |
| `scripts/docling-extract.py` | Add location markers via iterate_items() |
| `src/rag/indexer.ts` | Switch to allowlist, new metadata prefix format |
| `src/rag/rag-client.ts` | Fix Python injection — pass content via stdin |
| `src/config.ts` | Add SENTINEL_TIMEOUT, PROCESSED_DIR constants |
| `vault/profile/knowledge-map.md` | Add YAML frontmatter, update format |
| `vault/profile/study-log.md` | Update format |
| `vault/profile/student-profile.md` | Update format |

### Files to Delete
| File | Reason |
|------|--------|
| `src/ingestion/path-parser.ts` | No longer needed — uploads not organized by course |
| `src/ingestion/path-parser.test.ts` | Tests for removed code |
| `src/ingestion/tier-classifier.ts` | Tier system removed |
| `src/ingestion/tier-classifier.test.ts` | Tests for removed code |
| `src/ingestion/review-queue.ts` | Review/approval replaced by lazy verification |
| `src/ingestion/review-queue.test.ts` | Tests for removed code |
| `src/ingestion/type-mappings.ts` | Folder→type classification no longer needed |
| `src/ingestion/type-mappings.test.ts` | Tests for removed code |
| `src/ingestion/approval.test.ts` | Tests for removed approval system |
| `vault/courses/` | Old course-based structure |
| `vault/drafts/*.md` | Old UUID drafts (keep .gitkeep) |
| `upload/1. Semester/` | Old course uploads |

---

## Task 1: Database Schema Migration

**Files:**
- Modify: `src/db.ts:86-120` (schema), `src/db.ts:748-906` (ingestion functions)
- Modify: `src/db-ingestion.test.ts`
- Modify: `src/ingestion/db-ingestion.test.ts`

- [ ] **Step 1: Write failing test for simplified createIngestionJob**

In `src/ingestion/db-ingestion.test.ts`, add:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase, createIngestionJob, getIngestionJobs } from '../db.js';

describe('simplified ingestion schema', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates a job with only fileName, filePath, and status', () => {
    createIngestionJob('job-1', '/upload/paper.pdf', 'paper.pdf');
    const jobs = getIngestionJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'job-1',
      source_path: '/upload/paper.pdf',
      source_filename: 'paper.pdf',
      status: 'pending',
    });
    // Old columns should not exist
    expect(jobs[0]).not.toHaveProperty('tier');
    expect(jobs[0]).not.toHaveProperty('course_code');
  });

  it('does not have a review_items table', () => {
    expect(() => {
      const db = (globalThis as any).__nanoclaw_db;
      db.prepare('SELECT * FROM review_items').all();
    }).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/ingestion/db-ingestion.test.ts`
Expected: FAIL — `createIngestionJob` has wrong arity, `review_items` table exists

- [ ] **Step 3: Update schema and functions**

In `src/db.ts`, replace the `ingestion_jobs` CREATE TABLE (lines ~86-104) with:

```sql
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  extraction_path TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status ON ingestion_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_source_path ON ingestion_jobs(source_path);
```

Remove the entire `review_items` CREATE TABLE block (lines ~106-119).

Replace `createIngestionJob` (lines ~748-771) with:

```typescript
export function createIngestionJob(
  id: string,
  sourcePath: string,
  sourceFilename: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO ingestion_jobs (id, source_path, source_filename)
       VALUES (?, ?, ?)`,
    )
    .run(id, sourcePath, sourceFilename);
}
```

Remove these functions entirely:
- `createReviewItem` (~799-820)
- `updateReviewItemStatus` (~822-827)
- `getPendingReviewItems` (~829-835)
- `getReviewItemByJobId` (~894-898)

Update `updateIngestionJob` to remove `tier` from the allowed updates:

```typescript
export function updateIngestionJob(
  id: string,
  updates: {
    status?: string;
    extraction_path?: string;
    error?: string;
  },
): void {
  const setClauses: string[] = ['updated_at = datetime(\'now\')'];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    values.push(updates.status);
    if (updates.status === 'completed') {
      setClauses.push('completed_at = datetime(\'now\')');
    }
  }
  if (updates.extraction_path !== undefined) {
    setClauses.push('extraction_path = ?');
    values.push(updates.extraction_path);
  }
  if (updates.error !== undefined) {
    setClauses.push('error = ?');
    values.push(updates.error);
  }

  values.push(id);
  getDb()
    .prepare(
      `UPDATE ingestion_jobs SET ${setClauses.join(', ')} WHERE id = ?`,
    )
    .run(...values);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/ingestion/db-ingestion.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/ingestion/db-ingestion.test.ts
git commit -m "refactor(db): simplify ingestion schema — remove tiers, review_items, course columns"
```

---

## Task 2: Vault Cleanup and New Folder Structure

**Files:**
- Delete: `vault/courses/`, `vault/drafts/*.md`, `upload/1. Semester/`
- Create: `vault/concepts/.gitkeep`, `vault/sources/.gitkeep`, `vault/_nav/.gitkeep`, `vault/profile/archive/.gitkeep`, `upload/processed/`
- Modify: `vault/profile/knowledge-map.md`, `vault/profile/study-log.md`

- [ ] **Step 1: Delete old vault content**

```bash
rm -rf vault/courses/
rm -f vault/drafts/*.md
rm -rf "upload/1. Semester/"
```

- [ ] **Step 2: Create new folders**

```bash
touch vault/concepts/.gitkeep
touch vault/sources/.gitkeep
mkdir -p vault/_nav && touch vault/_nav/.gitkeep
mkdir -p vault/profile/archive && touch vault/profile/archive/.gitkeep
mkdir -p upload/processed
```

- [ ] **Step 3: Update profile files**

`vault/profile/knowledge-map.md`:
```markdown
---
title: Knowledge Map
type: profile
updated: 2026-03-30
---

## Topics
```

`vault/profile/study-log.md`:
```markdown
---
title: Study Log
type: profile
created: 2026-03-30
---
```

`vault/profile/student-profile.md` — keep as-is (already has valid frontmatter).

- [ ] **Step 4: Commit**

```bash
git add -A vault/ upload/
git commit -m "chore: clean vault, create new thematic folder structure"
```

---

## Task 3: Remove Dead Code

**Files:**
- Delete: `src/ingestion/path-parser.ts`, `src/ingestion/path-parser.test.ts`
- Delete: `src/ingestion/tier-classifier.ts`, `src/ingestion/tier-classifier.test.ts`
- Delete: `src/ingestion/review-queue.ts`, `src/ingestion/review-queue.test.ts`
- Delete: `src/ingestion/type-mappings.ts`, `src/ingestion/type-mappings.test.ts`
- Delete: `src/ingestion/approval.test.ts`
- Modify: `src/ingestion/index.ts` (remove imports — full rewrite comes in Task 8)

- [ ] **Step 1: Delete files**

```bash
rm src/ingestion/path-parser.ts src/ingestion/path-parser.test.ts
rm src/ingestion/tier-classifier.ts src/ingestion/tier-classifier.test.ts
rm src/ingestion/review-queue.ts src/ingestion/review-queue.test.ts
rm src/ingestion/type-mappings.ts src/ingestion/type-mappings.test.ts
rm src/ingestion/approval.test.ts
```

- [ ] **Step 2: Verify build still compiles (will fail — that's expected)**

```bash
npm run build 2>&1 | head -30
```

Expected: Compilation errors from `src/ingestion/index.ts` referencing deleted modules. This is expected — Task 8 rewrites index.ts. For now, just note the errors.

- [ ] **Step 3: Commit**

```bash
git add -A src/ingestion/
git commit -m "refactor: remove path-parser, tier-classifier, review-queue, type-mappings"
```

---

## Task 4: Fix RAG Client Python Injection

**Files:**
- Modify: `src/rag/rag-client.ts`
- Modify: `src/rag/rag-client.test.ts`

- [ ] **Step 1: Write failing test for stdin-based indexing**

In `src/rag/rag-client.test.ts`, add:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

import { RagClient } from './rag-client.js';

describe('RagClient stdin safety', () => {
  let client: RagClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new RagClient({
      workingDir: '/tmp/rag',
      vaultDir: '/tmp/vault',
    });
  });

  it('passes content via stdin, not string interpolation', async () => {
    // Simulate execFile that reads stdin
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (callback) callback(null, { stdout: 'ok', stderr: '' });
      // Return a mock child process with stdin
      return { stdin: { write: vi.fn(), end: vi.fn() } } as any;
    });

    const dangerousContent = 'Text with """triple quotes""" and $VARS and `backticks`';
    await client.index(dangerousContent);

    // The python code passed to execFile should NOT contain the content inline
    const pythonArg = mockExecFile.mock.calls[0]?.[1]?.[1] as string;
    expect(pythonArg).not.toContain('triple quotes');
    expect(pythonArg).toContain('sys.stdin.read()');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/rag/rag-client.test.ts`
Expected: FAIL — current implementation interpolates content into Python code

- [ ] **Step 3: Refactor RagClient to use stdin**

Replace the `index()` method in `src/rag/rag-client.ts`:

```typescript
async index(text: string): Promise<void> {
  const script = `
import sys, asyncio
from lightrag import LightRAG
rag = LightRAG(working_dir="${this.workingDir}")
content = sys.stdin.read()
asyncio.run(rag.ainsert(content))
print("ok")
`;
  await this.execPythonWithStdin(script, text);
}
```

Replace the `query()` method similarly:

```typescript
async query(
  question: string,
  mode: 'naive' | 'local' | 'global' | 'hybrid' = 'hybrid',
  filters?: Record<string, string>,
): Promise<RagResult> {
  const enriched = this.buildQuery(question, filters);
  const script = `
import sys, asyncio
from lightrag import LightRAG
rag = LightRAG(working_dir="${this.workingDir}")
question = sys.stdin.read()
result = asyncio.run(rag.aquery(question, param={"mode": "${mode}"}))
print(result)
`;
  try {
    const result = await this.execPythonWithStdin(script, enriched);
    return { answer: result.trim(), sources: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'RAG query failed, returning fallback');
    return { answer: '', sources: [] };
  }
}
```

Add the shared stdin helper:

```typescript
private execPythonWithStdin(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      this.pythonBin,
      ['-c', script],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`Python error: ${stderr || err.message}`));
        resolve(stdout);
      },
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/rag/rag-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rag/rag-client.ts src/rag/rag-client.test.ts
git commit -m "security(rag): pass content via stdin instead of Python string interpolation"
```

---

## Task 5: Update RAG Indexer to Allowlist + New Metadata Prefix

**Files:**
- Modify: `src/rag/indexer.ts`
- Modify: `src/rag/indexer.test.ts`

- [ ] **Step 1: Write failing test for new indexer behavior**

In `src/rag/indexer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RagIndexer } from './indexer.js';
import { readFileSync } from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, readFileSync: vi.fn() };
});
vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn(),
  })),
}));

const mockReadFile = vi.mocked(readFileSync);

describe('RagIndexer allowlist and metadata prefix', () => {
  let indexer: RagIndexer;
  let mockRagClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRagClient = { index: vi.fn().mockResolvedValue(undefined) };
    indexer = new RagIndexer('/vault', mockRagClient);
  });

  it('indexes files in concepts/', async () => {
    mockReadFile.mockReturnValue(`---
title: Self-Attention
type: concept
topics: [deep-learning, transformers]
source_doc: "Vaswani et al. 2017"
verification_status: unverified
---

Content here.`);

    await indexer.indexFile('/vault/concepts/self-attention.md');

    expect(mockRagClient.index).toHaveBeenCalledOnce();
    const indexed = mockRagClient.index.mock.calls[0][0] as string;
    expect(indexed).toContain('[Title: Self-Attention | Type: concept | Topics: deep-learning, transformers | Source: Vaswani et al. 2017 | Verification: unverified]');
    expect(indexed).toContain('Source path: concepts/self-attention.md');
  });

  it('skips files in _nav/', async () => {
    await indexer.indexFile('/vault/_nav/index.md');
    expect(mockRagClient.index).not.toHaveBeenCalled();
  });

  it('skips files in drafts/', async () => {
    await indexer.indexFile('/vault/drafts/abc.md');
    expect(mockRagClient.index).not.toHaveBeenCalled();
  });

  it('indexes files in profile/archive/', async () => {
    mockReadFile.mockReturnValue(`---
title: Study Log January
type: profile
---

Archived content.`);

    await indexer.indexFile('/vault/profile/archive/study-log-2026-01.md');
    expect(mockRagClient.index).toHaveBeenCalledOnce();
  });

  it('skips profile files outside archive/', async () => {
    await indexer.indexFile('/vault/profile/student-profile.md');
    expect(mockRagClient.index).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/rag/indexer.test.ts`
Expected: FAIL — current indexer uses blocklist, different metadata prefix

- [ ] **Step 3: Rewrite indexer**

Replace `src/rag/indexer.ts`:

```typescript
import { watch, type FSWatcher } from 'chokidar';
import { readFileSync } from 'fs';
import { relative, resolve } from 'path';
import { logger } from '../logger.js';
import type { RagClient } from './rag-client.js';
import { parseFrontmatter } from '../vault/frontmatter.js';

/** Paths relative to vaultDir that should be indexed. */
const ALLOWED_PATHS = ['concepts', 'sources', 'profile/archive'];

export class RagIndexer {
  private vaultDir: string;
  private ragClient: RagClient;
  private watcher: FSWatcher | null = null;

  constructor(vaultDir: string, ragClient: RagClient) {
    this.vaultDir = resolve(vaultDir);
    this.ragClient = ragClient;
  }

  start(): void {
    const watchPaths = ALLOWED_PATHS.map((p) => resolve(this.vaultDir, p));
    this.watcher = watch(watchPaths, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500 },
      ignored: [/(^|[/\\])\./],
    });
    this.watcher.on('add', (fp) => this.indexFile(fp).catch(() => {}));
    this.watcher.on('change', (fp) => this.indexFile(fp).catch(() => {}));
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  async indexFile(filePath: string): Promise<void> {
    if (!filePath.endsWith('.md')) return;

    const relPath = relative(this.vaultDir, filePath);

    // Allowlist check: must be under one of ALLOWED_PATHS
    const isAllowed = ALLOWED_PATHS.some((p) => relPath.startsWith(p + '/') || relPath.startsWith(p + '\\'));
    if (!isAllowed) return;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const { data: fm, content: body } = parseFrontmatter(content);
    if (fm.status === 'draft') return;

    const title = fm.title || relPath;
    const type = fm.type || 'unknown';
    const topics = Array.isArray(fm.topics) ? fm.topics.join(', ') : '';
    const sourceDoc = fm.source_doc || '';
    const verification = fm.verification_status || 'unverified';

    const parts = [`Title: ${title}`, `Type: ${type}`];
    if (topics) parts.push(`Topics: ${topics}`);
    if (sourceDoc) parts.push(`Source: ${sourceDoc}`);
    parts.push(`Verification: ${verification}`);

    const prefix = `[${parts.join(' | ')}]`;
    const indexed = `${prefix}\nSource path: ${relPath}\n\n${body}`;

    try {
      await this.ragClient.index(indexed);
    } catch (err) {
      logger.warn({ err, relPath }, 'Failed to index file');
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/rag/indexer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rag/indexer.ts src/rag/indexer.test.ts
git commit -m "feat(rag): switch indexer to allowlist, new metadata prefix format"
```

---

## Task 6: Enhance Docling Extraction with Location Markers

**Files:**
- Modify: `scripts/docling-extract.py`

- [ ] **Step 1: Update the extract function to emit location markers**

Replace the markdown export section in `scripts/docling-extract.py`:

```python
def extract(input_file: str, output_dir: str) -> dict:
    from docling.document_converter import DocumentConverter

    input_path = Path(input_file)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    figures_dir = output_path / "figures"
    figures_dir.mkdir(exist_ok=True)

    converter = DocumentConverter()
    result = converter.convert(str(input_path))
    doc = result.document

    # Export markdown with location markers
    markdown_parts = []
    for element, _level in doc.iterate_items():
        element_type = type(element).__name__

        # Extract page number if available
        page_num = None
        if hasattr(element, 'prov') and element.prov:
            for prov in element.prov:
                if hasattr(prov, 'page_no'):
                    page_num = prov.page_no
                    break

        # Build location marker
        marker_parts = []
        if page_num is not None:
            marker_parts.append(f"page:{page_num}")

        # Extract section label if available
        if hasattr(element, 'label'):
            marker_parts.append(f"label:{element.label}")

        marker = ""
        if marker_parts:
            marker = f"<!-- {' '.join(marker_parts)} -->\n"

        # Get text content
        text = ""
        if hasattr(element, 'text') and element.text:
            text = element.text
        elif hasattr(element, 'export_to_markdown'):
            try:
                text = element.export_to_markdown()
            except Exception:
                pass

        if not text:
            continue

        # Format based on element type
        if element_type in ("SectionHeaderItem",):
            level = getattr(element, 'level', 1)
            prefix = "#" * min(level + 1, 6)  # H2 minimum
            markdown_parts.append(f"{marker}{prefix} {text}\n")
        elif element_type in ("PictureItem", "FigureItem"):
            # Handled separately below
            pass
        elif element_type in ("TableItem",):
            # Convert tables to flat lists per spec
            markdown_parts.append(f"{marker}{text}\n")
        else:
            markdown_parts.append(f"{marker}{text}\n")

    markdown = "\n".join(markdown_parts)

    # Fallback: if iterate_items produced nothing, use export_to_markdown
    if not markdown.strip():
        markdown = doc.export_to_markdown()

    (output_path / "content.md").write_text(markdown, encoding="utf-8")

    # Save figures (unchanged from current)
    figure_filenames = []
    for idx, (element, _level) in enumerate(doc.iterate_items()):
        element_type = type(element).__name__
        if element_type in ("PictureItem", "FigureItem"):
            for img_idx, image in enumerate(getattr(element, "images", []) or []):
                try:
                    ext = "png"
                    fname = f"figure_{idx}_{img_idx}.{ext}"
                    fpath = figures_dir / fname
                    if hasattr(image, "save"):
                        image.save(str(fpath))
                    elif hasattr(image, "pil_image") and image.pil_image is not None:
                        image.pil_image.save(str(fpath))
                    else:
                        continue
                    figure_filenames.append(fname)
                except Exception:
                    pass

    # Count pages
    pages = None
    try:
        pages = len(doc.pages) if doc.pages else None
    except Exception:
        pass

    # Detect format from extension
    suffix = input_path.suffix.lower().lstrip(".")
    format_map = {
        "pdf": "PDF",
        "pptx": "PPTX",
        "ppt": "PPT",
        "docx": "DOCX",
        "doc": "DOC",
        "png": "PNG",
        "jpg": "JPEG",
        "jpeg": "JPEG",
        "tiff": "TIFF",
        "bmp": "BMP",
        "md": "Markdown",
        "txt": "Text",
        "html": "HTML",
        "htm": "HTML",
    }
    doc_format = format_map.get(suffix, suffix.upper())

    metadata = {
        "source": str(input_path.resolve()),
        "pages": pages,
        "figures": figure_filenames,
        "format": doc_format,
    }
    (output_path / "metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )

    # Convert DOCX/PPTX to PDF for preview (non-fatal)
    if suffix in ("docx", "pptx", "doc", "ppt"):
        try:
            import subprocess

            result_pdf = subprocess.run(
                [
                    "soffice",
                    "--headless",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(output_path),
                    str(input_path.resolve()),
                ],
                capture_output=True,
                timeout=120,
            )
            if result_pdf.returncode == 0:
                generated = output_path / (input_path.stem + ".pdf")
                if generated.exists():
                    generated.rename(output_path / "preview.pdf")
        except Exception:
            pass

    return {"status": "ok", "outputDir": str(output_path.resolve())}
```

- [ ] **Step 2: Test manually with a sample PDF**

```bash
.venv/bin/python3 scripts/docling-extract.py /path/to/sample.pdf /tmp/test-extract
cat /tmp/test-extract/content.md | head -50
```

Expected: Markdown with `<!-- page:N label:... -->` markers before paragraphs.

- [ ] **Step 3: Commit**

```bash
git add scripts/docling-extract.py
git commit -m "feat(docling): emit page/section location markers via iterate_items()"
```

---

## Task 7: Manifest and Promoter Modules

**Files:**
- Create: `src/ingestion/manifest.ts`
- Create: `src/ingestion/manifest.test.ts`
- Create: `src/ingestion/promoter.ts`
- Create: `src/ingestion/promoter.test.ts`

- [ ] **Step 1: Write failing tests for manifest**

`src/ingestion/manifest.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { readManifest, inferManifest, type NoteManifest } from './manifest.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/manifest');

describe('manifest', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  describe('readManifest', () => {
    it('reads a valid manifest file', () => {
      const manifest: NoteManifest = {
        source_note: 'job1-source.md',
        concept_notes: ['job1-concept-001.md', 'job1-concept-002.md'],
      };
      writeFileSync(join(TMP, 'job1-manifest.json'), JSON.stringify(manifest));

      const result = readManifest(TMP, 'job1');
      expect(result).toEqual(manifest);
    });

    it('returns null if manifest does not exist', () => {
      const result = readManifest(TMP, 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('inferManifest', () => {
    it('infers manifest from draft files when no manifest exists', () => {
      writeFileSync(join(TMP, 'job1-source.md'), '---\ntype: source\n---\nContent');
      writeFileSync(join(TMP, 'job1-concept-001.md'), '---\ntype: concept\n---\nContent');
      writeFileSync(join(TMP, 'job1-concept-002.md'), '---\ntype: concept\n---\nContent');
      writeFileSync(join(TMP, 'other-file.md'), 'Not related');

      const result = inferManifest(TMP, 'job1');
      expect(result.source_note).toBe('job1-source.md');
      expect(result.concept_notes).toHaveLength(2);
      expect(result.concept_notes).toContain('job1-concept-001.md');
      expect(result.concept_notes).toContain('job1-concept-002.md');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/ingestion/manifest.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement manifest module**

`src/ingestion/manifest.ts`:

```typescript
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../vault/frontmatter.js';

export interface NoteManifest {
  source_note: string;
  concept_notes: string[];
}

export function readManifest(
  draftsDir: string,
  jobId: string,
): NoteManifest | null {
  const manifestPath = join(draftsDir, `${jobId}-manifest.json`);
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as NoteManifest;
  } catch {
    return null;
  }
}

export function inferManifest(
  draftsDir: string,
  jobId: string,
): NoteManifest {
  const files = readdirSync(draftsDir).filter(
    (f) => f.startsWith(`${jobId}-`) && f.endsWith('.md'),
  );

  let sourceNote = '';
  const conceptNotes: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(draftsDir, file), 'utf-8');
    const { data: fm } = parseFrontmatter(content);
    if (fm.type === 'source') {
      sourceNote = file;
    } else {
      conceptNotes.push(file);
    }
  }

  return { source_note: sourceNote, concept_notes: conceptNotes };
}
```

- [ ] **Step 4: Run manifest tests**

Run: `npm test -- --run src/ingestion/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for promoter**

`src/ingestion/promoter.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { promoteNote } from './promoter.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/promoter');
const VAULT = join(TMP, 'vault');

describe('promoteNote', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(VAULT, 'concepts'), { recursive: true });
    mkdirSync(join(VAULT, 'sources'), { recursive: true });
    mkdirSync(join(VAULT, 'drafts'), { recursive: true });
  });

  it('promotes a concept note to concepts/ with kebab-case name', () => {
    const draftPath = join(VAULT, 'drafts', 'job1-concept-001.md');
    writeFileSync(draftPath, '---\ntitle: Self-Attention Mechanism\ntype: concept\n---\nContent');

    const result = promoteNote(draftPath, VAULT, 'job1');

    expect(result).toBe('concepts/self-attention-mechanism.md');
    expect(existsSync(join(VAULT, 'concepts', 'self-attention-mechanism.md'))).toBe(true);
    expect(existsSync(draftPath)).toBe(false);
  });

  it('promotes a source note to sources/', () => {
    const draftPath = join(VAULT, 'drafts', 'job1-source.md');
    writeFileSync(draftPath, '---\ntitle: "Attention Is All You Need (Vaswani 2017)"\ntype: source\n---\nContent');

    const result = promoteNote(draftPath, VAULT, 'job1');

    expect(result).toBe('sources/attention-is-all-you-need-vaswani-2017.md');
    expect(existsSync(join(VAULT, 'sources', 'attention-is-all-you-need-vaswani-2017.md'))).toBe(true);
  });

  it('appends hash suffix on filename collision', () => {
    writeFileSync(join(VAULT, 'concepts', 'gradient-descent.md'), 'existing');
    const draftPath = join(VAULT, 'drafts', 'job2-concept-001.md');
    writeFileSync(draftPath, '---\ntitle: Gradient Descent\ntype: concept\n---\nNew content');

    const result = promoteNote(draftPath, VAULT, 'job2');

    expect(result).toMatch(/^concepts\/gradient-descent-[a-f0-9]{4}\.md$/);
    expect(existsSync(join(VAULT, result))).toBe(true);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- --run src/ingestion/promoter.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 7: Implement promoter module**

`src/ingestion/promoter.ts`:

```typescript
import { readFileSync, renameSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { parseFrontmatter } from '../vault/frontmatter.js';

function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[()[\]{}'"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function promoteNote(
  draftPath: string,
  vaultDir: string,
  jobId: string,
): string {
  const content = readFileSync(draftPath, 'utf-8');
  const { data: fm } = parseFrontmatter(content);

  const type = fm.type as string;
  const title = fm.title as string;
  const destFolder = type === 'source' ? 'sources' : 'concepts';
  const slug = toKebabCase(title);

  let filename = `${slug}.md`;
  let destPath = join(vaultDir, destFolder, filename);

  // Handle collision
  if (existsSync(destPath)) {
    const hash = jobId.slice(0, 4);
    filename = `${slug}-${hash}.md`;
    destPath = join(vaultDir, destFolder, filename);
  }

  renameSync(draftPath, destPath);
  return `${destFolder}/${filename}`;
}
```

- [ ] **Step 8: Run promoter tests**

Run: `npm test -- --run src/ingestion/promoter.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/ingestion/manifest.ts src/ingestion/manifest.test.ts src/ingestion/promoter.ts src/ingestion/promoter.test.ts
git commit -m "feat(ingestion): add manifest reader and note promoter modules"
```

---

## Task 8: Sentinel File Polling Module

**Files:**
- Create: `src/ingestion/sentinel.ts`
- Create: `src/ingestion/sentinel.test.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Add config constant**

In `src/config.ts`, add:

```typescript
export const SENTINEL_TIMEOUT = Number(
  process.env.SENTINEL_TIMEOUT ?? 10 * 60 * 1000, // 10 minutes
);
export const PROCESSED_DIR = path.resolve(UPLOAD_DIR, 'processed');
```

- [ ] **Step 2: Write failing test for sentinel polling**

`src/ingestion/sentinel.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { waitForSentinel } from './sentinel.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/sentinel');

describe('waitForSentinel', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  it('resolves true when sentinel file appears', async () => {
    const sentinelPath = join(TMP, 'job1-complete');

    // Write sentinel after 100ms
    setTimeout(() => writeFileSync(sentinelPath, ''), 100);

    const result = await waitForSentinel(sentinelPath, 5000, 50);
    expect(result).toBe(true);
  });

  it('resolves false on timeout', async () => {
    const sentinelPath = join(TMP, 'nonexistent-complete');

    const result = await waitForSentinel(sentinelPath, 200, 50);
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- --run src/ingestion/sentinel.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 4: Implement sentinel module**

`src/ingestion/sentinel.ts`:

```typescript
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger.js';

/**
 * Polls for a sentinel file. Returns true if found, false on timeout.
 */
export async function waitForSentinel(
  sentinelPath: string,
  timeoutMs: number,
  pollIntervalMs = 1000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(sentinelPath)) return true;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return false;
}

/**
 * Writes the IPC _close sentinel to signal the container to exit.
 */
export function sendIpcClose(ipcNamespace: string, dataDir: string): void {
  const closePath = join(dataDir, 'ipc', 'ingestion', ipcNamespace, 'input', '_close');
  try {
    writeFileSync(closePath, '', { flag: 'w' });
    logger.info({ ipcNamespace }, 'Sent IPC close sentinel');
  } catch (err) {
    logger.warn({ ipcNamespace, err }, 'Failed to send IPC close sentinel');
  }
}

/**
 * Cleans up sentinel and manifest files after promotion.
 */
export function cleanupSentinel(
  draftsDir: string,
  jobId: string,
): void {
  const files = [
    join(draftsDir, `${jobId}-complete`),
    join(draftsDir, `${jobId}-manifest.json`),
  ];
  for (const f of files) {
    try {
      unlinkSync(f);
    } catch {
      // Already deleted or never existed
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --run src/ingestion/sentinel.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ingestion/sentinel.ts src/ingestion/sentinel.test.ts src/config.ts
git commit -m "feat(ingestion): add sentinel polling and IPC close signaling"
```

---

## Task 9: Rewrite Agent Processor (Cite-Then-Generate, Multi-Note)

**Files:**
- Modify: `src/ingestion/agent-processor.ts`
- Modify: `src/ingestion/agent-processor.test.ts`

- [ ] **Step 1: Write failing test for new prompt**

`src/ingestion/agent-processor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AgentProcessor } from './agent-processor.js';

describe('AgentProcessor prompt', () => {
  const processor = new AgentProcessor({
    vaultDir: '/vault',
    uploadDir: '/upload',
  });

  it('builds a cite-then-generate prompt with manifest instructions', () => {
    const prompt = processor.buildPrompt(
      'Extracted content here <!-- page:4 label:section_header -->',
      'paper.pdf',
      'job-123',
      ['figure_0_0.png'],
    );

    expect(prompt).toContain('cite-then-generate');
    expect(prompt).toContain('manifest');
    expect(prompt).toContain('job-123-manifest.json');
    expect(prompt).toContain('job-123-complete');
    expect(prompt).toContain('source overview note');
    expect(prompt).toContain('atomic concept notes');
    expect(prompt).not.toContain('_targetPath');
    expect(prompt).not.toContain('courses/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/ingestion/agent-processor.test.ts`
Expected: FAIL — `buildPrompt` has wrong signature and old prompt content

- [ ] **Step 3: Rewrite agent-processor.ts**

```typescript
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { runContainerAgent } from '../container-runner.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

export interface AgentProcessorOpts {
  vaultDir: string;
  uploadDir: string;
}

export class AgentProcessor {
  private vaultDir: string;
  private uploadDir: string;

  constructor(opts: AgentProcessorOpts) {
    this.vaultDir = opts.vaultDir;
    this.uploadDir = opts.uploadDir;
  }

  buildPrompt(
    extractedContent: string,
    fileName: string,
    jobId: string,
    figures: string[],
  ): string {
    const draftsPath = `/workspace/extra/vault/drafts`;

    const figuresSection =
      figures.length > 0
        ? `\n## Figures\n\nThe following figures were extracted from the document:\n${figures.map((f) => `- ${f}`).join('\n')}\n\nReference these figures in your notes with descriptive captions.`
        : '';

    return `Process this pre-extracted document and generate structured atomic notes.

## Source Document

Original filename: ${fileName}
Docling has already extracted the content — do NOT attempt to read the original file.
The content includes location markers like <!-- page:N label:TYPE --> before paragraphs.
Use these markers to produce precise citations in your notes.

## Extracted Content

${extractedContent}
${figuresSection}

## Your Task

Generate TWO types of notes from this document:

### 1. Source Overview Note
One note summarizing the document's argument, key contributions, and limitations.
- Filename: ${draftsPath}/${jobId}-source.md
- Frontmatter must include: title, type: source, source_type (paper|lecture|textbook-chapter|article|news), source_file, authors (if available), published (year if available), concepts_generated (slugified titles of concept notes), verification_status: unverified, created (today's date)

### 2. Atomic Concept Notes
One note per distinct concept, ~200-500 words each.
- Filename pattern: ${draftsPath}/${jobId}-concept-NNN.md (e.g., ${jobId}-concept-001.md)
- Frontmatter must include: title, type: concept, topics (array), source_doc, source_file, source_pages (array of page numbers), source_sections (array), generated_by: claude, verification_status: unverified, created (today's date)

### source_file Value
Use this path for all notes: upload/processed/${jobId}-${fileName}

## Citation Rules (cite-then-generate)

For each claim you write, you MUST:
1. First identify the specific passage in the source that supports it
   (quote the relevant text internally in <internal> tags)
2. Note the exact location (page number from <!-- page:N --> markers, section, paragraph)
3. Only then write the claim with its footnote citation

Do NOT write a claim first and then search for a citation to attach.
Do NOT make any factual statement without a supporting source passage.
If you cannot ground a claim in a specific passage, flag it as inference:
  "The scaling factor likely prevents gradient issues [inference, not stated in source]"

Use markdown footnotes: [^1], [^2], etc. with references at the bottom:
[^1]: Author, §Section, p.Page ¶Paragraph

## Cross-References

Mention related concepts in prose with [[wikilinks]]:
"Self-attention is the core building block of [[multi-head-attention]]..."

The concepts_generated field in the source note should list slugified titles
matching the concept note titles (e.g., "Self-Attention Mechanism" → self-attention-mechanism).

## Manifest

After writing ALL notes, create a manifest file at:
${draftsPath}/${jobId}-manifest.json

Format:
{
  "source_note": "${jobId}-source.md",
  "concept_notes": ["${jobId}-concept-001.md", "${jobId}-concept-002.md", ...]
}

## Self-Review

After generating all notes, review your own work:
1. Re-read each note you wrote
2. Check: does every claim have a grounded citation? Flag any that don't.
3. Check: are there important concepts from the source that you missed? Add them.
4. Check: are any notes too long (>500 words) or too short (<100 words)? Split or merge.
5. Check: do [[wikilinks]] point to notes you actually created? Fix broken links.
6. Update the manifest if you added or removed notes.
7. Write an empty file to ${draftsPath}/${jobId}-complete to signal you are finished.`;
  }

  async process(
    extractionPath: string,
    fileName: string,
    jobId: string,
    reviewAgentGroup: RegisteredGroup,
  ): Promise<{ status: 'success' | 'error'; error?: string }> {
    const contentFile = join(extractionPath, 'content.md');
    let extractedContent: string;
    try {
      extractedContent = readFileSync(contentFile, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'error',
        error: `Failed to read extraction content: ${message}`,
      };
    }

    const figuresDir = join(extractionPath, 'figures');
    let figures: string[] = [];
    if (existsSync(figuresDir)) {
      try {
        figures = readdirSync(figuresDir).filter((f) =>
          /\.(png|jpg|jpeg|svg|webp)$/i.test(f),
        );
      } catch {
        // Non-fatal
      }
    }

    const prompt = this.buildPrompt(extractedContent, fileName, jobId, figures);

    logger.info(
      { fileName, jobId, figures: figures.length },
      'Starting agent processing',
    );

    try {
      const output = await runContainerAgent(
        reviewAgentGroup,
        {
          prompt,
          groupFolder: reviewAgentGroup.folder,
          chatJid: `ingestion:${jobId}`,
          isMain: false,
          ipcNamespace: jobId,
          singleTurn: false,
        },
        (_proc, _containerName) => {
          // No queue registration needed for ingestion containers
        },
      );

      if (output.status === 'error') {
        logger.error(
          { fileName, jobId, error: output.error },
          'Agent processing failed',
        );
        return { status: 'error', error: output.error };
      }

      logger.info({ fileName, jobId }, 'Agent processing completed');
      return { status: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ fileName, jobId, err }, 'Agent processing error');
      return { status: 'error', error: message };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/ingestion/agent-processor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/agent-processor.ts src/ingestion/agent-processor.test.ts
git commit -m "feat(ingestion): rewrite agent prompt for cite-then-generate, multi-note, self-review"
```

---

## Task 10: Rewrite Pipeline Orchestration

**Files:**
- Modify: `src/ingestion/index.ts`
- Modify: `src/ingestion/pipeline.ts`
- Modify: `src/ingestion/pipeline.test.ts`
- Modify: `src/ingestion/file-watcher.ts`
- Modify: `src/ingestion/job-recovery.ts`
- Modify: `src/ingestion/job-recovery.test.ts`

This is the largest task — it rewires the entire pipeline. Breaking it into sub-steps.

- [ ] **Step 1: Update file-watcher.ts ignore pattern**

In `src/ingestion/file-watcher.ts`, change the ignored regex:

```typescript
// Old:
ignored: [/\.ds_store|thumbs\.db|\.gitkeep/i, /[\\/]\.processed[\\/]/],
// New:
ignored: [/\.ds_store|thumbs\.db|\.gitkeep/i, /[\\/]processed[\\/]/],
```

- [ ] **Step 2: Simplify pipeline drainer**

Rewrite `src/ingestion/pipeline.ts` — remove tier branching:

```typescript
import { getJobsByStatus, updateIngestionJob } from '../db.js';
import { logger } from '../logger.js';

export interface JobRow {
  id: string;
  source_path: string;
  source_filename: string;
  status: string;
  extraction_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineDrainerOpts {
  onExtract: (job: JobRow) => Promise<void>;
  onGenerate: (job: JobRow) => Promise<void>;
  maxExtractionConcurrent?: number;
  maxGenerationConcurrent?: number;
  pollIntervalMs?: number;
}

export class PipelineDrainer {
  private opts: Required<PipelineDrainerOpts>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private activeExtractions = 0;
  private activeGenerations = 0;

  constructor(opts: PipelineDrainerOpts) {
    this.opts = {
      maxExtractionConcurrent: 3,
      maxGenerationConcurrent: 3,
      pollIntervalMs: 5000,
      ...opts,
    };
  }

  drain(): void {
    this.interval = setInterval(() => this.tick(), this.opts.pollIntervalMs);
    this.tick();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private tick(): void {
    this.drainExtractions();
    this.drainGenerations();
  }

  private drainExtractions(): void {
    const pending = getJobsByStatus('pending') as JobRow[];
    const slots = this.opts.maxExtractionConcurrent - this.activeExtractions;
    const batch = pending.slice(0, Math.max(0, slots));

    for (const job of batch) {
      this.activeExtractions++;
      this.opts
        .onExtract(job)
        .catch((err) => {
          logger.error({ jobId: job.id, err }, 'Extraction failed');
          updateIngestionJob(job.id, { status: 'failed', error: String(err) });
        })
        .finally(() => {
          this.activeExtractions--;
        });
    }
  }

  private drainGenerations(): void {
    const extracted = getJobsByStatus('extracted') as JobRow[];
    const slots = this.opts.maxGenerationConcurrent - this.activeGenerations;
    const batch = extracted.slice(0, Math.max(0, slots));

    for (const job of batch) {
      this.activeGenerations++;
      this.opts
        .onGenerate(job)
        .catch((err) => {
          logger.error({ jobId: job.id, err }, 'Generation failed');
          updateIngestionJob(job.id, { status: 'failed', error: String(err) });
        })
        .finally(() => {
          this.activeGenerations--;
        });
    }
  }
}
```

- [ ] **Step 3: Rewrite pipeline orchestrator**

Rewrite `src/ingestion/index.ts`:

```typescript
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { join, relative, basename } from 'path';

import {
  createIngestionJob,
  getIngestionJobByPath,
  updateIngestionJob,
} from '../db.js';
import {
  VAULT_DIR,
  UPLOAD_DIR,
  EXTRACTIONS_DIR,
  SENTINEL_TIMEOUT,
  PROCESSED_DIR,
} from '../config.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

import { FileWatcher } from './file-watcher.js';
import { PipelineDrainer, type JobRow } from './pipeline.js';
import { Extractor } from './extractor.js';
import { AgentProcessor } from './agent-processor.js';
import { readManifest, inferManifest } from './manifest.js';
import { promoteNote } from './promoter.js';
import { waitForSentinel, sendIpcClose, cleanupSentinel } from './sentinel.js';
import { recoverStaleJobs } from './job-recovery.js';

export interface IngestionPipelineOpts {
  vaultDir?: string;
  uploadDir?: string;
  reviewAgentGroup: RegisteredGroup;
  maxGenerationConcurrent?: number;
}

export class IngestionPipeline {
  private vaultDir: string;
  private uploadDir: string;
  private reviewAgentGroup: RegisteredGroup;
  private watcher: FileWatcher;
  private drainer: PipelineDrainer;
  private extractor: Extractor;
  private agentProcessor: AgentProcessor;

  constructor(opts: IngestionPipelineOpts) {
    this.vaultDir = opts.vaultDir ?? VAULT_DIR;
    this.uploadDir = opts.uploadDir ?? UPLOAD_DIR;
    this.reviewAgentGroup = opts.reviewAgentGroup;

    this.extractor = new Extractor();
    this.agentProcessor = new AgentProcessor({
      vaultDir: this.vaultDir,
      uploadDir: this.uploadDir,
    });

    this.watcher = new FileWatcher(this.uploadDir, (filePath) =>
      this.enqueue(filePath),
    );

    this.drainer = new PipelineDrainer({
      onExtract: (job) => this.handleExtraction(job),
      onGenerate: (job) => this.handleGeneration(job),
      maxGenerationConcurrent: opts.maxGenerationConcurrent ?? 3,
    });
  }

  start(): void {
    mkdirSync(PROCESSED_DIR, { recursive: true });
    recoverStaleJobs({ extractionsDir: EXTRACTIONS_DIR });
    this.watcher.start();
    this.drainer.drain();
    logger.info('Ingestion pipeline started');
  }

  stop(): void {
    this.watcher.stop();
    this.drainer.stop();
  }

  private async enqueue(filePath: string): Promise<void> {
    const relPath = relative(this.uploadDir, filePath);
    const existing = getIngestionJobByPath(filePath);
    if (existing && existing.status !== 'failed') return;

    const jobId = randomUUID();
    const fileName = basename(filePath);
    createIngestionJob(jobId, filePath, fileName);
    logger.info({ jobId, relPath }, 'Enqueued ingestion job');
  }

  private async handleExtraction(job: JobRow): Promise<void> {
    updateIngestionJob(job.id, { status: 'extracting' });

    const result = await this.extractor.extract(job.id, job.source_path);
    updateIngestionJob(job.id, {
      status: 'extracted',
      extraction_path: result.contentPath,
    });
    logger.info({ jobId: job.id }, 'Extraction complete');
  }

  private async handleGeneration(job: JobRow): Promise<void> {
    updateIngestionJob(job.id, { status: 'generating' });

    const extractionDir = this.extractor.getExtractionDir(job.id);
    const result = await this.agentProcessor.process(
      extractionDir,
      job.source_filename,
      job.id,
      this.reviewAgentGroup,
    );

    if (result.status === 'error') {
      updateIngestionJob(job.id, {
        status: 'failed',
        error: result.error,
      });
      return;
    }

    // Wait for sentinel (agent signals completion) or timeout
    const draftsDir = join(this.vaultDir, 'drafts');
    const sentinelPath = join(draftsDir, `${job.id}-complete`);
    const found = await waitForSentinel(sentinelPath, SENTINEL_TIMEOUT);

    if (!found) {
      logger.warn({ jobId: job.id }, 'Sentinel timeout — promoting available notes');
      sendIpcClose(job.id, join(process.cwd(), 'data'));
    }

    // Read or infer manifest
    const manifest = readManifest(draftsDir, job.id) ?? inferManifest(draftsDir, job.id);

    const allNotes = [manifest.source_note, ...manifest.concept_notes].filter(Boolean);

    if (allNotes.length === 0) {
      updateIngestionJob(job.id, {
        status: 'failed',
        error: 'No notes generated',
      });
      return;
    }

    // Promote each note
    for (const noteFile of allNotes) {
      const draftPath = join(draftsDir, noteFile);
      if (!existsSync(draftPath)) {
        logger.warn({ jobId: job.id, noteFile }, 'Draft file missing, skipping');
        continue;
      }
      try {
        const destPath = promoteNote(draftPath, this.vaultDir, job.id);
        logger.info({ jobId: job.id, destPath }, 'Note promoted');
      } catch (err) {
        logger.error({ jobId: job.id, noteFile, err }, 'Failed to promote note');
      }
    }

    // Cleanup
    cleanupSentinel(draftsDir, job.id);
    await this.extractor.cleanup(job.id);
    this.moveToProcessed(job);
    this.pruneEmptyDirs(join(this.uploadDir, relative(this.uploadDir, job.source_path)));

    updateIngestionJob(job.id, { status: 'completed' });
    logger.info({ jobId: job.id }, 'Ingestion job completed');
  }

  private moveToProcessed(job: JobRow): void {
    const destPath = join(PROCESSED_DIR, `${job.id}-${job.source_filename}`);
    try {
      renameSync(job.source_path, destPath);
    } catch (err) {
      logger.warn({ jobId: job.id, err }, 'Failed to move source to processed');
    }
  }

  private pruneEmptyDirs(filePath: string): void {
    const { readdirSync, rmdirSync } = require('fs');
    const { dirname } = require('path');
    let dir = dirname(filePath);
    while (dir !== this.uploadDir && dir.startsWith(this.uploadDir)) {
      try {
        const entries = readdirSync(dir).filter(
          (e: string) => e !== '.DS_Store',
        );
        if (entries.length > 0) break;
        rmdirSync(dir);
        dir = dirname(dir);
      } catch {
        break;
      }
    }
  }
}
```

- [ ] **Step 4: Update job-recovery.ts — remove tier references**

```typescript
import { getStaleJobs, updateIngestionJob } from '../db.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger.js';

interface RecoveryOpts {
  extractionsDir: string;
  extractingThresholdMin?: number;
  generatingThresholdMin?: number;
}

export function recoverStaleJobs(opts: RecoveryOpts): {
  recovered: number;
  failed: number;
} {
  const extractingThreshold = opts.extractingThresholdMin ?? 15;
  const generatingThreshold = opts.generatingThresholdMin ?? 60;

  let recovered = 0;
  let failed = 0;

  const staleExtracting = getStaleJobs('extracting', extractingThreshold);
  for (const job of staleExtracting as any[]) {
    logger.warn({ jobId: job.id }, 'Recovering stale extracting job');
    updateIngestionJob(job.id, { status: 'pending' });
    recovered++;
  }

  const staleGenerating = getStaleJobs('generating', generatingThreshold);
  for (const job of staleGenerating as any[]) {
    const extractionDir = join(opts.extractionsDir, job.id);
    if (existsSync(join(extractionDir, 'content.md'))) {
      logger.warn({ jobId: job.id }, 'Recovering stale generating job to extracted');
      updateIngestionJob(job.id, { status: 'extracted' });
      recovered++;
    } else {
      logger.warn({ jobId: job.id }, 'Recovering stale generating job to pending');
      updateIngestionJob(job.id, { status: 'pending' });
      recovered++;
    }
  }

  return { recovered, failed };
}
```

- [ ] **Step 5: Write pipeline integration test**

`src/ingestion/pipeline.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _initTestDatabase, createIngestionJob, getIngestionJobs, updateIngestionJob } from '../db.js';
import { PipelineDrainer, type JobRow } from './pipeline.js';

describe('PipelineDrainer', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.useFakeTimers();
  });

  it('picks up pending jobs for extraction', async () => {
    createIngestionJob('job-1', '/upload/paper.pdf', 'paper.pdf');

    const onExtract = vi.fn().mockResolvedValue(undefined);
    const onGenerate = vi.fn().mockResolvedValue(undefined);

    const drainer = new PipelineDrainer({
      onExtract,
      onGenerate,
      pollIntervalMs: 100,
    });

    drainer.drain();
    await vi.advanceTimersByTimeAsync(150);
    drainer.stop();

    expect(onExtract).toHaveBeenCalledOnce();
    expect(onExtract.mock.calls[0][0]).toMatchObject({
      id: 'job-1',
      source_filename: 'paper.pdf',
    });
  });

  it('picks up extracted jobs for generation', async () => {
    createIngestionJob('job-2', '/upload/paper2.pdf', 'paper2.pdf');
    updateIngestionJob('job-2', { status: 'extracted' });

    const onExtract = vi.fn().mockResolvedValue(undefined);
    const onGenerate = vi.fn().mockResolvedValue(undefined);

    const drainer = new PipelineDrainer({
      onExtract,
      onGenerate,
      pollIntervalMs: 100,
    });

    drainer.drain();
    await vi.advanceTimersByTimeAsync(150);
    drainer.stop();

    expect(onGenerate).toHaveBeenCalledOnce();
  });

  it('respects concurrency limits', async () => {
    createIngestionJob('job-a', '/a.pdf', 'a.pdf');
    createIngestionJob('job-b', '/b.pdf', 'b.pdf');
    createIngestionJob('job-c', '/c.pdf', 'c.pdf');
    createIngestionJob('job-d', '/d.pdf', 'd.pdf');

    const inFlight: string[] = [];
    const onExtract = vi.fn().mockImplementation(async (job: JobRow) => {
      inFlight.push(job.id);
      expect(inFlight.length).toBeLessThanOrEqual(2);
      await new Promise((r) => setTimeout(r, 500));
      inFlight.splice(inFlight.indexOf(job.id), 1);
    });

    const drainer = new PipelineDrainer({
      onExtract,
      onGenerate: vi.fn().mockResolvedValue(undefined),
      maxExtractionConcurrent: 2,
      pollIntervalMs: 100,
    });

    drainer.drain();
    await vi.advanceTimersByTimeAsync(1500);
    drainer.stop();
  });
});
```

- [ ] **Step 6: Run all tests**

Run: `npm test -- --run src/ingestion/pipeline.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/ingestion/index.ts src/ingestion/pipeline.ts src/ingestion/pipeline.test.ts src/ingestion/file-watcher.ts src/ingestion/job-recovery.ts
git commit -m "feat(ingestion): rewrite pipeline for multi-note, sentinel-based, auto-promotion"
```

---

## Task 11: Lazy Verification System

**Files:**
- Create: `src/ingestion/verifier.ts`
- Create: `src/ingestion/verifier.test.ts`

- [ ] **Step 1: Write failing test**

`src/ingestion/verifier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { collectUnverifiedNotes, updateVerificationStatus, type VerificationResult } from './verifier.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/verifier');
const VAULT = join(TMP, 'vault');

describe('verifier', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(VAULT, 'concepts'), { recursive: true });
  });

  describe('collectUnverifiedNotes', () => {
    it('returns notes with unverified status from a list of paths', () => {
      writeFileSync(
        join(VAULT, 'concepts', 'note-a.md'),
        '---\ntitle: A\nverification_status: unverified\n---\nContent',
      );
      writeFileSync(
        join(VAULT, 'concepts', 'note-b.md'),
        '---\ntitle: B\nverification_status: agent-verified\n---\nContent',
      );
      writeFileSync(
        join(VAULT, 'concepts', 'note-c.md'),
        '---\ntitle: C\nverification_status: unverified\n---\nContent',
      );

      const sourcePaths = [
        'concepts/note-a.md',
        'concepts/note-b.md',
        'concepts/note-c.md',
      ];

      const result = collectUnverifiedNotes(VAULT, sourcePaths);
      expect(result).toHaveLength(2);
      expect(result.map((n) => n.relPath)).toEqual([
        'concepts/note-a.md',
        'concepts/note-c.md',
      ]);
    });

    it('caps at maxBatch', () => {
      for (let i = 0; i < 15; i++) {
        writeFileSync(
          join(VAULT, 'concepts', `note-${i}.md`),
          `---\ntitle: Note ${i}\nverification_status: unverified\n---\nContent`,
        );
      }

      const paths = Array.from({ length: 15 }, (_, i) => `concepts/note-${i}.md`);
      const result = collectUnverifiedNotes(VAULT, paths, 10);
      expect(result).toHaveLength(10);
    });
  });

  describe('updateVerificationStatus', () => {
    it('updates frontmatter verification_status and verified_at', () => {
      const notePath = join(VAULT, 'concepts', 'note-x.md');
      writeFileSync(
        notePath,
        '---\ntitle: X\nverification_status: unverified\nverified_at: null\n---\nContent',
      );

      updateVerificationStatus(notePath, 'agent-verified');

      const updated = readFileSync(notePath, 'utf-8');
      expect(updated).toContain('verification_status: agent-verified');
      expect(updated).toContain('verified_at:');
      expect(updated).not.toContain('verified_at: null');
    });

    it('adds verification_issues when status stays unverified', () => {
      const notePath = join(VAULT, 'concepts', 'note-y.md');
      writeFileSync(
        notePath,
        '---\ntitle: Y\nverification_status: unverified\n---\nContent',
      );

      updateVerificationStatus(notePath, 'unverified', [
        'Claim on line 5 unsupported by cited passage',
      ]);

      const updated = readFileSync(notePath, 'utf-8');
      expect(updated).toContain('verification_issues');
      expect(updated).toContain('unsupported by cited passage');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/ingestion/verifier.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement verifier**

`src/ingestion/verifier.ts`:

```typescript
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../vault/frontmatter.js';
import matter from 'gray-matter';

export interface UnverifiedNote {
  relPath: string;
  absPath: string;
  sourceFile: string | null;
}

export interface VerificationResult {
  relPath: string;
  status: 'agent-verified' | 'unverified';
  issues: string[];
}

/**
 * Collects notes with verification_status: unverified from a list of source paths.
 */
export function collectUnverifiedNotes(
  vaultDir: string,
  sourcePaths: string[],
  maxBatch = 10,
): UnverifiedNote[] {
  const unverified: UnverifiedNote[] = [];

  for (const relPath of sourcePaths) {
    if (unverified.length >= maxBatch) break;

    const absPath = join(vaultDir, relPath);
    try {
      const content = readFileSync(absPath, 'utf-8');
      const { data: fm } = parseFrontmatter(content);
      if (fm.verification_status === 'unverified') {
        unverified.push({
          relPath,
          absPath,
          sourceFile: (fm.source_file as string) || null,
        });
      }
    } catch {
      // File not found or unreadable — skip
    }
  }

  return unverified;
}

/**
 * Updates a note's verification_status and optionally adds issues.
 */
export function updateVerificationStatus(
  notePath: string,
  status: 'agent-verified' | 'human-verified' | 'unverified',
  issues?: string[],
): void {
  const content = readFileSync(notePath, 'utf-8');
  const parsed = matter(content);

  parsed.data.verification_status = status;

  if (status === 'agent-verified' || status === 'human-verified') {
    parsed.data.verified_at = new Date().toISOString().split('T')[0];
  }

  if (issues && issues.length > 0) {
    parsed.data.verification_issues = issues;
  }

  const updated = matter.stringify(parsed.content, parsed.data);
  writeFileSync(notePath, updated);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/ingestion/verifier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/verifier.ts src/ingestion/verifier.test.ts
git commit -m "feat(ingestion): add lazy verification system — collect unverified notes, update status"
```

---

## Task 12: Profile Rotation Job

**Files:**
- Create: `src/profile/rotation.ts`
- Create: `src/profile/rotation.test.ts`

- [ ] **Step 1: Write failing test**

`src/profile/rotation.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { rotateStudyLog } from './rotation.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/rotation');
const VAULT = join(TMP, 'vault');
const PROFILE = join(VAULT, 'profile');
const ARCHIVE = join(PROFILE, 'archive');

describe('rotateStudyLog', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(ARCHIVE, { recursive: true });
  });

  it('archives entries older than 30 days', () => {
    const oldDate = '2026-02-15';
    const recentDate = '2026-03-25';
    const logPath = join(PROFILE, 'study-log.md');

    writeFileSync(
      logPath,
      `---
title: Study Log
type: profile
created: 2026-03-01
---

## ${recentDate}
- Queried: transformers

## ${oldDate}
- Queried: sorting algorithms
- Quiz: data-structures (7/10)
`,
    );

    rotateStudyLog(PROFILE, new Date('2026-03-30'));

    const updated = readFileSync(logPath, 'utf-8');
    expect(updated).toContain(recentDate);
    expect(updated).not.toContain(oldDate);

    const archivePath = join(ARCHIVE, 'study-log-2026-02.md');
    expect(existsSync(archivePath)).toBe(true);
    const archived = readFileSync(archivePath, 'utf-8');
    expect(archived).toContain(oldDate);
    expect(archived).toContain('sorting algorithms');
  });

  it('force-archives when file exceeds 200 lines', () => {
    const logPath = join(PROFILE, 'study-log.md');
    const lines = Array.from({ length: 210 }, (_, i) => `- Entry ${i}`);
    const content = `---\ntitle: Study Log\ntype: profile\ncreated: 2026-03-01\n---\n\n## 2026-03-29\n${lines.join('\n')}\n`;
    writeFileSync(logPath, content);

    rotateStudyLog(PROFILE, new Date('2026-03-30'));

    const updated = readFileSync(logPath, 'utf-8');
    const lineCount = updated.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(210); // frontmatter + 200 content lines
  });

  it('does nothing when all entries are recent', () => {
    const logPath = join(PROFILE, 'study-log.md');
    const content = `---
title: Study Log
type: profile
created: 2026-03-01
---

## 2026-03-29
- Queried: attention
`;
    writeFileSync(logPath, content);

    rotateStudyLog(PROFILE, new Date('2026-03-30'));

    const updated = readFileSync(logPath, 'utf-8');
    expect(updated).toContain('2026-03-29');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/profile/rotation.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement rotation**

`src/profile/rotation.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { logger } from '../logger.js';

/**
 * Rotates study-log.md: entries older than 30 days move to archive.
 */
export function rotateStudyLog(
  profileDir: string,
  now = new Date(),
): void {
  const logPath = join(profileDir, 'study-log.md');
  if (!existsSync(logPath)) return;

  const content = readFileSync(logPath, 'utf-8');
  const parsed = matter(content);
  const body = parsed.content;

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 30);

  // Split body into date sections
  const sections = body.split(/(?=^## \d{4}-\d{2}-\d{2})/m).filter((s) => s.trim());

  const recent: string[] = [];
  const old: Map<string, string[]> = new Map(); // yearMonth → sections

  for (const section of sections) {
    const dateMatch = section.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) {
      recent.push(section);
      continue;
    }

    const sectionDate = new Date(dateMatch[1]);
    if (sectionDate >= cutoff) {
      recent.push(section);
    } else {
      const yearMonth = dateMatch[1].slice(0, 7); // YYYY-MM
      const existing = old.get(yearMonth) ?? [];
      existing.push(section);
      old.set(yearMonth, existing);
    }
  }

  // Write archived entries
  const archiveDir = join(profileDir, 'archive');
  for (const [yearMonth, archivedSections] of old) {
    const archivePath = join(archiveDir, `study-log-${yearMonth}.md`);
    const archiveContent = archivedSections.join('\n');

    if (existsSync(archivePath)) {
      appendFileSync(archivePath, '\n' + archiveContent);
    } else {
      writeFileSync(
        archivePath,
        `---\ntitle: Study Log ${yearMonth}\ntype: profile\n---\n\n${archiveContent}`,
      );
    }

    logger.info({ yearMonth, entries: archivedSections.length }, 'Archived study log entries');
  }

  // Rewrite main log with only recent entries
  if (old.size > 0) {
    const updated = matter.stringify('\n' + recent.join('\n'), parsed.data);
    writeFileSync(logPath, updated);
  }

  // Hard cap: if file exceeds 200 content lines, force-archive oldest
  const finalContent = readFileSync(logPath, 'utf-8');
  const finalParsed = matter(finalContent);
  const contentLines = finalParsed.content.split('\n');
  if (contentLines.length > 200) {
    const kept = contentLines.slice(0, 200);
    const overflow = contentLines.slice(200);
    const overflowText = overflow.join('\n');
    if (overflowText.trim()) {
      const overflowPath = join(archiveDir, `study-log-overflow-${now.toISOString().slice(0, 10)}.md`);
      writeFileSync(
        overflowPath,
        `---\ntitle: Study Log Overflow\ntype: profile\n---\n\n${overflowText}`,
      );
    }
    const capped = matter.stringify('\n' + kept.join('\n'), finalParsed.data);
    writeFileSync(logPath, capped);
    logger.info('Study log exceeded 200 lines, overflow archived');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/profile/rotation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/profile/rotation.ts src/profile/rotation.test.ts
git commit -m "feat(profile): add weekly study log rotation with archiving"
```

---

## Task 13: Integration Test and Build Verification

**Files:**
- Modify: `src/ingestion/integration.test.ts`

- [ ] **Step 1: Update integration test for new pipeline**

`src/ingestion/integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _initTestDatabase,
  createIngestionJob,
  getIngestionJobs,
  updateIngestionJob,
} from '../db.js';

describe('ingestion integration', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates a simplified ingestion job', () => {
    createIngestionJob('int-1', '/upload/paper.pdf', 'paper.pdf');
    const jobs = getIngestionJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'int-1',
      source_path: '/upload/paper.pdf',
      source_filename: 'paper.pdf',
      status: 'pending',
    });
  });

  it('transitions through pipeline statuses', () => {
    createIngestionJob('int-2', '/upload/thesis.pdf', 'thesis.pdf');

    updateIngestionJob('int-2', { status: 'extracting' });
    expect((getIngestionJobs('extracting') as any[])[0].id).toBe('int-2');

    updateIngestionJob('int-2', { status: 'extracted', extraction_path: '/tmp/ext' });
    expect((getIngestionJobs('extracted') as any[])[0].extraction_path).toBe('/tmp/ext');

    updateIngestionJob('int-2', { status: 'generating' });
    expect((getIngestionJobs('generating') as any[])).toHaveLength(1);

    updateIngestionJob('int-2', { status: 'completed' });
    const completed = getIngestionJobs('completed') as any[];
    expect(completed).toHaveLength(1);
    expect(completed[0].completed_at).toBeTruthy();
  });

  it('handles job failure', () => {
    createIngestionJob('int-3', '/upload/bad.pdf', 'bad.pdf');
    updateIngestionJob('int-3', { status: 'failed', error: 'Extraction timeout' });

    const failed = getIngestionJobs('failed') as any[];
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe('Extraction timeout');
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npm test -- --run`
Expected: All tests pass. If any fail, fix them.

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`
Expected: Clean compilation with no errors.

- [ ] **Step 4: Delete LightRAG data for reindex**

```bash
rm -rf data/rag-working-dir/
```

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/integration.test.ts
git commit -m "test(ingestion): update integration tests for simplified pipeline"
```

---

## Not in Scope (Follow-Up Tasks)

The following spec requirements are deferred because they involve the container agent's query path (not the ingestion pipeline):

1. **Post-retrieval re-ranking by verification_status** — requires changes to how the container agent queries RAG and presents results. The building blocks are in place (verifier module reads status from frontmatter), but the re-ranking logic lives in the agent's RAG query wrapper, which is container-side code.
2. **Trust indicators in responses** — the container agent should annotate retrieved notes with `[unverified]` / `[verified]` markers. This is an agent prompt change, not a pipeline change.

These should be implemented after the pipeline is working and tested with real documents.

---

## Task 14: Final Cleanup and Verification

- [ ] **Step 1: Run full test suite**

```bash
npm test -- --run
```

Expected: All tests pass.

- [ ] **Step 2: Verify no references to removed modules**

```bash
grep -rn "path-parser\|tier-classifier\|review-queue\|type-mappings\|ReviewQueue\|classifyTier\|TypeMappings\|PathContext\|_targetPath\|review_items" src/ --include='*.ts' | grep -v 'node_modules' | grep -v '.test-tmp'
```

Expected: No matches (or only in spec/plan docs).

- [ ] **Step 3: Verify vault structure**

```bash
ls -la vault/concepts/ vault/sources/ vault/_nav/ vault/profile/archive/ upload/processed/
```

Expected: Each directory exists with `.gitkeep`.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: final cleanup — verify no stale references, vault structure correct"
```
