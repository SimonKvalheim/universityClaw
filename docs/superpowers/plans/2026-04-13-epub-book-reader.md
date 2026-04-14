# EPUB Book Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent EPUB book reader at `/read/book` with chapter navigation and "find my place" for switching between RSVP and reMarkable.

**Architecture:** Separate route reuses the existing `useRSVPEngine` hook. EPUB parsing via `jszip` + `DOMParser` (no heavy EPUB library). Books persist in IndexedDB, reading state in localStorage. Three-phase UI: library → upload → reading.

**Tech Stack:** Next.js 16, React 19, jszip, IndexedDB, localStorage, Tailwind CSS, Vitest

**Spec:** `docs/superpowers/specs/2026-04-13-epub-book-reader-design.md`

---

### Task 1: Setup — branch and dependency

**Files:**
- Modify: `dashboard/package.json`

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feat/epub-book-reader main
```

- [ ] **Step 2: Install jszip and jsdom (test environment)**

```bash
cd dashboard && npm install jszip && npm install -D jsdom
```

- [ ] **Step 3: Verify build**

```bash
cd dashboard && npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json
git commit -m "chore: add jszip and jsdom dependencies for EPUB parsing"
```

---

### Task 2: Add initialPosition and textVersion to useRSVPEngine

The engine resets position to 0 whenever `text` changes. The book reader needs to:
1. Resume at a saved position when opening a book
2. Force a reset even when navigating to a chapter with identical text (e.g., re-selecting the current chapter)

We add `initialPosition` (where to start) and `textVersion` (a counter the caller increments to force the effect to re-fire even when text is unchanged). The effect depends on `[text, textVersion]`.

**Files:**
- Modify: `dashboard/src/app/read/useRSVPEngine.ts:9-20` (options interface)
- Modify: `dashboard/src/app/read/useRSVPEngine.ts:176` (destructure)
- Modify: `dashboard/src/app/read/useRSVPEngine.ts:210-216` (text-change effect)

- [ ] **Step 1: Add initialPosition and textVersion to the options interface**

In `dashboard/src/app/read/useRSVPEngine.ts`, update the `RSVPEngineOptions` interface:

```typescript
export interface RSVPEngineOptions {
  text: string;
  wpm: number;
  chunkSize: 1 | 2 | 3;
  initialPosition?: number;
  textVersion?: number;
}
```

- [ ] **Step 2: Update the hook to destructure and use the new options**

In the `useRSVPEngine` function, update the destructure:

```typescript
const { text, wpm, chunkSize, initialPosition, textVersion } = options;
```

Then update the text-change `useEffect` (the one with `setPosition(0)`) to:

```typescript
  // Re-tokenize when text or textVersion changes — start at initialPosition or 0
  useEffect(() => {
    const newWords = tokenizeWithDurations(text, wpm);
    setWords(newWords);
    const startPos = initialPosition ?? 0;
    setPosition(startPos);
    positionRef.current = startPos;
    setIsPlaying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, textVersion]);
```

- [ ] **Step 3: Run all tests**

```bash
npm test -- --run dashboard/src/app/read/useRSVPEngine.test.ts
```

Expected: All tests PASS. Existing behavior unchanged (no callers pass `initialPosition` or `textVersion`).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/app/read/useRSVPEngine.ts
git commit -m "feat(rsvp): add initialPosition and textVersion for chapter resume"
```

---

### Task 3: Extract shared display components

Move reusable display components out of `page.tsx` into a shared module so both the existing reader and the book reader can import them.

**Files:**
- Create: `dashboard/src/app/read/components.tsx`
- Modify: `dashboard/src/app/read/page.tsx`

- [ ] **Step 1: Create components.tsx with extracted components**

Create `dashboard/src/app/read/components.tsx`:

```typescript
'use client';

import { useRef, useEffect } from 'react';
import { getORPIndex, TokenizedWord } from './useRSVPEngine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function getFontSize(chunk: TokenizedWord[]): number {
  const maxLen = chunk.reduce((max, w) => Math.max(max, w.word.length), 0);
  if (maxLen > 30) return 24;
  if (maxLen > 20) return 32;
  return 44;
}

export function segmentClass(active: boolean): string {
  return `px-3 py-1.5 text-sm rounded transition-colors ${
    active
      ? 'bg-blue-600 text-white'
      : 'bg-gray-800 text-gray-400 hover:text-gray-200 cursor-pointer'
  }`;
}

// ---------------------------------------------------------------------------
// Display components
// ---------------------------------------------------------------------------

export function ORPDisplay({ chunk, fontSize }: { chunk: TokenizedWord[]; fontSize: number }) {
  if (chunk.length === 0) return null;

  const longestWord = chunk.reduce((longest, w) =>
    w.word.length > longest.word.length ? w : longest
  );
  const word = longestWord.word;
  const pivot = getORPIndex(word);

  const before = word.slice(0, pivot);
  const pivotChar = word[pivot] ?? '';
  const after = word.slice(pivot + 1);

  if (chunk.length > 1) {
    const phrase = chunk.map((w) => w.word).join(' ');
    let charsBeforeLongest = 0;
    for (const w of chunk) {
      if (w === longestWord) break;
      charsBeforeLongest += w.word.length + 1;
    }
    const pivotInPhrase = charsBeforeLongest + pivot;
    const phraseShiftCh = phrase.length / 2 - pivotInPhrase - 0.5;

    return (
      <div className="relative flex items-center justify-center" style={{ fontSize, fontFamily: 'ui-monospace, monospace', minHeight: '1.5em' }}>
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-800" />
        <span style={{ transform: `translateX(${phraseShiftCh}ch)` }}>
          {chunk.map((w, i) => {
            const isLongest = w === longestWord;
            return (
              <span key={i}>
                {i > 0 && ' '}
                {isLongest ? (
                  <>
                    <span className="text-gray-300">{before}</span>
                    <span className="text-red-500 font-bold">{pivotChar}</span>
                    <span className="text-gray-300">{after}</span>
                  </>
                ) : (
                  <span className="text-gray-300">{w.word}</span>
                )}
              </span>
            );
          })}
        </span>
      </div>
    );
  }

  const shiftCh = word.length / 2 - pivot - 0.5;

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ fontSize, fontFamily: 'ui-monospace, monospace', minHeight: '1.5em' }}
    >
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-800" />
      <span
        className="flex items-center"
        style={{ transform: `translateX(${shiftCh}ch)` }}
      >
        <span className="text-gray-300">{before}</span>
        <span className="text-red-500 font-bold">{pivotChar}</span>
        <span className="text-gray-300">{after}</span>
      </span>
    </div>
  );
}

export function CenteredDisplay({ chunk, fontSize }: { chunk: TokenizedWord[]; fontSize: number }) {
  const text = chunk.map((w) => w.word).join(' ');
  return (
    <div
      className="flex items-center justify-center text-gray-100"
      style={{ fontSize, fontFamily: 'ui-monospace, monospace', minHeight: '1.5em' }}
    >
      {text}
    </div>
  );
}

export function ContextDisplay({
  chunk,
  words,
  position,
  fontSize,
}: {
  chunk: TokenizedWord[];
  words: TokenizedWord[];
  position: number;
  fontSize: number;
}) {
  const before = words
    .slice(Math.max(0, position - 10), position)
    .map((w) => w.word)
    .join(' ');
  const after = words
    .slice(position + chunk.length, position + chunk.length + 10)
    .map((w) => w.word)
    .join(' ');

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-gray-700 text-sm truncate max-w-full text-center">{before}</p>
      <ORPDisplay chunk={chunk} fontSize={fontSize} />
      <p className="text-gray-700 text-sm truncate max-w-full text-center">{after}</p>
    </div>
  );
}

export function SourcePanel({ text, position }: { text: string; words: TokenizedWord[]; position: number }) {
  const allWords = text.trim().split(/\s+/);
  const start = Math.max(0, position - 250);
  const end = Math.min(allWords.length, position + 250);
  const slice = allWords.slice(start, end);

  const highlightRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [position]);

  return (
    <div className="max-h-48 overflow-y-auto text-xs leading-relaxed text-gray-600 p-3 bg-gray-900 border border-gray-800 rounded-lg">
      {slice.map((word, i) => {
        const globalIdx = start + i;
        const isHighlighted = globalIdx === position;
        return (
          <span key={globalIdx}>
            {isHighlighted ? (
              <span
                ref={highlightRef}
                className="bg-blue-900 text-blue-200 px-0.5 rounded"
              >
                {word}
              </span>
            ) : (
              <span className="text-gray-600">{word}</span>
            )}
            {' '}
          </span>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Update page.tsx to import from components.tsx**

In `dashboard/src/app/read/page.tsx`:

1. Remove the `formatTime`, `getFontSize` function definitions (lines 18-29)
2. Remove the `ORPDisplay`, `CenteredDisplay`, `ContextDisplay`, `SourcePanel` component definitions (lines 35-197)
3. Remove the inline `segmentClass` function definition (lines 363-369)
4. Add this import at the top (after the existing imports):

```typescript
import { formatTime, getFontSize, segmentClass, ORPDisplay, CenteredDisplay, ContextDisplay, SourcePanel } from './components';
```

5. Remove the `getORPIndex` and `TokenizedWord` imports from the useRSVPEngine import (they're no longer needed directly — components.tsx imports them).

The useRSVPEngine import becomes:

```typescript
import { useRSVPEngine } from './useRSVPEngine';
```

- [ ] **Step 3: Verify build and existing reader still works**

```bash
cd dashboard && npm run build
```

Expected: Build succeeds. The existing `/read` page is functionally identical.

- [ ] **Step 4: Run existing tests**

```bash
npm test -- --run dashboard/src/app/read/useRSVPEngine.test.ts
```

Expected: All tests PASS (no logic changed).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/read/components.tsx dashboard/src/app/read/page.tsx
git commit -m "refactor(read): extract shared display components for reuse"
```

---

### Task 4: EPUB parser

Pure module that takes an EPUB `ArrayBuffer` and returns structured chapter data. Uses `jszip` for unzipping and `DOMParser` for XML/XHTML parsing.

**Files:**
- Create: `dashboard/src/app/read/book/epubParser.ts`
- Create: `dashboard/src/app/read/book/epubParser.test.ts`

- [ ] **Step 1: Write failing tests**

Create `dashboard/src/app/read/book/epubParser.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { extractTextFromHtml, resolveHref } from './epubParser';

// ---------------------------------------------------------------------------
// extractTextFromHtml
// ---------------------------------------------------------------------------

describe('extractTextFromHtml', () => {
  it('strips HTML tags and returns text content', () => {
    const html = '<html><body><p>Hello <b>world</b></p></body></html>';
    expect(extractTextFromHtml(html)).toBe('Hello world');
  });

  it('joins multiple paragraphs with newlines', () => {
    const html = '<html><body><p>First.</p><p>Second.</p></body></html>';
    const result = extractTextFromHtml(html);
    expect(result).toContain('First.');
    expect(result).toContain('Second.');
  });

  it('returns empty string for empty body', () => {
    const html = '<html><body></body></html>';
    expect(extractTextFromHtml(html)).toBe('');
  });

  it('handles self-closing tags', () => {
    const html = '<html><body><p>Line one<br/>Line two</p></body></html>';
    const result = extractTextFromHtml(html);
    expect(result).toContain('Line one');
    expect(result).toContain('Line two');
  });
});

// ---------------------------------------------------------------------------
// resolveHref
// ---------------------------------------------------------------------------

describe('resolveHref', () => {
  it('prepends opfDir to relative href', () => {
    expect(resolveHref('chapter1.xhtml', 'OEBPS/')).toBe('OEBPS/chapter1.xhtml');
  });

  it('handles empty opfDir', () => {
    expect(resolveHref('chapter1.xhtml', '')).toBe('chapter1.xhtml');
  });

  it('handles nested paths', () => {
    expect(resolveHref('text/ch1.xhtml', 'OEBPS/')).toBe('OEBPS/text/ch1.xhtml');
  });

  it('resolves ../ segments', () => {
    expect(resolveHref('../Text/ch1.xhtml', 'OEBPS/nav/')).toBe('OEBPS/Text/ch1.xhtml');
  });

  it('decodes URL-encoded characters', () => {
    expect(resolveHref('chapter%201.xhtml', 'OEBPS/')).toBe('OEBPS/chapter 1.xhtml');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --run dashboard/src/app/read/book/epubParser.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the EPUB parser**

Create `dashboard/src/app/read/book/epubParser.ts`:

```typescript
import JSZip from 'jszip';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedBook {
  title: string;
  author: string;
  chapters: ParsedChapter[];
}

export interface ParsedChapter {
  title: string;
  text: string;
  wordCount: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an EPUB file from an ArrayBuffer into structured chapter data.
 */
export async function parseEpub(buffer: ArrayBuffer): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(buffer);

  // 1. Read container.xml to find the OPF file
  const containerXml = await readZipText(zip, 'META-INF/container.xml');
  if (!containerXml) throw new Error('Invalid EPUB: missing META-INF/container.xml');

  const containerDoc = parseXml(containerXml);
  // Use getElementsByTagNameNS with wildcard to handle any namespace
  const rootfileEl = containerDoc.getElementsByTagNameNS('*', 'rootfile')[0];
  const opfPath = rootfileEl?.getAttribute('full-path');
  if (!opfPath) throw new Error('Invalid EPUB: no rootfile path found');

  // 2. Read and parse the OPF
  const opfXml = await readZipText(zip, opfPath);
  if (!opfXml) throw new Error(`Invalid EPUB: missing OPF file at ${opfPath}`);

  const opfDoc = parseXml(opfXml);
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

  // 3. Extract metadata
  const DC_NS = 'http://purl.org/dc/elements/1.1/';
  const title = opfDoc.getElementsByTagNameNS(DC_NS, 'title')[0]?.textContent?.trim() ?? 'Untitled';
  const author = opfDoc.getElementsByTagNameNS(DC_NS, 'creator')[0]?.textContent?.trim() ?? '';

  // 4. Build manifest map (id → href)
  const manifest = new Map<string, string>();
  const manifestItems = opfDoc.getElementsByTagNameNS('*', 'item');
  for (let i = 0; i < manifestItems.length; i++) {
    const item = manifestItems[i];
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) manifest.set(id, href);
  }

  // 5. Get spine order
  const spineIds: string[] = [];
  const spineItemrefs = opfDoc.getElementsByTagNameNS('*', 'itemref');
  for (let i = 0; i < spineItemrefs.length; i++) {
    const idref = spineItemrefs[i].getAttribute('idref');
    if (idref) spineIds.push(idref);
  }

  // 6. Parse TOC for chapter titles (keys are paths relative to ZIP root)
  const tocTitles = await parseToc(zip, opfDoc, opfDir, manifest);

  // 7. Extract text from each spine item
  const chapters: ParsedChapter[] = [];
  let untitledIndex = 0;

  for (const id of spineIds) {
    const href = manifest.get(id);
    if (!href) continue;

    const filePath = resolveHref(href, opfDir);
    const xhtml = await readZipText(zip, filePath);
    if (!xhtml) continue;

    const text = extractTextFromHtml(xhtml);
    const wordCount = text ? text.trim().split(/\s+/).length : 0;

    // Skip chapters with fewer than 5 words (front matter, copyright, etc.)
    if (wordCount < 5) continue;

    // Match against TOC using ZIP-root-relative path
    const chapterTitle = tocTitles.get(filePath) ?? `Chapter ${++untitledIndex}`;
    chapters.push({ title: chapterTitle, text, wordCount });
  }

  if (chapters.length === 0) {
    throw new Error('No readable chapters found in this EPUB.');
  }

  return { title, author, chapters };
}

// ---------------------------------------------------------------------------
// Exported helpers (tested directly)
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags from XHTML content and return plain text.
 * Tries strict XHTML first, falls back to lenient text/html for malformed content.
 */
export function extractTextFromHtml(html: string): string {
  // Try strict XHTML first
  let doc = new DOMParser().parseFromString(html, 'application/xhtml+xml');
  // If parse failed (malformed XHTML), DOMParser returns a document with <parsererror>
  if (doc.querySelector('parsererror')) {
    doc = new DOMParser().parseFromString(html, 'text/html');
  }
  const body = doc.body ?? doc.documentElement;
  return (body.textContent ?? '').trim();
}

/**
 * Resolve a manifest href relative to the OPF directory.
 * Handles `../` segments and URL-encoded characters.
 */
export function resolveHref(href: string, opfDir: string): string {
  const decoded = decodeURIComponent(href);
  const combined = opfDir + decoded;
  // Resolve ../  segments
  const parts = combined.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else if (part !== '.') {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

async function readZipText(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  if (!file) return null;
  return file.async('text');
}

/**
 * Try to parse the TOC (EPUB 3 nav or EPUB 2 NCX) and return a map of href → title.
 */
async function parseToc(
  zip: JSZip,
  opfDoc: Document,
  opfDir: string,
  manifest: Map<string, string>,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();

  // Try EPUB 3 nav document first
  const manifestItems = opfDoc.getElementsByTagNameNS('*', 'item');
  let navDir = opfDir; // directory of nav file, for resolving relative hrefs
  for (let i = 0; i < manifestItems.length; i++) {
    const item = manifestItems[i];
    const props = item.getAttribute('properties') ?? '';
    if (props.includes('nav')) {
      const navHref = item.getAttribute('href');
      if (!navHref) continue;

      const navPath = resolveHref(navHref, opfDir);
      navDir = navPath.includes('/') ? navPath.substring(0, navPath.lastIndexOf('/') + 1) : '';
      const navXhtml = await readZipText(zip, navPath);
      if (!navXhtml) continue;

      // Parse as text/html for robustness — nav docs are often loose HTML
      const navDoc = new DOMParser().parseFromString(navXhtml, 'text/html');
      const navElements = navDoc.getElementsByTagName('nav');
      for (let n = 0; n < navElements.length; n++) {
        const nav = navElements[n];
        const epubType = nav.getAttribute('epub:type') ?? nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? '';
        if (epubType !== 'toc' && nav.id !== 'toc') continue;

        const links = nav.getElementsByTagName('a');
        for (let l = 0; l < links.length; l++) {
          const a = links[l];
          const rawHref = a.getAttribute('href')?.split('#')[0];
          const text = a.textContent?.trim();
          // Normalize to ZIP-root-relative path for matching
          if (rawHref && text) titles.set(resolveHref(rawHref, navDir), text);
        }
      }

      if (titles.size > 0) return titles;
    }
  }

  // Fall back to NCX (EPUB 2)
  const spineEl = opfDoc.getElementsByTagNameNS('*', 'spine')[0];
  const tocId = spineEl?.getAttribute('toc');
  if (tocId) {
    const ncxHref = manifest.get(tocId);
    if (ncxHref) {
      const ncxPath = resolveHref(ncxHref, opfDir);
      const ncxDir = ncxPath.includes('/') ? ncxPath.substring(0, ncxPath.lastIndexOf('/') + 1) : '';
      const ncxXml = await readZipText(zip, ncxPath);
      if (ncxXml) {
        const ncxDoc = parseXml(ncxXml);
        const navPoints = ncxDoc.getElementsByTagNameNS('*', 'navPoint');
        for (let i = 0; i < navPoints.length; i++) {
          const np = navPoints[i];
          const textEl = np.getElementsByTagNameNS('*', 'text')[0];
          const contentEl = np.getElementsByTagNameNS('*', 'content')[0];
          const text = textEl?.textContent?.trim();
          const src = contentEl?.getAttribute('src')?.split('#')[0];
          // Normalize to ZIP-root-relative path for matching
          if (text && src) titles.set(resolveHref(src, ncxDir), text);
        }
      }
    }
  }

  return titles;
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --run dashboard/src/app/read/book/epubParser.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/read/book/epubParser.ts dashboard/src/app/read/book/epubParser.test.ts
git commit -m "feat(book): add EPUB parser with jszip"
```

---

### Task 5: Utility functions — book ID and sentence extraction

**Files:**
- Create: `dashboard/src/app/read/book/utils.ts`
- Create: `dashboard/src/app/read/book/utils.test.ts`

- [ ] **Step 1: Write failing tests**

Create `dashboard/src/app/read/book/utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractCurrentSentence } from './utils';

// ---------------------------------------------------------------------------
// extractCurrentSentence
// ---------------------------------------------------------------------------

describe('extractCurrentSentence', () => {
  it('extracts a simple sentence around the given word index', () => {
    const words = ['The', 'cat', 'sat.', 'The', 'dog', 'ran.'];
    expect(extractCurrentSentence(words, 1)).toBe('The cat sat.');
  });

  it('extracts the second sentence when index is in it', () => {
    const words = ['The', 'cat', 'sat.', 'The', 'dog', 'ran.'];
    expect(extractCurrentSentence(words, 4)).toBe('The dog ran.');
  });

  it('handles index at the very start', () => {
    const words = ['Hello', 'world.'];
    expect(extractCurrentSentence(words, 0)).toBe('Hello world.');
  });

  it('handles text with no sentence-ending punctuation', () => {
    const words = ['no', 'punctuation', 'here'];
    expect(extractCurrentSentence(words, 1)).toBe('no punctuation here');
  });

  it('handles index at sentence boundary word', () => {
    const words = ['First.', 'Second.'];
    expect(extractCurrentSentence(words, 0)).toBe('First.');
  });

  it('handles exclamation marks', () => {
    const words = ['Wow!', 'That', 'was', 'great.'];
    expect(extractCurrentSentence(words, 2)).toBe('That was great.');
  });

  it('handles question marks', () => {
    const words = ['Is', 'it?', 'Yes.'];
    expect(extractCurrentSentence(words, 0)).toBe('Is it?');
  });

  it('truncates to 200 chars with ellipsis when sentence is too long', () => {
    // Build a sentence of 50 long words (each ~10 chars + space = ~550 chars)
    const words = Array.from({ length: 50 }, (_, i) => `longword${i.toString().padStart(2, '0')}`);
    words[49] = words[49] + '.';
    const result = extractCurrentSentence(words, 25);
    expect(result.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(result.startsWith('...')).toBe(true);
  });

  it('returns empty string for empty words array', () => {
    expect(extractCurrentSentence([], 0)).toBe('');
  });

  it('clamps index to valid range', () => {
    const words = ['Hello', 'world.'];
    expect(extractCurrentSentence(words, 99)).toBe('Hello world.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --run dashboard/src/app/read/book/utils.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement utils**

Create `dashboard/src/app/read/book/utils.ts`:

```typescript
/**
 * Generate a book ID by hashing the first 4KB of file content.
 */
export async function generateBookId(buffer: ArrayBuffer): Promise<string> {
  const slice = buffer.slice(0, 4096);
  const hash = await crypto.subtle.digest('SHA-256', slice);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Extract the sentence surrounding the word at `wordIndex`.
 * Scans backward and forward for sentence-ending punctuation (. ! ?).
 * Caps output at 200 characters, truncating from the left with "...".
 */
export function extractCurrentSentence(words: string[], wordIndex: number): string {
  if (words.length === 0) return '';

  const idx = Math.max(0, Math.min(wordIndex, words.length - 1));

  // Scan backward for sentence boundary
  let start = 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (/[.!?]$/.test(words[i])) {
      start = i + 1;
      break;
    }
  }

  // Scan forward for sentence boundary
  let end = words.length - 1;
  for (let i = idx; i < words.length; i++) {
    if (/[.!?]$/.test(words[i])) {
      end = i;
      break;
    }
  }

  const sentence = words.slice(start, end + 1).join(' ');

  if (sentence.length <= 200) return sentence;

  return '...' + sentence.slice(-200);
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --run dashboard/src/app/read/book/utils.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/read/book/utils.ts dashboard/src/app/read/book/utils.test.ts
git commit -m "feat(book): add book ID generation and sentence extraction utils"
```

---

### Task 6: Book store — IndexedDB and localStorage persistence

**Files:**
- Create: `dashboard/src/app/read/book/bookStore.ts`

- [ ] **Step 1: Implement the book store**

Create `dashboard/src/app/read/book/bookStore.ts`:

```typescript
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredBook {
  id: string;
  title: string;
  author: string;
  chapters: { title: string; text: string; wordCount: number }[];
  addedAt: number;
}

export interface ReadingState {
  bookId: string;
  currentChapter: number;
  position: number;
  wpm: number;
  chunkSize: 1 | 2 | 3;
  displayMode: 'orp' | 'centered' | 'orp+context';
  lastRead: number;
}

// ---------------------------------------------------------------------------
// IndexedDB — book storage
// ---------------------------------------------------------------------------

const DB_NAME = 'book-reader';
const STORE_NAME = 'books';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllBooks(): Promise<StoredBook[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getBook(id: string): Promise<StoredBook | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result ?? undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function saveBook(book: StoredBook): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(book);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function deleteBook(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------------------
// localStorage — reading state
// ---------------------------------------------------------------------------

function stateKey(bookId: string): string {
  return `book-state:${bookId}`;
}

export function getReadingState(bookId: string): ReadingState | null {
  const raw = localStorage.getItem(stateKey(bookId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReadingState;
  } catch {
    return null;
  }
}

export function saveReadingState(state: ReadingState): void {
  localStorage.setItem(stateKey(state.bookId), JSON.stringify(state));
}

export function deleteReadingState(bookId: string): void {
  localStorage.removeItem(stateKey(bookId));
}
```

- [ ] **Step 2: Verify build**

```bash
cd dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/read/book/bookStore.ts
git commit -m "feat(book): add IndexedDB and localStorage persistence"
```

---

### Task 7: Book reader page

The main page component with library, upload, and reading phases. This is the largest task.

**Files:**
- Create: `dashboard/src/app/read/book/page.tsx`

- [ ] **Step 1: Create the book reader page**

Create `dashboard/src/app/read/book/page.tsx`:

```tsx
'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRSVPEngine, type TokenizedWord } from '../useRSVPEngine';
import {
  formatTime,
  getFontSize,
  segmentClass,
  ORPDisplay,
  CenteredDisplay,
  ContextDisplay,
  SourcePanel,
} from '../components';
import { parseEpub, type ParsedChapter } from './epubParser';
import {
  getAllBooks,
  getBook,
  saveBook,
  deleteBook,
  getReadingState,
  saveReadingState,
  deleteReadingState,
  type StoredBook,
  type ReadingState,
} from './bookStore';
import { generateBookId, extractCurrentSentence } from './utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'library' | 'upload' | 'reading' | 'complete';
type DisplayMode = 'orp' | 'centered' | 'orp+context';

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function BookReaderPage() {
  const [phase, setPhase] = useState<Phase>('library');
  const [books, setBooks] = useState<StoredBook[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Reading state
  const [currentBook, setCurrentBook] = useState<StoredBook | null>(null);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [chapterText, setChapterText] = useState('');
  const [wpm, setWpm] = useState(250);
  const [chunkSize, setChunkSize] = useState<1 | 2 | 3>(1);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('orp');
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [initialPosition, setInitialPosition] = useState(0);
  const [copiedSentence, setCopiedSentence] = useState(false);
  const [textVersion, setTextVersion] = useState(0);

  // Timing refs
  const readingStartTime = useRef(0);
  const totalPauseTime = useRef(0);
  const lastPauseStart = useRef(0);
  const autoSaveInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // Refs for values needed in stable callbacks (avoids stale closures)
  const currentBookRef = useRef(currentBook);
  const currentChapterIndexRef = useRef(currentChapterIndex);
  useEffect(() => { currentBookRef.current = currentBook; }, [currentBook]);
  useEffect(() => { currentChapterIndexRef.current = currentChapterIndex; }, [currentChapterIndex]);

  const engine = useRSVPEngine({ text: chapterText, wpm, chunkSize, initialPosition, textVersion });

  // Completion stats
  const [completionStats, setCompletionStats] = useState<{
    totalTime: number;
    effectiveWpm: number;
  } | null>(null);

  // -----------------------------------------------------------------------
  // Load library on mount
  // -----------------------------------------------------------------------

  useEffect(() => {
    getAllBooks().then((b) => {
      setBooks(b);
      setLoadingLibrary(false);
    });
  }, []);

  // -----------------------------------------------------------------------
  // Auto-save on visibilitychange
  // -----------------------------------------------------------------------

  // Use engine position via ref so the callback stays stable during playback.
  // Without this, engine.position in deps causes the 30s interval to restart every word.
  const enginePositionRef = useRef(engine.position);
  useEffect(() => { enginePositionRef.current = engine.position; }, [engine.position]);

  const saveCurrentState = useCallback(() => {
    const book = currentBookRef.current;
    if (!book) return;
    saveReadingState({
      bookId: book.id,
      currentChapter: currentChapterIndexRef.current,
      position: enginePositionRef.current,
      wpm,
      chunkSize,
      displayMode,
      lastRead: Date.now(),
    });
  }, [wpm, chunkSize, displayMode]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden && phase === 'reading') {
        saveCurrentState();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [phase, saveCurrentState]);

  // Auto-save every 30s during playback
  useEffect(() => {
    if (phase === 'reading' && engine.isPlaying) {
      autoSaveInterval.current = setInterval(saveCurrentState, 30000);
    } else if (autoSaveInterval.current) {
      clearInterval(autoSaveInterval.current);
      autoSaveInterval.current = null;
    }
    return () => {
      if (autoSaveInterval.current) clearInterval(autoSaveInterval.current);
    };
  }, [phase, engine.isPlaying, saveCurrentState]);

  // Save on pause
  useEffect(() => {
    if (phase === 'reading' && !engine.isPlaying && currentBookRef.current) {
      saveCurrentState();
    }
  }, [engine.isPlaying, phase, saveCurrentState]);

  // Track pause time
  useEffect(() => {
    if (phase !== 'reading') return;
    if (!engine.isPlaying) {
      lastPauseStart.current = Date.now();
    } else if (lastPauseStart.current > 0) {
      totalPauseTime.current += Date.now() - lastPauseStart.current;
      lastPauseStart.current = 0;
    }
  }, [engine.isPlaying, phase]);

  // Detect chapter completion → auto-advance or book completion
  useEffect(() => {
    if (
      phase === 'reading' &&
      !engine.isPlaying &&
      engine.position >= engine.totalWords &&
      engine.totalWords > 0
    ) {
      const book = currentBookRef.current;
      const chIdx = currentChapterIndexRef.current;
      if (!book) return;
      const isLastChapter = chIdx >= book.chapters.length - 1;

      if (isLastChapter) {
        // Book complete
        if (lastPauseStart.current > 0) {
          totalPauseTime.current += Date.now() - lastPauseStart.current;
          lastPauseStart.current = 0;
        }
        const totalTime = (Date.now() - readingStartTime.current - totalPauseTime.current) / 1000;
        const totalWords = book.chapters.reduce((sum, ch) => sum + ch.wordCount, 0);
        const effectiveWpm = totalTime > 0 ? Math.round(totalWords / (totalTime / 60)) : 0;
        setCompletionStats({ totalTime, effectiveWpm });
        setPhase('complete');
      } else {
        // Advance to next chapter
        goToChapter(chIdx + 1, 0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.isPlaying, engine.position, engine.totalWords, phase]);

  // -----------------------------------------------------------------------
  // Stable engine ref for keyboard handler
  // -----------------------------------------------------------------------

  const engineRef = useRef(engine);
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (phase !== 'reading' && phase !== 'complete') return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || target.getAttribute('role') === 'slider') return;

      const eng = engineRef.current;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          eng.isPlaying ? eng.pause() : eng.play();
          break;
        case 'ArrowLeft':
          eng.seek(-10);
          break;
        case 'ArrowRight':
          eng.seek(10);
          break;
        case 'ArrowUp':
          setWpm((w) => Math.min(800, w + 25));
          break;
        case 'ArrowDown':
          setWpm((w) => Math.max(100, w - 25));
          break;
        case 'KeyR':
          eng.restart();
          break;
        case 'KeyT':
          setSourceExpanded((v) => !v);
          break;
        case 'KeyM':
          setDisplayMode((m) => {
            if (m === 'orp') return 'centered';
            if (m === 'centered') return 'orp+context';
            return 'orp';
          });
          break;
        case 'KeyC':
          setChunkSize((c) => {
            if (c === 1) return 2;
            if (c === 2) return 3;
            return 1;
          });
          break;
        case 'BracketLeft':
          if (currentBook && currentChapterIndex > 0) {
            goToChapter(currentChapterIndex - 1, 0);
          }
          break;
        case 'BracketRight':
          if (currentBook && currentChapterIndex < currentBook.chapters.length - 1) {
            goToChapter(currentChapterIndex + 1, 0);
          }
          break;
        case 'Escape':
          saveCurrentState();
          setPhase('library');
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phase, currentBook, currentChapterIndex]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  function goToChapter(index: number, pos: number) {
    if (!currentBook) return;
    const chapter = currentBook.chapters[index];
    if (!chapter) return;
    setCurrentChapterIndex(index);
    setInitialPosition(pos);
    setChapterText(chapter.text);
    setTextVersion((v) => v + 1); // Force engine re-init even if same text
  }

  async function openBook(bookId: string) {
    const book = await getBook(bookId);
    if (!book) return;

    setCurrentBook(book);
    const state = getReadingState(bookId);

    const chIdx = state?.currentChapter ?? 0;
    const pos = state?.position ?? 0;
    if (state?.wpm) setWpm(state.wpm);
    if (state?.chunkSize) setChunkSize(state.chunkSize);
    if (state?.displayMode) setDisplayMode(state.displayMode);

    setCurrentChapterIndex(chIdx);
    setInitialPosition(pos);
    setChapterText(book.chapters[chIdx]?.text ?? '');
    readingStartTime.current = Date.now();
    totalPauseTime.current = 0;
    lastPauseStart.current = 0;
    setPhase('reading');
  }

  async function handleRemoveBook(bookId: string) {
    if (!confirm('Remove this book? Reading progress will be lost.')) return;
    await deleteBook(bookId);
    deleteReadingState(bookId);
    setBooks((prev) => prev.filter((b) => b.id !== bookId));
  }

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.epub')) {
      setUploadError('Please upload an .epub file.');
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const buffer = await file.arrayBuffer();
      const id = await generateBookId(buffer);

      // Check if book already exists
      const existing = await getBook(id);
      if (existing) {
        if (!confirm(`"${existing.title}" is already in your library. Replace it? Reading progress will be reset.`)) {
          setUploading(false);
          return;
        }
        deleteReadingState(id);
      }

      const parsed = await parseEpub(buffer);
      const book: StoredBook = {
        id,
        title: parsed.title,
        author: parsed.author,
        chapters: parsed.chapters,
        addedAt: Date.now(),
      };

      await saveBook(book);
      setBooks((prev) => {
        const filtered = prev.filter((b) => b.id !== id);
        return [...filtered, book];
      });

      // Go directly to reading
      setCurrentBook(book);
      setCurrentChapterIndex(0);
      setInitialPosition(0);
      setChapterText(book.chapters[0].text);
      readingStartTime.current = Date.now();
      totalPauseTime.current = 0;
      lastPauseStart.current = 0;
      setPhase('reading');
    } catch (err) {
      const message = err instanceof DOMException && err.name === 'QuotaExceededError'
        ? 'Storage full. Remove some books to make room.'
        : err instanceof Error
          ? err.message
          : 'Failed to parse EPUB file.';
      setUploadError(message);
    } finally {
      setUploading(false);
    }
  }

  // -----------------------------------------------------------------------
  // Computed values
  // -----------------------------------------------------------------------

  const fontSize = getFontSize(engine.currentChunk);
  const showSettings = !engine.isPlaying && phase === 'reading';
  const currentChapter = currentBook?.chapters[currentChapterIndex];
  const chapterProgress = currentChapter
    ? Math.round((engine.position / currentChapter.wordCount) * 100)
    : 0;
  const overallProgress = currentBook
    ? (() => {
        const totalWords = currentBook.chapters.reduce((s, c) => s + c.wordCount, 0);
        const wordsBefore = currentBook.chapters.slice(0, currentChapterIndex).reduce((s, c) => s + c.wordCount, 0);
        return Math.round(((wordsBefore + engine.position) / totalWords) * 100);
      })()
    : 0;

  // "Find my place" sentence
  const currentSentence = (() => {
    if (!currentChapter) return '';
    const words = currentChapter.text.trim().split(/\s+/);
    return extractCurrentSentence(words, engine.position);
  })();

  async function copySentence() {
    await navigator.clipboard.writeText(currentSentence);
    setCopiedSentence(true);
    setTimeout(() => setCopiedSentence(false), 2000);
  }

  // -----------------------------------------------------------------------
  // Render: complete phase
  // -----------------------------------------------------------------------

  if (phase === 'complete') {
    const totalWords = currentBook?.chapters.reduce((s, c) => s + c.wordCount, 0) ?? 0;
    return (
      <div className="max-w-2xl mx-auto">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-10 text-center">
          <h2 className="text-2xl font-semibold text-gray-100 mb-2">Book Complete</h2>
          <p className="text-gray-400 mb-8">{currentBook?.title}</p>

          {completionStats && (
            <div className="flex justify-center gap-12 mb-10">
              <div>
                <p className="text-3xl font-mono text-blue-400">{formatTime(completionStats.totalTime)}</p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Time</p>
              </div>
              <div>
                <p className="text-3xl font-mono text-blue-400">{completionStats.effectiveWpm.toLocaleString()}</p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Effective WPM</p>
              </div>
              <div>
                <p className="text-3xl font-mono text-blue-400">{totalWords.toLocaleString()}</p>
                <p className="text-xs text-gray-500 mt-1 uppercase tracking-wide">Words</p>
              </div>
            </div>
          )}

          <button
            className="px-6 py-2.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            onClick={() => {
              setCompletionStats(null);
              setPhase('library');
            }}
          >
            Back to Library
          </button>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: reading phase
  // -----------------------------------------------------------------------

  if (phase === 'reading' && currentBook && currentChapter) {
    return (
      <div className="max-w-2xl mx-auto select-none">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <button
            className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
            onClick={() => { saveCurrentState(); setPhase('library'); }}
            title="Back to library (Esc)"
          >
            ← Library
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-400 truncate">{currentBook.title}</p>
          </div>
          <select
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-gray-600 max-w-[200px]"
            value={currentChapterIndex}
            onChange={(e) => goToChapter(Number(e.target.value), 0)}
          >
            {currentBook.chapters.map((ch, i) => (
              <option key={i} value={i}>{ch.title}</option>
            ))}
          </select>
          <span className="text-xs text-gray-500 whitespace-nowrap">
            {currentChapterIndex + 1}/{currentBook.chapters.length} — {chapterProgress}%
          </span>
        </div>

        {/* Display area */}
        <div className="py-20 flex items-center justify-center min-h-[160px]">
          {displayMode === 'orp' && <ORPDisplay chunk={engine.currentChunk} fontSize={fontSize} />}
          {displayMode === 'centered' && <CenteredDisplay chunk={engine.currentChunk} fontSize={fontSize} />}
          {displayMode === 'orp+context' && (
            <ContextDisplay chunk={engine.currentChunk} words={engine.words} position={engine.position} fontSize={fontSize} />
          )}
        </div>

        {/* Find my place panel */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500">
              Chapter {currentChapterIndex + 1} — {chapterProgress}% · Book {overallProgress}%
            </span>
            <button
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              onClick={copySentence}
              title="Copy sentence to clipboard"
            >
              {copiedSentence ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="text-sm text-gray-400 leading-relaxed">{currentSentence}</p>
        </div>

        {/* Progress bar */}
        <div className="mb-4">
          <div
            className="h-2 bg-gray-800 rounded-full cursor-pointer"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = (e.clientX - rect.left) / rect.width;
              engine.jumpTo(Math.round(pct * engine.totalWords));
            }}
          >
            <div
              className="h-full bg-blue-600 rounded-full transition-all"
              style={{ width: `${engine.progress * 100}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>Word {engine.position} / {engine.totalWords}</span>
            <span>{formatTime(engine.estimatedTimeLeft)} left</span>
          </div>
        </div>

        {/* Transport controls */}
        <div className="flex items-center justify-center gap-3 mb-4">
          <button className="px-3 py-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm transition-colors" onClick={() => engine.seek(-10)} title="Seek back 10s (←)">←10s</button>
          <button className="px-5 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors min-w-[80px]" onClick={() => (engine.isPlaying ? engine.pause() : engine.play())} title="Play/Pause (Space)">
            {engine.isPlaying ? 'Pause' : 'Play'}
          </button>
          <button className="px-3 py-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm transition-colors" onClick={() => engine.seek(10)} title="Seek forward 10s (→)">10s→</button>
          <button className="px-3 py-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm transition-colors" onClick={() => engine.restart()} title="Restart chapter (R)">↺</button>
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-center gap-4 text-xs text-gray-500 mb-4">
          <span>WPM: <span className="text-gray-300">{wpm}</span> <span className="text-gray-600">(↑↓)</span></span>
          <span>Chunk: <span className="text-gray-300">{chunkSize}</span> <span className="text-gray-600">(C)</span></span>
          <span>Mode: <span className="text-gray-300">{displayMode}</span> <span className="text-gray-600">(M)</span></span>
          <button className="text-gray-500 hover:text-gray-300 transition-colors" onClick={() => setSourceExpanded((v) => !v)} title="Toggle source (T)">
            Source <span className="text-gray-600">(T)</span>
          </button>
          <span>Ch: <span className="text-gray-600">[ ]</span></span>
        </div>

        {/* Settings panel — visible on pause */}
        {showSettings && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
            <div className="flex flex-wrap gap-6 items-center">
              <div className="flex items-center gap-3 flex-1 min-w-48">
                <label className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">WPM</label>
                <input type="range" min={100} max={800} step={25} value={wpm} onChange={(e) => setWpm(Number(e.target.value))} className="flex-1 accent-blue-500" />
                <input type="number" min={100} max={800} step={25} value={wpm} onChange={(e) => setWpm(Math.min(800, Math.max(100, Number(e.target.value))))} className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-center text-gray-100 focus:outline-none focus:border-gray-600" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">Words</span>
                <div className="flex gap-1">
                  {([1, 2, 3] as const).map((n) => (
                    <button key={n} className={segmentClass(chunkSize === n)} onClick={() => setChunkSize(n)}>{n}</button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">Mode</span>
                <div className="flex gap-1">
                  {([
                    { value: 'orp' as const, label: 'ORP' },
                    { value: 'centered' as const, label: 'Centered' },
                    { value: 'orp+context' as const, label: 'ORP + Context' },
                  ]).map(({ value, label }) => (
                    <button key={value} className={segmentClass(displayMode === value)} onClick={() => setDisplayMode(value)}>{label}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Source panel */}
        {(sourceExpanded || showSettings) && (
          <SourcePanel text={chapterText} words={engine.words} position={engine.position} />
        )}
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: upload phase
  // -----------------------------------------------------------------------

  if (phase === 'upload') {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button
            className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
            onClick={() => setPhase('library')}
          >
            ← Library
          </button>
          <h2 className="text-xl font-semibold">Add Book</h2>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div
            className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors ${
              dragging ? 'border-blue-500 bg-blue-950/20' : 'border-gray-700 hover:border-gray-600'
            }`}
            onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
          >
            {uploading ? (
              <p className="text-gray-400 text-sm">Parsing EPUB...</p>
            ) : (
              <>
                <p className="text-gray-400 mb-2 text-sm">
                  Drag and drop an EPUB file here, or{' '}
                  <label className="text-blue-400 hover:text-blue-300 cursor-pointer underline">
                    browse
                    <input type="file" accept=".epub" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                  </label>
                </p>
                <p className="text-xs text-gray-600">Supports .epub files</p>
              </>
            )}
          </div>

          {uploadError && (
            <p className="text-sm text-red-400 mt-3">{uploadError}</p>
          )}
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: library phase (default)
  // -----------------------------------------------------------------------

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Book Library</h2>
        <button
          className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          onClick={() => { setUploadError(null); setPhase('upload'); }}
        >
          Add Book
        </button>
      </div>

      {loadingLibrary ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : books.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-10 text-center">
          <p className="text-gray-400 mb-4">No books yet</p>
          <button
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            onClick={() => { setUploadError(null); setPhase('upload'); }}
          >
            Upload an EPUB
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {books
            .sort((a, b) => {
              const stateA = getReadingState(a.id);
              const stateB = getReadingState(b.id);
              return (stateB?.lastRead ?? b.addedAt) - (stateA?.lastRead ?? a.addedAt);
            })
            .map((book) => {
              const state = getReadingState(book.id);
              const chIdx = state?.currentChapter ?? 0;
              const totalWords = book.chapters.reduce((s, c) => s + c.wordCount, 0);
              const wordsBefore = book.chapters.slice(0, chIdx).reduce((s, c) => s + c.wordCount, 0);
              const overallPct = totalWords > 0 ? Math.round(((wordsBefore + (state?.position ?? 0)) / totalWords) * 100) : 0;
              const lastRead = state?.lastRead ? new Date(state.lastRead).toLocaleDateString() : null;

              return (
                <div
                  key={book.id}
                  className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors cursor-pointer"
                  onClick={() => openBook(book.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-gray-100 font-medium truncate">{book.title}</h3>
                      {book.author && <p className="text-sm text-gray-500">{book.author}</p>}
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                        <span>Chapter {chIdx + 1} / {book.chapters.length}</span>
                        <span>{overallPct}%</span>
                        {lastRead && <span>Last read: {lastRead}</span>}
                      </div>
                      {/* Mini progress bar */}
                      <div className="h-1 bg-gray-800 rounded-full mt-2 w-full">
                        <div className="h-full bg-blue-600 rounded-full" style={{ width: `${overallPct}%` }} />
                      </div>
                    </div>
                    <button
                      className="text-gray-600 hover:text-red-400 text-sm ml-3 transition-colors"
                      onClick={(e) => { e.stopPropagation(); handleRemoveBook(book.id); }}
                      title="Remove book"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/read/book/page.tsx
git commit -m "feat(book): add book reader page with library, upload, and reading phases"
```

---

### Task 8: Add navigation link

**Files:**
- Modify: `dashboard/src/app/layout.tsx:14-17`

- [ ] **Step 1: Add "Book" link to the nav bar**

In `dashboard/src/app/layout.tsx`, find the navigation links array and add a "Book" entry after "Read":

```tsx
<a href="/read" className="text-gray-400 hover:text-gray-100 transition-colors text-sm">Read</a>
<a href="/read/book" className="text-gray-400 hover:text-gray-100 transition-colors text-sm">Book</a>
```

- [ ] **Step 2: Verify build**

```bash
cd dashboard && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/layout.tsx
git commit -m "feat(nav): add Book link to dashboard navigation"
```

---

### Task 9: Run all tests and integration check

- [ ] **Step 1: Run all tests**

```bash
npm test -- --run
```

Expected: All tests pass, including new epubParser and utils tests.

- [ ] **Step 2: Start the dashboard and verify**

```bash
cd dashboard && npm run dev &
```

Then check:
1. Navigate to `/read` — existing speed reader works identically
2. Navigate to `/read/book` — shows empty library with "Upload an EPUB" prompt
3. Upload an EPUB file — parses and transitions to reading phase
4. Verify chapter dropdown populates with chapter titles
5. Verify RSVP playback works (Space to play/pause)
6. Verify "Find my place" sentence updates during playback
7. Verify Copy button copies sentence to clipboard
8. Verify `[` and `]` navigate chapters
9. Pause, reload page, navigate back to `/read/book` — book appears in library with progress
10. Click the book — resumes at saved position
11. Verify existing `/read` still works independently (paste text, play, etc.)

- [ ] **Step 3: Kill dev server and commit any fixes**

```bash
kill %1
```

If any fixes were needed, commit them with a descriptive message.
