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
      ((u: string) =>
        new (globalThis as { WebSocket: typeof WebSocket }).WebSocket(u));
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
        if (typeof frame.id !== 'string' || typeof frame.name !== 'string') {
          return;
        }
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
