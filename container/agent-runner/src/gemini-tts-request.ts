/**
 * Body builder for the Gemini generateContent TTS endpoint.
 *
 * Shapes the v1beta REST request body in camelCase, optionally prepending a
 * trimmed style prompt as "{stylePrompt}: {text}". Empty or whitespace-only
 * style prompts are treated as absent so callers don't need to pre-filter.
 */

export interface GeminiTtsRequestBody {
  contents: Array<{
    parts: Array<{ text: string }>;
  }>;
  generationConfig: {
    responseModalities: ['AUDIO'];
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: string;
        };
      };
    };
  };
}

export function buildGeminiTtsRequest(args: {
  text: string;
  stylePrompt?: string;
  voiceName: string;
}): GeminiTtsRequestBody {
  const { text, stylePrompt, voiceName } = args;

  const trimmedStyle = stylePrompt?.trim();
  const prompt = trimmedStyle ? `${trimmedStyle}: ${text}` : text;

  return {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName,
          },
        },
      },
    },
  };
}
