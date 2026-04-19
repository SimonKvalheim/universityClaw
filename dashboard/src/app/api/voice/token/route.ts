import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'node:crypto';
import { voiceLog } from '../../../../lib/voice-logger';

function logFire(record: Record<string, unknown>): void {
  voiceLog(record).catch(() => {
    /* ignore — logging is best-effort, must never break the route */
  });
}

function isLoopback(host: string | null): boolean {
  if (!host) return false;
  // Strip the port. The host header is either "host", "host:port", "[ipv6]", or "[ipv6]:port".
  let h = host.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end >= 0 ? h.slice(1, end) : h;
  } else {
    h = h.split(':')[0];
  }
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// TODO(remove-after-migration): drop `google_api_key` fallback once
// feat/gemini-tts-stt-migration lands on main.
function getApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.google_api_key;
}

export async function POST(req: Request) {
  if (!isLoopback(req.headers.get('host'))) {
    return NextResponse.json(
      { error: 'voice endpoints are localhost-only' },
      { status: 403 },
    );
  }

  let body: { persona?: unknown; resumeHandle?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (body.persona !== 'dev') {
    return NextResponse.json(
      { error: 'persona required (only "dev" supported in v1)' },
      { status: 400 },
    );
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'GEMINI_API_KEY is not set' },
      { status: 500 },
    );
  }

  const voiceSessionId = randomUUID();

  try {
    const client = new GoogleGenAI({ apiKey });
    const token = await client.authTokens.create({
      config: {
        uses: 1,
        liveConnectConstraints: {
          model: 'gemini-3.1-flash-live-preview',
        },
        expireTime: new Date(Date.now() + 31 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
      },
    });
    logFire({
      event: 'session.start',
      voiceSessionId,
      persona: 'dev',
      model: 'gemini-3.1-flash-live-preview',
    });
    return NextResponse.json({
      token: token.name ?? '',
      voiceSessionId,
    });
  } catch (err) {
    logFire({
      event: 'error.token_mint',
      voiceSessionId,
      message: (err as Error).message,
    });
    return NextResponse.json(
      { error: 'token mint failed: ' + (err as Error).message },
      { status: 502 },
    );
  }
}
