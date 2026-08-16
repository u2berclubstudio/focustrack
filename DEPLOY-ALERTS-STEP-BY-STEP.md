# Turning on reminders — every step

Four parts. Do them in order; each one needs the one before it.

- **Part A** — get the new code onto GitHub (your computer, 5 min)
- **Part B** — put it on the server (VPS, 10 min)
- **Part C** — build the n8n workflow (n8n, 10 min)
- **Part D** — prove it actually works (5 min)

Nothing here can break what's already running. Your team keeps using the app
throughout.

---

# PART A — Get the code onto GitHub

Your server pulls from GitHub. So the new code has to go there first, from
your computer, using GitHub Desktop.

### A1. Download the zip

Click **focustrack-v2.zip** in this chat and save it. It lands in your
Downloads folder.

### A2. Unzip it

Double-click the zip. You get a folder called **focustrack-v2** containing
files like `server.js`, `db.js`, `package.json`, and a `public` folder.

### A3. Open your repo folder

In GitHub Desktop, with **focustrack** selected at the top left, press:

- **Mac:** `Cmd + Shift + F`
- **Windows:** `Ctrl + Shift + F`

That opens the actual folder on your computer. Leave the window open.

### A4. Copy the new files in, replacing the old ones

Open the unzipped **focustrack-v2** folder in a second window.

Select everything inside it — `Cmd+A` on Mac, `Ctrl+A` on Windows — and drag
it into your repo folder from step A3.

Your computer will ask whether to replace existing files:

- **Mac:** click **Replace**
- **Windows:** click **Replace the files in the destination**

**This is safe.** You are only replacing code. The `data` folder with your
sessions lives on the server, not here, and the zip doesn't contain one.

### A5. Commit

Back in GitHub Desktop you'll see a list of changed files on the left —
`server.js`, `db.js`, `public/admin.html` and a few new ones.

At the bottom left, in the **Summary** box, type:

```
Add inactive member reminders
```

Click **Commit to main**.

### A6. Push

Click **Push origin** at the top.

When the button stops spinning, the code is on GitHub. Part A done.

---

# PART B — Put it on the server

Open your terminal and connect:

```bash
ssh root@129.121.123.192
```

### B1. Make your automation key

n8n can't log in as you — master sign-in needs a code emailed to you, and that
token expires monthly. So automation gets its own key that doesn't expire.

```bash
openssl rand -hex 32
```

It prints a long line of letters and numbers. **Copy it somewhere safe now.**

⚠️ **Do not screenshot this or paste it into a chat.** Anyone holding it can
read the name and email of every person in every workspace you host.

### B2. Pull the new code

```bash
cd /var/www/focustrack
git pull
npm install --omit=dev
```

`git pull` should mention `server.js`, `db.js` and `admin.html`. If it says
**Already up to date**, Part A didn't finish — go back and check you clicked
**Push origin**.

### B3. Open the service file

```bash
nano /etc/systemd/system/focustrack.service
```

A text editor fills the screen. Use **arrow keys** to move — the mouse does
nothing here.

### B4. Add one line

Move the cursor to the end of the line that starts `Environment="MAIL_FROM=`
and press **Enter** to make a new line. Type this, pasting your key from B1
in place of the placeholder:

```
Environment="ALERTS_API_KEY=paste-your-key-here"
```

The quotes matter. Keep them.

The block should now look like this (your key will be longer):

```
Environment=SMTP_HOST=smtp.gmail.com
Environment=SMTP_PORT=465
Environment=SMTP_USER=honestdigitalmarketer@gmail.com
Environment="SMTP_PASS=your-app-password"
Environment="MAIL_FROM=FocusTrack <honestdigitalmarketer@gmail.com>"
Environment="ALERTS_API_KEY=a1b2c3d4e5f6..."
ExecStart=/usr/bin/node server.js
```

### B5. Save and close

Three keystrokes, in order:

1. `Ctrl + O`  (letter O, not zero) — asks where to save
2. `Enter` — confirms
3. `Ctrl + X` — exits

You're back at the normal prompt.

### B6. Restart

```bash
systemctl daemon-reload
systemctl restart focustrack
sleep 2
curl http://127.0.0.1:3011/health
```

You want `{"ok":true,"time":"..."}`.

If you get nothing, something's wrong in the file — run
`journalctl -u focustrack -n 20 --no-pager` and send me what it says.

### B7. Check the key works

Paste your key in place of the placeholder:

```bash
curl -s -H "X-Api-Key: paste-your-key-here" \
  http://127.0.0.1:3011/api/automation/alerts-due | head -c 200
```

| You see | Meaning |
|---|---|
| `{"due":[...` | Working. Continue to Part C. |
| `{"due":[],...` | Working — nobody is overdue right now. Fine. |
| `Automation is not enabled` | The service didn't pick up the new line. Redo B3–B6. |
| `Bad key` | The key you typed doesn't match the file. |

Part B done. The app is ready; nothing is sending yet.

---

# PART C — Build the n8n workflow

### C1. Import the file

Download **n8n-inactive-alerts.json** from this chat.

In n8n: **Workflows** → **Import from File** → choose that file.

Five connected boxes appear.

### C2. Put your key in the first box

Double-click **Which workspaces are due**.

Scroll to **Header Parameters**. There's a row named `X-Api-Key` with the
value `PASTE_YOUR_ALERTS_KEY`. Replace that text with your real key.

Click **Back to canvas**.

### C3. Put your key in the last box too

Double-click **Mark them as notified** and do exactly the same thing.

**Both boxes need it.** If you only do one, emails go out every single hour
forever, because nothing ever gets marked as sent.

### C4. Connect email

Double-click **Email the admin**.

Next to **Credential to connect with**, click **Create new credential**. You
get four boxes. Fill them exactly like this:

| Box | Value |
|---|---|
| **User** | `honestdigitalmarketer@gmail.com` |
| **Password** | the Gmail **app password** from the security setup |
| **Host** | `smtp.gmail.com` |
| **Port** | `465` |

Then turn **SSL/TLS** **on**.

Click **Save**. n8n tests it immediately and shows a green tick if Gmail
accepted it.

> **Why not the Gmail node?** n8n's Gmail node uses OAuth, which needs a Google
> Cloud project, an OAuth consent screen, and a client ID and secret — about 15
> minutes of setup. Plain SMTP does the same job with the app password you
> already have. If you ever see a screen asking for **Client ID** and **Client
> Secret**, you're on the OAuth path — close it and use **Send Email** instead.

If you don't still have the app password, it's one-time-view — make a fresh one
at **https://myaccount.google.com/apppasswords** and use that. Making a new one
does not break the old one used by the app.

Click **Back to canvas**, then **Save** at the top right.

**Leave the workflow switched OFF for now.** Part D turns it on.

---

# PART D — Prove it works

Don't trust it until you've watched one real email arrive.

### D1. Force a workspace to be overdue

Open `https://focus.u2berclub.com/u2berclub/admin` (or any workspace you own).

Click the **Settings** tab → set **Notify me every** to **1 hour** → **Save**.

Make sure at least one person there hasn't started a session in the last hour.
Easiest: use a workspace nobody has touched today.

### D2. Run it once by hand

In n8n, click **Execute Workflow**.

Watch the boxes. Green ticks mean success.

### D3. Read the result

Click on **Which workspaces are due** to see what came back.

**If `due` has items:** the email should land within a minute. Check the inbox
of that workspace's contact address — not necessarily yours.

**If `due` is empty:** nothing was overdue. Either everyone logged recently, or
a reminder already went out inside the interval. Check D1 again.

### D4. Switch it on

Only once a real email has arrived: flip **Active** to on, top right.

It now runs every hour by itself.

### D5. Check back tomorrow

Open n8n → **Executions**. You should see roughly one run per hour, all green.
Most will do nothing, which is correct — silence means everyone is logging.

---

# What each workspace admin does

Nothing on your side. Each admin opens their own dashboard → **Settings** →
picks 1, 3, 6 or 12 hours. Everyone starts on 6 until they change it.

They only hear from you when someone on their team has actually gone quiet.

---

# When something looks wrong

| Symptom | Cause |
|---|---|
| Emails every hour, non-stop | The key is missing from **Mark them as notified** (step C3) |
| No emails at all | Workflow isn't **Active**, or nobody is overdue |
| `503 Automation is not enabled` | `ALERTS_API_KEY` missing on the server — redo B3–B6 |
| `401 Bad key` | The key in n8n doesn't match the server's |
| An admin says they get nothing | Their workspace has no contact email saved — it's skipped on purpose |
| `git pull` says "Already up to date" | The push in Part A didn't go through |
| n8n asks for **Client ID** / **Client Secret** | You opened the Gmail OAuth node. Use **Send Email** (SMTP) instead — see C4 |
| `Invalid login` from the email node | Wrong password, or you used your normal Gmail password instead of the app password |
| Email node times out | Your n8n host blocks port 465 — try port `587` with SSL/TLS off and STARTTLS on |

To see what the server thinks at any moment:

```bash
curl -s -H "X-Api-Key: YOUR_KEY" \
  http://127.0.0.1:3011/api/automation/alerts-due | python3 -m json.tool
```

---

# Undoing it

To stop all reminders instantly: switch the n8n workflow **Active** off.

To turn the feature off at the server: delete the `ALERTS_API_KEY` line from
the service file and restart. The endpoints then refuse everything. The
Settings tab still shows, it simply has no effect.

Neither touches your data or interrupts anyone using the timer.
