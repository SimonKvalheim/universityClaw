# Voice Dogfood Checklist

Manual exercise of the `/voice` Dev Assistant. Tick each item once per dogfood
pass. If any row fails, open a GitHub issue rather than patching scope-creep
items into the current PR.

> ⚠️ **v1 status — fake server only.** The browser WebSocket client speaks
> an opaque-JSON frame format (`{type: 'audio'|'usage'|'tool_call'|…}`) that
> matches the in-repo fake Gemini server, not the real Gemini Live
> `BidiGenerateContent` wire protocol. The `VoiceSession.start()` path that
> builds `wss://generativelanguage.googleapis.com/?access_token=…` is a
> placeholder. **A real GEMINI_API_KEY will not make a working session
> until the v1.1 real-Gemini adapter lands** (uses `@google/genai`'s
> `ai.live.connect()` and mirrors the real `serverContent` / `toolCall` /
> `usageMetadata` frame shapes).
>
> Everything except the live-audio path is usable today: token minting, the
> tool dispatcher + scope guards, session-close persistence, cost rollups,
> fake-server e2e. Dogfooding the UI, tools, and cost plumbing is valuable
> groundwork before the adapter lands.

## Environment

- [ ] `GEMINI_API_KEY` is set in `.env` (or falls back to legacy `google_api_key`).
- [ ] Dashboard is running at `http://localhost:3100`.
- [ ] Browser is Chromium-based (Chrome, Edge, Arc) — Gemini Live needs Web Audio + AudioWorklet.

## Golden path (first start)

- [ ] Click **Start** — browser prompts for microphone permission.
- [ ] Localhost-only amber banner is visible in the page header.
- [ ] Session timer starts counting up.
- [ ] Speak; my words appear in the transcript as the assistant listens.
- [ ] Assistant replies; audio plays; caption shows assistant turn.
- [ ] Cost panel (session) ticks up as usage metadata arrives.
- [ ] Today and This month rollups show non-zero after my first turn.

## Tools

- [ ] Ask the assistant to read a file (e.g. `src/config.ts`); response references concrete lines.
- [ ] Ask for a `grep` — response cites `path:line` rows.
- [ ] Ask for a `git_status` — response mentions the current branch.
- [ ] Ask to write a mockup (`write_mockup`). Preview pane loads it in the iframe.
- [ ] Ask to write a mermaid diagram (`write_diagram`). Diagram tab renders it.
- [ ] Ask to write a spec (`write_spec`). File appears under `docs/superpowers/specs/YYYY-MM-DD-<slug>.md`.

## Denials (security sanity)

- [ ] Ask it to `read_file .env` — assistant verbalises a polite "out of scope" (server returns `{ error }`).
- [ ] Ask it to write a spec with an uppercase slug (e.g. `BadSlug`) — assistant acknowledges slug rejection.
- [ ] Ask it to overwrite an existing spec with different content — server returns `would overwrite`, assistant picks a new slug.

## Session lifecycle

- [ ] Click **Mute** — assistant stops hearing you mid-sentence.
- [ ] Click **Unmute** — continues naturally.
- [ ] Click **Stop** — session ends cleanly; transcript is saved to `docs/superpowers/brainstorm-sessions/`.
- [ ] Row appears in `store/messages.db` `voice_sessions` table with matching `id`.
- [ ] Open a new tab and start a second session — Today rollup includes both.

## Edge cases

- [ ] Close the browser tab mid-session — `voice_sessions` row still lands (best-effort flush via `fetch({keepalive:true})`).
- [ ] Approach the 10-minute soft cap — session auto-ends with `endReason: 'soft_cap'`.
- [ ] Set `VOICE_MONTHLY_BUDGET_USD` below the current monthly total — amber banner surfaces on next reload.

## Privacy

- [ ] Confirm `docs/superpowers/brainstorm-sessions/` is NOT indexed by RAG (`grep -n superpowers src/rag/indexer.ts` returns nothing).
