import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  ATTACHMENT_MARKER_RE,
  prepareAttachments,
  cleanupAttachments,
  formatFileSize,
} from './attachments.js';
import type { NewMessage } from './types.js';

// Use real temp dirs for file I/O tests
let tmpDir: string;
let groupsDir: string;
let dataDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  groupsDir = path.join(tmpDir, 'groups');
  dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(groupsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeMessage(content: string, id = '1'): NewMessage {
  return {
    id,
    chat_jid: 'tg:100',
    sender: '99001',
    sender_name: 'Alice',
    content,
    timestamp: new Date().toISOString(),
  };
}

describe('ATTACHMENT_MARKER_RE', () => {
  it('matches marker with absolute path', () => {
    const match =
      '(__attachment__:/data/attachments/main/456-report.pdf)'.match(
        ATTACHMENT_MARKER_RE,
      );
    expect(match).not.toBeNull();
    expect(match![1]).toBe('/data/attachments/main/456-report.pdf');
  });

  it('does not match plain parenthesized text', () => {
    expect('(hello world)'.match(ATTACHMENT_MARKER_RE)).toBeNull();
  });
});

describe('formatFileSize', () => {
  it('formats zero bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatFileSize(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatFileSize(1_500_000)).toBe('1.4 MB');
  });
});

describe('prepareAttachments', () => {
  it('copies file to inputs dir and rewrites content', () => {
    const attachDir = path.join(dataDir, 'attachments', 'main');
    fs.mkdirSync(attachDir, { recursive: true });
    const sourcePath = path.join(attachDir, '456-report.pdf');
    fs.writeFileSync(sourcePath, 'fake pdf content');

    const groupDir = path.join(groupsDir, 'main');
    fs.mkdirSync(groupDir, { recursive: true });

    const messages = [
      makeMessage(`[Document: report.pdf](__attachment__:${sourcePath})`),
    ];

    const consumed = prepareAttachments(messages, 'main', groupsDir);

    // Content rewritten with container path and file size
    expect(messages[0].content).toMatch(
      /\[Document: report\.pdf — available at \/workspace\/group\/inputs\/report\.pdf \(\d+/,
    );
    // Marker stripped
    expect(messages[0].content).not.toContain('(__attachment__:');
    // File copied to inputs
    expect(fs.existsSync(path.join(groupDir, 'inputs', 'report.pdf'))).toBe(
      true,
    );
    // Returns consumed source paths
    expect(consumed).toContain(sourcePath);
  });

  it('deduplicates filenames with numeric suffix', () => {
    const attachDir = path.join(dataDir, 'attachments', 'main');
    fs.mkdirSync(attachDir, { recursive: true });
    const source1 = path.join(attachDir, '1-report.pdf');
    const source2 = path.join(attachDir, '2-report.pdf');
    fs.writeFileSync(source1, 'pdf 1');
    fs.writeFileSync(source2, 'pdf 2');

    const groupDir = path.join(groupsDir, 'main');
    fs.mkdirSync(groupDir, { recursive: true });

    const messages = [
      makeMessage(`[Document: report.pdf](__attachment__:${source1})`, '1'),
      makeMessage(`[Document: report.pdf](__attachment__:${source2})`, '2'),
    ];

    prepareAttachments(messages, 'main', groupsDir);

    const inputsDir = path.join(groupDir, 'inputs');
    expect(fs.existsSync(path.join(inputsDir, 'report.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(inputsDir, 'report-2.pdf'))).toBe(true);
  });

  it('handles missing source file gracefully', () => {
    const messages = [
      makeMessage('[Document: gone.pdf](__attachment__:/nonexistent/path.pdf)'),
    ];

    const groupDir = path.join(groupsDir, 'main');
    fs.mkdirSync(groupDir, { recursive: true });

    const consumed = prepareAttachments(messages, 'main', groupsDir);

    // Marker stripped, placeholder preserved
    expect(messages[0].content).toBe('[Document: gone.pdf]');
    expect(consumed).toHaveLength(0);
  });

  it('passes through messages without markers unchanged', () => {
    const messages = [makeMessage('Hello, no attachments here')];
    const groupDir = path.join(groupsDir, 'main');
    fs.mkdirSync(groupDir, { recursive: true });

    prepareAttachments(messages, 'main', groupsDir);

    expect(messages[0].content).toBe('Hello, no attachments here');
  });

  it('handles photo markers', () => {
    const attachDir = path.join(dataDir, 'attachments', 'main');
    fs.mkdirSync(attachDir, { recursive: true });
    const sourcePath = path.join(attachDir, '789-photo.jpg');
    fs.writeFileSync(sourcePath, 'fake jpg');

    const groupDir = path.join(groupsDir, 'main');
    fs.mkdirSync(groupDir, { recursive: true });

    const messages = [makeMessage(`[Photo](__attachment__:${sourcePath})`)];

    prepareAttachments(messages, 'main', groupsDir);

    expect(messages[0].content).toMatch(
      /\[Photo — available at \/workspace\/group\/inputs\/789-photo\.jpg/,
    );
  });
});

describe('cleanupAttachments', () => {
  it('removes inputs dir and consumed source files', () => {
    const groupDir = path.join(groupsDir, 'main');
    const inputsDir = path.join(groupDir, 'inputs');
    fs.mkdirSync(inputsDir, { recursive: true });
    fs.writeFileSync(path.join(inputsDir, 'report.pdf'), 'data');

    const attachDir = path.join(dataDir, 'attachments', 'main');
    fs.mkdirSync(attachDir, { recursive: true });
    const sourcePath = path.join(attachDir, '456-report.pdf');
    fs.writeFileSync(sourcePath, 'data');

    cleanupAttachments('main', [sourcePath], groupsDir);

    expect(fs.existsSync(inputsDir)).toBe(false);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it('handles already-deleted files gracefully', () => {
    // Should not throw
    cleanupAttachments('main', ['/nonexistent/file.pdf'], groupsDir);
  });
});
