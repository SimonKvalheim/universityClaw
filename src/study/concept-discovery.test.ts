import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverConcepts } from './concept-discovery.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFrontmatter(fields: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push('Content here...');
  return lines.join('\n');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('discoverConcepts', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = join(tmpdir(), `concept-discovery-test-${Date.now()}`);
    mkdirSync(join(vaultDir, 'concepts'), { recursive: true });
    mkdirSync(join(vaultDir, 'sources'), { recursive: true });
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns one concept with all fields when frontmatter has domain and subdomain', () => {
    writeFileSync(
      join(vaultDir, 'concepts', 'action-research.md'),
      makeFrontmatter({
        title: 'Action Research',
        type: 'concept',
        domain: 'research-methodology',
        subdomain: 'qualitative',
        topics: ['research', 'methods'],
        generated_by: 'claude',
      }),
    );

    const results = discoverConcepts(['concepts/action-research.md'], vaultDir);

    expect(results).toHaveLength(1);
    const concept = results[0];
    expect(concept.title).toBe('Action Research');
    expect(concept.domain).toBe('research-methodology');
    expect(concept.subdomain).toBe('qualitative');
    expect(concept.vaultNotePath).toBe('concepts/action-research.md');
    expect(concept.status).toBe('pending');
    expect(typeof concept.id).toBe('string');
    expect(concept.id.length).toBeGreaterThan(0);
    expect(typeof concept.createdAt).toBe('string');
    expect(concept.createdAt.length).toBeGreaterThan(0);
  });

  it('returns null domain and subdomain when frontmatter does not have them', () => {
    writeFileSync(
      join(vaultDir, 'concepts', 'action-research.md'),
      makeFrontmatter({
        title: 'Action Research',
        type: 'concept',
        topics: ['research-methodology', 'scientific-methods'],
        source_doc: 'Scientific Methods Lecture 2',
        generated_by: 'claude',
        verification_status: 'unverified',
        created: '2026-04-03',
      }),
    );

    const results = discoverConcepts(['concepts/action-research.md'], vaultDir);

    expect(results).toHaveLength(1);
    expect(results[0].domain).toBeNull();
    expect(results[0].subdomain).toBeNull();
  });

  it('skips source notes (type=source)', () => {
    writeFileSync(
      join(vaultDir, 'sources', 'vaswani.md'),
      makeFrontmatter({
        title: 'Attention is All You Need',
        type: 'source',
      }),
    );

    const results = discoverConcepts(['sources/vaswani.md'], vaultDir);

    expect(results).toHaveLength(0);
  });

  it('skips paths not starting with concepts/', () => {
    writeFileSync(
      join(vaultDir, 'sources', 'some-note.md'),
      makeFrontmatter({
        title: 'Some Note',
        type: 'concept',
        domain: 'science',
      }),
    );

    const results = discoverConcepts(['sources/some-note.md'], vaultDir);

    expect(results).toHaveLength(0);
  });

  it('returns empty array when the file does not exist', () => {
    const results = discoverConcepts(['concepts/ghost.md'], vaultDir);

    expect(results).toHaveLength(0);
  });

  it('handles multiple paths with mixed types and returns only concepts', () => {
    writeFileSync(
      join(vaultDir, 'concepts', 'alpha.md'),
      makeFrontmatter({ title: 'Alpha Concept', type: 'concept', domain: 'math' }),
    );
    writeFileSync(
      join(vaultDir, 'concepts', 'beta.md'),
      makeFrontmatter({ title: 'Beta Concept', type: 'concept' }),
    );
    writeFileSync(
      join(vaultDir, 'sources', 'gamma.md'),
      makeFrontmatter({ title: 'Gamma Source', type: 'source' }),
    );

    const results = discoverConcepts(
      ['concepts/alpha.md', 'concepts/beta.md', 'sources/gamma.md'],
      vaultDir,
    );

    expect(results).toHaveLength(2);
    const titles = results.map((r) => r.title).sort();
    expect(titles).toEqual(['Alpha Concept', 'Beta Concept']);
  });

  it('skips concept notes without a title field', () => {
    writeFileSync(
      join(vaultDir, 'concepts', 'no-title.md'),
      makeFrontmatter({ type: 'concept', domain: 'math' }),
    );

    // makeFrontmatter always writes title as a key — override with a note that has no title
    writeFileSync(
      join(vaultDir, 'concepts', 'no-title.md'),
      '---\ntype: concept\ndomain: math\n---\n\nContent.',
    );

    const results = discoverConcepts(['concepts/no-title.md'], vaultDir);

    expect(results).toHaveLength(0);
  });

  it('populates course field when present in frontmatter', () => {
    writeFileSync(
      join(vaultDir, 'concepts', 'business-process.md'),
      makeFrontmatter({
        title: 'Business Process',
        type: 'concept',
        course: 'BI-2081',
        domain: 'business',
      }),
    );

    const results = discoverConcepts(
      ['concepts/business-process.md'],
      vaultDir,
    );

    expect(results).toHaveLength(1);
    expect(results[0].course).toBe('BI-2081');
  });
});
