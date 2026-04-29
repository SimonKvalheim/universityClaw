import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLibraryFile } from './library-writer.js';

describe('writeLibraryFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'library-writer-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a file with the spec frontmatter shape', () => {
    const path = writeLibraryFile({
      libraryDir: dir,
      slug: 'foo-bar',
      jobMeta: {
        title: 'Foo Bar',
        sourceType: 'paper',
        ingestedFrom: 'upload/processed/abc-foo.pdf',
        jobId: 'abc',
        sourceSummarySlug: 'foo-bar',
      },
      cleanedBody: 'BODY CONTENT\n',
    });
    expect(path).toBe(join(dir, 'foo-bar.md'));
    const written = readFileSync(path, 'utf-8');
    // Format-tolerant assertions — match the gray-matter output style.
    expect(written).toMatch(/^title:\s*Foo Bar\s*$/m);
    expect(written).toMatch(/^type:\s*library\s*$/m);
    expect(written).toMatch(
      /^source_summary:\s*['"]?\[\[foo-bar\]\]['"]?\s*$/m,
    );
    expect(written).toMatch(/^source_type:\s*paper\s*$/m);
    expect(written).toMatch(
      /^ingested_from:\s*['"]?upload\/processed\/abc-foo\.pdf['"]?\s*$/m,
    );
    expect(written).toMatch(/^job_id:\s*abc\s*$/m);
    expect(written).toMatch(/^indexed:\s*false\s*$/m);
    expect(written).toContain('BODY CONTENT');
  });

  it('omits source_summary when not provided (over-budget case)', () => {
    const path = writeLibraryFile({
      libraryDir: dir,
      slug: 'big-book',
      jobMeta: {
        title: 'Big Book',
        sourceType: 'book',
        ingestedFrom: 'upload/processed/zz-big.pdf',
        jobId: 'zz',
        sourceSummarySlug: undefined,
      },
      cleanedBody: 'X',
    });
    const written = readFileSync(path, 'utf-8');
    expect(written).not.toMatch(/^source_summary:/m);
    expect(written).toMatch(/^title:\s*Big Book\s*$/m);
  });

  it('atomic write: no .tmp file remains after success', () => {
    writeLibraryFile({
      libraryDir: dir,
      slug: 'a',
      jobMeta: {
        title: 'A',
        sourceType: 'paper',
        ingestedFrom: 'x',
        jobId: 'j',
        sourceSummarySlug: 'a',
      },
      cleanedBody: 'b',
    });
    const entries = readdirSync(dir);
    expect(entries).toEqual(['a.md']);
  });

  it('overwrites existing library file (latest extraction wins)', () => {
    writeLibraryFile({
      libraryDir: dir,
      slug: 's',
      jobMeta: {
        title: 'first',
        sourceType: 'paper',
        ingestedFrom: 'x',
        jobId: 'j1',
        sourceSummarySlug: 's',
      },
      cleanedBody: 'old',
    });
    writeLibraryFile({
      libraryDir: dir,
      slug: 's',
      jobMeta: {
        title: 'second',
        sourceType: 'paper',
        ingestedFrom: 'x',
        jobId: 'j2',
        sourceSummarySlug: 's',
      },
      cleanedBody: 'new',
    });
    const written = readFileSync(join(dir, 's.md'), 'utf-8');
    expect(written).toMatch(/^title:\s*second\s*$/m);
    expect(written).toContain('new');
    expect(written).not.toContain('old');
  });

  it('creates libraryDir if missing', () => {
    const nested = join(dir, 'nested', 'library');
    writeLibraryFile({
      libraryDir: nested,
      slug: 'a',
      jobMeta: {
        title: 'A',
        sourceType: 'paper',
        ingestedFrom: 'x',
        jobId: 'j',
        sourceSummarySlug: 'a',
      },
      cleanedBody: 'b',
    });
    expect(statSync(join(nested, 'a.md')).isFile()).toBe(true);
  });

  it('handles concurrent writes to the same slug without tmp collision', async () => {
    const promises = [
      Promise.resolve().then(() =>
        writeLibraryFile({
          libraryDir: dir,
          slug: 'race',
          jobMeta: { title: 'A', sourceType: 'paper', ingestedFrom: 'x', jobId: 'j1', sourceSummarySlug: 'race' },
          cleanedBody: 'A_BODY',
        })
      ),
      Promise.resolve().then(() =>
        writeLibraryFile({
          libraryDir: dir,
          slug: 'race',
          jobMeta: { title: 'B', sourceType: 'paper', ingestedFrom: 'x', jobId: 'j2', sourceSummarySlug: 'race' },
          cleanedBody: 'B_BODY',
        })
      ),
    ];
    await Promise.all(promises);
    // Final file exists, no tmp leftovers, content is one of the two writes (not corrupted)
    const entries = readdirSync(dir);
    expect(entries).toEqual(['race.md']);
    const written = readFileSync(join(dir, 'race.md'), 'utf-8');
    expect(['A_BODY', 'B_BODY'].some((c) => written.includes(c))).toBe(true);
  });
});
