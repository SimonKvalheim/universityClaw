import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { runContainerAgent } from '../container-runner.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

export interface AgentProcessorOpts {
  vaultDir: string;
  uploadDir: string;
}

export class AgentProcessor {
  private vaultDir: string;
  private uploadDir: string;

  constructor(opts: AgentProcessorOpts) {
    this.vaultDir = opts.vaultDir;
    this.uploadDir = opts.uploadDir;
  }

  buildPrompt(
    extractedContent: string,
    fileName: string,
    jobId: string,
    figures: string[],
  ): string {
    const draftsPath = `/workspace/extra/vault/drafts`;

    const figuresSection =
      figures.length > 0
        ? `\n## Figures\n\nThe following figures were extracted from the document:\n${figures.map((f) => `- ${f}`).join('\n')}\n\nReference these figures in your notes with descriptive captions.`
        : '';

    return `Process this pre-extracted document and generate structured atomic notes.

## Source Document

Original filename: ${fileName}
Docling has already extracted the content — do NOT attempt to read the original file.
The content includes location markers like <!-- page:N label:TYPE --> before paragraphs.
Use these markers to produce precise citations in your notes.

## Extracted Content

${extractedContent}
${figuresSection}

## Your Task

Generate TWO types of notes from this document:

### 1. Source Overview Note
One source overview note summarizing the document's argument, key contributions, and limitations.
- Filename: ${draftsPath}/${jobId}-source.md
- Frontmatter must include: title, type: source, source_type (paper|lecture|textbook-chapter|article|news), source_file, authors (if available), published (year if available), concepts_generated (slugified titles of concept notes), verification_status: unverified, created (today's date)

### 2. Atomic Concept Notes
Multiple atomic concept notes, one per distinct concept, ~200-500 words each.
- Filename pattern: ${draftsPath}/${jobId}-concept-NNN.md (e.g., ${jobId}-concept-001.md)
- Frontmatter must include: title, type: concept, topics (array), source_doc, source_file, source_pages (array of page numbers), source_sections (array), generated_by: claude, verification_status: unverified, created (today's date)

### source_file Value
Use this path for all notes: upload/processed/${jobId}-${fileName}

## Citation Rules (cite-then-generate)

For each claim you write, you MUST:
1. First identify the specific passage in the source that supports it
   (quote the relevant text internally in <internal> tags)
2. Note the exact location (page number from <!-- page:N --> markers, section, paragraph)
3. Only then write the claim with its footnote citation

Do NOT write a claim first and then search for a citation to attach.
Do NOT make any factual statement without a supporting source passage.
If you cannot ground a claim in a specific passage, flag it as inference:
  "The scaling factor likely prevents gradient issues [inference, not stated in source]"

Use markdown footnotes: [^1], [^2], etc. with references at the bottom:
[^1]: Author, §Section, p.Page ¶Paragraph

## Cross-References

Mention related concepts in prose with [[wikilinks]]:
"Self-attention is the core building block of [[multi-head-attention]]..."

The concepts_generated field in the source note should list slugified titles
matching the concept note titles (e.g., "Self-Attention Mechanism" → self-attention-mechanism).

## Manifest

After writing ALL notes, create a manifest file at:
${draftsPath}/${jobId}-manifest.json

Format:
{
  "source_note": "${jobId}-source.md",
  "concept_notes": ["${jobId}-concept-001.md", "${jobId}-concept-002.md", ...]
}

## Self-Review

After generating all notes, review your own work:
1. Re-read each note you wrote
2. Check: does every claim have a grounded citation? Flag any that don't.
3. Check: are there important concepts from the source that you missed? Add them.
4. Check: are any notes too long (>500 words) or too short (<100 words)? Split or merge.
5. Check: do [[wikilinks]] point to notes you actually created? Fix broken links.
6. Update the manifest if you added or removed notes.
7. Write an empty file to ${draftsPath}/${jobId}-complete to signal you are finished.`;
  }

  async process(
    extractionPath: string,
    fileName: string,
    jobId: string,
    reviewAgentGroup: RegisteredGroup,
  ): Promise<{ status: 'success' | 'error'; error?: string }> {
    const contentFile = join(extractionPath, 'content.md');
    let extractedContent: string;
    try {
      extractedContent = readFileSync(contentFile, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'error',
        error: `Failed to read extraction content: ${message}`,
      };
    }

    const figuresDir = join(extractionPath, 'figures');
    let figures: string[] = [];
    if (existsSync(figuresDir)) {
      try {
        figures = readdirSync(figuresDir).filter((f) =>
          /\.(png|jpg|jpeg|svg|webp)$/i.test(f),
        );
      } catch {
        // Non-fatal
      }
    }

    const prompt = this.buildPrompt(extractedContent, fileName, jobId, figures);

    logger.info(
      { fileName, jobId, figures: figures.length },
      'Starting agent processing',
    );

    try {
      const output = await runContainerAgent(
        reviewAgentGroup,
        {
          prompt,
          groupFolder: reviewAgentGroup.folder,
          chatJid: `ingestion:${jobId}`,
          isMain: false,
          ipcNamespace: jobId,
          singleTurn: false,
        },
        (_proc, _containerName) => {
          // No queue registration needed for ingestion containers
        },
      );

      if (output.status === 'error') {
        logger.error(
          { fileName, jobId, error: output.error },
          'Agent processing failed',
        );
        return { status: 'error', error: output.error };
      }

      logger.info({ fileName, jobId }, 'Agent processing completed');
      return { status: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ fileName, jobId, err }, 'Agent processing error');
      return { status: 'error', error: message };
    }
  }
}
