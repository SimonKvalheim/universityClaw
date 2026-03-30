import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
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

    expect(result).toBe('concepts/self-attention-mechanism.md');
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

    expect(result).toBe('sources/attention-is-all-you-need-vaswani-2017.md');
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

    expect(result).toMatch(/^concepts\/gradient-descent-[a-f0-9]{4}\.md$/);
    expect(existsSync(join(VAULT, result))).toBe(true);
  });
});
