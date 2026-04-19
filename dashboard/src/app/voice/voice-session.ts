import { CostTracker } from './cost-tracker';
import { RATES, type TokenUsage } from './rates';
import type { PersonaConfig } from './personas';

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
  liveApiUrl?: string;
  softCapSeconds?: number;
  events: VoiceSessionEvents;
  wsFactory?: (url: string) => WebSocket;
}

type StopReason = SessionEndPayload['endReason'];

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

const WS_OPEN = 1;

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
    // Copy into a standalone Int16Array so callers don't alias Buffer memory.
    const pcm = new Int16Array(Math.floor(buf.length / 2));
    const view = new DataView(
      buf.buffer,
      buf.byteOffset,
      pcm.length * 2,
    );
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

export class VoiceSession {
  private readonly events: VoiceSessionEvents;
  private readonly persona: PersonaConfig;
  private readonly tokenEndpoint: string;
  private readonly contextEndpoint: string;
  private readonly toolEndpoint: string;
  private readonly closeEndpoint: string;
  private readonly liveApiUrl: string | undefined;
  private readonly softCapSeconds: number;
  private readonly wsFactory: (url: string) => WebSocket;

  private readonly costTracker: CostTracker;
  private readonly costListener: (c: number) => void;
  private readonly transcript: TranscriptEntry[] = [];

  private ws: WebSocket | null = null;
  private voiceSessionId = '';
  private startedAt = '';
  private muted = false;
  private softCapTimer: ReturnType<typeof setTimeout> | null = null;
  private stoppingPromise: Promise<void> | null = null;
  private started = false;

  constructor(opts: VoiceSessionOptions) {
    this.events = opts.events;
    this.persona = opts.persona;
    this.tokenEndpoint = opts.tokenEndpoint ?? '/api/voice/token';
    this.contextEndpoint = opts.contextEndpoint ?? opts.persona.contextPath;
    this.toolEndpoint = opts.toolEndpoint ?? '/api/voice/tools/dev';
    this.closeEndpoint = opts.closeEndpoint ?? '/api/voice/session-close';
    this.liveApiUrl = opts.liveApiUrl;
    this.softCapSeconds = opts.softCapSeconds ?? 600;
    this.wsFactory =
      opts.wsFactory ??
      ((url: string) => new (globalThis as { WebSocket: typeof WebSocket }).WebSocket(url));

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

    let wsUrl: string;
    if (this.liveApiUrl) {
      this.voiceSessionId = newSessionId();
      wsUrl = this.liveApiUrl;
    } else {
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
      this.voiceSessionId = voiceSessionId;
      // Raw URL placeholder for prod; production wiring is Task 19's concern.
      wsUrl = `wss://generativelanguage.googleapis.com/?access_token=${encodeURIComponent(
        token,
      )}`;
    }

    // Fetch startup context BEFORE opening the WS; failure blocks session start.
    const ctxRes = await fetch(this.contextEndpoint);
    if (!ctxRes.ok) {
      throw new Error(`Context fetch failed: ${ctxRes.status}`);
    }
    const contextPayload = await ctxRes.json();

    const ws = this.wsFactory(wsUrl);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (ev: unknown) => {
        cleanup();
        reject(new Error('ws open failed: ' + String(ev)));
      };
      const cleanup = () => {
        (ws as unknown as { removeEventListener?: Function }).removeEventListener?.(
          'open',
          onOpen as EventListener,
        );
        (ws as unknown as { removeEventListener?: Function }).removeEventListener?.(
          'error',
          onError as EventListener,
        );
      };
      (ws as unknown as { addEventListener: Function }).addEventListener(
        'open',
        onOpen as EventListener,
        { once: true },
      );
      (ws as unknown as { addEventListener: Function }).addEventListener(
        'error',
        onError as EventListener,
        { once: true },
      );
    });

    // Wire ongoing handlers.
    (ws as unknown as { addEventListener: Function }).addEventListener(
      'message',
      (ev: MessageEvent) => {
        const raw =
          typeof ev.data === 'string'
            ? ev.data
            : ev.data instanceof ArrayBuffer
              ? Buffer.from(new Uint8Array(ev.data)).toString('utf8')
              : Buffer.isBuffer(ev.data)
                ? (ev.data as Buffer).toString('utf8')
                : String(ev.data);
        this.onMessage(raw);
      },
    );
    (ws as unknown as { addEventListener: Function }).addEventListener(
      'close',
      () => {
        if (!this.stoppingPromise) {
          void this.stop('ws_drop');
        }
      },
    );
    (ws as unknown as { addEventListener: Function }).addEventListener(
      'error',
      () => {
        // Swallow post-open errors; close handler will drive shutdown.
      },
    );

    // Send the initial client_content with persona + context.
    this.wsSend({
      type: 'client_content',
      content: {
        systemInstruction: this.persona.systemInstruction,
        context: contextPayload,
        tools: this.persona.tools,
        voice: this.persona.voice,
      },
    });

    // Start soft-cap timer.
    this.softCapTimer = setTimeout(() => {
      void this.stop('soft_cap');
    }, this.softCapSeconds * 1000);
  }

  sendAudio(pcm: Int16Array): void {
    if (this.muted) return;
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    this.wsSend({ type: 'client_audio', data: pcmToBase64(pcm) });
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

    // Best-effort farewell.
    if (this.ws && this.ws.readyState === WS_OPEN) {
      try {
        this.wsSend({ type: 'bye' });
      } catch {
        /* ignore */
      }
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
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
        // keepalive is relevant for beacon-style close in the browser; Node
        // fetch ignores it silently.
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
      // Best-effort; don't throw.
      console.error('session-close POST failed', err);
    }

    this.costTracker.offChange(this.costListener);
    this.events.onEnd(payload);
  }

  private onMessage(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }

    switch (frame.type) {
      case 'audio': {
        if (typeof frame.data !== 'string') return;
        const pcm = base64ToPcm(frame.data);
        this.events.onAudio(pcm);
        return;
      }
      case 'input_transcription': {
        if (typeof frame.text !== 'string') return;
        const partial = frame.partial === true;
        this.events.onInputTranscript(frame.text, partial);
        if (!partial) {
          this.transcript.push({
            role: 'user',
            text: frame.text,
            ts: new Date().toISOString(),
          });
        }
        return;
      }
      case 'output_transcription': {
        if (typeof frame.text !== 'string') return;
        const partial = frame.partial === true;
        this.events.onOutputTranscript(frame.text, partial);
        if (!partial) {
          this.transcript.push({
            role: 'assistant',
            text: frame.text,
            ts: new Date().toISOString(),
          });
        }
        return;
      }
      case 'tool_call': {
        if (typeof frame.id !== 'string' || typeof frame.name !== 'string') return;
        void this.runToolCall({
          id: frame.id,
          name: frame.name,
          args: frame.args,
        });
        return;
      }
      case 'usage': {
        this.costTracker.addUsage({
          textIn: frame.textIn ?? 0,
          textOut: frame.textOut ?? 0,
          audioIn: frame.audioIn ?? 0,
          audioOut: frame.audioOut ?? 0,
        });
        return;
      }
      case 'server_end': {
        if (!this.stoppingPromise) {
          void this.stop('hard_cap');
        }
        return;
      }
      default:
        return;
    }
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
    this.wsSend({ type: 'tool_response', id: call.id, response });
  }

  private wsSend(obj: unknown): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      /* ignore; close handler drives shutdown */
    }
  }
}
