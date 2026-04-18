import { describe, it, expect } from 'vitest';
import { buildGeminiTtsRequest } from './gemini-tts-request.js';

describe('buildGeminiTtsRequest', () => {
  it('sends text unchanged when stylePrompt is omitted', () => {
    const body = buildGeminiTtsRequest({
      text: 'Hello world',
      voiceName: 'Kore',
    });
    expect(body.contents[0].parts[0].text).toBe('Hello world');
  });

  it('sends text unchanged when stylePrompt is an empty string', () => {
    const body = buildGeminiTtsRequest({
      text: 'Hello world',
      stylePrompt: '',
      voiceName: 'Kore',
    });
    expect(body.contents[0].parts[0].text).toBe('Hello world');
  });

  it('sends text unchanged when stylePrompt is whitespace only', () => {
    const body = buildGeminiTtsRequest({
      text: 'Hello world',
      stylePrompt: '   \t  ',
      voiceName: 'Kore',
    });
    expect(body.contents[0].parts[0].text).toBe('Hello world');
  });

  it('prepends a trimmed stylePrompt with a colon separator', () => {
    const body = buildGeminiTtsRequest({
      text: 'Hello world',
      stylePrompt: '  Say warmly and slowly  ',
      voiceName: 'Kore',
    });
    expect(body.contents[0].parts[0].text).toBe('Say warmly and slowly: Hello world');
  });

  it('requests AUDIO modality with the specified prebuilt voice', () => {
    const body = buildGeminiTtsRequest({ text: 'hi', voiceName: 'Charon' });
    expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(
      body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    ).toBe('Charon');
  });
});
