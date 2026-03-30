import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { rotateStudyLog } from './rotation.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/rotation');
const VAULT = join(TMP, 'vault');
const PROFILE = join(VAULT, 'profile');
const ARCHIVE = join(PROFILE, 'archive');

describe('rotateStudyLog', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(ARCHIVE, { recursive: true });
  });

  it('archives entries older than 30 days', () => {
    const oldDate = '2026-02-15';
    const recentDate = '2026-03-25';
    const logPath = join(PROFILE, 'study-log.md');

    writeFileSync(
      logPath,
      `---
title: Study Log
type: profile
created: 2026-03-01
---

## ${recentDate}
- Queried: transformers

## ${oldDate}
- Queried: sorting algorithms
- Quiz: data-structures (7/10)
`,
    );

    rotateStudyLog(PROFILE, new Date('2026-03-30'));

    const updated = readFileSync(logPath, 'utf-8');
    expect(updated).toContain(recentDate);
    expect(updated).not.toContain(oldDate);

    const archivePath = join(ARCHIVE, 'study-log-2026-02.md');
    expect(existsSync(archivePath)).toBe(true);
    const archived = readFileSync(archivePath, 'utf-8');
    expect(archived).toContain(oldDate);
    expect(archived).toContain('sorting algorithms');
  });

  it('force-archives when file exceeds 200 lines', () => {
    const logPath = join(PROFILE, 'study-log.md');
    const lines = Array.from({ length: 210 }, (_, i) => `- Entry ${i}`);
    const content = `---\ntitle: Study Log\ntype: profile\ncreated: 2026-03-01\n---\n\n## 2026-03-29\n${lines.join('\n')}\n`;
    writeFileSync(logPath, content);

    rotateStudyLog(PROFILE, new Date('2026-03-30'));

    const updated = readFileSync(logPath, 'utf-8');
    const lineCount = updated.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(210); // frontmatter + 200 content lines
  });

  it('does nothing when all entries are recent', () => {
    const logPath = join(PROFILE, 'study-log.md');
    const content = `---
title: Study Log
type: profile
created: 2026-03-01
---

## 2026-03-29
- Queried: attention
`;
    writeFileSync(logPath, content);

    rotateStudyLog(PROFILE, new Date('2026-03-30'));

    const updated = readFileSync(logPath, 'utf-8');
    expect(updated).toContain('2026-03-29');
  });
});
