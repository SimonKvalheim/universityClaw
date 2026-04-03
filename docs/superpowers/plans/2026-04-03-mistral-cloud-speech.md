# Mistral Cloud Speech Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace local TTS (mlx-audio) and STT (whisper-cli) with Mistral cloud APIs, and remove all dead local-model code.

**Architecture:** Container MCP tool calls Mistral TTS API directly (OneCLI injects auth). Host Telegram handler calls Mistral STT API with key from `.env`. Dead code (Voxtral local server config, Whisper binary paths, Ollama remnants) removed across config, container-runner, tests, docs.

**Tech Stack:** Mistral API (`voxtral-mini-tts-2603`, `voxtral-mini-latest`), Node.js `fetch()`, OneCLI credential proxy

**Spec:** `docs/superpowers/specs/2026-04-03-mistral-cloud-speech-design.md`

---

### Task 1: Delete dead files

**Files:**
- Delete: `src/voice-validation.ts`
- Delete: `src/voice-validation.test.ts`
- Delete: `services/com.nanoclaw.voxtral-tts.plist`
- Delete: `src/channels/telegram-voice.test.ts`
- Delete: `.claude/skills/use-local-whisper/SKILL.md`

- [ ] **Step 1: Delete the files**

```bash
rm src/voice-validation.ts src/voice-validation.test.ts services/com.nanoclaw.voxtral-tts.plist src/channels/telegram-voice.test.ts .claude/skills/use-local-whisper/SKILL.md
```

If `.claude/skills/use-local-whisper/` directory is now empty, remove it too:
```bash
rmdir .claude/skills/use-local-whisper 2>/dev/null || true
```

- [ ] **Step 2: Verify build still compiles**

```bash
npm run build
```

Expected: Success. None of these files are imported by production code (voice-validation.ts is duplicated inline in the MCP tool; telegram-voice.test.ts only imports from config).

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: All passing (deleted test files simply won't run).

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "chore: delete dead local-model files

Remove voice-validation module (language enum no longer needed),
Voxtral TTS launchd plist, whisper config tests, and local-whisper skill."
```

---

### Task 2: Remove local-model config from `src/config.ts`

**Files:**
- Modify: `src/config.ts:139-150` (remove WHISPER and VOXTRAL constants)
- Modify: `src/container-runner.test.ts:19` (remove VOXTRAL_TTS_PORT mock)
- Modify: `src/channels/telegram.test.ts:17-18` (remove WHISPER mocks)
- Modify: `src/channels/telegram.ts:14-15` (remove WHISPER imports)

- [ ] **Step 1: Remove config constants**

In `src/config.ts`, delete lines 139-150:
```typescript
// Voice: local STT (whisper.cpp + NB-Whisper)
export const WHISPER_BIN_PATH =
  process.env.WHISPER_BIN_PATH || '/opt/homebrew/bin/whisper-cli';
export const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ||
  path.join(HOME_DIR, '.cache', 'whisper', 'ggml-large-v3-turbo-q5_0.bin');

// Voice: local TTS (Voxtral via MLX)
export const VOXTRAL_TTS_PORT = parseInt(
  process.env.VOXTRAL_TTS_PORT || '8771',
  10,
);
```

- [ ] **Step 2: Remove WHISPER imports from telegram.ts**

In `src/channels/telegram.ts`, change the import block (lines 10-16) from:
```typescript
import {
  ASSISTANT_NAME,
  DATA_DIR,
  TRIGGER_PATTERN,
  WHISPER_BIN_PATH,
  WHISPER_MODEL_PATH,
} from '../config.js';
```
to:
```typescript
import {
  ASSISTANT_NAME,
  DATA_DIR,
  TRIGGER_PATTERN,
} from '../config.js';
```

- [ ] **Step 3: Remove WHISPER mocks from telegram.test.ts**

In `src/channels/telegram.test.ts`, change the config mock (lines 14-20) from:
```typescript
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  WHISPER_BIN_PATH: '/opt/homebrew/bin/whisper-cpp',
  WHISPER_MODEL_PATH: '/tmp/test-model.bin',
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));
```
to:
```typescript
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));
```

- [ ] **Step 4: Remove VOXTRAL_TTS_PORT from container-runner.test.ts**

In `src/container-runner.test.ts`, change the config mock (lines 10-20) from:
```typescript
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
  VOXTRAL_TTS_PORT: 8771,
}));
```
to:
```typescript
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
}));
```

- [ ] **Step 5: Build and test**

```bash
npm run build && npm test
```

Expected: All passing.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/channels/telegram.ts src/channels/telegram.test.ts src/container-runner.test.ts
git commit -m "chore: remove WHISPER and VOXTRAL config constants

No longer running local models for STT or TTS."
```

---

### Task 3: Remove Voxtral URL injection from container-runner

**Files:**
- Modify: `src/container-runner.ts:251-259` (remove Voxtral env injection block)

- [ ] **Step 1: Remove Voxtral injection block**

In `src/container-runner.ts`, delete lines 251-259:
```typescript
  // Voxtral TTS server URL — same host gateway pattern as LightRAG
  const voxtralUrl = `http://localhost:${VOXTRAL_TTS_PORT}`;
  const containerVoxtralUrl = voxtralUrl
    .replace('localhost', 'host.docker.internal')
    .replace('127.0.0.1', 'host.docker.internal');
  args.push('-e', `VOXTRAL_TTS_URL=${containerVoxtralUrl}`);
  if (process.env.VOXTRAL_TTS_MODEL) {
    args.push('-e', `VOXTRAL_TTS_MODEL=${process.env.VOXTRAL_TTS_MODEL}`);
  }
```

Also remove the `VOXTRAL_TTS_PORT` import if it's in the import block. Check the import from `./config.js` and remove `VOXTRAL_TTS_PORT` from it.

- [ ] **Step 2: Build and test**

```bash
npm run build && npm test
```

Expected: All passing.

- [ ] **Step 3: Commit**

```bash
git add src/container-runner.ts
git commit -m "chore: remove Voxtral TTS URL injection from container runner

TTS now calls Mistral API directly; OneCLI handles auth."
```

---

### Task 4: Rewrite `synthesize_speech` MCP tool for Mistral API

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:340-460`

- [ ] **Step 1: Replace the TTS tool implementation**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, replace lines 340-460 (from `const AUDIO_DIR` through the end of the `synthesize_speech` tool handler) with:

```typescript
const AUDIO_DIR = '/workspace/group/audio';
const TTS_MAX_TEXT_LENGTH = 5000;
const MISTRAL_TTS_URL = 'https://api.mistral.ai/v1/audio/speech';

server.tool(
  'synthesize_speech',
  'Convert text to speech audio using the Mistral Voxtral TTS API. Returns a file path to the generated WAV audio. Use send_voice to deliver it to the user as a Telegram voice message.',
  {
    text: z.string().describe('Text to synthesize (max 5000 characters)'),
  },
  async (args) => {
    if (!args.text || args.text.trim().length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'Error: text cannot be empty.' }],
        isError: true,
      };
    }
    if (args.text.length > TTS_MAX_TEXT_LENGTH) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: text too long (${args.text.length} chars, max ${TTS_MAX_TEXT_LENGTH}).`,
          },
        ],
        isError: true,
      };
    }

    try {
      const response = await fetch(MISTRAL_TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'voxtral-mini-tts-2603',
          input: args.text,
          response_format: 'wav',
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: TTS service returned ${response.status}: ${errText}`,
            },
          ],
          isError: true,
        };
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());

      fs.mkdirSync(AUDIO_DIR, { recursive: true });
      const random = Math.random().toString(36).slice(2, 6);
      const filename = `tts-${Date.now()}-${random}.wav`;
      const filepath = path.join(AUDIO_DIR, filename);
      fs.writeFileSync(filepath, audioBuffer);

      // Estimate duration from WAV size (24kHz, 16-bit mono = 48000 bytes/sec, minus 44-byte header)
      const durationSeconds = Math.max(0, Math.round((audioBuffer.length - 44) / 48000));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              path: filepath,
              duration_seconds: durationSeconds,
            }),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text' as const, text: `Error: TTS request failed: ${message}` },
        ],
        isError: true,
      };
    }
  },
);
```

Key changes from old code:
- Removed `LANGUAGE_VOICE_MAP` and `language` parameter
- URL changed from `VOXTRAL_TTS_URL` env var to hardcoded Mistral API URL
- Model changed to `voxtral-mini-tts-2603`
- No `voice` parameter in request body (using default voice)
- Timeout increased from 30s to 60s
- No auth header — OneCLI proxy injects it

- [ ] **Step 2: Rebuild agent container**

```bash
./container/build.sh
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(tts): switch synthesize_speech to Mistral cloud API

Replace local mlx-audio server call with Mistral's /v1/audio/speech
endpoint. OneCLI injects auth in container. Timeout bumped to 60s."
```

---

### Task 5: Rewrite Telegram STT to use Mistral API

**Files:**
- Modify: `src/channels/telegram.ts:370-436` (voice handler)
- Modify: `src/channels/telegram.ts:1-6` (imports — remove `execFile`/`promisify` if no longer needed)
- Modify: `src/channels/telegram.ts:610-611` (readEnvFile — add MISTRAL_API_KEY)

- [ ] **Step 1: Add MISTRAL_API_KEY to readEnvFile**

In `src/channels/telegram.ts`, change line 611 from:
```typescript
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
```
to:
```typescript
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'MISTRAL_API_KEY']);
```

And store the key so the channel instance can use it. In the factory function (around line 612-618), pass it to the constructor. The simplest approach: add `mistralApiKey` to the `TelegramChannel` class.

Add a property to the class and update the constructor to accept it:
```typescript
private mistralApiKey: string;
```

Pass it from the factory:
```typescript
const mistralApiKey = process.env.MISTRAL_API_KEY || envVars.MISTRAL_API_KEY || '';
if (!mistralApiKey) {
  logger.warn('Telegram: MISTRAL_API_KEY not set — voice transcription disabled');
}
return new TelegramChannel(token, opts, mistralApiKey);
```

- [ ] **Step 2: Replace whisper subprocess with Mistral fetch**

In `src/channels/telegram.ts`, replace the voice handler body (lines ~374-432). The new handler:

```typescript
      let transcribedText = '[Voice message (transcription failed)]';

      try {
        const file = await ctx.getFile();
        const localPath = path.join(
          os.tmpdir(),
          `voice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.oga`,
        );
        await file.download(localPath);

        try {
          if (!this.mistralApiKey) {
            logger.warn('Skipping transcription — no MISTRAL_API_KEY');
          } else {
            const audioData = fs.readFileSync(localPath);
            const formData = new FormData();
            formData.append('model', 'voxtral-mini-latest');
            formData.append(
              'file',
              new Blob([audioData], { type: 'audio/ogg' }),
              'voice.oga',
            );

            const response = await fetch(
              'https://api.mistral.ai/v1/audio/transcriptions',
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${this.mistralApiKey}`,
                },
                body: formData,
                signal: AbortSignal.timeout(60_000),
              },
            );

            if (response.ok) {
              const result = (await response.json()) as { text?: string };
              const text = result.text?.trim();
              if (text) {
                transcribedText = `[Voice]: ${text}`;
              }
            } else {
              const errText = await response.text().catch(() => '');
              logger.error(
                { status: response.status, body: errText },
                'Mistral STT request failed',
              );
            }
          }
        } finally {
          fs.unlink(localPath, () => {});
        }
      } catch (err) {
        logger.error(
          { err, chatJid: `tg:${ctx.chat.id}` },
          'Voice transcription failed',
        );
      }

      storeNonText(ctx, transcribedText);
```

Key changes:
- No ffmpeg conversion (send .oga directly)
- No whisper subprocess — single `fetch()` call
- Only one temp file to clean up instead of two
- Graceful degradation if `MISTRAL_API_KEY` is missing

- [ ] **Step 3: Clean up imports**

Remove `execFile` and `promisify` imports at the top of `telegram.ts` if they are no longer used anywhere else in the file. Check first — they may be used for other purposes. If the only use was `const execFileAsync = promisify(execFile)` for whisper, remove it.

- [ ] **Step 4: Build and test**

```bash
npm run build && npm test
```

Expected: Build succeeds, tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat(stt): switch voice transcription to Mistral cloud API

Replace local whisper-cli subprocess with Mistral's /v1/audio/transcriptions.
Sends .oga directly — no ffmpeg conversion needed for STT."
```

---

### Task 6: Clean up `.env.example` and `lightrag-server.sh` (Ollama remnants)

**Files:**
- Modify: `.env.example`
- Modify: `scripts/lightrag-server.sh`

- [ ] **Step 1: Update .env.example**

Replace the entire file with:
```bash
TELEGRAM_BOT_TOKEN=

# universityClaw config
VAULT_DIR=./vault
UPLOAD_DIR=./upload
DASHBOARD_PORT=3100

# --- Mistral API (TTS + STT) ---
MISTRAL_API_KEY=

# --- LightRAG ---
LIGHTRAG_PORT=9621

# Required when using openai binding
OPENAI_API_KEY=

LIGHTRAG_LLM_BINDING=openai
LIGHTRAG_LLM_MODEL=gpt-4o-mini
LIGHTRAG_EMBED_BINDING=openai
LIGHTRAG_EMBED_MODEL=text-embedding-3-small
LIGHTRAG_EMBED_DIM=1536

# --- LightRAG Parallelism ---
# LLM concurrency (entity extraction):
LIGHTRAG_MAX_ASYNC=16
LIGHTRAG_MAX_PARALLEL_INSERT=8
#
# Embedding concurrency (vector indexing):
LIGHTRAG_EMBED_MAX_ASYNC=16
LIGHTRAG_EMBED_BATCH_NUM=32
```

Removed: `LIGHTRAG_OLLAMA_HOST`, all Ollama comments and tuning hints.
Added: `MISTRAL_API_KEY`.

- [ ] **Step 2: Clean up lightrag-server.sh**

In `scripts/lightrag-server.sh`, remove the Ollama conditional blocks and comments.

Remove lines 16-17 (Ollama host comment):
```bash
#   LIGHTRAG_OLLAMA_HOST        (default: http://localhost:11434)
```

Remove lines 23-24 and 27-28 (Ollama tuning comments):
```bash
#     Reduce to 4/2 if using local Ollama instead of a remote API.
```
```bash
#     Reduce to 1/4 if using local Ollama instead of a remote API.
```

Remove lines 61-67 (Ollama conditional blocks):
```bash
# Only set binding hosts for Ollama — OpenAI uses its own default (https://api.openai.com/v1)
if [[ "$LLM_BINDING" == "ollama" ]]; then
  export LLM_BINDING_HOST="${LIGHTRAG_OLLAMA_HOST:-http://localhost:11434}"
fi
if [[ "$EMBEDDING_BINDING" == "ollama" ]]; then
  export EMBEDDING_BINDING_HOST="${LIGHTRAG_OLLAMA_HOST:-http://localhost:11434}"
fi
```

Remove line 70 comment:
```bash
# Defaults tuned for remote APIs (OpenAI). Reduce if using local Ollama.
```

And line 74 comment:
```bash
# Embedding concurrency: reduce to 1/4 for local Ollama
```

- [ ] **Step 3: Verify LightRAG script still works**

```bash
bash -n scripts/lightrag-server.sh
```

Expected: No syntax errors.

- [ ] **Step 4: Commit**

```bash
git add .env.example scripts/lightrag-server.sh
git commit -m "chore: remove Ollama remnants from env and LightRAG script

Clean up .env.example and lightrag-server.sh. Add MISTRAL_API_KEY.
All model inference now uses external APIs (OpenAI, Mistral)."
```

---

### Task 7: Update documentation

**Files:**
- Modify: `CLAUDE.md:110,160-179`
- Modify: `docs/speech.md` (full rewrite)
- Modify: `docs/superpowers/specs/2026-03-30-voxtral-tts-design.md` (mark superseded)
- Modify: `docs/superpowers/plans/2026-03-31-voxtral-tts-whisper-stt.md` (mark superseded)

- [ ] **Step 1: Update CLAUDE.md service stack**

In `CLAUDE.md`, the service stack section (line 110) says "4 services". Voxtral TTS was never in the table but the docs may reference it. Verify table is still accurate (NanoClaw, LightRAG, OneCLI, Dashboard). No change needed to the table itself.

Update the environment variables table (lines 164-179). Replace the Ollama-default rows:
```markdown
| `LLM_BINDING` | `ollama` | LightRAG LLM provider (entity extraction) |
| `LLM_MODEL` | `qwen2.5:3b` | LightRAG LLM model |
| `EMBEDDING_BINDING` | `ollama` | LightRAG embedding provider |
| `EMBEDDING_MODEL` | `bge-m3:latest` | LightRAG embedding model |
```
with:
```markdown
| `MISTRAL_API_KEY` | — | Mistral API key (TTS + STT) |
| `LIGHTRAG_LLM_BINDING` | `openai` | LightRAG LLM provider |
| `LIGHTRAG_LLM_MODEL` | `gpt-4o-mini` | LightRAG LLM model |
| `LIGHTRAG_EMBED_BINDING` | `openai` | LightRAG embedding provider |
| `LIGHTRAG_EMBED_MODEL` | `text-embedding-3-small` | LightRAG embedding model |
```

- [ ] **Step 2: Rewrite docs/speech.md**

Replace the entire file. The new version should document:
- Cloud API architecture (no local dependencies)
- TTS: Mistral API from container, OneCLI auth, WAV→OGG for Telegram
- STT: Mistral API from host, direct .oga upload, no ffmpeg needed
- Components table (only ffmpeg and @grammyjs/files remain)
- Configuration: `MISTRAL_API_KEY` in `.env`, no local binaries
- Error handling (same patterns, new error sources)
- Cost estimates

Remove all references to: mlx-audio, whisper-cli, local model RAM usage, Voxtral voice presets, NB-Whisper, GGML models, launchd plist, Homebrew dependencies.

- [ ] **Step 3: Mark old specs as superseded**

Add to the top of `docs/superpowers/specs/2026-03-30-voxtral-tts-design.md`:
```markdown
> **Superseded** by `2026-04-03-mistral-cloud-speech-design.md` — local TTS replaced with Mistral cloud API.

```

Add to the top of `docs/superpowers/plans/2026-03-31-voxtral-tts-whisper-stt.md`:
```markdown
> **Superseded** by `plans/2026-04-03-mistral-cloud-speech.md` — local speech stack replaced with Mistral cloud APIs.

```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/speech.md docs/superpowers/specs/2026-03-30-voxtral-tts-design.md docs/superpowers/plans/2026-03-31-voxtral-tts-whisper-stt.md
git commit -m "docs: update speech docs for Mistral cloud API migration

Rewrite speech.md, update CLAUDE.md env vars table, mark old
local-model specs as superseded."
```

---

### Task 8: Update telegram.test.ts for new STT

**Files:**
- Modify: `src/channels/telegram.test.ts`

- [ ] **Step 1: Check what the telegram tests currently cover**

Read `src/channels/telegram.test.ts` fully to understand existing test structure. The voice-related tests may need fetch mocks instead of whisper subprocess mocks. Add a mock for `global.fetch` if the test file exercises the voice handler path.

If the existing tests don't directly test the voice transcription path (they may only test message routing, trigger patterns, etc.), the mock removal from Task 2 may be sufficient.

- [ ] **Step 2: Build and run full test suite**

```bash
npm run build && npm test
```

Expected: All passing. Fix any remaining test failures.

- [ ] **Step 3: Commit (if changes needed)**

```bash
git add src/channels/telegram.test.ts
git commit -m "test: update telegram tests for Mistral STT migration"
```

---

### Task 9: End-to-end verification

- [ ] **Step 1: Verify build is clean**

```bash
npm run build
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

- [ ] **Step 3: Check for stale references**

Search for any remaining references to removed concepts:

```bash
grep -r "WHISPER_BIN\|WHISPER_MODEL\|VOXTRAL_TTS_PORT\|VOXTRAL_TTS_URL\|VOXTRAL_TTS_MODEL\|mlx.audio\|mlx_audio\|whisper-cli\|whisper\.cpp" src/ container/ scripts/ --include='*.ts' --include='*.sh' --include='*.json'
```

Expected: No matches in source files (docs may still reference for historical context, that's fine).

```bash
grep -r "ollama\|Ollama\|OLLAMA" src/ scripts/ .env.example --include='*.ts' --include='*.sh'
```

Expected: No matches (Ollama fully removed from source and config).

- [ ] **Step 4: Verify container builds**

```bash
./container/build.sh
```

Expected: Clean build.

- [ ] **Step 5: Smoke test (manual)**

Start NanoClaw and send a voice message on Telegram. Verify:
1. STT: Voice message is transcribed and appears as `[Voice]: <text>`
2. TTS: Ask Mr. Rogers to speak — `synthesize_speech` calls Mistral API, voice message delivered

If OneCLI doesn't have Mistral domain configured, the TTS call will fail with an auth error — fix OneCLI config and retry.
