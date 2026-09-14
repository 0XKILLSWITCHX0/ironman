# Ironman Training Plan

Full-distance Ironman training calendar, generated as an .ics feed.

- Target: Full Ironman (3.8km swim / 180km bike / 42.2km run), race day is the
  Sunday of week 52 from `CONFIG.startMonday` in `generate-ics.js`.
- Weekly pattern: Gym 3x (Mon/Wed/Fri, before 8AM) · Bike 3x (Wed/Fri evening
  intervals after 5PM + Saturday long ride) · Run 3x (Tue/Thu evening + Sunday
  long run) · Swim 1x (Monday evening, kept easy/fun).
- Periodized: base -> build1 -> build2 -> peak -> taper -> race week, with a
  recovery week every 4th week.

## Subscribe in Apple Calendar

Calendar app -> File -> New Calendar Subscription -> paste:

```
webcal://raw.githubusercontent.com/<github-user>/ironman/main/ironman.ics
```

Set refresh to "Every day" in the subscription settings so updates pull in
automatically — no re-downloading, no re-adding.

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
