# Local TTS & STT Integration (Voxtral + NB-Whisper)

## Overview

Add two-way audio capabilities to uniClaw (Mr. Rogers), fully local — no external APIs:

- **Outbound TTS**: Voxtral-4B running locally via MLX on Apple Silicon. The container agent requests speech synthesis from a host-side HTTP service, then sends the audio as a Telegram voice message.
- **Inbound STT**: NB-Whisper Large running locally via whisper.cpp. The host-side Telegram handler transcribes incoming voice messages before passing them to the agent.

Both models share the M1's unified memory (~4.5GB combined) but never run in parallel.

TTS is on-demand only — the agent uses it when prompted, not automatically.

## Use Cases

- Read notes or summaries aloud on request
- Study tool: audio flashcards, pronunciation guides, lecture recaps
- Voice messages from the user transcribed so the agent can read them

(Periodic scheduled audio summaries are an emergent capability via the existing task scheduler — not explicitly tested or documented.)

## Architecture

```
Inbound (STT) — runs entirely on host:
  User voice msg → Telegram → grammY downloads OGG Opus
    → whisper.cpp (NB-Whisper Large) → transcribed text
    → agent receives as "[Voice]: {text}"

Outbound (TTS) — host service, container client:
  Agent calls synthesize_speech MCP tool
    → HTTP POST to host TTS service (host.docker.internal:8771)
    → Voxtral-4B (MLX) generates audio → OGG Opus returned
    → saved to /workspace/group/audio/
    → Agent calls send_voice → IPC → host → Telegram sendVoice → User
```

### Why a Host-Side HTTP Service for TTS?

Voxtral-4B runs via MLX on Apple Silicon — it cannot run inside the Linux container. The container agent needs synchronous request-response to generate audio (IPC is async/polling-based, not suitable). A local HTTP server on the host solves this cleanly:

- `mlx-audio` or `mlx-voxtral` serves an OpenAI-compatible `/v1/audio/speech` endpoint on `localhost:8771`
- The container MCP tool reaches it via `host.docker.internal:8771` (Docker's host gateway)
- Request-response: audio bytes come back synchronously
- Same pattern used by other local model servers (Ollama, llama.cpp, etc.)

STT does not need this pattern — it runs entirely on the host in `telegram.ts`, so whisper.cpp is called directly as a CLI subprocess.

## Host Services

### Voxtral TTS Service

A local HTTP server running Voxtral-4B via MLX on Apple Silicon.

**Setup options (choose during implementation):**
- `mlx-audio` — Python package with built-in server mode and Voxtral support
- `mlx-voxtral` — Dedicated Voxtral MLX wrapper on PyPI
- Custom FastAPI wrapper around MLX inference (if neither package provides a stable server)

**Endpoint:** `http://localhost:8771/v1/audio/speech` (OpenAI-compatible)

**Request:**
```json
{
  "model": "voxtral-4b",
  "input": "Text to synthesize",
  "voice": "jessica",
  "response_format": "opus"
}
```

**Response:** Raw audio bytes (OGG Opus if supported, WAV otherwise — see transcoding note below).

**Resource usage:** ~3GB RAM (Q4 quantized). Model loads on first request, stays resident. Since STT and TTS never run in parallel, peak memory is ~3GB (not additive).

**Process management:** Managed via launchd (macOS) alongside the main NanoClaw service. Separate plist: `com.nanoclaw.voxtral-tts.plist`.

### NB-Whisper STT

Runs as a CLI tool via whisper.cpp, invoked from the host-side Telegram handler.

**Binary:** `whisper.cpp` compiled for Apple Silicon, using the `ggml-model-q5_0.bin` quantized model.

**Invocation:** Called as a subprocess from `telegram.ts` when a voice message arrives:
```
whisper-cpp -m /path/to/nb-whisper-large-q5_0.bin -l no -f /tmp/voice.oga --output-txt
```

**Resource usage:** ~1.5GB RAM during inference, unloaded after. Since it's a subprocess, memory is reclaimed when transcription completes.

**Language detection:** NB-Whisper handles Norwegian and English natively. For voice messages in other languages, it will still produce a reasonable transcription (Whisper-based architecture is multilingual). The `-l no` flag can be omitted to enable auto-detection if needed.

## MCP Tool: `synthesize_speech`

**Location:** `container/agent-runner/src/ipc-mcp-stdio.ts`

### Parameters

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | yes | — | Text to synthesize (max 5000 chars) |
| `language` | enum | no | `en` | `en`, `de`, `it` |
| `voice` | string | no | `jessica` | Voxtral preset voice name |

### Implementation

The MCP tool makes an HTTP POST to the host TTS service:

```typescript
const response = await fetch('http://host.docker.internal:8771/v1/audio/speech', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'voxtral-4b',
    input: args.text,
    voice: args.voice ?? 'jessica',
    response_format: 'opus',
  }),
});
const audioBuffer = Buffer.from(await response.arrayBuffer());
```

No API keys needed — the service runs on localhost with no authentication.

### Output

- Format: OGG Opus (Telegram-native for voice messages)
- Sample rate: 24kHz
- Directory: `/workspace/group/audio/` (created on first use via `mkdir -p`)
- Filename: `tts-{timestamp}-{random4}.opus` (random suffix prevents collision)
- Returns: JSON `{ path, duration_seconds, language }`

### Transcoding

If the Voxtral MLX server only outputs WAV/PCM (not Opus), the MCP tool must transcode before saving. This requires ffmpeg in the container:
```
ffmpeg -i input.wav -c:a libopus -b:a 64k output.opus
```
Check during implementation whether `mlx-audio`/`mlx-voxtral` supports Opus output natively. If not, add ffmpeg to the container Dockerfile.

### Voice Selection

One preset voice (e.g. `jessica`) chosen during implementation from Voxtral's 20 available presets — natural and tutor-appropriate. Overridable via the `voice` parameter.

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

## STT: NB-Whisper Integration (Custom for Telegram)

The existing `/add-voice-transcription` skill targets WhatsApp only. We need custom Telegram voice transcription using NB-Whisper locally.

### Dependencies

- `@grammyjs/files` — adds `.download()` method to grammY file objects. Must be registered on the bot instance: `bot.api.config.use(hydrateFiles(bot.token))`
- `whisper.cpp` — compiled binary for Apple Silicon, with NB-Whisper Large Q5_0 model

### Implementation

In `src/channels/telegram.ts`, replace the `[Voice message]` placeholder handler:

1. **Setup**: Register `@grammyjs/files` plugin on the bot instance during channel initialization
2. **Download**: Use `file.download(path.join(os.tmpdir(), \`voice-${Date.now()}.oga\`))` to download the OGG Opus file to a temp path
3. **Transcribe**: Run whisper.cpp as a subprocess on the downloaded file
4. **Deliver**: Pass transcribed text to the agent as `[Voice]: {transcribed text}` so the agent knows the message originated from audio
5. **Cleanup**: Delete temp files in a `finally` block

```typescript
import { hydrateFiles } from "@grammyjs/files";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// During bot setup:
bot.api.config.use(hydrateFiles(bot.token));

bot.on("message:voice", async (ctx) => {
  const file = await ctx.getFile();
  const localPath = await file.download(
    path.join(os.tmpdir(), `voice-${Date.now()}.oga`)
  );
  try {
    const { stdout } = await execFileAsync('whisper-cpp', [
      '-m', WHISPER_MODEL_PATH,
      '-f', localPath,
      '--output-txt', '--no-timestamps',
    ]);
    const text = stdout.trim();
    // Route text as a normal inbound message
    // prefixed with [Voice]: so the agent knows it was audio
  } finally {
    fs.unlink(localPath, () => {});
  }
});
```

### Format Notes

- Telegram voice messages are always OGG Opus (`.oga`)
- whisper.cpp accepts OGG/OGA natively when compiled with ffmpeg support, otherwise convert to WAV first
- Telegram file download limit: 20MB — more than enough for voice messages

## Host Dependencies

| Dependency | Purpose | Install |
|------------|---------|---------|
| `whisper.cpp` | STT inference | `brew install whisper-cpp` or compile from source |
| NB-Whisper Large Q5_0 | STT model | Download from HuggingFace (`NbAiLab/nb-whisper-large`) |
| `mlx-audio` or `mlx-voxtral` | TTS inference + HTTP server | `pip install mlx-audio` or `pip install mlx-voxtral` |
| Voxtral-4B Q4 | TTS model | Auto-downloaded on first run by MLX |
| `ffmpeg` | Audio transcoding (if needed) | `brew install ffmpeg` |

### Resource Budget (MacBook Pro M1 16GB)

| Component | RAM | When |
|-----------|-----|------|
| NanoClaw host process | ~200MB | Always |
| Voxtral TTS (MLX, Q4) | ~3GB | Resident while TTS service runs |
| NB-Whisper (whisper.cpp) | ~1.5GB | During transcription only (subprocess) |
| **Peak (TTS idle + STT active)** | **~4.7GB** | |
| **Peak (TTS active + STT idle)** | **~3.2GB** | |

Since TTS and STT never run simultaneously, peak usage is ~4.7GB (worst case: STT running while TTS model is resident but idle). Leaves ~11GB for macOS and other processes.

## Credentials

None required. Both models run locally with no API keys or authentication.

## Error Handling

- **TTS service unreachable**: Return error text to agent ("TTS service is not running"); agent responds in text instead
- **TTS model not loaded**: First request may be slow (~10s model load); subsequent requests ~70ms. MCP tool should have a generous timeout (30s) for the first call
- **Text too long (>5000 chars)**: Reject with clear error message
- **Empty text**: Reject with error
- **Invalid language**: Fall back to English with a note
- **STT failure** (whisper.cpp exits non-zero): Log error, deliver `[Voice message (transcription failed)]` placeholder so the agent can ask the user to resend or type
- **STT timeout**: Set a 60s timeout on the whisper.cpp subprocess; voice messages are typically short

## Testing

- Unit tests for `synthesize_speech` parameter validation (text length, language enum, voice)
- Unit tests for IPC voice message type handling and path resolution
- Integration tests with a mock HTTP server standing in for the TTS service
- Integration tests for the `send_voice` IPC flow
- Manual E2E: prompt Mr. Rogers for a voice summary, verify audio arrives on Telegram
- Manual E2E: send a voice message to Mr. Rogers, verify transcription appears
- Manual: verify whisper.cpp transcription of Norwegian and English voice messages

## Scope Boundaries

- No automatic TTS on every response — agent uses it only when prompted
- No new database tables or config files
- No external API keys or recurring costs
- Voice cloning is out of scope for now (but Voxtral supports it for future use)
- Only Telegram channel gets voice support; other channels unaffected (Channel interface change is optional/additive)
- Norwegian TTS is out of scope (Voxtral doesn't support it); Norwegian STT is fully supported via NB-Whisper

## Cost

Zero recurring cost. All inference runs locally. One-time setup: download ~2GB of model weights (NB-Whisper Q5_0 + Voxtral Q4).
