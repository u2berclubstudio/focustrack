'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'focustrack.db');

// Two ways to talk to SQLite, so this runs on any VPS:
//   1. better-sqlite3  - fastest, uses a prebuilt native binary when available
//   2. node:sqlite     - built into Node 22.5+, needs no compiler at all
function openDatabase() {
  try {
    const Database = require('better-sqlite3');
    const d = new Database(DB_FILE);
    d.pragma('journal_mode = WAL');
    d.pragma('foreign_keys = ON');
    console.log('[db] using better-sqlite3');
    return d;
  } catch (e) {
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch {
      throw new Error(
        'No SQLite driver available. Either run `npm rebuild better-sqlite3` ' +
        '(needs build-essential + python3) or upgrade to Node 22.5+.'
      );
    }
    const d = new DatabaseSync(DB_FILE);
    d.exec('PRAGMA journal_mode = WAL');
    d.exec('PRAGMA foreign_keys = ON');
    d.pragma = (sql) => d.exec('PRAGMA ' + sql);
    console.log('[db] using built-in node:sqlite');
    return d;
  }
}

const db = openDatabase();

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  pin_hash    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'employee',   -- 'employee' | 'admin'
  team        TEXT DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task             TEXT NOT NULL,
  planned_minutes  INTEGER NOT NULL,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  status           TEXT NOT NULL DEFAULT 'running', -- running | completed | abandoned
  actual_seconds   INTEGER,
  note             TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start  ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS distractions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason           TEXT NOT NULL,
  category         TEXT DEFAULT 'other',
  occurred_at      TEXT NOT NULL,
  elapsed_seconds  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_distractions_session ON distractions(session_id);
CREATE INDEX IF NOT EXISTS idx_distractions_user    ON distractions(user_id);

CREATE TABLE IF NOT EXISTS tokens (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
`);

// --- helpers -------------------------------------------------------------

function hashPin(pin, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pin), s, 32).toString('hex');
  return `${s}:${h}`;
}

function verifyPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  const candidate = hashPin(pin, salt);
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function nowISO() {
  return new Date().toISOString();
}

module.exports = { db, hashPin, verifyPin, nowISO, DATA_DIR };
