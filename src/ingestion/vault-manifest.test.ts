import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { buildVaultManifest } from './vault-manifest.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/vault-manifest');
const VAULT = join(TMP, 'vault');

describe('buildVaultManifest', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(VAULT, 'concepts'), { recursive: true });
    mkdirSync(join(VAULT, 'sources'), { recursive: true });
  });

  it('returns empty manifest for empty vault', () => {
    const manifest = buildVaultManifest(VAULT);

    expect(manifest).toContain('<existing_vault_notes>');
    expect(manifest).toContain('</existing_vault_notes>');
    expect(manifest).toContain('## Sources');
    expect(manifest).toContain('## Concepts');
  });

  it('lists source notes with title', () => {
    writeFileSync(
      join(VAULT, 'sources', 'kirschner-2002.md'),
      '---\ntitle: "Cognitive Load Theory (Kirschner 2002)"\ntype: source\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    expect(manifest).toContain(
      '- kirschner-2002 | "Cognitive Load Theory (Kirschner 2002)"',
    );
  });

  it('lists concept notes with title and topics', () => {
    writeFileSync(
      join(VAULT, 'concepts', 'working-memory.md'),
      '---\ntitle: Working Memory Architecture\ntype: concept\ntopics:\n  - cognitive-load\n  - memory\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    expect(manifest).toContain(
      '- working-memory | "Working Memory Architecture" | topics: cognitive-load, memory',
    );
  });

  it('skips notes with missing frontmatter gracefully', () => {
    writeFileSync(join(VAULT, 'concepts', 'no-frontmatter.md'), 'Just text');
    writeFileSync(
      join(VAULT, 'concepts', 'has-frontmatter.md'),
      '---\ntitle: Valid Note\ntype: concept\ntopics:\n  - test\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    expect(manifest).toContain('has-frontmatter');
    expect(manifest).not.toContain('no-frontmatter');
  });

  it('groups sources and concepts under separate headings', () => {
    writeFileSync(
      join(VAULT, 'sources', 'paper-a.md'),
      '---\ntitle: Paper A\ntype: source\n---\nContent',
    );
    writeFileSync(
      join(VAULT, 'concepts', 'concept-b.md'),
      '---\ntitle: Concept B\ntype: concept\ntopics:\n  - test\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    const sourcesIdx = manifest.indexOf('## Sources');
    const conceptsIdx = manifest.indexOf('## Concepts');
    const paperIdx = manifest.indexOf('paper-a');
    const conceptIdx = manifest.indexOf('concept-b');

    expect(paperIdx).toBeGreaterThan(sourcesIdx);
    expect(paperIdx).toBeLessThan(conceptsIdx);
    expect(conceptIdx).toBeGreaterThan(conceptsIdx);
  });

  it('handles hash-suffixed filenames from promoter collision', () => {
    writeFileSync(
      join(VAULT, 'concepts', 'gradient-descent-a1b2.md'),
      '---\ntitle: Gradient Descent\ntype: concept\ntopics:\n  - ml\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    expect(manifest).toContain('gradient-descent-a1b2');
  });

  it('ignores non-md files', () => {
    writeFileSync(join(VAULT, 'concepts', '.DS_Store'), '');
    writeFileSync(
      join(VAULT, 'concepts', 'valid.md'),
      '---\ntitle: Valid\ntype: concept\ntopics:\n  - test\n---\nContent',
    );

    const manifest = buildVaultManifest(VAULT);

    expect(manifest).not.toContain('.DS_Store');
    expect(manifest).toContain('valid');
  });
});
