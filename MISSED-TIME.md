# Missed time

For work someone actually did today but forgot to run the timer for.

## Deploying

```bash
cd /var/www/focustrack
git pull
npm install --omit=dev
systemctl restart focustrack
sleep 2
curl http://127.0.0.1:3011/health
```

No new settings. Every existing session is marked `timed` on first start —
verified against a database built at the previous release.

---

## For a team member

The timer screen now has three tabs: **Timer**, **Missed time**, **History**.

**Missed time** takes what you worked on and roughly how long, and adds it to
today. If it was one of today's planned tasks you can pick it from a list, so
the time lands on the right thing.

Entries can be removed while it's still today.

**Today only.** Not yesterday, not last week. The purpose is to fill a gap you
noticed the same day — not to reconstruct a week from memory.

---

## The one thing to understand

**Added time counts towards your hours. It does not count towards your focus
score.**

That isn't a punishment, it's arithmetic. The focus score is built from how
often you finish what you start and how often you get pulled away. A block you
typed in afterwards has no interruptions recorded, because nobody remembers at
6pm that they got distracted four times.

If added time were scored the same, it would score *perfectly* — and the person
who forgot the timer would outrank the person who used it honestly and tapped
"distracted" five times. Within a month everyone learns to skip the timer and
fill the form at day end, and you have a timesheet instead of a focus tracker.

So the two are kept apart everywhere:

- The dashboard card reads *4h 20m of focused work* and, separately, *plus 2h
  added by hand — not counted in the score*
- Someone whose whole week is hand-entered has **no score at all**, rather than
  a great one
- The **best hours of the day** chart ignores added time, because its timestamp
  is a placeholder and would invent a working hour that never happened
- The CSV marks every row `timed` or `added by hand`, and hand-entered rows
  export no clock time

---

## Limits

| Limit | Default | Why |
|---|---|---|
| One entry | 8 hours | A typo shouldn't wreck a month of averages |
| Per day | 10 hours | Same, at the day level |
| Never more than has elapsed today | — | You can't have worked 10 hours at 9am |

Change with `MAX_MANUAL_ENTRY_MINUTES` and `MAX_MANUAL_DAY_MINUTES` in the
service file.

---

## What to watch

The ratio of hand-entered to timed hours, per workspace. A little is healthy —
it means people are recording work they'd otherwise have lost. If a team drifts
past roughly half, the timer has stopped being used and the form has become the
product. That's a conversation with that customer, not a code change.

---

## Tests

`node test-manual.js` — 28 checks. The important one runs the same 30 minutes
of work two ways, timed and typed, and asserts the timed one scores while the
typed one gets no score at all.

`npm test` runs all 245.
