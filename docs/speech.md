# Speech: Local TTS & STT

Two-way audio for uniClaw via Telegram. Both text-to-speech and speech-to-text run entirely on the local Mac — no external APIs, no recurring costs.

## How It Works

### Inbound: Voice Message → Text (STT)

When a user sends a voice message on Telegram:

```
Telegram voice msg (.oga)
  → grammY downloads to /tmp/ via @grammyjs/files plugin
  → ffmpeg converts OGG Opus → 16kHz mono WAV
  → whisper-cli transcribes WAV → text (language auto-detected)
  → text delivered to agent as "[Voice]: {transcribed text}"
  → temp files cleaned up
```

All of this happens on the host in `src/channels/telegram.ts`, before the message reaches the agent container. If transcription fails for any reason, the agent receives `[Voice message (transcription failed)]` instead — it can then ask the user to resend or type.

**Key detail:** The `[Voice]:` prefix tells the agent the message originated from audio, not typed text. This lets the agent respond appropriately (e.g., it knows the user is in a voice-friendly context).

### Outbound: Agent → Voice Message (TTS)

When the agent wants to speak:

```
Agent calls synthesize_speech MCP tool (text + language)
  → HTTP POST to host-side mlx-audio server (port 8771)
  → Voxtral-4B generates WAV audio on Apple Silicon via MLX
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

### Why a host-side HTTP service for TTS?

Voxtral runs via MLX on Apple Silicon — it cannot run inside the Linux container. The container agent needs synchronous request-response to generate audio, but the NanoClaw IPC system is async/polling-based. A local HTTP server on the host solves this:

- `mlx-audio` serves an OpenAI-compatible `/v1/audio/speech` endpoint on `localhost:8771`
- The container reaches it via `host.docker.internal:8771` (Docker's host gateway)
- Same pattern used for LightRAG and other local services

### Why STT runs directly on the host (no HTTP service)?

STT happens in the Telegram message handler before the agent is even invoked. There's no need for the container to access it — whisper-cli runs as a subprocess directly from `telegram.ts`. Memory is reclaimed when transcription completes since it's a child process, not a resident server.

### Why WAV as the intermediate format?

- whisper-cli's default Homebrew build doesn't support OGG input — WAV is the universal format it accepts
- Voxtral outputs WAV natively (24kHz, 16-bit mono PCM)
- Telegram requires OGG Opus for voice bubbles (with waveform display and speed controls)
- So both directions need an ffmpeg conversion step, but WAV is the common intermediate

### Why language maps to voice presets?

Voxtral doesn't have a `language` parameter. Instead, it encodes language in the voice preset name (e.g., `de_male` for German, `it_female` for Italian). The `synthesize_speech` MCP tool accepts a `language` parameter and maps it to the appropriate male voice preset automatically:

| Language | Voice Preset |
|----------|-------------|
| en | casual_male |
| de | de_male |
| it | it_male |
| fr | fr_male |
| es | es_male |
| pt | pt_male |
| nl | nl_male |
| ar | ar_male |
| hi | hi_male |

This mapping lives in `container/agent-runner/src/ipc-mcp-stdio.ts` as `LANGUAGE_VOICE_MAP`.

### Why Whisper large-v3-turbo instead of NB-Whisper?

We initially planned to use NB-Whisper (Norwegian-tuned Whisper) but discovered during testing that:

- NB-Whisper with `-l auto` translates non-Norwegian speech *into Norwegian* instead of transcribing it
- NB-Whisper with `-l no` works for Norwegian but produces artifacts on English ("fox" → "reven")
- Standard Whisper large-v3-turbo with `-l auto` handles both Norwegian and English correctly
- The standard model is also smaller (574MB vs 1GB)

The NB-Whisper model is still downloaded at `~/.cache/whisper/nb-whisper-large-q5_0.bin` and can be swapped back via the `WHISPER_MODEL_PATH` env var if Norwegian dialect handling needs improvement.

## Components

### Host Dependencies

| Component | Install | Path |
|-----------|---------|------|
| whisper-cli | `brew install whisper-cpp` | `/opt/homebrew/bin/whisper-cli` |
| Whisper large-v3-turbo Q5_0 | Downloaded from ggerganov/whisper.cpp | `~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin` |
| mlx-audio | `pip install mlx-audio` (in project .venv) | `.venv/bin/python3 -m mlx_audio.server` |
| Voxtral-4B-TTS (MLX 4-bit) | Auto-downloaded on first TTS request | `~/.cache/huggingface/` (managed by mlx-audio) |
| ffmpeg | `brew install ffmpeg` | `/opt/homebrew/bin/ffmpeg` |
| @grammyjs/files | `npm install @grammyjs/files` | node_modules |

### Configuration

In `src/config.ts`:

| Constant | Default | Env Override |
|----------|---------|-------------|
| `WHISPER_BIN_PATH` | `/opt/homebrew/bin/whisper-cli` | `WHISPER_BIN_PATH` |
| `WHISPER_MODEL_PATH` | `~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin` | `WHISPER_MODEL_PATH` |
| `VOXTRAL_TTS_PORT` | `8771` | `VOXTRAL_TTS_PORT` |

Injected into containers by `src/container-runner.ts`:

| Env Var | Value | Purpose |
|---------|-------|---------|
| `VOXTRAL_TTS_URL` | `http://host.docker.internal:8771` | Container → host TTS service |
| `VOXTRAL_TTS_MODEL` | (optional) | Override the HuggingFace model ID |

### Files

| File | Role |
|------|------|
| `src/channels/telegram.ts` | STT: downloads voice, converts, transcribes, delivers text |
| `src/ipc.ts` | TTS delivery: picks up voice IPC, converts WAV→OGG, sends via channel |
| `src/index.ts` | Wires `sendVoice` into IPC deps |
| `src/types.ts` | Optional `sendVoice` on Channel interface |
| `src/config.ts` | Whisper and Voxtral config constants |
| `src/container-runner.ts` | Injects `VOXTRAL_TTS_URL` and `VOXTRAL_TTS_MODEL` into containers |
| `src/voice-validation.ts` | Shared TTS validation (text length, language enum) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tools: `synthesize_speech` and `send_voice` |
| `services/com.nanoclaw.voxtral-tts.plist` | Launchd template for the TTS service |

## Running the TTS Service

The mlx-audio server must be running for TTS to work. It loads the Voxtral model into memory on first request (~3GB RAM).

```bash
# Start manually
.venv/bin/python3 -m mlx_audio.server --port 8771

# Or via launchd (edit the plist to set your venv path first)
cp services/com.nanoclaw.voxtral-tts.plist ~/Library/LaunchAgents/
# Edit ~/Library/LaunchAgents/com.nanoclaw.voxtral-tts.plist:
#   Replace REPLACE_WITH_VENV_PYTHON with your .venv/bin/python3 path
launchctl load ~/Library/LaunchAgents/com.nanoclaw.voxtral-tts.plist
```

STT requires no running service — whisper-cli is invoked as a subprocess per voice message.

## Resource Usage (M1 16GB)

| Component | RAM | When |
|-----------|-----|------|
| Voxtral TTS (mlx-audio, Q4) | ~3GB | While TTS service is running |
| Whisper STT (whisper-cli) | ~1.5GB | During transcription only (subprocess, freed after) |

STT and TTS don't run in parallel in practice — a user sends a voice message, the agent processes it, then optionally responds with TTS. Peak memory is whichever one is active plus the baseline system usage.

## Error Handling

- **TTS service not running:** MCP tool returns error text; agent responds in text instead
- **TTS first request slow:** Model load takes ~10s; `AbortSignal.timeout(30_000)` gives headroom
- **Text too long (>5000 chars):** Rejected with clear error
- **STT failure (whisper exits non-zero):** Agent receives `[Voice message (transcription failed)]`
- **STT timeout:** 60s limit on whisper subprocess; voice messages are typically short
- **ffmpeg failure:** Logged, operation skipped gracefully
- **Invalid container path in IPC:** Rejected if not under `/workspace/group/` or contains `..`

## Security

- `execFile` (not `exec`) prevents shell injection in subprocess calls
- Container `send_voice` tool restricts file paths to `/workspace/group/audio/` directory
- Host IPC handler validates container paths (prefix check + no `..` traversal)
- Voice IPC uses the same authorization model as text: main group can send anywhere, others only to their own chat

## Limitations

- **Norwegian TTS is not supported.** Voxtral doesn't have Norwegian voice presets. Norwegian voice messages are transcribed correctly (STT works), but the agent can only respond with voice in the languages listed in the voice preset table above.
- **Only Telegram** has voice support. The `sendVoice` method on the Channel interface is optional — other channels silently skip voice delivery.
- **No streaming TTS.** Audio is fully generated before sending. For long texts this means a delay before the voice message arrives.
- **No voice cloning.** Voxtral supports it, but it's not exposed in the MCP tool.

## Future Development

- **Test Voxtral-Mini-4B-Realtime-2602** — the most popular local Voxtral variant (855K downloads vs 3.7K for our current model). Optimized for low-latency streaming. Worth comparing quality and speed.
- **NB-Whisper for Norwegian dialects** — if the standard Whisper model struggles with specific Norwegian dialects, swap back via `WHISPER_MODEL_PATH` env var.
- **Streaming TTS** — mlx-audio supports streaming responses. Could send audio chunks as they're generated for faster perceived response time.
- **Idle timeout for TTS service** — the Voxtral model holds ~3GB RAM while loaded. Could add an idle timeout to unload after periods of inactivity.
- **Female voice option** — currently hardcoded to male presets. Could expose a voice gender preference or let the agent choose.
