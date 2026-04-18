import fs from 'fs';
import path from 'path';

const projectRoot = path.join(process.cwd(), '..');

function ipcTaskDir(): string {
  return path.join(projectRoot, 'data', 'ipc', 'study-generator', 'tasks');
}

// IDs are interpolated into filenames, so anything outside a safe charset
// must be stripped to prevent path traversal (../, /, etc.).
function safeIdSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
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
  const filename = uniqueFilename(`study_generation_request-${safeIdSegment(conceptId)}`);
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload));
}

export function requestPostSessionGeneration(sessionId: string): void {
  const dir = ipcTaskDir();
  fs.mkdirSync(dir, { recursive: true });
  const payload = { type: 'study_post_session_generation', sessionId };
  const filename = uniqueFilename(`study_post_session_generation-${safeIdSegment(sessionId)}`);
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload));
}
