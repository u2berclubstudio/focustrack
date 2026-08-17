# The day planner

## Deploying it

Same three steps as always. No new keys, no new settings.

```bash
cd /var/www/focustrack
git pull
npm install --omit=dev
systemctl restart focustrack
sleep 2
curl http://127.0.0.1:3011/health
```

The new table and column are created on first start. Existing sessions,
people and workspaces are untouched — verified against a v1-shaped database.

Nothing to configure. The plan card appears on everyone's timer screen and a
**Plans** tab appears for admins.

---

## For a team member

The timer screen now opens with **Today's plan** above the start box.

- Type a task, pick a rough length, **Add**
- **Start** on any row starts the timer for it — no retyping
- The circle on the left marks it done
- **×** removes it — but only tasks you added yourself

You don't have to plan. The box below still works exactly as before, so a day
you didn't plan costs you nothing.

**When a session ends** on a planned task, you're asked whether the task is
finished. Two buttons. Finishing a 30-minute block often doesn't finish the
job, so the app asks rather than assumes — guessing either way would make the
numbers lie.

**Finished work leaves the list.** Ticking a task drops it into a collapsed
strip at the bottom — `1 done today ▾`. Tap to reopen it, and un-tick anything
you ticked by mistake. Skipped work goes there too, but the label keeps them
apart (`2 done · 1 skipped`) rather than pretending a skip was a completion.

**Unfinished work follows you.** Anything still open at the end of the day
appears on tomorrow's list tagged *moved once*, then *moved 2×*, and so on.
That tag is deliberate. A task on its fourth day usually means it was too big
or it's blocked on someone, and both are worth saying out loud.

**History** is the link at the top. Pick any past day and see it as it ended:
what got done, what was skipped and why, what each actually took.

Past days are **read-only**. The daily report has already gone out with those
numbers, and letting someone re-tick Tuesday on Thursday would mean the email
and the app disagree about what happened. Today stays editable all day, so
there is plenty of room to fix a mis-tap.

A day also shows work that was *carried out* of it, marked `carried to another
day`. Without that, a day you planned three things and finished two would look
like you only ever planned two.

After a week, anything untouched is retired automatically. Coming back from
leave shouldn't mean forty stale tasks.

---

## For an admin

**Plans** tab: a card per person for any chosen day, showing what they've
planned and what you've assigned.

- Type into **Assign a task…** and it lands on their plan, tagged with your name
- **×** withdraws something you assigned
- You can't touch a task they added themselves — that list is theirs
- You can't assign into a day that has passed

**When you over-assign, it says so.** Stack more than about five hours of work
onto one person and you get told at the moment you do it, not at review time.
Nothing is blocked; you just can't do it unknowingly. Change the threshold with
`REALISTIC_DAY_MINUTES` if five hours is wrong for your teams.

**On the Overview tab**, each card now says *Planned 4h, logged 2h 40m — a bit
under what they planned*, and names any task that keeps sliding to tomorrow.

---

## What the numbers mean

**Planned vs logged is the useful pair.** Either number alone misleads: logged
time with no plan says nothing about whether the right work happened, and a
plan with no logged time says nothing about whether any of it did.

**"Done" is self-reported.** Anyone can tick a task in two seconds without
touching the timer. That's not worth policing — but it does mean the done count
alone isn't evidence, which is why the dashboard always shows it beside logged
time rather than as a score.

**Someone who plans but never starts the timer still appears**, marked *No timer
use* with no score. Silently dropping them off the dashboard would hide exactly
the person worth asking about.

**Skipped work is excluded from planned totals.** It was explicitly dropped
with a reason, not quietly missed, so counting it as a shortfall would be
unfair.

---

## Deliberately not included

No subtasks, projects, priorities, due dates or comments. Each is a step toward
being a worse Asana, and the reason to use this is the tie between the plan and
real focus time. They're easy to add later and hard to remove.

---

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `REALISTIC_DAY_MINUTES` | `300` | When an admin gets the over-assignment warning |
| `MAX_ROLLOVER_DAYS` | `7` | How long an untouched task keeps moving forward |

Both go in the service file as `Environment=` lines if you want to change them.

---

## Tests

`node test-planner.js` — 33 checks: carry-over across days and its cap,
assigned-vs-personal permissions, over-assignment, planned-vs-actual maths,
tenant isolation.

`node test-ui.js` — 13 checks rendering both screens against a live server:
tags, escaping, which buttons appear on which rows, the overload badge.

`npm test` runs everything: 117 checks.
