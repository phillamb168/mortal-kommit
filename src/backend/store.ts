import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Match } from '../core/types.js';

export class Store extends EventEmitter {
  db: DatabaseSync;
  constructor(public directory: string) {
    super();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'arena.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, updated INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=1;',
    );
  }
  get(id: string): Match | null {
    const row = this.db.prepare('SELECT data FROM matches WHERE id=?').get(id) as
      { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  list(): Match[] {
    return (
      this.db.prepare('SELECT data FROM matches ORDER BY updated DESC').all() as unknown as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }
  save(match: Match) {
    match.updatedAt = Date.now();
    this.db
      .prepare(
        'INSERT INTO matches VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data',
      )
      .run(match.id, match.updatedAt, JSON.stringify(match));
    this.emit('change', match);
  }
  record(id: string, kind: string, data: unknown): boolean {
    return (
      Number(
        this.db
          .prepare('INSERT OR IGNORE INTO records VALUES(?,?,?)')
          .run(id, kind, JSON.stringify(data)).changes,
      ) > 0
    );
  }
  hasRecord(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM records WHERE id=?').get(id);
  }
  records(kind: string): any[] {
    return (
      this.db.prepare('SELECT data FROM records WHERE kind=?').all(kind) as unknown as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }
  meta(key: string, value?: unknown): any {
    if (value !== undefined) {
      this.db
        .prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, JSON.stringify(value));
      return value;
    }
    const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as
      { value: string } | undefined;
    return r ? JSON.parse(r.value) : null;
  }
  close() {
    this.db.close();
  }
}
