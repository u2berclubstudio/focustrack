# Turning on the security update

Two things change for you: your master sign-in now asks for an emailed code, and
new PINs must be 6 digits. Everyone already using the app keeps their existing PIN
and notices nothing.

**Time:** about 15 minutes, most of it inside your Google account.

---

## Step 1 — Get a Gmail app password

Your normal Gmail password will not work here, and you should not use it anyway.
Google issues a separate 16-character password for exactly this.

1. Go to **https://myaccount.google.com/security**
2. Turn on **2-Step Verification** if it isn't already. Google will not offer app
   passwords until you do — this is unavoidable.
3. Then open **https://myaccount.google.com/apppasswords**
4. Type a name — `FocusTrack` — and click **Create**.
5. Google shows a 16-character password like `abcd efgh ijkl mnop`.
   **Copy it now**, it is shown once. The spaces don't matter; keep or drop them.

> Can't find the app passwords page? It only appears once 2-Step Verification is on.
> Wait a minute after enabling it and reload.

---

## Step 2 — Deploy the code

```bash
cd /var/www/focustrack
git pull
npm install --omit=dev
```

`npm install` matters this time — there's one new package for sending mail.

---

## Step 3 — Put the mail settings in the service file

⚠️ This file now contains a password. Lock it down in the same breath.

Replace `PASTE_APP_PASSWORD_HERE` with what Google gave you, then paste the block:

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
Environment=SMTP_HOST=smtp.gmail.com
Environment=SMTP_PORT=465
Environment=SMTP_USER=honestdigitalmarketer@gmail.com
Environment="SMTP_PASS=PASTE_APP_PASSWORD_HERE"
Environment="MAIL_FROM=FocusTrack <honestdigitalmarketer@gmail.com>"
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

chmod 600 /etc/systemd/system/focustrack.service
systemctl daemon-reload
systemctl restart focustrack
sleep 2
curl http://127.0.0.1:3011/health
```

`chmod 600` means only root can read the file. Without it, any user on the box can
read your Gmail app password.

---

## Step 4 — Attach your email to the master account

```bash
cd /var/www/focustrack
sudo -u www-data env DATA_DIR=/var/www/focustrack/data \
  node seed.js "Atul" 481902 honestdigitalmarketer@gmail.com
chown -R www-data:www-data /var/www/focustrack/data
```

**Pick your own 6-digit PIN** — not `481902`, and not `123456` or `111111`; the
script refuses those. It prints a confirmation showing which email is attached.

---

## Step 5 — Test it before you rely on it

Open `https://focus.u2berclub.com/master` and sign in.

1. Name and PIN → **Continue**
2. Check your Gmail for a 6-digit code
3. Type it → you're in

**If the email doesn't arrive within a minute:**

```bash
journalctl -u focustrack -n 30 --no-pager | grep otp
```

The code is written to the log whenever sending fails, so you can still get in and
then fix the mail settings. Common causes:

| Log message | Fix |
|---|---|
| `Invalid login` / `Username and Password not accepted` | The app password is wrong, or you used your normal Gmail password |
| `SMTP is not configured` | A typo in one of the `Environment=SMTP_*` lines |
| `connect ETIMEDOUT` | Your host blocks outbound port 465 — switch to `SMTP_PORT=587` |

---

## What changed, in plain terms

**Sign-in attempts are now limited.** Five wrong PINs locks that one account for 15
minutes. The lock is per person, so one employee fumbling their PIN never locks out
the rest of the team, and it clears itself — you never have to unlock anything.

**Guessing across many accounts is throttled too.** Twenty failures from one internet
address in 15 minutes and that address is blocked for a while, whichever accounts it
was aiming at.

**Errors give nothing away.** A name that doesn't exist and a wrong PIN now return
the identical message, so an attacker can't use the login form to discover who works
at a company.

**Team links can't be enumerated.** Checking whether a link like `/acme` exists now
requires a live, unused invite code. Someone can no longer walk the alphabet and map
your whole customer list.

**New PINs are 6 digits** and obvious ones are refused — repeated digits, straight
sequences, and the usual suspects. Existing 4-digit PINs keep working. If you want a
team moved up, their admin can reset PINs from the Team tab.

**Failed sign-ins are logged.** Master panel → Activity log shows them with the IP
address. Worth a glance now and then; a burst of `login_failed` for one business is
worth a phone call to them.

**Business admins can sign everyone out.** Dashboard → Team tab → Security. Ends every
device for that team at once. This is what they should use when someone leaves.

---

## If you ever get locked out of the master account

Your PIN and email both live in the database, and you have root on the box:

```bash
cd /var/www/focustrack
sudo -u www-data env DATA_DIR=/var/www/focustrack/data \
  node seed.js "Atul" <new-6-digit-pin> <your-email>
```

That resets the PIN, clears any lockout on the master account, and cancels any
half-finished sign-in. If email is the thing that's broken, run it with no email
argument — the account then works on PIN alone until you set one again.

---

## Still worth doing eventually

None of these are urgent, but they're the honest remaining gaps:

- **Backups off this VPS.** You now hold other companies' data. A backup sitting on
  the same machine doesn't survive the machine.
- **A real password reset for business owners** — right now they have to ask you.
- **Email alerts to you** when a business gets a burst of failed sign-ins.
