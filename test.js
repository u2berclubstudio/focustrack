'use strict';
// End-to-end smoke test. Run: DATA_DIR=/tmp/ft-test node test.js
const assert = require('assert');
const app = require('./server');
const { db, hashPin, nowISO } = require('./db');

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, o = {}, tok) => {
    const r = await fetch(base + p, {
      ...o,
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  const ok = (label) => console.log('  ✓ ' + label);

  try {
    // seed users
    db.prepare('DELETE FROM users').run();
    db.prepare('INSERT INTO users (name,pin_hash,role,team,created_at) VALUES (?,?,?,?,?)')
      .run('Atul', hashPin('4321'), 'admin', 'management', nowISO());
    db.prepare('INSERT INTO users (name,pin_hash,role,team,created_at) VALUES (?,?,?,?,?)')
      .run('Ravi', hashPin('1111'), 'employee', 'sales', nowISO());

    // login
    assert.strictEqual((await call('/api/login', { method: 'POST', body: JSON.stringify({ name: 'Ravi', pin: '9999' }) })).status, 401);
    ok('wrong PIN rejected');
    const login = await call('/api/login', { method: 'POST', body: JSON.stringify({ name: 'ravi', pin: '1111' }) });
    assert.strictEqual(login.status, 200);
    const ravi = login.body.token;
    ok('login works (case-insensitive name)');

    const admin = (await call('/api/login', { method: 'POST', body: JSON.stringify({ name: 'Atul', pin: '4321' }) })).body.token;

    // auth guard
    assert.strictEqual((await call('/api/admin/stats', {}, ravi)).status, 403);
    ok('employee blocked from admin endpoints');
    assert.strictEqual((await call('/api/my/today')).status, 401);
    ok('unauthenticated blocked');

    // start session
    assert.strictEqual((await call('/api/sessions/start', { method: 'POST', body: JSON.stringify({ task: '', planned_minutes: 30 }) }, ravi)).status, 400);
    ok('empty task rejected');
    const s1 = (await call('/api/sessions/start', { method: 'POST', body: JSON.stringify({ task: 'Sharma quotation', planned_minutes: 30 }) }, ravi)).body.session;
    assert.strictEqual(s1.status, 'running');
    assert.strictEqual(s1.planned_minutes, 30);
    ok('session starts with server timestamp');

    // resume after refresh
    const active = (await call('/api/sessions/active', {}, ravi)).body;
    assert.strictEqual(active.session.id, s1.id);
    ok('active session resumes after page refresh');

    // distractions
    const d1 = await call(`/api/sessions/${s1.id}/distraction`, { method: 'POST', body: JSON.stringify({ reason: 'WhatsApp notification' }) }, ravi);
    assert.strictEqual(d1.body.count, 1);
    await call(`/api/sessions/${s1.id}/distraction`, { method: 'POST', body: JSON.stringify({ reason: 'Manager called me' }) }, ravi);
    const still = (await call('/api/sessions/active', {}, ravi)).body;
    assert.strictEqual(still.session.status, 'running');
    assert.strictEqual(still.distractions.length, 2);
    ok('distraction logged, timer keeps running');
    assert.strictEqual(db.prepare('SELECT category FROM distractions WHERE reason LIKE ?').get('WhatsApp%').category, 'phone');
    assert.strictEqual(db.prepare('SELECT category FROM distractions WHERE reason LIKE ?').get('Manager%').category, 'people');
    ok('reasons auto-categorised');

    // complete
    await call(`/api/sessions/${s1.id}/complete`, { method: 'POST', body: '{}' }, ravi);
    assert.strictEqual(db.prepare('SELECT status FROM sessions WHERE id=?').get(s1.id).status, 'completed');
    assert.strictEqual((await call('/api/sessions/active', {}, ravi)).body.session, null);
    ok('session completes and clears');

    // stale auto-close
    const s2 = (await call('/api/sessions/start', { method: 'POST', body: JSON.stringify({ task: 'Old task', planned_minutes: 15 }) }, ravi)).body.session;
    const s3 = (await call('/api/sessions/start', { method: 'POST', body: JSON.stringify({ task: 'New task', planned_minutes: 45 }) }, ravi)).body.session;
    assert.strictEqual(db.prepare('SELECT status FROM sessions WHERE id=?').get(s2.id).status, 'abandoned');
    ok('starting a new session auto-closes the stale one');
    await call(`/api/sessions/${s3.id}/stop`, { method: 'POST', body: '{}' }, ravi);

    // backdated data for stats math
    const iso = (mins) => new Date(Date.now() - mins * 60000).toISOString();
    const mk = (userId, task, plan, startMins, status, actual) => {
      const r = db.prepare(`INSERT INTO sessions (user_id,task,planned_minutes,started_at,ended_at,status,actual_seconds)
                            VALUES (?,?,?,?,?,?,?)`)
        .run(userId, task, plan, iso(startMins), iso(startMins - plan), status, actual);
      return r.lastInsertRowid;
    };
    const raviId = db.prepare('SELECT id FROM users WHERE name=?').get('Ravi').id;
    db.prepare('DELETE FROM sessions').run();
    // 4 sessions, 3 completed, 2h total focus, 2 distractions => dph = 1
    const a1 = mk(raviId, 'A', 30, 200, 'completed', 1800);
    const a2 = mk(raviId, 'B', 30, 160, 'completed', 1800);
    const a3 = mk(raviId, 'C', 30, 120, 'completed', 1800);
    const a4 = mk(raviId, 'D', 30, 80, 'abandoned', 1800);
    for (const sid of [a1, a2]) {
      db.prepare('INSERT INTO distractions (session_id,user_id,reason,category,occurred_at,elapsed_seconds) VALUES (?,?,?,?,?,?)')
        .run(sid, raviId, 'Phone', 'phone', iso(150), 600);
    }
    const stats = (await call('/api/admin/stats', {}, admin)).body;
    assert.strictEqual(stats.totals.sessions, 4);
    assert.strictEqual(stats.totals.completed, 3);
    assert.strictEqual(stats.totals.completionRate, 75);
    assert.strictEqual(stats.totals.focusedHours, 2);
    assert.strictEqual(stats.totals.distractionsPerHour, 1);
    // 0.6*75 + 0.4*(100-12.5) = 45 + 35 = 80
    assert.strictEqual(stats.totals.focusScore, 80);
    ok('focus score math verified (75% completion, 1 distr/hr -> 80)');
    assert.strictEqual(stats.employees.length, 1);
    assert.strictEqual(stats.employees[0].focusScore, 80);
    assert.strictEqual(stats.employees[0].focusedMinutes, 120);
    ok('per-employee rollup matches totals');
    assert.strictEqual(stats.topReasons[0].count, 2);
    assert.strictEqual(stats.categories[0].category, 'phone');
    ok('distraction rollups correct');
    assert.ok(stats.daily.length >= 1 && stats.hours.length >= 1);
    ok('daily + hourly buckets populated');

    // date filter excludes out-of-range
    const empty = (await call('/api/admin/stats?from=2000-01-01&to=2000-01-02', {}, admin)).body;
    assert.strictEqual(empty.totals.sessions, 0);
    assert.strictEqual(empty.totals.focusScore, null);
    ok('date range filter works');

    // CSV
    const csvRes = await fetch(base + '/api/admin/export.csv', { headers: { Authorization: 'Bearer ' + admin } });
    const csv = await csvRes.text();
    const lines = csv.trim().split('\n');
    assert.strictEqual(lines.length, 5); // header + 4
    assert.ok(lines[0].includes('distraction_reasons'));
    assert.ok(csv.includes('Ravi'));
    ok('CSV export has header + one row per session');

    // user admin
    assert.strictEqual((await call('/api/admin/users', { method: 'POST', body: JSON.stringify({ name: 'Neha', pin: '12' }) }, admin)).status, 400);
    ok('short PIN rejected');
    assert.strictEqual((await call('/api/admin/users', { method: 'POST', body: JSON.stringify({ name: 'Neha', pin: '2222', team: 'ops' }) }, admin)).status, 200);
    assert.strictEqual((await call('/api/admin/users', { method: 'POST', body: JSON.stringify({ name: 'neha', pin: '3333' }) }, admin)).status, 409);
    ok('duplicate name rejected');
    const nehaId = db.prepare('SELECT id FROM users WHERE name=?').get('Neha').id;
    await call(`/api/admin/users/${nehaId}`, { method: 'PATCH', body: JSON.stringify({ active: false }) }, admin);
    assert.strictEqual((await call('/api/login', { method: 'POST', body: JSON.stringify({ name: 'Neha', pin: '2222' }) })).status, 401);
    ok('disabled user cannot log in');

    // logout invalidates token
    await call('/api/logout', { method: 'POST' }, ravi);
    assert.strictEqual((await call('/api/my/today', {}, ravi)).status, 401);
    ok('logout invalidates token');

    console.log('\nAll checks passed.\n');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED:', err.message, '\n', err);
    server.close();
    process.exit(1);
  }
});
