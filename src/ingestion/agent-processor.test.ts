import { describe, it, expect } from 'vitest';
import { AgentProcessor } from './agent-processor.js';

describe('AgentProcessor prompt', () => {
  const processor = new AgentProcessor({
    vaultDir: '/vault',
    uploadDir: '/upload',
  });

  it('wraps document content in XML tags at the top of the prompt', () => {
    const prompt = processor.buildPrompt(
      'Extracted content here <!-- page:4 label:section_header -->',
      'paper.pdf',
      'job-123',
      ['figure_0_0.png'],
    );

    // Document content should be first (XML-wrapped)
    const docStart = prompt.indexOf('<document>');
    const jobParams = prompt.indexOf('## Job Parameters');
    expect(docStart).toBeLessThan(jobParams);
    expect(prompt).toContain('<source>paper.pdf</source>');
    expect(prompt).toContain('<document_content>');
    expect(prompt).toContain('Extracted content here');
  });

  it('includes job-specific parameters', () => {
    const prompt = processor.buildPrompt('Content', 'paper.pdf', 'job-123', []);

    expect(prompt).toContain('job-123');
    expect(prompt).toContain('job-123-manifest.json');
    expect(prompt).toContain('job-123-complete');
    expect(prompt).toContain('job-123-source.md');
    expect(prompt).toContain('job-123-concept-NNN.md');
    expect(prompt).toContain('upload/processed/job-123-paper.pdf');
  });

  it('does not contain workflow instructions (those live in CLAUDE.md)', () => {
    const prompt = processor.buildPrompt('Content', 'paper.pdf', 'job-123', []);

    // These should be in CLAUDE.md, not the prompt
    expect(prompt).not.toContain('cite-then-generate');
    expect(prompt).not.toContain('Self-Review');
    expect(prompt).not.toContain('verification_status: unverified');
    expect(prompt).not.toContain('_targetPath');
    expect(prompt).not.toContain('courses/');
  });

  it('includes figures when present', () => {
    const prompt = processor.buildPrompt('Content', 'paper.pdf', 'job-123', [
      'figure_0_0.png',
      'figure_1_0.png',
    ]);

    expect(prompt).toContain('<figures>');
    expect(prompt).toContain('figure_0_0.png');
    expect(prompt).toContain('figure_1_0.png');
  });

  it('includes vault manifest when provided', () => {
    const manifest =
      '<existing_vault_notes>\n## Sources\n- paper-a | "Paper A"\n</existing_vault_notes>';
    const prompt = processor.buildPrompt(
      'Content',
      'paper.pdf',
      'job-123',
      [],
      manifest,
    );

    expect(prompt).toContain('<existing_vault_notes>');
    expect(prompt).toContain('paper-a');

    // Manifest should be between document content and job parameters
    const manifestIdx = prompt.indexOf('<existing_vault_notes>');
    const docEnd = prompt.indexOf('</document>');
    const jobParams = prompt.indexOf('## Job Parameters');
    expect(manifestIdx).toBeGreaterThan(docEnd);
    expect(manifestIdx).toBeLessThan(jobParams);
  });

  it('omits manifest section when not provided', () => {
    const prompt = processor.buildPrompt('Content', 'paper.pdf', 'job-123', []);

    expect(prompt).not.toContain('<existing_vault_notes>');
  });
});

describe('AgentProcessor.buildPrompt', () => {
  const processor = new AgentProcessor({
    vaultDir: '/vault',
    uploadDir: '/upload',
  });

  it('includes Zotero metadata preamble when provided', () => {
    const metadata = JSON.stringify({
      title: 'Test Paper',
      creators: [
        { firstName: 'Jane', lastName: 'Doe', creatorType: 'author' },
        { firstName: 'John', lastName: 'Smith', creatorType: 'author' },
      ],
      date: '2025-06-15',
      DOI: '10.1234/test',
      publicationTitle: 'Journal of Testing',
      tags: ['AI', 'Education'],
      abstractNote: 'This paper examines...',
      itemType: 'journalArticle',
    });

    const prompt = processor.buildPrompt(
      'content',
      'file.pdf',
      'job-1',
      [],
      undefined,
      {
        source_type: 'zotero',
        zotero_key: 'ABCD1234',
        zotero_metadata: metadata,
      },
    );

    expect(prompt).toContain('## Source Document Metadata (from Zotero)');
    expect(prompt).toContain('Doe, J.');
    expect(prompt).toContain('Smith, J.');
    expect(prompt).toContain('2025-06-15');
    expect(prompt).toContain('10.1234/test');
    expect(prompt).toContain('Journal of Testing');
    expect(prompt).toContain('AI, Education');
    expect(prompt).toContain('zotero://select/items/ABCD1234');
    expect(prompt).toContain('zotero_key');
  });

  it('omits metadata preamble for upload-sourced jobs', () => {
    const prompt = processor.buildPrompt('content', 'file.pdf', 'job-2', []);

    expect(prompt).not.toContain('Source Document Metadata');
    expect(prompt).toContain('upload/processed/job-2-file.pdf');
  });
});
