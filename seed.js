'use strict';

// Creates (or resets) the MASTER admin — the account that approves businesses,
// issues invite codes, and sees every workspace.
//
//   node seed.js "Atul" 481902 you@gmail.com
//
// The email is where your one-time sign-in code is sent. Leave it out and the
// account works on PIN alone, which is fine for a first run but not for live.
//
// Safe to re-run: the same name just resets that master's PIN and email.

const { db, hashPin, nowISO, pinProblem } = require('./db');

const name = process.argv[2] || 'Master';
const pin = process.argv[3] || '';
const email = (process.argv[4] || '').trim();

if (!pin) {
  console.error('Usage: node seed.js "<name>" <pin> [email]');
  process.exit(1);
}

const issue = pinProblem(pin);
if (issue) {
  console.error(`That PIN will not do: ${issue}`);
  process.exit(1);
}
if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('That email address does not look right.');
  process.exit(1);
}

const existing = db
  .prepare("SELECT * FROM users WHERE business_id IS NULL AND role = 'master' AND lower(name) = lower(?)")
  .get(name);

if (existing) {
  db.prepare('UPDATE users SET pin_hash = ?, email = ?, active = 1 WHERE id = ?')
    .run(hashPin(pin), email || existing.email || '', existing.id);
  db.prepare('DELETE FROM tokens WHERE user_id = ?').run(existing.id);
  console.log(`Reset master admin "${name}".`);
} else {
  db.prepare(`INSERT INTO users (business_id, name, pin_hash, role, team, email, created_at)
              VALUES (NULL, ?, ?, 'master', 'platform', ?, ?)`)
    .run(name, hashPin(pin), email, nowISO());
  console.log(`Created master admin "${name}".`);
}

// Any half-finished sign-in from before is now meaningless.
try { db.prepare('DELETE FROM otp_challenges').run(); } catch {}
try { db.prepare("DELETE FROM login_guard WHERE key LIKE 'master:%'").run(); } catch {}

const finalEmail = email || (existing && existing.email) || '';
console.log('');
console.log(`  PIN:   ${pin}`);
console.log(`  Email: ${finalEmail || '(none — sign-in will not ask for a code)'}`);
console.log('');
if (!finalEmail) {
  console.log('  ⚠  No email set. Anyone with this PIN gets in with one factor.');
  console.log('     Re-run with your email as the third argument to turn on codes.');
} else {
  console.log('  Signing in asks for your PIN, then a 6-digit code sent to that address.');
  console.log('  If email ever fails, the code is written to the server log:');
  console.log('     journalctl -u focustrack -n 20');
}
console.log('');
console.log('  Master panel:  /master');
console.log('  Public signup: /');
