# FocusTrack

Focus-session tracking that multiple businesses can use on one install.

An employee types what they're about to do, picks a duration (30 min by default), and hits
Start. If they get pulled away they tap **I got distracted** and log the reason — the timer
keeps running. Their manager sees the rollup. You, the platform owner, see every business.

**Already running v1?** Read `UPGRADE.md` before pulling. Your data migrates automatically,
but the order of the steps matters.

---

## Three levels

| Who | Where | What they do |
|---|---|---|
| **Employee** | `/<team-link>` | Runs timers, logs distractions |
| **Business admin** | `/<team-link>/admin` | Sees their team's stats, adds staff, exports CSV |
| **You (master)** | `/master` | Issues invite codes, approves/suspends businesses, sets seat limits, sees live activity |

A business gets in only with a one-time invite code that you generate. Nobody can sign up
without one.

---

## What's in the box

```
focustrack/
├── server.js            API — signup, auth, sessions, stats, master admin
├── db.js                Schema, PIN hashing, v1→v2 migration
├── seed.js              Creates the master admin account
├── test.js              29 end-to-end checks incl. tenant isolation
├── test-migration.js    Proves a live v1 database upgrades without data loss
└── public/
    ├── index.html       Public landing + invite-code signup
    ├── app.html         Employee timer
    ├── admin.html       Business dashboard
    ├── master.html      Master admin panel
    ├── 404.html
    └── style.css
```

No build step, no framework, no CDN calls. One dependency: Express (plus optional
better-sqlite3 — Node 22.5+ has SQLite built in).

---

## Install

```bash
# Node 22+ recommended (has SQLite built in; nothing to compile)
git clone <your-repo> /var/www/focustrack
cd /var/www/focustrack
npm install --omit=dev

# create your master account
DATA_DIR=./data node seed.js "Atul" 4321

# run
DATA_DIR=./data PORT=3011 node server.js
```

Then open `/master`, sign in, and generate your first invite code.

For production, run it behind nginx with HTTPS under a systemd unit — `UPGRADE.md` contains
a working service file you can copy.

---

## Day one as the platform owner

1. Open `/master` → **Invite codes** → set who it's for and a seat limit → **Generate**.
2. Send the business the code and your signup link (`https://yourdomain.com`).
3. They pick their own team link (e.g. `acme`), set their name and PIN, and land in their dashboard.
4. They add staff from their dashboard. Staff sign in at `/acme` with name + PIN.

**"Activate instantly"** (on by default) means the workspace works the moment they sign up —
sensible, because you already vetted them by handing over the code. Untick it if you'd
rather approve each one yourself; they'll sit in **pending** until you click Approve.

### Reading the master panel

- **Live** — green dot means somebody logged a session in the last 24 hours. This is the
  column that tells you who actually adopted the tool versus who just signed up.
- **7d** — sessions in the last week, with how many distinct people are behind them.
  Ten sessions from one person is a very different story from ten across five people.
- **Seats** — used vs limit. Edit the limit inline; it takes effect immediately.
- **View as** — opens their dashboard as their owner. Every use is written to the activity
  log, and their dashboard shows a banner saying you're in there.

**Suspend** signs everyone in that business out instantly and blocks new logins. Their data
is untouched and reversible — approving them again restores everything.

---

## How the focus score works

```
focusScore = 0.6 × completionRate + 0.4 × max(0, 100 − 12.5 × distractionsPerHour)
```

- **Completion rate** — % of started sessions that reached the end (or were marked done).
- **Distractions per hour** — logged distractions ÷ hours of focused time. 0/hr scores full
  marks on that half; 8/hr scores zero.

So 75% completion with 1 distraction/hour = `0.6×75 + 0.4×87.5` = **80**.
80+ is healthy, 60–79 means something is eating the day, below 60 means sessions are being
started and abandoned.

**Worth telling every business you onboard:** the distraction button only produces useful
data if people feel safe pressing it. The moment it's used in appraisals, everyone's score
becomes 100 and the dashboard goes blind. "Help me find what's interrupting you" gets far
better data than "I'm watching you."

---

## Configuration

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `HOST` | `127.0.0.1` | Bind address. Loopback by default so only nginx can reach it |
| `DATA_DIR` | `./data` | Where the SQLite file lives |
| `DEFAULT_BUSINESS_NAME` | `My Company` | Only used once, when migrating a v1 database |
| `DEFAULT_BUSINESS_SLUG` | `main` | Only used once, when migrating a v1 database |

Each business sets its own timezone; there's no global timezone any more.

---

## Data model

```
businesses ─┬─ users ─┬─ sessions ── distractions
            │         └─ tokens
            └─ invite_codes (one-time, carries the seat limit)

users.business_id IS NULL  →  master admin (platform owner)
```

Every session and distraction row carries `business_id`, and every query filters on it.
Employee names are unique *within* a business, so two companies can both employ a "Ravi".

---

## Admin API

All endpoints take `Authorization: Bearer <token>`.

**Business admin**

| Endpoint | Returns |
|---|---|
| `GET /api/admin/stats?from=&to=&user_id=` | Full dashboard JSON |
| `GET /api/admin/export.csv?from=&to=` | CSV, one row per session |
| `GET/POST /api/admin/users` | List / add staff (seat-limited) |
| `PATCH /api/admin/users/:id` | `{pin?, active?, team?}` |
| `PATCH /api/admin/settings` | `{name?, tz_offset?}` |

**Master**

| Endpoint | Returns |
|---|---|
| `GET /api/master/overview` | Every business with live activity |
| `GET/POST /api/master/codes` | List / generate invite codes |
| `DELETE /api/master/codes/:code` | Delete an unused code |
| `POST /api/master/businesses/:id/status` | `{status: pending\|active\|suspended}` |
| `PATCH /api/master/businesses/:id` | `{seat_limit?, tz_offset?}` |
| `POST /api/master/businesses/:id/impersonate` | Token to view that workspace |
| `GET /api/master/audit` | Activity log |

Dates are `YYYY-MM-DD` in the business's timezone. Omit them for the last 7 days.

---

## Backups

One SQLite file holds everything. Nightly copy, keeping 30 days:

```bash
apt-get install -y sqlite3
mkdir -p /var/backups/focustrack
(crontab -l 2>/dev/null; echo '0 2 * * * sqlite3 /var/www/focustrack/data/focustrack.db ".backup /var/backups/focustrack/ft-$(date +\%F).db" && find /var/backups/focustrack -name "*.db" -mtime +30 -delete') | crontab -
```

Then pull those copies off the box — a backup on the same VPS isn't a backup. You're now
holding other companies' data, so this stops being optional.

---

## Testing

```bash
DATA_DIR=/tmp/ft-test node test.js      # 29 checks
node test-migration.js                  # v1 → v2 upgrade with real data
```

The isolation checks are the ones that matter: a business cannot read another's sessions,
export another's CSV, or reset another's PINs.

---

## Things you'll probably want next

- **Billing** — seat limits are already there; a plan/price per business is the next piece
- **Email** — welcome mail on signup, weekly digest to each business admin
- **Password reset** without you doing it by hand
- **A pending-signup email** to you, so you don't have to watch the master panel
- **Per-employee weekly targets** and streaks
