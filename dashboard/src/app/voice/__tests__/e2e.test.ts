import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { WebSocket as WsClient } from 'ws';

const REPO_ROOT = process.cwd().endsWith('/dashboard')
  ? path.resolve(process.cwd(), '..')
  : process.cwd();

process.env.STORE_DIR = path.join(REPO_ROOT, 'store');

import { startFakeGemini, type FakeGemini } from './fake-gemini-server';
import { VoiceSession } from '../voice-session';
import { DEV_PERSONA } from '../personas';

import { POST as tokenPOST } from '../../api/voice/token/route';
import { GET as contextGET } from '../../api/voice/context/dev/route';
import { POST as toolsPOST } from '../../api/voice/tools/dev/[tool]/route';
import { POST as sessionClosePOST } from '../../api/voice/session-close/route';

const wsFactory = (url: string) => new WsClient(url) as unknown as WebSocket;

const UNIQUE_SLUG = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function cleanupArtifacts() {
  const dirs = [
    path.join(REPO_ROOT, 'docs', 'superpowers', 'specs'),
    path.join(REPO_ROOT, 'docs', 'superpowers', 'plans'),
    path.join(REPO_ROOT, 'docs', 'superpowers', 'mockups'),
    path.join(REPO_ROOT, 'docs', 'superpowers', 'brainstorm-sessions'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.includes(UNIQUE_SLUG)) {
        rmSync(path.join(dir, name), { force: true });
      }
    }
  }
}

function cleanupSessions(sids: string[]) {
  if (sids.length === 0) return;
  const db = new Database(path.join(REPO_ROOT, 'store', 'messages.db'));
  for (const sid of sids) {
    db.prepare('DELETE FROM voice_sessions WHERE id = ?').run(sid);
  }
  db.close();
}

/**
 * Dispatches fetch() calls to the real Next.js route handlers based on URL
 * path. This keeps the e2e test in-process — no Next.js dev server required.
 */
function makeRoutedFetch() {
  const spies = {
    tool: vi.fn(),
    close: vi.fn(),
  };

  const routed: typeof fetch = async (input, init) => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const url = new URL(rawUrl, 'http://localhost:3100');
    const pathname = url.pathname;
    const host = (init?.headers as Record<string, string> | undefined)?.host ?? 'localhost';

    const mkReq = (body?: string): Request => {
      return new Request(url.toString(), {
        method: init?.method ?? 'GET',
        headers: { host, 'content-type': 'application/json' },
        body,
      });
    };

    if (pathname === '/api/voice/token' && init?.method === 'POST') {
      return tokenPOST(mkReq(init.body as string));
    }
    if (pathname === '/api/voice/context/dev') {
      return contextGET(mkReq());
    }
    if (pathname.startsWith('/api/voice/tools/dev/')) {
      const tool = pathname.slice('/api/voice/tools/dev/'.length);
      spies.tool(tool, init?.body);
      return toolsPOST(mkReq(init?.body as string), {
        params: Promise.resolve({ tool }),
      });
    }
    if (pathname === '/api/voice/session-close' && init?.method === 'POST') {
      spies.close(init?.body);
      return sessionClosePOST(mkReq(init.body as string));
    }
    throw new Error('routedFetch: unmatched ' + pathname);
  };

  return { routed, spies };
}

describe('VoiceSession e2e against fake server + real route handlers', () => {
  let fake: FakeGemini;
  let originalFetch: typeof globalThis.fetch;
  const sids: string[] = [];

  beforeAll(() => {
    // Guarantee the token endpoint has an API key even if tests nuked it.
    if (!process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = 'e2e-test-key';
  });

  beforeEach(async () => {
    fake = await startFakeGemini();
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fake.close();
  });

  afterAll(() => {
    cleanupArtifacts();
    cleanupSessions(sids);
  });

  it('runs a full session: context → usage → write_spec tool → session-close', async () => {
    const { routed, spies } = makeRoutedFetch();
    globalThis.fetch = routed;

    // Pre-mock @google/genai so the token route doesn't need a real key
    vi.doMock('@google/genai', () => ({
      GoogleGenAI: class {
        authTokens = {
          create: async () => ({ name: 'tokens/e2e' }),
        };
      },
    }));

    let endCost = 0;

    const session = new VoiceSession({
      persona: DEV_PERSONA,
      liveApiUrl: fake.url,
      wsFactory,
      events: {
        onInputTranscript: () => {},
        onOutputTranscript: () => {},
        onAudio: () => {},
        onCost: (c) => {
          endCost = c;
        },
        onToolCall: async (call) => {
          // Route the tool call through the real dispatcher.
          const res = await fetch(`/api/voice/tools/dev/${call.name}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(call.args ?? {}),
          });
          return await res.json();
        },
        onEnd: () => {
          // VoiceSession generates its own sid when liveApiUrl is set.
          // Fish it out of the session-close POST body instead.
        },
      },
    });

    await session.start();
    fake.sendUsage({ textIn: 500, textOut: 1000, audioIn: 10_000, audioOut: 20_000 });

    // Drive a write_spec tool call from the fake server, round-trip through
    // the real dispatcher.
    fake.sendToolCall({
      id: 'call-1',
      name: 'write_spec',
      args: { slug: UNIQUE_SLUG, content: '# E2E\n\nhello' },
    });
    const toolRes = await fake.waitForToolResponse('call-1');
    expect(toolRes).toMatchObject({ path: expect.stringMatching(new RegExp(`docs/superpowers/specs/\\d{4}-\\d{2}-\\d{2}-${UNIQUE_SLUG}\\.md`)) });

    await new Promise((r) => setTimeout(r, 80));
    await session.stop('user_stop');

    expect(endCost).toBeGreaterThan(0);

    // session-close was POSTed.
    expect(spies.close).toHaveBeenCalledTimes(1);
    const closeBody = JSON.parse(spies.close.mock.calls[0][0]);
    const sid: string = closeBody.voiceSessionId;
    sids.push(sid);

    // DB row exists with the right sid and a positive cost.
    const db = new Database(path.join(REPO_ROOT, 'store', 'messages.db'));
    const row = db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(sid) as
      | { cost_usd: number; artifacts: string | null }
      | undefined;
    db.close();
    expect(row).toBeDefined();
    expect(row!.cost_usd).toBeGreaterThan(0);
  }, 15_000);
});
