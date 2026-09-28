// SQLite (node:sqlite, WAL) on the Fly volume. Small, append-mostly tables.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

export function openDb(dir: string): Db {
  mkdirSync(dir, {recursive: true});
  const db = new DatabaseSync(path.join(dir, 'dino.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS champions (
      version INTEGER PRIMARY KEY, gen INTEGER NOT NULL, genome TEXT NOT NULL,
      gate TEXT NOT NULL, promoted_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, seed INTEGER NOT NULL, start_wall INTEGER NOT NULL,
      segments TEXT NOT NULL, ended_at INTEGER, frames INTEGER, crashed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS checkpoints (
      run_id INTEGER NOT NULL, frame INTEGER NOT NULL, snapshot TEXT NOT NULL,
      PRIMARY KEY (run_id, frame));
    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT, run_id INTEGER,
      frames INTEGER, speed REAL, obstacles TEXT, snapshot TEXT NOT NULL, genome TEXT NOT NULL,
      drops TEXT, created_at INTEGER NOT NULL, pulled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS races (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, seed INTEGER NOT NULL,
      frames INTEGER NOT NULL, score INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, verdict TEXT NOT NULL,
      created_at INTEGER NOT NULL);
  `);
  return db;
}

export function getMeta<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as {value: string} | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setMeta(db: Db, key: string, value: unknown): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
}
