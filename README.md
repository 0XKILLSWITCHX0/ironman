# Ironman Training Plan

Full-distance Ironman training calendar, generated as an .ics feed.

- Target: Full Ironman (3.8km swim / 180km bike / 42.2km run), race day is the
  Sunday of week 52 from `CONFIG.startMonday` in `generate-ics.js`.
- Weekly pattern: Gym 3x (Mon/Wed/Fri, before 8AM) · Bike 3x (Wed/Fri evening
  intervals after 5PM + Saturday long ride) · Run 3x (Tue/Thu evening + Sunday
  long run) · Swim 1x (Monday evening, kept easy/fun).
- Periodized: base -> build1 -> build2 -> peak -> taper -> race week, with a
  recovery week every 4th week.
- Every gym day includes a midsection finisher (obliques/abs/chest). This
  builds and tightens the muscle — it does not spot-reduce fat; visible
  change there comes from overall body-fat drop (nutrition), not exercise
  selection.
- Sessions auto-shift around your Frankfurt School class schedule (see
  below) — anything that would overlap a class gets moved within its
  allowed time window, or flagged "⚠️ CLASS CONFLICT" if no slot works.

## Subscribe in Apple Calendar

Calendar app -> File -> New Calendar Subscription -> paste:

```
webcal://raw.githubusercontent.com/<github-user>/ironman/main/ironman.ics
```

Set refresh to "Every day" in the subscription settings so updates pull in
automatically — no re-downloading, no re-adding.

## Class-conflict avoidance (one-time setup)

Your Canvas class feed URL contains a personal access token — it is never
committed to this (public) repo. Set it up locally once:

```
cp .env.example .env
# edit .env, set CLASS_ICS_URL=<your Canvas ics feed URL>
./fetch-classes.sh   # writes classes.ics (gitignored)
node generate-ics.js
```

`generate-ics.js` reads `classes.ics` if present and shifts any training
session that overlaps a real class to the nearest free slot within its
allowed window (gym stays before 8AM, bike/run intervals stay in the evening,
long weekend sessions stay within a wide daytime window). If no slot works,
the event is flagged `⚠️ CLASS CONFLICT` in both title and description
instead of guessing.

Whenever your class schedule changes, re-run `./fetch-classes.sh` then
`node generate-ics.js` and push.

## Updating the plan

Edit `generate-ics.js` (durations, days, race date, phase lengths), then:

```
node generate-ics.js
git add ironman.ics
git commit -m "update plan"
git push
```

Event UIDs are stable per week/day/slot, so edits update existing calendar
entries instead of creating duplicates. Apple Calendar picks up the change on
its next scheduled refresh (or force it: right-click the calendar -> Refresh).
