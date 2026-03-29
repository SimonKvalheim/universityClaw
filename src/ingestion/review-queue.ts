import { VaultUtility, NoteOutput } from '../vault/vault-utility.js';
import { updateReviewItemStatus } from '../db.js';

export interface DraftInput {
  id: string;
  data: Record<string, unknown>;
  content: string;
  targetPath: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ReviewQueue {
  constructor(private readonly vault: VaultUtility) {}

  async addDraft(draft: DraftInput): Promise<void> {
    await this.vault.createNote(`drafts/${draft.id}.md`, {
      data: {
        ...draft.data,
        _targetPath: draft.targetPath,
        status: 'draft',
      },
      content: draft.content,
    });
  }

  async approveDraft(draftId: string): Promise<{ targetPath: string }> {
    const draftPath = `drafts/${draftId}.md`;
    const note = await this.vault.readNote(draftPath);
    if (!note) {
      throw new Error(`Draft not found: ${draftId}`);
    }

    const targetPath = note.data._targetPath as string;
    const {
      _targetPath: _tp,
      _extractionId: _ei,
      ...remainingData
    } = note.data as Record<string, unknown> & {
      _targetPath?: unknown;
      _extractionId?: unknown;
    };

    const today = new Date().toISOString().split('T')[0];
    const cleanData = { ...remainingData, status: 'approved', reviewed: today };

    // Write to a tmp path then move atomically to avoid clobbering an existing note
    const tmpPath = `drafts/.tmp-${draftId}.md`;
    await this.vault.createNote(tmpPath, {
      data: cleanData,
      content: note.content,
    });
    await this.vault.moveNote(tmpPath, targetPath);
    await this.vault.deleteNote(draftPath);

    updateReviewItemStatus(draftId, 'approved');

    return { targetPath };
  }

  async rejectDraft(draftId: string): Promise<void> {
    await this.vault.deleteNote(`drafts/${draftId}.md`);
    updateReviewItemStatus(draftId, 'rejected');
  }

  async removeFigure(draftId: string, figureFilename: string): Promise<void> {
    const draftPath = `drafts/${draftId}.md`;
    const note = await this.vault.readNote(draftPath);
    if (!note) {
      throw new Error(`Draft not found: ${draftId}`);
    }

    const embedPattern = new RegExp(
      `!\\[\\[${escapeRegex(figureFilename)}\\]\\]\\s*\\n?\\s*(?:\\*\\*Figure:\\*\\*[^\\n]*\\n?)?`,
      'g',
    );

    const updatedContent = note.content.replace(embedPattern, '');

    const figures = Array.isArray(note.data.figures)
      ? (note.data.figures as string[]).filter((f) => f !== figureFilename)
      : note.data.figures;

    await this.vault.createNote(draftPath, {
      data: { ...note.data, figures },
      content: updatedContent,
    });
  }

  async listDrafts(): Promise<NoteOutput[]> {
    const paths = await this.vault.listNotes('drafts');
    const drafts: NoteOutput[] = [];
    for (const p of paths) {
      const note = await this.vault.readNote(p);
      if (note) drafts.push(note);
    }
    return drafts;
  }
}
