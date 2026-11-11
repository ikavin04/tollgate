import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from './schema';
import { seedProducts } from './seed-products';

const globalForDb = globalThis as unknown as {
  __tollgateDb?: Database.Database;
};

export function resolveDatabasePath(): string {
  const configured = process.env.DATABASE_PATH?.trim();
  if (configured) {
    return configured;
  }
  return path.join(process.cwd(), 'data', 'tollgate.db');
}

function configureDatabase(db: Database.Database, isMemory: boolean): void {
  if (!isMemory) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applyMigrations(db);
  seedProducts(db);
}

/**
 * Opens an isolated SQLite database (useful for tests with ':memory:' or temp paths).
 */
export function openDatabase(dbPath: string): Database.Database {
  const isMemory = dbPath === ':memory:' || dbPath.startsWith('file::memory:');
  if (!isMemory) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  const db = new Database(dbPath);
  configureDatabase(db, isMemory);
  return db;
}

/**
 * Returns the initialized singleton SQLite database for the application.
 */
export function getDb(): Database.Database {
  if (globalForDb.__tollgateDb) {
    return globalForDb.__tollgateDb;
  }
  const dbPath = resolveDatabasePath();
  const db = openDatabase(dbPath);
  globalForDb.__tollgateDb = db;
  return db;
}

/**
 * Allows tests to inject or clear a test database instance safely.
 */
export function setDbForTests(db: Database.Database | undefined): void {
  globalForDb.__tollgateDb = db;
}

