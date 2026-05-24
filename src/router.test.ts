import { describe, expect, it, vi } from 'vitest';
import { routeOutbound } from './router.js';

function makeChannel(jid: string) {
  return {
    name: 'mock',
    ownsJid: (j: string) => j === jid,
    isConnected: () => true,
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('routeOutbound', () => {
  it('logs and sends for non-empty text', async () => {
    const ch = makeChannel('tg:1');
    const logSpy = vi.fn();
    await routeOutbound([ch], 'tg:1', 'hello', undefined, logSpy);
    expect(logSpy).toHaveBeenCalledWith('tg:1', 'hello', undefined);
    expect(ch.sendMessage).toHaveBeenCalledWith('tg:1', 'hello');
  });

  it('forwards senderName for swarm sub-bots', async () => {
    const ch = makeChannel('tg:1');
    const logSpy = vi.fn();
    await routeOutbound([ch], 'tg:1', 'sub message', 'Researcher', logSpy);
    expect(logSpy).toHaveBeenCalledWith('tg:1', 'sub message', 'Researcher');
  });

  it('strips <internal> tags before logging and sending', async () => {
    const ch = makeChannel('tg:1');
    const logSpy = vi.fn();
    await routeOutbound([ch], 'tg:1', '<internal>shh</internal>visible', undefined, logSpy);
    expect(logSpy).toHaveBeenCalledWith('tg:1', 'visible', undefined);
    expect(ch.sendMessage).toHaveBeenCalledWith('tg:1', 'visible');
  });

  it('short-circuits on empty text — no log, no send', async () => {
    const ch = makeChannel('tg:1');
    const logSpy = vi.fn();
    await routeOutbound([ch], 'tg:1', '<internal>only-internal</internal>', undefined, logSpy);
    expect(logSpy).not.toHaveBeenCalled();
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });
});
