import { describe, it, expect } from 'vitest';
import { AgentProcessor } from './agent-processor.js';

describe('AgentProcessor prompt', () => {
  const processor = new AgentProcessor({
    vaultDir: '/vault',
    uploadDir: '/upload',
  });

  it('builds a cite-then-generate prompt with manifest instructions', () => {
    const prompt = processor.buildPrompt(
      'Extracted content here <!-- page:4 label:section_header -->',
      'paper.pdf',
      'job-123',
      ['figure_0_0.png'],
    );

    expect(prompt).toContain('cite-then-generate');
    expect(prompt).toContain('manifest');
    expect(prompt).toContain('job-123-manifest.json');
    expect(prompt).toContain('job-123-complete');
    expect(prompt).toContain('source overview note');
    expect(prompt).toContain('atomic concept notes');
    expect(prompt).not.toContain('_targetPath');
    expect(prompt).not.toContain('courses/');
  });
});
