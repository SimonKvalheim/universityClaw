import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

/**
 * Polls for a sentinel file. Returns true if found, false on timeout.
 */
export async function waitForSentinel(
  sentinelPath: string,
  timeoutMs: number,
  pollIntervalMs = 1000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(sentinelPath)) return true;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return false;
}

/**
 * Writes the IPC _close sentinel to signal the container to exit.
 */
export function sendIpcClose(ipcNamespace: string, _dataDir?: string): void {
  const closePath = join(
    DATA_DIR,
    'ipc',
    'ingestion',
    ipcNamespace,
    'input',
    '_close',
  );
  try {
    writeFileSync(closePath, '', { flag: 'w' });
    logger.info({ ipcNamespace }, 'Sent IPC close sentinel');
  } catch (err) {
    logger.warn({ ipcNamespace, err }, 'Failed to send IPC close sentinel');
  }
}

/**
 * Sends a message to the container agent via IPC input.
 */
export function sendIpcMessage(
  ipcNamespace: string,
  _dataDir: string,
  text: string,
): void {
  const inputDir = join(DATA_DIR, 'ipc', 'ingestion', ipcNamespace, 'input');
  try {
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(
      join(inputDir, `${Date.now()}.json`),
      JSON.stringify({ type: 'message', text }),
    );
    logger.info({ ipcNamespace }, 'Sent IPC message to agent');
  } catch (err) {
    logger.warn({ ipcNamespace, err }, 'Failed to send IPC message');
  }
}

/**
 * Cleans up sentinel and manifest files after promotion.
 */
export function cleanupSentinel(draftsDir: string, jobId: string): void {
  const files = [
    join(draftsDir, `${jobId}-complete`),
    join(draftsDir, `${jobId}-manifest.json`),
  ];
  for (const f of files) {
    try {
      unlinkSync(f);
    } catch {
      // Already deleted or never existed
    }
  }
}
