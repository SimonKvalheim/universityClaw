import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase, _closeDatabase } from '../db/index.js';
import { getTaskById, getAllTasks } from '../db.js';
import {
  registerStudyScheduledTasks,
  getStudyTaskDefinitions,
} from './scheduled.js';

const TEST_JID = 'test-chat@telegram';

describe('registerStudyScheduledTasks', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('creates 4 tasks', () => {
    registerStudyScheduledTasks(TEST_JID);
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(4);
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain('study-daily-morning');
    expect(ids).toContain('study-weekly-progress');
    expect(ids).toContain('study-monthly-mastery');
    expect(ids).toContain('study-sqlite-backup');
  });

  it('is idempotent — calling twice still yields only 4 tasks', () => {
    registerStudyScheduledTasks(TEST_JID);
    registerStudyScheduledTasks(TEST_JID);
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(4);
  });

  it('tasks have correct cron patterns', () => {
    registerStudyScheduledTasks(TEST_JID);

    const morning = getTaskById('study-daily-morning');
    expect(morning?.schedule_value).toBe('0 7 * * *');

    const weekly = getTaskById('study-weekly-progress');
    expect(weekly?.schedule_value).toBe('0 18 * * 0');

    const monthly = getTaskById('study-monthly-mastery');
    expect(monthly?.schedule_value).toBe('0 10 1 * *');

    const backup = getTaskById('study-sqlite-backup');
    expect(backup?.schedule_value).toBe('0 3 * * *');
  });

  it('tasks have valid future next_run', () => {
    registerStudyScheduledTasks(TEST_JID);
    const tasks = getAllTasks();
    const now = Date.now();
    for (const task of tasks) {
      expect(task.next_run).toBeTruthy();
      const nextRunMs = new Date(task.next_run!).getTime();
      expect(nextRunMs).toBeGreaterThan(now);
    }
  });
});

describe('getStudyTaskDefinitions', () => {
  it('returns 4 definitions with correct IDs', () => {
    const defs = getStudyTaskDefinitions(TEST_JID);
    expect(defs).toHaveLength(4);
    const ids = defs.map((d) => d.id);
    expect(ids).toContain('study-daily-morning');
    expect(ids).toContain('study-weekly-progress');
    expect(ids).toContain('study-monthly-mastery');
    expect(ids).toContain('study-sqlite-backup');
  });
});
