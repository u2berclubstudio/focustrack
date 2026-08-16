'use strict';
/* Day planner. Run: DATA_DIR=/tmp/ft-plan node test-planner.js
 *
 * The awkward cases live here: work carried forward across days, an admin
 * assigning into someone else's plan, and the line between the two.
 */
process.env.MAIL_MODE = 'capture';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/ft-plan';

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
  const del = (p, t) => call(p, { method: 'DELETE' }, t);
  const ok = (m) => console.log('  ✓ ' + m);
  const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() + 330 * 60000 - n * 86400000).toISOString().slice(0, 10);

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
                                owner_name: 'Ravi', owner_pin: '481902' });
    const admin = (await post('/api/login', { slug: 'acme', name: 'Ravi', pin: '481902' })).body.token;
    await post('/api/admin/users', { name: 'Neha', pin: '774411', team: 'Sales' }, admin);
    const neha = (await post('/api/login', { slug: 'acme', name: 'Neha', pin: '774411' })).body.token;
    const nehaId = db.prepare("SELECT id FROM users WHERE name='Neha'").get().id;

    // ---------- planning your own day ----------
    let p = await post('/api/my/plan', { title: 'Sharma quotation', estimate_min: 30 }, neha);
    assert.strictEqual(p.status, 200);
    const q = p.body.item.id;
    await post('/api/my/plan', { title: 'Follow up leads', estimate_min: 60 }, neha);
    let plan = (await call('/api/my/plan', {}, neha)).body;
    assert.strictEqual(plan.items.length, 2);
    assert.strictEqual(plan.totals.plannedMinutes, 90);
    ok('you can add tasks to your own day and the estimates add up');

    assert.strictEqual((await post('/api/my/plan', { title: '  ' }, neha)).status, 400);
    ok('a blank task is refused');

    const wild = await post('/api/my/plan', { title: 'Huge', estimate_min: 9999 }, neha);
    assert.strictEqual(wild.body.item.estimate_min, 480);
    await del('/api/my/plan/' + wild.body.item.id, neha);
    ok('a silly estimate is clamped rather than stored');

    // ---------- fixed times ----------
    const fixed = await post('/api/my/plan', { title: 'Client call', estimate_min: 60, at_time: '15:00' }, neha);
    assert.strictEqual(fixed.body.item.at_time, '15:00');
    const junk = await post('/api/my/plan', { title: 'Nope', at_time: '25:99' }, neha);
    assert.strictEqual(junk.body.item.at_time, null);
    await del('/api/my/plan/' + junk.body.item.id, neha);
    ok('a real clock time is kept, a nonsense one is dropped');

    // ---------- reordering ----------
    plan = (await call('/api/my/plan', {}, neha)).body;
    const rev = plan.items.map((i) => i.id).reverse();
    const after = (await post('/api/my/plan/reorder', { ids: rev }, neha)).body;
    assert.deepStrictEqual(after.items.map((i) => i.id), rev);
    ok('you can reorder your own list');

    const scrambled = await post('/api/my/plan/reorder', { ids: [999999, 888888] }, neha);
    assert.strictEqual(scrambled.body.items.length, 3);
    ok('unknown ids in a reorder are ignored, not obeyed');

    // ---------- starting the timer from the plan ----------
    const started = await post('/api/sessions/start',
      { task: 'Sharma quotation', planned_minutes: 30, plan_item_id: q }, neha);
    assert.strictEqual(started.status, 200);
    assert.strictEqual(started.body.session.plan_item_id, q);
    ok('starting from a plan item stamps the session with it');

    const free = await post('/api/sessions/start', { task: 'Something unplanned', planned_minutes: 15 }, neha);
    assert.strictEqual(free.body.session.plan_item_id, null);
    ok('typing a task freely still works and carries no plan id');

    const notMine = await post('/api/admin/plans', { user_id: nehaId, title: 'Hers' }, admin);
    const steal = await post('/api/sessions/start',
      { task: 'x', planned_minutes: 15, plan_item_id: notMine.body.item.id },
      (await post('/api/login', { slug: 'acme', name: 'Ravi', pin: '481902' })).body.token);
    assert.strictEqual(steal.status, 404);
    ok('you cannot start a timer against somebody else\'s plan item');

    // ---------- planned vs actual ----------
    db.prepare("UPDATE sessions SET status='completed', actual_seconds=1500, ended_at=? WHERE plan_item_id=?")
      .run(nowISO(), q);
    plan = (await call('/api/my/plan', {}, neha)).body;
    const done = plan.items.find((i) => i.id === q);
    assert.strictEqual(done.actual_seconds, 1500);
    assert.strictEqual(done.session_count, 1);
    ok('time logged against a task is totalled onto it');

    // ---------- marking done and skipping ----------
    await patch('/api/my/plan/' + q, { status: 'done' }, neha);
    plan = (await call('/api/my/plan', {}, neha)).body;
    assert.strictEqual(plan.items.find((i) => i.id === q).status, 'done');
    assert.ok(plan.items.find((i) => i.id === q).done_at);
    assert.strictEqual(plan.totals.done, 1);
    ok('marking a task done records when');

    assert.strictEqual((await patch('/api/my/plan/' + q, { status: 'banana' }, neha)).status, 400);
    ok('an unknown status is refused');

    // ---------- work carried forward ----------
    const oldId = (await post('/api/my/plan', { title: 'Weekly report', estimate_min: 45 }, neha)).body.item.id;
    db.prepare("UPDATE plan_items SET plan_date=? WHERE id=?").run(daysAgo(1), oldId);
    plan = (await call('/api/my/plan', {}, neha)).body;
    const moved = plan.items.find((i) => i.id === oldId);
    assert.ok(moved, 'yesterday\'s unfinished task should appear on today');
    assert.strictEqual(moved.moved_count, 1);
    assert.strictEqual(moved.moved_from, daysAgo(1));
    ok('an unfinished task from yesterday moves to today and says so');

    db.prepare("UPDATE plan_items SET plan_date=? WHERE id=?").run(daysAgo(1), oldId);
    plan = (await call('/api/my/plan', {}, neha)).body;
    assert.strictEqual(plan.items.find((i) => i.id === oldId).moved_count, 2);
    assert.strictEqual(plan.items.find((i) => i.id === oldId).moved_from, daysAgo(1));
    ok('moving again increments the count and keeps the original date');

    const doneOld = (await post('/api/my/plan', { title: 'Already finished' }, neha)).body.item.id;
    await patch('/api/my/plan/' + doneOld, { status: 'done' }, neha);
    db.prepare('UPDATE plan_items SET plan_date=? WHERE id=?').run(daysAgo(1), doneOld);
    plan = (await call('/api/my/plan', {}, neha)).body;
    assert.ok(!plan.items.some((i) => i.id === doneOld), 'finished work should not follow you around');
    ok('a task already done does not get carried forward');

    const ancient = (await post('/api/my/plan', { title: 'From last month' }, neha)).body.item.id;
    db.prepare('UPDATE plan_items SET plan_date=? WHERE id=?').run(daysAgo(30), ancient);
    plan = (await call('/api/my/plan', {}, neha)).body;
    assert.ok(!plan.items.some((i) => i.id === ancient));
    assert.strictEqual(db.prepare('SELECT status FROM plan_items WHERE id=?').get(ancient).status, 'skipped');
    ok('a month-old task is retired instead of piling onto today');

    // ---------- an admin assigning work ----------
    const asg = await post('/api/admin/plans',
      { user_id: nehaId, title: 'Prepare board deck', estimate_min: 90 }, admin);
    assert.strictEqual(asg.status, 200);
    assert.strictEqual(asg.body.item.assigned_by, 'Ravi');
    plan = (await call('/api/my/plan', {}, neha)).body;
    assert.ok(plan.items.some((i) => i.id === asg.body.item.id));
    ok('an admin can put work on a team member\'s plan, tagged with their name');

    assert.strictEqual((await post('/api/admin/plans', { user_id: 999999, title: 'x' }, admin)).status, 404);
    ok('assigning to somebody who does not exist is refused');

    const past = await post('/api/admin/plans',
      { user_id: nehaId, title: 'Yesterday work', date: daysAgo(3) }, admin);
    assert.strictEqual(past.status, 400);
    ok('you cannot assign work into a day that has already gone');

    // ---------- the line between assigned and personal ----------
    const cantDelete = await del('/api/my/plan/' + asg.body.item.id, neha);
    assert.strictEqual(cantDelete.status, 403);
    assert.match(cantDelete.body.error, /Ravi/);
    ok('assigned work cannot be quietly deleted, and the message says who assigned it');

    const skipped = await patch('/api/my/plan/' + asg.body.item.id,
      { status: 'skipped', skip_reason: 'Waiting on figures from finance' }, neha);
    assert.strictEqual(skipped.status, 200);
    assert.strictEqual(skipped.body.item.status, 'skipped');
    assert.match(skipped.body.item.skip_reason, /finance/);
    ok('assigned work can be skipped, but only with a reason attached');

    const retitle = await patch('/api/my/plan/' + asg.body.item.id, { title: 'Something else' }, neha);
    assert.strictEqual(retitle.body.item.title, 'Prepare board deck');
    ok('an assigned task cannot be quietly retitled');

    const own = (await post('/api/my/plan', { title: 'My own task' }, neha)).body.item.id;
    assert.strictEqual((await patch('/api/my/plan/' + own, { title: 'Renamed' }, neha)).body.item.title, 'Renamed');
    assert.strictEqual((await del('/api/my/plan/' + own, neha)).status, 200);
    ok('your own tasks you can rename and delete freely');

    const asg2 = await post('/api/admin/plans', { user_id: nehaId, title: 'Withdraw me' }, admin);
    assert.strictEqual((await del('/api/admin/plans/' + asg2.body.item.id, admin)).status, 200);
    ok('an admin can withdraw work they assigned');

    const hers = (await post('/api/my/plan', { title: 'Personal errand' }, neha)).body.item.id;
    const grab = await del('/api/admin/plans/' + hers, admin);
    assert.strictEqual(grab.status, 403);
    ok('an admin cannot delete a task the person added themselves');

    // ---------- over-assigning ----------
    for (let i = 0; i < 6; i++) {
      await post('/api/admin/plans', { user_id: nehaId, title: 'Task ' + i, estimate_min: 60 }, admin);
    }
    const plans = (await call('/api/admin/plans', {}, admin)).body;
    const her = plans.people.find((x) => x.name === 'Neha');
    assert.ok(her.overloaded, 'a day stacked past the realistic limit should be flagged');
    assert.ok(her.totals.plannedMinutes > plans.realisticDayMinutes);
    assert.ok(her.assignedMinutes >= 360);
    ok('stacking more than a day\'s work onto someone is flagged to the admin');

    // ---------- dashboard maths ----------
    const stats = (await call('/api/admin/stats', {}, admin)).body;
    const row = stats.employees.find((e) => e.name === 'Neha');
    assert.ok(row.plannedMinutes > 0, 'planned time should reach the dashboard');
    assert.ok(row.plannedDone >= 1);
    ok('planned time and completions reach the dashboard');

    const stuck = row.stuckTasks.find((t) => t.title === 'Weekly report');
    assert.ok(stuck && stuck.movedCount >= 2);
    ok('a task that keeps sliding is named on the dashboard');

    // Someone who plans but never starts a timer must still be visible.
    await post('/api/admin/users', { name: 'Ghost', pin: '318266' }, admin);
    const ghostId = db.prepare("SELECT id FROM users WHERE name='Ghost'").get().id;
    await post('/api/admin/plans', { user_id: ghostId, title: 'Never started', estimate_min: 120 }, admin);
    const s2 = (await call('/api/admin/stats', {}, admin)).body;
    const g = s2.employees.find((e) => e.name === 'Ghost');
    assert.ok(g, 'someone who planned but logged nothing must not vanish');
    assert.strictEqual(g.sessions, 0);
    assert.strictEqual(g.plannedMinutes, 120);
    assert.strictEqual(g.focusScore, null);
    ok('someone who planned work but never started still shows, with no score');

    // ---------- tenant isolation ----------
    const inv2 = (await post('/api/master/codes', {}, master)).body.code;
    await post('/api/signup', { code: inv2, business_name: 'Globex', slug: 'globex',
                                owner_name: 'Priya', owner_pin: '620744' });
    const other = (await post('/api/login', { slug: 'globex', name: 'Priya', pin: '620744' })).body.token;

    const cross = await post('/api/admin/plans', { user_id: nehaId, title: 'Do my work' }, other);
    assert.strictEqual(cross.status, 404);
    ok('one business cannot assign work into another business');

    const peek = (await call('/api/admin/plans', {}, other)).body;
    assert.deepStrictEqual(peek.people.map((x) => x.name), ['Priya']);
    ok('the plans screen only ever shows your own people');

    const reach = await patch('/api/my/plan/' + asg.body.item.id, { status: 'done' }, other);
    assert.strictEqual(reach.status, 404);
    ok('you cannot touch a plan item belonging to someone else');

    assert.strictEqual((await call('/api/admin/plans', {}, neha)).status, 403);
    ok('a normal team member cannot open the assigning screen');

    console.log('\nPlanner checks passed.\n');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED:', err.message, '\n', err);
    server.close();
    process.exit(1);
  }
});
