import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileWatcher } from './file-watcher.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('FileWatcher', () => {
  let tmpDir: string;
  let watcher: FileWatcher;
  let detectedFiles: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'file-watcher-test-'));
    detectedFiles = [];
    watcher = new FileWatcher(tmpDir, (filePath) => {
      detectedFiles.push(filePath);
    });
    await watcher.start();
    await wait(200);
  });

  afterEach(async () => {
    await watcher.stop();
  });

  it('detects new PDF files', async () => {
    const filePath = join(tmpDir, 'document.pdf');
    await writeFile(filePath, 'PDF content');
    await wait(2000);

    expect(detectedFiles).toContain(filePath);
  });

  it('detects PDFs in nested directories', async () => {
    const nestedDir = join(tmpDir, 'subdir');
    await mkdir(nestedDir, { recursive: true });
    const filePath = join(nestedDir, 'paper.pdf');
    await writeFile(filePath, 'PDF content');
    await wait(2000);

    expect(detectedFiles).toContain(filePath);
  });

  it('ignores non-PDF file types', async () => {
    const files = ['file.docx', 'file.pptx', 'file.txt', 'file.md', 'file.png', 'file.csv'];
    for (const name of files) {
      await writeFile(join(tmpDir, name), 'content');
    }
    await wait(2000);

    expect(detectedFiles).toHaveLength(0);
  });

  it('ignores ~$ temp files', async () => {
    const filePath = join(tmpDir, '~$document.pdf');
    await writeFile(filePath, 'lock file');
    await wait(2000);

    expect(detectedFiles).not.toContain(filePath);
  });

  it('ignores .DS_Store files', async () => {
    const ignoredPath = join(tmpDir, '.DS_Store');
    await writeFile(ignoredPath, '');
    await wait(2000);

    expect(detectedFiles).not.toContain(ignoredPath);
  });
});
