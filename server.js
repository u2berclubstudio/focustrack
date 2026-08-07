'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, hashPin, verifyPin, nowISO } = require('./db');

const PORT = Number(process.env.PORT || 3000);
// Minutes to add to UTC to get your local business time. India = 330.
const TZ_OFFSET = Number(process.env.TZ_OFFSET_MINUTES || 330);
const TOKEN_DAYS = 30;

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- utilities

const localDate = (iso) =>
  new Date(new Date(iso).getTime() + TZ_OFFSET * 60000).toISOString().slice(0, 10);
const localHour = (iso) =>
  new Date(new Date(iso).getTime() + TZ_OFFSET * 60000).getUTCHours();
const todayLocal = () => localDate(nowISO());

function daysAgoLocal(n) {
  const d = new Date(Date.now() + TZ_OFFSET * 60000 - n * 86400000);
  return d.toISOString().slice(0, 10);
}

// Category guessing keeps the admin charts useful without forcing employees
// to pick from a dropdown they'll ignore.
const CATEGORY_RULES = [
  ['phone',    /phone|mobile|whatsapp|insta|instagram|facebook|reel|youtube|tiktok|twitter|social/i],
  ['people',   /colleague|boss|manager|team|someone|call|meeting|visitor|client|interrupt|talk/i],
  ['email',    /email|mail|inbox|slack|teams|message|chat|notification/i],
  ['personal', /family|home|kid|child|wife|husband|personal|bank|doctor/i],
  ['break',    /tea|coffee|chai|snack|lunch|water|washroom|toilet|smoke|break|bathroom/i],
  ['fatigue',  /tired|sleepy|bored|headache|unwell|sick|no energy|distracted mind|overthink/i],
  ['blocked',  /waiting|blocked|no data|need info|internet|slow|system|laptop|software|login|access/i],
];

function categorize(reason) {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(reason)) return cat;
  return 'other';
}

function issueToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(
    'INSERT INTO tokens (token, user_id, created_at, expires_at) VALUES (?,?,?,?)'
  ).run(
    token,
    userId,
    nowISO(),
    new Date(Date.now() + TOKEN_DAYS * 86400000).toISOString()
  );
  return token;
}

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const row = db
    .prepare(
      `SELECT t.expires_at, u.id, u.name, u.role, u.team, u.active
         FROM tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token = ?`
    )
    .get(token);

  if (!row || !row.active) return res.status(401).json({ error: 'Session expired' });
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.user = { id: row.id, name: row.name, role: row.role, team: row.team };
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// ------------------------------------------------------------------- auth

app.post('/api/login', wrap((req, res) => {
  const name = String(req.body.name || '').trim();
  const pin = String(req.body.pin || '').trim();
  if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });

  const user = db
    .prepare('SELECT * FROM users WHERE lower(name) = lower(?) AND active = 1')
    .get(name);

  if (!user || !verifyPin(pin, user.pin_hash)) {
    return res.status(401).json({ error: 'Wrong name or PIN' });
  }
  res.json({
    token: issueToken(user.id),
    user: { id: user.id, name: user.name, role: user.role, team: user.team },
  });
}));

app.post('/api/logout', auth, wrap((req, res) => {
  const token = (req.get('authorization') || '').slice(7);
  db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
  res.json({ ok: true });
}));

app.get('/api/me', auth, wrap((req, res) => res.json({ user: req.user })));

// --------------------------------------------------------------- sessions

app.get('/api/sessions/active', auth, wrap((req, res) => {
  const s = db
    .prepare(
      `SELECT * FROM sessions WHERE user_id = ? AND status = 'running'
        ORDER BY id DESC LIMIT 1`
    )
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

  // Auto-close any stale running session so a user is never stuck.
  const stale = db
    .prepare("SELECT * FROM sessions WHERE user_id = ? AND status = 'running'")
    .all(req.user.id);
  for (const s of stale) {
    const elapsed = Math.round((Date.now() - new Date(s.started_at).getTime()) / 1000);
    db.prepare(
      "UPDATE sessions SET status='abandoned', ended_at=?, actual_seconds=?, note='auto-closed' WHERE id=?"
    ).run(nowISO(), Math.min(elapsed, s.planned_minutes * 60), s.id);
  }

  const info = db
    .prepare(
      `INSERT INTO sessions (user_id, task, planned_minutes, started_at, status)
       VALUES (?,?,?,?,'running')`
    )
    .run(req.user.id, task, minutes, nowISO());

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
  res.json({ session, serverTime: nowISO() });
}));

app.post('/api/sessions/:id/distraction', auth, wrap((req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'What distracted you?' });

  const s = db
    .prepare("SELECT * FROM sessions WHERE id = ? AND user_id = ? AND status = 'running'")
    .get(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ error: 'No running session' });

  const elapsed = Math.round((Date.now() - new Date(s.started_at).getTime()) / 1000);
  db.prepare(
    `INSERT INTO distractions (session_id, user_id, reason, category, occurred_at, elapsed_seconds)
     VALUES (?,?,?,?,?,?)`
  ).run(s.id, req.user.id, reason.slice(0, 300), categorize(reason), nowISO(), elapsed);

  const count = db
    .prepare('SELECT COUNT(*) c FROM distractions WHERE session_id = ?')
    .get(s.id).c;
  res.json({ ok: true, count });
}));

function endSession(req, res, status) {
  const s = db
    .prepare("SELECT * FROM sessions WHERE id = ? AND user_id = ? AND status = 'running'")
    .get(req.params.id, req.user.id);
  if (!s) return res.status(404).json({ error: 'No running session' });

  const elapsed = Math.round((Date.now() - new Date(s.started_at).getTime()) / 1000);
  const capped = Math.min(elapsed, s.planned_minutes * 60);
  db.prepare('UPDATE sessions SET status=?, ended_at=?, actual_seconds=?, note=? WHERE id=?')
    .run(status, nowISO(), capped, String(req.body.note || '').slice(0, 300), s.id);

  res.json({ ok: true, session: db.prepare('SELECT * FROM sessions WHERE id=?').get(s.id) });
}

app.post('/api/sessions/:id/complete', auth, wrap((req, res) => endSession(req, res, 'completed')));
app.post('/api/sessions/:id/stop',     auth, wrap((req, res) => endSession(req, res, 'abandoned')));

// --------------------------------------------------------- personal stats

app.get('/api/my/today', auth, wrap((req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM distractions d WHERE d.session_id = s.id) AS distractions
         FROM sessions s
        WHERE s.user_id = ? AND s.status != 'running'
        ORDER BY s.id DESC LIMIT 50`
    )
    .all(req.user.id);

  const today = rows.filter((r) => localDate(r.started_at) === todayLocal());
  const completed = today.filter((r) => r.status === 'completed');
  res.json({
    today: {
      sessions: today.length,
      completed: completed.length,
      focusedMinutes: Math.round(today.reduce((a, r) => a + (r.actual_seconds || 0), 0) / 60),
      distractions: today.reduce((a, r) => a + r.distractions, 0),
    },
    recent: rows.slice(0, 12),
  });
}));

// ----------------------------------------------------------------- admin

function scoreFor(sessions, distractionCount) {
  const total = sessions.length;
  if (!total) return { focusScore: null, completionRate: 0, distractionsPerHour: 0 };
  const completed = sessions.filter((s) => s.status === 'completed').length;
  const hours = sessions.reduce((a, s) => a + (s.actual_seconds || 0), 0) / 3600;
  const completionRate = completed / total;
  const dph = hours > 0 ? distractionCount / hours : 0;
  const focusScore = Math.max(
    0,
    Math.round(0.6 * completionRate * 100 + 0.4 * Math.max(0, 100 - 12.5 * dph))
  );
  return {
    focusScore,
    completionRate: Math.round(completionRate * 100),
    distractionsPerHour: Math.round(dph * 10) / 10,
  };
}

function rangeFromQuery(q) {
  const from = q.from || daysAgoLocal(6);
  const to = q.to || todayLocal();
  return { from, to };
}

function fetchSessions(from, to, userId) {
  const rows = db
    .prepare(
      `SELECT s.*, u.name AS user_name, u.team,
              (SELECT COUNT(*) FROM distractions d WHERE d.session_id = s.id) AS distractions
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.status != 'running'
        ORDER BY s.started_at DESC`
    )
    .all();
  return rows.filter((r) => {
    const d = localDate(r.started_at);
    if (d < from || d > to) return false;
    if (userId && r.user_id !== Number(userId)) return false;
    return true;
  });
}

app.get('/api/admin/stats', auth, adminOnly, wrap((req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const sessions = fetchSessions(from, to, req.query.user_id);
  const ids = new Set(sessions.map((s) => s.id));

  const allDistractions = db
    .prepare(
      `SELECT d.*, u.name AS user_name FROM distractions d
         JOIN users u ON u.id = d.user_id ORDER BY d.id DESC`
    )
    .all()
    .filter((d) => ids.has(d.session_id));

  const totalDistractions = allDistractions.length;
  const overall = scoreFor(sessions, totalDistractions);

  // per employee
  const byUser = {};
  for (const s of sessions) {
    byUser[s.user_id] ||= { user_id: s.user_id, name: s.user_name, team: s.team, sessions: [], distractions: 0 };
    byUser[s.user_id].sessions.push(s);
    byUser[s.user_id].distractions += s.distractions;
  }
  const employees = Object.values(byUser)
    .map((u) => ({
      user_id: u.user_id,
      name: u.name,
      team: u.team,
      sessions: u.sessions.length,
      completed: u.sessions.filter((s) => s.status === 'completed').length,
      focusedMinutes: Math.round(u.sessions.reduce((a, s) => a + (s.actual_seconds || 0), 0) / 60),
      distractions: u.distractions,
      ...scoreFor(u.sessions, u.distractions),
    }))
    .sort((a, b) => b.focusScore - a.focusScore);

  // distraction reasons + categories
  const reasonCounts = {};
  const categoryCounts = {};
  for (const d of allDistractions) {
    const key = d.reason.trim().toLowerCase();
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    categoryCounts[d.category] = (categoryCounts[d.category] || 0) + 1;
  }
  const topReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const categories = Object.entries(categoryCounts)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  // hour-of-day pattern
  const hours = Array.from({ length: 24 }, (_, h) => ({
    hour: h, sessions: 0, completed: 0, distractions: 0, focusedMinutes: 0,
  }));
  for (const s of sessions) {
    const h = hours[localHour(s.started_at)];
    h.sessions++;
    if (s.status === 'completed') h.completed++;
    h.distractions += s.distractions;
    h.focusedMinutes += Math.round((s.actual_seconds || 0) / 60);
  }

  // daily trend
  const dayMap = {};
  for (const s of sessions) {
    const d = localDate(s.started_at);
    dayMap[d] ||= { date: d, sessions: 0, completed: 0, distractions: 0, focusedMinutes: 0 };
    dayMap[d].sessions++;
    if (s.status === 'completed') dayMap[d].completed++;
    dayMap[d].distractions += s.distractions;
    dayMap[d].focusedMinutes += Math.round((s.actual_seconds || 0) / 60);
  }
  const daily = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    range: { from, to },
    totals: {
      sessions: sessions.length,
      completed: sessions.filter((s) => s.status === 'completed').length,
      focusedHours: Math.round(sessions.reduce((a, s) => a + (s.actual_seconds || 0), 0) / 360) / 10,
      distractions: totalDistractions,
      activeEmployees: employees.length,
      ...overall,
    },
    employees,
    topReasons,
    categories,
    hours: hours.filter((h) => h.sessions > 0),
    daily,
    recentDistractions: allDistractions.slice(0, 25).map((d) => ({
      user: d.user_name, reason: d.reason, at: d.occurred_at, category: d.category,
    })),
  });
}));

app.get('/api/admin/sessions', auth, adminOnly, wrap((req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  res.json({ sessions: fetchSessions(from, to, req.query.user_id).slice(0, 500) });
}));

app.get('/api/admin/export.csv', auth, adminOnly, wrap((req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const sessions = fetchSessions(from, to, req.query.user_id);
  const dRows = db.prepare('SELECT * FROM distractions').all();
  const bySession = {};
  for (const d of dRows) (bySession[d.session_id] ||= []).push(d.reason);

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = [
    'session_id', 'employee', 'team', 'date', 'start_time', 'end_time',
    'task', 'planned_minutes', 'actual_minutes', 'status',
    'distraction_count', 'distraction_reasons',
  ];
  const lines = [head.join(',')];
  for (const s of sessions) {
    lines.push([
      s.id, s.user_name, s.team, localDate(s.started_at),
      new Date(new Date(s.started_at).getTime() + TZ_OFFSET * 60000).toISOString().slice(11, 19),
      s.ended_at ? new Date(new Date(s.ended_at).getTime() + TZ_OFFSET * 60000).toISOString().slice(11, 19) : '',
      s.task, s.planned_minutes, Math.round((s.actual_seconds || 0) / 60), s.status,
      s.distractions, (bySession[s.id] || []).join(' | '),
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="focustrack_${from}_to_${to}.csv"`);
  res.send('﻿' + lines.join('\n'));
}));

// ------------------------------------------------------------ user admin

app.get('/api/admin/users', auth, adminOnly, wrap((req, res) => {
  res.json({
    users: db
      .prepare('SELECT id, name, role, team, active, created_at FROM users ORDER BY active DESC, name')
      .all(),
  });
}));

app.post('/api/admin/users', auth, adminOnly, wrap((req, res) => {
  const name = String(req.body.name || '').trim();
  const pin = String(req.body.pin || '').trim();
  const role = req.body.role === 'admin' ? 'admin' : 'employee';
  const team = String(req.body.team || '').trim();
  if (!name || pin.length < 4) {
    return res.status(400).json({ error: 'Name required and PIN must be 4+ digits' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE lower(name)=lower(?)').get(name)) {
    return res.status(409).json({ error: 'That name already exists' });
  }
  db.prepare(
    'INSERT INTO users (name, pin_hash, role, team, created_at) VALUES (?,?,?,?,?)'
  ).run(name, hashPin(pin), role, team, nowISO());
  res.json({ ok: true });
}));

app.patch('/api/admin/users/:id', auth, adminOnly, wrap((req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (req.body.pin) {
    const pin = String(req.body.pin).trim();
    if (pin.length < 4) return res.status(400).json({ error: 'PIN must be 4+ digits' });
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(pin), user.id);
    db.prepare('DELETE FROM tokens WHERE user_id = ?').run(user.id);
  }
  if (req.body.active !== undefined) {
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, user.id);
  }
  if (req.body.team !== undefined) {
    db.prepare('UPDATE users SET team = ? WHERE id = ?').run(String(req.body.team).trim(), user.id);
  }
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ boot

app.get('/health', (req, res) => res.json({ ok: true, time: nowISO() }));

// Nightly cleanup of expired tokens.
setInterval(() => {
  try {
    db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(nowISO());
  } catch (e) { /* ignore */ }
}, 6 * 3600 * 1000).unref();

if (require.main === module) {
  app.listen(PORT, () => console.log(`FocusTrack running on http://localhost:${PORT}`));
}

module.exports = app;
