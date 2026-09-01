'use strict';
/* Time added by hand. Run: DATA_DIR=/tmp/ft-man node test-manual.js
 *
 * The point of most of these: hand-entered time must never be able to score
 * better than time that was actually measured.
 */
process.env.MAIL_MODE = 'capture';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/ft-man';

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
    return { status: r.status, body: b, text: t };
  };
  const post = (p, b, t) => call(p, { method: 'POST', body: JSON.stringify(b || {}) }, t);
  const del = (p, t) => call(p, { method: 'DELETE' }, t);
  const ok = (m) => console.log('  ✓ ' + m);
  const IST = 330;

  try {
    for (const t of ['plan_items', 'distractions', 'sessions', 'tokens', 'users',
                     'invite_codes', 'businesses', 'audit_log', 'login_guard', 'otp_challenges']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }

    db.prepare(`INSERT INTO users (business_id,name,pin_hash,role,team,email,created_at)
                VALUES (NULL,?,?,'master','p',?,?)`)
      .run('Atul', hashPin('481902'), 'b@e.com', nowISO());
    const f = await post('/api/master/login', { name: 'Atul', pin: '481902' });
    const code = mailer.sent.at(-1).text.match(/\b(\d{6})\b/)[1];
    const master = (await post('/api/master/otp', { challenge: f.body.challenge, code })).body.token;
    const inv = (await post('/api/master/codes', { seat_limit: 20 }, master)).body.code;
    await post('/api/signup', { code: inv, business_name: 'Acme', slug: 'acme',
                                owner_name: 'Ravi', owner_pin: '481902', contact_email: 'boss@acme.com' });
    const admin = (await post('/api/login', { slug: 'acme', name: 'Ravi', pin: '481902' })).body.token;
    await post('/api/admin/users', { name: 'Neha', pin: '774411', team: 'Sales' }, admin);
    await post('/api/admin/users', { name: 'Sam', pin: '905513', team: 'Ops' }, admin);
    const neha = (await post('/api/login', { slug: 'acme', name: 'Neha', pin: '774411' })).body.token;
    const sam = (await post('/api/login', { slug: 'acme', name: 'Sam', pin: '905513' })).body.token;

    // ---------- adding ----------
    const add = await post('/api/my/manual', { task: 'Client call about Sharma order', minutes: 45 }, neha);
    assert.strictEqual(add.status, 200);
    assert.strictEqual(add.body.entry.entry_mode, 'manual');
    assert.strictEqual(add.body.entry.actual_seconds, 45 * 60);
    assert.strictEqual(add.body.entry.status, 'completed');
    ok('you can add time you forgot to track');

    assert.strictEqual(add.body.summary.manualMinutes, 45);
    assert.strictEqual(add.body.summary.trackedMinutes, 0);
    ok('the summary keeps added time and timed time apart');

    assert.strictEqual((await post('/api/my/manual', { task: '  ', minutes: 30 }, neha)).status, 400);
    assert.strictEqual((await post('/api/my/manual', { task: 'x', minutes: 2 }, neha)).status, 400);
    assert.strictEqual((await post('/api/my/manual', { task: 'x', minutes: 'lots' }, neha)).status, 400);
    ok('a blank task, a two-minute entry and nonsense input are all refused');

    const huge = await post('/api/my/manual', { task: 'Everything', minutes: 600 }, neha);
    assert.strictEqual(huge.status, 400);
    assert.match(huge.body.error, /at most 8 hours/);
    ok('a single entry cannot exceed eight hours');

    // ---------- today only ----------
    assert.ok(!Object.keys(add.body.entry).includes('plan_date'));
    const yesterdayTry = await post('/api/my/manual',
      { task: 'Yesterday work', minutes: 60, date: '2020-01-01' }, neha);
    assert.strictEqual(yesterdayTry.status, 200);
    const stamped = db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(yesterdayTry.body.entry.id);
    const localDay = new Date(new Date(stamped.started_at).getTime() + IST * 60000).toISOString().slice(0, 10);
    const todayLocal = new Date(Date.now() + IST * 60000).toISOString().slice(0, 10);
    assert.strictEqual(localDay, todayLocal, 'a date in the request must be ignored');
    ok('a date sent by the client is ignored — entries always land on today');

    await del('/api/my/manual/' + yesterdayTry.body.entry.id, neha);

    // ---------- the daily cap ----------
    for (let i = 0; i < 5; i++) {
      await post('/api/my/manual', { task: 'Block ' + i, minutes: 100 }, neha);
    }
    const over = await post('/api/my/manual', { task: 'One more', minutes: 100 }, neha);
    assert.strictEqual(over.status, 400);
    assert.match(over.body.error, /past 10 hours|minutes left/);
    ok('a day\'s hand-entered time is capped, with the remaining budget named');

    const summary = (await call('/api/my/manual', {}, neha)).body;
    assert.ok(summary.manualMinutes <= summary.maxDayMinutes);
    ok('the cap actually holds');

    // ---------- removing ----------
    const first = summary.entries[summary.entries.length - 1];
    assert.strictEqual((await del('/api/my/manual/' + first.id, neha)).status, 200);
    assert.ok(!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(first.id));
    ok('you can remove an entry you added by mistake');

    assert.strictEqual((await del('/api/my/manual/' + first.id, neha)).status, 404);
    ok('removing it twice is refused rather than erroring');

    // a past entry cannot be removed
    const keep = (await call('/api/my/manual', {}, neha)).body.entries[0];
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 3 * 86400000).toISOString(), keep.id);
    const oldDel = await del('/api/my/manual/' + keep.id, neha);
    assert.strictEqual(oldDel.status, 403);
    ok('an entry from a finished day cannot be removed');
    db.prepare('DELETE FROM sessions WHERE id = ?').run(keep.id);

    // ---------- you cannot touch anyone else's ----------
    const hers = (await post('/api/my/manual', { task: 'Mine', minutes: 30 }, sam)).body.entry.id;
    assert.strictEqual((await del('/api/my/manual/' + hers, neha)).status, 404);
    assert.ok(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(hers));
    ok('you cannot delete somebody else\'s entry');

    // ---------- the whole point: it must not score ----------
    db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE name='Neha')").run();

    // Neha uses the timer honestly and logs interruptions.
    const s1 = (await post('/api/sessions/start', { task: 'Real work', planned_minutes: 30 }, neha)).body.session.id;
    await post(`/api/sessions/${s1}/distraction`, { reason: 'WhatsApp' }, neha);
    await post(`/api/sessions/${s1}/distraction`, { reason: 'Colleague' }, neha);
    db.prepare("UPDATE sessions SET status='completed', actual_seconds=1800, ended_at=? WHERE id=?")
      .run(nowISO(), s1);

    // Sam types the same amount of time in at day end, no interruptions.
    db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE name='Sam')").run();
    await post('/api/my/manual', { task: 'Same work', minutes: 30 }, sam);

    const stats = (await call('/api/admin/stats', {}, admin)).body;
    const n = stats.employees.find((e) => e.name === 'Neha');
    const sm = stats.employees.find((e) => e.name === 'Sam');

    assert.ok(n.focusScore > 0, 'the person who used the timer should have a score');
    assert.strictEqual(sm.focusScore, null, 'the person who only typed time should have none');
    ok('typing time in gets no focus score at all — a perfect score is impossible');

    assert.strictEqual(sm.sessions, 0);
    assert.strictEqual(sm.focusedMinutes, 0);
    assert.strictEqual(sm.manualMinutes, 30);
    ok('their added time is reported, but not as focused work');

    assert.strictEqual(n.manualMinutes, 0);
    assert.strictEqual(n.focusedMinutes, 30);
    ok('the honest timer user\'s figures are untouched by the feature');

    assert.strictEqual(stats.totals.manualHours, 0.5);
    assert.strictEqual(stats.totals.focusedHours, 0.5);
    assert.strictEqual(stats.totals.sessions, 1);
    ok('team totals count the two kinds of time separately');

    // ---------- the hourly chart must not be invented ----------
    const hourSessions = stats.hours.reduce((a, h) => a + h.sessions, 0);
    assert.strictEqual(hourSessions, 1, 'only the timed session belongs on the hourly chart');
    ok('hand-entered time stays out of the "best hours" chart');

    const dailyMinutes = stats.daily.reduce((a, d) => a + d.focusedMinutes, 0);
    assert.strictEqual(dailyMinutes, 30);
    ok('the daily focus chart counts measured time only');

    // ---------- attaching to a planned task ----------
    const item = (await post('/api/my/plan', { title: 'Weekly report', estimate_min: 60 }, neha)).body.item.id;
    const linked = await post('/api/my/manual',
      { task: 'Weekly report', minutes: 40, plan_item_id: item }, neha);
    assert.strictEqual(linked.body.entry.plan_item_id, item);
    const plan = (await call('/api/my/plan', {}, neha)).body;
    assert.strictEqual(plan.items.find((i) => i.id === item).actual_seconds, 40 * 60);
    ok('added time can be credited to a planned task');

    const notMine = (await post('/api/my/plan', { title: 'Sam task' }, sam)).body.item.id;
    assert.strictEqual((await post('/api/my/manual',
      { task: 'x', minutes: 30, plan_item_id: notMine }, neha)).status, 404);
    ok('you cannot credit added time to somebody else\'s task');

    // ---------- what the admin sees ----------
    const rep = (await call('/api/admin/daily-report', {}, admin)).body;
    const samRow = rep.people.find((p) => p.name === 'Sam');
    assert.strictEqual(samRow.manualMinutes, 30);
    assert.strictEqual(samRow.loggedMinutes, 0);
    assert.strictEqual(samRow.allManual, true);
    ok('the daily report shows a hand-entered day as exactly that');

    const csv = (await call('/api/admin/export.csv', {}, admin)).text;
    assert.ok(csv.includes('entry_mode'));
    assert.ok(csv.includes('"added by hand"'));
    assert.ok(csv.includes('"timed"'));
    ok('the CSV export labels every row as timed or added by hand');

    const manualLine = csv.split('\n').find((l) => l.includes('added by hand'));
    assert.match(manualLine, /,"","",/, 'a hand-entered row must not export a start time');
    ok('a hand-entered row exports no clock time, since it never had one');

    // ---------- the screen ----------
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

    w.showView('missed');
    assert.ok(!w.document.getElementById('missedView').classList.contains('hidden'));
    assert.ok(w.document.getElementById('timerPanes').classList.contains('hidden'));
    ok('Missed time is its own tab, separate from the timer');

    await w.loadMissed();
    const note = w.document.getElementById('mNote').textContent;
    assert.match(note, /not your focus score/);
    ok('the tab says plainly that added time does not affect the focus score');

    assert.match(note, /can add up to/);
    ok('it shows how much more can still be added today');

    const list = w.document.getElementById('mList').innerHTML;
    assert.ok(list.includes('Weekly report'));
    assert.ok(list.includes('added by hand'));
    ok('today\'s added entries are listed and labelled');

    const opts = w.document.getElementById('mPlan').innerHTML;
    assert.ok(opts.includes('Weekly report'), 'open plan tasks should be offered');
    ok('today\'s planned tasks are offered so the time lands on the right one');

    w.showView('timer');
    assert.ok(!w.document.getElementById('timerPanes').classList.contains('hidden'));
    ok('switching back to the timer works');

    console.log('\nManual time checks passed.\n');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED:', err.message, '\n', err.stack.split('\n').slice(0, 4).join('\n'));
    server.close();
    process.exit(1);
  }
});
