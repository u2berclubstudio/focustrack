# FocusTrack

A focus-session tracker for small teams. An employee types what they're about to do,
picks a duration (30 min by default), and hits Start. If they get pulled away they tap
**I got distracted** and log the reason — the timer keeps running. Everything lands in a
SQLite database on your VPS and rolls up into an admin dashboard.

---

## What's in the box

```
focustrack/
├── server.js        Express API (auth, sessions, distractions, stats, CSV)
├── db.js            SQLite schema + PIN hashing
├── seed.js          Creates your first admin account
├── test.js          End-to-end smoke test (21 checks)
├── package.json
└── public/
    ├── index.html   Employee timer (mobile-first, one screen)
    └── admin.html   Admin dashboard
```

No build step, no framework, no CDN calls. Two dependencies: Express and SQLite.

---

## Quick start on your VPS

Assumes Ubuntu/Debian. Adjust paths and the domain to taste.

### 1. Install Node 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v          # should print v22.x
```

Node 22.5+ ships SQLite internally, so nothing needs to compile. If you're on an older
Node, `apt-get install -y build-essential python3` first so `better-sqlite3` can build.

### 2. Upload and install

```bash
sudo mkdir -p /opt/focustrack
sudo chown $USER:$USER /opt/focustrack
# copy the focustrack folder contents here, then:
cd /opt/focustrack
npm install --omit=dev
```

### 3. Create your admin login

```bash
node seed.js "Atul" 4321
```

Pick a real PIN, not 4321. Re-running with the same name resets that person's PIN.

### 4. Run it as a service

```bash
sudo tee /etc/systemd/system/focustrack.service > /dev/null <<'EOF'
[Unit]
Description=FocusTrack
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/focustrack
Environment=PORT=3000
Environment=DATA_DIR=/opt/focustrack/data
Environment=TZ_OFFSET_MINUTES=330
Environment=NODE_OPTIONS=--no-warnings
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo chown -R www-data:www-data /opt/focustrack
sudo systemctl daemon-reload
sudo systemctl enable --now focustrack
sudo systemctl status focustrack
```

`TZ_OFFSET_MINUTES=330` is IST. It only affects how days and hours are bucketed in
reports — change it if your team isn't in India (UTC = 0, Dubai = 240, London BST = 60).

### 5. Put nginx in front

```bash
sudo tee /etc/nginx/sites-available/focustrack > /dev/null <<'EOF'
server {
    listen 80;
    server_name focus.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/focustrack /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 6. HTTPS

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d focus.yourdomain.com
```

Do this before rolling out. PINs travel in the request body — over plain HTTP anyone on
the same network can read them.

---

## Daily use

**Employees** open `https://focus.yourdomain.com`, sign in once with name + PIN (the
login sticks for 30 days), then:

1. Type the task → pick 15 / 30 / 45 / 60 min → **Start**
2. Distracted? Tap the orange button, tap a quick reason or type one. Timer keeps ticking.
3. Timer hits zero → session auto-records as completed. Or tap **Done early**.
4. **Give up** records the session as not completed.

Closing the tab doesn't lose anything — the timer is anchored to the server's start
timestamp, so reopening the page resumes the countdown exactly where it was.

**You** open `/admin.html` (a Dashboard link appears in the header once you log in as an
admin) to see the rollup, add employees, reset PINs, and export CSV.

---

## How the focus score works

```
focusScore = 0.6 × completionRate + 0.4 × max(0, 100 − 12.5 × distractionsPerHour)
```

- **Completion rate** — % of started sessions that reached the end (or were marked done).
- **Distractions per hour** — total logged distractions ÷ hours of focused time.
  0/hr scores full marks on that half; 8/hr scores zero.

So 75% completion with 1 distraction/hour = `0.6×75 + 0.4×87.5` = **80**.

A quick read on the numbers: 80+ is healthy, 60–79 means something is eating the day,
below 60 means sessions are being started and abandoned.

**One caution worth naming:** the distraction button only produces useful data if people
feel safe pressing it. The moment it's used in appraisals, everyone's score becomes 100
and you learn nothing. Framing it as "help me find what's interrupting you" gets far
better data than framing it as monitoring.

---

## Configuration

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `DATA_DIR` | `./data` | Where the SQLite file lives |
| `TZ_OFFSET_MINUTES` | `330` | Minutes ahead of UTC for day/hour bucketing |

---

## Admin API (if you want to pipe data elsewhere)

All endpoints take `Authorization: Bearer <token>` from `POST /api/login`.

| Endpoint | Returns |
|---|---|
| `GET /api/admin/stats?from=&to=&user_id=` | Full dashboard JSON |
| `GET /api/admin/sessions?from=&to=` | Raw session rows |
| `GET /api/admin/export.csv?from=&to=` | CSV, one row per session |
| `GET /api/admin/users` | User list |
| `POST /api/admin/users` | `{name, pin, role, team}` |
| `PATCH /api/admin/users/:id` | `{pin?, active?, team?}` |

Dates are `YYYY-MM-DD` in your configured timezone. Omit them for the last 7 days.

---

## Backups

The whole system is one file. Nightly copy to somewhere off the box:

```bash
sudo crontab -e
# add:
0 2 * * * sqlite3 /opt/focustrack/data/focustrack.db ".backup '/opt/focustrack/backup-$(date +\%F).db'"
```

(`apt-get install -y sqlite3` if you don't have the CLI.) Then rsync the backups somewhere
else — a backup living on the same VPS isn't a backup.

---

## Testing

```bash
DATA_DIR=/tmp/ft-test node test.js
```

Covers login and auth guards, session lifecycle, distraction logging, stale-session
auto-close, focus-score arithmetic, date filtering, CSV shape, and user management.

---

## Things you'll probably want next

- **Idle detection** — a "still there?" ping if the tab is backgrounded a long time
- **Daily email digest** to you at 7pm
- **Per-employee weekly target** (e.g. 12 focus hours) with a progress bar
- **Categories on the task input** so you can see time split by project, not just person
- **Streaks** for the employee view — the one bit of gamification that reliably works
