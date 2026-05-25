import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class IpcTimeoutError extends Error {
  constructor(verb: string, timeoutMs: number) {
    super(`IPC request timeout after ${timeoutMs}ms (verb=${verb})`);
    this.name = 'IpcTimeoutError';
  }
}

type Opts = {
  responsesDir: string;
  timeoutMs?: number;
  pollMs?: number;
};

export async function writeIpcRequestAwaitResponse<T = unknown>(
  requestsDir: string,
  data: Record<string, unknown> & { type: string },
  opts: Opts,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 50;
  const requestId = randomUUID();
  fs.mkdirSync(requestsDir, { recursive: true });
  const filename = `${Date.now()}-${requestId.slice(0, 8)}.json`;
  const filepath = path.join(requestsDir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ ...data, requestId }, null, 2));
  fs.renameSync(tempPath, filepath);

  const responsePath = path.join(opts.responsesDir, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      const body = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as T;
      try { fs.unlinkSync(responsePath); } catch { /* ignore */ }
      return body;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new IpcTimeoutError(data.type, timeoutMs);
}
