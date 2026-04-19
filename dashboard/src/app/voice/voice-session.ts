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
