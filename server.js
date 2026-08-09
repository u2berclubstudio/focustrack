'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, hashPin, verifyPin, nowISO } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN_DAYS = 30;

// Slugs that would collide with a real route or file.
const RESERVED_SLUGS = new Set([
  'api', 'master', 'admin', 'health', 'public', 'app', 'static', 'assets',
  'www', 'signup', 'login', 'logout', 'favicon.ico', 'robots.txt', 'index',
  'dashboard', 'support', 'help', 'about', 'pricing', 'terms', 'privacy',
]);

const app = express();
app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------- utilities

const shift = (iso, tz) => new Date(new Date(iso).getTime() + tz * 60000);
const localDate = (iso, tz) => shift(iso, tz).toISOString().slice(0, 10);
const localHour = (iso, tz) => shift(iso, tz).getUTCHours();
const localTime = (iso, tz) => shift(iso, tz).toISOString().slice(11, 19);
const todayLocal = (tz) => localDate(nowISO(), tz);

function daysAgoLocal(n, tz) {
  return new Date(Date.now() + tz * 60000 - n * 86400000).toISOString().slice(0, 10);
}

const CATEGORY_RULES = [
  ['phone',    /phone|mobile|whatsapp|insta|instagram|facebook|reel|youtube|tiktok|twitter|social/i],
  ['people',   /colleague|boss|manager|team|someone|call|meeting|visitor|client|interrupt|talk/i],
  ['email',    /email|mail|inbox|slack|teams|message|chat|notification/i],
  ['personal', /family|home|kid|child|wife|husband|personal|bank|doctor/i],
  ['break',    /tea|coffee|chai|snack|lunch|water|washroom|toilet|smoke|break|bathroom/i],
  ['fatigue',  /tired|sleepy|bored|headache|unwell|sick|no energy|distracted mind|overthink/i],
  ['blocked',  /waiting|blocked|no data|need info|internet|slow|system|laptop|software|login|access/i],
];
const categorize = (reason) => {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(reason)) return cat;
  return 'other';
};

const slugify = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

const validSlug = (s) => /^[a-z0-9][a-z0-9-]{1,31}$/.test(s) && !RESERVED_SLUGS.has(s);

function audit(actor, action, detail) {
  db.prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?,?,?,?)')
    .run(nowISO(), actor, action, String(detail || '').slice(0, 500));
}

function issueToken(userId, impersonatedBy) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(
    'INSERT INTO tokens (token, user_id, impersonated_by, created_at, expires_at) VALUES (?,?,?,?,?)'
  ).run(
    token, userId, impersonatedBy || null, nowISO(),
    new Date(Date.now() + (impersonatedBy ? 1 : TOKEN_DAYS) * 86400000).toISOString()
  );
  return token;
}

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const row = db
    .prepare(
      `SELECT t.expires_at, t.impersonated_by, u.id, u.name, u.role, u.team, u.active, u.business_id
         FROM tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token = ?`
    )
    .get(token);

  if (!row || !row.active) return res.status(401).json({ error: 'Session expired' });
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
    return res.status(401).json({ error: 'Session expired' });
  }

  req.token = token;
  req.user = {
    id: row.id, name: row.name, role: row.role, team: row.team,
    business_id: row.business_id, impersonated_by: row.impersonated_by,
  };

  if (row.role === 'master') {
    req.business = null;
    return next();
  }

  const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(row.business_id);
  if (!biz) return res.status(401).json({ error: 'Account not found' });
  if (biz.status === 'pending') {
    return res.status(403).json({ error: 'Your account is waiting for approval.' });
  }
  if (biz.status === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended. Please contact support.' });
  }
  req.business = biz;
  next();
}

const masterOnly = (req, res, next) =>
  req.user.role === 'master' ? next() : res.status(403).json({ error: 'Master admin only' });

const businessAdmin = (req, res, next) =>
  ['owner', 'admin'].includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'Admins only' });

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const touchBusiness = (id) => {
  try {
    db.prepare('UPDATE businesses SET last_active_at = ? WHERE id = ?').run(nowISO(), id);
  } catch { /* non-critical */ }
};

// ------------------------------------------------------------------ signup

app.get('/api/slug-available/:slug', wrap((req, res) => {
  const slug = slugify(req.params.slug);
  if (!validSlug(slug)) {
    return res.json({ slug, available: false, reason: 'Use 2-32 letters, numbers or dashes.' });
  }
  const taken = !!db.prepare('SELECT 1 FROM businesses WHERE slug = ?').get(slug);
  res.json({ slug, available: !taken, reason: taken ? 'Already taken.' : '' });
}));

app.post('/api/signup', wrap((req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const bizName = String(req.body.business_name || '').trim();
  const slug = slugify(req.body.slug || bizName);
  const ownerName = String(req.body.owner_name || '').trim();
  const pin = String(req.body.owner_pin || '').trim();
  const email = String(req.body.contact_email || '').trim();

  if (!code) return res.status(400).json({ error: 'Invite code required' });
  if (!bizName) return res.status(400).json({ error: 'Business name required' });
  if (!validSlug(slug)) return res.status(400).json({ error: 'Pick a different team link' });
  if (!ownerName) return res.status(400).json({ error: 'Your name is required' });
  if (pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' });

  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
  if (!invite) return res.status(400).json({ error: 'That invite code is not valid' });
  if (invite.used_by) return res.status(400).json({ error: 'That invite code has already been used' });
  if (db.prepare('SELECT 1 FROM businesses WHERE slug = ?').get(slug)) {
    return res.status(409).json({ error: 'That team link is taken — try another' });
  }

  const status = invite.auto_approve ? 'active' : 'pending';
  const info = db
    .prepare(`INSERT INTO businesses (name, slug, contact_email, status, seat_limit, tz_offset, created_at, approved_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(bizName, slug, email, status, invite.seat_limit, 330, nowISO(),
         status === 'active' ? nowISO() : null);
  const bizId = info.lastInsertRowid;

  db.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ?')
    .run(bizId, nowISO(), code);

  db.prepare(`INSERT INTO users (business_id, name, pin_hash, role, team, created_at)
              VALUES (?,?,?,'owner','management',?)`)
    .run(bizId, ownerName, hashPin(pin), nowISO());

  audit(`signup:${slug}`, 'business_created', `${bizName} via code ${code} (${status})`);

  res.json({
    ok: true, status, slug,
    loginUrl: `/${slug}`, adminUrl: `/${slug}/admin`,
    message: status === 'active'
      ? 'Your workspace is ready.'
      : 'Thanks — your account is waiting for approval. We will be in touch.',
  });
}));

// ------------------------------------------------------------------- auth

app.post('/api/login', wrap((req, res) => {
  const slug = slugify(req.body.slug || '');
  const name = String(req.body.name || '').trim();
  const pin = String(req.body.pin || '').trim();
  if (!slug || !name || !pin) return res.status(400).json({ error: 'All fields are required' });

  const biz = db.prepare('SELECT * FROM businesses WHERE slug = ?').get(slug);
  if (!biz) return res.status(404).json({ error: 'No such team link' });
  if (biz.status === 'pending') {
    return res.status(403).json({ error: 'This account is waiting for approval.' });
  }
  if (biz.status === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended. Please contact support.' });
  }

  const user = db
    .prepare('SELECT * FROM users WHERE business_id = ? AND lower(name) = lower(?) AND active = 1')
    .get(biz.id, name);
  if (!user || !verifyPin(pin, user.pin_hash)) {
    return res.status(401).json({ error: 'Wrong name or PIN' });
  }

  touchBusiness(biz.id);
  res.json({
    token: issueToken(user.id),
    user: { id: user.id, name: user.name, role: user.role, team: user.team },
    business: { name: biz.name, slug: biz.slug },
  });
}));

app.post('/api/master/login', wrap((req, res) => {
  const name = String(req.body.name || '').trim();
  const pin = String(req.body.pin || '').trim();
  const user = db
    .prepare("SELECT * FROM users WHERE business_id IS NULL AND role='master' AND lower(name)=lower(?) AND active=1")
    .get(name);
  if (!user || !verifyPin(pin, user.pin_hash)) {
    return res.status(401).json({ error: 'Wrong name or PIN' });
  }
  audit(user.name, 'master_login', '');
  res.json({ token: issueToken(user.id), user: { id: user.id, name: user.name, role: 'master' } });
}));

app.post('/api/logout', auth, wrap((req, res) => {
  db.prepare('DELETE FROM tokens WHERE token = ?').run(req.token);
  res.json({ ok: true });
}));

app.get('/api/me', auth, wrap((req, res) => {
  res.json({
    user: req.user,
    business: req.business
      ? { name: req.business.name, slug: req.business.slug, seat_limit: req.business.seat_limit }
      : null,
  });
}));

app.get('/api/business/:slug', wrap((req, res) => {
  const biz = db.prepare('SELECT name, slug, status FROM businesses WHERE slug = ?')
    .get(slugify(req.params.slug));
  if (!biz) return res.status(404).json({ error: 'Not found' });
  res.json({ business: { name: biz.name, slug: biz.slug, status: biz.status } });
}));

// --------------------------------------------------------------- sessions

app.get('/api/sessions/active', auth, wrap((req, res) => {
  const s = db
    .prepare("SELECT * FROM sessions WHERE user_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(req.user.id);
  if (!s) return res.json({ session: null });
  const distractions = db
    .prepare('SELECT reason, occurred_at, elapsed_seconds FROM distractions WHERE session_id = ? ORDER BY id')
    .all(s.id);
  res.json({ session: s, distractions, serverTime: nowISO() });
}));

app.post('/api/sessions/start', auth, wrap((req, res) => {
  const task = String(req.body.task || '').trim();
  const minutes = Number(req.body.planned_minutes || 30);
  if (!task) return res.status(400).json({ error: 'Tell us what you are working on' });
  if (!(minutes >= 5 && minutes <= 240)) {
    return res.status(400).json({ error: 'Duration must be 5-240 minutes' });
  }

  const stale = db
    .prepare("SELECT * FROM sessions WHERE user_id = ? AND status = 'running'")
    .all(req.user.id);
  for (const s of stale) {
    const elapsed = Math.round((Date.now() - new Date(s.started_at).getTime()) / 1000);
    db.prepare("UPDATE sessions SET status='abandoned', ended_at=?, actual_seconds=?, note='auto-closed' WHERE id=?")
      .run(nowISO(), Math.min(elapsed, s.planned_minutes * 60), s.id);
  }

  const info = db
    .prepare(`INSERT INTO sessions (business_id, user_id, task, planned_minutes, started_at, status)
              VALUES (?,?,?,?,?,'running')`)
    .run(req.user.business_id, req.user.id, task, minutes, nowISO());

  touchBusiness(req.user.business_id);
  res.json({
    session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid),
    serverTime: nowISO(),
  });
}));

app.post('/api/sessions/:id/distraction', auth, wrap((req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'What distracted you?' });

  const s = db
    .prepare("SELECT * FROM sessions WHERE id = ? AND user_id = ? AND status = 'running'")
    .get(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ error: 'No running session' });

  const elapsed = Math.round((Date.now() - new Date(s.started_at).getTime()) / 1000);
  db.prepare(`INSERT INTO distractions (business_id, session_id, user_id, reason, category, occurred_at, elapsed_seconds)
              VALUES (?,?,?,?,?,?,?)`)
    .run(req.user.business_id, s.id, req.user.id, reason.slice(0, 300), categorize(reason), nowISO(), elapsed);

  res.json({
    ok: true,
    count: db.prepare('SELECT COUNT(*) c FROM distractions WHERE session_id = ?').get(s.id).c,
  });
}));

function endSession(req, res, status) {
  const s = db
    .prepare("SELECT * FROM sessions WHERE id = ? AND user_id = ? AND status = 'running'")
    .get(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ error: 'No running session' });

  const elapsed = Math.round((Date.now() - new Date(s.started_at).getTime()) / 1000);
  db.prepare('UPDATE sessions SET status=?, ended_at=?, actual_seconds=?, note=? WHERE id=?')
    .run(status, nowISO(), Math.min(elapsed, s.planned_minutes * 60),
         String(req.body.note || '').slice(0, 300), s.id);
  res.json({ ok: true, session: db.prepare('SELECT * FROM sessions WHERE id=?').get(s.id) });
}
app.post('/api/sessions/:id/complete', auth, wrap((req, res) => endSession(req, res, 'completed')));
app.post('/api/sessions/:id/stop',     auth, wrap((req, res) => endSession(req, res, 'abandoned')));

app.get('/api/my/today', auth, wrap((req, res) => {
  const tz = req.business.tz_offset;
  const rows = db
    .prepare(`SELECT s.*, (SELECT COUNT(*) FROM distractions d WHERE d.session_id = s.id) AS distractions
                FROM sessions s WHERE s.user_id = ? AND s.status != 'running'
               ORDER BY s.id DESC LIMIT 50`)
    .all(req.user.id);
  const today = rows.filter((r) => localDate(r.started_at, tz) === todayLocal(tz));
  res.json({
    today: {
      sessions: today.length,
      completed: today.filter((r) => r.status === 'completed').length,
      focusedMinutes: Math.round(today.reduce((a, r) => a + (r.actual_seconds || 0), 0) / 60),
      distractions: today.reduce((a, r) => a + r.distractions, 0),
    },
    recent: rows.slice(0, 12),
  });
}));

// -------------------------------------------------------- business admin

function scoreFor(sessions, distractionCount) {
  const total = sessions.length;
  if (!total) return { focusScore: null, completionRate: 0, distractionsPerHour: 0 };
  const completed = sessions.filter((s) => s.status === 'completed').length;
  const hours = sessions.reduce((a, s) => a + (s.actual_seconds || 0), 0) / 3600;
  const completionRate = completed / total;
  const dph = hours > 0 ? distractionCount / hours : 0;
  return {
    focusScore: Math.max(0, Math.round(0.6 * completionRate * 100 + 0.4 * Math.max(0, 100 - 12.5 * dph))),
    completionRate: Math.round(completionRate * 100),
    distractionsPerHour: Math.round(dph * 10) / 10,
  };
}

const rangeFromQuery = (q, tz) => ({
  from: q.from || daysAgoLocal(6, tz),
  to: q.to || todayLocal(tz),
});

function fetchSessions(bizId, tz, from, to, userId) {
  return db
    .prepare(`SELECT s.*, u.name AS user_name, u.team,
                     (SELECT COUNT(*) FROM distractions d WHERE d.session_id = s.id) AS distractions
                FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.status != 'running' AND s.business_id = ?
               ORDER BY s.started_at DESC`)
    .all(bizId)
    .filter((r) => {
      const d = localDate(r.started_at, tz);
      if (d < from || d > to) return false;
      if (userId && r.user_id !== Number(userId)) return false;
      return true;
    });
}

app.get('/api/admin/stats', auth, businessAdmin, wrap((req, res) => {
  const bizId = req.business.id;
  const tz = req.business.tz_offset;
  const { from, to } = rangeFromQuery(req.query, tz);
  const sessions = fetchSessions(bizId, tz, from, to, req.query.user_id);
  const ids = new Set(sessions.map((s) => s.id));

  const allDistractions = db
    .prepare(`SELECT d.*, u.name AS user_name FROM distractions d
                JOIN users u ON u.id = d.user_id
               WHERE d.business_id = ? ORDER BY d.id DESC`)
    .all(bizId)
    .filter((d) => ids.has(d.session_id));

  const totalDistractions = allDistractions.length;
  const overall = scoreFor(sessions, totalDistractions);

  const byUser = {};
  for (const s of sessions) {
    byUser[s.user_id] ||= { user_id: s.user_id, name: s.user_name, team: s.team, sessions: [], distractions: 0 };
    byUser[s.user_id].sessions.push(s);
    byUser[s.user_id].distractions += s.distractions;
  }
  const employees = Object.values(byUser)
    .map((u) => ({
      user_id: u.user_id, name: u.name, team: u.team,
      sessions: u.sessions.length,
      completed: u.sessions.filter((s) => s.status === 'completed').length,
      focusedMinutes: Math.round(u.sessions.reduce((a, s) => a + (s.actual_seconds || 0), 0) / 60),
      distractions: u.distractions,
      ...scoreFor(u.sessions, u.distractions),
    }))
    .sort((a, b) => b.focusScore - a.focusScore);

  const reasonCounts = {}, categoryCounts = {};
  for (const d of allDistractions) {
    const key = d.reason.trim().toLowerCase();
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    categoryCounts[d.category] = (categoryCounts[d.category] || 0) + 1;
  }
  const topReasons = Object.entries(reasonCounts).map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count).slice(0, 10);
  const categories = Object.entries(categoryCounts).map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  const hours = Array.from({ length: 24 }, (_, h) => ({
    hour: h, sessions: 0, completed: 0, distractions: 0, focusedMinutes: 0,
  }));
  const dayMap = {};
  for (const s of sessions) {
    const h = hours[localHour(s.started_at, tz)];
    h.sessions++; if (s.status === 'completed') h.completed++;
    h.distractions += s.distractions;
    h.focusedMinutes += Math.round((s.actual_seconds || 0) / 60);

    const d = localDate(s.started_at, tz);
    dayMap[d] ||= { date: d, sessions: 0, completed: 0, distractions: 0, focusedMinutes: 0 };
    dayMap[d].sessions++; if (s.status === 'completed') dayMap[d].completed++;
    dayMap[d].distractions += s.distractions;
    dayMap[d].focusedMinutes += Math.round((s.actual_seconds || 0) / 60);
  }

  const seatsUsed = db
    .prepare("SELECT COUNT(*) c FROM users WHERE business_id = ? AND active = 1 AND role != 'master'")
    .get(bizId).c;

  res.json({
    range: { from, to },
    business: { name: req.business.name, slug: req.business.slug,
                seatsUsed, seatLimit: req.business.seat_limit },
    totals: {
      sessions: sessions.length,
      completed: sessions.filter((s) => s.status === 'completed').length,
      focusedHours: Math.round(sessions.reduce((a, s) => a + (s.actual_seconds || 0), 0) / 360) / 10,
      distractions: totalDistractions,
      activeEmployees: employees.length,
      ...overall,
    },
    employees, topReasons, categories,
    hours: hours.filter((h) => h.sessions > 0),
    daily: Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date)),
    recentDistractions: allDistractions.slice(0, 25).map((d) => ({
      user: d.user_name, reason: d.reason, at: d.occurred_at, category: d.category,
    })),
  });
}));

app.get('/api/admin/sessions', auth, businessAdmin, wrap((req, res) => {
  const tz = req.business.tz_offset;
  const { from, to } = rangeFromQuery(req.query, tz);
  res.json({ sessions: fetchSessions(req.business.id, tz, from, to, req.query.user_id).slice(0, 500) });
}));

app.get('/api/admin/export.csv', auth, businessAdmin, wrap((req, res) => {
  const tz = req.business.tz_offset;
  const { from, to } = rangeFromQuery(req.query, tz);
  const sessions = fetchSessions(req.business.id, tz, from, to, req.query.user_id);
  const bySession = {};
  for (const d of db.prepare('SELECT * FROM distractions WHERE business_id = ?').all(req.business.id)) {
    (bySession[d.session_id] ||= []).push(d.reason);
  }

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [[
    'session_id', 'team_member', 'team', 'date', 'start_time', 'end_time', 'task',
    'planned_minutes', 'actual_minutes', 'status', 'distraction_count', 'distraction_reasons',
  ].join(',')];
  for (const s of sessions) {
    lines.push([
      s.id, s.user_name, s.team, localDate(s.started_at, tz), localTime(s.started_at, tz),
      s.ended_at ? localTime(s.ended_at, tz) : '', s.task, s.planned_minutes,
      Math.round((s.actual_seconds || 0) / 60), s.status, s.distractions,
      (bySession[s.id] || []).join(' | '),
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="${req.business.slug}_${from}_to_${to}.csv"`);
  res.send('﻿' + lines.join('\n'));
}));

app.get('/api/admin/users', auth, businessAdmin, wrap((req, res) => {
  const users = db
    .prepare('SELECT id, name, role, team, active, created_at FROM users WHERE business_id = ? ORDER BY active DESC, name')
    .all(req.business.id);
  res.json({
    users,
    seatsUsed: users.filter((u) => u.active).length,
    seatLimit: req.business.seat_limit,
  });
}));

app.post('/api/admin/users', auth, businessAdmin, wrap((req, res) => {
  const name = String(req.body.name || '').trim();
  const pin = String(req.body.pin || '').trim();
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  const team = String(req.body.team || '').trim();
  if (!name || pin.length < 4) {
    return res.status(400).json({ error: 'Name required and PIN must be 4+ digits' });
  }

  const seatsUsed = db
    .prepare('SELECT COUNT(*) c FROM users WHERE business_id = ? AND active = 1')
    .get(req.business.id).c;
  if (seatsUsed >= req.business.seat_limit) {
    return res.status(403).json({
      error: `You have used all ${req.business.seat_limit} seats. Disable someone or ask for more.`,
    });
  }
  if (db.prepare('SELECT 1 FROM users WHERE business_id = ? AND lower(name)=lower(?)')
        .get(req.business.id, name)) {
    return res.status(409).json({ error: 'That name already exists in your team' });
  }

  db.prepare('INSERT INTO users (business_id, name, pin_hash, role, team, created_at) VALUES (?,?,?,?,?,?)')
    .run(req.business.id, name, hashPin(pin), role, team, nowISO());
  res.json({ ok: true });
}));

app.patch('/api/admin/users/:id', auth, businessAdmin, wrap((req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND business_id = ?')
    .get(req.params.id, req.business.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'owner' && req.body.active === false) {
    return res.status(400).json({ error: 'The owner account cannot be disabled' });
  }

  if (req.body.pin) {
    const pin = String(req.body.pin).trim();
    if (pin.length < 4) return res.status(400).json({ error: 'PIN must be 4+ digits' });
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(pin), user.id);
    db.prepare('DELETE FROM tokens WHERE user_id = ?').run(user.id);
  }
  if (req.body.active !== undefined) {
    if (req.body.active) {
      const seatsUsed = db.prepare('SELECT COUNT(*) c FROM users WHERE business_id = ? AND active = 1')
        .get(req.business.id).c;
      if (seatsUsed >= req.business.seat_limit) {
        return res.status(403).json({ error: 'No seats left — disable someone first.' });
      }
    }
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, user.id);
  }
  if (req.body.team !== undefined) {
    db.prepare('UPDATE users SET team = ? WHERE id = ?').run(String(req.body.team).trim(), user.id);
  }
  res.json({ ok: true });
}));

app.patch('/api/admin/settings', auth, businessAdmin, wrap((req, res) => {
  if (req.body.tz_offset !== undefined) {
    const tz = Number(req.body.tz_offset);
    if (!Number.isFinite(tz) || tz < -720 || tz > 840) {
      return res.status(400).json({ error: 'Invalid timezone' });
    }
    db.prepare('UPDATE businesses SET tz_offset = ? WHERE id = ?').run(tz, req.business.id);
  }
  if (req.body.name) {
    db.prepare('UPDATE businesses SET name = ? WHERE id = ?')
      .run(String(req.body.name).trim().slice(0, 80), req.business.id);
  }
  res.json({ ok: true });
}));

// ----------------------------------------------------------- master admin

app.get('/api/master/overview', auth, masterOnly, wrap((req, res) => {
  const businesses = db.prepare('SELECT * FROM businesses ORDER BY created_at DESC').all();
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const rows = businesses.map((b) => {
    const seats = db.prepare('SELECT COUNT(*) c FROM users WHERE business_id = ? AND active = 1').get(b.id).c;
    const owner = db.prepare("SELECT name FROM users WHERE business_id = ? AND role = 'owner' LIMIT 1").get(b.id);
    const s24 = db.prepare("SELECT COUNT(*) c FROM sessions WHERE business_id = ? AND started_at > ?").get(b.id, dayAgo).c;
    const s7 = db.prepare("SELECT COUNT(*) c FROM sessions WHERE business_id = ? AND started_at > ?").get(b.id, weekAgo).c;
    const active7 = db.prepare(
      'SELECT COUNT(DISTINCT user_id) c FROM sessions WHERE business_id = ? AND started_at > ?'
    ).get(b.id, weekAgo).c;
    const last = db.prepare('SELECT MAX(started_at) m FROM sessions WHERE business_id = ?').get(b.id).m;

    return {
      id: b.id, name: b.name, slug: b.slug, status: b.status,
      contact_email: b.contact_email, owner: owner ? owner.name : '—',
      seats, seatLimit: b.seat_limit, tz_offset: b.tz_offset,
      created_at: b.created_at,
      sessions24h: s24, sessions7d: s7, activeUsers7d: active7,
      lastSessionAt: last || null,
      // "live" = someone actually logged a session in the last 24h
      live: s24 > 0,
    };
  });

  res.json({
    businesses: rows,
    totals: {
      businesses: rows.length,
      active: rows.filter((r) => r.status === 'active').length,
      pending: rows.filter((r) => r.status === 'pending').length,
      suspended: rows.filter((r) => r.status === 'suspended').length,
      liveToday: rows.filter((r) => r.live).length,
      seats: rows.reduce((a, r) => a + r.seats, 0),
      sessions24h: rows.reduce((a, r) => a + r.sessions24h, 0),
    },
  });
}));

app.get('/api/master/codes', auth, masterOnly, wrap((req, res) => {
  res.json({
    codes: db.prepare(`SELECT c.*, b.name AS business_name, b.slug AS business_slug
                         FROM invite_codes c LEFT JOIN businesses b ON b.id = c.used_by
                        ORDER BY c.created_at DESC LIMIT 200`).all(),
  });
}));

app.post('/api/master/codes', auth, masterOnly, wrap((req, res) => {
  const note = String(req.body.note || '').trim().slice(0, 120);
  const seatLimit = Math.max(1, Math.min(1000, Number(req.body.seat_limit || 10)));
  const autoApprove = req.body.auto_approve === false ? 0 : 1;

  // Ambiguous characters removed so codes survive being read over the phone.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    const raw = Array.from(crypto.randomBytes(8)).map((b) => alphabet[b % alphabet.length]).join('');
    code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  } while (db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(code));

  db.prepare('INSERT INTO invite_codes (code, note, seat_limit, auto_approve, created_at) VALUES (?,?,?,?,?)')
    .run(code, note, seatLimit, autoApprove, nowISO());
  audit(req.user.name, 'code_created', `${code} · ${seatLimit} seats · ${note}`);
  res.json({ ok: true, code });
}));

app.delete('/api/master/codes/:code', auth, masterOnly, wrap((req, res) => {
  const c = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(req.params.code);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.used_by) return res.status(400).json({ error: 'Already used — cannot delete' });
  db.prepare('DELETE FROM invite_codes WHERE code = ?').run(c.code);
  audit(req.user.name, 'code_deleted', c.code);
  res.json({ ok: true });
}));

app.post('/api/master/businesses/:id/status', auth, masterOnly, wrap((req, res) => {
  const status = String(req.body.status || '');
  if (!['pending', 'active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });

  db.prepare('UPDATE businesses SET status = ?, approved_at = COALESCE(approved_at, ?) WHERE id = ?')
    .run(status, status === 'active' ? nowISO() : null, biz.id);
  if (status !== 'active') {
    // Kick out anyone currently signed in.
    db.prepare('DELETE FROM tokens WHERE user_id IN (SELECT id FROM users WHERE business_id = ?)').run(biz.id);
  }
  audit(req.user.name, 'status_changed', `${biz.slug} → ${status}`);
  res.json({ ok: true });
}));

app.patch('/api/master/businesses/:id', auth, masterOnly, wrap((req, res) => {
  const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });

  if (req.body.seat_limit !== undefined) {
    const n = Math.max(1, Math.min(1000, Number(req.body.seat_limit)));
    db.prepare('UPDATE businesses SET seat_limit = ? WHERE id = ?').run(n, biz.id);
    audit(req.user.name, 'seats_changed', `${biz.slug} → ${n}`);
  }
  if (req.body.tz_offset !== undefined) {
    db.prepare('UPDATE businesses SET tz_offset = ? WHERE id = ?')
      .run(Number(req.body.tz_offset), biz.id);
  }
  res.json({ ok: true });
}));

app.post('/api/master/businesses/:id/impersonate', auth, masterOnly, wrap((req, res) => {
  const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  if (biz.status !== 'active') {
    return res.status(400).json({ error: 'Activate the business before viewing it' });
  }
  const owner = db
    .prepare("SELECT * FROM users WHERE business_id = ? AND role = 'owner' AND active = 1 LIMIT 1")
    .get(biz.id);
  if (!owner) return res.status(404).json({ error: 'That business has no active owner' });

  // Deliberately loud: viewing a customer's data is always written down.
  audit(req.user.name, 'impersonate', `viewed ${biz.name} (${biz.slug}) as ${owner.name}`);
  res.json({
    token: issueToken(owner.id, req.user.name),
    slug: biz.slug,
    adminUrl: `/${biz.slug}/admin`,
  });
}));

app.get('/api/master/audit', auth, masterOnly, wrap((req, res) => {
  res.json({ entries: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all() });
}));

// ------------------------------------------------------------------ pages

app.use(express.static(path.join(__dirname, 'public')));

const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));

app.get('/master', page('master.html'));
app.get('/health', (req, res) => res.json({ ok: true, time: nowISO() }));

app.get('/:slug', (req, res, next) => {
  const slug = slugify(req.params.slug);
  if (!validSlug(slug)) return next();
  if (!db.prepare('SELECT 1 FROM businesses WHERE slug = ?').get(slug)) return next();
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/:slug/admin', (req, res, next) => {
  const slug = slugify(req.params.slug);
  if (!validSlug(slug)) return next();
  if (!db.prepare('SELECT 1 FROM businesses WHERE slug = ?').get(slug)) return next();
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ------------------------------------------------------------------ boot

setInterval(() => {
  try { db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(nowISO()); } catch {}
}, 6 * 3600 * 1000).unref();

if (require.main === module) {
  // Bind to loopback only: nginx is the sole way in, so the app is never
  // reachable over plain HTTP on its raw port.
  app.listen(PORT, HOST, () => console.log(`FocusTrack running on http://${HOST}:${PORT}`));
}

module.exports = app;
