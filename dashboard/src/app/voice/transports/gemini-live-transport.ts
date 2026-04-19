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

// Preview model — rotate here when Google graduates the Live API.
const MODEL = 'gemini-3.1-flash-live-preview';

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

export interface GenaiClient {
  live: { connect: (params: GenaiConnectParams) => Promise<Session> };
}

export interface GeminiLiveTransportOptions {
  persona: PersonaConfig;
  tokenEndpoint?: string;
  /**
   * Test seam. When provided, replaces `new GoogleGenAI(...)` inside
   * `start()` so tests can inject a stub session. Not used in production.
   */
  genaiFactory?: (opts: {
    apiKey: string;
    httpOptions?: { apiVersion?: string };
  }) => GenaiClient;
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

// Gemini reports token counts split by modality under
// `promptTokensDetails[*]` and `responseTokensDetails[*]`. Sum the details
// rather than relying on the top-level totals, which don't split text/audio.
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
      ((args) => new GoogleGenAI(args) as unknown as GenaiClient);
  }

  async start(args: TransportStartArgs): Promise<TransportStartResult> {
    this.events = args.events;

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

    // Ephemeral tokens only work on v1alpha.
    const ai = this.genaiFactory({
      apiKey: token,
      httpOptions: { apiVersion: 'v1alpha' },
    });
    const session = await ai.live.connect({
      model: MODEL,
      callbacks: {
        onmessage: (msg) => this.onMessage(msg),
        onerror: () => {
          // The SDK normally follows onerror with onclose, but if the
          // transport aborts mid-handshake we may never see onclose.
          // Drive shutdown here too — close() is idempotent via this.closed.
          if (this.closed) return;
          this.closed = true;
          this.events?.onClose('drop');
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

    // Park the context in the prompt without forcing generation before
    // the user speaks (turnComplete:false).
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
    const responseObj: Record<string, unknown> =
      response && typeof response === 'object'
        ? (response as Record<string, unknown>)
        : { output: response };
    this.session.sendToolResponse({
      functionResponses: [{ id, name, response: responseObj }],
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
      const u = msg.usageMetadata;
      const hasDetails =
        (u.promptTokensDetails?.length ?? 0) > 0 ||
        (u.responseTokensDetails?.length ?? 0) > 0;
      if (hasDetails) {
        events.onUsage(usageMetadataToTokenUsage(u));
      }
    }

    if (msg.goAway && !this.closed) {
      this.closed = true;
      events.onClose('server_end');
    }
  }
}
