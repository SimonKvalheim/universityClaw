import path from 'node:path';
import { createVoiceLogger } from '../../../src/voice/voice-log';

type Logger = (record: Record<string, unknown>) => Promise<void>;

let _logger: Logger | null = null;

function getRepoRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith(path.sep + 'dashboard') || cwd.endsWith('/dashboard')
    ? path.resolve(cwd, '..')
    : cwd;
}

/** Append-only JSON-lines logger for voice events. Lazily created on first call.
 *  Errors propagate — callers fire-and-forget with `.catch()` if they prefer. */
export function voiceLog(record: Record<string, unknown>): Promise<void> {
  if (!_logger) {
    _logger = createVoiceLogger(path.join(getRepoRoot(), 'data', 'voice.log'));
  }
  return _logger(record);
}
