'use strict';
/* One paying customer trying to reach another customer's data.
 * Run: DATA_DIR=/tmp/ft-xt node test-crosstenant.js
 *
 * "Mallory" is a real, fully paid-up workspace owner. Everything she does here
 * is with a valid token for her own workspace — this is not an outsider
 * guessing PINs, it is the far more realistic case of a legitimate customer
 * poking at ids that aren't hers.
 */
process.env.MAIL_MODE = 'capture';
process.env.ALERTS_API_KEY = process.env.ALERTS_API_KEY || 'test-key-123';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/ft-xt';

const assert = require('assert');
const app = require('./server');
const { db, hashPin, nowISO } = require('./db');
const mailer = require('./mailer');

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, o = {}, tok) => {
    const r = await fetch(base + p, {
      ...o,
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    });
    let b; const t = await r.text();
    try { b = JSON.parse(t); } catch { b = t; }
    return { status: r.status, body: b, text: t };
  };
  const post = (p, b, t) => call(p, { method: 'POST', body: JSON.stringify(b || {}) }, t);
  const patch = (p, b, t) => call(p, { method: 'PATCH', body: JSON.stringify(b || {}) }, t);
  const del = (p, t) => call(p, { method: 'DELETE' }, t);
  const ok = (m) => console.log('  ✓ ' + m);
  const blocked = (r) => [401, 403, 404, 400].includes(r.status);

  try {
    for (const t of ['plan_items', 'distractions', 'sessions', 'tokens', 'users',
                     'invite_codes', 'businesses', 'audit_log', 'login_guard', 'otp_challenges']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }

    // ---- the platform, and two unrelated customers ----
    db.prepare(`INSERT INTO users (business_id,name,pin_hash,role,team,email,created_at)
                VALUES (NULL,?,?,'master','p',?,?)`)
      .run('Atul', hashPin('481902'), 'boss@platform.com', nowISO());
    const f = await post('/api/master/login', { name: 'Atul', pin: '481902' });
    const code = mailer.sent.at(-1).text.match(/\b(\d{6})\b/)[1];
    const master = (await post('/api/master/otp', { challenge: f.body.challenge, code })).body.token;

    const newCode = async () => (await post('/api/master/codes', { seat_limit: 20 }, master)).body.code;

    // VICTIM: a real customer with real data
    await post('/api/signup', { code: await newCode(), business_name: 'Victim Ltd', slug: 'victim',
                                owner_name: 'Priya', owner_pin: '620744', contact_email: 'priya@victim.com' });
    const vAdmin = (await post('/api/login', { slug: 'victim', name: 'Priya', pin: '620744' })).body.token;
    await post('/api/admin/users', { name: 'Deepak', pin: '830155', team: 'Finance' }, vAdmin);
    const vStaff = (await post('/api/login', { slug: 'victim', name: 'Deepak', pin: '830155' })).body.token;
    const vBizId = db.prepare("SELECT id FROM businesses WHERE slug='victim'").get().id;
    const vUserId = db.prepare("SELECT u.id FROM users u JOIN businesses b ON b.id=u.business_id WHERE b.slug='victim' AND u.name='Deepak'").get().id;

    const vSess = (await post('/api/sessions/start',
      { task: 'CONFIDENTIAL merger numbers', planned_minutes: 30 }, vStaff)).body.session.id;
    await post(`/api/sessions/${vSess}/distraction`, { reason: 'SECRET call from bank' }, vStaff);
    const vPlan = (await post('/api/my/plan', { title: 'CONFIDENTIAL board paper' }, vStaff)).body.item.id;
    db.prepare("UPDATE sessions SET status='completed', actual_seconds=1500, ended_at=? WHERE id=?")
      .run(nowISO(), vSess);

    // ATTACKER: an entirely legitimate customer on the same platform
    await post('/api/signup', { code: await newCode(), business_name: 'Mallory Inc', slug: 'mallory',
                                owner_name: 'Mallory', owner_pin: '774411', contact_email: 'm@mallory.com' });
    const mal = (await post('/api/login', { slug: 'mallory', name: 'Mallory', pin: '774411' })).body.token;

    const leaks = (r) => /CONFIDENTIAL|SECRET|Deepak|Priya|victim/i.test(r.text || '');

    // ---------- reading the victim's data ----------
    for (const [label, r] of [
      ['stats', await call('/api/admin/stats', {}, mal)],
      ['stats with their user id', await call(`/api/admin/stats?user_id=${vUserId}`, {}, mal)],
      ['session list', await call('/api/admin/sessions', {}, mal)],
      ['CSV export', await call('/api/admin/export.csv', {}, mal)],
      ['user list', await call('/api/admin/users', {}, mal)],
      ['plans', await call('/api/admin/plans', {}, mal)],
      ['inactive list', await call('/api/admin/inactive-members?hours=1', {}, mal)],
      ['daily report', await call('/api/admin/daily-report', {}, mal)],
    ]) {
      assert.ok(!leaks(r), `${label} leaked the other customer's data`);
    }
    ok('none of the eight admin read endpoints return another customer\'s data');

    // ---------- forging the range to sweep everything ----------
    const wide = await call('/api/admin/stats?from=2000-01-01&to=2099-12-31', {}, mal);
    assert.ok(!leaks(wide));
    ok('widening the date range to a century still returns only her own workspace');

    // ---------- writing into the victim's workspace ----------
    const reset = await patch(`/api/admin/users/${vUserId}`, { pin: '111222' }, mal);
    assert.ok(blocked(reset), 'must not reset another workspace\'s PIN');
    assert.strictEqual((await post('/api/login', { slug: 'victim', name: 'Deepak', pin: '830155' })).status, 200);
    ok('she cannot reset a PIN in the other workspace (their login still works)');

    const disable = await patch(`/api/admin/users/${vUserId}`, { active: 0 }, mal);
    assert.ok(blocked(disable));
    assert.strictEqual(db.prepare('SELECT active FROM users WHERE id=?').get(vUserId).active, 1);
    ok('she cannot disable someone else\'s employee');

    const promote = await patch(`/api/admin/users/${vUserId}`, { role: 'owner' }, mal);
    assert.ok(blocked(promote));
    assert.strictEqual(db.prepare('SELECT role FROM users WHERE id=?').get(vUserId).role, 'employee');
    ok('she cannot promote someone in another workspace to owner');

    const assign = await post('/api/admin/plans', { user_id: vUserId, title: 'Do my work' }, mal);
    assert.ok(blocked(assign));
    ok('she cannot put tasks on another workspace\'s employee');

    const killPlan = await del('/api/admin/plans/' + vPlan, mal);
    assert.ok(blocked(killPlan));
    assert.ok(db.prepare('SELECT 1 FROM plan_items WHERE id=?').get(vPlan));
    ok('she cannot delete another workspace\'s planned work');

    const touchPlan = await patch('/api/my/plan/' + vPlan, { status: 'done' }, mal);
    assert.ok(blocked(touchPlan));
    assert.strictEqual(db.prepare('SELECT status FROM plan_items WHERE id=?').get(vPlan).status, 'open');
    ok('she cannot mark another person\'s task as done');

    const hijack = await post('/api/sessions/start',
      { task: 'x', planned_minutes: 15, plan_item_id: vPlan }, mal);
    assert.ok(blocked(hijack));
    ok('she cannot start a timer against another workspace\'s task');

    // ---------- ending their sessions ----------
    const vSess2 = (await post('/api/sessions/start', { task: 'CONFIDENTIAL part two', planned_minutes: 30 }, vStaff)).body.session.id;
    for (const [label, r] of [
      ['complete', await post(`/api/sessions/${vSess2}/complete`, {}, mal)],
      ['stop', await post(`/api/sessions/${vSess2}/stop`, {}, mal)],
      ['add a distraction', await post(`/api/sessions/${vSess2}/distraction`, { reason: 'noise' }, mal)],
    ]) {
      assert.ok(blocked(r), `must not be able to ${label} another user's session`);
    }
    assert.strictEqual(db.prepare('SELECT status FROM sessions WHERE id=?').get(vSess2).status, 'running');
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM distractions WHERE session_id=?').get(vSess2).c, 0);
    ok('she cannot end, abandon or annotate another person\'s running session');

    // ---------- kicking their team off ----------
    const before = db.prepare('SELECT COUNT(*) c FROM tokens WHERE user_id IN (SELECT id FROM users WHERE business_id=?)').get(vBizId).c;
    await post('/api/admin/logout-all', {}, mal);
    const after = db.prepare('SELECT COUNT(*) c FROM tokens WHERE user_id IN (SELECT id FROM users WHERE business_id=?)').get(vBizId).c;
    assert.strictEqual(before, after, '"sign everyone out" must not reach another workspace');
    assert.strictEqual((await call('/api/me', {}, vStaff)).status, 200);
    ok('"sign everyone out" only ends her own workspace\'s sessions');

    // ---------- changing their settings ----------
    const settings = await patch('/api/admin/settings',
      { name: 'Owned', contact_email: 'attacker@evil.com', daily_report_hour: 3 }, mal);
    const vBiz = db.prepare('SELECT * FROM businesses WHERE id=?').get(vBizId);
    assert.strictEqual(vBiz.name, 'Victim Ltd');
    assert.strictEqual(vBiz.contact_email, 'priya@victim.com');
    ok('her settings changes land on her own workspace, never the other one');

    // Redirecting the victim's report to herself would be the quiet win.
    assert.notStrictEqual(vBiz.contact_email, 'attacker@evil.com');
    ok('she cannot redirect another workspace\'s daily report to her own inbox');

    // ---------- climbing to master ----------
    for (const [label, r] of [
      ['overview', await call('/api/master/overview', {}, mal)],
      ['invite codes', await call('/api/master/codes', {}, mal)],
      ['make a code', await post('/api/master/codes', {}, mal)],
      ['audit log', await call('/api/master/audit', {}, mal)],
      ['suspend them', await post(`/api/master/businesses/${vBizId}/status`, { status: 'suspended' }, mal)],
      ['rename them', await patch(`/api/master/businesses/${vBizId}`, { name: 'Owned' }, mal)],
      ['delete them', await del(`/api/master/businesses/${vBizId}`, mal)],
      ['impersonate them', await post(`/api/master/businesses/${vBizId}/impersonate`, {}, mal)],
    ]) {
      assert.strictEqual(r.status, 403, `master route "${label}" must refuse a business admin`);
    }
    assert.strictEqual(db.prepare('SELECT status FROM businesses WHERE id=?').get(vBizId).status, 'active');
    ok('all eight master-only routes refuse a business admin, and nothing changed');

    // ---------- promoting herself ----------
    const meId = db.prepare("SELECT u.id FROM users u JOIN businesses b ON b.id=u.business_id WHERE b.slug='mallory'").get().id;
    await patch(`/api/admin/users/${meId}`, { role: 'master' }, mal);
    assert.notStrictEqual(db.prepare('SELECT role FROM users WHERE id=?').get(meId).role, 'master');
    assert.strictEqual((await call('/api/master/overview', {}, mal)).status, 403);
    ok('she cannot promote herself to master by editing her own user record');

    // ---------- the automation surface ----------
    for (const p of ['/api/automation/alerts-due', '/api/automation/reports-due']) {
      assert.strictEqual((await call(p, {}, mal)).status, 401);
      const withToken = await fetch(base + p, { headers: { 'X-Api-Key': mal } });
      assert.strictEqual(withToken.status, 401);
    }
    ok('the automation feed ignores her login token entirely');

    // ---------- the employee floor ----------
    const malStaffPin = '905513';
    await post('/api/admin/users', { name: 'Junior', pin: malStaffPin }, mal);
    const junior = (await post('/api/login', { slug: 'mallory', name: 'Junior', pin: malStaffPin })).body.token;
    for (const [label, r] of [
      ['stats', await call('/api/admin/stats', {}, junior)],
      ['users', await call('/api/admin/users', {}, junior)],
      ['export', await call('/api/admin/export.csv', {}, junior)],
      ['plans', await call('/api/admin/plans', {}, junior)],
      ['report', await call('/api/admin/daily-report', {}, junior)],
      ['settings', await patch('/api/admin/settings', { name: 'x' }, junior)],
      ['add a user', await post('/api/admin/users', { name: 'Ghost', pin: '318266' }, junior)],
    ]) {
      assert.strictEqual(r.status, 403, `an employee must not reach "${label}"`);
    }
    ok('an ordinary employee cannot reach any admin route, even in their own workspace');

    // ---------- stolen and stale tokens ----------
    assert.strictEqual((await call('/api/admin/stats', {}, vAdmin + 'x')).status, 401);
    assert.strictEqual((await call('/api/admin/stats', {}, 'Bearer')).status, 401);
    assert.strictEqual((await call('/api/admin/stats', {}, '')).status, 401);
    ok('a tampered or empty token is refused');

    db.prepare('UPDATE tokens SET expires_at = ? WHERE token = ?')
      .run(new Date(Date.now() - 1000).toISOString(), mal);
    assert.strictEqual((await call('/api/admin/stats', {}, mal)).status, 401);
    ok('an expired token stops working immediately');

    // ---------- a suspended customer ----------
    const mal2 = (await post('/api/login', { slug: 'mallory', name: 'Mallory', pin: '774411' })).body.token;
    await post(`/api/master/businesses/${db.prepare("SELECT id FROM businesses WHERE slug='mallory'").get().id}/status`,
      { status: 'suspended' }, master);
    // Suspending deletes their tokens outright, so this is 401 (token gone)
    // rather than 403 (token fine, workspace barred). Either would be safe;
    // deleting is the stronger of the two.
    const susp = await call('/api/admin/stats', {}, mal2);
    assert.strictEqual(susp.status, 401);
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) c FROM tokens WHERE user_id IN (SELECT id FROM users WHERE business_id = (SELECT id FROM businesses WHERE slug='mallory'))").get().c,
      0, 'suspending should leave no live sessions behind');
    ok('suspending a workspace deletes its live sessions on the spot, not at expiry');

    // ---------- what the public can see ----------
    const pub = await call('/api/business/victim');
    assert.strictEqual(pub.status, 200);
    assert.deepStrictEqual(Object.keys(pub.body.business).sort(), ['name', 'slug', 'status']);
    assert.ok(!/priya|deepak|@/i.test(pub.text), 'the public lookup must not name people');
    ok('the public workspace lookup gives only a name and status, never people');

    console.log('\nCross-tenant checks passed — no path found from one customer to another.\n');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED:', err.message, '\n', err);
    server.close();
    process.exit(1);
  }
});
