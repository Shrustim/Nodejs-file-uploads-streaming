import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    expected_size INTEGER NOT NULL,
    expected_sha256 TEXT NOT NULL,
    incoming_key TEXT NOT NULL UNIQUE,
    version_id TEXT,
    clean_key TEXT,
    quarantine_key TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'PENDING_UPLOAD', 'UPLOADED', 'SCANNING', 'READY', 'QUARANTINED', 'SCAN_ERROR'
    )),
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_files_scan ON files(status, created_at);
`);

export function createFile(row) {
  db.prepare(`INSERT INTO files
    (id, user_id, original_name, content_type, expected_size, expected_sha256, incoming_key, status)
    VALUES (@id, @user_id, @original_name, @content_type, @expected_size, @expected_sha256, @incoming_key, @status)
  `).run(row);
}
export function getFile(id) { return db.prepare('SELECT * FROM files WHERE id = ?').get(id); }
export function getFileForUser(id, userId) {
  return db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(id, userId);
}
export function transition(id, from, to, extras = {}) {
  const fields = Object.keys(extras);
  const updates = fields.map(name => `${name} = @${name}`).join(', ');
  const statement = db.prepare(`UPDATE files SET status = @to, updated_at = CURRENT_TIMESTAMP${updates ? ', ' + updates : ''}
    WHERE id = @id AND status = @from`);
  return statement.run({ id, from, to, ...extras }).changes === 1;
}
export function nextUploaded() {
  return db.prepare(`SELECT * FROM files WHERE status = 'UPLOADED' ORDER BY created_at LIMIT 1`).get();
}
