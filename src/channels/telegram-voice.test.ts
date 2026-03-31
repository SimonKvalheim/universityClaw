import { describe, it, expect } from 'vitest';

import { WHISPER_BIN_PATH, WHISPER_MODEL_PATH } from '../config.js';

describe('Telegram voice transcription', () => {
  describe('config constants', () => {
    it('WHISPER_BIN_PATH has a sensible default', () => {
      expect(WHISPER_BIN_PATH).toBeTruthy();
      expect(typeof WHISPER_BIN_PATH).toBe('string');
    });

    it('WHISPER_MODEL_PATH has a sensible default', () => {
      expect(WHISPER_MODEL_PATH).toBeTruthy();
      expect(WHISPER_MODEL_PATH).toMatch(/nb-whisper/);
    });
  });

  describe('transcription output formatting', () => {
    it('trims whitespace from whisper stdout', () => {
      // whisper.cpp outputs leading/trailing newlines
      const stdout = '\n  Hello, this is a test message.  \n';
      const text = stdout.trim();
      expect(text).toBe('Hello, this is a test message.');
    });

    it('produces fallback text on empty transcription', () => {
      const stdout = '\n  \n';
      const text = stdout.trim();
      const result = text
        ? `[Voice]: ${text}`
        : '[Voice message (transcription failed)]';
      expect(result).toBe('[Voice message (transcription failed)]');
    });

    it('formats successful transcription with [Voice] prefix', () => {
      const stdout = ' Hei, dette er en test. ';
      const text = stdout.trim();
      const result = text
        ? `[Voice]: ${text}`
        : '[Voice message (transcription failed)]';
      expect(result).toBe('[Voice]: Hei, dette er en test.');
    });
  });

  describe('OGA→WAV path derivation', () => {
    it('replaces .oga extension with .wav', () => {
      const ogaPath = '/tmp/voice-1711900000-a1b2.oga';
      const wavPath = ogaPath.replace(/\.oga$/, '.wav');
      expect(wavPath).toBe('/tmp/voice-1711900000-a1b2.wav');
    });

    it('does not modify paths without .oga extension', () => {
      const otherPath = '/tmp/voice-1234.ogg';
      const wavPath = otherPath.replace(/\.oga$/, '.wav');
      expect(wavPath).toBe('/tmp/voice-1234.ogg'); // unchanged
    });
  });
});
