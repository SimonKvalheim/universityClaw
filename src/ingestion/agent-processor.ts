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
    vaultManifest?: string,
    jobMeta?: {
      source_type?: string;
      zotero_key?: string | null;
      zotero_metadata?: string | null;
    },
  ): string {
    const draftsPath = `/workspace/extra/vault/drafts`;

    const figuresSection =
      figures.length > 0
        ? `\n<figures>\n${figures.map((f) => `- ${f}`).join('\n')}\n</figures>\n\nReference these figures in your notes with descriptive captions.`
        : '';

    const manifestSection = vaultManifest ? `\n${vaultManifest}\n` : '';

    const isZotero = jobMeta?.source_type === 'zotero';

    let metadataSection = '';
    if (isZotero && jobMeta?.zotero_metadata) {
      try {
        const meta = JSON.parse(jobMeta.zotero_metadata);
        const creators = (meta.creators || [])
          .map(
            (c: { lastName: string; firstName: string }) =>
              `${c.lastName}, ${c.firstName?.[0] || ''}.`,
          )
          .join('; ');
        const tags = (meta.tags || []).join(', ');

        const lines = ['## Source Document Metadata (from Zotero)'];
        if (meta.title) lines.push(`- Title: ${meta.title}`);
        if (creators) lines.push(`- Authors: ${creators}`);
        if (meta.date) lines.push(`- Date: ${meta.date}`);
        if (meta.publicationTitle)
          lines.push(`- Publication: ${meta.publicationTitle}`);
        if (meta.DOI) lines.push(`- DOI: ${meta.DOI}`);
        if (tags) lines.push(`- Tags: ${tags}`);
        if (meta.abstractNote) lines.push(`- Abstract: ${meta.abstractNote}`);

        metadataSection = '\n' + lines.join('\n') + '\n';
      } catch {
        // Non-fatal: skip metadata if JSON is malformed
      }
    }

    const sourceFileValue =
      isZotero && jobMeta?.zotero_key
        ? `zotero://select/items/${jobMeta.zotero_key}`
        : `upload/processed/${jobId}-${fileName}`;

    const zoteroKeyLine =
      isZotero && jobMeta?.zotero_key
        ? `\n- **zotero_key for frontmatter:** ${jobMeta.zotero_key}`
        : '';

    // Document content first (top of prompt) for better attention quality,
    // then slim task parameters. Workflow instructions live in CLAUDE.md.
    // See docs/research/2026-03-30-agent-prompt-architecture.md
    return `<document>
<source>${fileName}</source>
<document_content>
${extractedContent}
</document_content>
</document>
${figuresSection}${metadataSection}${manifestSection}
## Job Parameters

- **Job ID:** ${jobId}
- **Source filename:** ${fileName}
- **Drafts path:** ${draftsPath}
- **source_file value for frontmatter:** ${sourceFileValue}${zoteroKeyLine}
- **Source note filename:** ${draftsPath}/${jobId}-source.md
- **Concept note pattern:** ${draftsPath}/${jobId}-concept-NNN.md
- **Manifest path:** ${draftsPath}/${jobId}-manifest.json
- **Completion sentinel:** ${draftsPath}/${jobId}-complete

The content above has been pre-extracted by Docling. Do NOT read the original file.
Location markers like \`<!-- page:N label:TYPE -->\` indicate source positions — use them for citations.

Process this document following your ingestion workflow.`;
  }

  async process(
    extractionPath: string,
    fileName: string,
    jobId: string,
    reviewAgentGroup: RegisteredGroup,
    vaultManifest?: string,
    jobMeta?: {
      source_type?: string;
      zotero_key?: string | null;
      zotero_metadata?: string | null;
    },
  ): Promise<{ status: 'success' | 'error'; error?: string }> {
    const cleanContentFile = join(extractionPath, 'content.clean.md');
    const rawContentFile = join(extractionPath, 'content.md');
    const contentFile = existsSync(cleanContentFile)
      ? cleanContentFile
      : rawContentFile;
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

    const prompt = this.buildPrompt(
      extractedContent,
      fileName,
      jobId,
      figures,
      vaultManifest,
      jobMeta,
    );

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
