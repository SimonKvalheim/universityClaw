import { beforeEach, describe, expect, it } from 'vitest';
import { _initTestDatabase } from '../db.js';
import { getDb } from './index.js';
import * as schema from './schema/index.js';
import {
  getRecentDeliveredConcepts,
  recordConceptDelivery,
} from './delivered-concepts.js';

const CHAT = 'tg:test';
const OTHER_CHAT = 'tg:other';

function seedConcept(id: string, path: string, title: string) {
  getDb().insert(schema.concepts).values({
    id, title, vaultNotePath: path,
    createdAt: '2026-05-01T00:00:00.000Z',
  }).run();
}

beforeEach(() => {
  _initTestDatabase();
});

describe('recordConceptDelivery', () => {
  it('inserts a row when concept exists by path', () => {
    seedConcept('c1', 'concepts/foo.md', 'Foo');
    const res = recordConceptDelivery({
      concept: 'concepts/foo.md',
      chatJid: CHAT,
      sourceTaskId: 'study-daily-morning',
      surface: 'text+voice',
    });
    expect(res).toEqual({ ok: true, conceptId: 'c1', title: 'Foo' });
  });

  it('accepts a UUID directly', () => {
    seedConcept('c2', 'concepts/bar.md', 'Bar');
    const res = recordConceptDelivery({ concept: 'c2', chatJid: CHAT });
    expect(res).toEqual({ ok: true, conceptId: 'c2', title: 'Bar' });
  });

  it('returns ok:false for an unknown concept', () => {
    const res = recordConceptDelivery({
      concept: 'concepts/does-not-exist.md',
      chatJid: CHAT,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not found/i);
  });

  it('allows duplicate deliveries of the same concept', () => {
    seedConcept('c3', 'concepts/dup.md', 'Dup');
    recordConceptDelivery({ concept: 'c3', chatJid: CHAT });
    const res2 = recordConceptDelivery({ concept: 'c3', chatJid: CHAT });
    expect(res2.ok).toBe(true);
  });
});

describe('getRecentDeliveredConcepts', () => {
  it('returns rows within the window, newest first', () => {
    seedConcept('c1', 'concepts/a.md', 'A');
    seedConcept('c2', 'concepts/b.md', 'B');
    const now = Date.now();
    const oneDay = 86_400_000;
    getDb().insert(schema.deliveredConcepts).values([
      { id: 'd1', conceptId: 'c1', chatJid: CHAT,
        deliveredAt: new Date(now - 1 * oneDay).toISOString() },
      { id: 'd2', conceptId: 'c2', chatJid: CHAT,
        deliveredAt: new Date(now - 7 * oneDay).toISOString() },
    ]).run();
    const rows = getRecentDeliveredConcepts(CHAT, 14);
    expect(rows.map((r) => r.conceptId)).toEqual(['c1', 'c2']);
    expect(rows[0]).toMatchObject({ title: 'A', vaultNotePath: 'concepts/a.md' });
  });

  it('excludes rows outside the window', () => {
    seedConcept('c1', 'concepts/old.md', 'Old');
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    getDb().insert(schema.deliveredConcepts).values({
      id: 'd1', conceptId: 'c1', chatJid: CHAT, deliveredAt: old,
    }).run();
    expect(getRecentDeliveredConcepts(CHAT, 14)).toEqual([]);
  });

  it('is scoped to chat_jid', () => {
    seedConcept('c1', 'concepts/x.md', 'X');
    getDb().insert(schema.deliveredConcepts).values({
      id: 'd1', conceptId: 'c1', chatJid: OTHER_CHAT,
      deliveredAt: new Date().toISOString(),
    }).run();
    expect(getRecentDeliveredConcepts(CHAT, 14)).toEqual([]);
    expect(getRecentDeliveredConcepts(OTHER_CHAT, 14)).toHaveLength(1);
  });
});
