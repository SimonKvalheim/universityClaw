import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  waitForSentinel,
  sendIpcClose,
  sendIpcMessage,
} from './sentinel.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/sentinel');

describe('waitForSentinel', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  it('resolves true when sentinel file appears', async () => {
    const sentinelPath = join(TMP, 'job1-complete');

    // Write sentinel after 100ms
    setTimeout(() => writeFileSync(sentinelPath, ''), 100);

    const result = await waitForSentinel(sentinelPath, 5000, 50);
    expect(result).toBe(true);
  });

  it('resolves false on timeout', async () => {
    const sentinelPath = join(TMP, 'nonexistent-complete');

    const result = await waitForSentinel(sentinelPath, 200, 50);
    expect(result).toBe(false);
  });
});

describe('sendIpcClose', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  it('writes _close sentinel file using the provided dataDir', () => {
    const ns = 'test-job';
    const inputDir = join(TMP, 'ipc', 'ingestion', ns, 'input');
    mkdirSync(inputDir, { recursive: true });

    sendIpcClose(ns, TMP);

    expect(existsSync(join(inputDir, '_close'))).toBe(true);
  });

  it('throws when the directory does not exist', () => {
    expect(() => sendIpcClose('nope', join(TMP, 'no-such-dir'))).toThrow();
  });
});

describe('sendIpcMessage', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  it('writes a JSON message file using the provided dataDir', () => {
    const ns = 'test-job';
    sendIpcMessage(ns, TMP, 'hello agent');

    const inputDir = join(TMP, 'ipc', 'ingestion', ns, 'input');
    expect(existsSync(inputDir)).toBe(true);

    const files = require('fs')
      .readdirSync(inputDir)
      .filter((f: string) => f.endsWith('.json'));
    expect(files).toHaveLength(1);

    const content = JSON.parse(readFileSync(join(inputDir, files[0]), 'utf-8'));
    expect(content).toEqual({ type: 'message', text: 'hello agent' });
  });
});
