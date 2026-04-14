import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'url';
import path from 'path';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle/migrations');

export function runMigrations(
  db: BetterSQLite3Database<Record<string, unknown>>,
): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
