import Database from 'better-sqlite3';
import { join } from 'path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

type DashboardDb = BetterSQLite3Database<typeof schema>;

let _db: DashboardDb | null = null;

export function getDb(): DashboardDb {
  if (!_db) {
    const storeDir =
      process.env.STORE_DIR ?? join(process.cwd(), '..', 'store');
    const dbPath = join(storeDir, 'messages.db');
    const sqlite = new Database(dbPath, { readonly: false });
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    _db = drizzle(sqlite, { schema });
  }
  return _db;
}
