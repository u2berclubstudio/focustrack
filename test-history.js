'use strict';
/* Cleared work and the history screen.
 * Run: DATA_DIR=/tmp/ft-hist node test-history.js
 */
process.env.MAIL_MODE = 'capture';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/ft-hist';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const fs = require('fs');
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
  const del = (p, t) => call(p, { method: 'DELETE' }, t);
  const ok = (m) => console.log('  ✓ ' + m);
  const IST = 330;
  const dayOf = (n) => new Date(Date.now() + IST * 60000 - n * 86400000).toISOString().slice(0, 10);

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
                                owner_name: 'Ravi', owner_pin: '481902' });
    const admin = (await post('/api/login', { slug: 'acme', name: 'Ravi', pin: '481902' })).body.token;
    await post('/api/admin/users', { name: 'Neha', pin: '774411', team: 'Sales' }, admin);
    const neha = (await post('/api/login', { slug: 'acme', name: 'Neha', pin: '774411' })).body.token;
    const nehaId = db.prepare("SELECT id FROM users WHERE name='Neha'").get().id;

    // ---------- today ----------
    const a = (await post('/api/my/plan', { title: 'Sharma quotation', estimate_min: 30 }, neha)).body.item.id;
    const b = (await post('/api/my/plan', { title: 'Follow up leads', estimate_min: 60 }, neha)).body.item.id;
    const asg = (await post('/api/admin/plans', { user_id: nehaId, title: 'Board deck', estimate_min: 90 }, admin)).body.item.id;

    await patch('/api/my/plan/' + a, { status: 'done' }, neha);
    await patch('/api/my/plan/' + asg, { status: 'skipped', skip_reason: 'Waiting on finance' }, neha);

    let plan = (await call('/api/my/plan', {}, neha)).body;
    assert.strictEqual(plan.items.length, 3, 'the API still returns everything');
    assert.strictEqual(plan.items.filter((i) => i.status === 'open').length, 1);
    ok('the API keeps returning all of today, open and cleared alike');

    assert.strictEqual(plan.totals.plannedMinutes, 60, 'only open work counts as time left');
    assert.strictEqual(plan.totals.done, 1);
    ok('the "time left" figure counts only what is still open');

    // ---------- putting something back ----------
    const back = await patch('/api/my/plan/' + a, { status: 'open' }, neha);
    assert.strictEqual(back.status, 200);
    assert.strictEqual(back.body.item.status, 'open');
    plan = (await call('/api/my/plan', {}, neha)).body;
    assert.strictEqual(plan.items.filter((i) => i.status === 'open').length, 2);
    ok('a task ticked by mistake can be put straight back');

    await patch('/api/my/plan/' + a, { status: 'done' }, neha);

    const unskip = await patch('/api/my/plan/' + asg, { status: 'open' }, neha);
    assert.strictEqual(unskip.body.item.status, 'open');
    ok('a skipped task can be reopened too');
    await patch('/api/my/plan/' + asg, { status: 'skipped', skip_reason: 'Waiting on finance' }, neha);

    // ---------- yesterday is closed ----------
    const old1 = (await post('/api/my/plan', { title: 'Old finished thing' }, neha)).body.item.id;
    await patch('/api/my/plan/' + old1, { status: 'done' }, neha);
    db.prepare('UPDATE plan_items SET plan_date = ? WHERE id = ?').run(dayOf(1), old1);

    const editPast = await patch('/api/my/plan/' + old1, { status: 'open' }, neha);
    assert.strictEqual(editPast.status, 403);
    assert.match(editPast.body.error, /finished|only change today/i);
    assert.strictEqual(db.prepare('SELECT status FROM plan_items WHERE id=?').get(old1).status, 'done');
    ok('a finished day cannot be re-ticked, so the report and the app agree');

    const delPast = await del('/api/my/plan/' + old1, neha);
    assert.strictEqual(delPast.status, 403);
    assert.ok(db.prepare('SELECT 1 FROM plan_items WHERE id=?').get(old1));
    ok('a task from a finished day cannot be deleted either');

    assert.strictEqual((await patch('/api/my/plan/' + b, { status: 'done' }, neha)).status, 200);
    await patch('/api/my/plan/' + b, { status: 'open' }, neha);
    ok('today is still fully editable, all day');

    // ---------- the history list ----------
    const s1 = (await post('/api/sessions/start', { task: 'Some work', planned_minutes: 30 }, neha)).body.session.id;
    db.prepare("UPDATE sessions SET status='completed', actual_seconds=1500, ended_at=? WHERE id=?")
      .run(nowISO(), s1);
    // a day with sessions but nothing planned
    const s2 = (await post('/api/sessions/start', { task: 'Unplanned day work', planned_minutes: 30 }, neha)).body.session.id;
    db.prepare("UPDATE sessions SET status='completed', actual_seconds=900, ended_at=?, started_at=? WHERE id=?")
      .run(nowISO(), new Date(Date.now() - 3 * 86400000).toISOString(), s2);

    const hist = (await call('/api/my/plan/history', {}, neha)).body;
    assert.ok(Array.isArray(hist.days) && hist.days.length >= 3);
    assert.strictEqual(hist.days[0].date, hist.today, 'newest first');
    ok('history lists the days newest first');

    const yesterday = hist.days.find((d) => d.date === dayOf(1));
    assert.ok(yesterday, 'yesterday should be listed');
    assert.strictEqual(yesterday.done, 1);
    ok('a past day carries its own counts');

    const sessionOnly = hist.days.find((d) => d.date === dayOf(3));
    assert.ok(sessionOnly, 'a day with sessions but no plan must still appear');
    assert.strictEqual(sessionOnly.items, 0);
    assert.strictEqual(sessionOnly.loggedMinutes, 15);
    ok('a day where someone worked without planning still shows in history');

    const todayRow = hist.days.find((d) => d.date === hist.today);
    assert.strictEqual(todayRow.isToday, true);
    assert.strictEqual(todayRow.skipped, 1);
    ok('today is flagged as today, and skipped work is counted separately');

    assert.ok(!hist.days.some((d) => d.date > hist.today), 'no future days');
    ok('history never shows a day that has not happened');

    // ---------- reading a past day ----------
    const past = (await call('/api/my/plan?date=' + dayOf(1), {}, neha)).body;
    assert.strictEqual(past.date, dayOf(1));
    assert.ok(past.items.some((i) => i.id === old1));
    ok('a past day can be read back exactly as it ended');

    // ---------- a day must not lose work that was carried out of it ----------
    const carried = (await post('/api/my/plan', { title: 'Rolled onward', estimate_min: 45 }, neha)).body.item.id;
    db.prepare('UPDATE plan_items SET plan_date = ? WHERE id = ?').run(dayOf(2), carried);
    await call('/api/my/plan', {}, neha);   // opening today rolls it forward

    assert.strictEqual(db.prepare('SELECT plan_date FROM plan_items WHERE id=?').get(carried).plan_date,
                       dayOf(0), 'it should now sit on today');

    const twoDaysAgo = (await call('/api/my/plan?date=' + dayOf(2), {}, neha)).body;
    const ghost = twoDaysAgo.items.find((i) => i.id === carried);
    assert.ok(ghost, 'the day it was carried out of must still show it');
    assert.strictEqual(ghost.status, 'carried');
    assert.strictEqual(ghost.carried_away, true);
    ok('a day still shows work that was later carried out of it');

    assert.strictEqual(twoDaysAgo.totals.carriedAway, 1);
    assert.ok(!twoDaysAgo.items.filter((i) => !i.carried_away).some((i) => i.id === carried));
    ok('carried-away work is flagged, not counted as that day\'s done or open');

    const todayPlan = (await call('/api/my/plan', {}, neha)).body;
    assert.strictEqual(todayPlan.items.filter((i) => i.id === carried).length, 1);
    assert.strictEqual(todayPlan.items.find((i) => i.id === carried).carried_away, false);
    ok('the same task appears once on today, as normal open work');

    // Reading an old date must not drag its leftovers into today.
    const beforeCount = (await call('/api/my/plan', {}, neha)).body.items.length;
    await call('/api/my/plan?date=' + dayOf(5), {}, neha);
    assert.strictEqual((await call('/api/my/plan', {}, neha)).body.items.length, beforeCount);
    ok('looking at an old day does not disturb today\'s plan');

    // ---------- other people's history ----------
    const inv2 = (await post('/api/master/codes', {}, master)).body.code;
    await post('/api/signup', { code: inv2, business_name: 'Globex', slug: 'globex',
                                owner_name: 'Priya', owner_pin: '620744' });
    const other = (await post('/api/login', { slug: 'globex', name: 'Priya', pin: '620744' })).body.token;
    const theirs = (await call('/api/my/plan/history', {}, other)).body;
    assert.strictEqual(theirs.days.length, 0, 'a new user has no history');
    ok('history only ever contains your own days');

    assert.strictEqual((await call('/api/my/plan/history')).status, 401);
    ok('history needs you to be signed in');

    // ---------- the screen itself ----------
    const html = fs.readFileSync('./public/app.html', 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: base + '/acme' });
    const w = dom.window;
    w.fetch = (u, o) => fetch(base + u, o);
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.navigator.serviceWorker = undefined;
    w.localStorage.setItem('ft_token_acme', neha);
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
      .replace(/^\(function \(\)[\s\S]*?\}\)\(\);/m, '');
    w.eval(script.replace(/boot\(\);?\s*$/, ''));

    await w.loadPlan();
    const openList = w.document.getElementById('planList').innerHTML;
    const strip = w.document.getElementById('doneList').innerHTML;

    assert.ok(openList.includes('Follow up leads'), 'unfinished work stays in the list');
    assert.ok(!openList.includes('Sharma quotation'), 'finished work must leave the list');
    assert.ok(!openList.includes('Board deck'), 'skipped work must leave the list too');
    ok('the open list holds only unfinished work');

    assert.ok(strip.includes('Sharma quotation') && strip.includes('Board deck'));
    ok('finished and skipped work moves into the strip');

    const label = w.document.getElementById('doneStripText').textContent;
    assert.match(label, /1 done/);
    assert.match(label, /1 skipped/);
    ok('the strip label distinguishes done from skipped rather than lumping them');

    assert.ok(w.document.getElementById('doneList').classList.contains('hidden'));
    w.document.getElementById('doneStrip').onclick();
    assert.ok(!w.document.getElementById('doneList').classList.contains('hidden'));
    ok('the strip is collapsed until you tap it');

    assert.ok(/data-act="toggle"/.test(strip), 'cleared rows must still be un-tickable');
    ok('a cleared task can be un-ticked straight from the strip');

    assert.ok(strip.includes('Waiting on finance'));
    ok('a skip reason stays visible in the strip');

    // history screen
    w.showView('history');
    await w.loadHistory();
    assert.ok(!w.document.getElementById('historyView').classList.contains('hidden'));
    assert.ok(w.document.getElementById('timerPanes').classList.contains('hidden'));
    const days = w.document.getElementById('histDays').innerHTML;
    assert.ok(days.includes('Today') && days.includes('Yesterday'));
    ok('the history screen names Today and Yesterday in words');

    const row = w.document.querySelector(`.day[data-date="${dayOf(1)}"]`);
    await w.document.getElementById('histDays').onclick({ target: row, preventDefault() {} });
    const items = w.document.getElementById('histItems').innerHTML;
    assert.ok(items.includes('Old finished thing'));
    assert.ok(!/data-act=/.test(items), 'a past day must render no action buttons');
    assert.ok(!w.document.getElementById('histReadonly').classList.contains('hidden'));
    ok('a past day opens read-only, with no buttons and a note saying why');

    console.log('\nHistory checks passed.\n');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED:', err.message, '\n', err.stack.split('\n').slice(0, 4).join('\n'));
    server.close();
    process.exit(1);
  }
});
