'use strict';

// Creates (or resets) the MASTER admin — the account that approves businesses,
// issues invite codes, and sees every workspace.
//
//   node seed.js "Atul" 4321
//
// Safe to re-run: same name just resets that master's PIN.

const { db, hashPin, nowISO } = require('./db');

const name = process.argv[2] || 'Master';
const pin = process.argv[3] || String(Math.floor(1000 + Math.random() * 9000));

if (String(pin).length < 4) {
  console.error('PIN must be at least 4 digits.');
  process.exit(1);
}

const existing = db
  .prepare("SELECT * FROM users WHERE business_id IS NULL AND role = 'master' AND lower(name) = lower(?)")
  .get(name);

if (existing) {
  db.prepare('UPDATE users SET pin_hash = ?, active = 1 WHERE id = ?').run(hashPin(pin), existing.id);
  db.prepare('DELETE FROM tokens WHERE user_id = ?').run(existing.id);
  console.log(`Reset master admin "${name}". PIN: ${pin}`);
} else {
  db.prepare(`INSERT INTO users (business_id, name, pin_hash, role, team, created_at)
              VALUES (NULL, ?, ?, 'master', 'platform', ?)`)
    .run(name, hashPin(pin), nowISO());
  console.log(`Created master admin "${name}". PIN: ${pin}`);
}

console.log('');
console.log('  Master panel:  /master');
console.log('  Public signup: /');
console.log('');
console.log('Next: log into /master and generate an invite code for your first business.');
