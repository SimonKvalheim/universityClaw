import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeIpcRequestAwaitResponse } from './ipc-helpers.js';

let base: string;
let tasksDir: string;
let responsesDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ipc-helpers-'));
  tasksDir = join(base, 'tasks');
  responsesDir = join(base, 'responses');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(responsesDir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('writeIpcRequestAwaitResponse', () => {
  it('returns the parsed response when the file appears', async () => {
    const responsePromise = writeIpcRequestAwaitResponse(
      tasksDir,
      { type: 'record_concept_delivery', concept: 'concepts/foo.md' },
      { responsesDir, timeoutMs: 2000, pollMs: 20 },
    );

    // Simulate the host writing a response after a short delay.
    setTimeout(() => {
      const files = readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
      const data = JSON.parse(readFileSync(join(tasksDir, files[0]), 'utf-8'));
      writeFileSync(
        join(responsesDir, `${data.requestId}.json`),
        JSON.stringify({ ok: true, conceptId: 'c1', title: 'Foo' }),
      );
    }, 30);

    const response = await responsePromise;
    expect(response).toEqual({ ok: true, conceptId: 'c1', title: 'Foo' });
  });

  it('throws IpcTimeoutError if no response appears within timeout', async () => {
    await expect(
      writeIpcRequestAwaitResponse(
        tasksDir,
        { type: 'anything' },
        { responsesDir, timeoutMs: 100, pollMs: 20 },
      ),
    ).rejects.toThrow(/timeout/i);
  });

  it('cleans up the response file after reading', async () => {
    const responsePromise = writeIpcRequestAwaitResponse(
      tasksDir,
      { type: 'x' },
      { responsesDir, timeoutMs: 2000, pollMs: 20 },
    );
    setTimeout(() => {
      const files = readdirSync(tasksDir);
      const data = JSON.parse(readFileSync(join(tasksDir, files[0]), 'utf-8'));
      writeFileSync(
        join(responsesDir, `${data.requestId}.json`),
        JSON.stringify({ ok: true }),
      );
    }, 30);
    await responsePromise;
    // Give the helper a tick to unlink.
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(responsesDir)).toEqual([]);
  });
});
