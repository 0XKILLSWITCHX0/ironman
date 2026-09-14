#!/usr/bin/env node
// Generates ironman.ics — full year, periodized Ironman training plan.
// Re-run after editing CONFIG below, then `git commit && git push`.
// Stable UIDs (per week/day/slot) mean edits UPDATE existing calendar
// events instead of duplicating them.

const fs = require('fs');

const CONFIG = {
  startMonday: '2026-09-14', // first Monday of the plan
  raceSundayWeek: 52,        // Ironman race day = Sunday of this week
  calName: 'Ironman Training Plan',
};

// ---- phase model -----------------------------------------------------
// base(1-16) -> build1(17-28) -> build2(29-40) -> peak(41-48) -> taper(49-51) -> race(52)
function phaseOf(week) {
  if (week <= 16) return { name: 'base', local: week, len: 16 };
  if (week <= 28) return { name: 'build1', local: week - 16, len: 12 };
  if (week <= 40) return { name: 'build2', local: week - 28, len: 12 };
  if (week <= 48) return { name: 'peak', local: week - 40, len: 8 };
  if (week <= 51) return { name: 'taper', local: week - 48, len: 3 };
  return { name: 'race', local: 1, len: 1 };
}

function lerp(start, end, local, len) {
  if (len <= 1) return end;
  return start + (end - start) * ((local - 1) / (len - 1));
}

function isDeload(week) {
  return week % 4 === 0 && week <= 48;
}

// duration ranges (minutes) per phase, by session type
const RANGES = {
  gym:        { base: [45, 55], build1: [40, 50], build2: [35, 45], peak: [25, 35], taper: [20, 25] },
  swim:       { base: [45, 60], build1: [60, 75], build2: [75, 90], peak: [85, 90], taper: [30, 45] },
  bikeInt:    { base: [45, 60], build1: [60, 75], build2: [75, 90], peak: [90, 75], taper: [30, 45] },
  bikeLong:   { base: [90, 180], build1: [180, 270], build2: [270, 390], peak: [390, 300], taper: [180, 60] },
  runInt:     { base: [30, 45], build1: [45, 55], build2: [55, 65], peak: [65, 50], taper: [20, 30] },
  runLong:    { base: [45, 90], build1: [90, 120], build2: [120, 165], peak: [165, 120], taper: [90, 45] },
};

function minutesFor(type, week) {
  const { name, local, len } = phaseOf(week);
  if (name === 'race') return 0;
  const [start, end] = RANGES[type][name];
  let mins = lerp(start, end, local, len);
  if (isDeload(week)) {
    mins *= (type === 'bikeLong' || type === 'runLong') ? 0.6 : 0.8;
  }
  return Math.round(mins / 5) * 5;
}

const DESCRIPTIONS = {
  gym: 'Full-body strength: compound lifts (squat, deadlift, press, row) + core/stability. Base phase = hypertrophy (3x8-10). Build/Peak = power + single-leg/injury-proofing (3x4-6, plyo). Keep it short and crisp before work — this protects your run/bike volume, not compete with it.',
  swim: 'Easy, technique-first swim. Your fun session — drills + relaxed continuous swimming, build toward race-pace continuous efforts as the year goes. No need to hammer; smooth > fast.',
  bikeInt: 'Evening quality ride: warm up 10min, then tempo/threshold intervals, cool down. Effort by feel (RPE) since it is dark/indoor-trainer-friendly territory.',
  bikeLong: 'Weekly long ride — the single most important IM-bike session. Steady aerobic pace (conversational), practice race nutrition (carbs/hour) and aero position. Scheduled midday since duration exceeds the evening window.',
  runInt: 'Evening quality run: easy or hills/strides depending on the week — keep effort controlled, this is not a race.',
  runLong: 'Weekly long run — steady aerobic effort, practice nutrition and race-day shoes/kit. Midday/morning slot for daylight and safety on longer efforts.',
};

const TITLES = {
  gym: 'Gym — Strength',
  swim: 'Swim (fun session)',
  bikeInt: 'Bike — Intervals',
  bikeLong: 'Long Ride',
  runInt: 'Run — Quality',
  runLong: 'Long Run',
};

// ---- date helpers (floating local time, no TZID — always shows at
// wall-clock time in whatever timezone the calendar app is set to) ----
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d;
}
function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function dtLocal(dateObj, hh, mm) {
  const p = (n) => String(n).padStart(2, '0');
  return `${fmtDate(dateObj)}T${p(hh)}${p(mm)}00`;
}
function addMinutes(dateObj, hh, mm, durationMin) {
  const start = new Date(dateObj);
  start.setHours(hh, mm, 0, 0);
  const end = new Date(start.getTime() + durationMin * 60000);
  return { hh: end.getHours(), mm: end.getMinutes(), dayShift: fmtDate(end) !== fmtDate(start) ? end : null };
}

function escapeText(s) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function vevent({ uid, day, hh, mm, durationMin, summary, description }) {
  const startEnd = addMinutes(day, hh, mm, durationMin);
  const dtstart = dtLocal(day, hh, mm);
  const endDay = startEnd.dayShift || day;
  const dtend = dtLocal(endDay, startEnd.hh, startEnd.mm);
  const now = new Date();
  const dtstamp = `${fmtDate(now)}T${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}00Z`;
  return [
    'BEGIN:VEVENT',
    `UID:${uid}@ironman-plan`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    'END:VEVENT',
  ].join('\r\n');
}

function buildEvents() {
  const events = [];

  for (let week = 1; week <= CONFIG.raceSundayWeek; week++) {
    const monday = addDays(CONFIG.startMonday, (week - 1) * 7);
    const phase = phaseOf(week).name;
    const weekTag = isDeload(week) ? ' [recovery week]' : '';

    if (phase === 'race') {
      const sunday = addDays(CONFIG.startMonday, (week - 1) * 7 + 6);
      // light taper days Mon-Sat, then race Sunday
      events.push(vevent({
        uid: `w${week}-mon-swim`, day: monday, hh: 7, mm: 0, durationMin: 15,
        summary: 'Shakeout Swim (race week)', description: 'Very easy, a few hundred meters, loosen up. Race is Sunday.',
      }));
      events.push(vevent({
        uid: `w${week}-wed-bike`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 2), hh: 17, mm: 30, durationMin: 20,
        summary: 'Shakeout Spin (race week)', description: 'Easy spin, a few openers at race pace. Keep legs fresh.',
      }));
      events.push(vevent({
        uid: `w${week}-thu-run`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 3), hh: 18, mm: 0, durationMin: 15,
        summary: 'Shakeout Run (race week)', description: 'Very easy jog + strides. Race is Sunday — rest is the workout now.',
      }));
      events.push(vevent({
        uid: `w${week}-sun-race`, day: sunday, hh: 6, mm: 30, durationMin: 16 * 60,
        summary: 'IRONMAN — RACE DAY 🏁', description: '3.8km swim / 180km bike / 42.2km run. Trust the training. Nutrition plan, pacing plan, gear laid out night before.',
      }));
      continue;
    }

    events.push(vevent({
      uid: `w${week}-mon-gym`, day: monday, hh: 6, mm: 30, durationMin: minutesFor('gym', week),
      summary: TITLES.gym + weekTag, description: DESCRIPTIONS.gym,
    }));
    events.push(vevent({
      uid: `w${week}-mon-swim`, day: monday, hh: 18, mm: 0, durationMin: minutesFor('swim', week),
      summary: TITLES.swim + weekTag, description: DESCRIPTIONS.swim,
    }));
    events.push(vevent({
      uid: `w${week}-tue-run`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 1), hh: 18, mm: 0, durationMin: minutesFor('runInt', week),
      summary: TITLES.runInt + weekTag, description: DESCRIPTIONS.runInt,
    }));
    events.push(vevent({
      uid: `w${week}-wed-gym`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 2), hh: 6, mm: 30, durationMin: minutesFor('gym', week),
      summary: TITLES.gym + weekTag, description: DESCRIPTIONS.gym,
    }));
    events.push(vevent({
      uid: `w${week}-wed-bike`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 2), hh: 17, mm: 30, durationMin: minutesFor('bikeInt', week),
      summary: TITLES.bikeInt + weekTag, description: DESCRIPTIONS.bikeInt,
    }));
    events.push(vevent({
      uid: `w${week}-thu-run`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 3), hh: 18, mm: 0, durationMin: minutesFor('runInt', week),
      summary: TITLES.runInt + weekTag, description: DESCRIPTIONS.runInt,
    }));
    events.push(vevent({
      uid: `w${week}-fri-gym`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 4), hh: 6, mm: 30, durationMin: minutesFor('gym', week),
      summary: TITLES.gym + weekTag, description: DESCRIPTIONS.gym,
    }));
    events.push(vevent({
      uid: `w${week}-fri-bike`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 4), hh: 17, mm: 30, durationMin: minutesFor('bikeInt', week),
      summary: TITLES.bikeInt + weekTag, description: DESCRIPTIONS.bikeInt,
    }));
    events.push(vevent({
      uid: `w${week}-sat-bike`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 5), hh: 7, mm: 0, durationMin: minutesFor('bikeLong', week),
      summary: TITLES.bikeLong + weekTag, description: DESCRIPTIONS.bikeLong,
    }));
    events.push(vevent({
      uid: `w${week}-sun-run`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 6), hh: 7, mm: 30, durationMin: minutesFor('runLong', week),
      summary: TITLES.runLong + weekTag, description: DESCRIPTIONS.runLong,
    }));
  }

  return events;
}

function buildIcs() {
  const events = buildEvents();
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ironman Training Plan//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${CONFIG.calName}`,
    'REFRESH-INTERVAL;VALUE=DURATION:P1D',
    'X-PUBLISHED-TTL:P1D',
    ...events,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

fs.writeFileSync('ironman.ics', buildIcs());
console.log('Wrote ironman.ics');
