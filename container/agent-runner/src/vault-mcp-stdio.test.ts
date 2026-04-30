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

describe('vaultSection (page locator)', () => {
  let dir2: string;
  beforeEach(() => {
    dir2 = mkdtempSync(join(tmpdir(), 'vault-mcp-page-'));
  });
  afterEach(() => {
    rmSync(dir2, { recursive: true, force: true });
  });

  it('returns content between first markers of page N and page N+1', () => {
    const file = join(dir2, 'paged.md');
    writeFileSync(
      file,
      [
        '---',
        'title: P',
        '---',
        '',
        '<!-- page:1 label:section_header -->',
        '## Intro',
        '<!-- page:1 label:text -->',
        'page one body',
        '<!-- page:2 label:text -->',
        'page two body',
        '<!-- page:3 label:text -->',
        'page three body',
      ].join('\n'),
      'utf-8',
    );
    const result = vaultSection(file, { page: 2 });
    expect(result.content).toContain('page two body');
    expect(result.content).not.toContain('page one body');
    expect(result.content).not.toContain('page three body');
    expect(result.header).toMatch(
      /^File: .*\/paged\.md \/ Section: .+ \/ Page 2 \/ Lines \d+-\d+$/,
    );
  });

  it('uses nearest enclosing heading at-or-before page start as Section', () => {
    const file = join(dir2, 'paged.md');
    writeFileSync(
      file,
      [
        '<!-- page:1 label:section_header -->',
        '## Methods',
        '<!-- page:2 label:text -->',
        'page two body',
      ].join('\n'),
      'utf-8',
    );
    const result = vaultSection(file, { page: 2 });
    expect(result.header).toContain('Section: Methods');
  });

  it('uses <page-only> when no heading precedes the page start', () => {
    const file = join(dir2, 'paged.md');
    writeFileSync(
      file,
      [
        '<!-- page:1 label:text -->',
        'page one (no heading)',
        '<!-- page:2 label:text -->',
        'page two body',
      ].join('\n'),
      'utf-8',
    );
    const result = vaultSection(file, { page: 1 });
    expect(result.header).toContain('Section: <page-only>');
  });

  it('miss returns total page count', () => {
    const file = join(dir2, 'paged.md');
    writeFileSync(
      file,
      '<!-- page:1 label:text -->\na\n<!-- page:2 label:text -->\nb',
      'utf-8',
    );
    const result = vaultSection(file, { page: 99 });
    expect(result.notFound).toBe(true);
    expect(result.header).toContain('total pages: 2');
  });
});
