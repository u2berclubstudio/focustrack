# Upgrading your live server from v1 to v2 (multi-tenant)

This turns your single-company install into a platform many businesses can sign up for.
Your existing data is **not** deleted — it gets moved into one business that you keep using.

**Do the steps in order.** Step 3 has to happen before Step 4, or your existing workspace
ends up at `/main` with the name "My Company" instead of your own.

**Downtime:** about 20 seconds.

---

## What changes for you

| Before | After |
|---|---|
| `focus.u2berclub.com` was the login page | It's now a public signup page |
| You logged in as admin `Atul` | Your workspace moves to `focus.u2berclub.com/u2berclub` |
| One dashboard | Your dashboard is at `/u2berclub/admin`, plus a new `/master` panel |
| `seed.js` made a business admin | `seed.js` now makes the **master** account |

Your existing sessions, distractions, employees, and PINs all carry over unchanged.

---

## Step 1 — Back up first

Non-negotiable. This migration rebuilds the users table.

```bash
mkdir -p /var/backups/focustrack
cp /var/www/focustrack/data/focustrack.db /var/backups/focustrack/pre-v2-$(date +%F).db
ls -la /var/backups/focustrack/
```

You should see a file with a non-zero size. If anything below goes wrong, Step 7 puts it back.

---

## Step 2 — Pull the new code

Make sure you've pushed from GitHub Desktop first, then:

```bash
cd /var/www/focustrack
git pull
npm install --omit=dev
```

Nothing has changed on disk that the running app reads yet — it's still serving the old
code from memory. The migration happens on restart, in Step 4.

---

## Step 3 — Tell it what to call your existing workspace

This is the step that's easy to skip and annoying to undo. Paste the whole block:

```bash
tee /etc/systemd/system/focustrack.service > /dev/null <<'EOF'
[Unit]
Description=FocusTrack
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/focustrack
Environment=PORT=3011
Environment=HOST=127.0.0.1
Environment=DATA_DIR=/var/www/focustrack/data
Environment=DEFAULT_BUSINESS_NAME=U2ber Club Studio
Environment=DEFAULT_BUSINESS_SLUG=u2berclub
Environment=NODE_OPTIONS=--no-warnings
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Change `U2ber Club Studio` and `u2berclub` if you want a different name or link. The slug
becomes your team's URL: `focus.u2berclub.com/u2berclub`.

`TZ_OFFSET_MINUTES` is gone — each business now sets its own timezone, and yours is carried
over as IST automatically.

---

## Step 4 — Restart (this runs the migration)

```bash
chown -R www-data:www-data /var/www/focustrack
systemctl daemon-reload
systemctl restart focustrack
sleep 3
journalctl -u focustrack -n 20 --no-pager
```

In the log you're looking for these three lines:

```
[db] migrating users table to multi-tenant shape
[db] created default business "U2ber Club Studio" at /u2berclub
[db] moved 1 existing user(s) into "U2ber Club Studio"
```

Then confirm it's alive:

```bash
curl http://127.0.0.1:3011/health
```

> If the service won't start, `journalctl -u focustrack -n 50 --no-pager` will say why.
> Your backup from Step 1 is untouched — nothing is lost either way.

---

## Step 5 — Create your master account

The old `Atul` account is now the **owner of your business workspace**. The master account
is separate — it's the platform-level login.

```bash
cd /var/www/focustrack
sudo -u www-data env DATA_DIR=/var/www/focustrack/data node seed.js "Atul" 5510
```

Change `5510` to a PIN you'll remember. Use a **different PIN from your business login** —
these are two different accounts and mixing them up is the most likely source of "why won't
it let me in."

---

## Step 6 — Check all three doors

| Open this | You should see |
|---|---|
| `https://focus.u2berclub.com` | The public signup page asking for an invite code |
| `https://focus.u2berclub.com/master` | Master admin login — sign in with the Step 5 PIN |
| `https://focus.u2berclub.com/u2berclub` | Your team's login — sign in with your old PIN |

Hard-refresh with **Cmd+Shift+R** on each; your browser has the old pages cached.

Inside your own dashboard at `/u2berclub/admin`, check your old sessions and employees are
still listed. That's the real proof the migration worked.

Then try the whole thing end to end: in `/master` → **Invite codes** → generate one → open
the signup page in a private window and create a throwaway business with it. Better you find
a problem than your first customer does.

---

## Step 7 — If you need to roll back

```bash
systemctl stop focustrack
cp /var/backups/focustrack/pre-v2-$(date +%F).db /var/www/focustrack/data/focustrack.db
rm -f /var/www/focustrack/data/focustrack.db-wal /var/www/focustrack/data/focustrack.db-shm
cd /var/www/focustrack && git checkout HEAD~1 .
chown -R www-data:www-data /var/www/focustrack
systemctl start focustrack
```

Then tell me what happened and we'll fix it before trying again.

---

## After the upgrade

Two things worth doing in the first week:

**Set up backups if you haven't.** You're now storing other companies' data. The cron job is
in `README.md` under Backups, and the copies need to leave this VPS.

**Decide what your invite codes mean.** Seat limits are already enforced, so a code is
effectively a plan. Ten seats for a trial, more once they pay — you can raise any limit
inline from the master panel the moment they do.
