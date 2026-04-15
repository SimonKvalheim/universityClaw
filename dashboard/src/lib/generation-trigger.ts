import fs from 'fs';
import path from 'path';

const projectRoot = path.join(process.cwd(), '..');

function ipcTaskDir(): string {
  return path.join(projectRoot, 'data', 'ipc', 'study-generator', 'tasks');
}

function uniqueFilename(prefix: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}.json`;
}

export function requestGeneration(conceptId: string, bloomLevel: number): void {
  const dir = ipcTaskDir();
  fs.mkdirSync(dir, { recursive: true });
  const payload = { type: 'study_generation_request', conceptId, bloomLevel };
  const filename = uniqueFilename(`study_generation_request-${conceptId}`);
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload));
}

export function requestPostSessionGeneration(sessionId: string): void {
  const dir = ipcTaskDir();
  fs.mkdirSync(dir, { recursive: true });
  const payload = { type: 'study_post_session_generation', sessionId };
  const filename = uniqueFilename(`study_post_session_generation-${sessionId}`);
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload));
}
