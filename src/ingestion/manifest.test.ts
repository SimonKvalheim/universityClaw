import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { readManifest, inferManifest, type NoteManifest } from './manifest.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/manifest');

describe('manifest', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  describe('readManifest', () => {
    it('reads a valid manifest file', () => {
      const manifest: NoteManifest = {
        source_note: 'job1-source.md',
        concept_notes: ['job1-concept-001.md', 'job1-concept-002.md'],
      };
      writeFileSync(join(TMP, 'job1-manifest.json'), JSON.stringify(manifest));

      const result = readManifest(TMP, 'job1');
      expect(result).toEqual(manifest);
    });

    it('returns null if manifest does not exist', () => {
      const result = readManifest(TMP, 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('inferManifest', () => {
    it('infers manifest from draft files when no manifest exists', () => {
      writeFileSync(
        join(TMP, 'job1-source.md'),
        '---\ntype: source\n---\nContent',
      );
      writeFileSync(
        join(TMP, 'job1-concept-001.md'),
        '---\ntype: concept\n---\nContent',
      );
      writeFileSync(
        join(TMP, 'job1-concept-002.md'),
        '---\ntype: concept\n---\nContent',
      );
      writeFileSync(join(TMP, 'other-file.md'), 'Not related');

      const result = inferManifest(TMP, 'job1');
      expect(result.source_note).toBe('job1-source.md');
      expect(result.concept_notes).toHaveLength(2);
      expect(result.concept_notes).toContain('job1-concept-001.md');
      expect(result.concept_notes).toContain('job1-concept-002.md');
    });
  });
});
