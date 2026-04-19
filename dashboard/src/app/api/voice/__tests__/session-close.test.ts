import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Set STORE_DIR BEFORE the route imports getDb(), so getDb resolves
// <repoRoot>/store/messages.db under vitest (cwd == repoRoot).
const REPO_ROOT = process.cwd().endsWith('/dashboard')
  ? path.resolve(process.cwd(), '..')
  : process.cwd();

process.env.STORE_DIR = path.join(REPO_ROOT, 'store');

import { POST } from '../session-close/route';

const cleanupIds: string[] = [];
const cleanupFiles: string[] = [];

afterAll(() => {
  const db = new Database(path.join(REPO_ROOT, 'store', 'messages.db'));
  for (const sid of cleanupIds) {
    db.prepare('DELETE FROM voice_sessions WHERE id = ?').run(sid);
  }
  db.close();
  for (const f of cleanupFiles) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
});

function newSid(): string {
  const sid = 'test-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now();
  cleanupIds.push(sid);
  return sid;
}

async function close(body: unknown, host = 'localhost:3100') {
  const req = new Request('http://localhost:3100/api/voice/session-close', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}

describe('POST /api/voice/session-close', () => {
  it('returns 403 off loopback', async () => {
    const res = await close({}, 'public.example.com');
    expect(res.status).toBe(403);
  });

  it('returns 400 on missing voiceSessionId', async () => {
    const res = await close({ persona: 'dev' });
    expect(res.status).toBe(400);
  });

  it('persists transcript file + session row', async () => {
    const sid = newSid();
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const endedAt   = new Date().toISOString();
    const { status, body } = await close({
      voiceSessionId: sid,
      persona: 'dev',
      startedAt,
      endedAt,
      transcript: [
        { role: 'user', text: 'hi', ts: startedAt },
        { role: 'assistant', text: 'hello there', ts: endedAt },
      ],
      usage: { textIn: 1000, textOut: 2000, audioIn: 50_000, audioOut: 100_000 },
      artifacts: [],
      endReason: 'user_stop',
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.transcriptPath).toMatch(/brainstorm-sessions/);
    expect(typeof body.costUsd).toBe('number');

    const absPath = path.join(REPO_ROOT, body.transcriptPath);
    cleanupFiles.push(absPath);
    expect(existsSync(absPath)).toBe(true);

    const md = readFileSync(absPath, 'utf8');
    expect(md).toContain('## User');
    expect(md).toContain('> hi');
    expect(md).toContain('## Assistant');
    expect(md).toContain('hello there');
    expect(md).toContain(`voiceSessionId: ${sid}`);

    const db = new Database(path.join(REPO_ROOT, 'store', 'messages.db'));
    const row = db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(sid) as {
      id: string;
      persona: string;
      duration_seconds: number;
      cost_usd: number;
      rates_version: string;
      transcript_path: string | null;
      artifacts: string | null;
    };
    db.close();
    expect(row.persona).toBe('dev');
    expect(row.duration_seconds).toBeGreaterThan(0);
    expect(row.cost_usd).toBeGreaterThanOrEqual(0);
    expect(row.rates_version).toBeTruthy();
    expect(row.transcript_path).toBe(body.transcriptPath);
  });

  it('skips transcript file when transcript is empty (but still inserts session row)', async () => {
    const sid = newSid();
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const endedAt   = new Date().toISOString();
    const { body } = await close({
      voiceSessionId: sid,
      persona: 'dev',
      startedAt,
      endedAt,
      transcript: [],
      usage: { textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 },
      artifacts: [],
      endReason: 'ws_drop',
    });
    expect(body.ok).toBe(true);
    expect(body.transcriptPath).toBeNull();
    expect(body.costUsd).toBe(0);

    const db = new Database(path.join(REPO_ROOT, 'store', 'messages.db'));
    const row = db.prepare('SELECT transcript_path FROM voice_sessions WHERE id = ?').get(sid) as { transcript_path: string | null };
    db.close();
    expect(row.transcript_path).toBeNull();
  });

  it('stores artifacts as JSON array', async () => {
    const sid = newSid();
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const endedAt   = new Date().toISOString();
    const artifacts = ['docs/superpowers/mockups/2026-04-18-foo.html'];
    const { body } = await close({
      voiceSessionId: sid,
      persona: 'dev',
      startedAt,
      endedAt,
      transcript: [],
      usage: { textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 },
      artifacts,
      endReason: 'user_stop',
    });
    expect(body.ok).toBe(true);

    const db = new Database(path.join(REPO_ROOT, 'store', 'messages.db'));
    const row = db.prepare('SELECT artifacts FROM voice_sessions WHERE id = ?').get(sid) as { artifacts: string | null };
    db.close();
    expect(row.artifacts).toBeTruthy();
    expect(JSON.parse(row.artifacts!)).toEqual(artifacts);
  });
});
