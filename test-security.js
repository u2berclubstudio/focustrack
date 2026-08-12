'use strict';
/* Attacker's-eye tests. Run: MAIL_MODE=capture DATA_DIR=/tmp/ft-sec node test-security.js
 *
 * Each block is written as "here is what someone trying to break in would do,
 * and here is where it stops".
 */
process.env.MAIL_MODE = 'capture';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/ft-sec';

const assert = require('assert');
const app = require('./server');
const { db, hashPin, nowISO, pinProblem } = require('./db');
const mailer = require('./mailer');

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;

  // A fake client address per test block, so one block's lockout doesn't
  // bleed into the next. trust proxy makes X-Forwarded-For the client IP.
  let ip = '203.0.113.1';
  const call = async (p, o = {}, tok) => {
    const r = await fetch(base + p, {
      ...o,
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': ip,
        ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
      },
    });
    let body; const t = await r.text();
    try { body = JSON.parse(t); } catch { body = t; }
    return { status: r.status, body };
  };
  const post = (p, b, tok) => call(p, { method: 'POST', body: JSON.stringify(b || {}) }, tok);
  const ok = (m) => console.log('  ✓ ' + m);
  const freshIp = (() => { let n = 10; return () => (ip = `198.51.100.${n++}`); })();

  try {
    for (const t of ['distractions', 'sessions', 'tokens', 'users', 'invite_codes',
                     'businesses', 'audit_log', 'login_guard', 'otp_challenges']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }

    // ---------- PIN policy ----------
    assert.strictEqual(pinProblem('1234'), 'Your PIN needs at least 6 digits');
    assert.ok(pinProblem('123456'));      // on the common list
    assert.match(pinProblem('345678'), /sequence/i);
    assert.match(pinProblem('876543'), /sequence/i);
    assert.match(pinProblem('111111'), /guessed|repeat/i);
    assert.match(pinProblem('000000'), /guessed|repeat/i);
    assert.match(pinProblem('abcdef'), /numbers only/i);
    assert.strictEqual(pinProblem('481902'), null);
    ok('weak PINs are refused: too short, sequences, repeats, top-of-list');

    // ---------- setup ----------
    db.prepare(`INSERT INTO users (business_id, name, pin_hash, role, team, email, created_at)
                VALUES (NULL,?,?,'master','platform',?,?)`)
      .run('Atul', hashPin('481902'), 'boss@example.com', nowISO());

    const first = await post('/api/master/login', { name: 'Atul', pin: '481902' });
    assert.strictEqual(first.body.otpRequired, true);
    const code1 = mailer.sent.at(-1).text.match(/\b(\d{6})\b/)[1];
    const master = (await post('/api/master/otp', { challenge: first.body.challenge, code: code1 })).body.token;
    assert.ok(master);
    ok('master sign-in needs the PIN and then the emailed code');

    const invite = (await post('/api/master/codes', { seat_limit: 10 }, master)).body.code;
    await post('/api/signup', {
      code: invite, business_name: 'Acme', slug: 'acme',
      owner_name: 'Ravi', owner_pin: '481902',
    });
    await post('/api/admin/users', { name: 'Neha', pin: '774411' },
      (await post('/api/login', { slug: 'acme', name: 'Ravi', pin: '481902' })).body.token);

    // ---------- signup rejects weak PINs ----------
    const inv2 = (await post('/api/master/codes', {}, master)).body.code;
    const weak = await post('/api/signup', {
      code: inv2, business_name: 'Weak', slug: 'weakco', owner_name: 'X', owner_pin: '1234' });
    assert.strictEqual(weak.status, 400);
    assert.match(weak.body.error, /6 digits/);
    assert.ok(!db.prepare('SELECT 1 FROM businesses WHERE slug=?').get('weakco'));
    ok('a business cannot be created with a 4-digit PIN');

    // ---------- brute forcing one person's PIN ----------
    freshIp();
    const attempts = [];
    for (let i = 0; i < 7; i++) {
      attempts.push((await post('/api/login', { slug: 'acme', name: 'Neha', pin: String(100000 + i) })).status);
    }
    assert.deepStrictEqual(attempts.slice(0, 4), [401, 401, 401, 401]);
    assert.strictEqual(attempts[4], 429, 'the 5th wrong PIN should lock the account');
    assert.ok(attempts.slice(5).every((s) => s === 429));
    ok('five wrong PINs lock that account for 15 minutes');

    const rightNow = await post('/api/login', { slug: 'acme', name: 'Neha', pin: '774411' });
    assert.strictEqual(rightNow.status, 429);
    ok('even the correct PIN is refused while the lock is on');

    // Locking one person must not lock their colleagues out.
    freshIp();
    assert.strictEqual((await post('/api/login', { slug: 'acme', name: 'Ravi', pin: '481902' })).status, 200);
    ok('locking one account leaves the rest of the team working');

    // ---------- the lock actually expires ----------
    db.prepare("UPDATE login_guard SET locked_until = ? WHERE key LIKE '%neha%'")
      .run(new Date(Date.now() - 1000).toISOString());
    freshIp();
    assert.strictEqual((await post('/api/login', { slug: 'acme', name: 'Neha', pin: '774411' })).status, 200);
    ok('once the lock expires the real PIN works again');

    // ---------- spraying guesses across many accounts from one machine ----------
    freshIp();
    let blocked = 0;
    for (let i = 0; i < 24; i++) {
      const r = await post('/api/login', { slug: 'acme', name: 'ghost' + i, pin: '999999' });
      if (r.status === 429) blocked++;
    }
    assert.ok(blocked > 0, 'the IP should be throttled after enough failures');
    const stillBlocked = await post('/api/login', { slug: 'acme', name: 'Ravi', pin: '481902' });
    assert.strictEqual(stillBlocked.status, 429);
    ok('spraying guesses across many names throttles the whole machine');

    // ---------- error messages give nothing away ----------
    freshIp();
    const noSuchUser = await post('/api/login', { slug: 'acme', name: 'NobodyHere', pin: '111222' });
    freshIp();
    const wrongPin = await post('/api/login', { slug: 'acme', name: 'Ravi', pin: '111222' });
    assert.strictEqual(noSuchUser.body.error, wrongPin.body.error);
    assert.ok(!/pin|name|exist/i.test(noSuchUser.body.error.replace('Wrong details.', '')));
    ok('an unknown name and a wrong PIN give the identical message');

    // ---------- mapping which workspaces exist ----------
    freshIp();
    const probe = await post('/api/slug-check', { slug: 'acme' });
    assert.strictEqual(probe.status, 403);
    const probe2 = await post('/api/slug-check', { code: 'AAAA-BBBB', slug: 'acme' });
    assert.strictEqual(probe2.status, 403);
    ok('you cannot ask whether a team link exists without a live invite code');

    freshIp();
    const legit = await post('/api/slug-check', { code: inv2, slug: 'acme' });
    assert.strictEqual(legit.status, 200);
    assert.strictEqual(legit.body.available, false);
    ok('a real invite code still gets the availability check during signup');

    // ---------- failures are recorded ----------
    const log = (await call('/api/master/audit', {}, master)).body.entries;
    assert.ok(log.some((a) => a.action === 'login_failed'));
    assert.ok(log.some((a) => a.actor.includes('Neha') || /neha/i.test(a.actor)));
    ok('failed sign-ins land in the activity log with the address they came from');

    // ---------- master OTP ----------
    freshIp();
    const start = await post('/api/master/login', { name: 'Atul', pin: '481902' });
    assert.strictEqual(start.body.otpRequired, true);
    assert.ok(!start.body.token, 'the PIN alone must never return a token');
    assert.match(start.body.sentTo, /^bo•+@example\.com$/);
    ok('the PIN alone gets you nothing, and the email is masked in the response');

    const chal = start.body.challenge;
    const realCode = mailer.sent.at(-1).text.match(/\b(\d{6})\b/)[1];

    const wrongCode = await post('/api/master/otp', { challenge: chal, code: '000001' });
    assert.strictEqual(wrongCode.status, 401);
    assert.match(wrongCode.body.error, /attempts? left/);
    ok('a wrong code is refused and counts down the attempts');

    const good = await post('/api/master/otp', { challenge: chal, code: realCode });
    assert.strictEqual(good.status, 200);
    assert.ok(good.body.token);
    ok('the emailed code completes the sign-in');

    const replay = await post('/api/master/otp', { challenge: chal, code: realCode });
    assert.strictEqual(replay.status, 401);
    ok('the same code cannot be used twice');

    // expiry
    freshIp();
    const s2 = await post('/api/master/login', { name: 'Atul', pin: '481902' });
    const c2 = mailer.sent.at(-1).text.match(/\b(\d{6})\b/)[1];
    db.prepare('UPDATE otp_challenges SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), s2.body.challenge);
    const expired = await post('/api/master/otp', { challenge: s2.body.challenge, code: c2 });
    assert.strictEqual(expired.status, 401);
    assert.match(expired.body.error, /expired/i);
    ok('a code that sat too long stops working');

    // guessing codes
    freshIp();
    const s3 = await post('/api/master/login', { name: 'Atul', pin: '481902' });
    let last;
    for (let i = 0; i < 6; i++) {
      last = await post('/api/master/otp', { challenge: s3.body.challenge, code: '00000' + i });
    }
    assert.strictEqual(last.status, 429);
    const realC3 = mailer.sent.at(-1).text.match(/\b(\d{6})\b/)[1];
    assert.strictEqual((await post('/api/master/otp', { challenge: s3.body.challenge, code: realC3 })).status, 429);
    ok('guessing the code five times burns the challenge, even for the right code');

    // wrong master PIN never sends mail
    const before = mailer.sent.length;
    freshIp();
    await post('/api/master/login', { name: 'Atul', pin: '999888' });
    assert.strictEqual(mailer.sent.length, before, 'no email should go out on a bad PIN');
    ok('a wrong master PIN does not send an email, so it cannot be used to spam you');

    // ---------- sign everyone out ----------
    freshIp();
    const owner = (await post('/api/login', { slug: 'acme', name: 'Ravi', pin: '481902' })).body.token;
    const neha = (await post('/api/login', { slug: 'acme', name: 'Neha', pin: '774411' })).body.token;
    assert.strictEqual((await call('/api/me', {}, neha)).status, 200);
    const out = await post('/api/admin/logout-all', {}, owner);
    assert.strictEqual(out.status, 200);
    assert.strictEqual((await call('/api/me', {}, neha)).status, 401);
    assert.strictEqual((await call('/api/me', {}, owner)).status, 200);
    ok('"sign everyone out" ends every other device but keeps the admin signed in');

    console.log('\nSecurity checks passed.\n');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('\nFAILED:', err.message, '\n', err);
    server.close();
    process.exit(1);
  }
});
