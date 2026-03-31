export const TTS_MAX_TEXT_LENGTH = 5000;
export const TTS_VALID_LANGUAGES = ['en', 'de', 'it'] as const;
export type TtsLanguage = (typeof TTS_VALID_LANGUAGES)[number];
export const TTS_DEFAULT_VOICE = 'neutral_female';

export function validateTtsText(text: string): string | null {
  if (!text || text.trim().length === 0) return 'Text cannot be empty';
  if (text.length > TTS_MAX_TEXT_LENGTH)
    return `Text too long (${text.length} chars, max ${TTS_MAX_TEXT_LENGTH})`;
  return null;
}

export function validateTtsLanguage(lang: string): string | null {
  if (!(TTS_VALID_LANGUAGES as readonly string[]).includes(lang))
    return `Unsupported language "${lang}". Supported: ${TTS_VALID_LANGUAGES.join(', ')}`;
  return null;
}

export function resolveTtsVoice(voice?: string): string {
  return voice || TTS_DEFAULT_VOICE;
}
