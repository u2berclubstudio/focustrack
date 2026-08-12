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
  const post = (p, b, tok) => call(p, { method: 'POST', body: JSON.stringify(b || {}) }, tok);
  const ok = (label) => console.log('  ✓ ' + label);

  try {
    for (const t of ['distractions', 'sessions', 'tokens', 'users', 'invite_codes', 'businesses', 'audit_log']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }

    // ---------- master ----------
    db.prepare(`INSERT INTO users (business_id, name, pin_hash, role, team, created_at)
                VALUES (NULL,?,?,'master','platform',?)`).run('Atul', hashPin('481902'), nowISO());

    assert.strictEqual((await post('/api/master/login', { name: 'Atul', pin: '240816' })).status, 401);
    const master = (await post('/api/master/login', { name: 'Atul', pin: '481902' })).body.token;
    assert.ok(master);
    ok('master admin can sign in');

    // ---------- invite codes ----------
    const c1 = (await post('/api/master/codes', { note: 'Acme', seat_limit: 3 }, master)).body.code;
    const c2 = (await post('/api/master/codes', { note: 'Globex', seat_limit: 10 }, master)).body.code;
    const c3 = (await post('/api/master/codes', { note: 'Pending Co', seat_limit: 5, auto_approve: false }, master)).body.code;
    assert.match(c1, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.notStrictEqual(c1, c2);
    ok('invite codes generate in a readable, unique format');

    assert.strictEqual((await post('/api/master/codes', {}, 'bogus-token')).status, 401);
    ok('codes cannot be generated without master auth');

    // ---------- signup ----------
    assert.strictEqual((await post('/api/signup', {
      code: 'FAKE-CODE', business_name: 'X', slug: 'x1', owner_name: 'A', owner_pin: '774411' })).status, 400);
    ok('invalid invite code rejected');

    assert.strictEqual((await post('/api/signup', {
      code: c1, business_name: 'API Co', slug: 'api', owner_name: 'A', owner_pin: '774411' })).status, 400);
    ok('reserved slug rejected');

    const s1 = await post('/api/signup', {
      code: c1, business_name: 'Acme Events', slug: 'acme',
      owner_name: 'Ravi', owner_pin: '774411', contact_email: 'a@acme.com' });
    assert.strictEqual(s1.status, 200);
    assert.strictEqual(s1.body.status, 'active');
    ok('signup with auto-approve code creates an active workspace');

    assert.strictEqual((await post('/api/signup', {
      code: c1, business_name: 'Second', slug: 'second', owner_name: 'B', owner_pin: '620744' })).status, 400);
    ok('invite code cannot be reused');

    const s2 = await post('/api/signup', {
      code: c2, business_name: 'Globex', slug: 'globex', owner_name: 'Priya', owner_pin: '620744' });
    assert.strictEqual(s2.status, 200);

    const s3 = await post('/api/signup', {
      code: c3, business_name: 'Pending Co', slug: 'pendingco', owner_name: 'Sam', owner_pin: '830155' });
    assert.strictEqual(s3.body.status, 'pending');
    ok('non-auto-approve code parks the business in pending');

    assert.strictEqual((await post('/api/signup', {
      code: (await post('/api/master/codes', {}, master)).body.code,
      business_name: 'Dupe', slug: 'acme', owner_name: 'C', owner_pin: '962037' })).status, 409);
    ok('duplicate team link rejected');

    // ---------- login scoping ----------
    const acme = (await post('/api/login', { slug: 'acme', name: 'Ravi', pin: '774411' })).body.token;
    const globex = (await post('/api/login', { slug: 'globex', name: 'Priya', pin: '620744' })).body.token;
    assert.ok(acme && globex);
    ok('owners can sign in at their own team link');

    assert.strictEqual((await post('/api/login', { slug: 'globex', name: 'Ravi', pin: '774411' })).status, 401);
    ok('credentials do not work on another business link');

    assert.strictEqual((await post('/api/login', { slug: 'pendingco', name: 'Sam', pin: '830155' })).status, 403);
    ok('pending business cannot sign in yet');

    // same employee name in two businesses
    assert.strictEqual((await post('/api/admin/users', { name: 'Ravi Jr', pin: '905513' }, acme)).status, 200);
    assert.strictEqual((await post('/api/admin/users', { name: 'Ravi Jr', pin: '318266' }, globex)).status, 200);
    const aJr = (await post('/api/login', { slug: 'acme', name: 'Ravi Jr', pin: '905513' })).body.token;
    const gJr = (await post('/api/login', { slug: 'globex', name: 'Ravi Jr', pin: '318266' })).body.token;
    assert.ok(aJr && gJr);
    ok('two businesses can both employ a "Ravi Jr" with different PINs');

    // ---------- tenant isolation ----------
    await post('/api/sessions/start', { task: 'Acme secret work', planned_minutes: 30 }, aJr);
    await post('/api/sessions/start', { task: 'Globex secret work', planned_minutes: 30 }, gJr);
    const acmeSess = db.prepare("SELECT id FROM sessions WHERE task = 'Acme secret work'").get();
    const globexSess = db.prepare("SELECT id FROM sessions WHERE task = 'Globex secret work'").get();

    // finish both so they show in stats
    await post(`/api/sessions/${acmeSess.id}/complete`, {}, aJr);
    await post(`/api/sessions/${globexSess.id}/complete`, {}, gJr);

    const acmeStats = (await call('/api/admin/stats', {}, acme)).body;
    const globexStats = (await call('/api/admin/stats', {}, globex)).body;
    assert.strictEqual(acmeStats.totals.sessions, 1);
    assert.strictEqual(globexStats.totals.sessions, 1);
    assert.strictEqual(acmeStats.business.name, 'Acme Events');
    ok('each business sees only its own sessions');

    const acmeCsv = await (await fetch(base + '/api/admin/export.csv', { headers: { Authorization: 'Bearer ' + acme } })).text();
    assert.ok(acmeCsv.includes('Acme secret work'));
    assert.ok(!acmeCsv.includes('Globex secret work'));
    ok('CSV export never leaks another tenant\'s rows');

    const acmeUsers = (await call('/api/admin/users', {}, acme)).body.users;
    assert.deepStrictEqual(acmeUsers.map((u) => u.name).sort(), ['Ravi', 'Ravi Jr']);
    ok('user list is scoped to the business');

    // cross-tenant write attempt
    const globexUserId = db.prepare(`SELECT u.id FROM users u JOIN businesses b ON b.id = u.business_id
                                      WHERE b.slug='globex' AND u.name='Ravi Jr'`).get().id;
    const attack = await call(`/api/admin/users/${globexUserId}`, {
      method: 'PATCH', body: JSON.stringify({ pin: '240816' }) }, acme);
    assert.strictEqual(attack.status, 404);
    assert.strictEqual((await post('/api/login', { slug: 'globex', name: 'Ravi Jr', pin: '318266' })).status, 200);
    ok('one business cannot reset another business\'s PINs');

    // employee cannot reach admin endpoints
    assert.strictEqual((await call('/api/admin/stats', {}, aJr)).status, 403);
    assert.strictEqual((await call('/api/master/overview', {}, acme)).status, 403);
    ok('role boundaries hold (employee < admin < master)');

    // ---------- seat limits ----------
    // Acme code was 3 seats: owner + Ravi Jr = 2 used.
    assert.strictEqual((await post('/api/admin/users', { name: 'Third', pin: '517399' }, acme)).status, 200);
    const over = await post('/api/admin/users', { name: 'Fourth', pin: '517399' }, acme);
    assert.strictEqual(over.status, 403);
    assert.match(over.body.error, /seats/i);
    ok('seat limit blocks the 4th user on a 3-seat plan');

    const acmeBizId = db.prepare("SELECT id FROM businesses WHERE slug='acme'").get().id;
    await call(`/api/master/businesses/${acmeBizId}`, {
      method: 'PATCH', body: JSON.stringify({ seat_limit: 5 }) }, master);
    assert.strictEqual((await post('/api/admin/users', { name: 'Fourth', pin: '517399' }, acme)).status, 200);
    ok('raising the seat limit from master immediately unblocks it');

    // ---------- approval + suspension ----------
    const pendingId = db.prepare("SELECT id FROM businesses WHERE slug='pendingco'").get().id;
    await post(`/api/master/businesses/${pendingId}/status`, { status: 'active' }, master);
    const samTok = (await post('/api/login', { slug: 'pendingco', name: 'Sam', pin: '830155' })).body.token;
    assert.ok(samTok);
    ok('master approval lets a pending business in');

    await post(`/api/master/businesses/${pendingId}/status`, { status: 'suspended' }, master);
    assert.strictEqual((await call('/api/me', {}, samTok)).status, 401);
    assert.strictEqual((await post('/api/login', { slug: 'pendingco', name: 'Sam', pin: '830155' })).status, 403);
    ok('suspension signs everyone out and blocks new logins');

    await post(`/api/master/businesses/${pendingId}/status`, { status: 'active' }, master);
    ok('suspension is reversible');

    // ---------- impersonation ----------
    const imp = await post(`/api/master/businesses/${acmeBizId}/impersonate`, {}, master);
    assert.strictEqual(imp.status, 200);
    const impStats = (await call('/api/admin/stats', {}, imp.body.token)).body;
    assert.strictEqual(impStats.business.slug, 'acme');
    assert.strictEqual((await call('/api/me', {}, imp.body.token)).body.user.impersonated_by, 'Atul');
    ok('master can view a workspace as its owner');

    const audit = (await call('/api/master/audit', {}, master)).body.entries;
    assert.ok(audit.some((a) => a.action === 'impersonate' && /acme/.test(a.detail)));
    assert.ok(audit.some((a) => a.action === 'status_changed'));
    assert.ok(audit.some((a) => a.action === 'code_created'));
    ok('impersonation and status changes are written to the audit log');

    // ---------- overview ----------
    const ov = (await call('/api/master/overview', {}, master)).body;
    assert.strictEqual(ov.totals.businesses, 3);
    const acmeRow = ov.businesses.find((b) => b.slug === 'acme');
    assert.strictEqual(acmeRow.live, true);
    assert.strictEqual(acmeRow.sessions24h, 1);
    assert.strictEqual(acmeRow.owner, 'Ravi');
    assert.strictEqual(acmeRow.seatLimit, 5);
    ok('master overview reports live activity per business');

    // ---------- focus score math (unchanged) ----------
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM distractions').run();
    const raviJrId = db.prepare(`SELECT u.id FROM users u JOIN businesses b ON b.id=u.business_id
                                  WHERE b.slug='acme' AND u.name='Ravi Jr'`).get().id;
    const iso = (mins) => new Date(Date.now() - mins * 60000).toISOString();
    const mk = (status, startMins) => db.prepare(
      `INSERT INTO sessions (business_id,user_id,task,planned_minutes,started_at,ended_at,status,actual_seconds)
       VALUES (?,?,?,30,?,?,?,1800)`
    ).run(acmeBizId, raviJrId, 'T', iso(startMins), iso(startMins - 30), status).lastInsertRowid;
    const ids = [mk('completed', 200), mk('completed', 160), mk('completed', 120), mk('abandoned', 80)];
    for (const sid of ids.slice(0, 2)) {
      db.prepare(`INSERT INTO distractions (business_id,session_id,user_id,reason,category,occurred_at,elapsed_seconds)
                  VALUES (?,?,?,'Phone','phone',?,600)`).run(acmeBizId, sid, raviJrId, iso(150));
    }
    const fs = (await call('/api/admin/stats', {}, acme)).body;
    assert.strictEqual(fs.totals.completionRate, 75);
    assert.strictEqual(fs.totals.distractionsPerHour, 1);
    assert.strictEqual(fs.totals.focusScore, 80);   // 0.6*75 + 0.4*87.5
    ok('focus score math still verified (75% completion, 1 distr/hr -> 80)');

    // ---------- routing ----------
    assert.strictEqual((await call('/acme')).status, 200);
    assert.strictEqual((await call('/acme/admin')).status, 200);
    assert.strictEqual((await call('/nosuchteam')).status, 404);
    assert.strictEqual((await call('/master')).status, 200);
    assert.strictEqual((await call('/')).status, 200);
    ok('per-business URLs resolve and unknown links 404');

    const spare = (await post('/api/master/codes', {}, master)).body.code;
    const avail = (await post('/api/slug-check', { code: spare, slug: 'acme' })).body;
    assert.strictEqual(avail.available, false);
    assert.strictEqual((await post('/api/slug-check', { code: spare, slug: 'brand-new-co' })).body.available, true);
    ok('team link availability check works behind an invite code');

    // A near-zero-length session with an interruption must not score perfectly.
    const gameId = db.prepare(`INSERT INTO sessions (business_id,user_id,task,planned_minutes,started_at,ended_at,status,actual_seconds)
                               VALUES (?,?,'Gamed',30,?,?,'completed',2)`)
      .run(acmeBizId, raviJrId, iso(40), iso(40)).lastInsertRowid;
    db.prepare(`INSERT INTO distractions (business_id,session_id,user_id,reason,category,occurred_at,elapsed_seconds)
                VALUES (?,?,?,'Phone','phone',?,1)`).run(acmeBizId, gameId, raviJrId, iso(40));
    const gamed = (await call('/api/admin/stats', {}, acme)).body.totals;
    assert.strictEqual(gamed.sessions, 5);
    assert.strictEqual(gamed.completed, 3, 'a 2-second session must not count as finished');
    assert.ok(gamed.completionRate < 75, 'completion rate should fall, not rise');
    assert.ok(gamed.focusScore < 80, 'gaming the timer must not improve the score');
    ok('starting and instantly finishing a session cannot fake a good score');
    db.prepare('DELETE FROM distractions WHERE session_id = ?').run(gameId);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(gameId);

    // ---------- per-member plain-language stats ----------
    const withStats = (await call('/api/admin/stats', {}, acme)).body.employees[0];
    assert.strictEqual(withStats.sessions, 4);
    assert.strictEqual(withStats.completed, 3);
    assert.strictEqual(withStats.focusedMinutes, 120);
    assert.strictEqual(withStats.avgSessionMinutes, 30);
    assert.strictEqual(withStats.topDistraction.reason, 'Phone');
    assert.strictEqual(withStats.topDistraction.count, 2);
    assert.ok(withStats.daysActive >= 1);
    ok('each member carries their own top interruption and averages');

    // Their own reason, not the team's: give the other business a different one.
    const globexBizId = db.prepare("SELECT id FROM businesses WHERE slug='globex'").get().id;
    const globexUser = db.prepare('SELECT id FROM users WHERE business_id = ? LIMIT 1').get(globexBizId).id;
    const gs = db.prepare(`INSERT INTO sessions (business_id,user_id,task,planned_minutes,started_at,ended_at,status,actual_seconds)
                           VALUES (?,?,'G',30,?,?,'completed',1800)`)
      .run(globexBizId, globexUser, iso(90), iso(60)).lastInsertRowid;
    db.prepare(`INSERT INTO distractions (business_id,session_id,user_id,reason,category,occurred_at,elapsed_seconds)
                VALUES (?,?,?,'Client walked in','people',?,600)`).run(globexBizId, gs, globexUser, iso(80));
    const acmeAgain = (await call('/api/admin/stats', {}, acme)).body.employees[0];
    assert.strictEqual(acmeAgain.topDistraction.reason, 'Phone');
    ok('per-member interruption stays inside the right business');

    // ---------- deleting a workspace ----------
    assert.strictEqual((await call(`/api/master/businesses/${globexBizId}`,
      { method: 'DELETE', body: JSON.stringify({ confirm: 'globex' }) }, acme)).status, 403);
    ok('a business admin cannot delete a workspace');

    const wrongConfirm = await call(`/api/master/businesses/${globexBizId}`,
      { method: 'DELETE', body: JSON.stringify({ confirm: 'wrong' }) }, master);
    assert.strictEqual(wrongConfirm.status, 400);
    assert.ok(db.prepare('SELECT 1 FROM businesses WHERE id = ?').get(globexBizId));
    ok('a mistyped confirmation deletes nothing');

    const gone = await call(`/api/master/businesses/${globexBizId}`,
      { method: 'DELETE', body: JSON.stringify({ confirm: 'GLOBEX' }) }, master);
    assert.strictEqual(gone.status, 200);
    assert.strictEqual(gone.body.deleted.sessions, 1);
    ok('the confirmation is case-insensitive and reports what it removed');

    for (const t of ['businesses', 'users', 'sessions', 'distractions']) {
      const col = t === 'businesses' ? 'id' : 'business_id';
      const left = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${col} = ?`).get(globexBizId).c;
      assert.strictEqual(left, 0, `${t} still had rows`);
    }
    ok('deletion removes the business, its people, sessions and interruptions');

    const goneLogin = await post('/api/login', { slug: 'globex', name: 'Priya', pin: '620744' });
    assert.strictEqual(goneLogin.status, 401);
    assert.match(goneLogin.body.error, /Wrong details/);
    ok('the deleted team link stops working, without revealing it ever existed');

    // Acme is untouched by its neighbour being deleted.
    assert.strictEqual((await call('/api/admin/stats', {}, acme)).body.totals.sessions, 4);
    ok('deleting one business leaves the others intact');

    const spare2 = (await post('/api/master/codes', {}, master)).body.code;
    assert.strictEqual((await post('/api/slug-check', { code: spare2, slug: 'globex' })).body.available, true);
    ok('the freed team link becomes available again');

    const auditAfter = (await call('/api/master/audit', {}, master)).body.entries;
    assert.ok(auditAfter.some((a) => a.action === 'business_deleted' && /globex/.test(a.detail)));
    ok('deletion is written to the audit log with the row counts');

    console.log('\nAll checks passed.\n');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED:', err.message, '\n', err);
    server.close();
    process.exit(1);
  }
});
