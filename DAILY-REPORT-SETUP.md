# The end-of-day report

An email each evening, per workspace: what each person planned, what they
actually logged against it, and which of the admin's assigned tasks got done.

This is a **second** n8n workflow, separate from the hourly inactive nudge.
Different job, different schedule, switched on and off independently.

---

## What it looks like

```
2 of 3 people worked. Planned 2h 15m, logged 2h 20m across 4 sessions.
Of the work you assigned, 0 of 1 got done.
1 interruption logged.

----------------------------------------
Neha  (Sales)
  planned 2h 15m   logged 1h 40m   1 of 3 tasks done
  your tasks: 0 of 1 done

  [x] Sharma quotation   (30m planned, 25m actual)
  [ ] Follow up 3 leads   (1h planned, 55m actual)
  [-] Prepare board deck   (1h 30m planned, you assigned)
        skipped: Waiting on figures from finance
  [ ] Weekly report   (45m planned, moved 1x)
  + 20m on 1 unplanned session

----------------------------------------
Sam  (Ops)
  logged 40m across 1 session — nothing was planned

----------------------------------------
NO ACTIVITY AT ALL
  Ravi
  Nothing planned and no timer use. May be off today.
```

`[x]` done · `[ ]` still open · `[-]` skipped, with the reason underneath.

---

## Before you start

You need the automation key from the inactive-alerts setup. Same key, same
service file line — nothing new on the server beyond a `git pull`.

If you haven't done that yet, do `DEPLOY-ALERTS-STEP-BY-STEP.md` first.

---

## Step 1 — Update the app

```bash
cd /var/www/focustrack
git pull
npm install --omit=dev
systemctl restart focustrack
sleep 2
curl http://127.0.0.1:3011/health
```

No new environment variables. The two new columns are added on start.

## Step 2 — Check the feed answers

```bash
curl -s -H "X-Api-Key: YOUR_KEY" \
  http://127.0.0.1:3011/api/automation/reports-due | head -c 300
```

`{"due":[` means it's working. An empty `due` is normal — it only fills once a
workspace has passed its chosen hour and hasn't had today's report yet.

## Step 3 — Look at the report before switching anything on

Open your dashboard → **Settings** → **Show me today's report**.

That preview is the *exact* text the email sends — same code path, checked by a
test that fails if the two ever drift. If it looks wrong or empty, fix that
before wiring up n8n rather than after.

## Step 4 — Set the time and the address

Same Settings card:

- **Send it at** — 3pm through 9pm, or **Don't send it** to switch off
- **Send it to** — the address that receives it

The time is in the workspace's own timezone. A Dubai workspace and a Delhi one
both get theirs at 6pm *their* time.

Every workspace starts at 6pm by default, but nothing is sent until the n8n
workflow below is running.

## Step 5 — Import the second workflow

In n8n: **Workflows → Import from File →** `n8n-daily-report.json`.

Then, exactly as before:

1. Paste your key into **Which reports are due**
2. Paste it into **Mark reports as sent** too — both nodes need it
3. Open **Email the report**, pick the same SMTP credential you made for the
   alerts workflow (User: your Gmail, Password: the app password, Host:
   `smtp.gmail.com`, Port `465`, SSL on)

## Step 6 — Test, then switch on

Force one to be due:

```sql
-- from the VPS, if you want to test right now rather than wait until 6pm
sqlite3 /var/www/focustrack/data/focustrack.db \
  "UPDATE businesses SET daily_report_hour = 0, last_daily_report_date = NULL WHERE slug = 'u2berclub';"
```

Click **Execute Workflow** in n8n. The email should arrive within a minute.
Then put the hour back to 18 in Settings and flip the workflow **Active**.

---

## Why it runs hourly for a daily email

The trigger fires every hour, but each workspace has its own send hour in its
own timezone. The app answers "who is due *right now*", and stamps each one
with the local date once sent.

That's what makes **one email per workspace per day** hold even though the
workflow runs 24 times. There's a test that calls the feed five times in a row
and asserts nothing sends twice.

Don't be tempted to switch the trigger to daily — that would send at one fixed
UTC hour and get the time wrong for every workspace outside your own timezone.

---

## What's in the numbers

**Skipped work is not counted as planned.** It was explicitly dropped with a
reason, so counting it as a shortfall would misrepresent the day.

**Unplanned work is reported, not hidden.** The `+ 20m on 1 unplanned session`
line. Often the real story of a day is the thing nobody planned for, and a
report that only shows planned work would quietly erase it.

**People with nothing at all are named separately** rather than shown as a row
of zeroes. Usually it means they're off, and a zero row implies something worse.

**"Done" is self-reported** — someone can tick a task without touching the
timer. That's why every line shows planned against actual rather than a tick
alone.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| `due` always empty | Nobody has reached their hour yet, or today's already went |
| Report arrives more than once | **Mark reports as sent** isn't running — check it's green |
| No report at all | Report hour is set to "Don't send it", or no email address saved |
| Wrong day's data | The workspace timezone is wrong — Settings → timezone |
| Report is nearly empty | Nobody used the timer that day. Check the inactive alerts are on |
| `503 Automation is not enabled` | `ALERTS_API_KEY` missing from the service file |

---

## Tests

- `node test-report.js` — 28 checks: due-now logic across timezones, the
  once-a-day guarantee, what the numbers contain, opt-out, tenant isolation
- `node test-report-email.js` — 9 checks running the actual email template
  against real data, including a workspace where nobody did anything
- `node test-ui.js` — includes a check that the Settings preview and the
  emailed report are byte-for-byte identical

`npm test` runs all 169.
