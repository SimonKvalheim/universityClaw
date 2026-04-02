interface Block {
  marker: string;
  page: number;
  label: string;
  content: string;
}

const MARKER_RE = /^<!--\s*page:(\d+)\s+label:(\S+)\s*-->$/;

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let current: {
    marker: string;
    page: number;
    label: string;
    lines: string[];
  } | null = null;

  for (const line of lines) {
    const m = MARKER_RE.exec(line);
    if (m) {
      if (current) {
        blocks.push({
          marker: current.marker,
          page: current.page,
          label: current.label,
          content: current.lines.join('\n').trim(),
        });
      }
      current = {
        marker: line,
        page: parseInt(m[1], 10),
        label: m[2],
        lines: [],
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    blocks.push({
      marker: current.marker,
      page: current.page,
      label: current.label,
      content: current.lines.join('\n').trim(),
    });
  }
  return blocks;
}

function deduplicateAdjacent(blocks: Block[]): Block[] {
  const result: Block[] = [];
  for (const block of blocks) {
    const prev = result[result.length - 1];
    if (prev && prev.page === block.page && prev.content === block.content) {
      continue;
    }
    result.push(block);
  }
  return result;
}

function collapseNoise(blocks: Block[]): Block[] {
  const result: Block[] = [];
  let run: Block[] = [];

  function flushRun() {
    if (run.length === 0) return;
    if (run.length === 1) {
      result.push(run[0]);
    } else {
      result.push({
        marker: run[0].marker,
        page: run[0].page,
        label: run[0].label,
        content: run.map((b) => b.content).join(' '),
      });
    }
    run = [];
  }

  for (const block of blocks) {
    const isShortText = block.label === 'text' && block.content.length < 50;

    if (isShortText) {
      if (run.length > 0 && run[0].page !== block.page) {
        flushRun();
      }
      run.push(block);
    } else {
      flushRun();
      result.push(block);
    }
  }
  flushRun();
  return result;
}

const REFERENCES_RE = /^##\s+(References|Bibliography|Works Cited)\s*$/i;
const SUPPLEMENTARY_RE = /^##\s+(Appendix|Supplementary|Supporting Information)\s*$/i;

function stripTail(
  blocks: Block[],
  headingPattern: RegExp,
  threshold: number,
): Block[] {
  const total = blocks.length;
  if (total === 0) return blocks;

  for (let i = 0; i < total; i++) {
    if (
      blocks[i].label === 'section_header' &&
      headingPattern.test(blocks[i].content)
    ) {
      const position = i / total;
      if (position >= threshold) {
        return blocks.slice(0, i);
      }
    }
  }
  return blocks;
}

function renderBlocks(blocks: Block[]): string {
  return blocks
    .map((b) => (b.content ? `${b.marker}\n${b.content}` : b.marker))
    .join('\n\n');
}

export function cleanExtraction(markdown: string): string {
  if (!markdown.trim()) return '';

  let blocks = parseBlocks(markdown);
  blocks = deduplicateAdjacent(blocks);
  blocks = collapseNoise(blocks);
  blocks = stripTail(blocks, REFERENCES_RE, 0.6);
  blocks = stripTail(blocks, SUPPLEMENTARY_RE, 0.7);
  return renderBlocks(blocks);
}
