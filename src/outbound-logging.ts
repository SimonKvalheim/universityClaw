import { randomUUID } from 'node:crypto';
import * as dbModule from './db.js';
import { logger } from './logger.js';

/**
 * Log a bot outbound message to the messages table.
 *
 * - Skips empty / whitespace-only text (logging is observability, not load-bearing).
 * - Falls back to ASSISTANT_NAME env var, then 'Assistant', for the sender name.
 * - Swallows storeMessage failures so a DB error never blocks sending.
 *
 * @param chatJid    - The chat JID the message was sent to.
 * @param text       - The message text that was sent.
 * @param senderName - Optional override for sender_name (e.g. swarm sub-bot identity).
 */
export function logBotOutbound(
  chatJid: string,
  text: string,
  senderName?: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const name = senderName || process.env.ASSISTANT_NAME || 'Assistant';

  try {
    dbModule.storeMessage({
      id: randomUUID(),
      chat_jid: chatJid,
      sender: 'bot',
      sender_name: name,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: true,
    });
  } catch (err) {
    logger.warn({ err, chatJid }, 'Failed to log outbound bot message');
  }
}
