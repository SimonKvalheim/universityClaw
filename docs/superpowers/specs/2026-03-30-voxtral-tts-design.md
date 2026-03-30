# Voxtral TTS & Whisper STT Integration

## Overview

Add two-way audio capabilities to uniClaw (Mr. Rogers):

- **Outbound TTS**: An MCP tool (`synthesize_speech`) that converts text to speech using Voxtral (EN/DE/IT) or OpenAI TTS (NO), returning an audio file the agent can send as a Telegram voice message.
- **Inbound STT**: Custom Telegram voice transcription using `@grammyjs/files` + OpenAI Whisper API.

TTS is on-demand only — the agent uses it when prompted, not automatically.

## Use Cases

- Read notes or summaries aloud on request
- Study tool: audio flashcards, pronunciation, lecture recaps
- Voice messages from the user transcribed so the agent can read them

(Periodic scheduled audio summaries are an emergent capability via the existing task scheduler — not explicitly tested or documented.)

## Architecture

```
Inbound (STT):
  User voice msg → Telegram → grammY downloads OGG Opus
    → OpenAI Whisper API → transcribed text → agent receives as "[Voice]: {text}"

Outbound (TTS):
  Agent calls synthesize_speech → Voxtral/OpenAI API → OGG Opus file
    → Agent calls send_voice → IPC → host → Telegram sendVoice → User
```

The TTS tool and voice delivery are separate MCP tools. The agent calls `synthesize_speech` to generate audio, then `send_voice` to deliver it. This keeps concerns separated and gives the agent full control over when to send audio.

## MCP Tool: `synthesize_speech`

**Location:** `container/agent-runner/src/ipc-mcp-stdio.ts`

### Parameters

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | yes | — | Text to synthesize (max 5000 chars) |
| `language` | enum | no | `en` | `en`, `de`, `it`, `no` |
| `voice` | string | no | per-provider default | Voxtral preset name or OpenAI voice name |

### Provider Routing

| Language | Provider | Fallback |
|----------|----------|----------|
| `en` | Voxtral | OpenAI TTS |
| `de` | Voxtral | OpenAI TTS |
| `it` | Voxtral | OpenAI TTS |
| `no` | OpenAI TTS | error |

If Voxtral API fails (timeout, error), automatically falls back to OpenAI TTS for that request. If the final provider (OpenAI) also fails, the tool returns an error to the agent, who should respond in text instead.

### API Contracts

**Voxtral (Mistral TTS API):**
- Endpoint: `https://api.mistral.ai/v1/audio/speech`
- Auth: `Authorization: Bearer {MISTRAL_API_KEY}`
- Body: `{ model: "mistral-tts-latest", input: text, voice: voiceName, response_format: "wav" }`
- Response: raw audio bytes
- Note: Voxtral may not support Opus output natively. If only WAV/PCM is available, transcode to OGG Opus via ffmpeg (`ffmpeg -i input.wav -c:a libopus output.ogg`).

**OpenAI TTS:**
- Endpoint: `https://api.openai.com/v1/audio/speech`
- Auth: `Authorization: Bearer {OPENAI_API_KEY}`
- Body: `{ model: "tts-1", input: text, voice: voiceName, response_format: "opus" }`
- Response: raw audio bytes (Opus natively supported)

### Output

- Format: OGG Opus (Telegram-native for voice messages)
- Sample rate: 24kHz
- Directory: `/workspace/group/audio/` (created on first use via `mkdir -p`)
- Filename: `tts-{timestamp}-{random4}.opus` (random suffix prevents collision)
- Returns: JSON `{ path, duration_seconds, provider, language }`

### Voice Selection

- Voxtral: one preset voice chosen during implementation (natural, tutor-appropriate) from 20 available
- OpenAI: one preset voice (from alloy, echo, fable, nova, onyx, shimmer)
- Overridable via the `voice` parameter

## MCP Tool: `send_voice`

**Location:** `container/agent-runner/src/ipc-mcp-stdio.ts`

A new MCP tool for sending audio files as Telegram voice messages.

### Parameters

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `file_path` | string | yes | — | Absolute path to the audio file |
| `caption` | string | no | — | Optional caption text |

### IPC Flow

1. Agent calls `send_voice` MCP tool with file path
2. Tool writes IPC JSON to `/workspace/ipc/messages/{timestamp}.json` with `{ type: "voice", file: "/workspace/group/audio/tts-xxx.opus", chatJid, caption?, sender }`
3. Host `ipc.ts` picks up the file, checks `type` field
4. For `type: "voice"`, host resolves container path to host path, then calls `sendVoice()` on the channel

**`chatJid`** is sourced from the `NANOCLAW_CHAT_JID` env var (same as `send_message`), so the agent can only send voice to its own chat.

**Path resolution:** The container writes audio to `/workspace/group/audio/...`, which maps to a host-side group folder path. The IPC handler in `ipc.ts` must resolve this using the same group folder mapping used for other container mounts (the `groupFolder` is already known to the IPC handler from the namespace).

### Changes Required

**`src/ipc.ts`** — Add an `else if (data.type === 'voice')` dispatch branch in the message handler. Currently only `type: "message"` is handled; without this branch, voice IPC files will be silently consumed and unlinked. The new branch must:
- Apply the same authorization check (`isMain || folder === sourceGroup`)
- Resolve the container file path to the host-absolute path
- Call `sendVoice()` on the target channel
- Handle missing file gracefully (log error, skip)

**`src/types.ts`** — Add optional `sendVoice` to the Channel interface:
```typescript
sendVoice?(jid: string, filePath: string, caption?: string): Promise<void>;
```

Optional so non-Telegram channels don't break.

**`src/channels/telegram.ts`** — Implement `sendVoice` (requires adding `InputFile` to the existing grammy import):
```typescript
async sendVoice(jid: string, filePath: string, caption?: string) {
  await this.bot.api.sendVoice(jid, new InputFile(filePath), { caption });
}
```

## STT: Whisper Integration (Custom for Telegram)

The existing `/add-voice-transcription` skill targets WhatsApp only. We need custom Telegram voice transcription.

### Dependencies

- `@grammyjs/files` — adds `.download()` method to grammY file objects. Must be registered on the bot instance: `bot.api.config.use(hydrateFiles(bot.token))`

### Implementation

In `src/channels/telegram.ts`, replace the `[Voice message]` placeholder handler:

1. **Setup**: Register `@grammyjs/files` plugin on the bot instance during channel initialization
2. **Download**: Use `file.download(path.join(os.tmpdir(), \`voice-${Date.now()}.oga\`))` to download the OGG Opus file to a temp path
3. **Transcribe**: Send the file directly to OpenAI Whisper API (Whisper accepts OGG/OGA natively — no ffmpeg conversion needed)
4. **Deliver**: Pass transcribed text to the agent as `[Voice]: {transcribed text}` so the agent knows the message originated from audio
5. **Cleanup**: Delete the temp file in a `finally` block

```typescript
import { hydrateFiles } from "@grammyjs/files";

// During bot setup:
bot.api.config.use(hydrateFiles(bot.token));

bot.on("message:voice", async (ctx) => {
  const file = await ctx.getFile();
  const localPath = await file.download(
    path.join(os.tmpdir(), `voice-${Date.now()}.oga`)
  );
  try {
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(localPath),
    });
    // Route transcription.text as a normal inbound message
    // prefixed with [Voice]: so the agent knows it was audio
  } finally {
    fs.unlink(localPath, () => {});
  }
});
```

### Format Notes

- Telegram voice messages are always OGG Opus (`.oga`)
- Whisper API accepts OGG/OGA natively — no transcoding step needed
- Telegram file download limit: 20MB; Whisper limit: 25MB — always within bounds

## Container Dependencies

**ffmpeg** may be needed if Voxtral doesn't support Opus output natively. Check during implementation:
- If Voxtral returns WAV/PCM only → add ffmpeg to the container Dockerfile
- If Voxtral supports Opus → no additional dependency

OpenAI TTS supports Opus natively, so ffmpeg is only needed for the Voxtral path.

## Credentials

| Key | Provider | Purpose |
|-----|----------|---------|
| `MISTRAL_API_KEY` | Mistral AI | Voxtral TTS API |
| `OPENAI_API_KEY` | OpenAI | TTS fallback + Whisper STT |

Both managed via OneCLI, injected into containers at runtime. The OpenAI key may already exist if other OpenAI features are configured.

## Error Handling

- **API timeout/failure**: Return error text to agent; agent responds in text instead
- **Text too long (>5000 chars)**: Reject with clear error message
- **Empty text**: Reject with error
- **Invalid language**: Fall back to English with a note
- **Voxtral failure**: Automatic fallback to OpenAI TTS
- **OpenAI failure (final provider)**: Return error to agent with details
- **STT failure**: Log error, deliver original `[Voice message (transcription failed)]` placeholder so the agent can ask the user to resend or type

## Testing

- Unit tests for provider routing logic (language → provider selection)
- Unit tests for parameter validation (text length, language enum, voice)
- Unit tests for IPC voice message type handling
- Integration tests with mocked API responses for both Voxtral and OpenAI TTS
- Integration tests for the `send_voice` IPC flow
- Manual E2E: prompt Mr. Rogers for a voice summary, verify audio arrives on Telegram
- Manual E2E: send a voice message to Mr. Rogers, verify transcription appears

## Scope Boundaries

- No automatic TTS on every response — agent uses it only when prompted
- No new database tables or config files
- Voice cloning is out of scope for now (but Voxtral supports it for future use)
- Only Telegram channel gets voice support; other channels unaffected (Channel interface change is optional/additive)

## Cost Estimate

Both TTS APIs are ~$0.015-0.016 per 1000 characters. A typical note summary (~500 chars) costs less than $0.01. Whisper STT is $0.006/minute. Negligible for personal use.
