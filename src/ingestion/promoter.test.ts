import { describe, it, expect, beforeEach } from 'vitest';
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { promoteNote } from './promoter.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/promoter');
const VAULT = join(TMP, 'vault');

describe('promoteNote', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(VAULT, 'concepts'), { recursive: true });
    mkdirSync(join(VAULT, 'sources'), { recursive: true });
    mkdirSync(join(VAULT, 'drafts'), { recursive: true });
  });

  it('promotes a concept note to concepts/ with kebab-case name', () => {
    const draftPath = join(VAULT, 'drafts', 'job1-concept-001.md');
    writeFileSync(
      draftPath,
      '---\ntitle: Self-Attention Mechanism\ntype: concept\n---\nContent',
    );

    const result = promoteNote(draftPath, VAULT, 'job1');

    expect(result.notePath).toBe('concepts/self-attention-mechanism.md');
    expect(result.figurePaths).toEqual([]);
    expect(
      existsSync(join(VAULT, 'concepts', 'self-attention-mechanism.md')),
    ).toBe(true);
    expect(existsSync(draftPath)).toBe(false);
  });

  it('promotes a source note to sources/', () => {
    const draftPath = join(VAULT, 'drafts', 'job1-source.md');
    writeFileSync(
      draftPath,
      '---\ntitle: "Attention Is All You Need (Vaswani 2017)"\ntype: source\n---\nContent',
    );

    const result = promoteNote(draftPath, VAULT, 'job1');

    expect(result.notePath).toBe(
      'sources/attention-is-all-you-need-vaswani-2017.md',
    );
    expect(
      existsSync(
        join(VAULT, 'sources', 'attention-is-all-you-need-vaswani-2017.md'),
      ),
    ).toBe(true);
  });

  it('appends hash suffix on filename collision', () => {
    writeFileSync(join(VAULT, 'concepts', 'gradient-descent.md'), 'existing');
    const draftPath = join(VAULT, 'drafts', 'a1b2-concept-001.md');
    writeFileSync(
      draftPath,
      '---\ntitle: Gradient Descent\ntype: concept\n---\nNew content',
    );

    const result = promoteNote(draftPath, VAULT, 'a1b2');

    expect(result.notePath).toMatch(
      /^concepts\/gradient-descent-[a-f0-9]{4}\.md$/,
    );
    expect(existsSync(join(VAULT, result.notePath))).toBe(true);
  });

  it('creates destination directory if it does not exist', () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(VAULT, 'drafts'), { recursive: true });

    const draftPath = join(VAULT, 'drafts', 'job2-concept-001.md');
    writeFileSync(
      draftPath,
      '---\ntitle: Backpropagation\ntype: concept\n---\nContent',
    );

    const result = promoteNote(draftPath, VAULT, 'job2');

    expect(result.notePath).toBe('concepts/backpropagation.md');
    expect(existsSync(join(VAULT, 'concepts', 'backpropagation.md'))).toBe(
      true,
    );
  });

  it('copies figures to vault/attachments/{slug}/ when figuresDir provided', () => {
    const figuresDir = join(TMP, 'figures');
    mkdirSync(figuresDir, { recursive: true });
    writeFileSync(join(figuresDir, 'page-3-figure-1.png'), 'fake-png');
    writeFileSync(join(figuresDir, 'page-5-figure-2.png'), 'fake-png-2');

    const draftPath = join(VAULT, 'drafts', 'job1-source.md');
    writeFileSync(
      draftPath,
      '---\ntitle: Cognitive Load Theory (Kirschner 2002)\ntype: source\n---\nContent',
    );

    const result = promoteNote(draftPath, VAULT, 'job1', figuresDir);

    expect(result.notePath).toBe(
      'sources/cognitive-load-theory-kirschner-2002.md',
    );
    expect(result.figurePaths).toEqual([
      'attachments/cognitive-load-theory-kirschner-2002/page-3-figure-1.png',
      'attachments/cognitive-load-theory-kirschner-2002/page-5-figure-2.png',
    ]);
    expect(
      existsSync(
        join(
          VAULT,
          'attachments',
          'cognitive-load-theory-kirschner-2002',
          'page-3-figure-1.png',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          VAULT,
          'attachments',
          'cognitive-load-theory-kirschner-2002',
          'page-5-figure-2.png',
        ),
      ),
    ).toBe(true);
  });

  it('returns empty figurePaths when figuresDir is empty', () => {
    const figuresDir = join(TMP, 'empty-figures');
    mkdirSync(figuresDir, { recursive: true });

    const draftPath = join(VAULT, 'drafts', 'job1-source.md');
    writeFileSync(
      draftPath,
      '---\ntitle: Empty Figures Source\ntype: source\n---\nContent',
    );

    const result = promoteNote(draftPath, VAULT, 'job1', figuresDir);

    expect(result.notePath).toBe('sources/empty-figures-source.md');
    expect(result.figurePaths).toEqual([]);
  });

  it('returns empty figurePaths when figuresDir does not exist', () => {
    const draftPath = join(VAULT, 'drafts', 'job1-source.md');
    writeFileSync(
      draftPath,
      '---\ntitle: Missing Figures\ntype: source\n---\nContent',
    );

    const result = promoteNote(
      draftPath,
      VAULT,
      'job1',
      '/nonexistent/figures',
    );

    expect(result.notePath).toBe('sources/missing-figures.md');
    expect(result.figurePaths).toEqual([]);
  });

  it('skips dotfiles when copying figures', () => {
    const figuresDir = join(TMP, 'figures-dotfile');
    mkdirSync(figuresDir, { recursive: true });
    writeFileSync(join(figuresDir, 'page-1-figure-1.png'), 'png-data');
    writeFileSync(join(figuresDir, '.DS_Store'), 'junk');

    const draftPath = join(VAULT, 'drafts', 'job1-source.md');
    writeFileSync(
      draftPath,
      '---\ntitle: Dotfile Test\ntype: source\n---\nContent',
    );

    const result = promoteNote(draftPath, VAULT, 'job1', figuresDir);

    expect(result.figurePaths).toEqual([
      'attachments/dotfile-test/page-1-figure-1.png',
    ]);
    const attachDir = join(VAULT, 'attachments', 'dotfile-test');
    expect(readdirSync(attachDir)).toEqual(['page-1-figure-1.png']);
  });

  it('uses collision-suffixed slug for attachments dir', () => {
    writeFileSync(join(VAULT, 'sources', 'shared-title.md'), 'existing');
    const figuresDir = join(TMP, 'figures-collision');
    mkdirSync(figuresDir, { recursive: true });
    writeFileSync(join(figuresDir, 'fig.png'), 'data');

    const draftPath = join(VAULT, 'drafts', 'abcd-source.md');
    writeFileSync(
      draftPath,
      '---\ntitle: Shared Title\ntype: source\n---\nContent',
    );

    const result = promoteNote(draftPath, VAULT, 'abcd', figuresDir);

    expect(result.notePath).toMatch(/^sources\/shared-title-[a-f0-9]{4}\.md$/);
    const suffixedSlug = result.notePath
      .replace(/^sources\//, '')
      .replace(/\.md$/, '');
    expect(result.figurePaths).toEqual([`attachments/${suffixedSlug}/fig.png`]);
    expect(existsSync(join(VAULT, 'attachments', suffixedSlug, 'fig.png'))).toBe(
      true,
    );
  });
});
