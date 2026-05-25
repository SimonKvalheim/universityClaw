import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

beforeEach(() => {
  vi.resetModules();
});

describe('logBotOutbound', () => {
  it('writes a bot row for non-empty text using ASSISTANT_NAME by default', async () => {
    process.env.ASSISTANT_NAME = 'Mr. Rogers';
    const dbMod = await import('./db.js');
    const { getDb } = await import('./db/index.js');
    const schema = await import('./db/schema/index.js');
    dbMod._initTestDatabase();
    dbMod.storeChatMetadata(
      'tg:1',
      '2026-05-24T00:00:00.000Z',
      'Test',
      undefined,
      true,
    );
    const { logBotOutbound } = await import('./outbound-logging.js');
    logBotOutbound('tg:1', 'Hello world');
    const rows = getDb()
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.chat_jid, 'tg:1'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sender: 'bot',
      sender_name: 'Mr. Rogers',
      content: 'Hello world',
      is_bot_message: 1,
      is_from_me: 0,
    });
  });

  it('uses the senderName argument when provided (swarm sub-bot)', async () => {
    const dbMod = await import('./db.js');
    const { getDb } = await import('./db/index.js');
    const schema = await import('./db/schema/index.js');
    dbMod._initTestDatabase();
    dbMod.storeChatMetadata(
      'tg:1',
      '2026-05-24T00:00:00.000Z',
      'Test',
      undefined,
      true,
    );
    const { logBotOutbound } = await import('./outbound-logging.js');
    logBotOutbound('tg:1', 'sub-bot speaking', 'Researcher');
    const rows = getDb()
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.chat_jid, 'tg:1'))
      .all();
    expect(rows[0].sender_name).toBe('Researcher');
  });

  it('skips empty and whitespace-only text', async () => {
    const dbMod = await import('./db.js');
    const { getDb } = await import('./db/index.js');
    const schema = await import('./db/schema/index.js');
    dbMod._initTestDatabase();
    dbMod.storeChatMetadata(
      'tg:1',
      '2026-05-24T00:00:00.000Z',
      'Test',
      undefined,
      true,
    );
    const { logBotOutbound } = await import('./outbound-logging.js');
    logBotOutbound('tg:1', '');
    logBotOutbound('tg:1', '   ');
    const rows = getDb().select().from(schema.messages).all();
    expect(rows).toEqual([]);
  });

  it('swallows storeMessage errors without throwing', async () => {
    const dbMod = await import('./db.js');
    dbMod._initTestDatabase();
    dbMod.storeChatMetadata(
      'tg:1',
      '2026-05-24T00:00:00.000Z',
      'Test',
      undefined,
      true,
    );
    const spy = vi.spyOn(dbMod, 'storeMessage').mockImplementation(() => {
      throw new Error('forced failure');
    });
    const { logBotOutbound } = await import('./outbound-logging.js');
    expect(() => logBotOutbound('tg:1', 'x')).not.toThrow();
    spy.mockRestore();
  });
});
