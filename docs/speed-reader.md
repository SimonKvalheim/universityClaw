# Speed Reader (RSVP)

The `/read` page on the uniClaw dashboard presents text one word (or chunk) at a time using RSVP (Rapid Serial Visual Presentation). It's a client-side tool for speed reading uploaded documents or pasted text.

## Why RSVP?

Traditional reading is bottlenecked by eye movement — saccades between words account for a significant portion of reading time. RSVP eliminates saccades entirely by flashing words at a fixed point. Combined with ORP (Optimal Recognition Point) alignment, which positions each word so the eye naturally fixates on the right letter, it enables comfortable reading at 300-800 WPM.

## Files

| File | Purpose |
|------|---------|
| `dashboard/src/app/read/page.tsx` | Page component — input, reader, and completion phases |
| `dashboard/src/app/read/useRSVPEngine.ts` | Core engine — tokenizer, smart timing, playback |
| `dashboard/src/app/read/useRSVPEngine.test.ts` | Unit tests for all pure engine functions |
| `dashboard/public/pdf.worker.min.mjs` | PDF.js worker for client-side PDF text extraction |

## How It Works

### Phases

1. **Input** — Paste text, upload a file (.txt, .md, .pdf), or (future) pick from the vault. Configure WPM, chunk size, and display mode.
2. **Reading** — Words flash at the configured rate with smart timing. Full keyboard control.
3. **Complete** — Shows stats (time, effective WPM, word count). Option to re-read or load new text.

### RSVP Engine (`useRSVPEngine`)

The engine is a React hook that manages tokenization, timing, and playback state. All timing logic lives in pure, exported functions for testability.

**Tokenization:** Text is split line-by-line, then by whitespace. Each word gets an index and a `paragraphBreak` flag (true if preceded by a blank line).

**Smart timing:** Rather than uniform intervals, each word gets an individually computed duration based on the base WPM plus multipliers:

| Condition | Multiplier | Why |
|-----------|-----------|-----|
| Sentence-ending (. ! ?) | 2.0x | Comprehension pause at sentence boundaries |
| Clause punctuation (, ; :) | 1.5x | Shorter pause at clause boundaries |
| Long word (>8 chars) | 1.3x | More visual processing time needed |
| Paragraph break | 2.5x | Context shift, need to reset mental model |
| Contains numbers | 1.5x | Numbers require different cognitive processing |

Multipliers stack multiplicatively (e.g., long word ending a sentence = 2.6x) with a 3.0x cap to prevent excessively long pauses.

**Playback:** Uses chained `setTimeout` calls (not `setInterval`) so each word gets its own duration. State is managed through refs to avoid stale closures in the timeout chain. The hook pauses on tab background (visibility API) but does not auto-resume.

### ORP Alignment

ORP (Optimal Recognition Point) is the character position where the eye naturally wants to fixate. For English text, this is roughly:
- 1-3 chars: position 0
- 4-6 chars: position 1
- 7-9 chars: position 2
- 10+ chars: position 3

The display renders a fixed vertical guide line at the center of the screen. Each word is horizontally offset using CSS `translateX` with `ch` units (monospace font) so the ORP character sits exactly on the guide line. The ORP character is highlighted in red. This means the reader's eye never moves — only the word content changes around the fixation point.

### Chunk Size

Words can be displayed 1, 2, or 3 at a time. When chunking:
- The chunk's display duration is the **sum** of individual word durations (not the max). This keeps the effective WPM consistent — showing 2 words means showing them for twice as long, not reading twice as fast.
- ORP alignment applies to the longest word in the chunk.
- Position advances by `chunkSize` per tick.

### Display Modes

- **ORP** — Single fixation point with pivot alignment. Best for speed.
- **Centered** — Words centered without ORP offset. Simpler, some users prefer it.
- **ORP + Context** — ORP-aligned focus word with 10 words of faded context above and below. Helps maintain comprehension at lower speeds.

### PDF Text Extraction

PDF processing uses `pdfjs-dist` running entirely in the browser. The worker (`pdf.worker.min.mjs`) is copied to `public/` via a postinstall script. This is intentionally separate from the server-side Docling pipeline used for vault ingestion — Docling is heavy (process-per-file, 10min timeout, rich extraction with figures) while pdfjs-dist is instant and only needs raw text.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| Left / Right | Seek -/+ 10 seconds |
| Up / Down | WPM -/+ 25 |
| R | Restart |
| T | Toggle source panel |
| M | Cycle display mode |
| C | Cycle chunk size |

Shortcuts are disabled when any form control has focus.

## Design Decisions

**Why client-side only?** No API routes, no server state. Text processing and playback are lightweight operations that belong in the browser. This keeps the feature self-contained and instantly responsive.

**Why `setTimeout` chains instead of `setInterval`?** Each word has a different duration due to smart timing. `setInterval` would require constant adjustment. Chained timeouts naturally handle variable timing.

**Why refs alongside state?** React state is async — reading `position` inside a `setTimeout` callback would capture a stale value. Refs (`positionRef`, `isPlayingRef`, etc.) provide synchronous access to current values inside the timeout chain, while state triggers re-renders for the UI.

**Why sum chunk durations?** Early testing showed that using `Math.max` for chunk duration effectively doubled reading speed when chunk size was 2 — the WPM slider became misleading. Summing durations keeps the WPM rate honest regardless of chunk size.

## Research Sources

- DashReader (Obsidian plugin) — smart micropauses, multi-word chunks
- Sprint Reader (Chrome extension) — grammar-aware delays
- React.Spritz — clean hook-based API pattern
- Glance/OpenSpritz — ORP pivot alignment technique
- Focus Reader — context view on pause
