import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { startFakeGemini, type FakeGemini } from './fake-gemini-server';
import { VoiceSession } from '../voice-session';
import { DEV_PERSONA } from '../personas';
import { FakeJsonTransport } from '../transports/fake-json-transport';

const wsFactory = (url: string) => new WsClient(url) as unknown as WebSocket;

function mockFetchSuccess() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
}

describe('VoiceSession', () => {
  let fake: FakeGemini;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    fake = await startFakeGemini();
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fake.close();
  });

  it('opens WS, accumulates cost on usage events, surfaces audio', async () => {
    globalThis.fetch = mockFetchSuccess() as unknown as typeof globalThis.fetch;

    const audio: Int16Array[] = [];
    let lastCost = 0;

    const session = new VoiceSession({
      persona: DEV_PERSONA,
      contextEndpoint: '/test/ctx',
      closeEndpoint: '/test/close',
      transport: new FakeJsonTransport({
        url: fake.url,
        persona: DEV_PERSONA,
        wsFactory,
      }),
      events: {
        onAudio: (pcm) => audio.push(pcm),
        onCost: (c) => {
          lastCost = c;
        },
        onInputTranscript: () => {},
        onOutputTranscript: () => {},
        onToolCall: async () => ({}),
        onEnd: () => {},
      },
    });

    await session.start();

    fake.sendUsage({
      textIn: 100_000,
      textOut: 200_000,
      audioIn: 1_000_000,
      audioOut: 1_000_000,
    });
    // Send two bytes of audio (one Int16 sample)
    fake.sendAssistantAudio(
      Buffer.from(new Uint8Array([0x01, 0x00])).toString('base64'),
    );

    await new Promise((r) => setTimeout(r, 80));
    expect(audio.length).toBeGreaterThan(0);
    expect(audio[0]).toBeInstanceOf(Int16Array);
    expect(lastCost).toBeGreaterThan(0);

    await session.stop('user_stop');
  }, 10_000);

  it('captures final transcripts only (ignores partials in buffer) and POSTs session-close with transcript', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    let endedPayload: unknown = null;

    const session = new VoiceSession({
      persona: DEV_PERSONA,
      contextEndpoint: '/test/ctx',
      closeEndpoint: '/test/close',
      transport: new FakeJsonTransport({
        url: fake.url,
        persona: DEV_PERSONA,
        wsFactory,
      }),
      events: {
        onAudio: () => {},
        onCost: () => {},
        onInputTranscript: () => {},
        onOutputTranscript: () => {},
        onToolCall: async () => ({}),
        onEnd: (p) => {
          endedPayload = p;
        },
      },
    });

    await session.start();

    fake.sendInputTranscription('hel', true); // partial → skip
    fake.sendInputTranscription('hello world', false); // final → buffer
    fake.sendOutputTranscription('hi the', true); // partial → skip
    fake.sendOutputTranscription('hi there', false); // final → buffer

    await new Promise((r) => setTimeout(r, 50));
    await session.stop('user_stop');

    expect(endedPayload).toBeTruthy();
    const payload = endedPayload as {
      transcript: Array<{ role: string; text: string }>;
    };
    expect(payload.transcript).toHaveLength(2);
    expect(payload.transcript[0]).toMatchObject({
      role: 'user',
      text: 'hello world',
    });
    expect(payload.transcript[1]).toMatchObject({
      role: 'assistant',
      text: 'hi there',
    });

    // session-close POSTed
    const closeCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes('/test/close'),
    );
    expect(closeCall).toBeDefined();
    const body = JSON.parse((closeCall![1] as RequestInit).body as string);
    expect(body.endReason).toBe('user_stop');
    expect(body.transcript).toHaveLength(2);
  }, 10_000);

  it('round-trips a tool call (receives call, returns response)', async () => {
    globalThis.fetch = mockFetchSuccess() as unknown as typeof globalThis.fetch;

    const session = new VoiceSession({
      persona: DEV_PERSONA,
      contextEndpoint: '/test/ctx',
      closeEndpoint: '/test/close',
      transport: new FakeJsonTransport({
        url: fake.url,
        persona: DEV_PERSONA,
        wsFactory,
      }),
      events: {
        onAudio: () => {},
        onCost: () => {},
        onInputTranscript: () => {},
        onOutputTranscript: () => {},
        onToolCall: async (c) => ({ ok: true, echoed: c.name }),
        onEnd: () => {},
      },
    });

    await session.start();

    fake.sendToolCall({
      id: 'call-42',
      name: 'read_file',
      args: { path: 'package.json' },
    });

    const response = await fake.waitForToolResponse('call-42');
    expect(response).toEqual({ ok: true, echoed: 'read_file' });

    await session.stop('user_stop');
  }, 10_000);

  it('fires onEnd with ws_drop when the server terminates unexpectedly', async () => {
    globalThis.fetch = mockFetchSuccess() as unknown as typeof globalThis.fetch;

    let ended: { endReason?: string } = {};

    const session = new VoiceSession({
      persona: DEV_PERSONA,
      contextEndpoint: '/test/ctx',
      closeEndpoint: '/test/close',
      transport: new FakeJsonTransport({
        url: fake.url,
        persona: DEV_PERSONA,
        wsFactory,
      }),
      events: {
        onAudio: () => {},
        onCost: () => {},
        onInputTranscript: () => {},
        onOutputTranscript: () => {},
        onToolCall: async () => ({}),
        onEnd: (p) => {
          ended = p as { endReason?: string };
        },
      },
    });

    await session.start();
    fake.terminate(); // server closes WS unilaterally

    await new Promise((r) => setTimeout(r, 200));
    expect(ended.endReason === 'hard_cap' || ended.endReason === 'ws_drop').toBe(
      true,
    );
  }, 10_000);
});
