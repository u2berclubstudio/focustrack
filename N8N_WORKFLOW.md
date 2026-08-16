# Turning on inactive-member reminders

Two halves: the app (10 minutes on your VPS) and the n8n workflow (10 minutes
in the n8n editor). Do them in that order — the workflow needs a key the app
gives you.

---

## Part 1 — Deploy the app

### 1. Make an automation key

n8n can't sign in as you. Master sign-in needs a code emailed to you, and the
token would expire every 30 days — your reminders would silently stop. So
automation gets its own long-lived key instead.

Generate one on the VPS:

```bash
openssl rand -hex 32
```

Copy the long string it prints. **Don't paste it into a chat or a screenshot** —
anyone holding it can read the name and email of every person in every
workspace on your platform.

### 2. Pull the code

```bash
cd /var/www/focustrack
git pull
npm install --omit=dev
```

### 3. Add the key to the service file

The one new line is `ALERTS_API_KEY`. Everything else stays as it is:

```bash
nano /etc/systemd/system/focustrack.service
```

Add this line with the other `Environment=` lines, pasting your key:

```
Environment="ALERTS_API_KEY=paste-the-long-string-here"
```

Save with `Ctrl+O`, `Enter`, then `Ctrl+X`. Then restart:

```bash
systemctl daemon-reload
systemctl restart focustrack
sleep 2
curl http://127.0.0.1:3011/health
```

You want `{"ok":true,...}`.

**If you skip this step**, the automation endpoints return
`503 Automation is not enabled` and nothing else changes. That's deliberate —
an unset key means the whole surface is off rather than open.

### 4. Check the key works

```bash
curl -s -H "X-Api-Key: paste-the-long-string-here" \
  http://127.0.0.1:3011/api/automation/alerts-due | head -c 400
```

You should get JSON starting `{"due":[`. If it says `Bad key` the string
doesn't match; if it says `Automation is not enabled` the service didn't pick
up the new line — re-check the quotes and restart again.

### 5. Set the reminder frequency

Open any workspace dashboard → **Settings** tab → pick 1, 3, 6 or 12 hours →
**Save**. Every workspace defaults to 6 hours until its admin changes it.

Each business admin controls their own. You don't set it for them.

---

## Part 2 — The n8n workflow

### 1. Import it

In n8n: **Workflows → Import from File →** pick `n8n-inactive-alerts.json`
from this repo. Five nodes appear, already wired together.

### 2. Paste your key in two places

Open **Which workspaces are due**, find the `X-Api-Key` header, replace
`PASTE_YOUR_ALERTS_KEY` with your key. Do the same in **Mark them as
notified**. Both nodes need it.

### 3. Connect Gmail

Open **Email the admin** and pick your Gmail credential. If you haven't made
one, n8n walks you through Google sign-in. This is a normal OAuth connection —
nothing to do with the app password you set up for the app itself.

### 4. Test before switching it on

Click **Execute Workflow** to run it once by hand. Then check:

- **Which workspaces are due** returned some items → good
- Returned an empty `due` array → also fine, it just means nobody is overdue
  right now. To force one, set a workspace to 1 hour in Settings and make sure
  at least one person hasn't logged today.
- **Email the admin** shows green and the mail arrives

Only once a real email lands should you flip **Active** on, top right.

---

## What actually happens each hour

1. n8n asks the app: *which workspaces are due a reminder?*
2. The app checks each active workspace: has it been at least `interval` hours
   since the last reminder, and is anyone currently inactive? It returns only
   those, with the names already attached.
3. n8n sends one email per workspace to that workspace's contact address.
4. n8n tells the app which ones went out, and the app stamps them.

The date arithmetic lives in the app, not in n8n. That's deliberate — it's the
part that quietly breaks in visual workflow tools, and it's covered by tests
here.

**Failed sends retry by themselves.** The "mark as sent" step only runs after
the email node succeeds, so if Gmail is down the workspace stays due and gets
picked up next hour.

---

## Things that are handled

- A workspace with **no contact email** is skipped rather than erroring.
- A **suspended** workspace stops being emailed.
- A workspace where **everyone is logging** is skipped — no "all clear" spam.
- Owners and admins are included in the list. They use the timer too.
- **Junk workspace ids** in the mark-sent call are ignored.

Each of these has a test in `test-alerts.js`.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| `503 Automation is not enabled` | `ALERTS_API_KEY` isn't set, or the service wasn't restarted |
| `401 Bad key` | The key in n8n doesn't match the one in the service file |
| `due` is always empty | Everyone is logging, or the interval hasn't elapsed since the last email |
| Emails arrive every hour | Check **Mark them as notified** is running and green — without it nothing gets stamped |
| No email but `due` had items | Look at the Gmail node's output in the n8n execution log |

To see what the app thinks, from the VPS:

```bash
curl -s -H "X-Api-Key: YOUR_KEY" \
  http://127.0.0.1:3011/api/automation/alerts-due | python3 -m json.tool
```

---

## If you'd rather not run n8n at all

This can move inside the app as a background job — same schedule, using the
Gmail settings already configured for sign-in codes, no second system to keep
running. Roughly 40 lines. Say the word and I'll build it; the API stays as it
is either way, so nothing you set up now is wasted.

---

## Rotating the key

If it ever leaks: generate a new one, replace it in the service file and in
both n8n nodes, restart. The old key stops working immediately. Nothing else
is affected.
