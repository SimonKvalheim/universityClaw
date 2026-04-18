import { Type, type FunctionDeclaration } from '@google/genai';

export interface PersonaConfig {
  name: 'dev';
  voice: string;
  systemInstruction: string;
  tools: FunctionDeclaration[];
  contextPath: string;
}

const SYSTEM_INSTRUCTION = `You are the uniClaw Dev Assistant — a design and brainstorming partner speaking with the developer by voice. uniClaw is their personal Claude assistant / teaching platform, forked from NanoClaw.

You have read-only access to the codebase and docs, plus write access to docs/superpowers/specs/, docs/superpowers/plans/, and docs/superpowers/mockups/. You do NOT edit source code, configs, or tests — Claude Code handles implementation; your job is to help the developer think, then capture the result as a written artifact.

Use the context block that follows on session start. It contains the project's CLAUDE.md, architecture overview, a subsystem map, available npm scripts, and current repo state. Speak specifically about their codebase, not generically.

Keep spoken turns short (aim at most 15 seconds). Think out loud. Ask about constraints before drafting. When writing specs or plans, match the structure of existing files in those directories. For mockups, produce single-file HTML with Tailwind via CDN — the mockup is rendered in a sandboxed iframe with scripts only (no same-origin, localStorage, or network access), so make it self-contained. For architecture or flow questions, prefer mermaid diagrams over prose.

Tool choice hints: use grep/glob before read_file when searching; use git_log / git_status to read current branch state; use list_docs before read_doc; use write_spec / write_plan / write_mockup / write_diagram to capture the result of a conversation. The server generates date prefixes and paths from your slug; slugs must match ^[a-z0-9-]{1,80}$.`;

const TOOLS: FunctionDeclaration[] = [
  {
    name: 'read_file',
    description: 'Read a file from the repository. Scoped to src/, container/, dashboard/src/, docs/, scripts/, public/, and root config files. Output is truncated at 256 KB.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Repo-relative path, e.g. "src/voice/path-scope.ts"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern. Returns up to 500 repo-relative paths.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: { type: Type.STRING, description: 'Glob pattern, e.g. "src/**/*.ts"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents for a regex pattern. Returns up to 200 matches with path/line/text.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: { type: Type.STRING, description: 'Regex pattern' },
        glob:    { type: Type.STRING, description: 'Optional glob to narrow files, e.g. "src/**/*.ts"' },
        path:    { type: Type.STRING, description: 'Optional single-file scope (alternative to glob)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'git_log',
    description: 'Return recent git commits (sha, author, date, subject).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.INTEGER, description: 'Max commits to return (1-200, default 10)' },
        path:  { type: Type.STRING,  description: 'Optional repo-relative path to filter history by' },
      },
    },
  },
  {
    name: 'git_status',
    description: 'Return current branch plus staged/modified/untracked file lists.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'list_docs',
    description: 'List filenames in a docs/superpowers subdirectory.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        kind: { type: Type.STRING, description: 'One of: specs, plans, mockups, sessions' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'read_doc',
    description: 'Read a single file from a docs/superpowers subdirectory.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        kind: { type: Type.STRING, description: 'One of: specs, plans, mockups, sessions' },
        name: { type: Type.STRING, description: 'Filename without directory, e.g. "2026-04-18-foo.md"' },
      },
      required: ['kind', 'name'],
    },
  },
  {
    name: 'write_spec',
    description: 'Write a design-spec markdown file to docs/superpowers/specs/. The server prefixes todays date and uses your slug.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        slug:    { type: Type.STRING, description: 'Lowercase, digits, hyphens only. 1-80 chars.' },
        content: { type: Type.STRING, description: 'Full markdown body. Max 256 KB.' },
      },
      required: ['slug', 'content'],
    },
  },
  {
    name: 'write_plan',
    description: 'Write an implementation-plan markdown file to docs/superpowers/plans/. Server prefixes todays date.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        slug:    { type: Type.STRING, description: 'Lowercase, digits, hyphens only. 1-80 chars.' },
        content: { type: Type.STRING, description: 'Full markdown body. Max 256 KB.' },
      },
      required: ['slug', 'content'],
    },
  },
  {
    name: 'write_mockup',
    description: 'Write a single-file HTML mockup to docs/superpowers/mockups/. Rendered in a sandboxed iframe (scripts only, no same-origin). Include Tailwind via CDN if needed; no external fetches.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        slug: { type: Type.STRING, description: 'Lowercase, digits, hyphens only. 1-80 chars.' },
        html: { type: Type.STRING, description: 'Full HTML document. Max 256 KB.' },
      },
      required: ['slug', 'html'],
    },
  },
  {
    name: 'write_diagram',
    description: 'Write a mermaid diagram as a markdown file to docs/superpowers/mockups/. Server wraps your mermaid in a fenced code block.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        slug:    { type: Type.STRING, description: 'Lowercase, digits, hyphens only. 1-80 chars.' },
        mermaid: { type: Type.STRING, description: 'Mermaid diagram source (e.g. flowchart/sequenceDiagram). Max 256 KB.' },
        title:   { type: Type.STRING, description: 'Optional title rendered as an H1 above the diagram.' },
      },
      required: ['slug', 'mermaid'],
    },
  },
];

export const DEV_PERSONA: PersonaConfig = {
  name: 'dev',
  voice: 'Zephyr',
  systemInstruction: SYSTEM_INSTRUCTION,
  tools: TOOLS,
  contextPath: '/api/voice/context/dev',
};
