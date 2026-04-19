import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createVoiceLogger } from '../voice-log.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'voice-log-'));
});

describe('voice-log', () => {
  it('writes one JSON line per event', async () => {
    const log = createVoiceLogger(path.join(dir, 'voice.log'));
    await log({
      event: 'session.start',
      voiceSessionId: 'abc',
      persona: 'dev',
    });
    await log({ event: 'tool.call', voiceSessionId: 'abc', tool: 'read_file' });
    const body = await readFile(path.join(dir, 'voice.log'), 'utf8');
    const lines = body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      event: 'session.start',
      voiceSessionId: 'abc',
    });
    expect(lines[0].ts).toBeDefined();
  });

  it('includes a timestamp', async () => {
    const log = createVoiceLogger(path.join(dir, 'voice.log'));
    await log({ event: 'session.end', voiceSessionId: 'x' });
    const body = await readFile(path.join(dir, 'voice.log'), 'utf8');
    const line = JSON.parse(body.trim());
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
