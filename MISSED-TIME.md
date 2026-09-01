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

**Missed time** takes what you worked on and the **start and end times**, and
adds it to today. The length is worked out for you and shown as you pick, so a
wrong end time is obvious before you save.

The end time is pre-filled with the current time, and after saving, the next
entry's start is pre-filled with the last one's end — the gaps you're filling
usually run back to back.

If it was one of today's planned tasks you can pick it from a list, so the time
lands on the right thing. Entries can be removed while it's still today.

**The same hour can't be claimed twice.** If an entry overlaps something already
logged — another hand entry, or a block you actually ran the timer for — it's
refused and names the clash. This is the main thing real times buy you that a
plain duration never could: without them, logging 9–11 and 10–12 would silently
double-count an hour.

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
- The **best hours of the day** chart ignores added time. The times are real
  now, but they're recalled rather than measured, and mixing the two would make
  "does best work around 11am" a blend of evidence and memory
- The CSV marks every row `timed` or `added by hand`, and exports the times
  either way

---

## Limits

| Limit | Default | Why |
|---|---|---|
| One entry | 8 hours | A typo shouldn't wreck a month of averages |
| Per day | 10 hours | Same, at the day level |
| Under 5 minutes | refused | Not worth a database row |
| End time in the future | refused | You haven't done it yet |
| Overlapping anything already logged | refused | Stops the same hour counting twice |

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

`node test-manual.js` — 38 checks. The important one runs the same 30 minutes
of work two ways, timed and typed, and asserts the timed one scores while the
typed one gets no score at all. Others cover overlaps, backwards ranges, future
times and the daily cap.

The suite pins the workspace timezone so "now" is always mid-afternoon locally.
Without that, these tests would quietly skip themselves whenever the server
clock happened to be early morning — and a test that skips is worse than none.

`npm test` runs all 255.
