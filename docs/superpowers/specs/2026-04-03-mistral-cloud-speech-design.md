# Migrate Speech to Mistral Cloud APIs

**Date:** 2026-04-03
**Status:** Approved
**Supersedes:** `2026-03-30-voxtral-tts-design.md`, `plans/2026-03-31-voxtral-tts-whisper-stt.md`

## Summary

Replace local model infrastructure (mlx-audio Voxtral TTS server, whisper-cli STT subprocess) with Mistral's cloud APIs for both text-to-speech and speech-to-text. Removes all local model dependencies and Ollama remnants from the codebase.

## Motivation

- Local mlx-audio TTS server is unreliable (must be manually started, holds ~3GB RAM)
- Local whisper-cli requires Homebrew binary + 574MB model file on disk
- User has decided against running models locally — external APIs preferred
- Mistral API key already configured in OneCLI

## TTS: `synthesize_speech` MCP Tool

### Current Flow
```
Agent calls synthesize_speech
  → HTTP POST to host-side mlx-audio (localhost:8771)
  → Voxtral-4B generates WAV via MLX on Apple Silicon
  → WAV saved to /workspace/group/audio/
  → Agent calls send_voice → IPC → host converts WAV→OGG → Telegram
```

### New Flow
```
Agent calls synthesize_speech
  → HTTPS POST to https://api.mistral.ai/v1/audio/speech
  → OneCLI intercepts and injects MISTRAL_API_KEY (container-side)
  → Mistral returns WAV audio
  → WAV saved to /workspace/group/audio/
  → Agent calls send_voice → IPC → host converts WAV→OGG → Telegram (unchanged)
```

### API Request
```json
{
  "model": "voxtral-mini-tts-2603",
  "input": "<text>",
  "response_format": "wav"
}
```

### Tool Interface Changes
- Remove `language` parameter (Mistral auto-detects from text)
- Remove `VOXTRAL_TTS_URL` env var dependency — hardcode API URL
- Keep text length validation (5000 chars) inline
- Update tool description to say "Mistral" not "local Voxtral"
- Increase timeout from 30s to 60s for cloud API latency

### Authentication (Container → Mistral API)
OneCLI's HTTPS-intercepting proxy injects the `MISTRAL_API_KEY` for container requests to `https://api.mistral.ai`. If the Mistral domain is not yet registered in OneCLI, that's a one-time config fix outside this spec's scope.

### Voice Selection
Default voice initially (no `voice_id` parameter). Can add voice cloning later by uploading a reference audio sample and storing the returned `voice_id` in `.env`.

## STT: Telegram Voice Handler

### Current Flow
```
Telegram voice .oga
  → grammY downloads to /tmp/
  → ffmpeg converts OGG→WAV (whisper-cli needs WAV)
  → whisper-cli subprocess transcribes WAV→text
  → text delivered to agent as "[Voice]: {text}"
  → temp files cleaned up
```

### New Flow
```
Telegram voice .oga
  → grammY downloads to /tmp/
  → HTTP POST multipart to https://api.mistral.ai/v1/audio/transcriptions
  → Mistral returns transcription text
  → text delivered to agent as "[Voice]: {text}"
  → temp file cleaned up
```

### API Request
Multipart form data:
- `model`: `voxtral-mini-latest`
- `file`: the .oga file (try directly first; fall back to ffmpeg WAV conversion if Mistral rejects the format)

### Authentication (Host-Side)
STT runs on the host in `telegram.ts`, outside OneCLI's container proxy. Read `MISTRAL_API_KEY` via `readEnvFile()` in the Telegram channel module (same pattern as `TELEGRAM_BOT_TOKEN`). Pass as `Authorization: Bearer ${key}` header on the fetch call.

### Changes
- Remove `WHISPER_BIN_PATH` and `WHISPER_MODEL_PATH` imports
- Replace `execFileAsync(WHISPER_BIN_PATH, ...)` with `fetch()` to Mistral API
- Remove ffmpeg OGG→WAV conversion step for STT (keep as fallback if .oga is rejected)
- Add `MISTRAL_API_KEY` to the channel's `readEnvFile()` call
- Keep the same error handling pattern (fallback to `[Voice message (transcription failed)]`)

## Dead Code Removal

### Files to Delete
| File | Reason |
|------|--------|
| `src/voice-validation.ts` | Language enum no longer needed; text length check stays inline in MCP tool |
| `src/voice-validation.test.ts` | Tests for deleted module |
| `services/com.nanoclaw.voxtral-tts.plist` | Local mlx-audio launchd service template |

### Skills to Delete or Archive
| Skill | Reason |
|-------|--------|
| `.claude/skills/use-local-whisper/SKILL.md` | Documents local whisper-cli workflow; no longer applicable |

### Config Removals (`src/config.ts`)
| Constant | Reason |
|----------|--------|
| `VOXTRAL_TTS_PORT` | No local TTS server |
| `WHISPER_BIN_PATH` | No local whisper binary |
| `WHISPER_MODEL_PATH` | No local whisper model |

### Container Runner (`src/container-runner.ts`)
- Remove Voxtral TTS URL injection (lines 251-259): `VOXTRAL_TTS_URL`, `VOXTRAL_TTS_MODEL` env vars
- OneCLI handles Mistral API auth transparently

### MCP Tool (`container/agent-runner/src/ipc-mcp-stdio.ts`)
- Remove `LANGUAGE_VOICE_MAP` constant
- Remove `language` parameter from `synthesize_speech` tool
- Change HTTP target from `VOXTRAL_TTS_URL` env var to `https://api.mistral.ai/v1/audio/speech`
- Update request body format for Mistral API

### Telegram Channel (`src/channels/telegram.ts`)
- Remove `WHISPER_BIN_PATH`, `WHISPER_MODEL_PATH` imports
- Remove ffmpeg OGG→WAV conversion in voice handler
- Replace whisper-cli subprocess with Mistral API fetch call
- Add `MISTRAL_API_KEY` to `readEnvFile()` call

### Environment (`.env.example`)
- Remove `LIGHTRAG_OLLAMA_HOST` and Ollama comments
- Remove Ollama tuning comments from parallelism section
- Add `MISTRAL_API_KEY=`

### LightRAG Script (`scripts/lightrag-server.sh`)
- Remove Ollama conditional blocks (lines 62-67)
- Remove "reduce for Ollama" comments
- Remove `LIGHTRAG_OLLAMA_HOST` reference

### Tests
- Update `src/channels/telegram.test.ts` — remove `WHISPER_BIN_PATH`/`WHISPER_MODEL_PATH` mocks, add `fetch()` mocks for STT
- Remove or update `src/channels/telegram-voice.test.ts` — whisper config tests no longer relevant
- Update `src/container-runner.test.ts` — remove `VOXTRAL_TTS_PORT` mock and Voxtral URL injection assertions

### Documentation
- Update `docs/speech.md` to reflect cloud API architecture
- CLAUDE.md: remove Voxtral TTS from service stack table, add `MISTRAL_API_KEY` to env vars table
- Mark `2026-03-30-voxtral-tts-design.md` and `plans/2026-03-31-voxtral-tts-whisper-stt.md` as superseded

## What Stays Unchanged

- `send_voice` MCP tool — sends audio file path via IPC (no changes)
- IPC voice handling in `src/ipc.ts` — WAV→OGG Opus conversion for Telegram delivery
- ffmpeg dependency for TTS delivery (WAV→OGG conversion on host side)
- `@grammyjs/files` for downloading voice messages

## Cost Estimate

| Service | Rate | Typical Usage |
|---------|------|--------------|
| TTS | $0.016/1k chars | ~$0.01 per voice response |
| STT | $0.003/min | ~$0.001 per voice message |

Net savings: ~3GB RAM freed (no resident mlx-audio server), no local model files needed.
