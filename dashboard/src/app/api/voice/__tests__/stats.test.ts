import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';

const REPO_ROOT = process.cwd().endsWith('/dashboard')
  ? path.resolve(process.cwd(), '..')
  : process.cwd();

process.env.STORE_DIR = path.join(REPO_ROOT, 'store');

import { GET } from '../stats/route';

const SID = 'stats-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

beforeAll(() => {
  // Seed a known row so today/month rollups are non-zero.
  const db = new Database(path.join(REPO_ROOT, 'store', 'messages.db'));
  db.prepare(
    `INSERT INTO voice_sessions (id, persona, started_at, ended_at, duration_seconds,
       text_tokens_in, text_tokens_out, audio_tokens_in, audio_tokens_out,
       cost_usd, rates_version, transcript_path, artifacts)
     VALUES (?, 'dev', ?, ?, 60, 0, 0, 0, 0, 1.23, 'test', NULL, '[]')`,
  ).run(SID, new Date().toISOString(), new Date().toISOString());
  db.close();
});

afterAll(() => {
  const db = new Database(path.join(REPO_ROOT, 'store', 'messages.db'));
  db.prepare('DELETE FROM voice_sessions WHERE id = ?').run(SID);
  db.close();
});

describe('GET /api/voice/stats', () => {
  it('returns 403 off loopback', async () => {
    const req = new Request('http://localhost:3100/api/voice/stats', {
      headers: { host: 'public.example.com' },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it('returns today and month totals plus optional budget', async () => {
    const req = new Request('http://localhost:3100/api/voice/stats', {
      headers: { host: 'localhost' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.todayUsd).toBe('number');
    expect(typeof body.monthUsd).toBe('number');
    expect(body.todayUsd).toBeGreaterThanOrEqual(1.23);
    expect(body.monthUsd).toBeGreaterThanOrEqual(1.23);
    expect(body.budgetUsd === null || typeof body.budgetUsd === 'number').toBe(true);
  });

  it('reads VOICE_MONTHLY_BUDGET_USD from env when set', async () => {
    const prev = process.env.VOICE_MONTHLY_BUDGET_USD;
    process.env.VOICE_MONTHLY_BUDGET_USD = '50';
    try {
      const req = new Request('http://localhost:3100/api/voice/stats', {
        headers: { host: 'localhost' },
      });
      const res = await GET(req);
      const body = await res.json();
      expect(body.budgetUsd).toBe(50);
    } finally {
      if (prev === undefined) delete process.env.VOICE_MONTHLY_BUDGET_USD;
      else process.env.VOICE_MONTHLY_BUDGET_USD = prev;
    }
  });
});
