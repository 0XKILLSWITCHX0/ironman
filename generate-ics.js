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

// current baseline paces (from your recent test efforts) — used to turn
// duration-based sessions into concrete distance estimates. Real distance
// will grow as fitness improves; duration/effort is what's prescribed,
// distance is just a helpful estimate.
const BASELINE = {
  bikeKmh: 112 / 5,          // 22.4 km/h
  swimMPerMin: 1500 / 70,    // ~21.4 m/min
  runMinPerKm: 40 / 5,       // 8 min/km
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
  gym:        { base: [55, 65], build1: [50, 60], build2: [45, 55], peak: [30, 40], taper: [20, 25] },
  swim:       { base: [45, 60], build1: [60, 75], build2: [75, 90], peak: [85, 90], taper: [30, 45] },
  swim2:      { build1: [30, 35], build2: [35, 40] }, // second, easy build-phase swim
  bikeInt:    { base: [45, 60], build1: [60, 75], build2: [75, 90], peak: [90, 75], taper: [30, 45] },
  bikeLong:   { base: [90, 180], build1: [180, 270], build2: [270, 390], peak: [390, 300], taper: [180, 60] },
  runInt:     { base: [30, 45], build1: [45, 55], build2: [55, 65], peak: [65, 50], taper: [20, 30] },
  runLong:    { base: [45, 90], build1: [90, 120], build2: [120, 165], peak: [165, 120], taper: [90, 45] },
};

function minutesFor(type, week) {
  const { name, local, len } = phaseOf(week);
  if (name === 'race') return 0;
  const range = RANGES[type][name];
  if (!range) return 0;
  const [start, end] = range;
  let mins = lerp(start, end, local, len);
  if (isDeload(week)) {
    mins *= (type === 'bikeLong' || type === 'runLong') ? 0.6 : 0.8;
  }
  return Math.round(mins / 5) * 5;
}

// ---- gym: named exercises + sets/reps + RPE per day-slot and phase ----
// Load is prescribed by RPE / reps-in-reserve (RIR), not kg — there's no
// 1RM/strength-test data to base absolute weights on, and RPE-based load
// self-corrects as you get stronger instead of going stale. Practically:
// pick a weight where the LAST rep of the LAST set feels like the stated
// RPE (RPE8 = could do ~2 more reps; RPE7 = could do ~3 more).
const GYM = {
  A: { // Monday — lower body / posterior chain
    base:   'Back Squat 3x8, Romanian Deadlift 3x8, Walking Lunge 3x10/leg, Plank 3x45s — RPE 7 (3 reps in reserve).',
    build1: 'Back Squat 4x6, Romanian Deadlift 3x6, Bulgarian Split Squat 3x8/leg, Pallof Press 3x12/side — RPE 7-8.',
    build2: 'Trap-bar Deadlift 4x5, Loaded Box Step-up 3x6/leg, Single-leg RDL 3x8/leg, Hanging Knee Raise 3x12 — RPE 8.',
    peak:   'Back Squat 2x5 (moderate) + Box Jump 3x3 (power/explosive), single-leg balance work, light core — RPE 6-7, low volume.',
    taper:  'Bodyweight squats, hip mobility, light activation only. No loaded lifting this close to race.',
  },
  B: { // Wednesday — upper body / pull + core
    base:   'Bench Press 3x8, Bent-over Row 3x8, Overhead Press 3x10, Pallof Press 3x12/side — RPE 7.',
    build1: 'Incline Press 3x6, Pull-up/Lat Pulldown 3x6-8, Single-arm DB Row 3x8/side, Side Plank 3x30s/side — RPE 7-8.',
    build2: 'Push Press 4x5, Weighted Pull-up 3x5, Face Pull 3x12, Anti-rotation Core Press 3x10 — RPE 8.',
    peak:   'Push Press 2x5 + Med-ball Chest Pass 3x5 (power), light row, core maintenance — RPE 6-7.',
    taper:  'Band pull-aparts, shoulder/thoracic mobility, activation only.',
  },
  C: { // Friday — full body / power / injury-proofing
    base:   'Goblet Squat 3x10, Deadlift 3x8, Step-up 3x10/leg, Core circuit (dead bug, bird-dog) — RPE 7.',
    build1: 'Front Squat 3x6, Single-leg RDL 3x8/leg, Broad Jump 3x5, Core circuit — RPE 7-8.',
    build2: 'Trap-bar Jump Squat 4x4 (power), Loaded Bulgarian Split Squat 3x6/leg, Box Jump 3x5, Core circuit — RPE 8.',
    peak:   'Jump Squat 2x3 (low volume power), single-leg balance/proprioception, ankle/calf mobility — RPE 6.',
    taper:  'Mobility and activation only. No heavy loading.',
  },
};

// Midsection/chest finisher, appended to every gym day. Note: this builds
// and tightens the muscle under the fat (obliques, rectus abdominis, chest)
// — it does not spot-reduce belly/love-handle fat. Visible change there
// comes from overall body-fat drop (nutrition + the training volume you're
// already doing), not from which muscle you isolate.
const CORE = {
  A: { // paired with lower-body day — lower-ab / anti-extension focus
    base:   'Finisher: Hanging Knee Raise 3x12, Side Plank 3x30s/side.',
    build1: 'Finisher: Hanging Leg Raise 3x10, Cable Woodchopper 3x12/side (obliques).',
    build2: 'Finisher: Weighted Hanging Leg Raise 3x8, Ab Wheel Rollout 3x8.',
    peak:   'Finisher: Hollow Body Hold 3x30s, Pallof Press 2x12/side (maintenance).',
    taper:  'Finisher: Dead Bug 2x10/side, easy stretching. Keep it light.',
  },
  B: { // paired with upper-body day — chest + oblique focus
    base:   'Finisher: Incline DB Press 3x10 (chest), Russian Twist 3x20, Side Plank 3x30s/side.',
    build1: 'Finisher: Cable Flye 3x12 (chest), Weighted Russian Twist 3x16, Suitcase Carry 3x20m/side.',
    build2: 'Finisher: Incline DB Press 3x8 (chest), Landmine Rotation 3x10/side, Ab Wheel Rollout 3x8.',
    peak:   'Finisher: DB Flye 2x12 (light, maintenance), Side Plank 2x30s/side.',
    taper:  'Finisher: light chest band activation, easy stretching.',
  },
  C: { // paired with full-body day — rotational / full core focus
    base:   'Finisher: Cable Woodchopper 3x12/side, Reverse Crunch 3x15.',
    build1: 'Finisher: Med-ball Rotational Throw 3x8/side, Hanging Leg Raise 3x10.',
    build2: 'Finisher: Landmine Rotation 3x10/side, Weighted Plank 3x40s.',
    peak:   'Finisher: Pallof Press 2x12/side, Hollow Hold 2x30s (maintenance).',
    taper:  'Finisher: easy core activation + mobility.',
  },
};

function gymText(dayLetter, phase) {
  const work = GYM[dayLetter][phase] || GYM[dayLetter].taper;
  const core = CORE[dayLetter][phase] || CORE[dayLetter].taper;
  return `${work} ${core} Load = RPE/reps-in-reserve, not a fixed kg — pick a weight where the last rep of the last set matches the stated RPE (no 1RM on file, this self-corrects as you get stronger).`;
}

// ---- endurance session prescriptions (structure + computed distance) --
function swimText(phase, totalMinutes) {
  const totalMeters = Math.round((totalMinutes * BASELINE.swimMPerMin) / 50) * 50;
  const plan = {
    base:   { rep: 50, rest: '20s', effort: 'easy, focus on technique (catch, rotation, breathing)' },
    build1: { rep: 100, rest: '20s', effort: 'steady, moderate effort' },
    build2: { rep: 100, rest: '15s', effort: 'strong effort, race-pace feel' },
    peak:   { rep: 200, rest: '10s', effort: 'continuous, race-pace' },
    taper:  { rep: 50, rest: '30s', effort: 'very easy, shake the legs/arms out' },
  }[phase];
  const mainMeters = Math.max(totalMeters - 300, plan.rep);
  const reps = Math.max(1, Math.round(mainMeters / plan.rep));
  return `Warm-up 200m easy + drills (catch-up, fist swim). Main set: ${reps}x${plan.rep}m @ ${plan.effort}, ${plan.rest} rest. Cool-down 100m easy. ~${totalMeters}m total (est. from your current ~${Math.round(BASELINE.swimMPerMin * 10) / 10}m/min pace).`;
}

function bikeIntText(phase, totalMinutes) {
  const structure = {
    base:   'Warm-up 10min easy. Main: 4x5min @ tempo (RPE 6-7), 3min easy spin between. Cool-down 10min.',
    build1: 'Warm-up 10min easy. Main: 6x4min @ threshold (RPE 7-8), 3min easy spin between. Cool-down.',
    build2: 'Warm-up 10min easy. Main: 5x8min @ threshold/race-power (RPE 8), 4min easy spin between. Cool-down.',
    peak:   'Warm-up 10min easy. Main: 3x12min @ goal IM race-power/pace (RPE 7), 5min easy between — dial in aero position + nutrition. Cool-down.',
    taper:  'Easy spin, then 4x1min @ race-pace openers, plenty of easy spin between. Legs should feel fresh after, not tired.',
  }[phase];
  const km = Math.round(totalMinutes / 60 * BASELINE.bikeKmh);
  return `${structure} ~${km}km at current pace.`;
}

function bikeLongText(phase, totalMinutes) {
  const structure = {
    base:   'Steady aerobic, fully conversational pace (RPE 4-5). Start practicing 60g carbs/hour + 500ml fluid/hour.',
    build1: 'Steady aerobic (RPE 4-5), last 20min @ tempo (RPE 6). 60-90g carbs/hour, sip fluids/electrolytes throughout.',
    build2: 'Steady aerobic with 2x20min @ goal race-power (RPE 7) mid-ride, rest easy. Full nutrition rehearsal: 60-90g carbs/hr, 500-750ml fluid/hr — same fuel you will use on race day.',
    peak:   'Race-simulation ride: last 60min @ goal IM bike power/pace. Full kit + nutrition dress rehearsal, aero position focus.',
    taper:  'Easy steady spin only, no intensity, no experiments. Legs stay fresh.',
  }[phase];
  const km = Math.round(totalMinutes / 60 * BASELINE.bikeKmh);
  return `${structure} ~${km}km at current pace (will be more as fitness improves — ride by time/effort, not a fixed distance).`;
}

function runIntText(phase) {
  return {
    base:   'Warm-up 10min easy. Main: 6x2min @ tempo (RPE 6-7), 2min easy jog between. Cool-down 5min.',
    build1: 'Warm-up 10min easy. Main: 5x4min @ threshold (RPE 7-8), 2min easy jog between. Cool-down.',
    build2: 'Warm-up 10min easy. Main: 4x6min @ threshold/race-pace (RPE 8), 90s jog between. Cool-down.',
    peak:   'Warm-up 10min easy. Main: 3x10min @ goal IM-run pace (RPE 7), 3min jog between. Cool-down.',
    taper:  'Easy jog throughout, then 4x20s relaxed strides. Should feel effortless.',
  }[phase];
}

function runLongText(phase, totalMinutes) {
  const structure = {
    base:   'Steady, fully conversational pace (RPE 4-5). Comfortable shoes, no gear testing yet.',
    build1: 'Steady (RPE 4-5), last 15min @ tempo (RPE 6).',
    build2: 'Steady with 20min @ goal IM-run pace mid-run (RPE 7), rest easy. Practice race nutrition + the shoes/kit you plan to race in.',
    peak:   'Race-simulation block: last 30-40min @ goal IM-run pace. Full nutrition + kit dress rehearsal — this is the closest thing to race day before race day.',
    taper:  'Easy and short, no intensity. Legs stay fresh, not tired.',
  }[phase];
  const km = Math.round((totalMinutes / BASELINE.runMinPerKm) * 10) / 10;
  return `${structure} ~${km}km at current pace (will be more as fitness improves — run by time/effort).`;
}

const TITLES = {
  gym: 'Gym — Strength',
  swim: 'Swim (fun session)',
  swim2: 'Swim (easy, 2nd session)',
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

    const gymMin = minutesFor('gym', week);
    const swimMin = minutesFor('swim', week);
    const bikeIntMin = minutesFor('bikeInt', week);
    const bikeLongMin = minutesFor('bikeLong', week);
    const runIntMin = minutesFor('runInt', week);
    const runLongMin = minutesFor('runLong', week);

    events.push(vevent({
      uid: `w${week}-mon-gym`, day: monday, hh: 6, mm: 30, durationMin: gymMin,
      summary: TITLES.gym + weekTag, description: gymText('A', phase),
    }));
    events.push(vevent({
      uid: `w${week}-mon-swim`, day: monday, hh: 18, mm: 0, durationMin: swimMin,
      summary: TITLES.swim + weekTag, description: swimText(phase, swimMin),
    }));
    events.push(vevent({
      uid: `w${week}-tue-run`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 1), hh: 18, mm: 0, durationMin: runIntMin,
      summary: TITLES.runInt + weekTag, description: runIntText(phase),
    }));
    events.push(vevent({
      uid: `w${week}-wed-gym`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 2), hh: 6, mm: 30, durationMin: gymMin,
      summary: TITLES.gym + weekTag, description: gymText('B', phase),
    }));
    events.push(vevent({
      uid: `w${week}-wed-bike`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 2), hh: 17, mm: 30, durationMin: bikeIntMin,
      summary: TITLES.bikeInt + weekTag, description: bikeIntText(phase, bikeIntMin),
    }));

    // second, easy swim during build phase only
    if (phase === 'build1' || phase === 'build2') {
      const swim2Min = minutesFor('swim2', week);
      events.push(vevent({
        uid: `w${week}-thu-swim`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 3), hh: 6, mm: 45, durationMin: swim2Min,
        summary: TITLES.swim2 + weekTag,
        description: `Easy technique swim, separate from Monday's session — keeps swim frequency up without adding fatigue. ${swimText('base', swim2Min)}`,
      }));
    }

    events.push(vevent({
      uid: `w${week}-thu-run`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 3), hh: 18, mm: 0, durationMin: runIntMin,
      summary: TITLES.runInt + weekTag, description: runIntText(phase),
    }));
    events.push(vevent({
      uid: `w${week}-fri-gym`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 4), hh: 6, mm: 30, durationMin: gymMin,
      summary: TITLES.gym + weekTag, description: gymText('C', phase),
    }));
    events.push(vevent({
      uid: `w${week}-fri-bike`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 4), hh: 17, mm: 30, durationMin: bikeIntMin,
      summary: TITLES.bikeInt + weekTag, description: bikeIntText(phase, bikeIntMin),
    }));
    events.push(vevent({
      uid: `w${week}-sat-bike`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 5), hh: 7, mm: 0, durationMin: bikeLongMin,
      summary: TITLES.bikeLong + weekTag, description: bikeLongText(phase, bikeLongMin),
    }));
    events.push(vevent({
      uid: `w${week}-sun-run`, day: addDays(CONFIG.startMonday, (week - 1) * 7 + 6), hh: 7, mm: 30, durationMin: runLongMin,
      summary: TITLES.runLong + weekTag, description: runLongText(phase, runLongMin),
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
