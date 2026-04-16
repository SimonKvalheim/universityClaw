import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { synthesizeAudio } from './audio.js';

describe('synthesizeAudio', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-test-'));
    process.env.OPENAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes audio to the correct path and returns it on success', async () => {
    const audioData = new Uint8Array([0x49, 0x44, 0x33]).buffer; // fake MP3 bytes

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => audioData,
    }));

    const outputPath = path.join(tmpDir, 'test-output.mp3');
    const result = await synthesizeAudio('Hello world', outputPath);

    expect(result).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    const written = fs.readFileSync(outputPath);
    expect(written).toEqual(Buffer.from(audioData));
  });

  it('throws on API failure and does not leave a temp file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    }));

    const outputPath = path.join(tmpDir, 'fail-output.mp3');
    await expect(synthesizeAudio('test', outputPath)).rejects.toThrow('400');

    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(outputPath + '.tmp')).toBe(false);
  });

  it('calls the OpenAI TTS API with the correct arguments', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    vi.stubGlobal('fetch', mockFetch);

    const outputPath = path.join(tmpDir, 'args-check.mp3');
    await synthesizeAudio('Check me', outputPath);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test-key',
    );

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('tts-1');
    expect(body.input).toBe('Check me');
    expect(body.voice).toBe('alloy');
    expect(body.response_format).toBe('mp3');
  });
});
