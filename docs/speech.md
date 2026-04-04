# Speech: Cloud TTS & STT

Two-way audio for uniClaw via Telegram. Both text-to-speech and speech-to-text use Mistral's cloud APIs — no local models or dependencies.

## How It Works

### Inbound: Voice Message → Text (STT)

When a user sends a voice message on Telegram:

```
Telegram voice msg (.oga)
  → grammY downloads to /tmp/ via @grammyjs/files plugin
  → POST multipart to https://api.mistral.ai/v1/audio/transcriptions
  → Mistral returns transcription text
  → text delivered to agent as "[Voice]: {transcribed text}"
  → temp file cleaned up
```

All of this happens on the host in `src/channels/telegram.ts`, before the message reaches the agent container. If transcription fails for any reason, the agent receives `[Voice message (transcription failed)]` instead.

The `[Voice]:` prefix tells the agent the message originated from audio, not typed text.

### Outbound: Agent → Voice Message (TTS)

When the agent wants to speak:

```
Agent calls synthesize_speech MCP tool (text)
  → HTTPS POST to https://api.mistral.ai/v1/audio/speech
  → Container reads MISTRAL_API_KEY from env and sends Bearer auth
  → Mistral returns WAV audio
  → WAV saved to /workspace/group/audio/
  → Agent calls send_voice MCP tool (file path)
  → IPC JSON written to /workspace/ipc/messages/
  → Host picks up IPC, resolves container path → host path
  → ffmpeg converts WAV → OGG Opus (Telegram requires this for voice bubbles)
  → grammY sends OGG as voice message via Telegram Bot API
  → WAV and OGG cleaned up after upload completes
```

TTS is on-demand only — the agent uses it when asked, not on every response.

## Architecture Decisions

### Why a cloud API for TTS?

Previously, TTS used a local mlx-audio server running Voxtral on Apple Silicon (~3GB RAM, manual startup). Switching to Mistral's cloud API eliminates the operational burden — no resident process, no local model files, no platform dependency.

### Why STT runs on the host (not in container)?

STT happens in the Telegram message handler before the agent is even invoked. The container doesn't need audio access — text arrives as `[Voice]: ...` in the prompt.

### Why WAV as the intermediate format for TTS?

Mistral's TTS API outputs WAV. Telegram requires OGG Opus for voice bubbles (with waveform display and speed controls). So ffmpeg converts WAV→OGG on the host side before sending.

STT does NOT need format conversion — the .oga file from Telegram is sent directly to Mistral's transcription API.

## Configuration

| Variable | Location | Purpose |
|----------|----------|---------|
| `MISTRAL_API_KEY` | `.env` (host) | STT authentication (Telegram channel) and TTS (passed into containers as env var) |

No local binaries, model files, or resident services needed.

## Components

### Host Dependencies

| Component | Install | Purpose |
|-----------|---------|---------|
| ffmpeg | `brew install ffmpeg` | WAV→OGG Opus conversion for TTS delivery |
| @grammyjs/files | npm dependency | Downloading Telegram voice messages |

### Files

| File | Role |
|------|------|
| `src/channels/telegram.ts` | STT: downloads voice, POSTs to Mistral, delivers text |
| `src/ipc.ts` | TTS delivery: picks up voice IPC, converts WAV→OGG, sends via channel |
| `src/index.ts` | Wires `sendVoice` into IPC deps |
| `src/types.ts` | Optional `sendVoice` on Channel interface |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tools: `synthesize_speech` and `send_voice` |

## Error Handling

- **TTS API error:** MCP tool returns error text; agent responds in text instead
- **TTS timeout (60s):** Catches `AbortSignal.timeout` and returns error
- **Text too long (>5000 chars):** Rejected with clear error before API call
- **STT API error:** Agent receives `[Voice message (transcription failed)]`
- **STT timeout (60s):** Same fallback text
- **MISTRAL_API_KEY missing:** STT skipped with warning log; TTS returns explicit error from MCP tool
- **ffmpeg failure (TTS delivery):** Logged, voice message not sent
- **Invalid container path in IPC:** Rejected if not under `/workspace/group/` or contains `..`

## Cost

| Service | Rate | Typical Usage |
|---------|------|--------------|
| TTS (Voxtral) | $0.016/1k chars | ~$0.01 per voice response |
| STT (Voxtral Transcribe) | $0.003/min | ~$0.001 per voice message |

## Limitations

- **Only Telegram** has voice support. The `sendVoice` method on the Channel interface is optional — other channels silently skip voice delivery.
- **No streaming TTS.** Audio is fully generated before sending.
- **No voice cloning (yet).** Using default Mistral voice. Can add a `voice_id` parameter later by cloning from a reference audio sample.
- **No Norwegian TTS.** Mistral supports 9 languages (en, fr, de, es, nl, pt, it, hi, ar) but not Norwegian. Norwegian voice messages are transcribed correctly (STT works for 13 languages including Norwegian-adjacent detection).

## Security

- Container `send_voice` tool restricts file paths to `/workspace/group/audio/` directory
- Host IPC handler validates container paths (prefix check + no `..` traversal)
- Voice IPC uses the same authorization model as text: main group can send anywhere, others only to their own chat
- MISTRAL_API_KEY is passed into containers as an env var by the host (read from `process.env` or `.env`). The container sends it directly in the Authorization header to the Mistral API
