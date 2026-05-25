import { describe, expect, it, vi } from 'vitest';
import { recordConceptDeliveryHandler } from './ipc-mcp-stdio.js';

describe('record_concept_delivery tool', () => {
  it('returns success block on host ok:true', async () => {
    const sendIpc = vi.fn().mockResolvedValue({
      ok: true, conceptId: 'c1', title: 'Foo',
    });
    const result = await recordConceptDeliveryHandler(
      { concept: 'concepts/foo.md', surface: 'text+voice' },
      { sendIpc, chatJid: 'tg:1', sourceTaskId: 'study-daily-morning' },
    );
    expect(sendIpc).toHaveBeenCalledWith({
      type: 'record_concept_delivery',
      concept: 'concepts/foo.md',
      chatJid: 'tg:1',
      sourceTaskId: 'study-daily-morning',
      surface: 'text+voice',
    });
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as any).text).toMatch(/Recorded delivery of Foo/);
  });

  it('returns isError block on host ok:false', async () => {
    const sendIpc = vi.fn().mockResolvedValue({
      ok: false, error: 'Concept not found: x',
    });
    const result = await recordConceptDeliveryHandler(
      { concept: 'x' },
      { sendIpc, chatJid: 'tg:1' },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toMatch(/Concept not found/);
  });

  it('returns isError block on IPC timeout', async () => {
    const sendIpc = vi.fn().mockRejectedValue(new Error('IPC timeout'));
    const result = await recordConceptDeliveryHandler(
      { concept: 'concepts/foo.md' },
      { sendIpc, chatJid: 'tg:1' },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toMatch(/timeout/i);
  });
});
