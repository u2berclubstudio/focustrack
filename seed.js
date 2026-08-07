'use strict';

// Creates the first admin account. Run once: node seed.js "Atul" 4321
const { db, hashPin, nowISO } = require('./db');

const name = process.argv[2] || 'Admin';
const pin = process.argv[3] || String(Math.floor(1000 + Math.random() * 9000));

const existing = db.prepare('SELECT * FROM users WHERE lower(name)=lower(?)').get(name);
if (existing) {
  db.prepare('UPDATE users SET pin_hash=?, role=?, active=1 WHERE id=?')
    .run(hashPin(pin), 'admin', existing.id);
  console.log(`Updated existing admin "${name}". PIN: ${pin}`);
} else {
  db.prepare('INSERT INTO users (name, pin_hash, role, team, created_at) VALUES (?,?,?,?,?)')
    .run(name, hashPin(pin), 'admin', 'management', nowISO());
  console.log(`Created admin "${name}". PIN: ${pin}`);
}
console.log('Log in at /  (admin dashboard link appears after login)');
