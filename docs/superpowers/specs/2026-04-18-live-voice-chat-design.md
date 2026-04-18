# Live Voice Chat — Design Spec

## Overview

A new dashboard surface at `/voice` that enables real-time spoken conversation with two distinct personas:

- **Mr. Rogers Live** — the existing teaching assistant, reachable by voice from the desk. Shares state with the Telegram Mr. Rogers so a concept discussed by voice is remembered when the next text exchange happens.
- **Dev Assistant** — a new brainstorming partner for uniClaw feature work. Read-only on the codebase, can draft specs, plans, and HTML/mermaid mockups. Not a replacement for Claude Code; a complement for thinking out loud.

Both personas share one infrastructure — a Gemini 3.1 Flash Live session opened from the browser — and differ only in system prompt, tool surface, startup context, and default voice.

Separate from existing async voice flow on Telegram (voice note → transcription → agent → voice note). That flow keeps its own provider migration path and is out of scope here.

## Goals

- **Zero to talking in <5 seconds** — click mic, start speaking.
- **Captions always visible** — you can reread what was just said.
- **Preview pane** — HTML mockups and mermaid diagrams render as they are written.
- **Transcripts preserved** — every session leaves durable artifacts.
- **Future-friendly boundaries** — adding session resumption, phone delivery, or more personas later is additive, not a rewrite.

## Non-Goals (v1)

- Session resumption beyond the 15-minute Live API cap. Sessions end; you start a fresh one. The frontend abstraction leaves room for adding resumption later.
- Phone / Twilio / mobile apps. Dashboard-only.
- Multi-user. Single-user, localhost. No auth beyond whatever gates the dashboard itself (none today — see Security).
- Voice cloning or custom voices. Use prebuilt Gemini voices only.
- Tool-use approval UI for Dev writes. Mockups and specs are cheap to revert via git; an approval step adds friction without much safety gain.
- Barge-in tuning. Use Gemini's default VAD.

## Route & File Structure

```
dashboard/src/app/voice/page.tsx                           — The page (persona toggle, mic, captions, preview)
dashboard/src/app/voice/voice-session.ts                   — VoiceSession class: WS lifecycle, audio I/O, event stream
dashboard/src/app/voice/audio-io.ts                        — Mic capture + playback helpers (Web Audio API)
dashboard/src/app/voice/personas.ts                        — Persona configs (system prompts, tool declarations, voice, context loader)
dashboard/src/app/voice/preview-pane.tsx                   — Renders latest mockup (iframe) or diagram (mermaid)
dashboard/src/app/voice/captions.tsx                       — Scrolling transcript view
dashboard/src/app/api/voice/token/route.ts                 — Mints ephemeral token for Live API
dashboard/src/app/api/voice/context/[persona]/route.ts     — Returns startup context payload per persona
dashboard/src/app/api/voice/tools/[persona]/[tool]/route.ts — Executes a tool call forwarded from the browser
dashboard/src/app/api/voice/session-close/route.ts         — Persists transcript per persona rules
docs/superpowers/mockups/YYYY-MM-DD-<slug>.html            — Dev-written HTML+Tailwind mockups (new dir)
docs/superpowers/mockups/YYYY-MM-DD-<slug>.md              — Dev-written mermaid diagrams (same dir, .md)
docs/superpowers/brainstorm-sessions/YYYY-MM-DD-HHMM.md    — Dev session transcripts (new dir)
```

## Dependencies

- `@google/genai` — Google Gen AI SDK (TypeScript). Used server-side for ephemeral token minting; browser uses the SDK's WebSocket client for the Live session.
- `mermaid` — client-side diagram rendering in the preview pane.
- No new backend services. Everything runs in the existing Next.js dashboard process.
- `GEMINI_API_KEY` environment variable (rename of current `google_api_key`; see Environment below).

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ Browser (dashboard/src/app/voice/page.tsx)                    │
│                                                                │
│  Mic ─► PCM encode ─┐                          ┌─► Audio out  │
│                     ▼                          │               │
│           ┌──────────────────┐                 │               │
│           │  VoiceSession    │────── WS ───────┼──► Gemini     │
│           │  (voice-session) │                 │    Live API   │
│           └─┬────────────────┘                 │    (v1alpha)  │
│             │ onToolCall    onTranscript       │               │
│             ▼               ▼                  │               │
│   ┌──────────────┐    ┌──────────────┐         │               │
│   │ Tool bridge  │    │ Captions +   │         │               │
│   │ (fetch)      │    │ Preview pane │         │               │
│   └──────┬───────┘    └──────────────┘         │               │
└──────────┼─────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│ Dashboard Next.js API routes                                     │
│                                                                  │
│   /api/voice/token          mint ephemeral token from GEMINI_API_KEY │
│   /api/voice/context/:p     session startup context              │
│   /api/voice/tools/:p/:tool execute a tool call                  │
│   /api/voice/session-close  flush transcript per persona         │
└──────────┬──────────────────────────────────────────────────────┘
           │
   ┌───────┴───────────────┐
   │                       │
   ▼                       ▼
┌─────────────────┐   ┌────────────────────────────┐
│ Filesystem      │   │ NanoClaw IPC queue          │
│ (vault, docs,   │   │ (for ask_mr_rogers only)    │
│  git, specs)    │   │ → main Telegram group's     │
└─────────────────┘   │   Claude container          │
                      └────────────────────────────┘
```

## Data Flow

### Session start

1. User opens `/voice`, picks persona, clicks **Start**.
2. Frontend calls `POST /api/voice/token` with `{ persona }`. Optional `resumeHandle` is accepted but ignored in v1.
3. Backend uses `GEMINI_API_KEY` and `@google/genai` to request an ephemeral token bound to the persona's model config. Returns `{ token, expiresAt }`.
4. Frontend calls `GET /api/voice/context/:persona` to fetch startup context (see Personas below).
5. `VoiceSession` opens a WebSocket to Gemini at the `v1alpha` endpoint using the ephemeral token. Session config includes:
   - Model: `gemini-3.1-flash-live-preview`
   - Response modalities: `["AUDIO"]`
   - System instruction (persona-specific)
   - Tool declarations (persona-specific)
   - `inputAudioTranscription: {}`, `outputAudioTranscription: {}` (for captions)
   - Voice config (persona-specific)
6. Immediately after connecting, `VoiceSession` sends a `clientContent` turn containing the fetched startup context, then unmutes the mic.

### Talking

1. Browser captures mic audio, resamples/encodes to **16-bit PCM, 16 kHz, little-endian**, mono.
2. `VoiceSession.sendRealtimeInput({ audio: { mimeType: 'audio/pcm;rate=16000', data: base64Chunk } })` streams chunks to Gemini.
3. Gemini streams back `serverContent` events with 24 kHz PCM audio data + transcription events.
4. `audio-io.ts` buffers and plays incoming PCM via a Web Audio `AudioWorklet`.
5. Transcription events update the captions component.
6. When Gemini emits a `toolCall`, `VoiceSession` forwards it to `POST /api/voice/tools/:persona/:tool` with the tool's args. The backend executes the tool and returns JSON. `VoiceSession` replies to Gemini with `toolResponse`.
7. Mockup/diagram tool calls return a file path; the preview pane reloads to display it.

### Session end

Triggered by: user click **Stop**, tab close, 15-minute cap, or WebSocket disconnect.

1. `VoiceSession` emits `onSessionEnd({ transcript, persona, startedAt, endedAt })`.
2. Frontend `POST /api/voice/session-close` with the payload.
3. Server-side persistence branches by persona (see Transcript Handling).

## Personas

### Mr. Rogers Live

**Backend**: Hybrid. Gemini handles conversation; the `ask_mr_rogers` tool delegates to the existing Claude container for anything that needs memory or vault writes.

**Scope**: Shared with the main Telegram group. Context flows both ways (voice → Telegram memory → voice).

**Default voice**: `Aoede` (warm, conversational).

**System prompt (sketch)**:
> You are Mr. Rogers, the student's personal teaching assistant, speaking with them by voice at their desk. You already know them well from prior exchanges — the context block below contains their current study state. Speak naturally and conversationally, as in a tutoring session. Keep turns short. Ask what they want to work on before explaining. When they ask about a concept, check the vault first (`search_vault`, `read_note`). Use `search_rag` for synthesis across sources. For anything that needs durable memory, planning, or vault writes, call `ask_mr_rogers` — that reaches your "slower self" which maintains the student profile.

**Startup context**:

Fetched by `/api/voice/context/mr-rogers`. Contains:
- Today's study plan entries (from the plan DB)
- Last 10 concepts practiced (from study log)
- Open questions / gaps flagged in the student profile
- Timestamp

Delivered as a `clientContent` turn: `Here's where you left off: [context JSON]`. Not read aloud; Gemini keeps it in context.

**Tool surface**:

| Tool | Args | Returns | Scope |
|---|---|---|---|
| `search_vault` | `{ query: string, limit?: number }` | `{ matches: Array<{path, snippet}> }` | Read |
| `read_note` | `{ path: string }` | `{ content: string, frontmatter: object }` | Read |
| `search_rag` | `{ query: string, mode?: 'hybrid'\|'local'\|'global' }` | `{ answer: string, sources: string[] }` | Read |
| `get_study_state` | `{}` | `{ plan, recentConcepts, openQuestions }` | Read (same as startup context, on-demand) |
| `ask_mr_rogers` | `{ question: string, context?: string }` | `{ answer: string }` | Delegate to Claude container |

The `ask_mr_rogers` tool posts a synthetic message into the main group's IPC queue with a `[voice-session]` tag, then polls / awaits the container's response. Implementation detail to be worked out in the plan: either reuse the existing message-response flow with a dedicated correlation ID, or add a direct blocking IPC path keyed on a request ID. The correlation-ID approach fits the existing IPC model; the plan should prefer it unless there's a reason not to.

### Dev Assistant

**Backend**: Gemini direct. No Claude container.

**Scope**: Isolated. No access to `groups/`, vault, RAG, study system, or `src/`/`container/`/`dashboard/` for writes.

**Default voice**: `Zephyr` (clear, neutral).

**System prompt (sketch)**:
> You are a design and brainstorming partner for uniClaw (a personal Claude assistant / teaching platform fork of NanoClaw). The developer you're speaking with is building features for it. You have read access to the codebase and docs, and write access scoped to `docs/superpowers/specs/`, `docs/superpowers/plans/`, and `docs/superpowers/mockups/` only. You do NOT touch source code. When drafting specs or plans, follow the structure of existing files in those directories. For mockups, produce single-file HTML with Tailwind via CDN. For architecture or flow questions, prefer mermaid diagrams over prose. Keep spoken turns short. Think out loud. Ask about constraints before writing.

**Startup context**:

Fetched by `/api/voice/context/dev`. Contains:
- Current git branch
- `git status` (short form)
- Last 10 commits (subject line only)
- List of spec filenames in `docs/superpowers/specs/`
- List of plan filenames in `docs/superpowers/plans/`
- Timestamp

**Tool surface**:

| Tool | Args | Returns | Scope |
|---|---|---|---|
| `read_file` | `{ path: string }` | `{ content: string }` | Read; path must be within repo |
| `glob` | `{ pattern: string }` | `{ paths: string[] }` | Read |
| `grep` | `{ pattern: string, path?: string, glob?: string }` | `{ matches: Array<{path, line, text}> }` | Read |
| `git_log` | `{ limit?: number, path?: string }` | `{ commits: Array<{sha, subject, date, author}> }` | Read |
| `git_status` | `{}` | `{ branch, staged, modified, untracked }` | Read |
| `list_specs` | `{}` | `{ specs: string[], plans: string[] }` | Read |
| `write_spec` | `{ slug: string, content: string }` | `{ path: string }` | Write to `docs/superpowers/specs/YYYY-MM-DD-<slug>.md` |
| `write_plan` | `{ slug: string, content: string }` | `{ path: string }` | Write to `docs/superpowers/plans/YYYY-MM-DD-<slug>.md` |
| `write_mockup` | `{ slug: string, html: string }` | `{ path: string, previewUrl: string }` | Write to `docs/superpowers/mockups/YYYY-MM-DD-<slug>.html` |
| `write_diagram` | `{ slug: string, mermaid: string, title?: string }` | `{ path: string, previewUrl: string }` | Write to `docs/superpowers/mockups/YYYY-MM-DD-<slug>.md` with mermaid block |

**Path guards** on all write tools:
- Slug sanitized to `[a-z0-9-]+`, trimmed, max 80 chars.
- Generated filename is fully controlled by the server; Gemini's `slug` arg never contains a path separator or parent traversal.
- Refuse if the resulting file already exists and contents differ (don't overwrite silently). Provide a `replace: true` flag only if we later decide to support iteration on the same slug.

## Preview Pane

A tabbed side panel within `/voice`:

- **Mockup tab** — renders latest `write_mockup` in a sandboxed `<iframe srcDoc={html}>`. Sandboxed with `allow-scripts` so Tailwind CDN works, no `allow-same-origin`.
- **Diagram tab** — renders latest `write_diagram` using client-side `mermaid.js` initialized on mount.
- **History** — a dropdown listing all files written during this session. Selecting one swaps the tab content.

Files persist on disk; history is session-scoped only (resets when you leave the page). Grepping `docs/superpowers/mockups/` recovers anything you produced in prior sessions.

## Captions

Scrolling transcript pane beneath the mic controls:

- Input transcription (what the user said) — left-aligned, muted text.
- Output transcription (what Gemini said) — left-aligned, normal text, prefixed with the persona name.
- Auto-scroll to bottom on new content; pin-to-bottom toggle if user scrolls up.
- Copy-session button copies the full transcript to clipboard.

Captions update in real time as transcription events arrive over the WebSocket.

## Transcript Handling (session close)

### Mr. Rogers

1. Session-close handler calls `ask_mr_rogers` one more time with the full transcript and a prompt like: *"Summarize this voice tutoring session into 2–5 bullet points for your long-term log. Focus on: concepts practiced, what the student struggled with, what to revisit next."*
2. Writes the summary as a single message into the main group's conversation log with metadata: `{ origin: 'voice-session', startedAt, endedAt, transcriptPath? }`.
3. Optionally also writes the full transcript to a side file (e.g., `groups/{main}/voice-archive/YYYY-MM-DD-HHMM.md`) so it's available for manual review but doesn't flood the agent's context. Default: yes. Storage cost is negligible.

### Dev Assistant

1. Session-close handler writes the full verbatim transcript to `docs/superpowers/brainstorm-sessions/YYYY-MM-DD-HHMM.md`.
2. The file's frontmatter lists any spec/plan/mockup/diagram files written during the session so they're cross-referenced.
3. No summarization step. Raw brainstorms are more valuable than summaries for dev work.

## Session Lifecycle Edge Cases

- **User closes the tab mid-session**: browser unload handler does a best-effort `sendBeacon` to `/api/voice/session-close` with the buffered transcript. If it fails, the transcript is lost — acceptable for v1.
- **WebSocket drops unexpectedly**: show a "connection lost, reconnect?" button. No auto-reconnect in v1 (that's B territory). Transcript up to the drop is preserved and can be saved.
- **15-minute cap approaches**: show a countdown at 2:00 remaining; at 0:15 auto-flush transcript and show "session ended — start a new one?".
- **Tool call fails**: return a structured error to Gemini (`{ error: "..." }`). Gemini decides how to relay it verbally. Server also logs for diagnostics.
- **Tool call times out (default 10s)**: return `{ error: "timeout" }`. `ask_mr_rogers` gets a longer budget (60s) because the Claude container may need to search, read, reason.
- **`ask_mr_rogers` queue is busy** (e.g. a Telegram exchange in flight): queue behind it. The IPC model already serializes per-container. This means voice may pause while a text exchange completes — acceptable.

## Environment

Standardize on **`GEMINI_API_KEY`** for all Google AI access in universityClaw.

- `.env.example`: add `GEMINI_API_KEY=` under a new `# --- Google Gemini API ---` section.
- `.env` migration: the current lowercase `google_api_key` should be renamed to `GEMINI_API_KEY` during implementation (documented in the plan).
- Dashboard API routes read from `process.env.GEMINI_API_KEY`.
- No container-side env changes in this spec (the container's Gemini usage, if any, is out of scope and handled by the parallel Mistral → Gemini migration).

## Security

**Current state**: dashboard has no auth (per existing deferred-auth note). Voice routes inherit that.

**Implications**:

- `/api/voice/token` issues ephemeral tokens with minimal scope, but **anyone who reaches `localhost:3100` can mint one**. On localhost this is fine; on a LAN or public network, it leaks Gemini billing to anyone who finds the dashboard.
- Tool routes execute real operations (vault reads, git reads, file writes) — unauthenticated access means someone on the LAN could, for example, make the Dev Assistant write a mockup that exfiltrates secrets via tailwind image URLs. Low risk on localhost; meaningful risk otherwise.

**Enforcement for v1**:

- Dashboard server binds to `127.0.0.1` only (verify / enforce in the plan if not already).
- No voice features used outside localhost until dashboard auth ships.
- A banner on `/voice` says "Localhost only — do not expose without auth" so the constraint is visible.

**Future hardening (out of scope for v1)**:

- Dashboard auth (covered by the existing deferred work). Once it ships, voice routes sit behind it automatically.
- Per-tool rate limiting on `/api/voice/tools/*`.
- Content-Security-Policy for the mockup iframe (beyond `sandbox` attribute).

## Error Handling

- **Missing `GEMINI_API_KEY`**: `/api/voice/token` returns 500 with a clear error; frontend shows "Voice requires `GEMINI_API_KEY` in .env."
- **Token mint failure** (network, quota): surface the Google error message to the user. Don't retry silently.
- **Mic permission denied**: show inline instructions to enable it.
- **Audio worklet fails to load**: fall back to `AudioBufferSourceNode`-based playback. Degraded but functional.
- **Unknown tool call**: server returns `{ error: "unknown tool" }`; Gemini apologizes verbally. Logged for review.
- **Write tool conflict** (file exists, differs): return `{ error: "would overwrite <path>", existingContent: "..." }`. Gemini can offer a new slug.

## Testing

Given the real-time, audio-centric nature of this feature, test coverage focuses on the deterministic parts:

- Unit tests (Vitest) for:
  - Token endpoint response shape
  - Context endpoints (with mocked file/git reads)
  - Tool handlers with fixture vaults and temp dirs
  - Path-guard regressions for write tools (reject slashes, traversal, bad chars, existing-file conflicts)
  - Session-close handler for each persona (summarization mocked for Mr. Rogers)
- Frontend unit tests for `VoiceSession` event stream (with a mocked WebSocket).
- Integration test: manually verified — end-to-end voice loop against real Gemini with a fresh `GEMINI_API_KEY`. Not automated in v1.

## Rollout

1. Build behind a dev-only link on the dashboard nav (e.g. visible only when `NODE_ENV=development`).
2. Dogfood for a week. Log every tool call, every transcript, every failure mode to `store/messages.db` or a voice-specific log file.
3. Based on dogfood findings, decide which v2 items to pull forward: session resumption, tool approval UI, different default voices, captions toggle, etc.

## Open Questions

Items deliberately deferred into the implementation plan:

1. **`ask_mr_rogers` transport** — correlation-ID inside existing IPC vs a new dedicated channel. Plan should pick and justify.
2. **Context injection as a `clientContent` turn vs part of the system instruction** — either works; the former lets us refresh mid-session via a new turn, the latter is simpler. Plan decides.
3. **Audio worklet processor** — write one or use an existing open-source 16 kHz resampler. Plan surveys options.
4. **Mockup tab iframe sandbox policy** — exact flags. Needs CSP sanity check.
5. **Voice selection UX** — can user override the default per session, or is it hardcoded in `personas.ts`? Default: hardcoded; swap by editing config. Plan confirms.

## Future Work (out of scope, noted for architecture clarity)

- **Session resumption** — reconnect with a handle to span multiple 15-min windows. Token endpoint already reserves the param.
- **More personas** — e.g. "Research Reader" for speed-reading sessions with Mr. Rogers, "Code Reviewer" that has write access to PR descriptions.
- **Phone delivery** — Twilio bridge, reuse backend tool surface.
- **Dashboard auth** — blocks network exposure of this feature.
- **Tool approval UI** — if the Dev Assistant grows write access beyond `docs/superpowers/`.
- **Real-time interruption tuning** — expose VAD sensitivity as a setting.
