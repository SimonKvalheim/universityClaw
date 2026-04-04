import { describe, it, expect, beforeEach } from 'vitest';
import {
  createIngestionJob,
  updateIngestionJob,
  getIngestionJobByZoteroKey,
  getZoteroSyncVersion,
  setZoteroSyncVersion,
  getIngestionJobById,
  _initTestDatabase,
  _closeDatabase,
} from '../db.js';

describe('Zotero DB functions', () => {
  beforeEach(() => {
    _closeDatabase();
    _initTestDatabase();
  });

  it('createIngestionJob stores zotero fields', () => {
    createIngestionJob('job-1', '/path/to/file.pdf', 'file.pdf', 'hash123', {
      source_type: 'zotero',
      zotero_key: 'ABCD1234',
      zotero_metadata: JSON.stringify({ title: 'Test Paper' }),
    });
    const job = getIngestionJobById('job-1') as Record<string, unknown>;
    expect(job.source_type).toBe('zotero');
    expect(job.zotero_key).toBe('ABCD1234');
    expect(JSON.parse(job.zotero_metadata as string)).toEqual({ title: 'Test Paper' });
  });

  it('createIngestionJob defaults source_type to upload', () => {
    createIngestionJob('job-2', '/path/to/file.pdf', 'file.pdf', 'hash456');
    const job = getIngestionJobById('job-2') as Record<string, unknown>;
    expect(job.source_type).toBe('upload');
    expect(job.zotero_key).toBeNull();
  });

  it('getIngestionJobByZoteroKey finds completed job', () => {
    createIngestionJob('job-3', '/path/to/file.pdf', 'file.pdf', 'hash789', {
      source_type: 'zotero',
      zotero_key: 'EFGH5678',
    });
    updateIngestionJob('job-3', { status: 'completed' });

    const result = getIngestionJobByZoteroKey('EFGH5678');
    expect(result).toBeDefined();
    expect(result!.id).toBe('job-3');
  });

  it('getIngestionJobByZoteroKey returns undefined for non-existent key', () => {
    const result = getIngestionJobByZoteroKey('NONEXIST');
    expect(result).toBeUndefined();
  });

  it('get/setZoteroSyncVersion persists version', () => {
    expect(getZoteroSyncVersion()).toBeNull();
    setZoteroSyncVersion(1834);
    expect(getZoteroSyncVersion()).toBe(1834);
    setZoteroSyncVersion(1900);
    expect(getZoteroSyncVersion()).toBe(1900);
  });
});
