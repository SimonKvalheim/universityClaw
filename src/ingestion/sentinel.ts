import {
  existsSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { logger } from '../logger.js';

/**
 * Polls for a sentinel file. Returns true if found, false on timeout.
 * If an AbortSignal is provided and aborted, returns false immediately.
 */
export async function waitForSentinel(
  sentinelPath: string,
  timeoutMs: number,
  pollIntervalMs = 1000,
  signal?: AbortSignal,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return false;
    if (existsSync(sentinelPath)) return true;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return false;
}

/**
 * Writes the IPC _close sentinel to signal the container to exit.
 * Throws on failure so callers know the close signal was not delivered.
 */
export function sendIpcClose(ipcNamespace: string, dataDir: string): void {
  const closePath = join(
    dataDir,
    'ipc',
    'ingestion',
    ipcNamespace,
    'input',
    '_close',
  );
  writeFileSync(closePath, '', { flag: 'w' });
  logger.info({ ipcNamespace }, 'Sent IPC close sentinel');
}

/**
 * Sends a message to the container agent via IPC input.
 */
export function sendIpcMessage(
  ipcNamespace: string,
  dataDir: string,
  text: string,
): void {
  const inputDir = join(dataDir, 'ipc', 'ingestion', ipcNamespace, 'input');
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

/**
 * Removes all remaining files belonging to a draft bundle ({jobId}-*).
 * Called after promotion to clean up any leftover draft .md files.
 * promoteNote() moves promoted drafts via renameSync, but files may remain
 * if the manifest had concept_notes: [] or promotion partially failed.
 */
export function cleanupDraftBundle(draftsDir: string, jobId: string): void {
  let entries: string[];
  try {
    entries = readdirSync(draftsDir);
  } catch {
    return;
  }
  const prefix = `${jobId}-`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      unlinkSync(join(draftsDir, entry));
      logger.info({ jobId, file: entry }, 'Cleaned up leftover draft file');
    } catch {
      // Already deleted
    }
  }
}
