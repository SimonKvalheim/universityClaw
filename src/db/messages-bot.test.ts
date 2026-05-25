import { beforeEach, describe, expect, it } from 'vitest';
import { _initTestDatabase, storeChatMetadata, storeMessage } from '../db.js';
import { getMessagesSinceIncludingBot } from './messages-bot.js';

const CHAT = 'tg:test';
const EPOCH = '1970-01-01T00:00:00.000Z';

beforeEach(() => {
  _initTestDatabase();
  // storeChatMetadata is positional: (chatJid, timestamp, name?, channel?, isGroup?)
  storeChatMetadata(CHAT, EPOCH, 'Test', undefined, true);
});

describe('getMessagesSinceIncludingBot', () => {
  it('returns both human and bot rows', () => {
    storeMessage({
      id: 'm1',
      chat_jid: CHAT,
      sender: 'simon',
      sender_name: 'Simon',
      content: 'hello',
      timestamp: '2026-05-20T10:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'm2',
      chat_jid: CHAT,
      sender: 'bot',
      sender_name: 'Mr. Rogers',
      content: 'hi simon',
      timestamp: '2026-05-20T10:01:00.000Z',
      is_from_me: false,
      is_bot_message: true,
    });
    const rows = getMessagesSinceIncludingBot(CHAT, EPOCH);
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2']);
  });

  it('respects the since cutoff', () => {
    storeMessage({
      id: 'old',
      chat_jid: CHAT,
      sender: 'simon',
      sender_name: 'Simon',
      content: 'a',
      timestamp: '2026-05-01T00:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'new',
      chat_jid: CHAT,
      sender: 'bot',
      sender_name: 'Mr. Rogers',
      content: 'b',
      timestamp: '2026-05-22T00:00:00.000Z',
      is_from_me: false,
      is_bot_message: true,
    });
    const rows = getMessagesSinceIncludingBot(CHAT, '2026-05-10T00:00:00.000Z');
    expect(rows.map((r) => r.id)).toEqual(['new']);
  });
});
