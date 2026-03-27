import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TypeMappings } from './type-mappings.js';

describe('TypeMappings', () => {
  describe('built-in mappings — Norwegian', () => {
    const tm = new TypeMappings('');

    it('maps forelesninger → lecture', () => {
      expect(tm.classifyFolder('forelesninger')).toBe('lecture');
    });

    it('maps presentasjoner → lecture', () => {
      expect(tm.classifyFolder('presentasjoner')).toBe('lecture');
    });

    it('maps pensum → reading', () => {
      expect(tm.classifyFolder('pensum')).toBe('reading');
    });

    it('maps litteratur → reading', () => {
      expect(tm.classifyFolder('litteratur')).toBe('reading');
    });

    it('maps artikler → reading', () => {
      expect(tm.classifyFolder('artikler')).toBe('reading');
    });

    it('maps eksamenslesning → exam-prep', () => {
      expect(tm.classifyFolder('eksamenslesning')).toBe('exam-prep');
    });

    it('maps eksamen → exam-prep', () => {
      expect(tm.classifyFolder('eksamen')).toBe('exam-prep');
    });

    it('maps oppgaver → assignment', () => {
      expect(tm.classifyFolder('oppgaver')).toBe('assignment');
    });

    it('maps innleveringer → assignment', () => {
      expect(tm.classifyFolder('innleveringer')).toBe('assignment');
    });

    it('maps øvinger → assignment', () => {
      expect(tm.classifyFolder('øvinger')).toBe('assignment');
    });

    it('maps kompendium → compendium', () => {
      expect(tm.classifyFolder('kompendium')).toBe('compendium');
    });

    it('maps sammendrag → compendium', () => {
      expect(tm.classifyFolder('sammendrag')).toBe('compendium');
    });

    it('maps prosjekt → project', () => {
      expect(tm.classifyFolder('prosjekt')).toBe('project');
    });

    it('maps bacheloroppgave → project', () => {
      expect(tm.classifyFolder('bacheloroppgave')).toBe('project');
    });

    it('maps masteroppgave → project', () => {
      expect(tm.classifyFolder('masteroppgave')).toBe('project');
    });

    it('maps ressurser → reference', () => {
      expect(tm.classifyFolder('ressurser')).toBe('reference');
    });

    it('maps vedlegg → reference', () => {
      expect(tm.classifyFolder('vedlegg')).toBe('reference');
    });
  });

  describe('built-in mappings — English', () => {
    const tm = new TypeMappings('');

    it('maps lectures → lecture', () => {
      expect(tm.classifyFolder('lectures')).toBe('lecture');
    });

    it('maps slides → lecture', () => {
      expect(tm.classifyFolder('slides')).toBe('lecture');
    });

    it('maps readings → reading', () => {
      expect(tm.classifyFolder('readings')).toBe('reading');
    });

    it('maps exam → exam-prep', () => {
      expect(tm.classifyFolder('exam')).toBe('exam-prep');
    });

    it('maps tasks → assignment', () => {
      expect(tm.classifyFolder('tasks')).toBe('assignment');
    });

    it('maps summary → compendium', () => {
      expect(tm.classifyFolder('summary')).toBe('compendium');
    });

    it('maps project → project', () => {
      expect(tm.classifyFolder('project')).toBe('project');
    });

    it('maps resources → reference', () => {
      expect(tm.classifyFolder('resources')).toBe('reference');
    });
  });

  describe('case-insensitivity', () => {
    const tm = new TypeMappings('');

    it('matches uppercase folder names', () => {
      expect(tm.classifyFolder('FORELESNINGER')).toBe('lecture');
    });

    it('matches mixed-case folder names', () => {
      expect(tm.classifyFolder('Forelesninger')).toBe('lecture');
    });

    it('matches uppercase english names', () => {
      expect(tm.classifyFolder('LECTURES')).toBe('lecture');
    });
  });

  describe('unknown folders', () => {
    const tm = new TypeMappings('');

    it('returns null for unknown folder names', () => {
      expect(tm.classifyFolder('random-folder')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(tm.classifyFolder('')).toBeNull();
    });

    it('returns null for numeric folder names', () => {
      expect(tm.classifyFolder('2024')).toBeNull();
    });
  });

  describe('learning and persistence', () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'type-mappings-test-'));
      configPath = join(tmpDir, 'mappings.json');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('learns a new mapping in-memory', async () => {
      const tm = new TypeMappings('');
      await tm.learn('anteckningar', 'lecture');
      expect(tm.classifyFolder('anteckningar')).toBe('lecture');
    });

    it('persists learned mappings to disk', async () => {
      const tm = new TypeMappings(configPath);
      await tm.learn('notater', 'lecture');

      expect(existsSync(configPath)).toBe(true);
      const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<
        string,
        string
      >;
      expect(saved['notater']).toBe('lecture');
    });

    it('loads persisted mappings on construction', async () => {
      const tm1 = new TypeMappings(configPath);
      await tm1.learn('anteckningar', 'reading');

      const tm2 = new TypeMappings(configPath);
      expect(tm2.classifyFolder('anteckningar')).toBe('reading');
    });

    it('learned mappings are case-insensitive', async () => {
      const tm = new TypeMappings(configPath);
      await tm.learn('MyFolder', 'personal');
      expect(tm.classifyFolder('myfolder')).toBe('personal');
      expect(tm.classifyFolder('MYFOLDER')).toBe('personal');
    });

    it('custom mappings override built-in mappings', async () => {
      const tm = new TypeMappings(configPath);
      await tm.learn('slides', 'reference');
      expect(tm.classifyFolder('slides')).toBe('reference');
    });

    it('skips file writing when configPath is empty string', async () => {
      const tm = new TypeMappings('');
      await tm.learn('notater', 'lecture');
      // No file should be written (no error thrown either)
      expect(tm.classifyFolder('notater')).toBe('lecture');
    });
  });
});
