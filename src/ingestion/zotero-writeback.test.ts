import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZoteroWriteBack } from './zotero-writeback.js';
import { ZoteroWebClient } from './zotero-client.js';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

describe('ZoteroWriteBack', () => {
  let writeBack: ZoteroWriteBack;
  let mockWebClient: {
    createChildNote: ReturnType<typeof vi.fn>;
    addTag: ReturnType<typeof vi.fn>;
    getLibraryVersion: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockWebClient = {
      createChildNote: vi.fn().mockResolvedValue(undefined),
      addTag: vi.fn().mockResolvedValue(undefined),
      getLibraryVersion: vi.fn().mockResolvedValue(100),
    };
    writeBack = new ZoteroWriteBack(mockWebClient as unknown as ZoteroWebClient);
  });

  it('writes summary note and tag to Zotero', async () => {
    const sourceContent = '---\ntitle: Test Paper\n---\n\nThis is the summary body.';
    const promotedPaths = ['sources/test-paper.md', 'concepts/concept-1.md', 'concepts/concept-2.md'];

    await writeBack.writeBack('ABC12345', sourceContent, promotedPaths);

    expect(mockWebClient.createChildNote).toHaveBeenCalledWith(
      'ABC12345',
      expect.stringContaining('This is the summary body.'),
      100,
    );
    expect(mockWebClient.createChildNote).toHaveBeenCalledWith(
      'ABC12345',
      expect.stringContaining('2 concepts'),
      100,
    );
    expect(mockWebClient.addTag).toHaveBeenCalledWith('ABC12345', 'vault:ingested');
  });

  it('converts markdown to basic HTML', async () => {
    const sourceContent = '---\ntitle: Test\n---\n\n**Bold** and *italic* text.\n\nSecond paragraph.';

    await writeBack.writeBack('ABC12345', sourceContent, ['sources/test.md']);

    const noteHtml = mockWebClient.createChildNote.mock.calls[0][1] as string;
    expect(noteHtml).toContain('<strong>Bold</strong>');
    expect(noteHtml).toContain('<em>italic</em>');
    expect(noteHtml).toContain('<p>Second paragraph.</p>');
  });

  it('retries once on version conflict (412)', async () => {
    mockWebClient.createChildNote
      .mockRejectedValueOnce(new Error('Zotero version conflict (412)'))
      .mockResolvedValueOnce(undefined);
    mockWebClient.getLibraryVersion
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(101);

    const sourceContent = '---\ntitle: Test\n---\n\nBody.';
    await writeBack.writeBack('ABC12345', sourceContent, ['sources/test.md']);

    expect(mockWebClient.createChildNote).toHaveBeenCalledTimes(2);
    expect(mockWebClient.getLibraryVersion).toHaveBeenCalledTimes(2);
  });

  it('does not throw on write-back failure', async () => {
    mockWebClient.createChildNote.mockRejectedValue(new Error('Network error'));

    const sourceContent = '---\ntitle: Test\n---\n\nBody.';
    // Should not throw
    await writeBack.writeBack('ABC12345', sourceContent, ['sources/test.md']);
  });
});
