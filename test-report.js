'use strict';
/* End-of-day report. Run: DATA_DIR=/tmp/ft-rep node test-report.js
 *
 * The two things that matter: it goes out once per day in the workspace's own
 * timezone, and the numbers in it are true.
 */
process.env.MAIL_MODE = 'capture';
process.env.ALERTS_API_KEY = process.env.ALERTS_API_KEY || 'test-key-123';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/ft-rep';

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
    return { status: r.status, body: b };
  };
  const post = (p, b, t) => call(p, { method: 'POST', body: JSON.stringify(b || {}) }, t);
  const patch = (p, b, t) => call(p, { method: 'PATCH', body: JSON.stringify(b || {}) }, t);
  const kcall = async (p, o = {}, k = 'test-key-123') => {
    const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', 'X-Api-Key': k } });
    let b; const t = await r.text();
    try { b = JSON.parse(t); } catch { b = t; }
    return { status: r.status, body: b };
  };
  const ok = (m) => console.log('  ✓ ' + m);
  const IST = 330;
  const localDateFor = (tz) => new Date(Date.now() + tz * 60000).toISOString().slice(0, 10);
  const localHourFor = (tz) => new Date(Date.now() + tz * 60000).getUTCHours();

  try {
    for (const t of ['plan_items', 'distractions', 'sessions', 'tokens', 'users',
                     'invite_codes', 'businesses', 'audit_log', 'login_guard', 'otp_challenges']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }

    db.prepare(`INSERT INTO users (business_id,name,pin_hash,role,team,email,created_at)
                VALUES (NULL,?,?,'master','p',?,?)`)
      .run('Atul', hashPin('481902'), 'b@e.com', nowISO());
    const f = await post('/api/master/login', { name: 'Atul', pin: '481902' });
    const c = mailer.sent.at(-1).text.match(/\b(\d{6})\b/)[1];
    const master = (await post('/api/master/otp', { challenge: f.body.challenge, code: c })).body.token;
    const inv = (await post('/api/master/codes', { seat_limit: 20 }, master)).body.code;
    await post('/api/signup', { code: inv, business_name: 'Acme', slug: 'acme',
                                owner_name: 'Ravi', owner_pin: '481902', contact_email: 'boss@acme.com' });
    const admin = (await post('/api/login', { slug: 'acme', name: 'Ravi', pin: '481902' })).body.token;
    const bizId = db.prepare("SELECT id FROM businesses WHERE slug='acme'").get().id;

    await post('/api/admin/users', { name: 'Neha', pin: '774411', team: 'Sales' }, admin);
    await post('/api/admin/users', { name: 'Sam', pin: '905513', team: 'Ops' }, admin);
    const neha = (await post('/api/login', { slug: 'acme', name: 'Neha', pin: '774411' })).body.token;
    const nehaId = db.prepare("SELECT id FROM users WHERE name='Neha'").get().id;

    // ---------- settings ----------
    let st = (await call('/api/admin/settings', {}, admin)).body;
    assert.strictEqual(st.daily_report_hour, 18);
    ok('a new workspace defaults to a 6pm report');

    assert.strictEqual((await patch('/api/admin/settings', { daily_report_hour: 30 }, admin)).status, 400);
    assert.strictEqual((await call('/api/admin/settings', {}, admin)).body.daily_report_hour, 18);
    ok('an impossible hour is refused and the saved one is untouched');

    await patch('/api/admin/settings', { daily_report_hour: null }, admin);
    assert.strictEqual((await call('/api/admin/settings', {}, admin)).body.daily_report_hour, null);
    ok('the report can be switched off entirely');

    await patch('/api/admin/settings', { daily_report_hour: 18 }, admin);

    // ---------- a real day ----------
    const today = localDateFor(IST);
    const a1 = (await post('/api/my/plan', { title: 'Sharma quotation', estimate_min: 30 }, neha)).body.item.id;
    const a2 = (await post('/api/my/plan', { title: 'Follow up leads', estimate_min: 60 }, neha)).body.item.id;
    const asg = (await post('/api/admin/plans',
      { user_id: nehaId, title: 'Board deck', estimate_min: 90 }, admin)).body.item.id;

    const s1 = (await post('/api/sessions/start',
      { task: 'Sharma quotation', planned_minutes: 30, plan_item_id: a1 }, neha)).body.session.id;
    db.prepare("UPDATE sessions SET status='completed', actual_seconds=1500, ended_at=? WHERE id=?")
      .run(nowISO(), s1);
    await patch('/api/my/plan/' + a1, { status: 'done' }, neha);

    const s2 = (await post('/api/sessions/start',
      { task: 'Follow up leads', planned_minutes: 60, plan_item_id: a2 }, neha)).body.session.id;
    await post(`/api/sessions/${s2}/distraction`, { reason: 'WhatsApp' }, neha);
    db.prepare("UPDATE sessions SET status='completed', actual_seconds=3000, ended_at=? WHERE id=?")
      .run(nowISO(), s2);

    // unplanned work
    const s3 = (await post('/api/sessions/start', { task: 'Emergency client call', planned_minutes: 30 }, neha)).body.session.id;
    db.prepare("UPDATE sessions SET status='completed', actual_seconds=1200, ended_at=? WHERE id=?")
      .run(nowISO(), s3);

    await patch('/api/my/plan/' + asg, { status: 'skipped', skip_reason: 'Waiting on finance' }, neha);

    const rep = (await call('/api/admin/daily-report', {}, admin)).body;
    const her = rep.people.find((p) => p.name === 'Neha');

    assert.strictEqual(her.plannedMinutes, 90, 'skipped work should not count as planned');
    ok('skipped work is left out of the planned total');

    assert.strictEqual(her.loggedMinutes, 95);
    assert.strictEqual(her.sessions, 3);
    ok('logged minutes and session count are right');

    assert.strictEqual(her.done, 1);
    assert.strictEqual(her.planned, 2);
    ok('finished tasks are counted against what was planned');

    assert.strictEqual(her.assignedTotal, 1);
    assert.strictEqual(her.assignedDone, 0);
    ok('assigned work is counted separately from their own');

    assert.strictEqual(her.unplannedSessions, 1);
    assert.strictEqual(her.unplannedMinutes, 20);
    ok('work done that was never planned is reported too');

    assert.strictEqual(her.distractions, 1);
    ok('interruptions are attributed to the right person');

    const skipped = her.items.find((i) => i.title === 'Board deck');
    assert.strictEqual(skipped.status, 'skipped');
    assert.match(skipped.skipReason, /finance/);
    assert.strictEqual(skipped.assignedBy, 'Ravi');
    ok('a skipped assigned task carries its reason and who assigned it');

    const doneItem = her.items.find((i) => i.title === 'Sharma quotation');
    assert.strictEqual(doneItem.estimateMin, 30);
    assert.strictEqual(doneItem.actualMin, 25);
    ok('each task line shows estimate against actual');

    const sam = rep.people.find((p) => p.name === 'Sam');
    assert.strictEqual(sam.quiet, true);
    ok('someone with no plan and no sessions is flagged as quiet, not zeroed');

    assert.strictEqual(rep.totals.activePeople, 1);
    assert.strictEqual(rep.totals.quietPeople, 2);
    assert.strictEqual(rep.totals.loggedMinutes, 95);
    assert.strictEqual(rep.totals.assignedDone, 0);
    ok('the team totals only count people who actually did something');

    // ---------- another person's day must not bleed in ----------
    const sam2 = (await post('/api/login', { slug: 'acme', name: 'Sam', pin: '905513' })).body.token;
    const sс = (await post('/api/sessions/start', { task: 'Sam work', planned_minutes: 30 }, sam2)).body.session.id;
    db.prepare("UPDATE sessions SET status='completed', actual_seconds=600, ended_at=? WHERE id=?").run(nowISO(), sс);
    const rep2 = (await call('/api/admin/daily-report', {}, admin)).body;
    assert.strictEqual(rep2.people.find((p) => p.name === 'Neha').loggedMinutes, 95);
    assert.strictEqual(rep2.people.find((p) => p.name === 'Sam').loggedMinutes, 10);
    ok('each person\'s minutes stay their own');

    // ---------- yesterday's work is not in today's report ----------
    db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 30 * 3600000).toISOString(), s3);
    const rep3 = (await call('/api/admin/daily-report', {}, admin)).body;
    assert.strictEqual(rep3.people.find((p) => p.name === 'Neha').sessions, 2);
    ok('a session from yesterday is not counted in today');

    // ---------- when it is due ----------
    db.prepare('UPDATE businesses SET daily_report_hour = ?, last_daily_report_date = NULL WHERE id = ?')
      .run(23, bizId);
    let due = (await kcall('/api/automation/reports-due')).body.due;
    if (localHourFor(IST) < 23) {
      assert.ok(!due.some((d) => d.business.slug === 'acme'));
      ok('nothing is sent before the hour the admin chose');
    } else ok('(skipped: local clock is already past 23:00)');

    db.prepare('UPDATE businesses SET daily_report_hour = 0 WHERE id = ?').run(bizId);
    due = (await kcall('/api/automation/reports-due')).body.due;
    assert.ok(due.some((d) => d.business.slug === 'acme'), 'past the hour, it should be due');
    ok('once the hour has passed, the report becomes due');

    const one = due.find((d) => d.business.slug === 'acme');
    assert.strictEqual(one.date, today);
    assert.strictEqual(one.business.contactEmail, 'boss@acme.com');
    assert.ok(one.people.length >= 3);
    ok('the feed carries the date, the address and everybody\'s lines');

    // ---------- exactly once a day ----------
    const mark = await kcall('/api/automation/reports-sent',
      { method: 'POST', body: JSON.stringify({ sent: [{ businessId: bizId, date: today }] }) });
    assert.strictEqual(mark.body.updated, 1);
    for (let i = 0; i < 5; i++) {
      const again = (await kcall('/api/automation/reports-due')).body.due;
      assert.ok(!again.some((d) => d.business.slug === 'acme'), 'must not resend the same day');
    }
    ok('running the workflow every hour still sends only one report a day');

    db.prepare('UPDATE businesses SET last_daily_report_date = ? WHERE id = ?')
      .run('2020-01-01', bizId);
    assert.ok((await kcall('/api/automation/reports-due')).body.due.some((d) => d.business.slug === 'acme'));
    ok('the next day it becomes due again');

    // ---------- timezone ----------
    // Same instant, a workspace far enough west that it is still yesterday.
    db.prepare('UPDATE businesses SET tz_offset = ?, daily_report_hour = ?, last_daily_report_date = NULL WHERE id = ?')
      .run(-480, 0, bizId);
    const west = (await kcall('/api/automation/reports-due')).body.due.find((d) => d.business.slug === 'acme');
    assert.strictEqual(west.date, localDateFor(-480));
    ok('the report covers the workspace\'s own local day, not the server\'s');

    db.prepare('UPDATE businesses SET tz_offset = ? WHERE id = ?').run(IST, bizId);

    // ---------- switched off ----------
    db.prepare('UPDATE businesses SET daily_report_hour = NULL, last_daily_report_date = NULL WHERE id = ?')
      .run(bizId);
    assert.ok(!(await kcall('/api/automation/reports-due')).body.due.some((d) => d.business.slug === 'acme'));
    ok('a workspace with the report switched off is never included');

    db.prepare('UPDATE businesses SET daily_report_hour = 0 WHERE id = ?').run(bizId);
    db.prepare("UPDATE businesses SET contact_email = '' WHERE id = ?").run(bizId);
    assert.ok(!(await kcall('/api/automation/reports-due')).body.due.some((d) => d.business.slug === 'acme'));
    ok('a workspace with no email address is skipped rather than erroring');
    db.prepare("UPDATE businesses SET contact_email = 'boss@acme.com' WHERE id = ?").run(bizId);

    db.prepare("UPDATE businesses SET status = 'suspended' WHERE id = ?").run(bizId);
    assert.ok(!(await kcall('/api/automation/reports-due')).body.due.some((d) => d.business.slug === 'acme'));
    db.prepare("UPDATE businesses SET status = 'active' WHERE id = ?").run(bizId);
    ok('a suspended workspace stops getting reports');

    // ---------- access ----------
    assert.strictEqual((await call('/api/automation/reports-due')).status, 401);
    assert.strictEqual((await kcall('/api/automation/reports-due', {}, 'wrong')).status, 401);
    ok('the report feed needs the automation key');

    assert.strictEqual((await call('/api/admin/daily-report', {}, neha)).status, 403);
    ok('a normal team member cannot pull the report');

    const inv2 = (await post('/api/master/codes', {}, master)).body.code;
    await post('/api/signup', { code: inv2, business_name: 'Globex', slug: 'globex',
                                owner_name: 'Priya', owner_pin: '620744' });
    const other = (await post('/api/login', { slug: 'globex', name: 'Priya', pin: '620744' })).body.token;
    const peek = (await call('/api/admin/daily-report', {}, other)).body;
    assert.deepStrictEqual(peek.people.map((p) => p.name), ['Priya']);
    ok('an admin\'s report only ever contains their own people');

    const junk = await kcall('/api/automation/reports-sent',
      { method: 'POST', body: JSON.stringify({ sent: [{ businessId: 'x', date: 'nope' }, null] }) });
    assert.strictEqual(junk.body.updated, 0);
    ok('junk in the mark-sent call updates nothing and does not error');

    console.log('\nReport checks passed.\n');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED:', err.message, '\n', err);
    server.close();
    process.exit(1);
  }
});
