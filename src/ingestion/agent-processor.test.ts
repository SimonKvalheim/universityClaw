import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentProcessor } from './agent-processor.js';

// Mock the container runner
vi.mock('../container-runner.js', () => ({
  runContainerAgent: vi.fn(),
}));

vi.mock('../db.js', () => ({
  getAllRegisteredGroups: vi.fn(() => ({})),
  setRegisteredGroup: vi.fn(),
}));

describe('AgentProcessor', () => {
  let processor: AgentProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new AgentProcessor({
      vaultDir: '/tmp/test-vault',
      uploadDir: '/tmp/test-upload',
    });
  });

  it('builds a prompt with extracted content and metadata context', () => {
    const prompt = processor.buildPrompt(
      '# TCP\n\nTransmission Control Protocol content here.',
      '03_TCP.pdf',
      {
        courseCode: 'IS-1500',
        courseName: 'Digital Samhandling',
        semester: 3,
        year: 2,
        type: 'lecture',
        fileName: '03_TCP.pdf',
      },
      'draft-id-123',
      [],
    );

    expect(prompt).toContain('03_TCP.pdf');
    expect(prompt).toContain('IS-1500');
    expect(prompt).toContain('Digital Samhandling');
    expect(prompt).toContain('draft-id-123');
    expect(prompt).toContain('TCP\n\nTransmission Control Protocol content here.');
    // Should NOT contain old file path reference
    expect(prompt).not.toContain('/workspace/extra/upload/');
  });

  it('builds prompt with null metadata gracefully', () => {
    const prompt = processor.buildPrompt(
      '# Random content',
      'random.pdf',
      {
        courseCode: null,
        courseName: null,
        semester: null,
        year: null,
        type: null,
        fileName: 'random.pdf',
      },
      'draft-id-456',
      [],
    );

    expect(prompt).toContain('random.pdf');
    expect(prompt).toContain('draft-id-456');
    expect(prompt).not.toContain('IS-1500');
  });

  it('includes figures section when figures are provided', () => {
    const prompt = processor.buildPrompt(
      '# Network Diagram',
      'lecture.pdf',
      {
        courseCode: 'IS-1500',
        courseName: null,
        semester: null,
        year: null,
        type: 'lecture',
        fileName: 'lecture.pdf',
      },
      'draft-id-789',
      ['figure-001.png', 'figure-002.png'],
    );

    expect(prompt).toContain('figure-001.png');
    expect(prompt).toContain('figure-002.png');
    expect(prompt).toContain('Figures');
  });

  it('omits figures section when no figures are provided', () => {
    const prompt = processor.buildPrompt(
      '# Content',
      'lecture.pdf',
      {
        courseCode: null,
        courseName: null,
        semester: null,
        year: null,
        type: null,
        fileName: 'lecture.pdf',
      },
      'draft-id-000',
      [],
    );

    expect(prompt).not.toContain('Figures');
  });
});
