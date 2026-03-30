# Voxtral TTS & Whisper STT Integration

## Overview

Add two-way audio capabilities to uniClaw (Mr. Rogers):

- **Outbound TTS**: An MCP tool (`synthesize_speech`) that converts text to speech using Voxtral (EN/DE/IT) or OpenAI TTS (NO), returning an audio file the agent can send via Telegram.
- **Inbound STT**: Apply the existing `/add-voice-transcription` skill to transcribe incoming Telegram voice messages via OpenAI Whisper.

TTS is on-demand only — the agent uses it when prompted, not automatically.

## Use Cases

- Read notes or summaries aloud on request
- Study tool: audio flashcards, pronunciation, lecture recaps
- Periodic scheduled audio summaries (via existing task scheduler)
- Voice messages from the user transcribed so the agent can read them

## Architecture

```
User (voice msg) → Telegram → Whisper STT → text → Mr. Rogers
Mr. Rogers → text → synthesize_speech MCP tool → Voxtral/OpenAI → .opus file → send_message → Telegram → User
```

The TTS tool and message delivery are decoupled. The agent calls `synthesize_speech` to generate audio, then decides whether/how to send it via the existing `send_message` MCP tool with file attachment.

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
| `no` | OpenAI TTS | — |

If Voxtral API fails (timeout, error), automatically falls back to OpenAI TTS for that request.

### Output

- Format: Opus (compact, Telegram-native for voice messages)
- Sample rate: 24kHz
- Saved to: `/workspace/group/audio/tts-{timestamp}.opus`
- Returns: file path as text content

### Voice Selection

- Voxtral: one preset voice chosen during implementation (natural, tutor-appropriate)
- OpenAI: one preset voice (from alloy, echo, fable, nova, onyx, shimmer)
- Overridable via the `voice` parameter

## STT: Whisper Integration

Applied via the existing `/add-voice-transcription` NanoClaw skill:

- Hooks into Telegram `message:voice` and `message:audio` handlers
- Downloads audio via Telegram Bot API
- Transcribes via OpenAI Whisper API
- Passes transcribed text to the agent as a normal message
- Supports Norwegian, English, German, Italian (and 95+ other languages)

No custom code needed — skill is applied as-is.

## Credentials

| Key | Provider | Purpose |
|-----|----------|---------|
| `MISTRAL_API_KEY` | Mistral AI | Voxtral TTS API |
| `OPENAI_API_KEY` | OpenAI | TTS fallback + Whisper STT |

Both managed via OneCLI, injected into containers at runtime.

## Error Handling

- **API timeout/failure**: Return error text to agent; agent responds in text instead
- **Text too long (>5000 chars)**: Reject with clear error message
- **Empty text**: Reject with error
- **Invalid language**: Fall back to English with a note
- **Voxtral failure**: Automatic fallback to OpenAI TTS

## Testing

- Unit tests for provider routing logic (language → provider selection)
- Unit tests for parameter validation (text length, language enum, voice)
- Integration tests with mocked API responses for both Voxtral and OpenAI
- Manual E2E: prompt Mr. Rogers for a voice summary, verify audio arrives on Telegram

## Scope Boundaries

- No automatic TTS on every response — agent uses it only when prompted
- No new database tables or config files
- No changes to existing tests
- STT handled entirely by existing skill, not custom code
- Voice cloning is out of scope for now (but Voxtral supports it for future use)

## Cost Estimate

Both APIs are ~$0.015-0.016 per 1000 characters. A typical note summary (~500 chars) costs less than $0.01. Whisper STT is $0.006/minute. Negligible for personal use.
