import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { DATA_DIR, STORE_DIR } from '../config.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import * as schema from './schema/index.js';
import { runMigrations } from './migrate.js';

// Module-level state
let db: BetterSQLite3Database<typeof schema>;
let rawSqlite: Database.Database;

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  rawSqlite = new Database(dbPath);
  rawSqlite.pragma('journal_mode = WAL');
  rawSqlite.pragma('foreign_keys = ON');

  db = drizzle(rawSqlite, { schema });

  runMigrations(db);
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  rawSqlite = new Database(':memory:');
  rawSqlite.pragma('foreign_keys = ON');

  db = drizzle(rawSqlite, { schema });

  runMigrations(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  if (rawSqlite) rawSqlite.close();
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  return db;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- TODO: Task 5 stubs (required by migrateJsonState) ---

export function setRouterState(key: string, value: string): void {
  // Task 5
  void key;
  void value;
}

export function setSession(groupFolder: string, sessionId: string): void {
  // Task 5
  void groupFolder;
  void sessionId;
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  // Task 5
  void jid;
  void group;
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder: ${group.folder}`);
  }
}
