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

const nowISO = () => new Date().toISOString();

// --- PIN policy ----------------------------------------------------------
// Applies to PINs being *set*. Existing hashes are never re-validated, so
// nobody already using a 4-digit PIN is locked out by this.
const MIN_PIN = Number(process.env.MIN_PIN_LENGTH || 6);

const COMMON_PINS = new Set([
  '000000', '111111', '121212', '112233', '123123', '123321', '654321',
  '666666', '696969', '123456', '654312', '159753', '147258', '102030',
  '999999', '888888', '777777', '098765', '011235', '520520',
  '1234', '1111', '0000', '1212', '7777', '1004', '2000', '4444', '2222',
]);

function pinProblem(pin) {
  const p = String(pin || '').trim();
  if (!/^\d+$/.test(p)) return 'Your PIN should be numbers only';
  if (p.length < MIN_PIN) return `Your PIN needs at least ${MIN_PIN} digits`;
  if (p.length > 12) return 'That PIN is too long';
  if (COMMON_PINS.has(p)) return 'That PIN is one of the most guessed — pick another';
  if (/^(\d)\1+$/.test(p)) return 'Do not repeat the same digit';

  // 123456 / 987654 and friends
  let up = true, down = true;
  for (let i = 1; i < p.length; i++) {
    const step = Number(p[i]) - Number(p[i - 1]);
    if (step !== 1) up = false;
    if (step !== -1) down = false;
  }
  if (up || down) return 'Avoid straight sequences like 123456';
  return null;
}

const columns = (table) => {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch {
    return [];
  }
};
const tableExists = (t) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

// --- schema --------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS businesses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  contact_email  TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending | active | suspended
  seat_limit     INTEGER NOT NULL DEFAULT 10,
  tz_offset      INTEGER NOT NULL DEFAULT 330,      -- minutes ahead of UTC
  created_at     TEXT NOT NULL,
  approved_at    TEXT,
  last_active_at TEXT
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code          TEXT PRIMARY KEY,
  note          TEXT DEFAULT '',
  seat_limit    INTEGER NOT NULL DEFAULT 10,
  auto_approve  INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  used_by       INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
  used_at       TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`);

// users -------------------------------------------------------------------
// The v1 table had a globally UNIQUE name, which breaks the moment two
// businesses both employ a "Ravi". SQLite can't drop a constraint, so when we
// spot the old shape we rebuild the table and carry the rows across.
const usersIsV1 = tableExists('users') && !columns('users').includes('business_id');

if (!tableExists('users')) {
  db.exec(`
    CREATE TABLE users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      pin_hash    TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'employee',  -- master | owner | admin | employee
      team        TEXT DEFAULT '',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    );`);
} else if (usersIsV1) {
  console.log('[db] migrating users table to multi-tenant shape');
  db.exec(`
    CREATE TABLE users_v2 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      pin_hash    TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'employee',
      team        TEXT DEFAULT '',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    );
    INSERT INTO users_v2 (id, business_id, name, pin_hash, role, team, active, created_at)
      SELECT id, NULL, name, pin_hash, role, team, active, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_v2 RENAME TO users;`);
}

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_biz_name
  ON users(business_id, lower(name)) WHERE business_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_master_name
  ON users(lower(name)) WHERE business_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id);
`);

// sessions / distractions / tokens ---------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id      INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task             TEXT NOT NULL,
  planned_minutes  INTEGER NOT NULL,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  status           TEXT NOT NULL DEFAULT 'running',
  actual_seconds   INTEGER,
  note             TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS distractions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id      INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason           TEXT NOT NULL,
  category         TEXT DEFAULT 'other',
  occurred_at      TEXT NOT NULL,
  elapsed_seconds  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token            TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  impersonated_by  TEXT DEFAULT NULL,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL
);
`);

// --- login security -------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS login_guard (
  key            TEXT PRIMARY KEY,   -- 'user:<biz>:<name>' or 'ip:<addr>'
  fails          INTEGER NOT NULL DEFAULT 0,
  first_fail_at  TEXT,
  locked_until   TEXT
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_otp_user ON otp_challenges(user_id);
`);

// Add columns that older installs won't have yet.
const addColumn = (table, col, decl) => {
  if (tableExists(table) && !columns(table).includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
};
addColumn('users', 'email', "TEXT DEFAULT ''");
addColumn('sessions', 'business_id', 'INTEGER');
addColumn('distractions', 'business_id', 'INTEGER');
addColumn('tokens', 'impersonated_by', 'TEXT DEFAULT NULL');
addColumn('businesses', 'last_active_at', 'TEXT');

db.exec(`
CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_business ON sessions(business_id);
CREATE INDEX IF NOT EXISTS idx_sessions_start    ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status   ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_distractions_session  ON distractions(session_id);
CREATE INDEX IF NOT EXISTS idx_distractions_business ON distractions(business_id);
`);

// --- data migration ------------------------------------------------------
// Anyone already using v1 has users with no business. Park them in one
// business so nothing is orphaned and the app keeps working after the upgrade.
function migrateOrphans() {
  const orphans = db
    .prepare("SELECT * FROM users WHERE business_id IS NULL AND role != 'master'")
    .all();
  if (!orphans.length) return;

  const name = process.env.DEFAULT_BUSINESS_NAME || 'My Company';
  const slug = process.env.DEFAULT_BUSINESS_SLUG || 'main';
  let biz = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slug);
  if (!biz) {
    const info = db
      .prepare(`INSERT INTO businesses (name, slug, status, seat_limit, tz_offset, created_at, approved_at)
                VALUES (?,?,'active',?,?,?,?)`)
      .run(name, slug, 100, Number(process.env.TZ_OFFSET_MINUTES || 330), nowISO(), nowISO());
    biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(info.lastInsertRowid);
    console.log(`[db] created default business "${name}" at /${slug}`);
  }

  for (const u of orphans) {
    // The v1 admin becomes the owner of the migrated business.
    const role = u.role === 'admin' ? 'owner' : 'employee';
    db.prepare('UPDATE users SET business_id = ?, role = ? WHERE id = ?').run(biz.id, role, u.id);
  }
  db.prepare('UPDATE sessions SET business_id = ? WHERE business_id IS NULL').run(biz.id);
  db.prepare('UPDATE distractions SET business_id = ? WHERE business_id IS NULL').run(biz.id);
  console.log(`[db] moved ${orphans.length} existing user(s) into "${name}"`);
}
migrateOrphans();

module.exports = {
  db, hashPin, verifyPin, nowISO, DATA_DIR, tableExists, columns,
  pinProblem, MIN_PIN,
};
