# EPUB Book Reader — Design Spec

## Overview

A dedicated book reading page at `/read/book` that loads EPUB files, parses them into chapters, and presents them through the existing RSVP engine. Designed for switching between speed reading on the dashboard and reading the same book on a reMarkable tablet. Books persist in the browser via IndexedDB so they never need re-uploading.

Separate from the existing `/read` speed reader, which stays untouched for ad-hoc text/file reading. Both share the `useRSVPEngine` hook.

## Route & File Structure

```
dashboard/src/app/read/book/page.tsx       — Book reader page (library + reading phases)
dashboard/src/app/read/book/useBookStore.ts — IndexedDB + localStorage persistence
dashboard/src/app/read/book/epubParser.ts   — EPUB → chapter extraction
dashboard/src/app/read/useRSVPEngine.ts     — Shared engine (minor change: initialPosition support)
```

## Dependencies

- `jszip` — unzip EPUB files client-side
- No new API routes or backend changes

An EPUB is a ZIP containing XML/XHTML files. Rather than pulling in `epubjs` (which has SSR/bundler compatibility issues with Next.js and is overkill for text extraction), we use `jszip` to unzip and `DOMParser` to parse the XML metadata and XHTML chapter content directly.

## Data Model

### Book (IndexedDB)

```typescript
interface StoredBook {
  id: string;              // SHA-256 hash of first 4KB of file content
  title: string;           // from EPUB metadata (dc:title), fallback to filename
  author: string;          // from EPUB metadata (dc:creator), empty string if missing
  chapters: Chapter[];     // ordered by spine
  addedAt: number;         // timestamp
}

interface Chapter {
  title: string;           // from TOC, fallback to "Chapter N"
  text: string;            // plain text content (HTML stripped)
  wordCount: number;       // precomputed for progress display
}
```

The book ID uses a content hash of the first 4KB to avoid collisions from files with the same name and size.

### Reading State (localStorage)

```typescript
interface ReadingState {
  bookId: string;
  currentChapter: number;  // 0-indexed
  position: number;        // word index within current chapter
  wpm: number;
  chunkSize: 1 | 2 | 3;
  displayMode: 'orp' | 'centered' | 'orp+context';
  lastRead: number;        // timestamp
}
```

Key format: `book-state:{bookId}`

## Phases

The page has three phases: **library**, **upload**, and **reading**.

### Library Phase (landing state)

Shows all stored books. This is what users see on return visits.

- Each book card shows: title, author, chapter progress ("Chapter 5 / 12"), overall book progress ("42%"), last read date
- Click a book → resume reading at saved position
- "Add Book" button → switches to upload phase
- Remove button per book (confirms before deleting from IndexedDB + localStorage)
- Empty state: "No books yet" with prominent upload prompt

### Upload Phase

Minimal — just a drop zone.

- Drag-and-drop or browse for `.epub` files
- Loading spinner with "Parsing..." during extraction (large books may take a few seconds)
- On load: parse EPUB, extract chapters, store in IndexedDB
- If book already exists (same id): ask "Replace existing book? Reading progress will be reset." vs cancel
- After successful parse: transition directly to reading phase at chapter 0
- Parse error: inline error message, stay on upload phase
- IndexedDB quota error: "Storage full. Remove some books to make room."

### Reading Phase

The RSVP reader with chapter awareness and "find my place" features.

**Layout (top to bottom):**

1. **Header bar**: book title, chapter dropdown, chapter progress ("Chapter 5 / 12 — 34%"), back-to-library button
2. **RSVP display**: center of screen, same engine and display modes as existing reader
3. **"Find my place" panel**: current full sentence as static text, copy button
4. **Transport controls**: play/pause, seek, restart — same as existing reader
5. **Status bar**: WPM, chunk size, display mode indicators with keyboard hints
6. **Settings panel**: appears on pause — WPM slider, chunk size, display mode toggles
7. **Source panel**: expandable, shows chapter text with current word highlighted

## Chapter Navigation

- **Dropdown** in header lists all chapters by TOC title
- Selecting a chapter: feeds that chapter's text to the engine, resets position to 0, auto-saves state
- **Auto-advance**: completing a chapter transitions to the next one automatically (paused at word 0)
- **End of book**: completing the final chapter shows a completion screen with total stats and a "Back to Library" button
- **Keyboard**: `[` prev chapter, `]` next chapter
- Chapter changes are persisted immediately

## "Find My Place" Panel

Always visible below the RSVP display. Purpose: when switching to the reMarkable, glance at this to know where you are.

**Sentence extraction:**
- From the current word position, scan backward in the chapter text to the previous sentence-ending punctuation (`. ! ?` followed by a space or end of string, or start of text)
- Scan forward to the next sentence-ending punctuation (or end of text)
- Display the full sentence as static, readable text
- Cap at 200 characters; if longer, truncate from the left with "..." so the current word is always visible

Known limitation: abbreviations like "Dr." may cause incorrect sentence boundaries. Proper sentence detection requires NLP and is not worth the complexity.

**UI:**
- Gray text on dark background, comfortable reading size (~14-16px)
- Copy button (clipboard icon) on the right — copies sentence to clipboard
- Shows "Chapter X — Y%" label above the sentence for quick reference

## Persistence

### Auto-save triggers
- Every pause
- Every chapter change
- Every 30 seconds during playback (via interval)
- On `visibilitychange` when `document.hidden` becomes true (reliable across mobile/desktop, unlike `beforeunload`)

### Resume behavior
- Clicking a book from the library loads its reading state and jumps to the saved chapter + position
- The RSVP engine supports an `initialPosition` option so it can start at a non-zero position without a race condition (see Engine Changes below)
- Settings (WPM, chunk size, display mode) are restored

### Storage management
- IndexedDB store name: `book-reader`
- Object store: `books`
- localStorage keys: `book-state:{bookId}`
- Removing a book clears both IndexedDB entry and localStorage state

## Engine Changes

The existing `useRSVPEngine` hook resets position to 0 whenever `text` changes. For book reader resume, the hook needs a minor addition:

- Add an optional `initialPosition` field to `RSVPEngineOptions`
- In the text-change `useEffect`, use `initialPosition ?? 0` instead of hardcoded `0`
- This is backward-compatible — the existing speed reader passes no `initialPosition` and gets the current behavior

## EPUB Parsing

Using `jszip` + `DOMParser`:

1. Load EPUB from `ArrayBuffer` (from file upload) into JSZip
2. Read `META-INF/container.xml` → find the OPF file path (rootfile)
3. Parse the OPF file:
   - Extract metadata: `dc:title`, `dc:creator`
   - Read the `<spine>` element for ordered `itemref` entries
   - Read the `<manifest>` to map item IDs to file paths
4. For each spine item: read the XHTML file from the ZIP, parse with `DOMParser`, extract `textContent` from `<body>`
5. Read the TOC file (NCX or XHTML nav) for chapter titles; map to spine items by href; fallback to "Chapter N" for untitled items
6. Filter out chapters with fewer than 5 words (front matter, copyright pages)

## Keyboard Shortcuts

All existing RSVP shortcuts carry over, plus:

| Key | Action |
|-----|--------|
| `[` | Previous chapter |
| `]` | Next chapter |
| `Escape` | Back to library |

## Navigation

Add "Book" as a link in the dashboard nav bar, alongside the existing Read link. Route: `/read/book`.

## Styling

Follows existing dashboard patterns:
- Inline Tailwind CSS
- Dark theme: `bg-gray-950`, `text-gray-100`, `border-gray-800`
- Cards: `bg-gray-900 border border-gray-800 rounded-lg`
- Accent: `blue-500` for controls, `red-500` for ORP pivot
