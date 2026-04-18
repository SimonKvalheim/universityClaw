import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../token/route';

// Mock @google/genai — the real SDK is only used at runtime.
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    authTokens = {
      create: vi.fn().mockResolvedValue({ name: 'tokens/fake-ephemeral' }),
    };
  },
}));

function makeReq(body: unknown, host = 'localhost:3100') {
  return new Request('http://localhost:3100/api/voice/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host },
    body: JSON.stringify(body),
  });
}

describe('POST /api/voice/token', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.google_api_key;
  });

  it('returns 400 when persona missing', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 when persona is not "dev"', async () => {
    const res = await POST(makeReq({ persona: 'teacher' }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when host is not loopback', async () => {
    const res = await POST(makeReq({ persona: 'dev' }, 'public.example.com'));
    expect(res.status).toBe(403);
  });

  it('returns 500 when no API key is set', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.google_api_key;
    const res = await POST(makeReq({ persona: 'dev' }));
    expect(res.status).toBe(500);
  });

  it('falls back to lowercase google_api_key when GEMINI_API_KEY is absent', async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.google_api_key = 'legacy-lowercase-key';
    const res = await POST(makeReq({ persona: 'dev' }));
    expect(res.status).toBe(200);
  });

  it('returns an ephemeral token + voiceSessionId on success', async () => {
    const res = await POST(makeReq({ persona: 'dev' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.voiceSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts (and ignores) resumeHandle in v1', async () => {
    const res = await POST(makeReq({ persona: 'dev', resumeHandle: 'abc' }));
    expect(res.status).toBe(200);
  });

  it('treats 127.0.0.1 as loopback', async () => {
    const res = await POST(makeReq({ persona: 'dev' }, '127.0.0.1:3100'));
    expect(res.status).toBe(200);
  });
});
