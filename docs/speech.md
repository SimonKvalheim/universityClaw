# Speech: Cloud TTS & STT

Two-way audio for uniClaw via Telegram. Inbound voice notes (STT) and outbound voice replies (TTS) both use Google Gemini cloud APIs.

## How It Works

### Inbound: Voice Message → Text (STT)

Voice transcription happens on the host, inside the Telegram message handler in `src/channels/telegram.ts`, before the agent container is invoked.

```
Telegram voice note (.oga)
  → grammY downloads to /tmp/ via @grammyjs/files
  → base64-encode file bytes
  → POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent
     headers: x-goog-api-key: $GEMINI_API_KEY
     body: { contents: [{ parts: [
              { inlineData: { mimeType: "audio/ogg", data: <base64> } },
              { text: "Generate a transcript of this speech." }
           ] }] }
  → response.candidates[0].content.parts[0].text (trimmed)
  → delivered to agent as "[Voice]: {text}"
  → temp file unlinked
```

No language hint is sent — Gemini auto-detects Norwegian, English, and others from the audio itself. The `[Voice]:` prefix signals to the agent that the message originated from audio rather than typed text. If any step fails, the agent receives the literal placeholder `[Voice message (transcription failed)]` instead.

The STT model is exposed as a single constant (`GEMINI_STT_MODEL`) at the top of `src/channels/telegram.ts`. If `gemini-2.5-flash-lite` ever returns 400 on audio input, swap it to `gemini-2.5-flash` (documented multimodal, ~3-5x the cost).

### Outbound: Agent → Voice Message (TTS)

TTS happens inside the agent container. The agent calls an MCP tool; the container produces a WAV file; the host converts it to OGG Opus and sends it as a Telegram voice bubble.

```
Agent calls synthesize_speech({ text, style_prompt? })
  → container composes prompt: `${style_prompt.trim()}: ${text}` when
    style_prompt is a non-empty, non-whitespace string; otherwise just text
  → POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent
     headers: x-goog-api-key: $GEMINI_API_KEY
     body: { contents: [{ parts: [{ text: prompt }] }],
             generationConfig: {
               responseModalities: ["AUDIO"],
               speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } }
             } }
  → response.candidates[0].content.parts[0].inlineData.data
     (base64 raw PCM: 24 kHz mono 16-bit little-endian — NOT a WAV)
  → pcmToWav() prepends a 44-byte RIFF/WAVE header
  → write to /workspace/group/audio/tts-{timestamp}-{rand}.wav
  → return { path, duration_seconds }
Agent then calls send_voice({ file_path })
  → IPC JSON queued at /workspace/ipc/messages/
  → host picks up IPC, resolves container path → host path
  → host ffmpeg converts WAV → OGG Opus
  → grammY sends OGG as Telegram voice bubble
  → intermediate files cleaned up
```

TTS is on-demand: the agent invokes it when asked, not on every response.

## Architecture Decisions

### Why STT runs on the host (not in container)

STT happens in the Telegram message handler before the agent is even invoked. The container never needs audio access — text arrives as `[Voice]: ...` in the prompt, so the agent treats voice and text uniformly.

### Why wrap PCM as WAV in the container

Gemini's TTS response is raw 24 kHz s16le mono PCM, not a container format. The container prepends a 44-byte RIFF/WAVE header (via the pure helper `pcmToWav`) so the existing host IPC contract and ffmpeg invocation do not change — they still receive a `.wav` file path and convert it to OGG Opus exactly as before. The intermediate `.wav` files also remain playable in isolation, which helps debugging.

## Configuration

| Variable         | Location      | Purpose                                                                       |
| ---------------- | ------------- | ----------------------------------------------------------------------------- |
| `GEMINI_API_KEY` | `.env` (host) | STT authentication (Telegram channel) and TTS (passed into containers as env var) |

No local binaries, model files, or resident services are needed.

## Components

### Host Dependencies

| Component        | Install              | Purpose                                       |
| ---------------- | -------------------- | --------------------------------------------- |
| `ffmpeg`         | `brew install ffmpeg`| WAV → OGG Opus conversion for TTS delivery    |
| `@grammyjs/files`| npm dependency       | Downloading Telegram voice messages           |

### Files

| File                                              | Role                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/channels/telegram.ts`                        | STT: downloads voice, POSTs to Gemini, delivers text                                            |
| `src/ipc.ts`                                      | TTS delivery: picks up voice IPC, converts WAV→OGG, sends via channel                           |
| `src/index.ts`                                    | Wires `sendVoice` into IPC deps                                                                 |
| `src/types.ts`                                    | Optional `sendVoice` on Channel interface                                                       |
| `container/agent-runner/src/ipc-mcp-stdio.ts`     | MCP tools: `synthesize_speech` and `send_voice`                                                 |
| `container/agent-runner/src/pcm-to-wav.ts`        | Pure helper: prepends 44-byte RIFF/WAVE header to Gemini's raw PCM                              |
| `container/agent-runner/src/gemini-tts-request.ts`| Pure helper: builds the Gemini `generateContent` request body, handles `style_prompt` empty/whitespace semantics |

## Error Handling

| Condition                                                                   | Behavior                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GEMINI_API_KEY` missing (STT)                                              | Log warning, skip transcription, agent receives `[Voice message (transcription failed)]`                                 |
| `GEMINI_API_KEY` missing (TTS)                                              | MCP tool returns error with `isError: true`; agent falls back to text                                                    |
| Gemini STT non-2xx / timeout (60s)                                          | Log error with status + body; agent receives `[Voice message (transcription failed)]`                                    |
| Gemini TTS non-2xx / timeout (300s)                                         | MCP tool returns error with body; agent falls back to text                                                               |
| TTS response missing `inlineData.data`                                      | MCP tool returns error including `finishReason` and `promptFeedback.blockReason` so safety blocks and modality failures are diagnosable |
| TTS response returns `text` instead of audio (modality negotiation failure) | MCP tool returns a distinct error including the returned text, logged for debugging                                      |
| Empty / oversized text (>50000 chars)                                       | Rejected in-tool before API call                                                                                         |
| ffmpeg / IPC path validation                                                | Unchanged — WAV output preserves the invariant                                                                           |

## Cost

- TTS (`gemini-3.1-flash-tts-preview`): $1 / M text-input tokens, $20 / M audio-output tokens. Batch mode is half price.
- STT (`gemini-2.5-flash-lite`): priced at the lite model's audio-input rates.

_Prices per https://ai.google.dev/pricing as of 2026-04-19 — check the live page for current rates._

## Limitations

- **Only Telegram** has voice support. `sendVoice` is optional on the Channel interface; other channels silently skip voice delivery.
- **No streaming TTS.** Audio is fully generated before sending.
- **No mid-conversation voice swap.** The voice is compile-time hardcoded (`Kore`) via `GEMINI_TTS_VOICE` in `container/agent-runner/src/ipc-mcp-stdio.ts`. Changing it requires editing the constant and rebuilding the container.
- **No voice cloning.** Only Gemini's prebuilt voices are supported.

## Security

- The container's `send_voice` tool restricts file paths to `/workspace/group/audio/`.
- The host IPC handler validates container paths (prefix check + no `..` traversal).
- Voice IPC uses the same authorization model as text: the main group can send anywhere; other groups only to their own chat.
- `GEMINI_API_KEY` is passed into containers as an env var by the host (read from `process.env` or `.env`). The container sends it directly in the `x-goog-api-key` header to the Gemini API.
- Key injection bypasses the OneCLI gateway intentionally — this matches the direct env-injection pattern used for provider keys that are not routed through the proxy.
