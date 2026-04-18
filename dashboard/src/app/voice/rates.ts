// Gemini 3.1 Flash Live pricing.
// Source: https://ai.google.dev/gemini-api/docs/pricing
// Retrieved: 2026-04-18
// Update `asOf` and `version` when these change.

export interface Rates {
  textInPerM: number;
  textOutPerM: number;
  audioInPerM: number;
  audioOutPerM: number;
  asOf: string; // YYYY-MM-DD
  version: string; // short tag used by voice_sessions.rates_version
}

export const RATES: Rates = {
  textInPerM: 0.75,
  textOutPerM: 4.5,
  audioInPerM: 3.0,
  audioOutPerM: 12.0,
  asOf: '2026-04-18',
  version: 'gemini-31-flash-live-2026-04',
};

export interface TokenUsage {
  textIn: number;
  textOut: number;
  audioIn: number;
  audioOut: number;
}

export function computeCostUsd(usage: TokenUsage, rates: Rates): number {
  return (
    (usage.textIn / 1_000_000) * rates.textInPerM +
    (usage.textOut / 1_000_000) * rates.textOutPerM +
    (usage.audioIn / 1_000_000) * rates.audioInPerM +
    (usage.audioOut / 1_000_000) * rates.audioOutPerM
  );
}
