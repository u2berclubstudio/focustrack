'use strict';
// Proves that a LIVE v1 database (single-tenant) upgrades to v2 without losing
// anything. Run: node test-migration.js
//
// Step 1 builds a database in the exact old shape and fills it with data.
// Step 2 loads the new db.js against it in a fresh process and checks the rows.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const DIR = '/tmp/ft-migrate-test';
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

function open(file) {
  try {
    return new (require('better-sqlite3'))(file);
  } catch {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(file);
    d.pragma = (s) => d.exec('PRAGMA ' + s);
    return d;
  }
}

const hashPin = (pin, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;

// ---- step 1: build a v1 database -----------------------------------------
const file = path.join(DIR, 'focustrack.db');
const v1 = open(file);
v1.exec(`
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee',
  team TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task TEXT NOT NULL,
  planned_minutes INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  actual_seconds INTEGER,
  note TEXT DEFAULT ''
);
CREATE TABLE distractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  category TEXT DEFAULT 'other',
  occurred_at TEXT NOT NULL,
  elapsed_seconds INTEGER NOT NULL
);
CREATE TABLE tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);`);

const now = new Date().toISOString();
v1.prepare('INSERT INTO users (name,pin_hash,role,team,created_at) VALUES (?,?,?,?,?)')
  .run('Atul', hashPin('1983'), 'admin', 'management', now);
v1.prepare('INSERT INTO users (name,pin_hash,role,team,created_at) VALUES (?,?,?,?,?)')
  .run('Ravi', hashPin('1111'), 'employee', 'sales', now);
v1.prepare(`INSERT INTO sessions (user_id,task,planned_minutes,started_at,ended_at,status,actual_seconds)
            VALUES (2,'Old work',30,?,?,'completed',1800)`).run(now, now);
v1.prepare(`INSERT INTO distractions (session_id,user_id,reason,category,occurred_at,elapsed_seconds)
            VALUES (1,2,'Phone','phone',?,600)`).run(now);
v1.close && v1.close();
console.log('  ✓ built a v1 database with 2 users, 1 session, 1 distraction');

// ---- step 2: load the new schema against it ------------------------------
const probe = `
const { db } = require('${path.join(__dirname, 'db.js').replace(/\\/g, '\\\\')}');
const out = {
  businesses: db.prepare('SELECT * FROM businesses').all(),
  users: db.prepare('SELECT id,name,role,business_id,team FROM users ORDER BY id').all(),
  sessions: db.prepare('SELECT id,business_id,task,status FROM sessions').all(),
  distractions: db.prepare('SELECT id,business_id,reason FROM distractions').all(),
  pinOk: require('${path.join(__dirname, 'db.js').replace(/\\/g, '\\\\')}')
           .verifyPin('1983', db.prepare("SELECT pin_hash h FROM users WHERE name='Atul'").get().h),
};
process.stdout.write('@@' + JSON.stringify(out) + '@@');
`;
const raw = execFileSync(process.execPath, ['-e', probe], {
  env: { ...process.env, DATA_DIR: DIR, DEFAULT_BUSINESS_NAME: 'U2ber Club', DEFAULT_BUSINESS_SLUG: 'u2berclub' },
  encoding: 'utf8',
});
const res = JSON.parse(raw.split('@@')[1]);

try {
  assert.strictEqual(res.businesses.length, 1);
  const biz = res.businesses[0];
  assert.strictEqual(biz.slug, 'u2berclub');
  assert.strictEqual(biz.status, 'active');
  console.log(`  ✓ existing data was moved into one business ("${biz.name}" at /${biz.slug})`);

  assert.strictEqual(res.users.length, 2);
  assert.ok(res.users.every((u) => u.business_id === biz.id));
  console.log('  ✓ both users kept, both attached to that business');

  const atul = res.users.find((u) => u.name === 'Atul');
  assert.strictEqual(atul.role, 'owner');
  assert.strictEqual(res.users.find((u) => u.name === 'Ravi').role, 'employee');
  console.log('  ✓ the old admin became the business owner, employee stayed an employee');

  assert.strictEqual(atul.team, 'management');
  assert.strictEqual(res.pinOk, true);
  console.log('  ✓ PINs and profile fields survived the table rebuild');

  assert.strictEqual(res.sessions.length, 1);
  assert.strictEqual(res.sessions[0].task, 'Old work');
  assert.strictEqual(res.sessions[0].business_id, biz.id);
  assert.strictEqual(res.distractions.length, 1);
  assert.strictEqual(res.distractions[0].business_id, biz.id);
  console.log('  ✓ historical sessions and distractions kept and back-filled');

  // Running it a second time must not duplicate anything.
  const raw2 = execFileSync(process.execPath, ['-e', probe], {
    env: { ...process.env, DATA_DIR: DIR, DEFAULT_BUSINESS_NAME: 'U2ber Club', DEFAULT_BUSINESS_SLUG: 'u2berclub' },
    encoding: 'utf8',
  });
  const res2 = JSON.parse(raw2.split('@@')[1]);
  assert.strictEqual(res2.businesses.length, 1);
  assert.strictEqual(res2.users.length, 2);
  console.log('  ✓ migration is idempotent — restarting the server changes nothing');

  console.log('\nMigration checks passed.\n');
} catch (err) {
  console.error('\nMIGRATION FAILED:', err.message);
  console.error(JSON.stringify(res, null, 2));
  process.exit(1);
}
