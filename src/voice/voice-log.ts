import fs from 'node:fs/promises';
import path from 'node:path';

export function createVoiceLogger(
  filePath: string,
): (record: Record<string, unknown>) => Promise<void> {
  let parentEnsured = false;

  return async (record: Record<string, unknown>): Promise<void> => {
    if (!parentEnsured) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      parentEnsured = true;
    }
    const entry = { ts: new Date().toISOString(), ...record };
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
  };
}
