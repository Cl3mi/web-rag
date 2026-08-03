import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CollectorRow } from './scoring';

export class CollectorStore {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL,
        system_label TEXT NOT NULL,
        query_id     TEXT NOT NULL,
        row_json     TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(session_id);
    `);
  }

  insert(sessionId: string, systemLabel: string, row: CollectorRow): void {
    this.db
      .prepare('INSERT INTO runs (session_id, system_label, query_id, row_json) VALUES (?, ?, ?, ?)')
      .run(sessionId, systemLabel, row.queryId, JSON.stringify(row));
  }

  rowsForSession(sessionId: string): CollectorRow[] {
    const rows = this.db
      .prepare('SELECT row_json FROM runs WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as { row_json: string }[];
    return rows.map((r) => JSON.parse(r.row_json) as CollectorRow);
  }

  systemLabel(sessionId: string): string | null {
    const r = this.db
      .prepare('SELECT system_label FROM runs WHERE session_id = ? ORDER BY id ASC LIMIT 1')
      .get(sessionId) as { system_label: string } | undefined;
    return r?.system_label ?? null;
  }

  sessions(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT session_id FROM runs ORDER BY session_id ASC')
      .all() as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }
}

let cached: CollectorStore | null = null;

export function getCollectorStore(dbPath: string): CollectorStore {
  if (!cached) cached = new CollectorStore(dbPath);
  return cached;
}
