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

// ---- class-feed conflict avoidance ------------------------------------
// classes.ics is fetched locally via fetch-classes.sh (gitignored — the
// Canvas URL carries a personal token, never committed). If it's missing,
// training just generates with no conflict checks, same as before.
const BERLIN_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function icsUtcToDate(s) {
  // s = YYYYMMDDTHHMMSSZ
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)));
}

function berlinParts(date) {
  const parts = BERLIN_FMT.formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { dateStr: `${get('year')}${get('month')}${get('day')}`, minutes: (+get('hour')) * 60 + (+get('minute')) };
}

function parseClasses(path) {
  const busy = new Map();
  if (!fs.existsSync(path)) return busy;
  const unfolded = fs.readFileSync(path, 'utf8').replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const startMatch = block.match(/DTSTART(?:;[^:\n]*)?:(\d{8}T\d{6}Z)/);
    const endMatch = block.match(/DTEND(?:;[^:\n]*)?:(\d{8}T\d{6}Z)/);
    if (!startMatch || !endMatch) continue; // skip all-day / VALUE=DATE entries
    const start = berlinParts(icsUtcToDate(startMatch[1]));
    const end = berlinParts(icsUtcToDate(endMatch[1]));
    if (start.dateStr !== end.dateStr) continue; // skip multi-day spans
    const list = busy.get(start.dateStr) || [];
    list.push([start.minutes, end.minutes]);
    busy.set(start.dateStr, list);
  }
  return busy;
}

const CLASS_BUSY = parseClasses('classes.ics');
if (CLASS_BUSY.size === 0) {
  console.log('No classes.ics found (or empty) — run ./fetch-classes.sh to enable class-conflict avoidance.');
} else {
  console.log(`Loaded class schedule: ${CLASS_BUSY.size} days with classes.`);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// search outward from the desired time for a free slot within [minMin,maxMin)
function resolveSlot(dateStr, desiredMin, durationMin, minMin, maxMin, step = 15) {
  const busy = CLASS_BUSY.get(dateStr) || [];
  const isFree = (start) => {
    const end = start + durationMin;
    if (start < minMin || end > maxMin) return false;
    return !busy.some(([bs, be]) => overlaps(start, end, bs, be));
  };
  if (isFree(desiredMin)) return { minutes: desiredMin, moved: false };
  const candidates = [];
  for (let t = desiredMin + step; t + durationMin <= maxMin; t += step) candidates.push(t);
  for (let t = desiredMin - step; t >= minMin; t -= step) candidates.push(t);
  for (const t of candidates) {
    if (isFree(t)) return { minutes: t, moved: true };
  }
  return null; // no free slot in the allowed window
}

// per-type allowed windows for auto-shifting around classes
const BOUNDS = {
  gym:      { minMin: 5 * 60 + 30, maxMin: 8 * 60 },       // must stay before 8AM
  swim:     { minMin: 17 * 60, maxMin: 22 * 60 },
  swim2:    { minMin: 6 * 60, maxMin: 8 * 60 },
  runInt:   { minMin: 17 * 60, maxMin: 22 * 60 },           // must stay after 5PM-ish evening window
  bikeInt:  { minMin: 17 * 60, maxMin: 22 * 60 },           // must stay after 5PM
  bikeLong: { minMin: 6 * 60, maxMin: 20 * 60 },
  runLong:  { minMin: 6 * 60, maxMin: 20 * 60 },
};

// resolves (hh,mm) around any class on that date; returns a description
// suffix explaining a shift or flagging an unresolved conflict.
function placeSession(type, dateObj, desiredHH, desiredMM, durationMin) {
  const dateStr = fmtDate(dateObj);
  const { minMin, maxMin } = BOUNDS[type];
  const desiredMin = desiredHH * 60 + desiredMM;
  const result = resolveSlot(dateStr, desiredMin, durationMin, minMin, maxMin);
  const original = `${String(desiredHH).padStart(2, '0')}:${String(desiredMM).padStart(2, '0')}`;
  if (!result) {
    return { hh: desiredHH, mm: desiredMM, tag: ' ⚠️ CLASS CONFLICT', suffix: `⚠️ CLASS CONFLICT: overlaps a class and no free slot was found in the allowed window — reschedule manually.` };
  }
  const hh = Math.floor(result.minutes / 60);
  const mm = result.minutes % 60;
  if (!result.moved) return { hh, mm, tag: '', suffix: '' };
  return { hh, mm, tag: ' (moved)', suffix: `Shifted from ${original} to avoid a class.` };
}

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
  let conflictCount = 0;

  // pushes one session, auto-shifted around any class on that date
  function push(type, uid, day, desiredHH, desiredMM, durationMin, title, description) {
    const placed = placeSession(type, day, desiredHH, desiredMM, durationMin);
    if (placed.tag === ' ⚠️ CLASS CONFLICT') conflictCount++;
    events.push(vevent({
      uid, day, hh: placed.hh, mm: placed.mm, durationMin,
      summary: title + placed.tag,
      description: placed.suffix ? `${description} [${placed.suffix}]` : description,
    }));
  }

  for (let week = 1; week <= CONFIG.raceSundayWeek; week++) {
    const monday = addDays(CONFIG.startMonday, (week - 1) * 7);
    const tue = addDays(CONFIG.startMonday, (week - 1) * 7 + 1);
    const wed = addDays(CONFIG.startMonday, (week - 1) * 7 + 2);
    const thu = addDays(CONFIG.startMonday, (week - 1) * 7 + 3);
    const fri = addDays(CONFIG.startMonday, (week - 1) * 7 + 4);
    const sat = addDays(CONFIG.startMonday, (week - 1) * 7 + 5);
    const sun = addDays(CONFIG.startMonday, (week - 1) * 7 + 6);
    const phase = phaseOf(week).name;
    const weekTag = isDeload(week) ? ' [recovery week]' : '';

    if (phase === 'race') {
      push('swim2', `w${week}-mon-swim`, monday, 7, 0, 15, 'Shakeout Swim (race week)', 'Very easy, a few hundred meters, loosen up. Race is Sunday.');
      push('bikeInt', `w${week}-wed-bike`, wed, 17, 30, 20, 'Shakeout Spin (race week)', 'Easy spin, a few openers at race pace. Keep legs fresh.');
      push('runInt', `w${week}-thu-run`, thu, 18, 0, 15, 'Shakeout Run (race week)', 'Very easy jog + strides. Race is Sunday — rest is the workout now.');
      events.push(vevent({
        uid: `w${week}-sun-race`, day: sun, hh: 6, mm: 30, durationMin: 16 * 60,
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

    push('gym', `w${week}-mon-gym`, monday, 6, 30, gymMin, TITLES.gym + weekTag, gymText('A', phase));
    push('swim', `w${week}-mon-swim`, monday, 18, 0, swimMin, TITLES.swim + weekTag, swimText(phase, swimMin));
    push('runInt', `w${week}-tue-run`, tue, 18, 0, runIntMin, TITLES.runInt + weekTag, runIntText(phase));
    push('gym', `w${week}-wed-gym`, wed, 6, 30, gymMin, TITLES.gym + weekTag, gymText('B', phase));
    push('bikeInt', `w${week}-wed-bike`, wed, 17, 30, bikeIntMin, TITLES.bikeInt + weekTag, bikeIntText(phase, bikeIntMin));

    // second, easy swim during build phase only
    if (phase === 'build1' || phase === 'build2') {
      const swim2Min = minutesFor('swim2', week);
      push('swim2', `w${week}-thu-swim`, thu, 6, 45, swim2Min, TITLES.swim2 + weekTag,
        `Easy technique swim, separate from Monday's session — keeps swim frequency up without adding fatigue. ${swimText('base', swim2Min)}`);
    }

    push('runInt', `w${week}-thu-run`, thu, 18, 0, runIntMin, TITLES.runInt + weekTag, runIntText(phase));
    push('gym', `w${week}-fri-gym`, fri, 6, 30, gymMin, TITLES.gym + weekTag, gymText('C', phase));
    push('bikeInt', `w${week}-fri-bike`, fri, 17, 30, bikeIntMin, TITLES.bikeInt + weekTag, bikeIntText(phase, bikeIntMin));
    push('bikeLong', `w${week}-sat-bike`, sat, 7, 0, bikeLongMin, TITLES.bikeLong + weekTag, bikeLongText(phase, bikeLongMin));
    push('runLong', `w${week}-sun-run`, sun, 7, 30, runLongMin, TITLES.runLong + weekTag, runLongText(phase, runLongMin));
  }

  if (conflictCount > 0) {
    console.log(`${conflictCount} session(s) could not be auto-resolved around your classes — look for "⚠️ CLASS CONFLICT" in the calendar.`);
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
