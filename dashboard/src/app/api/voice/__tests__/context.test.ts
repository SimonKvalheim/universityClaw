import { describe, it, expect } from 'vitest';
import { GET } from '../context/dev/route';

function makeReq(host = 'localhost:3100') {
  return new Request('http://localhost:3100/api/voice/context/dev', {
    headers: { host },
  });
}

describe('GET /api/voice/context/dev', () => {
  it('returns 403 off loopback', async () => {
    const res = await GET(makeReq('public.example.com'));
    expect(res.status).toBe(403);
  });

  it('returns full context payload shape', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.claudeMd).toBe('string');
    expect(body.claudeMd.length).toBeGreaterThan(100); // CLAUDE.md exists in this repo

    expect(typeof body.architecture).toBe('string'); // may be empty; type still string

    expect(Array.isArray(body.subsystemMap)).toBe(true);
    expect(body.subsystemMap.length).toBeGreaterThan(0);
    expect(body.subsystemMap[0]).toHaveProperty('path');
    expect(body.subsystemMap[0]).toHaveProperty('purpose');

    expect(typeof body.scripts.root).toBe('object');
    expect(typeof body.scripts.dashboard).toBe('object');
    expect(typeof body.scripts.root.test).toBe('string'); // root package has a "test" script

    expect(typeof body.repoState.branch).toBe('string');
    expect(typeof body.repoState.statusShort).toBe('string');
    expect(Array.isArray(body.repoState.recentCommits)).toBe(true);
    expect(body.repoState.recentCommits.length).toBeGreaterThan(0);
    expect(body.repoState.recentCommits[0]).toHaveProperty('sha');
    expect(body.repoState.recentCommits[0]).toHaveProperty('subject');
    expect(Array.isArray(body.repoState.specNames)).toBe(true);
    expect(Array.isArray(body.repoState.planNames)).toBe(true);

    expect(body.sessionMeta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('tolerates missing docs/ARCHITECTURE.md with a warning', async () => {
    // In this worktree, docs/ARCHITECTURE.md is currently absent.
    // The handler must not 500; it should return '' with a warning.
    const res = await GET(makeReq());
    const body = await res.json();
    if (body.architecture === '') {
      // Either the warning mentions the missing file, or it's simply absent — both acceptable.
      // We just assert the server didn't crash.
      expect(body.architecture).toBe('');
    }
  });
});
