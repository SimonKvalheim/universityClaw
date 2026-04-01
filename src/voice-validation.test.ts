import { describe, it, expect } from 'vitest';

import {
  validateTtsText,
  validateTtsLanguage,
  TTS_MAX_TEXT_LENGTH,
} from './voice-validation.js';

describe('TTS validation', () => {
  describe('validateTtsText', () => {
    it('rejects empty text', () => {
      expect(validateTtsText('')).toBe('Text cannot be empty');
    });

    it('rejects whitespace-only text', () => {
      expect(validateTtsText('   ')).toBe('Text cannot be empty');
    });

    it('rejects text over max length', () => {
      const long = 'a'.repeat(TTS_MAX_TEXT_LENGTH + 1);
      expect(validateTtsText(long)).toMatch(/Text too long/);
    });

    it('accepts valid text', () => {
      expect(validateTtsText('Hello world')).toBeNull();
    });

    it('accepts text at exactly max length', () => {
      expect(validateTtsText('a'.repeat(TTS_MAX_TEXT_LENGTH))).toBeNull();
    });
  });

  describe('validateTtsLanguage', () => {
    it('accepts all supported languages', () => {
      for (const lang of [
        'en',
        'de',
        'it',
        'fr',
        'es',
        'pt',
        'nl',
        'ar',
        'hi',
      ]) {
        expect(validateTtsLanguage(lang)).toBeNull();
      }
    });

    it('rejects Norwegian (not supported for TTS)', () => {
      expect(validateTtsLanguage('no')).toMatch(/Unsupported language/);
    });

    it('rejects empty string', () => {
      expect(validateTtsLanguage('')).toMatch(/Unsupported language/);
    });

    it('rejects arbitrary strings', () => {
      expect(validateTtsLanguage('zh')).toMatch(/Unsupported language/);
    });
  });
});
