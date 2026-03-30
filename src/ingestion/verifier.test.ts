import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  collectUnverifiedNotes,
  updateVerificationStatus,
  type VerificationResult,
} from './verifier.js';

const TMP = join(import.meta.dirname, '../../.test-tmp/verifier');
const VAULT = join(TMP, 'vault');

describe('verifier', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(VAULT, 'concepts'), { recursive: true });
  });

  describe('collectUnverifiedNotes', () => {
    it('returns notes with unverified status from a list of paths', () => {
      writeFileSync(
        join(VAULT, 'concepts', 'note-a.md'),
        '---\ntitle: A\nverification_status: unverified\n---\nContent',
      );
      writeFileSync(
        join(VAULT, 'concepts', 'note-b.md'),
        '---\ntitle: B\nverification_status: agent-verified\n---\nContent',
      );
      writeFileSync(
        join(VAULT, 'concepts', 'note-c.md'),
        '---\ntitle: C\nverification_status: unverified\n---\nContent',
      );

      const sourcePaths = [
        'concepts/note-a.md',
        'concepts/note-b.md',
        'concepts/note-c.md',
      ];

      const result = collectUnverifiedNotes(VAULT, sourcePaths);
      expect(result).toHaveLength(2);
      expect(result.map((n) => n.relPath)).toEqual([
        'concepts/note-a.md',
        'concepts/note-c.md',
      ]);
    });

    it('caps at maxBatch', () => {
      for (let i = 0; i < 15; i++) {
        writeFileSync(
          join(VAULT, 'concepts', `note-${i}.md`),
          `---\ntitle: Note ${i}\nverification_status: unverified\n---\nContent`,
        );
      }

      const paths = Array.from(
        { length: 15 },
        (_, i) => `concepts/note-${i}.md`,
      );
      const result = collectUnverifiedNotes(VAULT, paths, 10);
      expect(result).toHaveLength(10);
    });
  });

  describe('updateVerificationStatus', () => {
    it('updates frontmatter verification_status and verified_at', () => {
      const notePath = join(VAULT, 'concepts', 'note-x.md');
      writeFileSync(
        notePath,
        '---\ntitle: X\nverification_status: unverified\nverified_at: null\n---\nContent',
      );

      updateVerificationStatus(notePath, 'agent-verified');

      const updated = readFileSync(notePath, 'utf-8');
      expect(updated).toContain('verification_status: agent-verified');
      expect(updated).toContain('verified_at:');
      expect(updated).not.toContain('verified_at: null');
    });

    it('adds verification_issues when status stays unverified', () => {
      const notePath = join(VAULT, 'concepts', 'note-y.md');
      writeFileSync(
        notePath,
        '---\ntitle: Y\nverification_status: unverified\n---\nContent',
      );

      updateVerificationStatus(notePath, 'unverified', [
        'Claim on line 5 unsupported by cited passage',
      ]);

      const updated = readFileSync(notePath, 'utf-8');
      expect(updated).toContain('verification_issues');
      expect(updated).toContain('unsupported by cited passage');
    });
  });
});
