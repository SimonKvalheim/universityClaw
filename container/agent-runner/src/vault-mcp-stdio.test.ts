import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vaultSection } from './vault-mcp-stdio.js';

const sample = `---
title: Sample
---

# Top

intro

## Introduction

intro body line 1
intro body line 2

## Methods

methods body

## Introduction (Appendix)

duplicate header
`;

describe('vaultSection (section locator)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-mcp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the matching H2 section with header line', () => {
    const file = join(dir, 's.md');
    writeFileSync(file, sample, 'utf-8');
    const result = vaultSection(file, { section: 'Methods' });
    expect(result.header).toMatch(
      /^File: .*\/s\.md \/ Section: Methods \/ Page \d+ \/ Lines \d+-\d+$/,
    );
    expect(result.content).toContain('methods body');
    expect(result.multipleMatches).toBeUndefined();
  });

  it('case-insensitive substring match', () => {
    const file = join(dir, 's.md');
    writeFileSync(file, sample, 'utf-8');
    const result = vaultSection(file, { section: 'method' });
    expect(result.content).toContain('methods body');
  });

  it('first match in document order on collision, with multiple_matches', () => {
    const file = join(dir, 's.md');
    writeFileSync(file, sample, 'utf-8');
    const result = vaultSection(file, { section: 'Introduction' });
    expect(result.content).toContain('intro body line 1');
    expect(result.multipleMatches).toBe(2);
    expect(result.matchingHeadings).toEqual([
      'Introduction',
      'Introduction (Appendix)',
    ]);
  });

  it('returns available sections list on miss', () => {
    const file = join(dir, 's.md');
    writeFileSync(file, sample, 'utf-8');
    const result = vaultSection(file, { section: 'Conclusion' });
    expect(result.notFound).toBe(true);
    expect(result.availableSections).toEqual(
      expect.arrayContaining([
        'Top',
        'Introduction',
        'Methods',
        'Introduction (Appendix)',
      ]),
    );
  });
});
