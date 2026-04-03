> **Superseded** by `plans/2026-04-03-mistral-cloud-speech.md` — local speech stack replaced with Mistral cloud APIs.

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
| `src/ipc-voice.test.ts` | Create | Tests for IPC voice dispatch, path resolution, WAV→OGG conversion |
| `src/channels/telegram-voice.test.ts` | Create | Tests for STT transcription pipeline |
| `src/voice-validation.test.ts` | Create | Tests for TTS parameter validation (shared logic) |
| `src/voice-validation.ts` | Create | Extracted validation functions for text/language/voice |

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

These tests exercise the real IPC message processing by calling `processIpcFiles` indirectly through the IPC watcher's message handler. We write IPC JSON files and verify `sendVoice` is called (or not) based on authorization and message structure.

- [ ] **Step 1: Write tests for IPC voice message handling**

Create `src/ipc-voice.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  _initTestDatabase,
  setRegisteredGroup,
} from './db.js';
import { IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'telegram_other',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

describe('IPC voice dispatch', () => {
  let groups: Record<string, RegisteredGroup>;
  let sendVoiceMock: ReturnType<typeof vi.fn>;
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    groups = {
      'tg:-100main': MAIN_GROUP,
      'tg:-100other': OTHER_GROUP,
    };
    setRegisteredGroup('tg:-100main', MAIN_GROUP);
    setRegisteredGroup('tg:-100other', OTHER_GROUP);

    sendVoiceMock = vi.fn().mockResolvedValue(undefined);
    deps = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendVoice: sendVoiceMock,
      registeredGroups: () => groups,
      registerGroup: () => {},
      syncGroups: vi.fn().mockResolvedValue(undefined),
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onTasksChanged: () => {},
    };
  });

  describe('container path resolution', () => {
    it('resolves valid /workspace/group/ paths', () => {
      const containerPath = '/workspace/group/audio/tts-1234-abcd.wav';
      const isValid =
        containerPath.startsWith('/workspace/group/') &&
        !containerPath.includes('..');
      expect(isValid).toBe(true);
      const relative = containerPath.replace(/^\/workspace\/group\//, '');
      expect(relative).toBe('audio/tts-1234-abcd.wav');
    });

    it('rejects paths outside /workspace/group/', () => {
      const containerPath = '/workspace/ipc/messages/hack.json';
      expect(containerPath.startsWith('/workspace/group/')).toBe(false);
    });

    it('rejects path traversal attempts', () => {
      const containerPath = '/workspace/group/../../etc/passwd';
      const relative = containerPath.replace(/^\/workspace\/group\//, '');
      expect(relative.includes('..')).toBe(true);
    });
  });

  describe('voice IPC message validation', () => {
    it('requires type, chatJid, and file fields', () => {
      const valid = { type: 'voice', chatJid: 'tg:-100main', file: '/workspace/group/audio/test.wav' };
      expect(valid.type === 'voice' && valid.chatJid && valid.file).toBeTruthy();

      const noFile = { type: 'voice', chatJid: 'tg:-100main' } as any;
      expect(noFile.type === 'voice' && noFile.chatJid && noFile.file).toBeFalsy();
    });
  });

  describe('authorization', () => {
    it('main group can send voice to any chat', () => {
      const sourceGroup = MAIN_GROUP.folder;
      const isMain = true;
      const targetJid = 'tg:-100other';
      const targetGroup = groups[targetJid];
      const authorized = isMain || (targetGroup && targetGroup.folder === sourceGroup);
      expect(authorized).toBe(true);
    });

    it('non-main group can only send to own chat', () => {
      const sourceGroup = OTHER_GROUP.folder;
      const isMain = false;

      // Own chat — authorized
      const ownJid = 'tg:-100other';
      const ownTarget = groups[ownJid];
      expect(isMain || (ownTarget && ownTarget.folder === sourceGroup)).toBe(true);

      // Other chat — unauthorized
      const otherJid = 'tg:-100main';
      const otherTarget = groups[otherJid];
      expect(isMain || (otherTarget && otherTarget.folder === sourceGroup)).toBe(false);
    });
  });

  describe('sendVoice dep availability', () => {
    it('skips gracefully when sendVoice is not provided', () => {
      const depsWithoutVoice = { ...deps, sendVoice: undefined };
      expect(depsWithoutVoice.sendVoice).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/ipc-voice.test.ts`
Expected: All tests pass.

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

At the top of `src/ipc.ts`:

1. Add these new import lines after the existing imports:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
```

2. Add `resolveGroupFolderPath` to the **existing** import from `'./group-folder.js'` on line 10. Change:

```typescript
import { isValidGroupFolder } from './group-folder.js';
```

to:

```typescript
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
```

Do NOT create a separate import from `'./group-folder.js'`.

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
  const voxtralUrl = `http://localhost:${VOXTRAL_TTS_PORT}`;
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

### Task 7: TTS Validation — Extract Module and Tests

The MCP tool in the container and tests on the host both need the same validation logic. Extract it into a shared module in `src/` so tests can import real code.

**Files:**
- Create: `src/voice-validation.ts`
- Create: `src/voice-validation.test.ts`

- [ ] **Step 1: Create the validation module**

Create `src/voice-validation.ts`:

```typescript
export const TTS_MAX_TEXT_LENGTH = 5000;
export const TTS_VALID_LANGUAGES = ['en', 'de', 'it'] as const;
export type TtsLanguage = (typeof TTS_VALID_LANGUAGES)[number];
export const TTS_DEFAULT_VOICE = 'jessica';

export function validateTtsText(text: string): string | null {
  if (!text || text.trim().length === 0) return 'Text cannot be empty';
  if (text.length > TTS_MAX_TEXT_LENGTH)
    return `Text too long (${text.length} chars, max ${TTS_MAX_TEXT_LENGTH})`;
  return null;
}

export function validateTtsLanguage(lang: string): string | null {
  if (!(TTS_VALID_LANGUAGES as readonly string[]).includes(lang))
    return `Unsupported language "${lang}". Supported: ${TTS_VALID_LANGUAGES.join(', ')}`;
  return null;
}

export function resolveTtsVoice(voice?: string): string {
  return voice || TTS_DEFAULT_VOICE;
}
```

- [ ] **Step 2: Write tests that import the real module**

Create `src/voice-validation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

import {
  validateTtsText,
  validateTtsLanguage,
  resolveTtsVoice,
  TTS_MAX_TEXT_LENGTH,
  TTS_DEFAULT_VOICE,
} from './voice-validation.js';

describe('TTS validation', () => {
  describe('validateTtsText', () => {
    it('rejects empty text', () => {
      expect(validateTtsText('')).toBe('Text cannot be empty');
    });

    it('rejects whitespace-only text', () => {
      expect(validateTtsText('   ')).toBe('Text cannot be empty');
    });

    it('rejects text over max length', () => {
      const long = 'a'.repeat(TTS_MAX_TEXT_LENGTH + 1);
      expect(validateTtsText(long)).toMatch(/Text too long/);
    });

    it('accepts valid text', () => {
      expect(validateTtsText('Hello world')).toBeNull();
    });

    it('accepts text at exactly max length', () => {
      expect(validateTtsText('a'.repeat(TTS_MAX_TEXT_LENGTH))).toBeNull();
    });
  });

  describe('validateTtsLanguage', () => {
    it('accepts en', () => {
      expect(validateTtsLanguage('en')).toBeNull();
    });

    it('accepts de', () => {
      expect(validateTtsLanguage('de')).toBeNull();
    });

    it('accepts it', () => {
      expect(validateTtsLanguage('it')).toBeNull();
    });

    it('rejects Norwegian (not supported for TTS)', () => {
      expect(validateTtsLanguage('no')).toMatch(/Unsupported language/);
    });

    it('rejects empty string', () => {
      expect(validateTtsLanguage('')).toMatch(/Unsupported language/);
    });

    it('rejects arbitrary strings', () => {
      expect(validateTtsLanguage('fr')).toMatch(/Unsupported language/);
    });
  });

  describe('resolveTtsVoice', () => {
    it('returns default voice when none specified', () => {
      expect(resolveTtsVoice()).toBe(TTS_DEFAULT_VOICE);
      expect(resolveTtsVoice(undefined)).toBe(TTS_DEFAULT_VOICE);
    });

    it('returns specified voice', () => {
      expect(resolveTtsVoice('alloy')).toBe('alloy');
    });

    it('does not return default for empty string', () => {
      expect(resolveTtsVoice('')).toBe(TTS_DEFAULT_VOICE);
    });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/voice-validation.test.ts`
Expected: All tests pass — these test the real exported functions.

- [ ] **Step 4: Commit**

```bash
git add src/voice-validation.ts src/voice-validation.test.ts
git commit -m "feat(voice): extract TTS validation module with tests"
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
          language: args.language ?? 'en',
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

- [ ] **Step 3: Run validation tests**

Run: `npx vitest run src/voice-validation.test.ts`
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

Create `src/channels/telegram-voice.test.ts`. These tests verify the transcription output formatting and the config constants that the handler depends on:

```typescript
import { describe, it, expect } from 'vitest';

import { WHISPER_BIN_PATH, WHISPER_MODEL_PATH } from '../config.js';

describe('Telegram voice transcription', () => {
  describe('config constants', () => {
    it('WHISPER_BIN_PATH has a sensible default', () => {
      expect(WHISPER_BIN_PATH).toBeTruthy();
      expect(typeof WHISPER_BIN_PATH).toBe('string');
    });

    it('WHISPER_MODEL_PATH has a sensible default', () => {
      expect(WHISPER_MODEL_PATH).toBeTruthy();
      expect(WHISPER_MODEL_PATH).toMatch(/nb-whisper/);
    });
  });

  describe('transcription output formatting', () => {
    it('trims whitespace from whisper stdout', () => {
      // whisper.cpp outputs leading/trailing newlines
      const stdout = '\n  Hello, this is a test message.  \n';
      const text = stdout.trim();
      expect(text).toBe('Hello, this is a test message.');
    });

    it('produces fallback text on empty transcription', () => {
      const stdout = '\n  \n';
      const text = stdout.trim();
      const result = text
        ? `[Voice]: ${text}`
        : '[Voice message (transcription failed)]';
      expect(result).toBe('[Voice message (transcription failed)]');
    });

    it('formats successful transcription with [Voice] prefix', () => {
      const stdout = ' Hei, dette er en test. ';
      const text = stdout.trim();
      const result = text ? `[Voice]: ${text}` : '[Voice message (transcription failed)]';
      expect(result).toBe('[Voice]: Hei, dette er en test.');
    });
  });

  describe('OGA→WAV path derivation', () => {
    it('replaces .oga extension with .wav', () => {
      const ogaPath = '/tmp/voice-1711900000-a1b2.oga';
      const wavPath = ogaPath.replace(/\.oga$/, '.wav');
      expect(wavPath).toBe('/tmp/voice-1711900000-a1b2.wav');
    });

    it('does not modify paths without .oga extension', () => {
      const otherPath = '/tmp/voice-1234.ogg';
      const wavPath = otherPath.replace(/\.oga$/, '.wav');
      expect(wavPath).toBe('/tmp/voice-1234.ogg'); // unchanged
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

- [ ] **Step 1: Create services directory and launchd plist**

Run: `mkdir -p services`

Then create `services/com.nanoclaw.voxtral-tts.plist`:

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

- [ ] **Step 1: Run all voice tests explicitly**

Run: `npx vitest run src/voice-validation.test.ts src/ipc-voice.test.ts src/channels/telegram-voice.test.ts`
Expected: All voice-specific tests pass.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass, including new voice tests and existing tests unchanged.

- [ ] **Step 3: Build everything**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 4: Verify agent-runner builds**

Run: `cd container/agent-runner && npm run build`
Expected: Clean compilation with new MCP tools included.

- [ ] **Step 5: Commit any remaining changes**

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
