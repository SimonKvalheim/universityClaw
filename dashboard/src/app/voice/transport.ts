import type { PersonaConfig } from './personas';
import type { TokenUsage } from './rates';

export interface TransportEvents {
  onAudio: (pcm: Int16Array) => void;
  onInputTranscript: (text: string, partial: boolean) => void;
  onOutputTranscript: (text: string, partial: boolean) => void;
  onToolCall: (call: { id: string; name: string; args: unknown }) => void;
  onUsage: (usage: TokenUsage) => void;
  onClose: (reason: 'server_end' | 'drop') => void;
}

export interface TransportStartArgs {
  contextPayload: unknown;
  events: TransportEvents;
}

export interface TransportStartResult {
  voiceSessionId: string;
}

export interface Transport {
  readonly persona: PersonaConfig;
  start(args: TransportStartArgs): Promise<TransportStartResult>;
  sendAudio(pcm: Int16Array): void;
  sendToolResponse(id: string, name: string, response: unknown): void;
  close(): Promise<void>;
}
