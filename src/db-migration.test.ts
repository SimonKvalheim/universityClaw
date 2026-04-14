import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('creates all tables on a fresh database', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      vi.resetModules();
      const { initDatabase, getDb, _closeDatabase } = await import('./db.js');
      const { sql } = await import('drizzle-orm');

      initDatabase();

      const db = getDb();

      const tables = db
        .all(sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`) as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);

      const expectedTables = [
        'chats',
        'citation_edges',
        'ingestion_jobs',
        'messages',
        'rag_index_tracker',
        'registered_groups',
        'router_state',
        'scheduled_tasks',
        'sessions',
        'settings',
        'task_run_logs',
        'zotero_sync',
      ];

      for (const table of expectedTables) {
        expect(tableNames, `Expected table "${table}" to exist`).toContain(table);
      }

      // Spot-check key columns via PRAGMA
      const ingestionCols = db
        .all(sql`PRAGMA table_info(ingestion_jobs)`) as Array<{ name: string }>;
      const ingestionColNames = ingestionCols.map((c) => c.name);
      expect(ingestionColNames).toContain('promoted_paths');
      expect(ingestionColNames).toContain('source_type');
      expect(ingestionColNames).toContain('content_hash');

      const chatCols = db
        .all(sql`PRAGMA table_info(chats)`) as Array<{ name: string }>;
      const chatColNames = chatCols.map((c) => c.name);
      expect(chatColNames).toContain('channel');
      expect(chatColNames).toContain('is_group');

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('defaults Telegram backfill chats to direct messages on an existing database', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(`INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`)
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(`INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`)
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(`INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`)
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } = await import('./db.js');

      initDatabase();

      const chats = getAllChats();

      // Existing rows survive
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toBeDefined();
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toBeDefined();
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toBeDefined();

      // Legacy column migration backfills channel and is_group
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});
