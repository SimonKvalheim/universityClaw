import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MediaModality,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
import {
  GeminiLiveTransport,
  type GenaiConnectParams,
} from '../transports/gemini-live-transport';
import { DEV_PERSONA } from '../personas';
import type { TransportEvents } from '../transport';

interface SentRealtime {
  kind: 'realtime';
  audioB64: string;
  mimeType: string;
}
interface SentToolResponse {
  kind: 'toolResponse';
  id: string;
  name: string;
  response: unknown;
}
interface SentClientContent {
  kind: 'clientContent';
  text: string;
  turnComplete: boolean;
}
interface SentClose {
  kind: 'close';
}
type Sent = SentRealtime | SentToolResponse | SentClientContent | SentClose;

interface StubSession extends Session {
  sent: Sent[];
  emit: (msg: LiveServerMessage) => void;
  emitClose: () => void;
  _bind: (args: {
    onmessage: (msg: LiveServerMessage) => void;
    onclose?: () => void;
  }) => void;
}

function makeStubSession(): StubSession {
  const sent: Sent[] = [];
  let onmessage: (msg: LiveServerMessage) => void = () => {};
  let onclose: (() => void) | null = null;

  const stub = {
    sent,
    sendRealtimeInput: (p: {
      audio?: { data?: string; mimeType?: string };
    }) => {
      if (p.audio?.data && p.audio.mimeType) {
        sent.push({
          kind: 'realtime',
          audioB64: p.audio.data,
          mimeType: p.audio.mimeType,
        });
      }
    },
    sendToolResponse: (p: {
      functionResponses: Array<{
        id?: string;
        name?: string;
        response?: unknown;
      }>;
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

function makeTransport(
  stub: StubSession,
): {
  transport: GeminiLiveTransport;
  connect: ReturnType<typeof vi.fn>;
  factory: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn(async (params: GenaiConnectParams) => {
    stub._bind({
      onmessage: params.callbacks.onmessage,
      onclose: params.callbacks.onclose as (() => void) | undefined,
    });
    return stub;
  });
  const factory = vi.fn(() => ({ live: { connect } }));
  const transport = new GeminiLiveTransport({
    persona: DEV_PERSONA,
    genaiFactory: factory,
  });
  return { transport, connect, factory };
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

  it('connects with v1alpha + Zephyr + tools + transcription config, then parks context as clientContent', async () => {
    const stub = makeStubSession();
    const { transport, connect, factory } = makeTransport(stub);
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
    const params = connect.mock.calls[0][0] as GenaiConnectParams;
    expect(params.model).toBe('gemini-3.1-flash-live-preview');
    expect(params.config.systemInstruction).toBe(DEV_PERSONA.systemInstruction);
    expect(params.config.responseModalities).toEqual(['AUDIO']);
    expect(params.config.inputAudioTranscription).toEqual({});
    expect(params.config.outputAudioTranscription).toEqual({});
    expect(
      params.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    ).toBe('Zephyr');
    expect(params.config.tools[0].functionDeclarations).toBe(DEV_PERSONA.tools);

    const clientContent = stub.sent.find(
      (s): s is SentClientContent => s.kind === 'clientContent',
    );
    expect(clientContent).toBeDefined();
    expect(clientContent!.turnComplete).toBe(false);
    expect(clientContent!.text).toContain('hello');
  });

  it('translates inlineData audio frames into Int16Array audio events', async () => {
    const stub = makeStubSession();
    const { transport } = makeTransport(stub);
    const { events, log } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    stub.emit({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                data: Buffer.from(
                  new Uint8Array([0x01, 0x00, 0x02, 0x00]),
                ).toString('base64'),
                mimeType: 'audio/pcm;rate=24000',
              },
            },
          ],
        },
      },
    } as unknown as LiveServerMessage);

    expect(log).toContainEqual({ kind: 'audio', bytes: 4 });
  });

  it('maps input/output transcriptions with finished=false → partial=true', async () => {
    const stub = makeStubSession();
    const { transport } = makeTransport(stub);
    const { events, log } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    stub.emit({
      serverContent: {
        inputTranscription: { text: 'hel', finished: false },
      },
    } as unknown as LiveServerMessage);
    stub.emit({
      serverContent: {
        inputTranscription: { text: 'hello world', finished: true },
      },
    } as unknown as LiveServerMessage);
    stub.emit({
      serverContent: {
        outputTranscription: { text: 'hi', finished: false },
      },
    } as unknown as LiveServerMessage);
    stub.emit({
      serverContent: {
        outputTranscription: { text: 'hi there', finished: true },
      },
    } as unknown as LiveServerMessage);

    expect(log).toEqual([
      { kind: 'in', text: 'hel', partial: true },
      { kind: 'in', text: 'hello world', partial: false },
      { kind: 'out', text: 'hi', partial: true },
      { kind: 'out', text: 'hi there', partial: false },
    ]);
  });

  it('sums usageMetadata modality details into TokenUsage', async () => {
    const stub = makeStubSession();
    const { transport } = makeTransport(stub);
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
    } as unknown as LiveServerMessage);

    expect(log).toContainEqual({
      kind: 'usage',
      textIn: 100,
      textOut: 50,
      audioIn: 2000,
      audioOut: 3000,
    });
  });

  it('forwards toolCall.functionCalls to onToolCall and sends tool responses with id+name', async () => {
    const stub = makeStubSession();
    const { transport } = makeTransport(stub);
    const { events, log } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    stub.emit({
      toolCall: {
        functionCalls: [{ id: 'c1', name: 'read_file', args: { path: 'x' } }],
      },
    } as unknown as LiveServerMessage);

    expect(log).toContainEqual({
      kind: 'tool',
      id: 'c1',
      name: 'read_file',
      args: { path: 'x' },
    });

    transport.sendToolResponse('c1', 'read_file', { content: 'ok' });

    const tr = stub.sent.find(
      (s): s is SentToolResponse => s.kind === 'toolResponse',
    );
    expect(tr).toBeDefined();
    expect(tr!.id).toBe('c1');
    expect(tr!.name).toBe('read_file');
    expect(tr!.response).toEqual({ content: 'ok' });
  });

  it('wraps non-object tool responses in { output } so FunctionResponse.response stays an object', async () => {
    const stub = makeStubSession();
    const { transport } = makeTransport(stub);
    const { events } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    transport.sendToolResponse('c1', 'read_file', 'plain string result');

    const tr = stub.sent.find(
      (s): s is SentToolResponse => s.kind === 'toolResponse',
    );
    expect(tr!.response).toEqual({ output: 'plain string result' });
  });

  it('raises onClose("drop") when the session emits onclose unexpectedly', async () => {
    const stub = makeStubSession();
    const { transport } = makeTransport(stub);
    const { events, log } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    stub.emitClose();

    expect(log).toContainEqual({ kind: 'close', reason: 'drop' });
  });

  it('raises onClose("server_end") on goAway frames', async () => {
    const stub = makeStubSession();
    const { transport } = makeTransport(stub);
    const { events, log } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    stub.emit({ goAway: { timeLeft: '0s' } } as unknown as LiveServerMessage);

    expect(log).toContainEqual({ kind: 'close', reason: 'server_end' });
  });

  it('sends outgoing audio as base64 PCM at 16 kHz', async () => {
    const stub = makeStubSession();
    const { transport } = makeTransport(stub);
    const { events } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    transport.sendAudio(new Int16Array([1, 2, 3]));

    const rt = stub.sent.find((s): s is SentRealtime => s.kind === 'realtime');
    expect(rt).toBeDefined();
    expect(rt!.mimeType).toBe('audio/pcm;rate=16000');
    expect(Buffer.from(rt!.audioB64, 'base64').byteLength).toBe(6);
  });

  it('close() calls session.close() exactly once and no-ops on repeat', async () => {
    const stub = makeStubSession();
    const { transport } = makeTransport(stub);
    const { events } = makeEvents();
    await transport.start({ contextPayload: {}, events });

    await transport.close();
    await transport.close();

    const closes = stub.sent.filter((s) => s.kind === 'close');
    expect(closes).toHaveLength(1);
  });

  it('throws when token mint returns !ok', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: 'boom' }),
    })) as unknown as typeof globalThis.fetch;
    const stub = makeStubSession();
    const { transport } = makeTransport(stub);
    const { events } = makeEvents();

    await expect(
      transport.start({ contextPayload: {}, events }),
    ).rejects.toThrow(/Token mint failed: 502/);
  });
});
