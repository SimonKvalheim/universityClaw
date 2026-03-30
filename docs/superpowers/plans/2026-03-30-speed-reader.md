# Speed Reader (RSVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/read` page to the uniClaw dashboard that presents text one word at a time using RSVP with ORP alignment, smart timing, and full playback controls.

**Architecture:** Single client-side page component with a `useRSVPEngine` custom hook. The hook manages tokenization, timing, and position. The page handles input/reader/complete phase transitions, three display modes, and keyboard controls. PDF text extraction via `pdfjs-dist` runs client-side.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, Tailwind CSS 4, pdfjs-dist

**Spec:** `docs/superpowers/specs/2026-03-30-speed-reader-design.md`

**IMPORTANT:** This dashboard is Next.js 16 which may have breaking changes from your training data. Before writing any code, check `node_modules/next/dist/docs/` for relevant API documentation. The existing pages use `'use client'` directive, `useState`/`useRef`/`useCallback` hooks, inline Tailwind classes, and `fetch()` for API calls.

---

## File Structure

```
dashboard/
├── src/app/
│   ├── layout.tsx              — MODIFY: add "Read" nav link
│   └── read/
│       ├── page.tsx            — CREATE: main page component (input/reader/complete phases)
│       └── useRSVPEngine.ts    — CREATE: RSVP engine hook (tokenizer, timer, smart timing)
└── public/
    └── pdf.worker.min.mjs      — CREATE: copied from pdfjs-dist (worker file for PDF parsing)
```

---

**Note on parallelism:** Tasks 1, 2, and 3 are fully independent and can be executed in parallel.

**Note on state management:** The spec mentions `useReducer` for page state, but the plan uses individual `useState` calls. This is an intentional simplification — the state is flat with independent fields, making `useState` cleaner. No `useReducer` needed.

---

### Task 1: Install pdfjs-dist and set up PDF worker

**Files:**
- Modify: `dashboard/package.json`
- Create: `dashboard/public/pdf.worker.min.mjs`

- [ ] **Step 1: Install pdfjs-dist**

Run from `dashboard/`:
```bash
cd dashboard && npm install pdfjs-dist
```

- [ ] **Step 2: Copy the PDF worker to public/**

The worker must be served as a static file for client-side PDF parsing.

```bash
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/pdf.worker.min.mjs
```

- [ ] **Step 3: Verify the worker file exists**

```bash
ls -la public/pdf.worker.min.mjs
```

Expected: file exists, ~300-700KB.

- [ ] **Step 4: Add a postinstall script to keep the worker in sync**

In `dashboard/package.json`, add to the `"scripts"` section:

```json
"postinstall": "cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/pdf.worker.min.mjs"
```

This ensures the worker file is refreshed whenever `pdfjs-dist` is updated via `npm install`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json public/pdf.worker.min.mjs
git commit -m "feat(read): install pdfjs-dist and set up PDF worker"
```

---

### Task 2: Add "Read" link to navigation

**Files:**
- Modify: `dashboard/src/app/layout.tsx`

- [ ] **Step 1: Add the Read nav link**

In `dashboard/src/app/layout.tsx`, add a "Read" link after "Vault" in the nav:

```tsx
<div className="flex gap-6 text-sm text-gray-400">
  <a href="/" className="hover:text-gray-100">Status</a>
  <a href="/upload" className="hover:text-gray-100">Upload</a>
  <a href="/review" className="hover:text-gray-100">Review</a>
  <a href="/vault" className="hover:text-gray-100">Vault</a>
  <a href="/read" className="hover:text-gray-100">Read</a>
</div>
```

- [ ] **Step 2: Verify the dashboard builds**

```bash
cd dashboard && npm run build
```

Expected: build succeeds (the /read route won't exist yet, but the nav link is valid).

- [ ] **Step 3: Commit**

```bash
git add src/app/layout.tsx
git commit -m "feat(read): add Read link to dashboard navigation"
```

---

### Task 3: Build the RSVP engine hook — tokenizer and smart timing

**Files:**
- Create: `dashboard/src/app/read/useRSVPEngine.ts`

This is the core engine. We build it in two tasks: this task covers tokenization and smart timing (pure functions, no React), and Task 4 adds the playback logic.

- [ ] **Step 1: Create the tokenizer and timing functions**

Create `dashboard/src/app/read/useRSVPEngine.ts`:

```typescript
'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

// --- Types ---

interface TokenizedWord {
  word: string;
  index: number;           // position in the words array
  paragraphBreak: boolean; // true if preceded by a paragraph break
  duration: number;        // ms, computed from base + multipliers
}

interface RSVPEngineOptions {
  text: string;
  wpm: number;
  chunkSize: 1 | 2 | 3;
}

interface RSVPEngineState {
  words: TokenizedWord[];
  position: number;
  isPlaying: boolean;
  progress: number;
  currentChunk: TokenizedWord[];
  totalWords: number;
  estimatedTimeLeft: number;
  play: () => void;
  pause: () => void;
  seek: (deltaSeconds: number) => void;
  restart: () => void;
  jumpTo: (position: number) => void;
}

// --- ORP ---

export function getORPIndex(word: string): number {
  const len = word.length;
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  if (len <= 9) return 2;
  return 3;
}

// --- Tokenizer ---

export function tokenize(text: string): Omit<TokenizedWord, 'duration'>[] {
  const lines = text.split(/\n/);
  const result: Omit<TokenizedWord, 'duration'>[] = [];
  let index = 0;
  let prevLineEmpty = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      prevLineEmpty = true;
      continue;
    }

    const words = trimmed.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      if (words[i] === '') continue;
      result.push({
        word: words[i],
        index,
        paragraphBreak: prevLineEmpty && i === 0 && index > 0,
      });
      index++;
      if (i === 0) prevLineEmpty = false;
    }
  }

  return result;
}

// --- Smart Timing ---

export function computeDuration(
  word: TokenizedWord | Omit<TokenizedWord, 'duration'>,
  baseMs: number,
): number {
  let multiplier = 1.0;

  // Sentence-ending punctuation
  if (/[.!?]$/.test(word.word)) {
    multiplier *= 2.0;
  }
  // Clause punctuation (only if not already sentence-ending)
  else if (/[,;:]$/.test(word.word)) {
    multiplier *= 1.5;
  }

  // Long words (>8 chars, strip trailing punctuation for length check)
  const stripped = word.word.replace(/[^a-zA-Z0-9\u00C0-\u024F]/g, '');
  if (stripped.length > 8) {
    multiplier *= 1.3;
  }

  // Paragraph break
  if (word.paragraphBreak) {
    multiplier *= 2.5;
  }

  // Contains numbers
  if (/\d/.test(word.word)) {
    multiplier *= 1.5;
  }

  // Cap at 3.0x
  multiplier = Math.min(multiplier, 3.0);

  return baseMs * multiplier;
}

export function tokenizeWithDurations(text: string, wpm: number): TokenizedWord[] {
  const baseMs = 60000 / wpm;
  const rawTokens = tokenize(text);
  return rawTokens.map((t) => ({
    ...t,
    duration: computeDuration(t, baseMs),
  }));
}

// --- Chunk helper ---

export function getChunk(words: TokenizedWord[], position: number, chunkSize: number): TokenizedWord[] {
  const start = position;
  const end = Math.min(position + chunkSize, words.length);
  return words.slice(start, end);
}

// --- Estimated time remaining ---

export function computeTimeLeft(words: TokenizedWord[], position: number): number {
  let totalMs = 0;
  for (let i = position; i < words.length; i++) {
    totalMs += words[i].duration;
  }
  return totalMs / 1000;
}
```

- [ ] **Step 2: Verify the file compiles**

```bash
cd dashboard && npx tsc --noEmit src/app/read/useRSVPEngine.ts 2>&1 || true
```

This may show warnings about module resolution, which is fine. The real test is the full build later. Just verify no syntax errors in the output.

- [ ] **Step 3: Commit**

```bash
git add src/app/read/useRSVPEngine.ts
git commit -m "feat(read): add RSVP tokenizer and smart timing functions"
```

---

### Task 4: Build the RSVP engine hook — playback logic

**Files:**
- Modify: `dashboard/src/app/read/useRSVPEngine.ts`

- [ ] **Step 1: Add the useRSVPEngine hook**

Append to the bottom of `dashboard/src/app/read/useRSVPEngine.ts`:

```typescript
// --- Hook ---

export function useRSVPEngine(options: RSVPEngineOptions): RSVPEngineState {
  const { text, wpm, chunkSize } = options;

  const [words, setWords] = useState<TokenizedWord[]>([]);
  const [position, setPosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionRef = useRef(0);
  const wordsRef = useRef<TokenizedWord[]>([]);
  const isPlayingRef = useRef(false);
  const chunkSizeRef = useRef(chunkSize);

  // Keep refs in sync
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { wordsRef.current = words; }, [words]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { chunkSizeRef.current = chunkSize; }, [chunkSize]);

  // Re-tokenize when text or WPM changes
  useEffect(() => {
    if (!text.trim()) {
      setWords([]);
      setPosition(0);
      return;
    }
    const tokenized = tokenizeWithDurations(text, wpm);
    setWords(tokenized);
    wordsRef.current = tokenized;
  }, [text, wpm]);

  // Clear timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Visibility change: pause on tab background
  useEffect(() => {
    function handleVisibility() {
      if (document.hidden && isPlayingRef.current) {
        pause();
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const scheduleNext = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const w = wordsRef.current;
    const pos = positionRef.current;
    const cs = chunkSizeRef.current;

    if (pos >= w.length) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      return;
    }

    // Duration for the current chunk is the max duration of words in the chunk
    const chunk = getChunk(w, pos, cs);
    const duration = Math.max(...chunk.map((t) => t.duration));

    timerRef.current = setTimeout(() => {
      const nextPos = Math.min(positionRef.current + chunkSizeRef.current, wordsRef.current.length);
      positionRef.current = nextPos;
      setPosition(nextPos);

      if (nextPos >= wordsRef.current.length) {
        setIsPlaying(false);
        isPlayingRef.current = false;
      } else if (isPlayingRef.current) {
        scheduleNext();
      }
    }, duration);
  }, []);

  const play = useCallback(() => {
    if (positionRef.current >= wordsRef.current.length) return;
    setIsPlaying(true);
    isPlayingRef.current = true;
    scheduleNext();
  }, [scheduleNext]);

  const pause = useCallback(() => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const seek = useCallback((deltaSeconds: number) => {
    const wordDelta = Math.round((wpm / 60) * Math.abs(deltaSeconds));
    const direction = deltaSeconds > 0 ? 1 : -1;
    const newPos = Math.max(0, Math.min(wordsRef.current.length - 1, positionRef.current + direction * wordDelta));
    positionRef.current = newPos;
    setPosition(newPos);

    // If playing, restart the timer from the new position
    if (isPlayingRef.current) {
      if (timerRef.current) clearTimeout(timerRef.current);
      scheduleNext();
    }
  }, [wpm, scheduleNext]);

  const restart = useCallback(() => {
    pause();
    positionRef.current = 0;
    setPosition(0);
  }, [pause]);

  const jumpTo = useCallback((pos: number) => {
    const clamped = Math.max(0, Math.min(wordsRef.current.length - 1, pos));
    positionRef.current = clamped;
    setPosition(clamped);

    if (isPlayingRef.current) {
      if (timerRef.current) clearTimeout(timerRef.current);
      scheduleNext();
    }
  }, [scheduleNext]);

  const totalWords = words.length;
  const progress = totalWords > 0 ? position / totalWords : 0;
  const currentChunk = words.length > 0 ? getChunk(words, position, chunkSize) : [];
  const estimatedTimeLeft = words.length > 0 ? computeTimeLeft(words, position) : 0;

  return {
    words,
    position,
    isPlaying,
    progress,
    currentChunk,
    totalWords,
    estimatedTimeLeft,
    play,
    pause,
    seek,
    restart,
    jumpTo,
  };
}
```

- [ ] **Step 2: Verify the file compiles**

```bash
cd dashboard && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors from `useRSVPEngine.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/app/read/useRSVPEngine.ts
git commit -m "feat(read): add RSVP engine playback hook with visibility handling"
```

---

### Task 5: Build the page — input phase

**Files:**
- Create: `dashboard/src/app/read/page.tsx`

- [ ] **Step 1: Create the page with input phase**

Create `dashboard/src/app/read/page.tsx`:

```tsx
'use client';

import { useState, useRef, useCallback, useEffect, DragEvent } from 'react';
import { useRSVPEngine, getORPIndex } from './useRSVPEngine';

type DisplayMode = 'orp' | 'centered' | 'context';
type Phase = 'input' | 'reading' | 'complete';
type InputTab = 'paste' | 'upload' | 'vault';

export default function ReadPage() {
  // --- Input phase state ---
  const [phase, setPhase] = useState<Phase>('input');
  const [text, setText] = useState('');
  const [wpm, setWpm] = useState(250);
  const [chunkSize, setChunkSize] = useState<1 | 2 | 3>(1);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('orp');
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [inputTab, setInputTab] = useState<InputTab>('paste');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const readingStartTime = useRef<number>(0);
  const totalPauseTime = useRef<number>(0);
  const lastPauseStart = useRef<number>(0);

  // --- Engine ---
  const engine = useRSVPEngine({ text, wpm, chunkSize });

  // --- Word count ---
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  // --- File handling ---
  async function handleFile(file: File) {
    setUploadError(null);
    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext === 'txt' || ext === 'md') {
      const content = await file.text();
      setText(content);
      setUploadedFileName(file.name);
    } else if (ext === 'pdf') {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let fullText = '';

        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items
            .map((item: any) => ('str' in item ? item.str : ''))
            .join(' ');
          fullText += pageText + '\n\n';
        }

        setText(fullText.trim());
        setUploadedFileName(file.name);
      } catch {
        setUploadError('Could not extract text from this PDF. Try a different file.');
      }
    } else {
      setUploadError(`Unsupported file type: .${ext}. Use .txt, .md, or .pdf`);
    }
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  // --- Start reading ---
  function startReading() {
    if (!text.trim()) return;
    setPhase('reading');
    setSourceExpanded(false);
    readingStartTime.current = Date.now();
    totalPauseTime.current = 0;
    engine.restart();
    engine.play();
  }

  // --- Tab classes ---
  function tabClass(tab: InputTab, disabled = false) {
    if (disabled) return 'px-4 py-2 text-sm text-gray-600 cursor-not-allowed';
    return `px-4 py-2 text-sm cursor-pointer ${
      inputTab === tab
        ? 'text-gray-100 border-b-2 border-blue-500'
        : 'text-gray-400 hover:text-gray-200'
    }`;
  }

  // --- Segmented control helper ---
  function segmentClass(active: boolean) {
    return `px-3 py-1.5 text-sm rounded transition-colors ${
      active
        ? 'bg-blue-600 text-white'
        : 'bg-gray-800 text-gray-400 hover:text-gray-200 cursor-pointer'
    }`;
  }

  // ==================== INPUT PHASE ====================
  if (phase === 'input') {
    return (
      <div className="max-w-2xl mx-auto">
        <h2 className="text-xl font-semibold mb-6">Speed Reader</h2>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-800 mb-4">
          <button className={tabClass('paste')} onClick={() => setInputTab('paste')}>
            Paste Text
          </button>
          <button className={tabClass('upload')} onClick={() => setInputTab('upload')}>
            Upload File
          </button>
          <button className={tabClass('vault', true)} title="Coming soon">
            From Vault
          </button>
        </div>

        {/* Paste tab */}
        {inputTab === 'paste' && (
          <div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste your text here..."
              className="w-full h-72 bg-gray-900 border border-gray-800 rounded-lg p-4 text-gray-100 text-sm resize-none focus:outline-none focus:border-gray-600"
            />
            <div className="text-gray-500 text-sm mt-1">{wordCount} words</div>
          </div>
        )}

        {/* Upload tab */}
        {inputTab === 'upload' && (
          <div>
            {uploadError && (
              <div className="mb-3 px-4 py-3 rounded bg-red-900 text-red-100 text-sm">
                {uploadError}
              </div>
            )}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
                dragging
                  ? 'border-blue-500 bg-blue-950'
                  : 'border-gray-700 hover:border-gray-500 bg-gray-900'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.pdf"
                className="hidden"
                onChange={handleFileInput}
              />
              {uploadedFileName ? (
                <div>
                  <p className="text-gray-200 font-medium">{uploadedFileName}</p>
                  <p className="text-gray-500 text-sm mt-1">{wordCount} words extracted</p>
                </div>
              ) : (
                <div>
                  <p className="text-gray-400">Drag & drop a file here, or click to select</p>
                  <p className="text-gray-600 text-sm mt-1">.txt, .md, or .pdf</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Vault tab (disabled) */}
        {inputTab === 'vault' && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-10 text-center">
            <p className="text-gray-500">Vault search coming soon</p>
          </div>
        )}

        {/* Settings */}
        <div className="mt-6 space-y-4">
          {/* WPM */}
          <div className="flex items-center gap-4">
            <label className="text-sm text-gray-400 w-28">WPM</label>
            <input
              type="range"
              min={100}
              max={800}
              step={25}
              value={wpm}
              onChange={(e) => setWpm(Number(e.target.value))}
              className="flex-1 accent-blue-500"
            />
            <input
              type="number"
              min={100}
              max={800}
              step={25}
              value={wpm}
              onChange={(e) => setWpm(Math.max(100, Math.min(800, Number(e.target.value))))}
              className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-center text-gray-100"
            />
          </div>

          {/* Chunk size */}
          <div className="flex items-center gap-4">
            <label className="text-sm text-gray-400 w-28">Chunk size</label>
            <div className="flex gap-1">
              {([1, 2, 3] as const).map((n) => (
                <button
                  key={n}
                  onClick={() => setChunkSize(n)}
                  className={segmentClass(chunkSize === n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* Display mode */}
          <div className="flex items-center gap-4">
            <label className="text-sm text-gray-400 w-28">Display</label>
            <div className="flex gap-1">
              {([
                ['orp', 'ORP'],
                ['centered', 'Centered'],
                ['context', 'ORP + Context'],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setDisplayMode(mode as DisplayMode)}
                  className={segmentClass(displayMode === mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Start button */}
        <button
          onClick={startReading}
          disabled={!text.trim()}
          className="mt-6 w-full px-4 py-3 rounded-lg bg-blue-700 hover:bg-blue-600 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Start Reading
        </button>
      </div>
    );
  }

  // ==================== READING + COMPLETE PHASES (Task 6 & 7) ====================
  return (
    <div className="max-w-2xl mx-auto text-center py-20">
      <p className="text-gray-500">Reader phase — coming in next task</p>
    </div>
  );
}
```

- [ ] **Step 2: Verify the dashboard builds and the page renders**

```bash
cd dashboard && npm run build
```

Expected: build succeeds. Then run `npm run dev` and navigate to `http://localhost:3000/read` to verify the input phase renders with tabs, settings, and the Start button.

- [ ] **Step 3: Commit**

```bash
git add src/app/read/page.tsx
git commit -m "feat(read): add speed reader input phase with paste, upload, and settings"
```

---

### Task 6: Build the page — reader phase with display modes

**Files:**
- Modify: `dashboard/src/app/read/page.tsx`

- [ ] **Step 1: Add the ORP display component**

Insert these helper components above the `ReadPage` default export in `page.tsx`:

```tsx
// --- Display helpers ---

function ORPDisplay({ chunk, fontSize }: { chunk: { word: string }[]; fontSize: number }) {
  if (chunk.length === 0) return null;

  // Find longest word for ORP alignment
  let longestIdx = 0;
  for (let i = 1; i < chunk.length; i++) {
    if (chunk[i].word.length > chunk[longestIdx].word.length) longestIdx = i;
  }

  const pivotWord = chunk[longestIdx].word;
  const pivotCharIdx = getORPIndex(pivotWord);

  return (
    <div className="relative flex items-center justify-center" style={{ minHeight: fontSize * 1.5 }}>
      {/* Fixed center line */}
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-800" />

      <div className="flex items-baseline gap-[0.3em]" style={{ fontFamily: 'ui-monospace, monospace', fontSize }}>
        {chunk.map((token, i) => {
          if (i === longestIdx) {
            // This word gets ORP treatment
            const before = pivotWord.slice(0, pivotCharIdx);
            const pivot = pivotWord[pivotCharIdx] || '';
            const after = pivotWord.slice(pivotCharIdx + 1);

            // Calculate offset to center the pivot character
            // Each character is ~0.6em in monospace
            const charWidth = fontSize * 0.6;
            const offsetChars = pivotCharIdx - (pivotWord.length / 2);
            const offset = offsetChars * charWidth;

            return (
              <span key={i} style={{ position: 'relative', left: -offset }}>
                <span className="text-gray-300">{before}</span>
                <span className="text-red-500 font-bold">{pivot}</span>
                <span className="text-gray-300">{after}</span>
              </span>
            );
          }
          return <span key={i} className="text-gray-300">{token.word}</span>;
        })}
      </div>
    </div>
  );
}

function CenteredDisplay({ chunk, fontSize }: { chunk: { word: string }[]; fontSize: number }) {
  const text = chunk.map((t) => t.word).join(' ');
  return (
    <div className="flex items-center justify-center" style={{ minHeight: fontSize * 1.5 }}>
      <span
        className="text-gray-100"
        style={{ fontFamily: 'ui-monospace, monospace', fontSize }}
      >
        {text}
      </span>
    </div>
  );
}

function ContextDisplay({
  chunk,
  words,
  position,
  fontSize,
}: {
  chunk: { word: string }[];
  words: { word: string }[];
  position: number;
  fontSize: number;
}) {
  // Get surrounding context (10 words before and after)
  const contextBefore = words
    .slice(Math.max(0, position - 10), position)
    .map((w) => w.word)
    .join(' ');
  const contextAfter = words
    .slice(position + chunk.length, position + chunk.length + 10)
    .map((w) => w.word)
    .join(' ');

  return (
    <div className="flex flex-col items-center gap-3" style={{ minHeight: fontSize * 3 }}>
      <div className="text-gray-700 text-sm max-w-lg text-center truncate">
        {contextBefore}
      </div>
      <ORPDisplay chunk={chunk} fontSize={fontSize} />
      <div className="text-gray-700 text-sm max-w-lg text-center truncate">
        {contextAfter}
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- Font size for long words ---
function getFontSize(chunk: { word: string }[]): number {
  const maxLen = Math.max(...chunk.map((t) => t.word.length));
  if (maxLen > 30) return Math.max(20, Math.floor(44 * (30 / maxLen)));
  return 44;
}
```

- [ ] **Step 2: Add reader/complete phase logic and replace the placeholder return**

This step adds code in **two locations** inside the `ReadPage` function:

1. **Before the `if (phase === 'input')` block:** Insert the `useEffect` hooks, `completionStats` state, `engineRef`, and computed values. These are React hooks and must appear before any conditional returns.
2. **Replace the final placeholder `return`** (the `"Reader phase — coming in next task"` block) with the complete and reading phase JSX.

Replace everything from the `// ==================== READING + COMPLETE PHASES` comment through the closing `);` and `}` of the placeholder with:

```tsx
  // --- Track pause time ---
  useEffect(() => {
    if (phase !== 'reading') return;
    if (!engine.isPlaying) {
      lastPauseStart.current = Date.now();
    } else if (lastPauseStart.current > 0) {
      totalPauseTime.current += Date.now() - lastPauseStart.current;
      lastPauseStart.current = 0;
    }
  }, [engine.isPlaying, phase]);

  // --- Completion stats (computed once on transition to complete) ---
  const [completionStats, setCompletionStats] = useState<{
    totalTime: number;
    effectiveWpm: number;
  } | null>(null);

  // --- Detect completion ---
  useEffect(() => {
    if (
      phase === 'reading' &&
      !engine.isPlaying &&
      engine.position >= engine.totalWords &&
      engine.totalWords > 0
    ) {
      if (lastPauseStart.current > 0) {
        totalPauseTime.current += Date.now() - lastPauseStart.current;
        lastPauseStart.current = 0;
      }
      const totalTime = (Date.now() - readingStartTime.current - totalPauseTime.current) / 1000;
      const effectiveWpm = totalTime > 0 ? Math.round(engine.totalWords / (totalTime / 60)) : 0;
      setCompletionStats({ totalTime, effectiveWpm });
      setPhase('complete');
    }
  }, [engine.isPlaying, engine.position, engine.totalWords, phase]);

  // --- Engine ref for stable keyboard handler ---
  const engineRef = useRef(engine);
  useEffect(() => { engineRef.current = engine; }, [engine]);

  // --- Keyboard shortcuts ---
  useEffect(() => {
    if (phase !== 'reading' && phase !== 'complete') return;

    function handleKey(e: KeyboardEvent) {
      // Don't capture when interactive elements are focused
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      if ((e.target as HTMLElement).getAttribute('role') === 'slider') return;

      const eng = engineRef.current;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          eng.isPlaying ? eng.pause() : eng.play();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          eng.seek(-10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          eng.seek(10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setWpm((w) => Math.min(800, w + 25));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setWpm((w) => Math.max(100, w - 25));
          break;
        case 'KeyR':
          e.preventDefault();
          eng.restart();
          setPhase('reading');
          break;
        case 'KeyT':
          e.preventDefault();
          setSourceExpanded((v) => !v);
          break;
        case 'KeyM':
          e.preventDefault();
          setDisplayMode((m) => {
            if (m === 'orp') return 'centered';
            if (m === 'centered') return 'context';
            return 'orp';
          });
          break;
        case 'KeyC':
          e.preventDefault();
          setChunkSize((c) => {
            if (c === 1) return 2;
            if (c === 2) return 3;
            return 1;
          });
          break;
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [phase]);

  const fontSize = getFontSize(engine.currentChunk);
  const showSettings = !engine.isPlaying && phase === 'reading';

  // ==================== COMPLETE PHASE ====================
  if (phase === 'complete') {
    return (
      <div className="max-w-2xl mx-auto text-center py-20">
        <h2 className="text-2xl font-semibold mb-4 text-gray-100">Finished</h2>
        <div className="flex justify-center gap-8 mb-8 text-sm">
          <div>
            <div className="text-gray-500">Time</div>
            <div className="text-gray-200 text-lg">{formatTime(completionStats?.totalTime ?? 0)}</div>
          </div>
          <div>
            <div className="text-gray-500">Effective WPM</div>
            <div className="text-gray-200 text-lg">{completionStats?.effectiveWpm ?? 0}</div>
          </div>
          <div>
            <div className="text-gray-500">Words</div>
            <div className="text-gray-200 text-lg">{engine.totalWords}</div>
          </div>
        </div>
        <div className="flex justify-center gap-4">
          <button
            onClick={() => { engine.restart(); setPhase('reading'); setTimeout(() => engine.play(), 50); }}
            className="px-6 py-2.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white font-medium transition-colors"
          >
            Read Again
          </button>
          <button
            onClick={() => { engine.restart(); setPhase('input'); }}
            className="px-6 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 font-medium transition-colors"
          >
            New Text
          </button>
        </div>
      </div>
    );
  }

  // ==================== READING PHASE ====================
  return (
    <div className="max-w-2xl mx-auto">
      {/* Display area */}
      <div className="py-20 px-4">
        {displayMode === 'orp' && (
          <ORPDisplay chunk={engine.currentChunk} fontSize={fontSize} />
        )}
        {displayMode === 'centered' && (
          <CenteredDisplay chunk={engine.currentChunk} fontSize={fontSize} />
        )}
        {displayMode === 'context' && (
          <ContextDisplay
            chunk={engine.currentChunk}
            words={engine.words}
            position={engine.position}
            fontSize={fontSize}
          />
        )}
      </div>

      {/* Progress bar */}
      <div className="mb-4">
        <div
          className="h-2 bg-gray-800 rounded-full cursor-pointer"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const fraction = (e.clientX - rect.left) / rect.width;
            engine.jumpTo(Math.floor(fraction * engine.totalWords));
          }}
        >
          <div
            className="h-2 bg-blue-600 rounded-full transition-all duration-100"
            style={{ width: `${engine.progress * 100}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          <span>Word {engine.position} / {engine.totalWords}</span>
          <span>~{formatTime(engine.estimatedTimeLeft)} left</span>
        </div>
      </div>

      {/* Transport controls */}
      <div className="flex items-center justify-center gap-4 text-sm">
        <button
          onClick={() => engine.seek(-10)}
          className="px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-gray-100 transition-colors"
          title="Seek back 10s (←)"
        >
          ←10s
        </button>
        <button
          onClick={() => engine.isPlaying ? engine.pause() : engine.play()}
          className="px-5 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-white font-medium transition-colors"
          title="Play/Pause (Space)"
        >
          {engine.isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        <button
          onClick={() => engine.seek(10)}
          className="px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-gray-100 transition-colors"
          title="Seek forward 10s (→)"
        >
          10s→
        </button>
        <button
          onClick={() => engine.restart()}
          className="px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-gray-100 transition-colors"
          title="Restart (R)"
        >
          ↺
        </button>
      </div>

      {/* Status bar */}
      <div className="flex justify-center gap-4 mt-3 text-xs text-gray-500">
        <span>{wpm} WPM (↑↓)</span>
        <span>Chunk: {chunkSize} (C)</span>
        <span>{displayMode === 'orp' ? 'ORP' : displayMode === 'centered' ? 'Centered' : 'ORP+Context'} (M)</span>
        <span>Source (T)</span>
      </div>

      {/* Settings panel (visible on pause) */}
      {showSettings && (
        <div className="mt-6 p-4 bg-gray-900 border border-gray-800 rounded-lg space-y-3">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Settings</div>
          {/* WPM */}
          <div className="flex items-center gap-4">
            <label className="text-sm text-gray-400 w-28">WPM</label>
            <input
              type="range"
              min={100}
              max={800}
              step={25}
              value={wpm}
              onChange={(e) => setWpm(Number(e.target.value))}
              className="flex-1 accent-blue-500"
            />
            <span className="text-sm text-gray-300 w-12 text-right">{wpm}</span>
          </div>
          {/* Chunk size */}
          <div className="flex items-center gap-4">
            <label className="text-sm text-gray-400 w-28">Chunk size</label>
            <div className="flex gap-1">
              {([1, 2, 3] as const).map((n) => (
                <button
                  key={n}
                  onClick={() => setChunkSize(n)}
                  className={segmentClass(chunkSize === n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          {/* Display mode */}
          <div className="flex items-center gap-4">
            <label className="text-sm text-gray-400 w-28">Display</label>
            <div className="flex gap-1">
              {([
                ['orp', 'ORP'],
                ['centered', 'Centered'],
                ['context', 'ORP + Context'],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setDisplayMode(mode as DisplayMode)}
                  className={segmentClass(displayMode === mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Source panel */}
      <div className="mt-4">
        <button
          onClick={() => setSourceExpanded((v) => !v)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {sourceExpanded ? '▼ Hide source text' : '▶ Show source text'}
        </button>
        {(sourceExpanded || showSettings) && (
          <SourcePanel text={text} position={engine.position} />
        )}
      </div>
    </div>
  );
```

- [ ] **Step 3: Add the SourcePanel component**

Insert above the `ReadPage` default export, after the other display helpers:

```tsx
function SourcePanel({ text, position }: { text: string; position: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLSpanElement>(null);

  // Split into words for highlighting
  const allWords = text.trim().split(/\s+/);

  // Limit display to ~500 words around position for performance
  const windowStart = Math.max(0, position - 250);
  const windowEnd = Math.min(allWords.length, position + 250);
  const prefix = windowStart > 0 ? '... ' : '';
  const suffix = windowEnd < allWords.length ? ' ...' : '';

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [position]);

  return (
    <div
      ref={containerRef}
      className="mt-2 max-h-48 overflow-y-auto bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm leading-relaxed"
    >
      <span className="text-gray-600">{prefix}</span>
      {allWords.slice(windowStart, windowEnd).map((word, i) => {
        const globalIdx = windowStart + i;
        const isHighlighted = globalIdx === position;
        return (
          <span key={globalIdx}>
            {isHighlighted ? (
              <span ref={highlightRef} className="bg-blue-900 text-blue-200 px-0.5 rounded">
                {word}
              </span>
            ) : (
              <span className="text-gray-600">{word}</span>
            )}
            {' '}
          </span>
        );
      })}
      <span className="text-gray-600">{suffix}</span>
    </div>
  );
}
```

Note: `SourcePanel` uses a `useRef` import — this is already imported at the top of the file.

- [ ] **Step 4: Verify the dashboard builds**

```bash
cd dashboard && npm run build
```

Expected: build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/read/page.tsx
git commit -m "feat(read): add reader phase with display modes, controls, and source panel"
```

---

### Task 7: Manual integration test

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

```bash
cd dashboard && npm run dev
```

- [ ] **Step 2: Test the input phase**

Navigate to `http://localhost:3000/read`. Verify:
- [ ] Page title shows "Speed Reader"
- [ ] Three tabs: "Paste Text" (active), "Upload File", "From Vault" (greyed out)
- [ ] Typing in the textarea updates the word count live
- [ ] Start Reading button is disabled when textarea is empty
- [ ] WPM slider works and updates the number input
- [ ] Chunk size and display mode segmented controls work

- [ ] **Step 3: Test paste and read**

Paste a paragraph of text (at least 50 words). Click "Start Reading". Verify:
- [ ] Transitions to reader phase
- [ ] Words appear one at a time
- [ ] Progress bar advances
- [ ] Word count and ETA display correctly

- [ ] **Step 4: Test playback controls**

- [ ] Press Space to pause — settings panel and source text appear
- [ ] Press Space to resume — settings and source collapse
- [ ] Press ← and → to seek back/forward
- [ ] Press ↑ and ↓ to adjust WPM
- [ ] Press M to cycle display modes (ORP → Centered → ORP+Context)
- [ ] Press C to cycle chunk size (1 → 2 → 3)
- [ ] Press T to toggle source panel
- [ ] Press R to restart
- [ ] Click on the progress bar to jump to a position

- [ ] **Step 5: Test display modes**

- [ ] ORP mode: pivot letter highlighted in red, word aligned to center point
- [ ] Centered mode: word centered, no highlighting
- [ ] ORP+Context mode: context lines above and below

- [ ] **Step 6: Test file upload**

Switch to "Upload File" tab. Upload a `.txt` file. Verify text is extracted and word count displays. Upload a `.pdf` file. Verify text extraction works.

- [ ] **Step 7: Test completion**

Let a short text (~20 words) play to completion. Verify:
- [ ] "Finished" screen appears with stats (time, effective WPM, word count)
- [ ] "Read Again" restarts the same text
- [ ] "New Text" goes back to input phase

- [ ] **Step 8: Test edge cases**

- [ ] Switch browser tabs while playing — verify it auto-pauses
- [ ] Paste text with punctuation — verify longer pauses at periods and commas
- [ ] Paste text with paragraph breaks — verify extra pause between paragraphs

- [ ] **Step 9: Commit if any fixes were needed**

If any issues were discovered and fixed during testing:
```bash
git add -A
git commit -m "fix(read): address issues found during integration testing"
```
