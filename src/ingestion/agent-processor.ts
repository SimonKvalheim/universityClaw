import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { runContainerAgent } from '../container-runner.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
export interface PathContext {
  semester: number | null;
  year: number | null;
  courseCode: string | null;
  courseName: string | null;
  type: string | null;
  fileName: string;
}

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
    context: PathContext,
    draftId: string,
    figures: string[],
  ): string {
    const vaultDraftPath = `/workspace/extra/vault/drafts/${draftId}.md`;

    const metadataLines: string[] = [];
    if (context.courseCode)
      metadataLines.push(`- Course code: ${context.courseCode}`);
    if (context.courseName)
      metadataLines.push(`- Course name: ${context.courseName}`);
    if (context.semester) metadataLines.push(`- Semester: ${context.semester}`);
    if (context.year) metadataLines.push(`- Year: ${context.year}`);
    if (context.type) metadataLines.push(`- Material type: ${context.type}`);

    const metadataSection =
      metadataLines.length > 0
        ? `The folder structure suggests:\n${metadataLines.join('\n')}\n\nUse this as a starting point but verify against the document content.`
        : 'No metadata was inferred from the folder structure. Determine all metadata from the document content.';

    const figuresSection =
      figures.length > 0
        ? `\n## Figures\n\nThe following figures were extracted from the document:\n${figures.map((f) => `- ${f}`).join('\n')}\n\nReference these figures in your notes with descriptive captions that explain what each figure shows and why it matters.`
        : '';

    return `Process this pre-extracted document content and generate structured study notes.

## Source Document

Original filename: ${fileName}
Docling has already extracted the content — do NOT attempt to read the original file.

## Extracted Content

${extractedContent}
${figuresSection}

## Inferred Metadata

${metadataSection}

## Output

Write the generated note (with YAML frontmatter) to: ${vaultDraftPath}

The _targetPath in frontmatter should be: courses/${context.courseCode || '_unsorted'}/${context.type || 'unsorted'}/${fileName.replace(/\.[^.]+$/, '.md')}

### Note Format Requirements

- Use H2 (##) for major sections and H3 (###) for subsections
- Add a contextual prefix to each section heading that indicates its role (e.g. "## Overview: TCP Connection Lifecycle")
- Include a \`concepts\` array in the YAML frontmatter listing the key concepts covered
- For each referenced figure, write a descriptive caption explaining what it shows and its significance
- Follow the instructions in your CLAUDE.md for note format and metadata schema`;
  }

  async process(
    extractionPath: string,
    fileName: string,
    context: PathContext,
    draftId: string,
    reviewAgentGroup: RegisteredGroup,
  ): Promise<{ status: 'success' | 'error'; error?: string }> {
    // Read clean markdown from extraction output
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

    // List figures from extraction output
    const figuresDir = join(extractionPath, 'figures');
    let figures: string[] = [];
    if (existsSync(figuresDir)) {
      try {
        figures = readdirSync(figuresDir).filter((f) =>
          /\.(png|jpg|jpeg|svg|webp)$/i.test(f),
        );
      } catch {
        // Non-fatal: proceed without figures
      }
    }

    const prompt = this.buildPrompt(
      extractedContent,
      fileName,
      context,
      draftId,
      figures,
    );

    logger.info(
      { fileName, draftId, figures: figures.length },
      'Starting agent processing',
    );

    try {
      const output = await runContainerAgent(
        reviewAgentGroup,
        {
          prompt,
          groupFolder: reviewAgentGroup.folder,
          chatJid: `ingestion:${draftId}`,
          isMain: false,
          ipcNamespace: draftId,
          singleTurn: true,
        },
        (_proc, _containerName) => {
          // No queue registration needed for ingestion containers
        },
      );

      if (output.status === 'error') {
        logger.error(
          { fileName, draftId, error: output.error },
          'Agent processing failed',
        );
        return { status: 'error', error: output.error };
      }

      logger.info({ fileName, draftId }, 'Agent processing completed');
      return { status: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ fileName, draftId, err }, 'Agent processing error');
      return { status: 'error', error: message };
    }
  }
}
