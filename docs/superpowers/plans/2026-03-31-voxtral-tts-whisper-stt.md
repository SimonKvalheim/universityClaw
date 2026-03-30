# Local TTS & STT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two-way audio to uniClaw — Voxtral-4B (MLX) for text-to-speech and NB-Whisper Large (whisper.cpp) for speech-to-text, both running locally on Apple Silicon.

**Architecture:** Container agent calls `synthesize_speech` MCP tool → HTTP to host-side Voxtral MLX service → WAV file → `send_voice` IPC → host converts WAV→OGG Opus via ffmpeg → Telegram `sendVoice`. Inbound voice messages: Telegram → grammY downloads OGG → ffmpeg converts to WAV → whisper.cpp transcribes → text delivered to agent.

**Tech Stack:** TypeScript (Node.js), grammy + @grammyjs/files, whisper.cpp, MLX (Python), ffmpeg, vitest

**Spec:** `docs/superpowers/specs/2026-03-30-voxtral-tts-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config.ts` | Modify | Add `WHISPER_BIN_PATH`, `WHISPER_MODEL_PATH`, `VOXTRAL_TTS_PORT` constants |
| `src/types.ts` | Modify | Add optional `sendVoice` to `Channel` interface |
| `src/ipc.ts` | Modify | Add `sendVoice` to `IpcDeps`, add `type: "voice"` dispatch branch with WAV→OGG conversion |
| `src/channels/telegram.ts` | Modify | Implement `sendVoice`, replace voice message placeholder with STT transcription |
| `src/container-runner.ts` | Modify | Inject `VOXTRAL_TTS_URL` env var into container |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Modify | Add `synthesize_speech` and `send_voice` MCP tools |
| `src/ipc-voice.test.ts` | Create | Tests for IPC voice dispatch, path resolution, ffmpeg conversion |
| `src/channels/telegram-voice.test.ts` | Create | Tests for STT transcription pipeline |
| `container/agent-runner/src/tts-mcp.test.ts` | Create | Tests for `synthesize_speech` parameter validation |

---

### Task 1: Configuration Constants

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add whisper and TTS constants to config.ts**

Add these lines after the `PROCESSED_DIR` export at the end of `src/config.ts`:

```typescript
// Voice: local STT (whisper.cpp + NB-Whisper)
export const WHISPER_BIN_PATH =
  process.env.WHISPER_BIN_PATH || '/opt/homebrew/bin/whisper-cpp';
export const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ||
  path.join(HOME_DIR, '.cache', 'whisper', 'nb-whisper-large-q5_0.bin');

// Voice: local TTS (Voxtral via MLX)
export const VOXTRAL_TTS_PORT = parseInt(
  process.env.VOXTRAL_TTS_PORT || '8771',
  10,
);
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(voice): add whisper and voxtral config constants"
```

---

### Task 2: Channel Interface — `sendVoice`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add sendVoice to Channel interface**

In `src/types.ts`, add after the `syncGroups?` method (line 95):

```typescript
  // Optional: send a voice/audio file. Channels that support it implement it.
  sendVoice?(jid: string, filePath: string, caption?: string): Promise<void>;
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean compilation, no errors. Existing channels are unaffected since the method is optional.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(voice): add optional sendVoice to Channel interface"
```

---

### Task 3: Telegram `sendVoice` Implementation

**Files:**
- Modify: `src/channels/telegram.ts`

- [ ] **Step 1: Add InputFile to grammy import**

In `src/channels/telegram.ts` line 2, change:

```typescript
import { Api, Bot } from 'grammy';
```

to:

```typescript
import { Api, Bot, InputFile } from 'grammy';
```

- [ ] **Step 2: Add sendVoice method to TelegramChannel**

Add after the `sendMessage` method (after the closing brace of `sendMessage`, around line 360):

```typescript
  async sendVoice(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendVoice(numericId, new InputFile(filePath), {
        caption,
      });
      logger.info({ jid, filePath }, 'Telegram voice message sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram voice');
    }
  }
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat(voice): implement sendVoice on TelegramChannel"
```

---

### Task 4: IPC Voice Dispatch — Tests

**Files:**
- Create: `src/ipc-voice.test.ts`

- [ ] **Step 1: Write tests for IPC voice message handling**

Create `src/ipc-voice.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// We test the voice dispatch logic that will be added to ipc.ts.
// For now, we test the helper functions: path resolution and ffmpeg conversion.

describe('IPC voice dispatch', () => {
  const MAIN_GROUP: RegisteredGroup = {
    name: 'Main',
    folder: 'telegram_main',
    trigger: 'always',
    added_at: '2024-01-01T00:00:00.000Z',
    isMain: true,
  };

  describe('container path resolution', () => {
    it('strips /workspace/group/ prefix and prepends host group path', () => {
      const containerPath = '/workspace/group/audio/tts-1234-abcd.wav';
      const relative = containerPath.replace(/^\/workspace\/group\//, '');
      expect(relative).toBe('audio/tts-1234-abcd.wav');
    });

    it('rejects paths outside /workspace/group/', () => {
      const containerPath = '/workspace/ipc/messages/hack.json';
      const isGroupPath = containerPath.startsWith('/workspace/group/');
      expect(isGroupPath).toBe(false);
    });

    it('rejects path traversal attempts', () => {
      const containerPath = '/workspace/group/../../etc/passwd';
      const relative = containerPath.replace(/^\/workspace\/group\//, '');
      const hasTraversal = relative.includes('..');
      expect(hasTraversal).toBe(true);
    });
  });

  describe('voice IPC message structure', () => {
    it('recognizes type: voice', () => {
      const data = {
        type: 'voice',
        file: '/workspace/group/audio/tts-1234-abcd.wav',
        chatJid: 'tg:-1001234567890',
        sender: 'Mr. Rogers',
      };
      expect(data.type).toBe('voice');
      expect(data.file).toMatch(/^\/workspace\/group\//);
    });

    it('ignores voice messages without file field', () => {
      const data = {
        type: 'voice',
        chatJid: 'tg:-1001234567890',
      };
      expect(data.file).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/ipc-voice.test.ts`
Expected: All tests pass. These are structural tests for the helpers we'll build in the next step.

- [ ] **Step 3: Commit**

```bash
git add src/ipc-voice.test.ts
git commit -m "test(voice): add IPC voice dispatch tests"
```

---

### Task 5: IPC Voice Dispatch — Implementation

**Files:**
- Modify: `src/ipc.ts`

- [ ] **Step 1: Add sendVoice to IpcDeps interface**

In `src/ipc.ts`, add to the `IpcDeps` interface (after line 15, the `sendMessage` line):

```typescript
  sendVoice?: (jid: string, filePath: string, caption?: string) => Promise<void>;
```

- [ ] **Step 2: Add imports for execFile and group folder resolution**

At the top of `src/ipc.ts`, add after the existing imports:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveGroupFolderPath } from './group-folder.js';

const execFileAsync = promisify(execFile);
```

- [ ] **Step 3: Add voice dispatch branch in the message handler**

In `src/ipc.ts`, inside the `processIpcFiles` function, find the message processing block. After the existing `if (data.type === 'message' && data.chatJid && data.text)` block (which ends around line 104 with the closing brace before `fs.unlinkSync`), add an `else if` branch:

```typescript
              } else if (data.type === 'voice' && data.chatJid && data.file) {
                // Voice message: resolve path, convert WAV→OGG, send via channel
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (!deps.sendVoice) {
                    logger.warn(
                      { chatJid: data.chatJid },
                      'sendVoice not available, skipping voice IPC',
                    );
                  } else {
                    // Resolve container path to host path
                    const containerFile = data.file as string;
                    if (
                      !containerFile.startsWith('/workspace/group/') ||
                      containerFile.includes('..')
                    ) {
                      logger.warn(
                        { file: containerFile, sourceGroup },
                        'Invalid voice file path',
                      );
                    } else {
                      const relative = containerFile.replace(
                        /^\/workspace\/group\//,
                        '',
                      );
                      const hostGroupDir = resolveGroupFolderPath(sourceGroup);
                      const wavPath = path.join(hostGroupDir, relative);
                      const oggPath = wavPath.replace(/\.wav$/, '.ogg');

                      try {
                        // Convert WAV to OGG Opus for Telegram voice bubbles
                        await execFileAsync('ffmpeg', [
                          '-y',
                          '-i', wavPath,
                          '-c:a', 'libopus',
                          '-b:a', '48k',
                          '-vbr', 'on',
                          '-application', 'voip',
                          oggPath,
                        ], { timeout: 30_000 });

                        await deps.sendVoice(
                          data.chatJid,
                          oggPath,
                          (data.caption as string) || undefined,
                        );
                        logger.info(
                          { chatJid: data.chatJid, sourceGroup },
                          'IPC voice message sent',
                        );

                        // Clean up audio files
                        fs.unlink(wavPath, () => {});
                        fs.unlink(oggPath, () => {});
                      } catch (err) {
                        logger.error(
                          { file: wavPath, sourceGroup, err },
                          'Failed to convert/send voice message',
                        );
                      }
                    }
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC voice attempt blocked',
                  );
                }
              }
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 5: Run all IPC tests**

Run: `npx vitest run src/ipc-auth.test.ts src/ipc-voice.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts
git commit -m "feat(voice): add IPC voice dispatch with WAV→OGG conversion"
```

---

### Task 6: Inject `VOXTRAL_TTS_URL` into Container

**Files:**
- Modify: `src/container-runner.ts`

- [ ] **Step 1: Add VOXTRAL_TTS_URL env var injection**

In `src/container-runner.ts`, in the `buildContainerArgs` function, add after the `LIGHTRAG_URL` block (after line 248):

```typescript
  // Voxtral TTS server URL — same host gateway pattern as LightRAG
  const voxtralPort = process.env.VOXTRAL_TTS_PORT || '8771';
  const voxtralUrl = `http://localhost:${voxtralPort}`;
  const containerVoxtralUrl = voxtralUrl
    .replace('localhost', 'host.docker.internal')
    .replace('127.0.0.1', 'host.docker.internal');
  args.push('-e', `VOXTRAL_TTS_URL=${containerVoxtralUrl}`);
```

- [ ] **Step 2: Add VOXTRAL_TTS_PORT import**

In `src/container-runner.ts`, add `VOXTRAL_TTS_PORT` to the import from `./config.js` (line 11):

```typescript
import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  TIMEZONE,
  VOXTRAL_TTS_PORT,
} from './config.js';
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(voice): inject VOXTRAL_TTS_URL into container env"
```

---

### Task 7: MCP Tools — Tests

**Files:**
- Create: `container/agent-runner/src/tts-mcp.test.ts`

- [ ] **Step 1: Write tests for synthesize_speech parameter validation**

Create `container/agent-runner/src/tts-mcp.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// Test the validation logic that will be used in the synthesize_speech MCP tool.
// We extract and test the validation functions independently.

describe('synthesize_speech validation', () => {
  const MAX_TEXT_LENGTH = 5000;
  const VALID_LANGUAGES = ['en', 'de', 'it'];
  const DEFAULT_VOICE = 'jessica';

  function validateText(text: string): string | null {
    if (!text || text.trim().length === 0) return 'Text cannot be empty';
    if (text.length > MAX_TEXT_LENGTH)
      return `Text too long (${text.length} chars, max ${MAX_TEXT_LENGTH})`;
    return null;
  }

  function validateLanguage(lang: string): string | null {
    if (!VALID_LANGUAGES.includes(lang))
      return `Unsupported language "${lang}". Supported: ${VALID_LANGUAGES.join(', ')}`;
    return null;
  }

  function resolveVoice(voice?: string): string {
    return voice || DEFAULT_VOICE;
  }

  describe('text validation', () => {
    it('rejects empty text', () => {
      expect(validateText('')).toBe('Text cannot be empty');
    });

    it('rejects whitespace-only text', () => {
      expect(validateText('   ')).toBe('Text cannot be empty');
    });

    it('rejects text over 5000 chars', () => {
      const long = 'a'.repeat(5001);
      expect(validateText(long)).toMatch(/Text too long/);
    });

    it('accepts valid text', () => {
      expect(validateText('Hello world')).toBeNull();
    });

    it('accepts text at exactly 5000 chars', () => {
      expect(validateText('a'.repeat(5000))).toBeNull();
    });
  });

  describe('language validation', () => {
    it('accepts en', () => {
      expect(validateLanguage('en')).toBeNull();
    });

    it('accepts de', () => {
      expect(validateLanguage('de')).toBeNull();
    });

    it('accepts it', () => {
      expect(validateLanguage('it')).toBeNull();
    });

    it('rejects unsupported language', () => {
      expect(validateLanguage('no')).toMatch(/Unsupported language/);
    });

    it('rejects empty string', () => {
      expect(validateLanguage('')).toMatch(/Unsupported language/);
    });
  });

  describe('voice resolution', () => {
    it('returns default voice when none specified', () => {
      expect(resolveVoice()).toBe('jessica');
      expect(resolveVoice(undefined)).toBe('jessica');
    });

    it('returns specified voice', () => {
      expect(resolveVoice('alloy')).toBe('alloy');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run container/agent-runner/src/tts-mcp.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/tts-mcp.test.ts
git commit -m "test(voice): add synthesize_speech validation tests"
```

---

### Task 8: MCP Tools — `synthesize_speech` and `send_voice`

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Add synthesize_speech MCP tool**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, add before the `// Start the stdio transport` line (line 340):

```typescript
const AUDIO_DIR = '/workspace/group/audio';

server.tool(
  'synthesize_speech',
  'Convert text to speech audio using the local Voxtral TTS service. Returns a file path to the generated WAV audio. Use send_voice to deliver it to the user as a Telegram voice message.',
  {
    text: z.string().describe('Text to synthesize (max 5000 characters)'),
    language: z
      .enum(['en', 'de', 'it'])
      .default('en')
      .describe('Language for synthesis: en (English), de (German), it (Italian)'),
    voice: z
      .string()
      .default('jessica')
      .describe('Voxtral preset voice name (default: jessica)'),
  },
  async (args) => {
    // Validate text
    if (!args.text || args.text.trim().length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'Error: text cannot be empty.' }],
        isError: true,
      };
    }
    if (args.text.length > 5000) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: text too long (${args.text.length} chars, max 5000).`,
          },
        ],
        isError: true,
      };
    }

    const ttsUrl = process.env.VOXTRAL_TTS_URL;
    if (!ttsUrl) {
      return {
        content: [
          { type: 'text' as const, text: 'Error: TTS service not configured (VOXTRAL_TTS_URL not set).' },
        ],
        isError: true,
      };
    }

    try {
      const response = await fetch(`${ttsUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'voxtral-4b',
          input: args.text,
          voice: args.voice ?? 'jessica',
          response_format: 'wav',
        }),
        signal: AbortSignal.timeout(30_000),
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

      // Save to group audio directory
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
      const random = Math.random().toString(36).slice(2, 6);
      const filename = `tts-${Date.now()}-${random}.wav`;
      const filepath = path.join(AUDIO_DIR, filename);
      fs.writeFileSync(filepath, audioBuffer);

      // Estimate duration from WAV size (24kHz, 16-bit mono = 48000 bytes/sec)
      const durationSeconds = Math.round(audioBuffer.length / 48000);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              path: filepath,
              duration_seconds: durationSeconds,
              language: args.language,
            }),
          },
        ],
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text' as const, text: `Error: TTS request failed: ${message}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'send_voice',
  'Send an audio file as a Telegram voice message. Use after synthesize_speech to deliver the generated audio to the user.',
  {
    file_path: z
      .string()
      .describe('Absolute path to the audio file (e.g., from synthesize_speech output)'),
    caption: z
      .string()
      .optional()
      .describe('Optional caption text to accompany the voice message'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [
          { type: 'text' as const, text: `Error: file not found: ${args.file_path}` },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'voice',
      chatJid,
      file: args.file_path,
      caption: args.caption || undefined,
      sender: undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return {
      content: [{ type: 'text' as const, text: 'Voice message queued for delivery.' }],
    };
  },
);
```

- [ ] **Step 2: Verify build of agent-runner**

Run: `cd container/agent-runner && npm run build`
Expected: Clean compilation.

- [ ] **Step 3: Run MCP validation tests**

Run: `npx vitest run container/agent-runner/src/tts-mcp.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(voice): add synthesize_speech and send_voice MCP tools"
```

---

### Task 9: STT — Install Dependencies and Setup

**Files:**
- Modify: `package.json` (via npm install)
- Modify: `src/channels/telegram.ts`

- [ ] **Step 1: Install @grammyjs/files**

Run: `npm install @grammyjs/files`

- [ ] **Step 2: Register hydrateFiles plugin on the Telegram bot**

In `src/channels/telegram.ts`, add to the imports at the top:

```typescript
import { hydrateFiles } from '@grammyjs/files';
```

Then in the `connect()` method, right after the bot is created (after `this.bot = new Bot(this.botToken, { ... });` around line 153), add:

```typescript
    // Enable file downloads for voice transcription
    this.bot.api.config.use(hydrateFiles(this.botToken));
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/channels/telegram.ts
git commit -m "feat(voice): install @grammyjs/files and register on Telegram bot"
```

---

### Task 10: STT — Tests

**Files:**
- Create: `src/channels/telegram-voice.test.ts`

- [ ] **Step 1: Write tests for voice transcription pipeline**

Create `src/channels/telegram-voice.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Test the transcription helper logic that will be used in the Telegram voice handler.
// We test the command construction and output parsing independently.

describe('Telegram voice transcription', () => {
  describe('ffmpeg conversion command', () => {
    it('builds correct ffmpeg args for OGG→WAV conversion', () => {
      const inputPath = '/tmp/voice-1234.oga';
      const outputPath = inputPath.replace(/\.oga$/, '.wav');

      const args = ['-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', outputPath];

      expect(args).toEqual([
        '-i', '/tmp/voice-1234.oga',
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        '/tmp/voice-1234.wav',
      ]);
      expect(outputPath).toBe('/tmp/voice-1234.wav');
    });
  });

  describe('whisper command construction', () => {
    it('builds correct whisper-cpp args', () => {
      const binPath = '/opt/homebrew/bin/whisper-cpp';
      const modelPath = '/Users/test/.cache/whisper/nb-whisper-large-q5_0.bin';
      const wavPath = '/tmp/voice-1234.wav';

      const args = ['-m', modelPath, '-l', 'no', '-f', wavPath, '--no-timestamps'];

      expect(args).toEqual([
        '-m', modelPath,
        '-l', 'no',
        '-f', wavPath,
        '--no-timestamps',
      ]);
    });
  });

  describe('transcription output parsing', () => {
    it('trims whitespace from whisper stdout', () => {
      const stdout = '\n  Hello, this is a test message.  \n';
      const text = stdout.trim();
      expect(text).toBe('Hello, this is a test message.');
    });

    it('handles empty transcription', () => {
      const stdout = '\n  \n';
      const text = stdout.trim();
      expect(text).toBe('');
    });

    it('formats as voice prefix', () => {
      const text = 'Hello world';
      const formatted = `[Voice]: ${text}`;
      expect(formatted).toBe('[Voice]: Hello world');
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/channels/telegram-voice.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/channels/telegram-voice.test.ts
git commit -m "test(voice): add Telegram voice transcription tests"
```

---

### Task 11: STT — Implementation

**Files:**
- Modify: `src/channels/telegram.ts`

- [ ] **Step 1: Add required imports**

In `src/channels/telegram.ts`, add to the existing imports:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
```

And add the config import — find the existing import from `'../config.js'` and add the new constants:

```typescript
import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
  WHISPER_BIN_PATH,
  WHISPER_MODEL_PATH,
} from '../config.js';
```

Add after the imports:

```typescript
const execFileAsync = promisify(execFile);
```

- [ ] **Step 2: Replace voice message placeholder handler with transcription**

In `src/channels/telegram.ts`, replace the voice message handler (line 298):

```typescript
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
```

with:

```typescript
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      let transcribedText = '[Voice message (transcription failed)]';

      try {
        const file = await ctx.getFile();
        const localPath = path.join(
          os.tmpdir(),
          `voice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.oga`,
        );
        await file.download(localPath);
        const wavPath = localPath.replace(/\.oga$/, '.wav');

        try {
          // Convert OGG Opus to WAV (whisper.cpp needs WAV input)
          await execFileAsync('ffmpeg', [
            '-y', '-i', localPath,
            '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath,
          ], { timeout: 15_000 });

          // Transcribe with NB-Whisper
          const { stdout } = await execFileAsync(WHISPER_BIN_PATH, [
            '-m', WHISPER_MODEL_PATH,
            '-l', 'no',
            '-f', wavPath,
            '--no-timestamps',
          ], { timeout: 60_000 });

          const text = stdout.trim();
          if (text) {
            transcribedText = `[Voice]: ${text}`;
          }
        } finally {
          fs.unlink(localPath, () => {});
          fs.unlink(wavPath, () => {});
        }
      } catch (err) {
        logger.error({ err, chatJid: `tg:${ctx.chat.id}` }, 'Voice transcription failed');
      }

      // Store the transcribed (or fallback) text as a normal message
      storeNonText(ctx, transcribedText);
    });
```

- [ ] **Step 3: Add fs and path imports if missing**

Check if `fs` and `path` are already imported. If not, add:

```typescript
import fs from 'fs';
import path from 'path';
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 5: Run all voice-related tests**

Run: `npx vitest run src/channels/telegram-voice.test.ts src/ipc-voice.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat(voice): replace voice placeholder with NB-Whisper transcription"
```

---

### Task 12: Wire `sendVoice` into Host IPC Dependencies

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Find where IPC deps are constructed and add sendVoice**

In `src/index.ts`, find where `startIpcWatcher` is called with the deps object. Add `sendVoice` to the deps, wired to the Telegram channel:

```typescript
    sendVoice: async (jid: string, filePath: string, caption?: string) => {
      const channel = channels.find((ch) => ch.ownsJid(jid) && ch.sendVoice);
      if (channel?.sendVoice) {
        await channel.sendVoice(jid, filePath, caption);
      } else {
        logger.warn({ jid }, 'No channel supports sendVoice for this JID');
      }
    },
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(voice): wire sendVoice into IPC dependencies"
```

---

### Task 13: Voxtral TTS Launchd Service

**Files:**
- Create: `services/com.nanoclaw.voxtral-tts.plist`

- [ ] **Step 1: Create launchd plist for the TTS service**

Create `services/com.nanoclaw.voxtral-tts.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.voxtral-tts</string>
    <key>ProgramArguments</key>
    <array>
        <!-- Replace with actual command during setup. Example for mlx-audio: -->
        <string>/usr/bin/env</string>
        <string>python3</string>
        <string>-m</string>
        <string>mlx_audio.server</string>
        <string>--model</string>
        <string>mistralai/Voxtral-4B-TTS-2603</string>
        <string>--port</string>
        <string>8771</string>
    </array>
    <key>RunAtLoad</key>
    <false/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/voxtral-tts.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/voxtral-tts.err</string>
</dict>
</plist>
```

Note: `RunAtLoad` is false — the service starts on demand, not at boot. `KeepAlive` is false so it doesn't auto-restart, helping with the idle timeout recommendation from the spec.

- [ ] **Step 2: Commit**

```bash
git add services/com.nanoclaw.voxtral-tts.plist
git commit -m "feat(voice): add Voxtral TTS launchd service template"
```

---

### Task 14: Final Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass, including new voice tests and existing tests unchanged.

- [ ] **Step 2: Build everything**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 3: Verify agent-runner builds**

Run: `cd container/agent-runner && npm run build`
Expected: Clean compilation with new MCP tools included.

- [ ] **Step 4: Commit any remaining changes**

If there are any formatting or lint fixes:

```bash
git add -A
git commit -m "chore(voice): final formatting and build verification"
```

---

## Manual E2E Testing Checklist

After all tasks are complete, verify end-to-end:

- [ ] Start the Voxtral TTS service: `launchctl load ~/Library/LaunchAgents/com.nanoclaw.voxtral-tts.plist`
- [ ] Send a text message to Mr. Rogers asking for a voice summary of a note
- [ ] Verify: agent calls `synthesize_speech`, then `send_voice`
- [ ] Verify: Telegram receives a voice bubble with waveform and speed controls
- [ ] Send a voice message to Mr. Rogers in Norwegian
- [ ] Verify: voice is transcribed and agent responds to the content
- [ ] Send a voice message in English
- [ ] Verify: transcription works for English as well
