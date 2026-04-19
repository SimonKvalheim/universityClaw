export interface SubsystemEntry {
  path: string;
  purpose: string;
}

export const SUBSYSTEMS: SubsystemEntry[] = [
  {
    path: 'src/ingestion/',
    purpose:
      'File watcher → Docling extraction → Claude note generation → auto-promotion to vault.',
  },
  {
    path: 'src/rag/',
    purpose:
      'LightRAG hybrid retrieval with SQLite-tracked indexing; chokidar watcher with content-hash dedup.',
  },
  {
    path: 'src/study/',
    purpose:
      'Study engine, session builder, SM-2 spacing, scaffolding, audio pipeline.',
  },
  {
    path: 'src/vault/',
    purpose: 'Direct Obsidian vault file I/O (gray-matter + wikilinks).',
  },
  {
    path: 'src/channels/',
    purpose:
      'Channel registry and per-channel adapters (telegram, web, slack, etc.).',
  },
  {
    path: 'src/profile/',
    purpose:
      'Student profile: progress tracking, knowledge map, study-log rotation.',
  },
  {
    path: 'src/db/schema/',
    purpose:
      'Canonical Drizzle schema (snake_case SQL columns, camelCase TS properties).',
  },
  {
    path: 'src/voice/',
    purpose:
      'Server-side voice helpers: path-scope guards, voice-log JSON writer, subsystem map.',
  },
  {
    path: 'dashboard/src/app/voice/',
    purpose:
      'Live voice chat UI (/voice page): VoiceSession, audio I/O, cost tracker, captions, preview pane.',
  },
  {
    path: 'dashboard/src/app/study/',
    purpose: 'Dashboard UI for study sessions, plans, analytics.',
  },
  {
    path: 'dashboard/src/app/vault/',
    purpose: 'Dashboard UI for browsing and editing vault notes.',
  },
  {
    path: 'dashboard/src/app/read/',
    purpose: 'Speed reader (RSVP) and book (EPUB) reading surfaces.',
  },
  {
    path: 'dashboard/src/lib/',
    purpose: 'Dashboard-side DB helpers, study math, session builder.',
  },
  {
    path: 'container/',
    purpose:
      'Agent-runner container definition (Dockerfile + TS entrypoint + MCP tool surface).',
  },
  {
    path: 'docs/superpowers/',
    purpose: 'Design specs and implementation plans for major features.',
  },
];
