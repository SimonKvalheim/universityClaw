# Voice v1.1 — Real-Gemini Live Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> execute this plan inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder `wss://…/?access_token=…` URL in `VoiceSession`
with a real adapter against `@google/genai`'s `ai.live.connect()` so
`/voice` works with a production `GEMINI_API_KEY`, while keeping the v1 fake-
server test suite green via a Transport-injection abstraction.

**Architecture:** Introduce a `Transport` interface between `VoiceSession` and
the wire protocol. `GeminiLiveTransport` wraps `@google/genai`'s
`ai.live.connect()` and translates Gemini's `LiveServerMessage` frames to the
Transport event shape. `FakeJsonTransport` wraps the in-repo fake server's
`{type:'audio'|'usage'|…}` JSON frames for tests. `VoiceSession` keeps the
token mint + context fetch + soft-cap timer + session-close POST orchestration
and no longer touches WebSocket frames.

**Tech Stack:** TypeScript, `@google/genai` v1.50+, Next.js route handlers
unchanged, `ws` in tests, Vitest, existing `CostTracker` + `RATES`.

---

## Files Touched

**New:**
- `dashboard/src/app/voice/transport.ts` — `Transport` + `TransportEvents` +
  `TransportInit` interfaces.
- `dashboard/src/app/voice/transports/fake-json-transport.ts` — Wraps the fake
  server's WS JSON protocol. Extracted verbatim from today's VoiceSession.
- `dashboard/src/app/voice/transports/gemini-live-transport.ts` — Real Gemini
  Live adapter using `ai.live.connect()`.
- `dashboard/src/app/voice/__tests__/gemini-live-transport.test.ts` — Unit
  tests against a mocked `@google/genai`.

**Modified:**
- `dashboard/src/app/voice/voice-session.ts` — Delegates to a `Transport`.
- `dashboard/src/app/voice/__tests__/voice-session.test.ts` — Pass a
  `FakeJsonTransport` instead of `liveApiUrl` + `wsFactory`.
- `dashboard/src/app/voice/__tests__/e2e.test.ts` — Same.
- `docs/voice-dogfood-checklist.md` — Drop the v1 fake-only warning block.

**Not touched:** Token mint route, context route, tool dispatcher, session-close
route, cost tracker, rates, personas, UI page, audio IO.

---

## Task 1: Transport interface

**Files:**
- Create: `dashboard/src/app/voice/transport.ts`

- [ ] **Step 1: Write the interface module**

```ts
import type { PersonaConfig } from './personas';
import type { TokenUsage } from './rates';

/**
 * Events emitted by a Transport during its lifetime. VoiceSession supplies
 * these to translate transport output into transcript buffering, audio
 * playback, tool dispatch, and cost rollups.
 */
export interface TransportEvents {
  onAudio: (pcm: Int16Array) => void;
  onInputTranscript: (text: string, partial: boolean) => void;
  onOutputTranscript: (text: string, partial: boolean) => void;
  onToolCall: (call: { id: string; name: string; args: unknown }) => void;
  onUsage: (usage: TokenUsage) => void;
  /**
   * Fires once when the underlying connection terminates. `server_end` means
   * the server closed cleanly (hard cap, goAway, or bye-ack); `drop` means an
   * unexpected socket error / close.
   */
  onClose: (reason: 'server_end' | 'drop') => void;
}

export interface TransportStartArgs {
  contextPayload: unknown;
  events: TransportEvents;
}

export interface TransportStartResult {
  /** Server-issued or locally-generated session id, whichever the transport owns. */
  voiceSessionId: string;
}

/**
 * A Transport handles the wire protocol for a voice session. VoiceSession
 * owns orchestration (context fetch, soft-cap timer, session-close POST);
 * the Transport handles whatever framing the backend needs.
 */
export interface Transport {
  readonly persona: PersonaConfig;
  start(args: TransportStartArgs): Promise<TransportStartResult>;
  sendAudio(pcm: Int16Array): void;
  sendToolResponse(id: string, name: string, response: unknown): void;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit`
Expected: PASS (no new errors — file is not yet imported).

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/voice/transport.ts
git commit -m "voice: add Transport interface for v1.1 Gemini adapter"
```

---

## Task 2: FakeJsonTransport

Extracts the WebSocket frame handling that lives in today's `VoiceSession`
into a standalone transport. It speaks the same opaque JSON protocol the
fake-gemini-server already implements — no changes to the fake server.

**Files:**
- Create: `dashboard/src/app/voice/transports/fake-json-transport.ts`

- [ ] **Step 1: Write the transport module**

```ts
import type { PersonaConfig } from '../personas';
import type {
  Transport,
  TransportEvents,
  TransportStartArgs,
  TransportStartResult,
} from '../transport';

const WS_OPEN = 1;

type WsEventName = 'open' | 'error' | 'message' | 'close';
interface WsListenerTarget {
  addEventListener(
    ev: WsEventName,
    cb: (e: Event) => void,
    opts?: { once?: boolean },
  ): void;
  removeEventListener?(ev: WsEventName, cb: (e: Event) => void): void;
}

interface ServerFrame {
  type: string;
  data?: string;
  text?: string;
  partial?: boolean;
  id?: string;
  name?: string;
  args?: unknown;
  textIn?: number;
  textOut?: number;
  audioIn?: number;
  audioOut?: number;
}

function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToPcm(b64: string): Int16Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    const pcm = new Int16Array(Math.floor(buf.length / 2));
    const view = new DataView(buf.buffer, buf.byteOffset, pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = view.getInt16(i * 2, true);
    }
    return pcm;
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 2),
  );
}

function newSessionId(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  const uuid = g.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return 'sid-' + Math.random().toString(36).slice(2);
}

export interface FakeJsonTransportOptions {
  url: string;
  persona: PersonaConfig;
  wsFactory?: (url: string) => WebSocket;
}

export class FakeJsonTransport implements Transport {
  readonly persona: PersonaConfig;
  private readonly url: string;
  private readonly wsFactory: (url: string) => WebSocket;
  private ws: WebSocket | null = null;
  private events: TransportEvents | null = null;
  private closed = false;

  constructor(opts: FakeJsonTransportOptions) {
    this.persona = opts.persona;
    this.url = opts.url;
    this.wsFactory =
      opts.wsFactory ??
      ((u: string) => new (globalThis as { WebSocket: typeof WebSocket }).WebSocket(u));
  }

  async start(args: TransportStartArgs): Promise<TransportStartResult> {
    this.events = args.events;
    const voiceSessionId = newSessionId();
    const ws = this.wsFactory(this.url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const target = ws as unknown as WsListenerTarget;
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (ev: unknown) => {
        cleanup();
        reject(new Error('ws open failed: ' + String(ev)));
      };
      const cleanup = () => {
        target.removeEventListener?.('open', onOpen as EventListener);
        target.removeEventListener?.('error', onError as EventListener);
      };
      target.addEventListener('open', onOpen as EventListener, { once: true });
      target.addEventListener('error', onError as EventListener, { once: true });
    });

    const target = ws as unknown as WsListenerTarget;
    target.addEventListener('message', (e) => {
      const ev = e as MessageEvent;
      const raw =
        typeof ev.data === 'string'
          ? ev.data
          : ev.data instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(ev.data)).toString('utf8')
            : Buffer.isBuffer(ev.data)
              ? (ev.data as Buffer).toString('utf8')
              : String(ev.data);
      this.onMessage(raw);
    });
    target.addEventListener('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.events?.onClose('drop');
    });
    target.addEventListener('error', () => {
      /* close handler drives shutdown */
    });

    // Send the initial client_content with persona + context (matches the
    // frame the fake server accepts today).
    this.send({
      type: 'client_content',
      content: {
        systemInstruction: this.persona.systemInstruction,
        context: args.contextPayload,
        tools: this.persona.tools,
        voice: this.persona.voice,
      },
    });

    return { voiceSessionId };
  }

  sendAudio(pcm: Int16Array): void {
    this.send({ type: 'client_audio', data: pcmToBase64(pcm) });
  }

  sendToolResponse(id: string, _name: string, response: unknown): void {
    this.send({ type: 'tool_response', id, response });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ws && this.ws.readyState === WS_OPEN) {
      try {
        this.send({ type: 'bye' });
      } catch {
        /* ignore */
      }
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private onMessage(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    const events = this.events;
    if (!events) return;

    switch (frame.type) {
      case 'audio': {
        if (typeof frame.data !== 'string') return;
        events.onAudio(base64ToPcm(frame.data));
        return;
      }
      case 'input_transcription': {
        if (typeof frame.text !== 'string') return;
        events.onInputTranscript(frame.text, frame.partial === true);
        return;
      }
      case 'output_transcription': {
        if (typeof frame.text !== 'string') return;
        events.onOutputTranscript(frame.text, frame.partial === true);
        return;
      }
      case 'tool_call': {
        if (typeof frame.id !== 'string' || typeof frame.name !== 'string') return;
        events.onToolCall({ id: frame.id, name: frame.name, args: frame.args });
        return;
      }
      case 'usage': {
        events.onUsage({
          textIn: frame.textIn ?? 0,
          textOut: frame.textOut ?? 0,
          audioIn: frame.audioIn ?? 0,
          audioOut: frame.audioOut ?? 0,
        });
        return;
      }
      case 'server_end': {
        if (this.closed) return;
        this.closed = true;
        events.onClose('server_end');
        return;
      }
      default:
        return;
    }
  }

  private send(obj: unknown): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      /* close handler drives shutdown */
    }
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/voice/transports/fake-json-transport.ts
git commit -m "voice: add FakeJsonTransport wrapping the fake-gemini-server protocol"
```

---

## Task 3: GeminiLiveTransport

Real-Gemini adapter. Mirrors the canonical frame shapes documented in
`@google/genai`'s `LiveServerMessage`, `LiveServerContent`, `UsageMetadata`,
and `MediaModality`. Tokens for `ai.live.connect()` are ephemeral and only
work on the `v1alpha` http surface, hence the `httpOptions` override.

**Files:**
- Create: `dashboard/src/app/voice/transports/gemini-live-transport.ts`

- [ ] **Step 1: Write the module**

```ts
import {
  GoogleGenAI,
  MediaModality,
  Modality,
  type FunctionCall,
  type LiveServerMessage,
  type Session,
  type UsageMetadata,
} from '@google/genai';
import type { PersonaConfig } from '../personas';
import type {
  Transport,
  TransportEvents,
  TransportStartArgs,
  TransportStartResult,
} from '../transport';
import type { TokenUsage } from '../rates';

const MODEL = 'gemini-3.1-flash-live-preview';

export interface GeminiLiveTransportOptions {
  persona: PersonaConfig;
  tokenEndpoint?: string;
  /**
   * Test seam. When provided, replaces the `new GoogleGenAI(...)` construction
   * inside `start()` so tests can inject a stub. Not used in production.
   */
  genaiFactory?: (opts: {
    apiKey: string;
    httpOptions?: { apiVersion?: string };
  }) => {
    live: { connect: (params: GenaiConnectParams) => Promise<Session> };
  };
}

/**
 * Shape of the `ai.live.connect()` parameter we construct. This mirrors
 * `types.LiveConnectParameters` from `@google/genai` but is spelled out here
 * so the test stub can verify the call site without importing the SDK type.
 */
export interface GenaiConnectParams {
  model: string;
  callbacks: {
    onopen?: () => void;
    onmessage: (msg: LiveServerMessage) => void;
    onerror?: (e: unknown) => void;
    onclose?: (e: unknown) => void;
  };
  config: {
    responseModalities: Modality[];
    systemInstruction: string;
    inputAudioTranscription: Record<string, never>;
    outputAudioTranscription: Record<string, never>;
    tools: [{ functionDeclarations: PersonaConfig['tools'] }];
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: string } };
    };
  };
}

function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToPcm(b64: string): Int16Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    const pcm = new Int16Array(Math.floor(buf.length / 2));
    const view = new DataView(buf.buffer, buf.byteOffset, pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = view.getInt16(i * 2, true);
    }
    return pcm;
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 2),
  );
}

/**
 * Extract textIn/textOut/audioIn/audioOut from a Gemini UsageMetadata.
 * Gemini reports modality breakdown in `promptTokensDetails[*]` /
 * `responseTokensDetails[*]` keyed by `modality: 'TEXT' | 'AUDIO' | ...`.
 * We sum across the details — the top-level totals don't split by modality.
 */
function usageMetadataToTokenUsage(u: UsageMetadata): TokenUsage {
  const acc: TokenUsage = { textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 };
  for (const d of u.promptTokensDetails ?? []) {
    const n = d.tokenCount ?? 0;
    if (d.modality === MediaModality.TEXT) acc.textIn += n;
    else if (d.modality === MediaModality.AUDIO) acc.audioIn += n;
  }
  for (const d of u.responseTokensDetails ?? []) {
    const n = d.tokenCount ?? 0;
    if (d.modality === MediaModality.TEXT) acc.textOut += n;
    else if (d.modality === MediaModality.AUDIO) acc.audioOut += n;
  }
  return acc;
}

export class GeminiLiveTransport implements Transport {
  readonly persona: PersonaConfig;
  private readonly tokenEndpoint: string;
  private readonly genaiFactory: NonNullable<
    GeminiLiveTransportOptions['genaiFactory']
  >;
  private session: Session | null = null;
  private events: TransportEvents | null = null;
  private closed = false;

  constructor(opts: GeminiLiveTransportOptions) {
    this.persona = opts.persona;
    this.tokenEndpoint = opts.tokenEndpoint ?? '/api/voice/token';
    this.genaiFactory =
      opts.genaiFactory ??
      ((args) =>
        new GoogleGenAI(args) as unknown as {
          live: { connect: (p: GenaiConnectParams) => Promise<Session> };
        });
  }

  async start(args: TransportStartArgs): Promise<TransportStartResult> {
    this.events = args.events;

    // 1. Mint an ephemeral token.
    const tokenRes = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: this.persona.name }),
    });
    if (!tokenRes.ok) {
      throw new Error(`Token mint failed: ${tokenRes.status}`);
    }
    const { token, voiceSessionId } = (await tokenRes.json()) as {
      token: string;
      voiceSessionId: string;
    };

    // 2. Open the Live session. Ephemeral tokens require v1alpha.
    const ai = this.genaiFactory({
      apiKey: token,
      httpOptions: { apiVersion: 'v1alpha' },
    });
    const session = await ai.live.connect({
      model: MODEL,
      callbacks: {
        onmessage: (msg) => this.onMessage(msg),
        onerror: () => {
          // `onclose` will follow and drive shutdown.
        },
        onclose: () => {
          if (this.closed) return;
          this.closed = true;
          this.events?.onClose('drop');
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: this.persona.systemInstruction,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [{ functionDeclarations: this.persona.tools }],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: this.persona.voice },
          },
        },
      },
    });
    this.session = session;

    // 3. Deliver the startup context as a user turn. `turnComplete: false`
    //    parks it in the prompt without forcing the model to generate before
    //    the user speaks.
    session.sendClientContent({
      turns: [
        {
          role: 'user',
          parts: [
            {
              text:
                'Project context (read on session start):\n\n' +
                JSON.stringify(args.contextPayload, null, 2),
            },
          ],
        },
      ],
      turnComplete: false,
    });

    return { voiceSessionId };
  }

  sendAudio(pcm: Int16Array): void {
    if (!this.session) return;
    this.session.sendRealtimeInput({
      audio: {
        data: pcmToBase64(pcm),
        mimeType: 'audio/pcm;rate=16000',
      },
    });
  }

  sendToolResponse(id: string, name: string, response: unknown): void {
    if (!this.session) return;
    this.session.sendToolResponse({
      functionResponses: [
        {
          id,
          name,
          response: (response && typeof response === 'object'
            ? (response as Record<string, unknown>)
            : { output: response }) as Record<string, unknown>,
        },
      ],
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
  }

  private onMessage(msg: LiveServerMessage): void {
    const events = this.events;
    if (!events) return;

    const sc = msg.serverContent;
    if (sc) {
      // Audio output comes as inlineData parts on the modelTurn.
      const parts = sc.modelTurn?.parts ?? [];
      for (const p of parts) {
        const inline = p.inlineData;
        if (
          inline?.data &&
          typeof inline.mimeType === 'string' &&
          inline.mimeType.startsWith('audio/pcm')
        ) {
          events.onAudio(base64ToPcm(inline.data));
        }
      }

      // Transcriptions arrive independently of the model turn.
      const itxt = sc.inputTranscription?.text;
      if (typeof itxt === 'string' && itxt.length > 0) {
        const finished = sc.inputTranscription?.finished === true;
        events.onInputTranscript(itxt, !finished);
      }
      const otxt = sc.outputTranscription?.text;
      if (typeof otxt === 'string' && otxt.length > 0) {
        const finished = sc.outputTranscription?.finished === true;
        events.onOutputTranscript(otxt, !finished);
      }
    }

    const calls = msg.toolCall?.functionCalls ?? [];
    for (const c of calls as FunctionCall[]) {
      if (!c.id || !c.name) continue;
      events.onToolCall({ id: c.id, name: c.name, args: c.args });
    }

    if (msg.usageMetadata) {
      events.onUsage(usageMetadataToTokenUsage(msg.usageMetadata));
    }

    if (msg.goAway) {
      // Server is going to close soon — treat as a clean server_end so
      // VoiceSession flushes as hard_cap.
      if (!this.closed) {
        this.closed = true;
        events.onClose('server_end');
      }
    }
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit`
Expected: PASS. If any mismatches surface against the real SDK types, cross-
reference `dashboard/node_modules/@google/genai/dist/genai.d.ts`.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/voice/transports/gemini-live-transport.ts
git commit -m "voice: add GeminiLiveTransport using ai.live.connect() (v1alpha)"
```

---

## Task 4: Refactor VoiceSession

Strips WebSocket + JSON-frame handling out of `VoiceSession`. Replaces it
with a `Transport` delegation. The class keeps token-less orchestration
(context fetch, soft-cap timer, transcript buffering, session-close POST,
cost tracker, stop reason semantics).

**Files:**
- Modify: `dashboard/src/app/voice/voice-session.ts` (full rewrite)

- [ ] **Step 1: Replace `voice-session.ts` with the Transport-based version**

```ts
import { CostTracker } from './cost-tracker';
import { RATES, type TokenUsage } from './rates';
import type { PersonaConfig } from './personas';
import type { Transport, TransportEvents } from './transport';
import { GeminiLiveTransport } from './transports/gemini-live-transport';

export interface VoiceSessionEvents {
  onInputTranscript: (text: string, partial: boolean) => void;
  onOutputTranscript: (text: string, partial: boolean) => void;
  onAudio: (pcm: Int16Array) => void;
  onToolCall: (call: {
    id: string;
    name: string;
    args: unknown;
  }) => Promise<unknown>;
  onCost: (costUsd: number) => void;
  onEnd: (payload: SessionEndPayload) => void;
}

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  ts: string;
}

export interface SessionEndPayload {
  transcript: TranscriptEntry[];
  startedAt: string;
  endedAt: string;
  usage: TokenUsage;
  endReason: 'user_stop' | 'tab_close' | 'soft_cap' | 'hard_cap' | 'ws_drop';
  resumeHandle?: string;
}

export interface VoiceSessionOptions {
  persona: PersonaConfig;
  tokenEndpoint?: string;
  contextEndpoint?: string;
  toolEndpoint?: string;
  closeEndpoint?: string;
  softCapSeconds?: number;
  events: VoiceSessionEvents;
  /**
   * Wire-protocol adapter. Omit in production (defaults to
   * `GeminiLiveTransport`); tests inject a `FakeJsonTransport`.
   */
  transport?: Transport;
}

type StopReason = SessionEndPayload['endReason'];

export class VoiceSession {
  private readonly events: VoiceSessionEvents;
  private readonly persona: PersonaConfig;
  private readonly contextEndpoint: string;
  private readonly toolEndpoint: string;
  private readonly closeEndpoint: string;
  private readonly softCapSeconds: number;
  private readonly transport: Transport;

  private readonly costTracker: CostTracker;
  private readonly costListener: (c: number) => void;
  private readonly transcript: TranscriptEntry[] = [];

  private voiceSessionId = '';
  private startedAt = '';
  private muted = false;
  private softCapTimer: ReturnType<typeof setTimeout> | null = null;
  private stoppingPromise: Promise<void> | null = null;
  private started = false;

  constructor(opts: VoiceSessionOptions) {
    this.events = opts.events;
    this.persona = opts.persona;
    this.contextEndpoint = opts.contextEndpoint ?? opts.persona.contextPath;
    this.toolEndpoint = opts.toolEndpoint ?? '/api/voice/tools/dev';
    this.closeEndpoint = opts.closeEndpoint ?? '/api/voice/session-close';
    this.softCapSeconds = opts.softCapSeconds ?? 600;
    this.transport =
      opts.transport ??
      new GeminiLiveTransport({
        persona: opts.persona,
        tokenEndpoint: opts.tokenEndpoint,
      });

    this.costTracker = new CostTracker(RATES);
    this.costListener = (c) => {
      this.events.onCost(c);
    };
    this.costTracker.onChange(this.costListener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startedAt = new Date().toISOString();

    // Fetch startup context BEFORE opening the transport; failure blocks
    // session start.
    const ctxRes = await fetch(this.contextEndpoint);
    if (!ctxRes.ok) {
      throw new Error(`Context fetch failed: ${ctxRes.status}`);
    }
    const contextPayload = await ctxRes.json();

    const transportEvents: TransportEvents = {
      onAudio: (pcm) => this.events.onAudio(pcm),
      onInputTranscript: (text, partial) => {
        this.events.onInputTranscript(text, partial);
        if (!partial) {
          this.transcript.push({
            role: 'user',
            text,
            ts: new Date().toISOString(),
          });
        }
      },
      onOutputTranscript: (text, partial) => {
        this.events.onOutputTranscript(text, partial);
        if (!partial) {
          this.transcript.push({
            role: 'assistant',
            text,
            ts: new Date().toISOString(),
          });
        }
      },
      onToolCall: (call) => {
        void this.runToolCall(call);
      },
      onUsage: (usage) => {
        this.costTracker.addUsage(usage);
      },
      onClose: (reason) => {
        if (this.stoppingPromise) return;
        void this.stop(reason === 'server_end' ? 'hard_cap' : 'ws_drop');
      },
    };

    const { voiceSessionId } = await this.transport.start({
      contextPayload,
      events: transportEvents,
    });
    this.voiceSessionId = voiceSessionId;

    this.softCapTimer = setTimeout(() => {
      void this.stop('soft_cap');
    }, this.softCapSeconds * 1000);
  }

  sendAudio(pcm: Int16Array): void {
    if (this.muted) return;
    this.transport.sendAudio(pcm);
  }

  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
  }

  stop(reason?: StopReason): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise;
    this.stoppingPromise = this._doStop(reason ?? 'user_stop');
    return this.stoppingPromise;
  }

  private async _doStop(reason: StopReason): Promise<void> {
    if (this.softCapTimer) {
      clearTimeout(this.softCapTimer);
      this.softCapTimer = null;
    }

    try {
      await this.transport.close();
    } catch {
      /* ignore */
    }

    const endedAt = new Date().toISOString();
    const usage = this.costTracker.totals;
    const payload: SessionEndPayload = {
      transcript: this.transcript.slice(),
      startedAt: this.startedAt,
      endedAt,
      usage,
      endReason: reason,
    };

    try {
      await fetch(this.closeEndpoint, {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          voiceSessionId: this.voiceSessionId,
          persona: this.persona.name,
          startedAt: this.startedAt,
          endedAt,
          transcript: payload.transcript,
          usage,
          artifacts: [],
          endReason: reason,
        }),
      });
    } catch (err) {
      console.error('session-close POST failed', err);
    }

    this.costTracker.offChange(this.costListener);
    this.events.onEnd(payload);
  }

  private async runToolCall(call: {
    id: string;
    name: string;
    args: unknown;
  }): Promise<void> {
    let response: unknown;
    try {
      response = await this.events.onToolCall(call);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      response = { error: message };
    }
    this.transport.sendToolResponse(call.id, call.name, response);
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit`
Expected: PASS. Existing imports of `VoiceSession` / `SessionEndPayload` from
`dashboard/src/app/voice/page.tsx` continue to type-check because the public
surface (`VoiceSession`, `VoiceSessionOptions.persona/events`,
`SessionEndPayload`) is preserved.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/voice/voice-session.ts
git commit -m "voice: delegate VoiceSession to pluggable Transport"
```

---

## Task 5: Update existing tests

The current tests pass `liveApiUrl` + `wsFactory` to force VoiceSession onto
the fake server. After the refactor those options no longer exist — tests
construct a `FakeJsonTransport` instead.

**Files:**
- Modify: `dashboard/src/app/voice/__tests__/voice-session.test.ts`
- Modify: `dashboard/src/app/voice/__tests__/e2e.test.ts`

- [ ] **Step 1: Rewrite `voice-session.test.ts` session construction**

In each of the four tests, replace the `VoiceSession` constructor call. Each
test currently looks like:

```ts
const session = new VoiceSession({
  persona: DEV_PERSONA,
  liveApiUrl: fake.url,
  tokenEndpoint: '/test/token',
  contextEndpoint: '/test/ctx',
  toolEndpoint: '/test/tool',
  closeEndpoint: '/test/close',
  wsFactory,
  events: { ... },
});
```

Change it to:

```ts
const session = new VoiceSession({
  persona: DEV_PERSONA,
  contextEndpoint: '/test/ctx',
  toolEndpoint: '/test/tool',
  closeEndpoint: '/test/close',
  transport: new FakeJsonTransport({
    url: fake.url,
    persona: DEV_PERSONA,
    wsFactory,
  }),
  events: { ... },
});
```

Add at the top with the other imports:

```ts
import { FakeJsonTransport } from '../transports/fake-json-transport';
```

Drop the `tokenEndpoint` and `liveApiUrl` properties (neither exist any more).
Everything else — `fake.sendUsage`, `fake.sendAssistantAudio`,
`fake.sendInputTranscription`, `fake.sendOutputTranscription`,
`fake.sendToolCall`, `fake.terminate`, `fake.waitForToolResponse` — keeps
working unchanged because the FakeJsonTransport speaks the same protocol.

- [ ] **Step 2: Run the four VoiceSession tests**

Run: `npx vitest run dashboard/src/app/voice/__tests__/voice-session.test.ts`
Expected: 4/4 PASS.

- [ ] **Step 3: Rewrite `e2e.test.ts` session construction**

In `dashboard/src/app/voice/__tests__/e2e.test.ts`, the session construction
around line 144 needs the same swap:

```ts
const session = new VoiceSession({
  persona: DEV_PERSONA,
  transport: new FakeJsonTransport({
    url: fake.url,
    persona: DEV_PERSONA,
    wsFactory,
  }),
  events: { ... },
});
```

Add the import:

```ts
import { FakeJsonTransport } from '../transports/fake-json-transport';
```

Remove the `liveApiUrl: fake.url` and `wsFactory` lines. The `vi.doMock` of
`@google/genai` at line 133 can stay — it covers the token route's use of
`GoogleGenAI.authTokens.create` even though the test uses `FakeJsonTransport`
and never hits `GeminiLiveTransport`.

- [ ] **Step 4: Run the e2e test**

Run: `npx vitest run dashboard/src/app/voice/__tests__/e2e.test.ts`
Expected: 1/1 PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/voice/__tests__/voice-session.test.ts \
        dashboard/src/app/voice/__tests__/e2e.test.ts
git commit -m "voice: update VoiceSession tests to inject FakeJsonTransport"
```

---

## Task 6: GeminiLiveTransport tests

Stub `@google/genai` via the `genaiFactory` seam and feed synthetic
`LiveServerMessage` frames to verify the translation layer. The tests do not
hit the real Gemini service.

**Files:**
- Create: `dashboard/src/app/voice/__tests__/gemini-live-transport.test.ts`

- [ ] **Step 1: Write the test module**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaModality, type LiveServerMessage, type Session } from '@google/genai';
import { GeminiLiveTransport } from '../transports/gemini-live-transport';
import { DEV_PERSONA } from '../personas';
import type { TransportEvents } from '../transport';

interface StubSession extends Session {
  sent: Array<
    | { kind: 'realtime'; audioB64: string; mimeType: string }
    | { kind: 'toolResponse'; id: string; name: string; response: unknown }
    | { kind: 'clientContent'; text: string; turnComplete: boolean }
    | { kind: 'close' }
  >;
  emit: (msg: LiveServerMessage) => void;
  emitClose: () => void;
}

function makeStubSession(): StubSession {
  const sent: StubSession['sent'] = [];
  let onmessage: (msg: LiveServerMessage) => void = () => {};
  let onclose: (() => void) | null = null;

  const stub = {
    sent,
    sendRealtimeInput: (p: { audio?: { data?: string; mimeType?: string } }) => {
      if (p.audio?.data && p.audio.mimeType) {
        sent.push({
          kind: 'realtime',
          audioB64: p.audio.data,
          mimeType: p.audio.mimeType,
        });
      }
    },
    sendToolResponse: (p: {
      functionResponses: Array<{ id?: string; name?: string; response?: unknown }>;
    }) => {
      for (const fr of p.functionResponses) {
        sent.push({
          kind: 'toolResponse',
          id: fr.id ?? '',
          name: fr.name ?? '',
          response: fr.response,
        });
      }
    },
    sendClientContent: (p: {
      turns?: Array<{ parts?: Array<{ text?: string }> }>;
      turnComplete?: boolean;
    }) => {
      const text = p.turns?.[0]?.parts?.[0]?.text ?? '';
      sent.push({
        kind: 'clientContent',
        text,
        turnComplete: p.turnComplete !== false,
      });
    },
    close: () => {
      sent.push({ kind: 'close' });
    },
    emit: (msg: LiveServerMessage) => onmessage(msg),
    emitClose: () => onclose?.(),
    _bind: (args: {
      onmessage: (msg: LiveServerMessage) => void;
      onclose?: () => void;
    }) => {
      onmessage = args.onmessage;
      onclose = args.onclose ?? null;
    },
  };

  return stub as unknown as StubSession;
}

function makeEvents(): { events: TransportEvents; log: unknown[] } {
  const log: unknown[] = [];
  const events: TransportEvents = {
    onAudio: (pcm) => log.push({ kind: 'audio', bytes: pcm.byteLength }),
    onInputTranscript: (text, partial) =>
      log.push({ kind: 'in', text, partial }),
    onOutputTranscript: (text, partial) =>
      log.push({ kind: 'out', text, partial }),
    onToolCall: (call) => log.push({ kind: 'tool', ...call }),
    onUsage: (u) => log.push({ kind: 'usage', ...u }),
    onClose: (reason) => log.push({ kind: 'close', reason }),
  };
  return { events, log };
}

describe('GeminiLiveTransport', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'ephemeral-xyz', voiceSessionId: 'vsid-1' }),
    })) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('connects with v1alpha + Zephyr + tools + both transcriptions, then sends context as clientContent', async () => {
    const stub = makeStubSession();
    const connect = vi.fn(async (params) => {
      (stub as unknown as { _bind: (a: unknown) => void })._bind({
        onmessage: params.callbacks.onmessage,
        onclose: params.callbacks.onclose,
      });
      return stub;
    });
    const factory = vi.fn((args: { apiKey: string; httpOptions?: { apiVersion?: string } }) => {
      return { live: { connect } } as unknown as {
        live: { connect: typeof connect };
      };
    });

    const transport = new GeminiLiveTransport({
      persona: DEV_PERSONA,
      genaiFactory: factory,
    });
    const { events } = makeEvents();

    const result = await transport.start({
      contextPayload: { claudeMd: 'hello' },
      events,
    });

    expect(result.voiceSessionId).toBe('vsid-1');
    expect(factory).toHaveBeenCalledWith({
      apiKey: 'ephemeral-xyz',
      httpOptions: { apiVersion: 'v1alpha' },
    });
    expect(connect).toHaveBeenCalledTimes(1);
    const params = connect.mock.calls[0][0];
    expect(params.model).toBe('gemini-3.1-flash-live-preview');
    expect(params.config.systemInstruction).toBe(DEV_PERSONA.systemInstruction);
    expect(params.config.responseModalities).toEqual(['AUDIO']);
    expect(params.config.inputAudioTranscription).toEqual({});
    expect(params.config.outputAudioTranscription).toEqual({});
    expect(params.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Zephyr');
    expect(params.config.tools[0].functionDeclarations).toBe(DEV_PERSONA.tools);

    const clientContent = stub.sent.find((s) => s.kind === 'clientContent');
    expect(clientContent).toBeDefined();
    expect(clientContent!.kind).toBe('clientContent');
    // turnComplete must be false so context sits in the prompt without forcing generation.
    expect((clientContent as { turnComplete: boolean }).turnComplete).toBe(false);
    expect((clientContent as { text: string }).text).toContain('hello');
  });

  it('translates inlineData audio frames into Int16Array audio events', async () => {
    const stub = makeStubSession();
    const connect = vi.fn(async (params) => {
      (stub as unknown as { _bind: (a: unknown) => void })._bind({
        onmessage: params.callbacks.onmessage,
        onclose: params.callbacks.onclose,
      });
      return stub;
    });
    const transport = new GeminiLiveTransport({
      persona: DEV_PERSONA,
      genaiFactory: () => ({ live: { connect } }) as unknown as {
        live: { connect: typeof connect };
      },
    });
    const { events, log } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    stub.emit({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                data: Buffer.from(new Uint8Array([0x01, 0x00, 0x02, 0x00])).toString('base64'),
                mimeType: 'audio/pcm;rate=24000',
              },
            },
          ],
        },
      },
    } as LiveServerMessage);

    expect(log).toContainEqual({ kind: 'audio', bytes: 4 });
  });

  it('maps input/output transcriptions with finished=false → partial=true', async () => {
    const stub = makeStubSession();
    const connect = vi.fn(async (params) => {
      (stub as unknown as { _bind: (a: unknown) => void })._bind({
        onmessage: params.callbacks.onmessage,
        onclose: params.callbacks.onclose,
      });
      return stub;
    });
    const transport = new GeminiLiveTransport({
      persona: DEV_PERSONA,
      genaiFactory: () => ({ live: { connect } }) as unknown as {
        live: { connect: typeof connect };
      },
    });
    const { events, log } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    stub.emit({
      serverContent: {
        inputTranscription: { text: 'hel', finished: false },
      },
    } as LiveServerMessage);
    stub.emit({
      serverContent: {
        inputTranscription: { text: 'hello world', finished: true },
      },
    } as LiveServerMessage);
    stub.emit({
      serverContent: {
        outputTranscription: { text: 'hi', finished: false },
      },
    } as LiveServerMessage);
    stub.emit({
      serverContent: {
        outputTranscription: { text: 'hi there', finished: true },
      },
    } as LiveServerMessage);

    expect(log).toEqual([
      { kind: 'in', text: 'hel', partial: true },
      { kind: 'in', text: 'hello world', partial: false },
      { kind: 'out', text: 'hi', partial: true },
      { kind: 'out', text: 'hi there', partial: false },
    ]);
  });

  it('sums usageMetadata modality details into TokenUsage', async () => {
    const stub = makeStubSession();
    const connect = vi.fn(async (params) => {
      (stub as unknown as { _bind: (a: unknown) => void })._bind({
        onmessage: params.callbacks.onmessage,
        onclose: params.callbacks.onclose,
      });
      return stub;
    });
    const transport = new GeminiLiveTransport({
      persona: DEV_PERSONA,
      genaiFactory: () => ({ live: { connect } }) as unknown as {
        live: { connect: typeof connect };
      },
    });
    const { events, log } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    stub.emit({
      usageMetadata: {
        promptTokensDetails: [
          { modality: MediaModality.TEXT, tokenCount: 100 },
          { modality: MediaModality.AUDIO, tokenCount: 2000 },
        ],
        responseTokensDetails: [
          { modality: MediaModality.TEXT, tokenCount: 50 },
          { modality: MediaModality.AUDIO, tokenCount: 3000 },
        ],
      },
    } as LiveServerMessage);

    expect(log).toContainEqual({
      kind: 'usage',
      textIn: 100,
      textOut: 50,
      audioIn: 2000,
      audioOut: 3000,
    });
  });

  it('forwards toolCall.functionCalls as onToolCall events and sends tool responses with id+name', async () => {
    const stub = makeStubSession();
    const connect = vi.fn(async (params) => {
      (stub as unknown as { _bind: (a: unknown) => void })._bind({
        onmessage: params.callbacks.onmessage,
        onclose: params.callbacks.onclose,
      });
      return stub;
    });
    const transport = new GeminiLiveTransport({
      persona: DEV_PERSONA,
      genaiFactory: () => ({ live: { connect } }) as unknown as {
        live: { connect: typeof connect };
      },
    });
    const { events, log } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    stub.emit({
      toolCall: {
        functionCalls: [{ id: 'c1', name: 'read_file', args: { path: 'x' } }],
      },
    } as LiveServerMessage);

    expect(log).toContainEqual({
      kind: 'tool',
      id: 'c1',
      name: 'read_file',
      args: { path: 'x' },
    });

    transport.sendToolResponse('c1', 'read_file', { content: 'ok' });

    const tr = stub.sent.find((s) => s.kind === 'toolResponse') as {
      kind: 'toolResponse';
      id: string;
      name: string;
      response: Record<string, unknown>;
    };
    expect(tr).toBeDefined();
    expect(tr.id).toBe('c1');
    expect(tr.name).toBe('read_file');
    expect(tr.response).toEqual({ content: 'ok' });
  });

  it('raises onClose("drop") when the session emits onclose unexpectedly', async () => {
    const stub = makeStubSession();
    const connect = vi.fn(async (params) => {
      (stub as unknown as { _bind: (a: unknown) => void })._bind({
        onmessage: params.callbacks.onmessage,
        onclose: params.callbacks.onclose,
      });
      return stub;
    });
    const transport = new GeminiLiveTransport({
      persona: DEV_PERSONA,
      genaiFactory: () => ({ live: { connect } }) as unknown as {
        live: { connect: typeof connect };
      },
    });
    const { events, log } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    stub.emitClose();

    expect(log).toContainEqual({ kind: 'close', reason: 'drop' });
  });

  it('raises onClose("server_end") on goAway frames', async () => {
    const stub = makeStubSession();
    const connect = vi.fn(async (params) => {
      (stub as unknown as { _bind: (a: unknown) => void })._bind({
        onmessage: params.callbacks.onmessage,
        onclose: params.callbacks.onclose,
      });
      return stub;
    });
    const transport = new GeminiLiveTransport({
      persona: DEV_PERSONA,
      genaiFactory: () => ({ live: { connect } }) as unknown as {
        live: { connect: typeof connect };
      },
    });
    const { events, log } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    stub.emit({ goAway: { timeLeft: '0s' } } as LiveServerMessage);

    expect(log).toContainEqual({ kind: 'close', reason: 'server_end' });
  });

  it('sends outgoing audio as base64 PCM @ 16kHz', async () => {
    const stub = makeStubSession();
    const connect = vi.fn(async (params) => {
      (stub as unknown as { _bind: (a: unknown) => void })._bind({
        onmessage: params.callbacks.onmessage,
        onclose: params.callbacks.onclose,
      });
      return stub;
    });
    const transport = new GeminiLiveTransport({
      persona: DEV_PERSONA,
      genaiFactory: () => ({ live: { connect } }) as unknown as {
        live: { connect: typeof connect };
      },
    });
    const { events } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    const pcm = new Int16Array([1, 2, 3]);
    transport.sendAudio(pcm);

    const rt = stub.sent.find((s) => s.kind === 'realtime') as {
      kind: 'realtime';
      audioB64: string;
      mimeType: string;
    };
    expect(rt).toBeDefined();
    expect(rt.mimeType).toBe('audio/pcm;rate=16000');
    expect(Buffer.from(rt.audioB64, 'base64').byteLength).toBe(6);
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run dashboard/src/app/voice/__tests__/gemini-live-transport.test.ts`
Expected: 8/8 PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/app/voice/__tests__/gemini-live-transport.test.ts
git commit -m "voice: test GeminiLiveTransport frame translation against mocked SDK"
```

---

## Task 7: Drop the v1 caveat, verify, dogfood, PR

**Files:**
- Modify: `docs/voice-dogfood-checklist.md`

- [ ] **Step 1: Remove the blockquoted v1 status warning from `docs/voice-dogfood-checklist.md`**

Delete lines 7-20 (the entire `> ⚠️ **v1 status — fake server only.** …` block
through the `Dogfooding the UI, tools, and cost plumbing is valuable
groundwork before the adapter lands.` paragraph). The remaining content
(Environment, Golden path, Tools, Denials, Session lifecycle, Edge cases,
Privacy) all still apply and now describe a working real-Gemini path.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: ~966 passing, 1 pre-existing skip of `claw-skill.test.ts`. No new
failures.

- [ ] **Step 3: Run typechecks**

Run: `npm run typecheck` (in repo root) and `cd dashboard && npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 4: Dogfood live**

Per `CLAUDE.md` → Services & Dependencies → Start Everything:

1. `docker restart onecli-app-1 onecli-postgres-1`
2. `.venv/bin/python3 -m lightrag.api.lightrag_server --port 9621 --working-dir ./data/lightrag &`
3. `cd dashboard && npm run dev &`
4. `npm run dev` (from repo root) in the foreground

Open Chromium at `http://localhost:3100/voice` with a real `GEMINI_API_KEY`
in `.env`. Walk the updated `docs/voice-dogfood-checklist.md` end-to-end.

- [ ] **Step 5: Commit the docs change**

```bash
git add docs/voice-dogfood-checklist.md
git commit -m "voice: drop v1 fake-only caveat from dogfood checklist"
```

- [ ] **Step 6: Push the branch**

```bash
git push -u origin feat/voice-gemini-adapter
```

- [ ] **Step 7: Open the PR against `SimonKvalheim/universityClaw`**

Use `/create-pr` or `gh pr create`. Body must reference `Closes #39` so the
issue auto-closes on merge. Summarize: Transport interface, GeminiLiveTransport,
FakeJsonTransport, VoiceSession refactor, test updates, dogfood checklist
caveat dropped.

---

## Spec Coverage Check

Acceptance criteria from GitHub issue #39:

| Criterion | Covered by |
|-----------|------------|
| Token mint flow unchanged | Task 3 calls `/api/voice/token` identically; Task 4 stops owning it |
| `GoogleGenAI({apiKey: token, httpOptions: {apiVersion: 'v1alpha'}})` + `ai.live.connect(...)` | Task 3 |
| Persona/context delivered as first `clientContent` after connect | Task 3 (Step 1, `session.sendClientContent`) |
| Translate `serverContent.modelTurn.parts[*].inlineData` audio frames | Task 3 `onMessage` |
| Translate `serverContent.inputTranscription`/`outputTranscription` | Task 3 `onMessage` |
| `toolCall.functionCalls[*]` → `onToolCall`, response via `sendToolResponse({functionResponses})` | Task 3 `onMessage` + `sendToolResponse` |
| `usageMetadata` → `costTracker.addUsage` summing `promptTokensDetails`/`responseTokensDetails` by modality | Task 3 `usageMetadataToTokenUsage` |
| Outgoing audio via `sendRealtimeInput({audio:{data,mimeType:'audio/pcm;rate=16000'}})` | Task 3 `sendAudio` |
| Two-layer abstraction (Option A: Transport interface) | Tasks 1-4 |
| Existing VoiceSession tests still pass | Task 5 via FakeJsonTransport |
| New smoke test against mocked Gemini response | Task 6 |
| Manual dogfood per checklist works | Task 7 |
| Remove placeholder WS URL + Task 19 comment | Task 4 (the whole `wsUrl = …` block is gone) |
| Drop v1 fake-only warning from dogfood checklist | Task 7 |
| Spec doc update if frame assumptions changed | Not needed — the spec already talks about BidiGenerateContent; this PR aligns the implementation with the spec |
