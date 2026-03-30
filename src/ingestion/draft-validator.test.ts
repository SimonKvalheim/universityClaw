import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { validateDrafts, type ValidationResult } from './draft-validator.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/draft-validator');
const DRAFTS = join(TMP, 'drafts');
const JOB_ID = 'abc12345-1111-2222-3333-444444444444';

function writeNote(filename: string, frontmatter: string, body = 'Content') {
  writeFileSync(join(DRAFTS, filename), `---\n${frontmatter}\n---\n\n${body}`);
}

function writeManifest(source: string, concepts: string[]) {
  writeFileSync(
    join(DRAFTS, `${JOB_ID}-manifest.json`),
    JSON.stringify({ source_note: source, concept_notes: concepts }),
  );
}

describe('validateDrafts', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(DRAFTS, { recursive: true });
  });

  it('passes when all files and frontmatter are correct', () => {
    writeNote(`${JOB_ID}-source.md`, [
      'title: "Test Paper (2024)"',
      'type: source',
      'source_type: paper',
      'source_file: upload/processed/abc12345-paper.pdf',
      'concepts_generated:',
      '  - working-memory',
      'verification_status: unverified',
    ].join('\n'), 'Summary content [^1]\n\n[^1]: Author, §1, p.1');

    writeNote(`${JOB_ID}-concept-001.md`, [
      'title: Working Memory',
      'type: concept',
      'topics: [cognitive-load, memory]',
      'source_doc: "Test Paper"',
      'source_file: upload/processed/abc12345-paper.pdf',
      'source_pages: [2, 3]',
      'verification_status: unverified',
    ].join('\n'), 'Concept content [^1]\n\n[^1]: Author, §2, p.2');

    writeManifest(`${JOB_ID}-source.md`, [`${JOB_ID}-concept-001.md`]);

    const result = validateDrafts(DRAFTS, JOB_ID, 'paper.pdf');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports missing manifest', () => {
    const result = validateDrafts(DRAFTS, JOB_ID, 'paper.pdf');
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ severity: 'must-fix', check: 'manifest-exists' }),
    );
  });

  it('reports missing source note', () => {
    writeManifest(`${JOB_ID}-source.md`, [`${JOB_ID}-concept-001.md`]);
    writeNote(`${JOB_ID}-concept-001.md`, [
      'title: Concept',
      'type: concept',
      'topics: [topic]',
      'source_doc: "Paper"',
      'source_file: upload/processed/abc12345-paper.pdf',
      'source_pages: [1]',
      'verification_status: unverified',
    ].join('\n'));

    const result = validateDrafts(DRAFTS, JOB_ID, 'paper.pdf');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.check === 'source-note-exists')).toBe(true);
  });

  it('reports missing concept note files', () => {
    writeNote(`${JOB_ID}-source.md`, [
      'title: "Paper"',
      'type: source',
      'source_type: paper',
      'source_file: upload/processed/abc12345-paper.pdf',
      'concepts_generated: []',
      'verification_status: unverified',
    ].join('\n'));
    writeManifest(`${JOB_ID}-source.md`, [`${JOB_ID}-concept-001.md`]);

    const result = validateDrafts(DRAFTS, JOB_ID, 'paper.pdf');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.check === 'concept-note-exists')).toBe(true);
  });

  it('reports missing required frontmatter on source note', () => {
    writeNote(`${JOB_ID}-source.md`, [
      'title: "Paper"',
      'type: source',
      // missing source_type, source_file, concepts_generated, verification_status
    ].join('\n'));
    writeManifest(`${JOB_ID}-source.md`, []);

    const result = validateDrafts(DRAFTS, JOB_ID, 'paper.pdf');
    expect(result.valid).toBe(false);
    const fmErrors = result.errors.filter((e) => e.check === 'source-frontmatter');
    expect(fmErrors.length).toBeGreaterThan(0);
  });

  it('reports missing required frontmatter on concept notes', () => {
    writeNote(`${JOB_ID}-source.md`, [
      'title: "Paper"',
      'type: source',
      'source_type: paper',
      'source_file: upload/processed/abc12345-paper.pdf',
      'concepts_generated: []',
      'verification_status: unverified',
    ].join('\n'));
    writeNote(`${JOB_ID}-concept-001.md`, [
      'title: Concept',
      'type: concept',
      // missing topics, source_doc, source_file, source_pages, verification_status
    ].join('\n'));
    writeManifest(`${JOB_ID}-source.md`, [`${JOB_ID}-concept-001.md`]);

    const result = validateDrafts(DRAFTS, JOB_ID, 'paper.pdf');
    expect(result.valid).toBe(false);
    const fmErrors = result.errors.filter((e) => e.check === 'concept-frontmatter');
    expect(fmErrors.length).toBeGreaterThan(0);
  });

  it('reports concepts_generated mismatch as should-fix', () => {
    writeNote(`${JOB_ID}-source.md`, [
      'title: "Paper"',
      'type: source',
      'source_type: paper',
      'source_file: upload/processed/abc12345-paper.pdf',
      'concepts_generated:',
      '  - wrong-slug',
      'verification_status: unverified',
    ].join('\n'));
    writeNote(`${JOB_ID}-concept-001.md`, [
      'title: Working Memory',
      'type: concept',
      'topics: [memory]',
      'source_doc: "Paper"',
      'source_file: upload/processed/abc12345-paper.pdf',
      'source_pages: [1]',
      'verification_status: unverified',
    ].join('\n'));
    writeManifest(`${JOB_ID}-source.md`, [`${JOB_ID}-concept-001.md`]);

    const result = validateDrafts(DRAFTS, JOB_ID, 'paper.pdf');
    expect(result.errors.some((e) =>
      e.severity === 'should-fix' && e.check === 'concepts-generated-match',
    )).toBe(true);
  });

  it('warns about missing citations', () => {
    writeNote(`${JOB_ID}-source.md`, [
      'title: "Paper"',
      'type: source',
      'source_type: paper',
      'source_file: upload/processed/abc12345-paper.pdf',
      'concepts_generated: []',
      'verification_status: unverified',
    ].join('\n'), 'No citations here.');
    writeManifest(`${JOB_ID}-source.md`, []);

    const result = validateDrafts(DRAFTS, JOB_ID, 'paper.pdf');
    const warns = result.warnings.filter((w) => w.check === 'has-citations');
    expect(warns.length).toBeGreaterThan(0);
  });
});
