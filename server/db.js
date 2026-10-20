import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'kenlod.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  quota_bytes INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workgroups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#1f4e8c',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_invites (
  token TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0
);

-- space: 'u:<userId>' (personal space) or 'g:<groupId>' (group space), inherited from the parent.
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'file', 'doc', 'sheet', 'form')),
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  space TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  storage_key TEXT,
  content TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  trashed_at INTEGER,
  trashed_root INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS items_space ON items(space, parent_id);
CREATE INDEX IF NOT EXISTS items_trash ON items(trashed_root, trashed_at);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES workgroups(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK ((user_id IS NULL) <> (group_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS shares_user ON shares(item_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shares_group ON shares(item_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shares_u ON shares(user_id);
CREATE INDEX IF NOT EXISTS shares_g ON shares(group_id);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  password_hash TEXT,
  expires_at INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS links_item ON links(item_id);

CREATE TABLE IF NOT EXISTS stars (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS recent (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  opened_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  space TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_item ON activity(item_id, created_at);
CREATE INDEX IF NOT EXISTS activity_space ON activity(space, created_at);
`);

// ---- Migrations ----
if (!db.prepare('PRAGMA table_info(items)').all().some((c) => c.name === 'ydoc')) {
  // Collaborative state (Yjs update). `content` stays the HTML/JSON snapshot used for search, export and public links.
  db.exec('ALTER TABLE items ADD COLUMN ydoc BLOB');
}
db.exec(`
CREATE TABLE IF NOT EXISTS doc_images (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_images_item ON doc_images(item_id);
`);
// SQLite can't change a CHECK constraint in place: rebuild `items` so it accepts forms
// (the documented copy / drop / rename procedure, with foreign keys off so nothing cascades).
if (!db.prepare("SELECT sql FROM sqlite_master WHERE name = 'items'").get().sql.includes("'form'")) {
  const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
CREATE TABLE items_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'file', 'doc', 'sheet', 'form')),
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  space TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  storage_key TEXT,
  content TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  trashed_at INTEGER,
  trashed_root INTEGER NOT NULL DEFAULT 0,
  ydoc BLOB
);
INSERT INTO items_new (${cols}) SELECT ${cols} FROM items;
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
CREATE INDEX items_parent ON items(parent_id);
CREATE INDEX items_space ON items(space, parent_id);
CREATE INDEX items_trash ON items(trashed_root, trashed_at);
`);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('foreign key check failed after items rebuild');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
db.exec(`
CREATE TABLE IF NOT EXISTS forms (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  accepting INTEGER NOT NULL DEFAULT 1,
  closes_at INTEGER,
  require_login INTEGER NOT NULL DEFAULT 0,
  one_per_user INTEGER NOT NULL DEFAULT 0,
  notify INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS form_responses (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  answers TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS form_responses_item ON form_responses(item_id, created_at);
`);
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'email_verified_at')) {
  // Accounts created before e-mail verification existed are trusted as they are.
  db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
  db.exec('UPDATE users SET email_verified_at = created_at');
}
db.exec(`
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose);
`);

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export const one = (sql, ...params) => stmt(sql).get(...params);
export const all = (sql, ...params) => stmt(sql).all(...params);
export const run = (sql, ...params) => stmt(sql).run(...params);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const placeholders = (arr) => arr.map(() => '?').join(',');
