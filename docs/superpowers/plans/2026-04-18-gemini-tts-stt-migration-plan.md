# Gemini TTS/STT Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Mistral with Google Gemini across both audio paths (host-side STT, container-side TTS) with zero changes to the downstream ffmpeg/IPC pipeline; enable Norwegian TTS; add an optional `style_prompt` parameter to the `synthesize_speech` MCP tool.

**Architecture:** Host-side STT in `src/channels/telegram.ts` swaps Mistral multipart POST for Gemini `generateContent` on `gemini-2.5-flash-lite`. Container-side `synthesize_speech` in `container/agent-runner/src/ipc-mcp-stdio.ts` swaps Mistral endpoint for Gemini `gemini-3.1-flash-tts-preview` TTS, wraps base64 PCM as 44-byte WAV, and gains a `style_prompt` param. Voice is hardcoded to `Kore`. Env var is standardized to `GEMINI_API_KEY`.

**Tech Stack:** TypeScript (ES modules, strict), Node 22, native `fetch`, Vitest, Zod (MCP tool schemas), `@modelcontextprotocol/sdk`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-18-gemini-tts-stt-migration-design.md`

---

## Essential Reading (coordinator only — do not duplicate to subagents)

- **Spec:** `docs/superpowers/specs/2026-04-18-gemini-tts-stt-migration-design.md` — the source of truth. Each task below is self-contained; subagents should not need to open the spec, but the coordinator should re-read it before final review.
- **Current Mistral STT:** `src/channels/telegram.ts` voice-message handler (search for `MISTRAL` / `voxtral-mini-latest` / `api.mistral.ai`).
- **Current Mistral TTS:** `container/agent-runner/src/ipc-mcp-stdio.ts` — the `synthesize_speech` tool handler and surrounding constants (`MISTRAL_TTS_URL`, `MISTRAL_DEFAULT_VOICE_ID`, `AUDIO_DIR`, `TTS_MAX_TEXT_LENGTH`).
- **Env plumbing:** `src/container-runner.ts` — the `MISTRAL_API_KEY` injection block (a small `process.env.X || readEnvFile(['X']).X` pattern that pushes `-e X=...` into the container `args` array).
- **Review feedback applied to spec:** STT model has a documented fallback (`gemini-2.5-flash`) behind a single constant; `style_prompt` empty/whitespace semantics specified; `finishReason` / `promptFeedback` logging required; `google_api_key` → `GEMINI_API_KEY` rename is a first-class rollout step.

## Conventions (apply to every code task)

- **TDD, strictly:** Write the failing test → run it and see the failure → write the minimal code → see it pass → commit.
- **Commit per task.** Small commits. Subject line format: `feat(tts): ...` / `feat(stt): ...` / `chore(env): ...` / `docs(speech): ...` matching this repo's recent history (check `git log --oneline -20`).
- **Never skip hooks.** Husky + prettier run on commit; let them. If prettier reformats staged files, re-stage and retry — do not `--no-verify`.
- **Never amend or force-push.** New commit per fix.
- **ES module imports:** include `.js` extension on relative imports (the repo uses `"module": "NodeNext"` and compiled output runs as ESM). Example: `import { pcmToWav } from './pcm-to-wav.js';`.
- **Do not add new runtime dependencies.** All code in this plan uses built-ins or the Vitest/Zod already installed.
- **Do not touch files outside the `Files` list of your task.** If the spec says a change is needed elsewhere, it's covered by a later task.
- **Spec deviations:** if an instruction conflicts with the spec, stop and surface the conflict in a commit message or a comment — do not silently deviate.

## Parallel-Execution Guide

Tasks 1, 2, and 4 can run in parallel (different files, no shared edits). All others are sequential per the dependency arrows:

```
Task 0 (vitest bootstrap) ──┬─> Task 1 (pcm-to-wav)    ─┐
                            ├─> Task 2 (request body)  ─┤
                            │                           ├─> Task 3 (synthesize_speech rewrite)
                            └─> Task 4 (telegram STT)  ─┘                              │
                                                                                       │
                                        Task 5 (container-runner env) ─────────────────┘
                                                  │
                                                  v
                              Tasks 6–10 (docs, in parallel with each other)
                                                  │
                                                  v
                                            Task 11 (smoke + PR gate)
```

**Ownership (parallel safety):**
- Task 1 owns: `container/agent-runner/src/pcm-to-wav.ts`, `container/agent-runner/src/pcm-to-wav.test.ts`. Must not touch `ipc-mcp-stdio.ts`.
- Task 2 owns: `container/agent-runner/src/gemini-tts-request.ts`, `container/agent-runner/src/gemini-tts-request.test.ts`. Must not touch `ipc-mcp-stdio.ts`.
- Task 4 owns: `src/channels/telegram.ts`, `src/channels/telegram.test.ts`. Must not touch any container/ path.

---

## Task 0: Bootstrap Vitest coverage for `container/agent-runner`

**Why this exists first:** The spec calls for two new unit test files under `container/agent-runner/src/`, but the host's `vitest.config.ts` does not currently glob that directory. Without this bootstrap, Tasks 1 and 2 cannot observe their tests running. Also, `container/agent-runner/tsconfig.json` currently compiles everything in `src/**/*` — we must exclude `*.test.ts` so test files do not ship into the container image.

**Files:**
- Modify: `vitest.config.ts`
- Modify: `container/agent-runner/tsconfig.json`

- [ ] **Step 1: Read the current vitest config**

Run: `cat vitest.config.ts`

Expected output:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'dashboard/src/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Add the container-runner test glob**

Edit `vitest.config.ts` — add `'container/agent-runner/src/**/*.test.ts'` to the `include` array. Final state:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'dashboard/src/**/*.test.ts',
      'container/agent-runner/src/**/*.test.ts',
    ],
  },
});
```

- [ ] **Step 3: Exclude test files from the agent-runner TypeScript build**

Edit `container/agent-runner/tsconfig.json` — add `"src/**/*.test.ts"` to the `exclude` array:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

- [ ] **Step 4: Verify Vitest still runs cleanly**

Run: `npm test`
Expected: All existing tests pass. Vitest reports no new test files (they don't exist yet).

- [ ] **Step 5: Verify the agent-runner build is unaffected**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Exits 0.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts container/agent-runner/tsconfig.json
git commit -m "chore(test): wire container/agent-runner into vitest

Add container/agent-runner/src/**/*.test.ts to vitest include and
exclude test files from the agent-runner tsc build so tests are
runnable but do not ship into the container image."
```

---

## Task 1: `pcmToWav` helper — TDD

**Why:** Gemini TTS returns raw base64 PCM (24kHz mono 16-bit little-endian). The host ffmpeg pipeline expects a WAV on disk (that's the invariant the spec preserves). A pure function `pcmToWav(pcm: Buffer): Buffer` prepends a standard 44-byte RIFF/WAVE header. Isolating it as a file makes it trivially unit-testable and keeps `ipc-mcp-stdio.ts` readable.

**Files:**
- Create: `container/agent-runner/src/pcm-to-wav.ts`
- Create: `container/agent-runner/src/pcm-to-wav.test.ts`

**Header layout (from spec, do not deviate):**

| Offset | Bytes | Value | Notes |
|---|---|---|---|
| 0 | 4 | `"RIFF"` | ASCII |
| 4 | 4 | `pcm.length + 36` | little-endian u32 (file size minus 8) |
| 8 | 4 | `"WAVE"` | ASCII |
| 12 | 4 | `"fmt "` | note the trailing space |
| 16 | 4 | `16` | fmt chunk size (PCM) |
| 20 | 2 | `1` | PCM format |
| 22 | 2 | `1` | mono |
| 24 | 4 | `24000` | sample rate |
| 28 | 4 | `48000` | byte rate = 24000 × 1 × 2 |
| 32 | 2 | `2` | block align |
| 34 | 2 | `16` | bits per sample |
| 36 | 4 | `"data"` | ASCII |
| 40 | 4 | `pcm.length` | little-endian u32 |

All numeric fields little-endian. All `writeUIntLE` / `writeUInt32LE` / `writeUInt16LE` — these are Node `Buffer` built-ins, no deps.

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/pcm-to-wav.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pcmToWav } from './pcm-to-wav.js';

describe('pcmToWav', () => {
  it('prepends a 44-byte RIFF/WAVE header to the PCM buffer', () => {
    const pcm = Buffer.alloc(100, 0xAB);
    const wav = pcmToWav(pcm);
    expect(wav.length).toBe(100 + 44);
    // Header ASCII markers
    expect(wav.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.slice(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.slice(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.slice(36, 40).toString('ascii')).toBe('data');
    // PCM body is appended verbatim
    expect(wav.slice(44).equals(pcm)).toBe(true);
  });

  it('encodes fmt chunk for 24kHz mono 16-bit little-endian PCM', () => {
    const pcm = Buffer.alloc(10);
    const wav = pcmToWav(pcm);
    expect(wav.readUInt32LE(16)).toBe(16);   // fmt chunk size
    expect(wav.readUInt16LE(20)).toBe(1);    // PCM format
    expect(wav.readUInt16LE(22)).toBe(1);    // mono
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(48000); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2);    // block align
    expect(wav.readUInt16LE(34)).toBe(16);   // bits per sample
  });

  it('writes the RIFF and data chunk sizes correctly', () => {
    const pcm = Buffer.alloc(1000);
    const wav = pcmToWav(pcm);
    expect(wav.readUInt32LE(4)).toBe(1000 + 36); // RIFF size = total - 8
    expect(wav.readUInt32LE(40)).toBe(1000);     // data chunk size
  });

  it('handles an empty PCM buffer', () => {
    const wav = pcmToWav(Buffer.alloc(0));
    expect(wav.length).toBe(44);
    expect(wav.readUInt32LE(4)).toBe(36);
    expect(wav.readUInt32LE(40)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run container/agent-runner/src/pcm-to-wav.test.ts`
Expected: Failure — module `./pcm-to-wav.js` not found (the import target does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `container/agent-runner/src/pcm-to-wav.ts`:

```ts
/**
 * Wrap raw PCM (24kHz, mono, 16-bit little-endian) in a 44-byte RIFF/WAVE
 * header so the host ffmpeg pipeline can read it as a standard WAV.
 *
 * The audio format is fixed — Gemini TTS returns PCM at exactly these
 * parameters, so there are no knobs here.
 */
export function pcmToWav(pcm: Buffer): Buffer {
  const SAMPLE_RATE = 24000;
  const CHANNELS = 1;
  const BITS_PER_SAMPLE = 16;
  const BYTE_RATE = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const BLOCK_ALIGN = CHANNELS * (BITS_PER_SAMPLE / 8);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTE_RATE, 28);
  header.writeUInt16LE(BLOCK_ALIGN, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run container/agent-runner/src/pcm-to-wav.test.ts`
Expected: All four tests pass.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/pcm-to-wav.ts container/agent-runner/src/pcm-to-wav.test.ts
git commit -m "feat(tts): add pcmToWav helper for Gemini PCM → WAV wrap

Gemini TTS returns raw 24kHz mono 16-bit PCM. Wrap it in a 44-byte
RIFF/WAVE header so the existing host ffmpeg WAV→OGG pipeline can
consume it unchanged."
```

---

## Task 2: `buildGeminiTtsRequest` helper — TDD

**Why:** The request body builder is the only piece of the TTS tool with real decision logic (whether to prepend `style_prompt`, how to shape `speechConfig`). Extracting it keeps the MCP handler thin and lets us pin the Gemini request shape with unit tests so future refactors can't silently drift from the documented API.

**Files:**
- Create: `container/agent-runner/src/gemini-tts-request.ts`
- Create: `container/agent-runner/src/gemini-tts-request.test.ts`

**Contract (from spec):**

```ts
function buildGeminiTtsRequest(args: {
  text: string;
  stylePrompt?: string;
  voiceName: string;
}): GeminiTtsRequestBody;
```

The `stylePrompt` is treated as absent when `undefined`, empty, or whitespace-only. Otherwise it's trimmed and prepended as `"{stylePrompt}: {text}"`. The `voiceName` is passed through from the caller so this helper stays pure.

**Body shape (Gemini v1beta REST, camelCase):**

```json
{
  "contents": [{ "parts": [{ "text": "<prompt>" }] }],
  "generationConfig": {
    "responseModalities": ["AUDIO"],
    "speechConfig": {
      "voiceConfig": {
        "prebuiltVoiceConfig": {
          "voiceName": "Kore"
        }
      }
    }
  }
}
```

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/gemini-tts-request.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildGeminiTtsRequest } from './gemini-tts-request.js';

describe('buildGeminiTtsRequest', () => {
  it('sends text unchanged when stylePrompt is omitted', () => {
    const body = buildGeminiTtsRequest({
      text: 'Hello world',
      voiceName: 'Kore',
    });
    expect(body.contents[0].parts[0].text).toBe('Hello world');
  });

  it('sends text unchanged when stylePrompt is an empty string', () => {
    const body = buildGeminiTtsRequest({
      text: 'Hello world',
      stylePrompt: '',
      voiceName: 'Kore',
    });
    expect(body.contents[0].parts[0].text).toBe('Hello world');
  });

  it('sends text unchanged when stylePrompt is whitespace only', () => {
    const body = buildGeminiTtsRequest({
      text: 'Hello world',
      stylePrompt: '   \t  ',
      voiceName: 'Kore',
    });
    expect(body.contents[0].parts[0].text).toBe('Hello world');
  });

  it('prepends a trimmed stylePrompt with a colon separator', () => {
    const body = buildGeminiTtsRequest({
      text: 'Hello world',
      stylePrompt: '  Say warmly and slowly  ',
      voiceName: 'Kore',
    });
    expect(body.contents[0].parts[0].text).toBe('Say warmly and slowly: Hello world');
  });

  it('requests AUDIO modality with the specified prebuilt voice', () => {
    const body = buildGeminiTtsRequest({ text: 'hi', voiceName: 'Charon' });
    expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(
      body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    ).toBe('Charon');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run container/agent-runner/src/gemini-tts-request.test.ts`
Expected: Failure — module `./gemini-tts-request.js` not found.

- [ ] **Step 3: Write the minimal implementation**

Create `container/agent-runner/src/gemini-tts-request.ts`:

```ts
export interface GeminiTtsRequestBody {
  contents: Array<{ parts: Array<{ text: string }> }>;
  generationConfig: {
    responseModalities: ['AUDIO'];
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: string };
      };
    };
  };
}

export function buildGeminiTtsRequest(args: {
  text: string;
  stylePrompt?: string;
  voiceName: string;
}): GeminiTtsRequestBody {
  const style = args.stylePrompt?.trim();
  const prompt = style ? `${style}: ${args.text}` : args.text;

  return {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: args.voiceName },
        },
      },
    },
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run container/agent-runner/src/gemini-tts-request.test.ts`
Expected: All five tests pass.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/gemini-tts-request.ts container/agent-runner/src/gemini-tts-request.test.ts
git commit -m "feat(tts): add buildGeminiTtsRequest body builder

Pure helper that shapes the Gemini generateContent body. Handles
style_prompt empty/whitespace semantics (treated as absent) and
trims+prepends when present."
```

---

## Task 3: Rewrite `synthesize_speech` tool to use Gemini

**Why:** This is the functional core of the migration on the TTS side. The tool's external contract (`{ path, duration_seconds }`) and file location (`/workspace/group/audio/`) are preserved so the host-side IPC and ffmpeg pipeline don't notice. A new optional `style_prompt` param is added; the voice and model are named constants.

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

**Depends on:** Task 1 (pcmToWav) and Task 2 (buildGeminiTtsRequest).

**What to replace:** The whole block starting with the constants just above the `synthesize_speech` tool declaration and ending at the closing `);` of the tool definition. Specifically:

- Delete: `const MISTRAL_TTS_URL = ...`
- Delete: `const MISTRAL_DEFAULT_VOICE_ID = ...`
- Keep: `const AUDIO_DIR = '/workspace/group/audio';`
- Keep: `const TTS_MAX_TEXT_LENGTH = 50000;`
- Add: the new Gemini constants (see Step 2 below).
- Add: imports for the two helpers.
- Replace: the entire `server.tool('synthesize_speech', ...)` call.

**What to leave alone:** The `send_voice` tool (directly after `synthesize_speech`) is unchanged. All other tools (`send_message`, `schedule_task`, `list_tasks`, etc.) are unchanged.

- [ ] **Step 1: Add helper imports at the top of the file**

Near the other imports in `container/agent-runner/src/ipc-mcp-stdio.ts` (after the existing `import { CronExpressionParser } from 'cron-parser';` line), add:

```ts
import { pcmToWav } from './pcm-to-wav.js';
import { buildGeminiTtsRequest } from './gemini-tts-request.js';
```

- [ ] **Step 2: Replace the Mistral constants with Gemini constants**

Find the block near `AUDIO_DIR` and `TTS_MAX_TEXT_LENGTH`. Replace the two `MISTRAL_*` constants with:

```ts
const AUDIO_DIR = '/workspace/group/audio';
const TTS_MAX_TEXT_LENGTH = 50000;

// Voice is a single prebuilt. To try another, change this constant.
// Kore is a balanced multilingual default. Other good starting points:
// "Charon", "Puck", "Zephyr", "Aoede". Full list: 30 prebuilts in Gemini TTS docs.
const GEMINI_TTS_VOICE = 'Kore';

// TTS model is currently a preview. If it is deprecated or promoted to GA,
// swap this constant — it is the only coupling point to the preview name.
const GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const GEMINI_TTS_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`;
```

- [ ] **Step 3: Replace the `synthesize_speech` tool handler — load-bearing bits verbatim, composition up to you**

Replace the entire `server.tool('synthesize_speech', ...)` call. Two parts are load-bearing and MUST be exactly as shown (wire format + tool contract): the Zod schema and the `fetch` invocation. Everything else is composition — write it however reads cleanly; the invariants you must preserve are listed after the verbatim blocks.

**Verbatim — Zod schema** (wire-level; MCP clients depend on these strings and keys):

```ts
{
  text: z
    .string()
    .max(50000)
    .describe(
      'Text to synthesize. You can embed Gemini audio tags like [warmly], [slowly], [whispering], [excitedly] inline to color specific moments within the speech.',
    ),
  style_prompt: z
    .string()
    .optional()
    .describe(
      'Natural-language whole-utterance style directive, e.g. "Say warmly and slowly" or "Speak with calm encouragement". Prepended to the text before synthesis. Use style_prompt for whole-utterance tone; use [inline tags] inside text for moment-specific expression.',
    ),
}
```

The tool description string (second arg to `server.tool`) stays as today: `'Convert text to speech audio. Returns a file path to the generated WAV audio. Call send_voice with the returned path to deliver it as a Telegram voice message. Everything is pre-configured — just call this tool.'`

**Verbatim — the Gemini fetch** (wire format; a typo here fails silently with a 400):

```ts
const response = await fetch(GEMINI_TTS_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  },
  body: JSON.stringify(
    buildGeminiTtsRequest({
      text: args.text,
      stylePrompt: args.style_prompt,
      voiceName: GEMINI_TTS_VOICE,
    }),
  ),
  signal: AbortSignal.timeout(300_000),
});
```

**Invariants you must preserve** (compose the rest however reads best — extract helpers, unify error shapes, rename locals; you own the handler's structure):

- **Input validation** (pre-fetch): empty/whitespace-only `text` → error `"Error: text cannot be empty."`. `text.length > TTS_MAX_TEXT_LENGTH` → error `"Error: text too long (${len} chars, max ${TTS_MAX_TEXT_LENGTH})."`. Missing `process.env.GEMINI_API_KEY` → error `"Error: GEMINI_API_KEY is not set in the container environment."`. All three return `{ isError: true, content: [...] }` — match the shape used by the current tool.
- **HTTP failure**: `!response.ok` → error `"Error: TTS service returned ${status}: ${body}"` where body is `await response.text()` with a defensive catch.
- **Response extraction**: the audio is at `candidates[0].content.parts[0].inlineData.data` (base64). Anything else that's there on the part is not audio.
- **Modality-mismatch branch** (REQUIRED, do not omit): if `parts[0]` contains a `text` field instead of `inlineData`, return a DISTINCT error message that includes the model's returned text — do not collapse this into the generic "missing inlineData" path. Rationale: this is the single most informative diagnostic when the preview model's modality negotiation breaks.
- **Missing-audio branch with diagnostics** (REQUIRED): when `inlineData.data` is absent and no fallback `text` is present, return an error that logs both `candidates[0].finishReason` and `promptFeedback.blockReason` (use "unknown" / "none" when either is absent). This is the only way the user diagnoses safety blocks.
- **PCM → WAV → disk**: decode base64 → `pcmToWav` → write to `path.join(AUDIO_DIR, \`tts-${Date.now()}-${random}.wav\`)` where `random = Math.random().toString(36).slice(2, 6)`. `fs.mkdirSync(AUDIO_DIR, { recursive: true })` first.
- **Return shape** (DO NOT CHANGE — `send_voice` and `src/ipc.ts` depend on it): `{ content: [{ type: 'text', text: JSON.stringify({ path, duration_seconds }) }] }`. `duration_seconds = Math.max(0, Math.round((wavBuffer.length - 44) / 48000))`.
- **Outer `try/catch`**: thrown errors → `"Error: TTS request failed: ${message}"`.

The constant `TTS_MAX_TEXT_LENGTH` is already defined at the top of the file (kept from the Mistral version). `AUDIO_DIR` likewise.

- [ ] **Step 4: Confirm no `MISTRAL` string remains in this file**

Run: `grep -n -i mistral container/agent-runner/src/ipc-mcp-stdio.ts`
Expected: No output.

- [ ] **Step 5: Type-check the container-agent-runner package**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: Exits 0 with no errors.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: All tests pass (Tasks 1 and 2 tests, plus all pre-existing tests).

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(tts): migrate synthesize_speech to Gemini

Swap Mistral voxtral-mini-tts for Gemini gemini-3.1-flash-tts-preview.
Add optional style_prompt MCP param. Voice is hardcoded to Kore as a
single constant. PCM response is wrapped as 44-byte WAV so the host
ffmpeg WAV→OGG pipeline is untouched. Adds finishReason/promptFeedback
logging and a distinct error for text-instead-of-audio modality
failures."
```

---

## Task 4: Rewrite STT handler in `src/channels/telegram.ts`

**Why:** Host-side voice transcription runs before the agent is invoked. This task swaps the Mistral multipart `FormData` POST for a Gemini inline-base64 JSON POST. The function shape (download → transcribe → deliver `[Voice]: ...`) is preserved. No change to how the bot is wired up or how messages are delivered.

**Files:**
- Modify: `src/channels/telegram.ts`

**Scope of the change (symbols, not line numbers):**
- Constructor: rename param `mistralApiKey` → `geminiApiKey`.
- Private field: rename `this.mistralApiKey` → `this.geminiApiKey`.
- Voice handler (`this.bot.on('message:voice', ...)`): replace the Mistral multipart POST block with a Gemini inline-base64 JSON POST.
- `registerChannel` callback at the bottom of the file: read `GEMINI_API_KEY` instead of `MISTRAL_API_KEY`; update the warning log message.

**What to leave alone:** the markdown send helper, the pool bot code, all non-voice handlers, `sendMessage`, `sendVoice`, `setTyping`, etc.

**STT model constant:** add a single module-level constant near the top of the voice handler (or as a file-level `const` at the top of the file) so the model is a one-line swap if `lite` rejects audio input during smoke testing:

```ts
// STT model. Swap to 'gemini-2.5-flash' if 'lite' returns 400 on audio input.
const GEMINI_STT_MODEL = 'gemini-2.5-flash-lite';
```

- [ ] **Step 1: Rename the constructor parameter and field**

In the class `TelegramChannel`:
- Change constructor signature: `mistralApiKey: string = ''` → `geminiApiKey: string = ''`.
- Change field declaration: `private mistralApiKey: string;` → `private geminiApiKey: string;`.
- Change assignment: `this.mistralApiKey = mistralApiKey;` → `this.geminiApiKey = geminiApiKey;`.

- [ ] **Step 2: Add the STT model constant**

Near the top of the file (below the imports, above the exports), add:

```ts
// STT model. Swap to 'gemini-2.5-flash' if 'lite' returns 400 on audio input.
const GEMINI_STT_MODEL = 'gemini-2.5-flash-lite';
```

- [ ] **Step 3: Replace the STT body inside the `message:voice` handler — fetch verbatim, surrounding flow up to you**

The current Mistral block (read the handler first — look for `const formData = new FormData();` and the `fetch('https://api.mistral.ai/v1/audio/transcriptions', ...)` call) is the inner `try { ... } finally { fs.unlink(localPath, () => {}); }` body. Replace only that inner body. The outer download/file-handling and the `transcribedText` → `storeNonText(ctx, transcribedText)` flow stay as-is.

**Verbatim — the Gemini fetch** (wire format; do not alter keys, header case, or path shape):

```ts
const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_STT_MODEL}:generateContent`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.geminiApiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'audio/ogg', data: audioData.toString('base64') } },
            { text: 'Generate a transcript of this speech.' },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  },
);
```

**Invariants you must preserve** (compose the surrounding logic however reads best):

- **Missing key short-circuit**: if `!this.geminiApiKey`, log `"Skipping transcription — no GEMINI_API_KEY"` via `logger.warn` and skip the fetch entirely. Do not attempt the POST. `transcribedText` retains its default `"[Voice message (transcription failed)]"` value.
- **Response extraction**: transcript is at `candidates[0].content.parts[0].text`. Trim it. If truthy, set `transcribedText = \`[Voice]: ${text}\`` — the `[Voice]:` prefix is load-bearing; the agent uses it to recognize audio origin.
- **Non-2xx branch**: `logger.error({ status: response.status, body: errText }, 'Gemini STT request failed')` where `errText = await response.text().catch(() => '')`. Leaves `transcribedText` at its failure-default so the agent sees the failure placeholder.
- **File cleanup**: `fs.unlink(localPath, () => {})` runs in the `finally` regardless of branch taken.
- **No new exception surface**: the outer try/catch (around `ctx.getFile()` / `file.download()` / inner block) is kept intact. Do not add new try/catches around the fetch — let thrown errors bubble to the existing outer catch, which already logs and leaves `transcribedText` at the failure-default.

- [ ] **Step 4: Update the `registerChannel` callback at the bottom of the file**

Replace the Mistral-key reading with Gemini-key reading. The final state of the callback:

```ts
registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  const geminiApiKey =
    process.env.GEMINI_API_KEY || envVars.GEMINI_API_KEY || '';
  if (!geminiApiKey) {
    logger.warn(
      'Telegram: GEMINI_API_KEY not set — voice transcription disabled',
    );
  }
  return new TelegramChannel(token, opts, geminiApiKey);
});
```

- [ ] **Step 5: Confirm no `MISTRAL` / `mistral` string remains in this file**

Run: `grep -n -i mistral src/channels/telegram.ts`
Expected: No output.

- [ ] **Step 6: Type-check the host package**

Run: `npx tsc --noEmit`
Expected: Exits 0.

- [ ] **Step 7: Run the existing Telegram tests**

Run: `npx vitest run src/channels/telegram.test.ts`
Expected: Existing tests still pass. (We are not adding new tests here — STT is externally validated by the manual smoke checklist in Task 11.)

- [ ] **Step 8: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat(stt): migrate Telegram voice transcription to Gemini

Swap Mistral voxtral transcription for Gemini gemini-2.5-flash-lite
via generateContent with inlineData audio/ogg. Rename the constructor
param and private field from mistralApiKey to geminiApiKey. Add a
single STT model constant so pivoting to gemini-2.5-flash is a
one-line change."
```

---

## Task 5: Update container env injection in `src/container-runner.ts`

**Why:** Containers currently receive `MISTRAL_API_KEY`. This task swaps the injection for `GEMINI_API_KEY`. The pattern (`process.env.X || readEnvFile(['X']).X`) stays identical; only the variable name changes.

**Files:**
- Modify: `src/container-runner.ts`

- [ ] **Step 1: Replace the Mistral injection block**

Find the block that reads `MISTRAL_API_KEY` and pushes it into the container `args` (look for the comment `// Mistral API key for TTS (synthesize_speech tool in container)` — it is between the `LIGHTRAG_URL` injection and the OneCLI `applyContainerConfig` call).

Replace the entire block — comment included — with:

```ts
// Gemini API key for STT (on host) and TTS (synthesize_speech tool in container).
// This bypasses the OneCLI gateway intentionally — it matches the direct env
// injection pattern the previous Mistral key used.
const geminiKey =
  process.env.GEMINI_API_KEY ||
  readEnvFile(['GEMINI_API_KEY']).GEMINI_API_KEY;
if (geminiKey) {
  args.push('-e', `GEMINI_API_KEY=${geminiKey}`);
}
```

- [ ] **Step 2: Confirm no `MISTRAL` string remains in this file**

Run: `grep -n -i mistral src/container-runner.ts`
Expected: No output.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: Exits 0.

- [ ] **Step 4: Run the container-runner tests**

Run: `npx vitest run src/container-runner.test.ts`
Expected: Existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts
git commit -m "chore(env): inject GEMINI_API_KEY into agent containers

Replace the MISTRAL_API_KEY env-injection block with an equivalent
GEMINI_API_KEY block. Pattern and surrounding comments unchanged;
OneCLI bypass is intentional and matches the prior Mistral behavior."
```

---

## Task 6: Update `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Read the current file**

Run: `cat .env.example`

Look for the `# --- Mistral API (TTS + STT) ---` block followed by `MISTRAL_API_KEY=`.

- [ ] **Step 2: Replace the Mistral block with a Gemini block**

Final state of that block:

```
# --- Gemini API (TTS + STT) ---
GEMINI_API_KEY=
```

- [ ] **Step 3: Confirm no `MISTRAL` string remains**

Run: `grep -n -i mistral .env.example`
Expected: No output.

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "chore(env): rename MISTRAL_API_KEY to GEMINI_API_KEY in example"
```

---

## Task 7: Update `CLAUDE.md` env var table

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Locate the env-var row**

In the "Environment Variables" table under "Services & Dependencies", find the row for `MISTRAL_API_KEY`. Current state:

```
| `MISTRAL_API_KEY` | — | Mistral API key (TTS + STT) |
```

- [ ] **Step 2: Replace with Gemini row**

Final state:

```
| `GEMINI_API_KEY` | — | Gemini API key (TTS + STT) |
```

- [ ] **Step 3: Confirm no `MISTRAL` string remains**

Run: `grep -n -i mistral CLAUDE.md`
Expected: No output.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md env-var table for Gemini migration"
```

---

## Task 8: Update `docs/ARCHITECTURE.md` mermaid diagram

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Locate the mermaid node**

Find the line `mistral["Mistral API<br/>(TTS / STT)"]` in the mermaid block.

- [ ] **Step 2: Rename the node and update the edge label**

Change the node declaration:

```
gemini["Gemini API<br/>(TTS / STT)"]
```

Find the edge `core -->|"audio synthesis"| mistral` and update it to:

```
core -->|"audio synthesis + transcription"| gemini
```

Do a final scan to ensure the `mistral` id is fully replaced by `gemini` everywhere in the diagram (node declaration AND edges). There should be no remaining references to the old node id.

- [ ] **Step 3: Confirm no `mistral` / `Mistral` string remains**

Run: `grep -n -i mistral docs/ARCHITECTURE.md`
Expected: No output.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(arch): replace Mistral node with Gemini in architecture diagram"
```

---

## Task 9: Rewrite `docs/speech.md`

**Why:** `docs/speech.md` is the document someone reads when they want to understand the speech pipeline. It's Mistral-specific today and has pre-existing staleness (says "5000 chars" instead of 50000, "60s" timeout instead of 300s). Full rewrite.

**Files:**
- Modify: `docs/speech.md`

**Rewrite scope:** The entire file. Structure the new doc in this section order (same top-level shape as today, so readers who know the old doc don't get lost):

1. **Intro** — one sentence: both inbound (STT) and outbound (TTS) audio use Google Gemini cloud APIs.
2. **How It Works**
   - `### Inbound: Voice Message → Text (STT)` — prose + the STT ASCII flow block (Telegram voice → host download → POST to Gemini `generateContent` at `gemini-2.5-flash-lite` with `inlineData` `audio/ogg` + prompt → transcript → `[Voice]: ...` to agent → temp cleanup).
   - `### Outbound: Agent → Voice Message (TTS)` — prose + the TTS ASCII flow block (agent calls `synthesize_speech(text, style_prompt?)` → container POSTs Gemini `generateContent` at `gemini-3.1-flash-tts-preview` → base64 PCM → `pcmToWav` → `/workspace/group/audio/*.wav` → `send_voice` IPC → host ffmpeg WAV→OGG → Telegram voice bubble → cleanup).
3. **Architecture Decisions** (subsections, in this order):
   - `### Why STT runs on the host (not in container)` — retained from the old doc (same rationale).
   - `### Why wrap PCM as WAV in the container` — new. Gemini returns raw 24kHz s16le mono PCM. We prepend a 44-byte RIFF/WAVE header in-container so the existing host IPC contract + ffmpeg invocation do not change; intermediate `.wav` files remain playable standalone, which helps debugging.
   - Do NOT include "Why a cloud API for TTS" — that decision is obsolete history.
4. **Configuration** — single-row table: `GEMINI_API_KEY` (host `.env`), purpose: "STT authentication (Telegram channel) and TTS (passed into containers as env var)". State that no local binaries/model files are needed.
5. **Components**
   - `### Host Dependencies` — `ffmpeg` (WAV→OGG conversion), `@grammyjs/files` (voice downloads). Same as today.
   - `### Files` — updated table: `src/channels/telegram.ts`, `src/ipc.ts`, `src/index.ts`, `src/types.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`, plus the new `container/agent-runner/src/pcm-to-wav.ts` and `container/agent-runner/src/gemini-tts-request.ts` helpers.
6. **Error Handling** — the rows from the spec §"Error handling" (including the new Gemini rows: `finishReason`/`promptFeedback` logging, modality-mismatch text-instead-of-audio). Use the correct timeouts (STT 60s, TTS 300s) and the correct text-length limit (50000 chars). Do not carry forward the old doc's stale "5000 chars" or "TTS timeout (60s)" phrasings.
7. **Cost** — per spec: TTS $1/M text-input tokens, $20/M audio-output tokens (batch: half). STT priced at `gemini-2.5-flash-lite` input-audio rates. If you can confirm current audio-input pricing cheaply during the rewrite, include concrete per-minute and per-voice-reply estimates; otherwise write the rate card as above and add a footnote: `*Pricing confirmed at https://ai.google.dev/pricing on {date}; check the live page for current rates.*`
8. **Limitations** — remove "No Norwegian TTS" (Gemini supports `nb` and `nn`). Add:
   - "No mid-conversation voice swap" (voice is a compile-time constant).
   - "No streaming TTS" (audio is fully generated before sending).
   - Retain "Only Telegram has voice support" (still true).
   - Retain "No voice cloning" (still true, rewording optional).
9. **Security** — update references to use `GEMINI_API_KEY`. Retain the existing bullets about path restriction, IPC path validation, and authorization model. Add one line: key injection bypasses OneCLI intentionally, matching the prior Mistral pattern.

Do not carry over any sentence that mentions Mistral or Voxtral. Do not retain the "Why a cloud API for TTS" section.

- [ ] **Step 1: Rewrite the file end-to-end**

Replace the full contents of `docs/speech.md` with a Gemini-focused version that covers the sections above. Do not retain any sentence that mentions Mistral, Voxtral, or the old limits (5000 chars, 60s TTS timeout).

- [ ] **Step 2: Confirm no stale strings remain**

Run each:
```
grep -n -i mistral docs/speech.md
grep -n -i voxtral docs/speech.md
grep -n '5000 chars' docs/speech.md
grep -n '60s' docs/speech.md
```
Expected: All return empty.

- [ ] **Step 3: Commit**

```bash
git add docs/speech.md
git commit -m "docs(speech): rewrite for Gemini TTS/STT

Replace Mistral-centric documentation with Gemini. Corrects two
pre-existing stale values along the way (TTS char limit 50000, not
5000; TTS timeout 300s, not 60s). Removes 'No Norwegian TTS'
limitation; Gemini supports nb and nn."
```

---

## Task 10: Repo-wide Mistral sweep

**Why:** Catch anything the preceding tasks missed. Historical plan/spec docs are explicitly left alone per the migration spec's "Docs left alone" section, but any active-path code or config reference to Mistral is a bug.

**Files:** None to modify in this task (it's a verification task). If this task finds a stray reference, open a new task to fix it; do not silently patch.

- [ ] **Step 1: Search for any `MISTRAL` / `mistral` reference outside the historical plans and build artifacts**

Run:
```
grep -rn -i mistral . \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' \
  --include='*.md' --include='*.sh' --include='.env.example' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
  --exclude-dir=.next --exclude-dir=data --exclude-dir=store \
  | grep -v 'docs/superpowers/plans/' \
  | grep -v 'docs/superpowers/specs/2026-04-12-' \
  | grep -v 'docs/superpowers/specs/2026-04-18-gemini-'
```

Expected: Empty. Anything that surfaces is a live reference that the preceding tasks missed.

**Excluded (intentionally):** `node_modules/`, `dist/` and other build output, `.git/`, `.next/`, `data/` (LightRAG working dir), `store/` (binary SQLite). Historical plan and spec docs are excluded by the trailing `grep -v` filters because the migration spec explicitly lists them as "Docs left alone".

- [ ] **Step 2: If anything surfaces, file it as a follow-up**

If the grep returns non-empty output, leave a note at the bottom of this plan file under a new "Follow-ups" section describing the stray reference, and do not proceed to Task 11 until it is resolved.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Typecheck host + container**

Run: `npx tsc --noEmit && cd container/agent-runner && npx tsc --noEmit && cd ../..`
Expected: Both exit 0.

- [ ] **Step 5: Commit (only if this task uncovered and fixed something; otherwise skip)**

This is a verification task. If nothing changed, no commit is needed.

---

## Task 11: Pre-merge gate — build, container rebuild, manual smoke, PR

**Why:** Audio paths cannot be fully unit-tested. This task gates the PR on the seven-step manual smoke checklist from the spec plus a clean build of the container image.

**Files:** None.

**Prerequisite:** The `.env` file must already have `GEMINI_API_KEY` set (renamed from the prior lowercase `google_api_key`; `MISTRAL_API_KEY` deleted). If not, STOP and surface to the user before continuing — the agent must not rename env vars in the user's `.env` without explicit confirmation.

- [ ] **Step 1: Confirm the user has migrated `.env`**

Ask the user: "Before I run the smoke checklist, please confirm your local `.env` has `GEMINI_API_KEY=...` (same value that was in `google_api_key`) and that `MISTRAL_API_KEY` is deleted."

Do not proceed until confirmed.

- [ ] **Step 2: Clean build**

Run: `npm run build`
Expected: Exits 0.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Rebuild the container (prune builder first — default for this PR)**

Per `CLAUDE.md`: the builder cache is aggressive and `--no-cache` alone does NOT invalidate COPY steps. Since this migration rewrites a container-side file (`ipc-mcp-stdio.ts`) AND adds two new source files (`pcm-to-wav.ts`, `gemini-tts-request.ts`) that must land in the image, prune the builder before rebuilding rather than treating the prune as a fallback.

Run:
```
docker builder prune -af
./container/build.sh
```
Expected: Build succeeds and the new helper files appear in the compiled image. Note the image tag.

- [ ] **Step 5: Restart NanoClaw**

Per `CLAUDE.md` on macOS:
```
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
Or, if running via `npm run dev`: stop and re-run `npm run dev`.

- [ ] **Step 6: Manual smoke checklist (from spec)**

Run each check and tick it off only after observing the expected behavior:

- [ ] Send a short English voice note to Telegram → agent receives `[Voice]: ...` with correct transcript.
- [ ] Send a Norwegian voice note → transcript is Norwegian with accented characters (æ, ø, å) rendered correctly as UTF-8.
- [ ] Ask agent to speak → receive a Telegram voice bubble that plays, has a waveform, and sounds like the Kore voice.
- [ ] Ask agent to speak Norwegian → plays Norwegian audio.
- [ ] Ask agent to speak using `style_prompt: "Say warmly and slowly"` → tone is noticeably warmer and slower. **A/B check** (turns the subjective call into an observable one): first ask the agent to speak the same sentence WITHOUT `style_prompt`, then WITH it. Listen to both back-to-back. The two must audibly differ; if they sound identical the `style_prompt` prepend path is broken.
- [ ] Ask agent to speak with inline `[whispering]` / `[slowly]` tags → tags honored at the tagged position.
- [ ] Temporarily unset `GEMINI_API_KEY` and restart; send a voice note → `[Voice message (transcription failed)]`. Ask agent to speak → text-only fallback with sensible error message. Restore `GEMINI_API_KEY` and restart.

If Step 1 of the smoke checklist (English STT) fails with a 400 response, swap the STT model: in `src/channels/telegram.ts` change `const GEMINI_STT_MODEL = 'gemini-2.5-flash-lite';` to `'gemini-2.5-flash';`, rebuild, and re-run. Commit as `chore(stt): pivot to gemini-2.5-flash — lite rejects audio`.

- [ ] **Step 7: Push branch and open PR**

Run: `git push -u origin feat/gemini-tts-stt-migration`
Run: `gh pr create --base main --title "feat(speech): migrate TTS/STT from Mistral to Google Gemini" --body "$(cat <<'EOF'
## Summary
- Replaces Mistral with Google Gemini across both audio paths (host-side STT, container-side TTS).
- Enables Norwegian TTS (Gemini supports nb/nn; Mistral did not).
- Adds optional `style_prompt` param to the `synthesize_speech` MCP tool for whole-utterance tone control. Inline `[tags]` remain available inside `text` for moment-level expression.
- Hardcodes TTS voice to `Kore` (easy one-constant swap in `ipc-mcp-stdio.ts`). STT model is `gemini-2.5-flash-lite` with a documented fallback to `gemini-2.5-flash` (also one-constant swap).
- Standardizes env var to `GEMINI_API_KEY`. `MISTRAL_API_KEY` and the prior lowercase `google_api_key` are removed.
- Host ffmpeg WAV→OGG pipeline is untouched — container wraps Gemini's base64 PCM as WAV to preserve the existing IPC contract.

## Test plan
- [x] `npm run build`
- [x] `npm test` (new unit tests for `pcmToWav` and `buildGeminiTtsRequest`; all prior tests pass)
- [x] `./container/build.sh`
- [x] English STT smoke
- [x] Norwegian STT smoke (æ/ø/å render)
- [x] English TTS smoke (Kore voice, waveform in Telegram)
- [x] Norwegian TTS smoke
- [x] `style_prompt` smoke (warmer/slower)
- [x] Inline audio tags smoke
- [x] Missing `GEMINI_API_KEY` graceful-fallback smoke

## Docs
- Spec: \`docs/superpowers/specs/2026-04-18-gemini-tts-stt-migration-design.md\`
- Plan: \`docs/superpowers/plans/2026-04-18-gemini-tts-stt-migration-plan.md\`
- Rewrote \`docs/speech.md\`, updated \`docs/ARCHITECTURE.md\`, \`CLAUDE.md\`, \`.env.example\`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"`

Target repo: `SimonKvalheim/universityClaw` (never upstream `qwibitai/nanoclaw`).

- [ ] **Step 8: Done**

PR URL printed. Hand back to user for review/merge.

---

## Follow-ups

(Empty. Populate if Task 10 uncovers stray references.)
