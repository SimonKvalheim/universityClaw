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
  return renderBlocks(blocks);
}
