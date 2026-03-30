# Speed Reader (RSVP) — Design Spec

## Overview

A speed reading page for the uniClaw dashboard that presents text one word (or chunk) at a time using RSVP (Rapid Serial Visual Presentation). Supports configurable WPM, three display modes including ORP alignment, smart micropauses, and full playback controls. Designed as a standalone module that accepts text from any source, ready for future integration with vault notes and AI-generated digests.

## Research & Inspiration

The RSVP technique is well-established with many open-source implementations. Key projects studied:

- **DashReader** (Obsidian plugin, TypeScript) — most feature-rich: smart micropauses, multi-word chunks, minimap, breadcrumb navigation
- **Sprint Reader** (Chrome extension) — grammar-aware delays, configurable chunk size, multiple display algorithms
- **React.Spritz** (React component) — clean component API with `wpm`, `playing`, callbacks; closest to our architecture
- **Glance/OpenSpritz** — popularized ORP (Optimal Recognition Point) pivot letter alignment
- **Focus Reader** — auto-pacing, "context view" on pause showing surrounding paragraph
- **Bionic Reading** (React+Tailwind) — bolds first half of each word for faster fixation; complementary technique

Key UX patterns adopted: ORP alignment, smart micropauses, context display on pause, keyboard-driven controls, chunk size progression.

## Route & Navigation

- **Route:** `dashboard/src/app/read/page.tsx`
- **Nav link:** "Read" added to the dashboard navigation bar (alongside Status, Upload, Review, Vault)
- **Component type:** Client component (`'use client'`) — all processing is client-side

## Architecture

### Component Structure

Single page component with one custom hook:

```
dashboard/src/app/read/page.tsx    — page component (input + reader phases)
dashboard/src/app/read/useRSVPEngine.ts — RSVP engine hook
```

### `useRSVPEngine` Hook

Manages all reading state and timing logic.

**Input:** raw text string, WPM, chunk size

**Responsibilities:**
- Tokenize input text into word array, preserving paragraph boundaries
- Track current position (word index)
- Handle play/pause/seek/restart via chained `setTimeout` (rescheduled per word to support variable durations from smart timing)
- Calculate per-word display duration: base duration from WPM + smart timing multipliers
- Chunk words into groups of 1-3 based on chunk size setting

**Exposed interface:**
```typescript
{
  words: string[]
  position: number
  isPlaying: boolean
  progress: number          // 0-1
  currentChunk: string[]    // current word(s) being displayed
  totalWords: number
  estimatedTimeLeft: number // seconds
  play: () => void
  pause: () => void
  seek: (deltaSeconds: number) => void
  restart: () => void
  jumpTo: (position: number) => void  // for progress bar clicks
}
```

### Page Component State

Managed with `useReducer`:

```typescript
{
  phase: 'input' | 'reading' | 'complete'
  text: string
  wpm: number           // 100-800, default 250, step 25
  chunkSize: 1 | 2 | 3  // default 1
  displayMode: 'orp' | 'centered' | 'context'  // default 'orp'
  sourceExpanded: boolean  // default false during reading
}
```

## Smart Timing

Per-word display duration is calculated as `(60000 / WPM) * multiplier`. Multipliers stack **multiplicatively** when multiple conditions apply (e.g., a long word ending a sentence: 2.0 * 1.3 = 2.6x), capped at 3.0x to prevent jarring pauses. All word durations are precomputed up front during tokenization for accurate ETA calculation and progress display.

| Condition | Multiplier | Rationale |
|-----------|-----------|-----------|
| Sentence-ending punctuation (`.` `!` `?`) | 2.0x | Brain needs a beat at sentence boundaries |
| Clause punctuation (`,` `;` `:`) | 1.5x | Minor pause for clause processing |
| Word > 8 characters | 1.3x | Longer words need more recognition time |
| Paragraph break (detected during tokenization) | 2.5x | Signal a new thought/section |
| Contains numbers | 1.5x | Numeric content is harder to parse at speed |

## Display Modes

Three modes, toggleable mid-session without losing position.

### Mode A — ORP (Optimal Recognition Point)

The word is positioned so a pivot letter sits at a fixed point on screen. The pivot is highlighted in an accent color. The eye never moves.

**ORP pivot calculation:**
| Word length | Pivot index |
|-------------|-------------|
| 1-3 chars | 0 |
| 4-6 chars | 1 |
| 7-9 chars | 2 |
| 10+ chars | 3 |

For multi-word chunks: the chunk is displayed as a space-separated phrase on one line, centered as a unit. ORP pivot highlighting applies to the longest word in the chunk. The phrase is positioned so the pivot character of the longest word sits at the fixed screen point.

### Mode B — Simple Centered

Word/chunk is centered on screen. No pivot highlighting. Largest font size since no alignment constraints. Simplest visual.

### Mode C — ORP + Context

Same ORP alignment as Mode A, plus faded lines of surrounding text above and below the focus word. Context lines update as reading progresses. Provides spatial orientation without breaking focus.

### Shared Display Properties

- Font: monospace or semi-monospace (system monospace / `JetBrains Mono` if available) for consistent character widths
- Focus word size: ~40-48px
- Background: `gray-950` matching dashboard theme
- Accent color for ORP pivot: `red-500` (high contrast against white text on dark background)
- Controls accent: `blue-500`

## Input Phase

### Text Entry

Tabbed interface with three tabs:

**"Paste Text" tab (active):**
- Full-width textarea, ~300px height
- Placeholder: "Paste your text here..."
- Live word count displayed below

**"Upload File" tab:**
- Drag-and-drop zone
- Accepted formats: `.txt`, `.md`, `.pdf`
- `.txt` / `.md`: read content directly
- `.pdf`: extract text client-side using `pdfjs-dist`
- Shows filename and word count after processing

**"From Vault" tab (disabled):**
- Disabled with "Coming soon" indicator
- Future: search modal wired to existing `/api/vault` endpoint

### Settings Row

Below the text entry area:

- **WPM:** slider with numeric input, range 100-800, default 250, step 25
- **Chunk size:** segmented control `1 | 2 | 3`, default 1
- **Display mode:** segmented control `ORP | Centered | ORP + Context`, default ORP

### Start Button

- "Start Reading" — transitions to reader phase
- Disabled when no text is entered/uploaded

### Validation & Error States

- **Empty/whitespace-only input:** Start button remains disabled; no error message needed
- **PDF parse failure:** Show inline error in the upload tab: "Could not extract text from this PDF. Try a different file."
- **Very large text (>50,000 words):** Accept it, but the source panel should virtualize its rendering (or limit displayed context to ~500 words around the current position) to avoid DOM performance issues
- **Long words (URLs, identifiers >30 chars):** Scale font down proportionally for that word to fit the display area, then restore normal size on the next word

## Reader Phase

### Display Area

Central focus area rendering the current word/chunk according to the selected display mode. Generous vertical padding to create a focused, distraction-free zone.

### Progress Bar

- Horizontal bar below the display area
- Clickable — click/drag to jump to any position
- Label: `Word X / Total` and estimated time remaining (e.g., "~2:30 left")

### Transport Controls

Visual buttons with keyboard shortcuts:

| Control | Key | Behavior |
|---------|-----|----------|
| Play / Pause | `Space` | Toggle reading |
| Seek back 10s | `←` | Jump back by `(WPM / 60) * 10` words |
| Seek forward 10s | `→` | Jump forward by same amount |
| Speed down 25 WPM | `↓` | Min 100, applies live during playback |
| Speed up 25 WPM | `↑` | Max 800, applies live during playback |
| Restart | `R` | Back to word 0, paused |
| Toggle source panel | `T` | Expand/collapse source text below reader |
| Cycle display mode | `M` | ORP → Centered → ORP+Context → ORP |
| Cycle chunk size | `C` | 1 → 2 → 3 → 1 |

### Source Panel

- Collapsed by default during reading (focus-first)
- Expandable via `T` key or click
- Shows full source text with the current word/position highlighted
- Auto-scrolls to keep the current position visible

### On Pause

When the user pauses:
1. Current word stays visible in the display
2. Settings panel appears below (WPM slider, chunk size, display mode toggle)
3. Source panel auto-expands with current word highlighted
4. Resuming collapses settings and source back to reader-only

## Completion State

When all words have been displayed:

- "Finished" indicator
- Stats: total reading time, effective WPM (accounting for pauses), word count
- Two actions: "Read Again" (restart same text) and "New Text" (back to input phase)

## Keyboard Shortcut Scoping

All keyboard shortcuts are scoped to the reader phase only. During the input phase, keys behave normally (typing in textarea). Shortcuts are disabled when any interactive element has focus (inputs, sliders, buttons) — not just text inputs. This prevents Space from toggling play/pause while adjusting the WPM slider, for example.

## Dependencies

- `pdfjs-dist` — client-side PDF text extraction (new dependency); requires worker setup for Next.js (copy worker to `public/` or configure webpack/turbopack to serve it)
- No new API routes needed
- No backend changes

## Browser Tab Handling

The engine listens for `visibilitychange` events. When the browser tab is backgrounded, playback pauses automatically (browser-throttled timers would cause drift otherwise). Playback does not auto-resume when the tab is foregrounded — the user must press play.

## Seek Behavior Note

Seek forward/back 10s uses **nominal** WPM for the word count calculation (`(WPM / 60) * 10`), not effective time adjusted for smart timing multipliers. This is intentional — it keeps seek distance predictable and avoids the complexity of summing precomputed durations. The trade-off is that seeking 10s back after a paragraph with many pauses may undershoot the actual elapsed time.

## Styling

Follows existing dashboard patterns:
- Inline Tailwind CSS (no component library)
- Dark theme: `bg-gray-950`, `text-gray-100`, `border-gray-800`
- Cards/containers: `bg-gray-900 border border-gray-800 rounded-lg`
- Accent: `red-500` for ORP pivot, `blue-500` for controls and interactive elements

## Future Integration Points

Designed for extensibility without building now:

- **Vault integration:** "From Vault" tab wires to `/api/vault` search, passes note content to reader
- **Digest integration:** AI-generated reading assignments pre-fill the text input programmatically
- **Comprehension checks:** after completion state, trigger a quiz component with questions about the content
- **Spaced repetition:** log completed readings with timestamps; schedule re-reads based on learning theory intervals
- **Reading analytics:** track WPM progression over time, words read per session, streaks
