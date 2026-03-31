import { describe, it, expect } from 'vitest';

import {
  validateTtsText,
  validateTtsLanguage,
  resolveTtsVoice,
  TTS_MAX_TEXT_LENGTH,
  TTS_DEFAULT_VOICE,
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
    it('accepts en', () => {
      expect(validateTtsLanguage('en')).toBeNull();
    });

    it('accepts de', () => {
      expect(validateTtsLanguage('de')).toBeNull();
    });

    it('accepts it', () => {
      expect(validateTtsLanguage('it')).toBeNull();
    });

    it('rejects Norwegian (not supported for TTS)', () => {
      expect(validateTtsLanguage('no')).toMatch(/Unsupported language/);
    });

    it('rejects empty string', () => {
      expect(validateTtsLanguage('')).toMatch(/Unsupported language/);
    });

    it('rejects arbitrary strings', () => {
      expect(validateTtsLanguage('fr')).toMatch(/Unsupported language/);
    });
  });

  describe('resolveTtsVoice', () => {
    it('returns default voice when none specified', () => {
      expect(resolveTtsVoice()).toBe(TTS_DEFAULT_VOICE);
      expect(resolveTtsVoice(undefined)).toBe(TTS_DEFAULT_VOICE);
    });

    it('returns specified voice', () => {
      expect(resolveTtsVoice('alloy')).toBe('alloy');
    });

    it('does not return default for empty string', () => {
      expect(resolveTtsVoice('')).toBe(TTS_DEFAULT_VOICE);
    });
  });
});
