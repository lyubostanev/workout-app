'use strict';
/* Home Gym Coach – PWA prototype. All data in localStorage. */
const $ = s => document.querySelector(s);
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
// Default plan: 3-day rotating split Push -> Pull -> Legs & Core (whole body covered across the 3 days). TRX and rower are OFF by default (rower malfunctioning).
// Kettlebells on hand: 2 x 25 lb + 1 x 35 lb (suggestions snap to these). No tempo counting (removed).
const DEFAULTS = { daysPerWeek: 3, minutes: 45, level: 'intermediate', voice: true, beeps: true,
  excluded: [], avoided: [], warmup: true, cooldown: true, trx: false, rower: false, kettlebells: [25, 25, 35],
  restSec: 60, restOverrides: {}, keepAwake: true, switchSec: 10, setupSec: 30 };  // restSec = 'Rest between rounds' (after both exercises of a pair); switchSec = A->B switch; setupSec = extra time between groups; restOverrides = per-exercise rest {id: seconds}
let settings = Object.assign({}, DEFAULTS, LS.get('gc_settings', {}));
delete settings.tempo; // tempo feature removed entirely
if (!Array.isArray(settings.avoided)) settings.avoided = [];
if (!settings.restOverrides || typeof settings.restOverrides !== 'object') settings.restOverrides = {};
if (!Array.isArray(settings.kettlebells) || !settings.kettlebells.length) settings.kettlebells = DEFAULTS.kettlebells.slice();
// Round rest is 60 s. Older saves (and the old "core gets half, min 30" rule) left this at 30.
if (!(+settings.restSec >= 60)) { settings.restSec = 60; LS.set('gc_settings', settings); }
if (!(+settings.setupSec >= 15)) { settings.setupSec = 30; LS.set('gc_settings', settings); }
let history = LS.get('gc_history', []);
let LIB = [];
let today = null;     // generated workout
let shuffleN = 0;

/* ---------- weekly splits ---------- */
// Each day = name + block patterns (categories per superset). Blocks repeat until time budget is filled.
const SPLITS = {
  3: [
    // Slot syntax 'category:muscle/muscle' -> prefers exercises whose PRIMARY muscle matches, then any listed muscle,
    // then anything in the category (so a missing piece of equipment never empties a slot).
    // Main blocks are filled in order (and repeat only if the time budget allows); the finisher is always last.
    { name: 'Push', short: 'Push', focus: 'Chest & upper chest · Front/side delts · Triceps',
      blocks: [['push:chest','push:side delts'],['push:upper chest','push:triceps'],['push:shoulders','push:chest'],['push:front delts','push:triceps']],
      finisher: ['conditioning','conditioning'], cooldown: ['ball-chest-stretch','foam-roll-tspine'],
      warmup: ['wu-arm-circles','wu-band-pull-apart','wu-scap-pushup','st-dyn-chest','st-triceps','wu-light-press'] },
    { name: 'Pull', short: 'Pull', focus: 'Back & lats · Rear delts · Traps · Biceps',
      blocks: [['pull:lats','pull:rear delts'],['pull:mid back','pull:biceps'],['pull:lats','pull:traps'],['pull:upper back/rear delts','pull:biceps']],
      finisher: ['conditioning','conditioning'], cooldown: ['foam-roll-tspine','cat-cow'],
      warmup: ['cat-cow','wu-band-pulldown','wu-scap-pull','wu-band-pull-apart','st-childs-pose','st-biceps'] },
    { name: 'Legs & Core', short: 'Legs', focus: 'Quads · Hams · Glutes · Calves · Glute med · Abs/obliques',
      blocks: [['legs:quads','core:abs'],['legs:hamstrings','legs:calves'],['legs:glutes','core:obliques'],['legs:glute med','core:lower abs/core/abs']],
      finisher: ['conditioning','conditioning'], cooldown: ['foam-roll-legs','cat-cow'],
      warmup: ['wu-hip-circles','wu-leg-swings','wu-glute-bridge','dead-bug','st-hip-flexor','st-hamstring','wu-bw-squat'] },
  ],
  4: [
    { name: 'Upper A', focus: 'Chest · Back · Shoulders', blocks: [['push','pull'],['push','pull'],['push','pull'],['core','core']] },
    { name: 'Lower A', focus: 'Quads · Glutes · Core', blocks: [['legs','core'],['legs','legs'],['legs','core'],['conditioning','conditioning']] },
    { name: 'Upper B', focus: 'Back · Arms · Shoulders', blocks: [['pull','push'],['pull','push'],['pull','push'],['core','conditioning']] },
    { name: 'Lower B + Conditioning', focus: 'Hamstrings · Glutes · Engine', blocks: [['legs','conditioning'],['legs','core'],['legs','conditioning'],['conditioning','core']] },
  ],
  5: [
    { name: 'Push', focus: 'Chest · Shoulders · Triceps', blocks: [['push','core'],['push','push'],['push','core'],['push','conditioning']] },
    { name: 'Pull', focus: 'Back · Biceps · Rear delts', blocks: [['pull','core'],['pull','pull'],['pull','core'],['pull','conditioning']] },
    { name: 'Legs', focus: 'Quads · Glutes · Hamstrings', blocks: [['legs','core'],['legs','legs'],['legs','core'],['legs','conditioning']] },
    { name: 'Upper Mix', focus: 'Push/Pull supersets', blocks: [['push','pull'],['push','pull'],['push','pull'],['core','core']] },
    { name: 'Engine', focus: 'Kettlebell · Conditioning · Full body', blocks: [['conditioning','legs'],['conditioning','pull'],['conditioning','push'],['conditioning','core']] },
  ],
};
const LEVEL = { beginner: { rounds: 2, w: 0.85, r: 1.25 }, intermediate: { rounds: 3, w: 1, r: 1 }, advanced: { rounds: 4, w: 1.1, r: 0.85 } };

/* ---------- seeded RNG ---------- */
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  return () => { h = Math.imul(h ^ h >>> 16, 2246822507); h = Math.imul(h ^ h >>> 13, 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
const dateKey = d => d.toLocaleDateString('en-CA'); // YYYY-MM-DD local

/* ---------- generator ---------- */
// Equipment switches: TRX and Rower have dedicated toggles (default OFF); other gear via the equipment list.
const switchedOff = e => (!settings.trx && e.equipment.includes('TRX')) || (!settings.rower && e.equipment.includes('rower'));
function available() { return LIB.filter(e => !switchedOff(e) && !settings.excluded.some(x => e.equipment.includes(x))); }
// Generation pool: equipment you have, minus exercises you've marked "avoid" (injury).
function genPool() { return available().filter(e => !settings.avoided.includes(e.id)); }
const byId = id => LIB.find(e => e.id === id);
/* Which split day a history row is. Matches dayIndex, the full name, the short label ("Legs"),
   and older rows that said "Legs" for "Legs & Core". A named row that matches nothing is ignored
   so it cannot be counted as a different day and leave Legs "up next". */
function dayIndexFromHistory(h, split) {
  const n = split.length;
  if (Number.isInteger(h.dayIndex) && h.dayIndex >= 0 && h.dayIndex < n) return h.dayIndex;
  const nm = String(h.day || '').replace(/ \(skipped\)$/, '').trim();
  if (!nm) return -1;
  let i = split.findIndex(d => d.name === nm || d.short === nm);
  if (i < 0) i = split.findIndex(d => (d.short && nm.toLowerCase() === d.short.toLowerCase()) || d.name.toLowerCase() === nm.toLowerCase());
  if (i < 0 && /^legs\b/i.test(nm)) i = split.findIndex(d => /^legs\b/i.test(d.name) || d.short === 'Legs');
  return i;
}
/* Training cycle: each day of the split once, in any order. Derived from history (day name / dayIndex; old entries
   without a day count as "next in order"). When every day is done the cycle resets. */
function cycleState() {
  const split = SPLITS[settings.daysPerWeek] || SPLITS[4], n = split.length; let done = [], last = -1;
  history.filter(h => h.split == null || h.split === settings.daysPerWeek).forEach(h => {
    let i = dayIndexFromHistory(h, split);
    if (i < 0) { if (String(h.day || '').trim()) return; i = (last + 1) % n; }
    if (!done.includes(i)) done.push(i); last = i;
    if (done.length >= n) done = [];
  });
  const order = [...Array(n).keys()].map(k => (last + 1 + k) % n), remaining = order.filter(i => !done.includes(i));
  return { n, done, last, remaining, next: remaining[0] ?? 0 };
}
// Day picked on the Today screen; valid until the next session is saved (or the split changes).
const pickSig = () => history.length + '|' + settings.daysPerWeek;
let dayPick = LS.get('gc_daypick', null);
function nextDayIndex() {
  const n = (SPLITS[settings.daysPerWeek] || SPLITS[4]).length;
  if (dayPick && dayPick.sig === pickSig() && dayPick.di >= 0 && dayPick.di < n) return dayPick.di;
  return cycleState().next;
}
function pickDay(di, temp) {
  dayPick = { di, sig: pickSig() }; if (!temp) LS.set('gc_daypick', dayPick);
  shuffleN = 0; localStorage.removeItem('gc_swaps'); today = generate(); return today;
}
function lastPerf(id) {
  let hl = null, hd = 0;
  for (let i = history.length - 1; i >= 0; i--) { const l = (history[i].log || []).find(x => x.id === id && (x.weight || x.reps)); if (l) { hl = l; hd = +new Date(history[i].date); break; } }
  // Per-set log (saved live during rests) wins if it is newer than the last saved session summary.
  const ls = lastSet(id, P && P.started); if (ls && (!hl || +new Date(ls.date) > hd + 3 * 36e5)) return { id, weight: ls.w || '', reps: ls.r || '', feel: 'good', fromSets: true };
  return hl;
}
/* ---------- per-set logging (weight + reps after every lift/core set) ---------- */
const WEIGHTED = ['dumbbells', 'light dumbbells', 'cables', 'smith', 'kettlebell', 'medicine ball', 'straight bar', 'lat bar', 'V-handle', 'D-handles', 'tricep rope'];
const isBW = e => !e.kb && !e.equipment.some(q => WEIGHTED.includes(q));
const loggable = (e, kind) => kind === 'main' && ['push', 'pull', 'legs', 'core'].includes(e.category) && !!(e.reps || e.kb);
let setLog = LS.get('gc_setlog', {});   // {exerciseId: [{date, s: sessionStart, k: setKey, w, r}]}
function lastSet(id, excludeSession) { const a = setLog[id] || []; for (let i = a.length - 1; i >= 0; i--) if (!excludeSession || a[i].s !== excludeSession) return a[i]; return null; }
const setText = (e, x) => x ? [x.w ? wText(e, Number(x.w)) : (isBW(e) ? 'BW' : ''), x.r ? x.r + ' reps' : ''].filter(Boolean).join(' × ') : '';
/* Last few sessions for an exercise (newest first): per-set log grouped by session, plus older saved-session summaries. */
function recentHistory(e, n = 3, exclude) {
  const by = {};
  (setLog[e.id] || []).forEach(x => { if (exclude && x.s === exclude) return; const g = by[x.s] = by[x.s] || { t: 0, sets: [] }; g.sets.push(x); g.t = Math.max(g.t, +new Date(x.date)); });
  const out = Object.values(by).map(g => ({ t: g.t, txt: setsShort(e, g.sets) }));
  const days = new Set(out.map(o => dateKey(new Date(o.t))));
  history.forEach(h => { if (h.skipped) return; const d = dateKey(new Date(h.date)); if (days.has(d)) return;
    const ss = (h.sets || []).filter(x => x.id === e.id).map(x => ({ w: x.weight, r: x.reps })), l = (h.log || []).find(x => x.id === e.id && (x.weight || x.reps));
    if (ss.length || l) { out.push({ t: +new Date(h.date), txt: ss.length ? setsShort(e, ss) : lastText(e, l) }); days.add(d); } });
  return out.sort((a, b) => b.t - a.t).slice(0, n).map(o => ({ ...o, date: new Date(o.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) }));
}
// "25 lb × 12, 12, 11" (consecutive sets at the same weight share the weight)
function setsShort(e, sets) {
  const parts = []; sets.forEach(x => { const w = x.w ? wText(e, Number(x.w)) : (isBW(e) ? 'BW' : '—'), r = x.r || '?'; const p = parts[parts.length - 1]; if (p && p.w === w) p.r.push(r); else parts.push({ w, r: [r] }); });
  return parts.map(p => `${p.w} × ${p.r.join(', ')}`).join(' · ');
}
const histHTML = (rows, cls = '') => rows.length ? `<div class="hist ${cls}"><div class="hh">History</div>${rows.map(r => `<div class="hr"><span>${r.date}</span><b>${r.txt}</b></div>`).join('')}</div>` : '';
const setKey = st => st.block + '|' + st.round + '|' + st.ex.id;
function setPrefill(st) {
  const e = st.ex, k = setKey(st); if (P.sets[k]) return P.sets[k];
  const same = Object.values(P.sets).filter(x => x.id === e.id).sort((a, b) => a.t - b.t).pop();
  const prev = same || lastSet(e.id, P.started);
  if (prev) return { w: prev.w || null, r: prev.r || null };
  const sg = suggest(e.id);
  return { w: (sg && sg.weight) || (e.kb ? snapKB(e, e.kb.start) : null), r: e.targetReps || (sg && sg.reps) || (e.reps ? e.reps[0] : null) };
}
function recordSet(st, w, r, auto) {
  const e = st.ex, k = setKey(st);
  P.sets[k] = { id: e.id, block: st.block, round: st.round, w: w || null, r: r || null, auto: !!auto, t: Date.now() };
  const a = setLog[e.id] = (setLog[e.id] || []).filter(x => !(x.s === P.started && x.k === k));
  a.push({ date: new Date().toISOString(), s: P.started, k, w: w || null, r: r || null }); if (a.length > 60) a.splice(0, a.length - 60);
  LS.set('gc_setlog', setLog);
}
function stepWeight(e, w, d) {
  w = Number(w) || 0;
  if (e.kb) return stepKB(e, w, d);
  const step = isBW(e) ? 5 : (w + (d > 0 ? 0 : -0.01)) < 25 ? 2.5 : 5;
  return Math.max(0, Math.round((w + d * step) * 10) / 10) || null;
}
/* Kettlebells you listed in Settings. single = any bell; double = a weight you have two of (2 × 25).
   Suggestions start here. The log stepper is NOT limited to this list. */
function kbOwned(e) {
  const c = {}; (settings.kettlebells || []).forEach(w => { c[w] = (c[w] || 0) + 1; });
  return Object.keys(c).map(Number).filter(w => !e || !e.kb || e.kb.mode !== 'double' || c[w] >= 2).sort((a, b) => a - b);
}
// Logger stops. The owned list used to be the ceiling, so a 50 lb suitcase carry could not be
// entered when Settings only listed 25 and 35. Past the last rung, + keeps adding 10 lb.
const KB_RUNGS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 110, 120];
function kbOptions(e) {
  return [...new Set([...KB_RUNGS, ...kbOwned(e)])].filter(w => w > 0).sort((a, b) => a - b);
}
function stepKB(e, w, d) {
  const o = kbOptions(e); if (!o.length) return w || null;
  if (!w) return d < 0 ? o[0] : (kbOwned(e)[0] || o[0]);
  const exact = o.findIndex(x => Math.abs(x - w) < 0.1);
  if (exact >= 0) {
    if (d > 0 && exact === o.length - 1) return Math.round((w + 10) * 10) / 10;
    return o[Math.max(0, exact + (d > 0 ? 1 : -1))];
  }
  if (d > 0) return o.find(x => x > w + 0.1) || Math.round((w + 10) * 10) / 10;
  return [...o].reverse().find(x => x < w - 0.1) || o[0];
}
function snapKB(e, w) { const o = kbOwned(e); return o.length ? o.reduce((a, b) => Math.abs(b - w) < Math.abs(a - w) ? b : a) : w; }
/* Double progression with lighter loads: add reps inside the exercise's range first; at the top of the range
   (and logged Easy) the load goes up one small step (KB: next bell you own) and reps reset to the bottom.
   Hard = drop reps (or load at the bottom of the range). Returns {weight, reps, last} or null. */
function suggest(id) {
  const e = byId(id); if (!e) return null; const l = lastPerf(id);
  const [lo, hi] = e.reps || [0, 0]; const rstep = hi - lo > 4 ? 2 : 1; const start = e.startReps || lo;
  if (!l) { if (!e.kb && !e.reps) return null; return { last: null, weight: e.kb ? snapKB(e, e.kb.start) : null, reps: e.reps ? start : null }; }
  let w = Number(l.weight) || 0, r = Number(l.reps) || (e.reps ? start : 0);
  // Owned bells only for the automatic bump. A weight he logged above that list (50 lb suitcase) stays.
  const up = () => { if (e.kb) { const nx = kbOwned(e).find(x => x > w + 0.1); if (nx) { w = nx; return true; } return false; } if (!w) return false; w += w >= 25 ? 5 : 2.5; return true; };
  const down = () => { if (e.kb) { const pv = [...kbOptions(e)].reverse().find(x => x < w - 0.1); if (pv) w = pv; return; } if (w) w = Math.max(0, w - (w > 25 ? 5 : 2.5)); };
  if (l.feel === 'easy') { if (e.reps && r + rstep <= hi) r += rstep; else if (up()) r = e.reps ? lo : r; else if (e.reps) r = Math.min(hi, r + rstep); }
  else if (l.feel === 'hard') { if (e.reps && r - rstep >= Math.min(lo, start)) r -= rstep; else down(); }
  return { last: l, weight: w || null, reps: e.reps ? r : null };
}
const wText = (e, w) => w ? (e.kb && e.kb.mode === 'double' ? `2×${w} lb` : `${w} lb`) : '';
function sgText(e, sg) { if (!sg) return ''; return [wText(e, sg.weight), sg.reps ? (perSide(e) ? sg.reps + ' / side' : sg.reps + ' reps') : ''].filter(Boolean).join(' × '); }
function lastText(e, l) { return l ? [wText(e, Number(l.weight)), l.reps ? l.reps + ' reps' : ''].filter(Boolean).join(' × ') : ''; }
/* ---------- time model (v16) ----------
   Work interval = ~10 s to get set (grab/unrack, get in position) + target reps x 5 s (x2 for each-side moves), 25-150 s.
   On top of the timers, every lifting set costs extra real time the timers don't run for (logging, pauses, re-racking,
   walking to the next station): OVH s per set. OVH starts at 15 s and is calibrated from the sessions he actually did
   (gc_timing: wall-clock vs planned time per session and per step). The estimate shown everywhere and used to fit the
   chosen length = sum of all steps + OVH x lifting sets. */
const SET_SETUP = 10, SEC_PER_REP = 5, OVH_DEFAULT = 15;
// Both limbs in one interval: the unilateral flag (left then right). The old cue regex
// (only "switch" / "each side") left "Alternate legs per set" and timed one-side moves
// on a single-side clock, so the set ended before the second side.
function perSide(e) { return !!(e && e.unilateral); }
function sideCount(e) { return perSide(e) ? 2 : 1; }
// Halfway "switch sides" cue: the unilateral flag, plus any move whose name or cues say
// each side / left-then-right / switch side (renegade row says "then switch" only in the form cues).
function switchesSides(e) {
  if (!e) return false;
  if (e.unilateral) return true;
  const t = `${e.name || ''} ${e.cue || ''} ${(e.formCues || []).join(' ')}`;
  return /each side|switch side|switch hand|switch sides|left (leg|side|arm)|per side|single[- ](leg|arm)|one-arm|split squat|then switch|other side|other leg|other arm/i.test(t);
}
function withReps(x) {
  const src = byId(x.id) || x;
  if (!src.reps) {
    if (perSide(src)) {
      const lv = LEVEL[settings.level] || LEVEL.intermediate;
      const base = Math.round((src.work || 30) * lv.w / 5) * 5;
      x.work = Math.min(150, Math.max(30, Math.round(base * 2 / 5) * 5));
    }
    return x;
  }
  const sg = suggest(x.id); x.targetReps = (sg && sg.reps) || src.startReps || src.reps[0];
  const sides = sideCount(src);
  x.work = Math.min(150, Math.max(25, Math.round((SET_SETUP + x.targetReps * SEC_PER_REP * sides) / 5) * 5));
  return x;
}
const isLiftStep = s => s.type === 'work' && s.kind !== 'warmup' && s.kind !== 'cooldown';
// Extra seconds per lifting set, from real sessions: mean of the default and the last 5 measured sessions (5-60 s).
function ovhPerSet() {
  const T = LS.get('gc_timing', []).filter(x => x.sets >= 4 && x.actualSec > 0).slice(-5);
  const v = [OVH_DEFAULT, ...T.map(x => (x.actualSec - x.plannedSec) / x.sets)];
  return Math.round(Math.min(60, Math.max(5, v.reduce((a, b) => a + b, 0) / v.length)));
}
function estSec(w, ovh = ovhPerSet()) { const st = buildSteps(w); return st.reduce((a, x) => a + x.dur, 0) + ovh * st.filter(isLiftStep).length; }
/* Rest after a finished round (both exercises of a pair done), and the rest portion before the
   next group's setup. Priority: per-exercise override (Library) > exercise data restSec > rule.
   Full "Rest between rounds" for every category (default 60). Core and conditioning used to take
   half of that (min 30), so any pair that ended on abs/obliques or a finisher rested 30 s.
   Beginner stretches it; it never drops under the round-rest setting. Warm-up/cool-down transitions
   are set by the generator (10 s / 5 s), not this rule. */
function restFor(e) {
  const ov = (settings.restOverrides || {})[e.id]; if (ov) return ov;
  if (e.restSec) return e.restSec;
  if (e.category === 'mobility') return 10;
  const lv = LEVEL[settings.level] || LEVEL.intermediate, base = Math.max(60, +settings.restSec || 60), r5 = x => Math.round(x / 5) * 5;
  return Math.max(base, r5(Math.max(base, e.rest || 0) * lv.r));
}
// One token per station setup. Same station + same token = no reconfiguration, safe to superset.
// Same station + different token = move the pin, pulley, bench angle, strap length, or step height
// between the two moves (Smith RDL vs calf raise was the example; cables, benches, BOSU, TRX, the step too).
// Two dumbbell or kettlebell moves do not conflict: there is no station to reconfigure.
const STATION = {
  'smith-bench': ['smith:flat', 'bench:flat'],
  'smith-incline-bench': ['smith:incline', 'bench:incline'],
  'smith-ohp': ['smith:upright', 'bench:upright'],
  'smith-row': ['smith:row'],
  'smith-inverted-row': ['smith:inverted'],
  'smith-shrug': ['smith:shrug'],
  'smith-squat': ['smith:shoulders'],
  'smith-split-squat': ['smith:shoulders'],
  'smith-rdl': ['smith:rdl'],
  'smith-calf-raise': ['smith:calf', 'step:low'],
  'db-bench': ['bench:flat'], 'db-fly': ['bench:flat'], 'db-row': ['bench:flat'],
  'db-incline-press': ['bench:incline'], 'db-incline-fly': ['bench:incline'],
  'db-chest-supported-row': ['bench:incline'], 'db-rear-delt-fly': ['bench:incline'],
  'db-shoulder-press': ['bench:upright'], 'db-arnold-press': ['bench:upright'],
  'db-bulgarian': ['bench:foot'],
  'db-hip-thrust': ['bench:hip'], 'sl-hip-thrust': ['bench:hip'],
  'decline-situp': ['bench:decline'],
  'cable-fly': ['cable:high-d'], 'cable-woodchop': ['cable:high-d'],
  'cable-low-high-fly': ['cable:low-d'], 'cable-front-raise': ['cable:low-d'], 'cable-lateral-raise': ['cable:low-d'],
  'cable-tricep-pushdown': ['cable:high-rope'], 'cable-crunch': ['cable:high-rope'],
  'cable-overhead-tricep': ['cable:low-rope'], 'cable-pull-through': ['cable:low-rope'],
  'cable-face-pull': ['cable:mid-rope'],
  'lat-pulldown': ['cable:high-latbar'],
  'cable-straight-arm-pd': ['cable:high-bar'],
  'cable-curl': ['cable:low-bar'], 'cable-shrug': ['cable:low-bar'],
  'seated-cable-row': ['cable:low-v'],
  'cable-rear-delt-fly': ['cable:mid-d-crossed'],
  'pallof-press': ['cable:mid-d'],
  'cable-kickback': ['cable:low-ankle'], 'cable-hip-abduction': ['cable:low-ankle'],
  'db-step-up': ['step:full'],
  'negative-pullup': ['step:aid'],
  'bosu-pushup': ['bosu:flat-up'], 'bosu-plank': ['bosu:dome-up'],
  'trx-row': ['trx:hands-row'], 'trx-fallout': ['trx:hands-long'],
  'trx-pistol': ['trx:hands-stand'], 'trx-jump-squat': ['trx:hands-stand'],
  'trx-ham-curl': ['trx:feet'],
};
const stationKeys = e => (e && STATION[e.id]) || [];
function stationConflict(a, b) {
  const A = stationKeys(a), B = stationKeys(b);
  for (const x of A) for (const y of B) if (x.split(':')[0] === y.split(':')[0] && x !== y) return true;
  return false;
}
function smithConflict(a, b) { return stationConflict(a, b); }
// Full-body / hard-effort finishers. Burpee + thruster (and the other max efforts in that pool)
// are too much in one superset; pair one of them with a lighter conditioner instead.
const HIGH_ENERGY = new Set(['burpee', 'kb-thruster', 'row-sprint', 'mountain-climber', 'trx-jump-squat']);
function highEnergy(e) {
  if (!e) return false;
  if (HIGH_ENERGY.has(e.id)) return true;
  return e.category === 'conditioning' && (e.muscles || []).includes('full body');
}
function pairConflict(a, b) { return stationConflict(a, b) || (highEnergy(a) && highEnergy(b)); }
function warmupFor(day) {
  if (day.warmup) return day.warmup;
  const cats = new Set(day.blocks.flat().map(c => c.split(':')[0]));
  if (cats.has('legs') && !cats.has('push')) return ['wu-hip-circles', 'wu-leg-swings', 'wu-glute-bridge', 'dead-bug', 'st-hip-flexor', 'wu-bw-squat'];
  return ['wu-arm-circles', 'cat-cow', 'wu-band-pull-apart', 'wu-scap-pushup', 'st-dyn-chest', 'st-childs-pose'];
}
function generate() {
  const split = SPLITS[settings.daysPerWeek] || SPLITS[4];
  const di = nextDayIndex(); const day = split[di];
  // Same calendar day used to reproduce the same blocks: the random draw is only 0–1,
  // smaller than "primary muscle" (3) or the heavy-exercise bonus (0.6), and the old
  // −0.5 recent hit only saw the last two sessions of any day — so the previous Push
  // was already buried under Pull and Legs. Count this day's own sessions, penalize
  // those lifts when another on-role option exists, and rotate which patterns lead.
  const prior = history.filter(h => !h.skipped && dayIndexFromHistory(h, split) === di);
  const turn = prior.length;
  const again = new Set(prior.slice(-2).flatMap(h => h.exerciseIds || []));
  const R = rng([dateKey(new Date()), di, shuffleN, turn, settings.daysPerWeek].join('|'));
  const lv = LEVEL[settings.level] || LEVEL.intermediate;
  const pool = available(), okPool = genPool(); const used = new Set();
  // An avoided exercise is never programmed: its slot automatically gets its first usable backup instead
  // (keeps the rest of the plan stable). If no backup is usable, the next-best pick is taken.
  const sub = e => { if (!settings.avoided.includes(e.id)) return e; const a = (e.alternates || []).map(x => okPool.find(p => p.id === x && !used.has(x))).find(Boolean); return a ? { ...a, autoFor: e.id } : null; };
  // Fixed warm-up/cool-down picks fall back to their first usable alternate if avoided or missing equipment.
  const fixed = id => { const ok = x => okPool.find(e => e.id === x && !used.has(x)); const e = ok(id) || (byId(id)?.alternates || []).map(ok).find(Boolean); if (e) used.add(e.id); return e; };
  const rankSlot = (slot, preferHeavy, skip) => {
    const [cat, mus] = slot.split(':'); const want = mus ? mus.split('/') : [];
    const c = pool.filter(e => e.category === cat && !used.has(e.id) && !skip.has(e.id) && e.id !== 'row-steady');
    const fit = e => !want.length ? 0 : want.includes((e.muscles || [])[0]) ? 3 : (e.muscles || []).some(m => want.includes(m)) ? 1.5 : 0;
    const score = e => {
      const f = fit(e);
      // 2.6 is larger than the random draw plus the heavy bonus, so a repeat loses to a
      // fresh exercise with the same muscle fit. The only calf raise (no other fit-3) stays.
      const alt = again.has(e.id) && c.some(o => o !== e && fit(o) >= f);
      return f + R() + (preferHeavy && e.rest >= 60 ? 0.6 : 0) - (alt ? 2.6 : 0);
    };
    return c.map(e => ({ e, score: score(e) })).sort((a, b) => b.score - a.score);
  };
  // Highest-scoring superset that does not pair two different setups of the same station
  // (Smith stops, cable pulley/attachment, bench angle, BOSU side, TRX length, step height).
  // Searching the pair keeps a real hamstring with the calf raise instead of dropping the calf.
  const chooseItems = (pat, preferFirst) => {
    const lists = pat.map((slot, i) => rankSlot(slot, preferFirst && i === 0, new Set()));
    let best = null, bestScore = -Infinity;
    const chosen = [];
    const dfs = i => {
      if (i === lists.length) {
        const sc = chosen.reduce((a, c) => a + c.score, 0);
        if (sc > bestScore) { bestScore = sc; best = chosen.map(c => ({ raw: c.e, item: c.item })); }
        return;
      }
      for (const row of lists[i]) {
        if (chosen.some(c => c.e.id === row.e.id)) continue;
        const item = sub(row.e); if (!item) continue;
        if (chosen.some(c => c.item.id === item.id || pairConflict(c.item, item))) continue;
        chosen.push({ e: row.e, item, score: row.score }); dfs(i + 1); chosen.pop();
      }
    };
    dfs(0);
    if (!best) {
      const items = [];
      for (let i = 0; i < pat.length; i++) {
        const row = rankSlot(pat[i], preferFirst && i === 0, new Set(items.map(e => e.id))).find(r => sub(r.e));
        if (!row) continue;
        const item = sub(row.e); used.add(row.e.id); used.add(item.id); items.push(item);
      }
      return items;
    }
    best.forEach(c => { used.add(c.raw.id); used.add(c.item.id); });
    return best.map(c => c.item);
  };
  const scale = e => withReps({ ...e, work: Math.round(e.work * lv.w / 5) * 5, rest: restFor(e) });
  const budget = settings.minutes * 60;
  const cy = cycleState(), rem = cy.remaining.filter(i => i !== di);
  const out = { day: day.name, focus: day.focus, dayIndex: di, splitLen: split.length, nextDay: split[rem.length ? rem[0] : (di + 1) % split.length].name, blocks: [] };
  let t = 0;
  if (settings.warmup) {
    // Day-specific prep + a short dynamic-stretch segment (gentle on lower back, right shoulder, left elbow, knees).
    const wt = settings.minutes <= 30 ? 25 : 30;
    const wu = warmupFor(day).map(fixed).filter(Boolean).map(e => ({ ...e, work: perSide(e) ? Math.round(wt * 2 / 5) * 5 : wt, rest: 10 }));
    if (wu.length) { out.blocks.push({ name: 'Warm-up', rounds: 1, items: wu, kind: 'warmup' }); t += wu.reduce((s, e) => s + e.work + e.rest, 0); }
  }
  const cdItems = settings.cooldown ? (day.cooldown || ['foam-roll-legs', 'ball-chest-stretch']).map(fixed).filter(Boolean).map(e => ({ ...e, work: perSide(e) ? 120 : 60, rest: 5 })) : [];
  const cdTime = cdItems.reduce((s, e) => s + e.work + e.rest, 0);
  // Short conditioning finisher (2 rounds) reserved up front so main work fills the rest of the budget.
  const finItems = day.finisher ? chooseItems(day.finisher, false).map(scale) : [];
  const finRounds = 2;
  // Fill main blocks using the real step timeline (warm-up + blocks + finisher + cool-down) so the session lands near the target.
  const finBlock = finItems.length ? { name: 'Finisher', rounds: finRounds, items: finItems, kind: 'finisher' } : null;
  let fin = finBlock;
  const cdBlock = cdItems.length ? { name: 'Cool-down', rounds: 1, items: cdItems, kind: 'cooldown' } : null;
  const ovh = ovhPerSet(), total = blocks => estSec({ blocks: blocks.filter(Boolean) }, ovh);
  // Fit to the chosen length using the REALISTIC estimate (every step buildSteps makes + per-set overhead).
  // Realistic estimate must not exceed the chosen length; up to 4 min under is fine (fewer blocks/rounds beat cramming).
  const hi = budget, lo = budget - 240, all = () => [...out.blocks, fin, cdBlock];
  let bi = 0;
  while (bi < 10) {
    const pat = day.blocks[(bi + turn) % day.blocks.length];
    const items = chooseItems(pat, bi < 2).map(scale);
    if (!items.length) break;
    const isFinisher = !day.finisher && pat.every(c => /^(conditioning|core)/.test(c));
    let rounds = isFinisher ? Math.max(2, lv.rounds) : lv.rounds;
    const blk = r => ({ name: isFinisher ? 'Finisher' : 'Block ' + String.fromCharCode(65 + bi), rounds: r, items, kind: isFinisher ? 'finisher' : 'main' });
    // Full rounds if it fits; else fewer (min 2); always keep at least 2 main blocks.
    while (rounds > Math.max(2, bi >= 2 ? lv.rounds - 1 : 2) && total([...out.blocks, blk(rounds), finBlock, cdBlock]) > hi) rounds--;
    if (bi >= 2 && total([...out.blocks, blk(rounds), finBlock, cdBlock]) > hi) { items.forEach(e => used.delete(e.id)); break; }
    out.blocks.push(blk(rounds)); bi++;
  }
  // Still short? add a round to main blocks (up to level rounds + 1), then to the finisher, while staying <= target.
  const mains = () => out.blocks.filter(b => b.kind === 'main');
  for (let pass = 0; pass < 2 && total(all()) < lo; pass++)
    for (const b of [...mains(), finBlock].filter(Boolean)) { if (total(all()) >= lo) break; if (b.rounds >= lv.rounds + 1) continue; b.rounds++; if (total(all()) > hi) b.rounds--; }
  // Still long (minimum 2 main blocks forced)? drop rounds from the last blocks, then the finisher to 1 round.
  for (const b of [...mains()].reverse()) { while (total(all()) > hi && b.rounds > 2) b.rounds--; }
  if (fin) while (total(all()) > hi && fin.rounds > 1) fin.rounds--;
  if (fin && total(all()) > hi) { fin.items.forEach(e => used.delete(e.id)); fin = null; } // drop the finisher before cramming
  if (fin) out.blocks.push(fin);
  if (cdBlock) out.blocks.push(cdBlock);
  out.key = [dateKey(new Date()), di, shuffleN, turn, settings.daysPerWeek, settings.minutes, settings.level, settings.restSec, settings.switchSec, settings.setupSec].join('|');
  applySwaps(out);
  out.stepSec = totalSec(out); out.totalSec = estSec(out); out.estMin = Math.round(out.totalSec / 60);
  return out;
}
/* The one true session length: the sum of every step the player will run. Used by Today, preview and the player header. */
function totalSec(w) { return buildSteps(w).reduce((a, x) => a + x.dur, 0); }
const minText = s => Math.round(s / 60) + ' min';

/* ---------- swaps (injury backups) ----------
   One tap = replace with the next curated alternate (no chooser). Tapping again cycles through the backups
   (and back to the original). The slot keeps its work/rest timing and round structure; the new exercise
   brings its own images, form cues and demo link. Swaps persist for this session (gc_swaps, keyed to the
   generated workout) and are logged in history. Long-press = avoid this exercise permanently. */
function slotCandidates(w, bi, ii) {
  const cur = w.blocks[bi].items[ii], orig = byId(cur.origId || cur.id);
  const used = new Set(w.blocks.flatMap((b, x) => b.items.filter((e, y) => !(x === bi && y === ii)).map(e => e.id)));
  const avail = new Set(available().map(e => e.id));
  const partners = w.blocks[bi].items.filter((_, y) => y !== ii);
  const pass = id => { const e = byId(id); return !!(e && avail.has(id) && !settings.avoided.includes(id) && !used.has(id) && id !== 'row-steady' && !partners.some(p => pairConflict(p, e))); };
  const base = [];
  const push = id => { if (id && !base.includes(id) && (id === cur.id || pass(id))) base.push(id); };
  push(cur.id); push(orig.id); (orig.alternates || []).forEach(push);
  const extra = extraForSlot(orig, base, used, partners, avail);
  if (extra) base.push(extra);
  return base;
}
// One more replacement than the curated backups: same category and muscle role, still free of
// station conflicts and a second max-effort finisher.
function extraForSlot(orig, have, used, partners, avail) {
  if (!orig) return null;
  const primary = (orig.muscles || [])[0];
  const pool = available().filter(e => avail.has(e.id) && !have.includes(e.id) && !used.has(e.id) && !settings.avoided.includes(e.id) && e.id !== 'row-steady' && e.category === orig.category && !partners.some(p => pairConflict(p, e)));
  const role = e => (e.muscles || [])[0] === primary ? 2 : (e.muscles || []).some(m => (orig.muscles || []).includes(m)) ? 1 : 0;
  pool.sort((a, b) => role(b) - role(a) || a.name.localeCompare(b.name));
  const fit = pool.find(e => role(e) > 0) || pool[0];
  return fit ? fit.id : null;
}
function nextAlternate(w, bi, ii) {
  const cur = w.blocks[bi].items[ii], c = slotCandidates(w, bi, ii);
  const nx = c[(c.indexOf(cur.id) + 1) % c.length];
  return nx && nx !== cur.id ? nx : null;
}
// A swap keeps the slot's rest and round structure; the work interval follows the new exercise's reps.
const makeItem = (slot, id) => withReps({ ...byId(id), work: slot.work, rest: (settings.restOverrides || {})[id] || slot.rest, origId: slot.origId || slot.id });
function persistSwaps(w = today) {
  const slots = {}; w.blocks.forEach((b, bi) => b.items.forEach((e, ii) => { if (e.origId && e.origId !== e.id) slots[bi + ':' + ii] = e.id; }));
  LS.set('gc_swaps', { key: w.key, slots, log: w.swaps || [] });
}
function applySwaps(w) {
  w.swaps = [];
  const st = LS.get('gc_swaps', null); if (!st || st.key !== w.key) return;
  for (const [k, id] of Object.entries(st.slots || {})) {
    const [bi, ii] = k.split(':').map(Number), slot = w.blocks[bi] && w.blocks[bi].items[ii];
    if (slot && byId(id) && slotCandidates(w, bi, ii).includes(id)) w.blocks[bi].items[ii] = makeItem(slot, id);
  }
  w.swaps = st.log || [];
}
function findSlot(item, w = today) {
  for (let bi = 0; bi < w.blocks.length; bi++) { const ii = w.blocks[bi].items.indexOf(item); if (ii >= 0) return [bi, ii]; }
  return null;
}
function doSwap(bi, ii, reason = 'swap', forceId) {
  const w = today, cur = w.blocks[bi].items[ii];
  const allowed = slotCandidates(w, bi, ii);
  const id = forceId && allowed.includes(forceId) && forceId !== cur.id ? forceId : (forceId ? null : nextAlternate(w, bi, ii));
  if (!id) { if (!forceId) toast('No other backup available for ' + cur.name); return null; }
  const ni = makeItem(cur, id); w.blocks[bi].items[ii] = ni;
  w.swaps.push({ block: w.blocks[bi].name, from: cur.id, to: id, original: ni.origId, reason, at: new Date().toISOString() });
  persistSwaps(w);
  if (P.steps.length) { // live session: point every step for this slot at the new exercise
    let hit = false; P.steps.forEach((s, k) => { if (s.ex === cur) { s.ex = ni; hit = true; if (k !== P.i && s.type === 'work') s.dur = ni.work; } });
    P.est = 0; if (hit && !(id in P.cueOff)) Object.assign(P.cueOff, assignCueOffsets(P.steps.filter(s => s.ex === ni)));
  }
  return ni;
}
// What actually changed this session (original -> exercise done), plus anything newly avoided.
function netSwaps(w = today) {
  const out = w.blocks.flatMap(b => b.items.filter(e => e.origId && e.origId !== e.id).map(e => ({ block: b.name, from: e.origId, to: e.id, reason: 'swap' })));
  (w.swaps || []).filter(x => x.reason === 'avoid').forEach(x => { const o = out.find(y => y.to === x.to || y.from === x.from); if (o) o.reason = 'avoid'; else out.push({ block: x.block, from: x.from, to: x.to, reason: 'avoid' }); });
  return out;
}
function avoidEx(id) { if (!settings.avoided.includes(id)) { settings.avoided.push(id); LS.set('gc_settings', settings); } }
// Long-press on Swap: never program this exercise again, and swap it out right now.
function avoidAndSwap(bi, ii) {
  const cur = today.blocks[bi].items[ii]; avoidEx(cur.id);
  const ni = doSwap(bi, ii, 'avoid'); toast(`Avoiding ${cur.name}${ni ? ' → ' + ni.name : ''}. Undo in Settings.`); return ni;
}
// "Avoid" chip shown after a swap: permanently avoid the original exercise, keep the backup.
function avoidOriginal(bi, ii) {
  const cur = today.blocks[bi].items[ii]; if (!cur.origId || cur.origId === cur.id) return;
  avoidEx(cur.origId); today.swaps.push({ block: today.blocks[bi].name, from: cur.origId, to: cur.id, original: cur.origId, reason: 'avoid', at: new Date().toISOString() });
  persistSwaps(); toast(`Avoiding ${byId(cur.origId).name}. Undo in Settings.`);
}
function longPress(el, onLong, onShort, ms = 600) {
  let t = null, fired = false;
  el.addEventListener('pointerdown', () => { fired = false; t = setTimeout(() => { fired = true; onLong(); }, ms); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(n => el.addEventListener(n, () => clearTimeout(t)));
  el.addEventListener('contextmenu', ev => ev.preventDefault());
  el.addEventListener('click', ev => { ev.stopPropagation(); if (fired) { fired = false; return; } onShort(); });
}
function toast(msg) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600);
}
const clampSwitch = () => Math.min(30, Math.max(5, +settings.switchSec || 10));
const clampSetup = () => Math.min(90, Math.max(15, +settings.setupSec || 30));
// Inside a block, the rest after both exercises of a round is one minute. Not the exercise's own
// rest (30 on core, 75 on a heavy squat) and not a library override — those were the 30 s exceptions.
const ROUND_REST = 60;
// Between blocks: 60 s rest + setup (at least 30 s). Never under 90 s, including warm-up → first block.
const BLOCK_GAP = 90;
function blockGap() {
  const setupPart = Math.max(30, clampSetup());
  let restPart = ROUND_REST;
  if (restPart + setupPart < BLOCK_GAP) restPart += BLOCK_GAP - (restPart + setupPart);
  return { restPart, setupPart, dur: restPart + setupPart };
}
/* Flatten blocks into timed steps */
function buildSteps(w) {
  const steps = [{ type: 'prep', dur: 10, ex: w.blocks[0].items[0], label: 'Get ready' }];
  w.blocks.forEach((b, bi) => {
    for (let r = 1; r <= b.rounds; r++) {
      b.items.forEach((e, i) => {
        steps.push({ type: 'work', dur: e.work, ex: e, block: b.name, kind: b.kind, round: r, rounds: b.rounds });
        const lastInRound = i === b.items.length - 1;
        const lastOfBlock = lastInRound && r === b.rounds;
        // Superset structure: A -> short switch -> B; full rest only after the round; between groups rest + setup time.
        const warm = b.kind === 'warmup' || b.kind === 'cooldown';
        const nb = w.blocks[bi + 1];
        if (lastOfBlock && !nb) return; // end of workout
        if (lastOfBlock) { // every block boundary, including warm-up → first group: at least 90 s (60 rest + setup)
          const gap = blockGap();
          steps.push({ type: 'rest', dur: gap.dur, restPart: gap.restPart, setupPart: gap.setupPart, setup: true, block: b.name, after: e.name,
            nextBlock: nb.name, nextRounds: nb.rounds, nextItems: nb.items, label: 'Set up · next group' });
        } else if (warm) steps.push({ type: 'rest', dur: 10, block: b.name, transition: true, after: e.name, label: 'Transition' });
        else if (!lastInRound) steps.push({ type: 'rest', dur: clampSwitch(), block: b.name, sw: true, after: e.name, label: 'Switch · next exercise' });
        else steps.push({ type: 'rest', dur: ROUND_REST, block: b.name, after: e.name, label: 'Rest · next round' });
      });
    }
  });
  // attach "next exercise" to each step
  for (let i = 0; i < steps.length; i++) steps[i].next = steps.slice(i + 1).find(s => s.type === 'work') || null;
  return steps;
}

/* ---------- audio ----------
   iOS Safari (incl. home-screen PWAs) only allows sound that was unlocked inside a user tap, and it mutes Web Audio
   when the ring/silent switch is on silent. So: ONE AudioContext, unlocked + resumed on every tap; a looping silent
   <audio playsinline> element during workouts puts iOS in "playback" mode; and pre-rendered <audio> beep files are
   used whenever the AudioContext isn't running. */
const AC = window.AudioContext || window.webkitAudioContext;
let actx = null, silentEl = null;
const BEEP_FILES = [420, 500, 700, 880, 1000, 1200, 1320];
const beepEls = {};
const audioCtx = () => { if (!actx && AC) { try { actx = new AC(); } catch (e) { actx = null; } } return actx; };
function resumeAudio() { const c = actx; if (c && c.state !== 'running') { try { c.resume(); } catch (e) {} } }
// Call synchronously inside a user gesture (Start workout, Test sound, any tap).
function unlockAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
  const c = audioCtx();
  if (c) { try { resumeAudio(); const b = c.createBuffer(1, 1, 22050), src = c.createBufferSource(); src.buffer = b; src.connect(c.destination); src.start(0); } catch (e) {} }
  try {
    if (!silentEl) { silentEl = new Audio('audio/silence.wav'); silentEl.loop = true; silentEl.setAttribute('playsinline', ''); silentEl.preload = 'auto'; }
    // Playing this loop pauses speechSynthesis on iOS and leaves it paused, so later names never start.
    if (!settings.voice && !speaking() && silentEl.paused) { const pr = silentEl.play(); if (pr && pr.catch) pr.catch(() => {}); }
  } catch (e) {}
  if (!settings.voice && !speaking()) BEEP_FILES.forEach(f => { // prime the fallback beep elements inside the gesture
    try {
      if (beepEls[f]) return; const el = new Audio('audio/beep' + f + '.wav'); el.setAttribute('playsinline', ''); el.preload = 'auto'; beepEls[f] = el;
      el.muted = true; const pr = el.play(); if (pr && pr.then) pr.then(() => { el.pause(); el.currentTime = 0; el.muted = false; }).catch(() => { el.muted = false; }); else el.muted = false;
    } catch (e) {}
  });
  if ('speechSynthesis' in window) { try { speechSynthesis.getVoices(); } catch (e) {} } // load the list inside the tap; no extra utterance (it raced the first line)
}
/* v18: keep the iOS audio route warm for the whole workout so speech does not lose its first syllable while the
   output spins up after silence. A near-silent (-66 dB) low tone runs continuously through WebAudio from Start until
   the workout ends; it is never stopped/restarted per utterance. */
const WARM = { gain: 0.0005, freq: 30, node: null, g: null };
function warmAudio() {
  const c = audioCtx(); if (!c) return; resumeAudio();
  if (WARM.node) return; // already running: never restart
  try { const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.value = WARM.freq; g.gain.value = WARM.gain;
    o.connect(g); g.connect(c.destination); o.start(); WARM.node = o; WARM.g = g; } catch (e) {}
}
function coolAudio() { try { WARM.node && WARM.node.stop(); WARM.g && WARM.g.disconnect(); } catch (e) {} WARM.node = null; WARM.g = null; }
function stopKeepAlive() { try { silentEl && silentEl.pause(); } catch (e) {} coolAudio(); }
const playerOpen = () => { const el = document.getElementById('player'); return !!el && !el.classList.contains('hidden'); };
['touchend', 'click', 'keydown'].forEach(t => document.addEventListener(t, () => { resumeAudio(); if (playerOpen()) warmAudio(); if (!settings.voice && silentEl && silentEl.paused && playerOpen() && !speaking()) silentEl.play().catch(() => {}); }, { capture: true, passive: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) { resumeAudio(); if (!settings.voice && playerOpen() && silentEl && !speaking()) silentEl.play().catch(() => {}); } });
// ---- Keep the screen awake during a workout ----
// Screen Wake Lock API first; if it's missing or refused (older iOS, some home-screen PWAs), fall back to a tiny
// muted, looping, inline video (the NoSleep.js trick). The lock is dropped by the OS when the page is hidden, so it is
// re-acquired on visibilitychange and on resume; released when the workout finishes or is closed.
const NOSLEEP_MP4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAmgbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAJxAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAApp0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAJxAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAACcQAAAAAAABAAAAAAISbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAACgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABvW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAX1zdGJsAAAAuXN0c2QAAAAAAAAAAQAAAKlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAL2F2Y0MBQsAK/+EAF2dCwArZBCbARAAAAwAEAAADAAg8SJkgAQAFaMuDxMgAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAACYAAAAAAAAAAYc3R0cwAAAAAAAAABAAAACgAAQAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAA8c3RzegAAAAAAAAAAAAAACgAAApUAAAALAAAADAAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAA4c3RjbwAAAAAAAAAKAAAJ5QAADNIAAA01AAANlQAADfgAAA5XAAAOugAADxkAAA98AAAP2wAABjF0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAJxAAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAACcQAAAEAAABAAAAAAWpbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABWIgADYVRVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAAFVG1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAFGHN0YmwAAAB+c3RzZAAAAAAAAAABAAAAbm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAABWIgAAAAAANmVzZHMAAAAAA4CAgCUAAgAEgICAF0AVAAAAAAA+gAAAAsAFgICABROIVuUABoCAgAECAAAAFGJ0cnQAAAAAAAA+gAAAAsAAAAAgc3R0cwAAAAAAAAACAAAA2AAABAAAAAABAAABVAAAAIhzdHNjAAAAAAAAAAoAAAABAAAAAQAAAAEAAAACAAAAFgAAAAEAAAAEAAAAFQAAAAEAAAAFAAAAFgAAAAEAAAAGAAAAFQAAAAEAAAAHAAAAFgAAAAEAAAAIAAAAFQAAAAEAAAAJAAAAFgAAAAEAAAAKAAAAFQAAAAEAAAALAAAAFgAAAAEAAAN4c3RzegAAAAAAAAAAAAAA2QAAABUAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAA8c3RjbwAAAAAAAAALAAAJ0AAADHoAAAzdAAANQQAADaAAAA4DAAAOYgAADsUAAA8kAAAPhwAAD+YAAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAAAHJvbGwAAAABAAAA2QAAAAEAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYxLjcuMTAzAAAACGZyZWUAAAZ2bWRhdN4CAExhdmM2MS4xOS4xMDEAAjBADgAAAnIGBf//btxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTotMzotMyBhbmFseXNlPTB4MToweDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9Mi4wMDowLjcwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tNCB0aHJlYWRzPTIgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMjAAgAAAABtliIQF85///w9FAAFXnycnJ1111111111114ABGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHAAAAB0GaOAvnOEYBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHAAAACEGaVAL5zhGAARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHAAAAB0GaYBfOcIwBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHAAAAB0GagBfOcIwBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcAAAAHQZqgF85wjAEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcAAAAHQZrAF85wjAEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAAdBmuAXznCMARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAAdBmwAXznCMARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHAAAAB0GbIBfOcIwBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAH';
const WAKE = { mode: 'off', err: null };
let wakeVid = null;
const wakeWanted = () => settings.keepAwake !== false && playerOpen();
function videoWake() {
  if (settings.voice) return; // a playing <video> pauses speechSynthesis for the rest of the session on iOS
  if (!wakeVid) {
    wakeVid = document.createElement('video');
    wakeVid.setAttribute('playsinline', ''); wakeVid.setAttribute('webkit-playsinline', ''); wakeVid.setAttribute('muted', '');
    wakeVid.muted = true; wakeVid.loop = true; wakeVid.setAttribute('aria-hidden', 'true'); wakeVid.id = 'wakeVid';
    wakeVid.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
    wakeVid.src = NOSLEEP_MP4; document.body.appendChild(wakeVid);
  }
  WAKE.mode = 'video';
  if (!wakeVid.paused) return; // already running: never restart it (would interrupt speech on iOS)
  wakeVid.muted = true; const pr = wakeVid.play(); if (pr && pr.catch) pr.catch(e => { WAKE.err = 'video:' + (e && e.name); });
}
function acquireWake() {
  if (!wakeWanted()) return;
  if (P.wake && !P.wake.released) return;            // already held
  if (!('wakeLock' in navigator) || !navigator.wakeLock) { if (!settings.voice) videoWake(); return; } // synchronous: stays inside the tap on iOS
  navigator.wakeLock.request('screen').then(l => {
    if (!wakeWanted()) { l.release().catch(() => {}); return; }
    P.wake = l; WAKE.mode = 'wakelock'; WAKE.err = null; if (wakeVid) wakeVid.pause();
    l.addEventListener('release', () => { if (P.wake === l) { P.wake = null; if (WAKE.mode === 'wakelock') WAKE.mode = 'released'; } });
  }).catch(e => { WAKE.err = e && e.name; if (!settings.voice) videoWake(); });
}
function releaseWake() {
  const l = P.wake; P.wake = null; try { l && l.release().catch(() => {}); } catch (e) {}
  if (wakeVid) { try { wakeVid.pause(); } catch (e) {} }
  WAKE.mode = 'off';
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && playerOpen()) acquireWake(); });
['touchend', 'click'].forEach(t => document.addEventListener(t, () => { if (settings.voice || !playerOpen() || WAKE.mode !== 'video' || !wakeVid || !wakeVid.paused || !wakeWanted() || speaking()) return; wakeVid.muted = true; wakeVid.play().catch(() => {}); }, { capture: true, passive: true }));
function beepFile(freq) {
  const f = BEEP_FILES.reduce((a, b) => Math.abs(b - freq) < Math.abs(a - freq) ? b : a);
  try { let el = beepEls[f]; if (!el) { el = beepEls[f] = new Audio('audio/beep' + f + '.wav'); el.setAttribute('playsinline', ''); } el.muted = false; el.currentTime = 0; const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
}
let lastBeepPath = '';
function beep(freq = 880, ms = 120, vol = 0.25, force = false, droppable = false, overSpeech = false) {
  if (!settings.beeps && !force) return;
  // Countdown ticks are skipped while words are queued or playing. Other beeps wait
  // and play after the line (they are not dropped on a timer, and they do not play over it).
  if (!overSpeech && speechPending() && droppable) { lastBeepPath = 'dropped'; return; }
  if (!overSpeech && speechPending()) { SPQ.heldBeep = { args: [freq, ms, vol, force, false, overSpeech], at: Date.now() }; lastBeepPath = 'held'; return; }
  SPQ.beepUntil = Math.max(SPQ.beepUntil, Date.now() + ms + 40);
  const c = audioCtx();
  if (c && c.state === 'running') {
    try {
      const o = c.createOscillator(), g = c.createGain(), t0 = c.currentTime;
      o.frequency.value = freq; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.005); g.gain.setValueAtTime(vol, t0 + ms / 1000 - 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
      o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + ms / 1000 + 0.02); lastBeepPath = 'webaudio';
      return;
    } catch (e) {}
  }
  if (settings.voice && playerOpen()) { lastBeepPath = 'skipped-html'; return; } // an <audio> beep pauses speech for the rest of the workout
  resumeAudio(); beepFile(freq); lastBeepPath = 'html';
}
/* Speech (v25). One chain, one utterance at a time.
   On iOS Safari a speak() from the workout timer is ignored (no onstart) unless it runs
   inside the Start tap or inside onend of an utterance that itself started there.
   After a line ends, paused stays true and the next speak() sits in the queue forever.
   resume() in the SAME turn as speak() drops that utterance — v24 did exactly that, so
   names after the first one stayed silent. An <audio> element (silence loop, beep file,
   wake video) also pauses the engine and leaves it paused.
   The Start tap speaks the first line directly. Every later line is spoken from the
   previous onend. Between lines a paused one-word hold keeps the chain alive and is
   not heard. resume() is only scheduled on a later turn, to release a hold or a line
   iOS queued while paused. Beeps play after the words. Utterances stay referenced so
   iOS does not collect them mid-sentence. */
const SPQ = { q: [], cur: null, t0: 0, keep: [], heldBeep: null, beepUntil: 0, notBefore: 0, timer: null, log: [], cancels: 0, gestureUntil: 0, voice: null };
const speaking = () => !!SPQ.cur;
const audible = () => !!(SPQ.cur && !SPQ.cur.hold);
const speechPending = () => audible() || SPQ.q.some(x => !x.low);
const SPEECH_LEAD = { text: ', ', resumeDelayMs: 0 };
const speechCap = text => Math.min(12000, 800 + 90 * String(text).length);
function pickVoice() {
  try {
    const vs = ('speechSynthesis' in window) ? (speechSynthesis.getVoices() || []) : [];
    SPQ.voice = vs.find(v => v.localService && /^en/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
  } catch (e) { SPQ.voice = null; }
  return SPQ.voice;
}
if ('speechSynthesis' in window) { try { speechSynthesis.getVoices(); speechSynthesis.addEventListener('voiceschanged', pickVoice); } catch (e) {} }
function quietMedia() {
  try { if (silentEl && !silentEl.paused) silentEl.pause(); } catch (e) {}
  try { if (wakeVid && !wakeVid.paused) wakeVid.pause(); } catch (e) {}
  try { Object.values(beepEls).forEach(el => { if (el && !el.paused) el.pause(); }); } catch (e) {}
}
function say(text, opt = false) {
  const o = typeof opt === 'object' ? opt : { force: !!opt }, low = o.prio === 'low';
  if ((!settings.voice && !o.force) || !('speechSynthesis' in window) || !text) return false;
  if (SPQ.q.some(x => x.text === text) || (SPQ.cur && !SPQ.cur.hold && SPQ.cur.raw === text)) return false;
  SPQ.q.push({ text, low, step: P.i, at: Date.now(), tries: o.tries || 0 });
  if (SPQ.q.length > 6) { const drop = SPQ.q.findIndex(x => x.low); if (drop >= 0) SPQ.q.splice(drop, 1); else SPQ.q.shift(); }
  if (SPQ.cur && SPQ.cur.hold) releaseHold();
  else if (!SPQ.cur) pumpSpeech();
  return true;
}
function releaseHold() {
  const u = SPQ.cur;
  if (!u || !u.hold) return;
  u.releaseAsked = true;
  if (!u.parked) return; // onstart parks first, then releases on a later turn than speak()
  setTimeout(() => {
    if (SPQ.cur !== u) return;
    try { speechSynthesis.resume(); } catch (e) {}
    // If resume never finishes the hold, cancel it. onerror/onend is still inside the
    // speech callback, so the queued name or cue is spoken on that chain — not from a timer.
    setTimeout(() => {
      if (SPQ.cur !== u || !SPQ.q.length) return;
      try { speechSynthesis.cancel(); } catch (e) {}
      setTimeout(() => { if (SPQ.cur === u) finishUtterance(u); }, 180);
    }, 500);
  }, 0);
}
function pumpSpeech() {
  clearTimeout(SPQ.timer); SPQ.timer = null;
  if (SPQ.cur || !SPQ.q.length) return;
  const wait = SPQ.notBefore - Date.now();
  if (wait > 0 && Date.now() > (SPQ.gestureUntil || 0)) { SPQ.timer = setTimeout(pumpSpeech, wait + 5); return; }
  const it = SPQ.q.shift();
  if (it.low && it.step !== P.i) return pumpSpeech();
  speakNow(it.text, false, it.tries || 0);
}
function speakNow(text, hold, tries) {
  if (!('speechSynthesis' in window)) return;
  quietMedia();
  let u;
  try {
    u = new SpeechSynthesisUtterance(hold ? ' ' : (SPEECH_LEAD.text + text));
    u.raw = hold ? '' : text; u.hold = !!hold; u.tries = tries || 0; u.rate = hold ? 1.5 : 1.02; u.volume = 1; u.lang = 'en-US';
    try { const v = pickVoice(); if (v) u.voice = v; } catch (e) {}
    u.onstart = () => {
      u.started = true;
      if (!u.hold) return;
      try { speechSynthesis.pause(); } catch (e) {}
      u.parked = true; u.parkedAt = Date.now();
      if (u.releaseAsked || SPQ.q.length) releaseHold();
    };
    u.onend = () => finishUtterance(u);
    u.onerror = () => finishUtterance(u);
    SPQ.cur = u; SPQ.t0 = Date.now(); SPQ.keep.push(u); if (SPQ.keep.length > 8) SPQ.keep.shift();
    speechSynthesis.speak(u);
    // Later turn only. resume() before this function returns drops the utterance on iOS.
    setTimeout(() => { if (SPQ.cur === u && !u.started && speechSynthesis.paused) { try { speechSynthesis.resume(); } catch (e) {} } }, 0);
    armWatch(u);
  } catch (e) { if (u && SPQ.cur === u) SPQ.cur = null; }
}
function armWatch(u) {
  const cap = u.hold ? 2000 : speechCap(u.raw || '') + 600;
  const wd = () => {
    if (SPQ.cur !== u) return;
    if (u.hold && u.parked && !u.releaseAsked && !SPQ.q.length) return;
    if (!u.started && speechSynthesis.paused) { try { speechSynthesis.resume(); } catch (e) {} }
    if (!u.started && Date.now() - SPQ.t0 > 700) {
      const text = u.raw, tries = (u.tries || 0) + 1;
      SPQ.cur = null;
      try { speechSynthesis.cancel(); SPQ.cancels++; } catch (e) {}
      if (text && tries <= 2) SPQ.q.unshift({ text, low: false, step: P.i, at: Date.now(), tries });
      SPQ.notBefore = 0;
      setTimeout(() => { if (!SPQ.cur) pumpSpeech(); }, 0);
      return;
    }
    if (!u.hold && u.started && Date.now() - SPQ.t0 > cap) { finishUtterance(u); return; }
    setTimeout(wd, 250);
  };
  setTimeout(wd, 280);
}
function finishUtterance(u) {
  if (!u || u.done || SPQ.cur !== u) return;
  u.done = true; SPQ.cur = null; SPQ.keep = SPQ.keep.filter(x => x !== u);
  if (!u.hold && u.raw) SPQ.log.push({ text: u.raw, end: Date.now() });
  drainSpeech();
}
function drainSpeech() {
  if (SPQ.cur) return;
  if (SPQ.q.length) { pumpSpeech(); return; }
  flushBeep();
  if (settings.voice && playerOpen() && !P.paused) startHold();
}
function startHold() {
  if (SPQ.cur || SPQ.q.length || !settings.voice || !playerOpen() || P.paused) return;
  speakNow('', true, 0);
}
function flushBeep() {
  if (!SPQ.heldBeep || speechPending()) return;
  const b = SPQ.heldBeep; SPQ.heldBeep = null; beep(...b.args);
}
function speechNewStep() { SPQ.q = []; SPQ.heldBeep = null; }
function speechStop() {
  SPQ.q = []; SPQ.heldBeep = null; clearTimeout(SPQ.timer); SPQ.timer = null;
  const u = SPQ.cur; SPQ.cur = null;
  if (!('speechSynthesis' in window)) return;
  if (u || speechSynthesis.speaking || speechSynthesis.pending) {
    try { speechSynthesis.cancel(); SPQ.cancels++; } catch (e) {}
    if (Date.now() > (SPQ.gestureUntil || 0)) SPQ.notBefore = Date.now() + 160;
  }
}
// Any tap re-opens the iOS gesture window and restarts the chain if it died.
document.addEventListener('pointerdown', () => {
  SPQ.gestureUntil = Date.now() + 1200;
  if (!playerOpen() || !settings.voice || SPQ.cur || P.paused) return;
  if (SPQ.q.length) pumpSpeech(); else if (P.steps && P.steps.length) startHold();
}, true);

/* ---------- player ---------- */
const P = { sets: {}, steps: [], i: 0, end: 0, left: 0, paused: false, timer: null, started: 0, lastBeep: -1, wake: null, halfSaid: false, cueOff: {}, cueSaid: 0, tk: '' };
/* Form cues rotate across sessions: each session starts one cue further along per exercise
   (last offset kept in localStorage gc_cueidx), and each round within a session shows the next pair. */
function assignCueOffsets(steps) {
  const store = LS.get('gc_cueidx', {}); const off = {};
  for (const s of steps) if (s.type === 'work' && s.ex.formCues && !(s.ex.id in off)) {
    const n = s.ex.formCues.length; off[s.ex.id] = ((store[s.ex.id] ?? -1) + 1) % n; store[s.ex.id] = off[s.ex.id];
  }
  LS.set('gc_cueidx', store); return off;
}
function cuesFor(ex, round = 1) {
  const c = ex && ex.formCues; if (!c || !c.length) return [];
  const b = (P.cueOff[ex.id] || 0) + (round - 1) * 2;
  return c.length > 1 ? [c[b % c.length], c[(b + 1) % c.length]] : [c[0]];
}
async function startWorkout() {
  SPQ.gestureUntil = Date.now() + 1500;
  unlockAudio(); // must run synchronously in the tap, before any await (iOS). Does not speak.
  warmAudio();
  P.steps = buildSteps(today); P.i = 0; P.started = Date.now(); P.sets = {}; P.paused = false; P.cueOff = assignCueOffsets(P.steps);
  P.ovh = ovhPerSet(); P.est = estSec(today, P.ovh); P.tl = []; P.prevI = null; P.stepT0 = 0; P.maxI = 0; P.pausedMs = 0; P.pauseT = 0; P.timingSaved = false;
  $('#player').classList.remove('hidden');
  enterStep(); // first announcement is inside this tap, before the wake video can take the audio session
  acquireWake(); // keep the screen on (Wake Lock API; the video fallback stays off while voice is on)
  clearInterval(P.timer); P.timer = setInterval(tick, 200);
}
function logStepFor(i) { const s = P.steps[i], pw = P.steps[i - 1]; if (!s || s.type !== 'rest' || !pw || pw.type !== 'work') return null; const b = today.blocks.find(b => b.name === pw.block); return b && loggable(pw.ex, b.kind) ? pw : null; }
// First loggable exercise of this round, once the short switch after it has passed.
// The switch itself already shows that log, so it is not offered there.
function prevWork(i = P.i) {
  const s = P.steps[i]; if (!s) return null;
  let block = s.block, round = s.round, kind = s.kind;
  if (s.type !== 'work') {
    const pw = P.steps[i - 1]; if (!pw || pw.type !== 'work') return null;
    block = pw.block; round = pw.round; kind = pw.kind;
  }
  if (kind === 'warmup' || kind === 'cooldown') return null;
  let first = null;
  for (let k = 0; k < i; k++) {
    const st = P.steps[k];
    if (st.type === 'work' && st.block === block && st.round === round) { first = st; break; }
  }
  if (!first) return null;
  const logging = s.type === 'rest' ? logStepFor(i) : s.type === 'work' ? s : null;
  if (logging && setKey(logging) === setKey(first)) return null;
  const b = today.blocks.find(x => x.name === first.block);
  return b && loggable(first.ex, b.kind) ? first : null;
}
function setLogHTML(pw, opt = {}) {
  const id = opt.id || 'setlog';
  const v = P.sets[setKey(pw)] || setPrefill(pw), e = pw.ex, bw = isBW(e);
  const note = opt.prev ? ((P.steps[P.i] && P.steps[P.i].type === 'work') ? 'This exercise keeps going · Save stays here' : 'Rest keeps running · Save stays on this screen') : slmText(pw);
  return `<div class="setlog" id="${id}"><div class="slh"><b>${opt.head || `Log set ${pw.round}/${pw.rounds}`}</b> · ${esc(e.name)}</div>
    <div class="stps"><div class="stp"><button type="button" data-d="w-1" aria-label="less weight">−</button><div class="v"><b>${v.w ? (e.kb && e.kb.mode === 'double' ? '2×' : '') + v.w : bw ? 'BW' : '—'}</b><small>${bw ? (v.w ? '+lb' : 'bodyweight') : 'lb'}</small></div><button type="button" data-d="w1" aria-label="more weight">+</button></div>
    <div class="stp"><button type="button" data-d="r-1" aria-label="fewer reps">−</button><div class="v"><b>${v.r || '—'}</b><small>reps</small></div><button type="button" data-d="r1" aria-label="more reps">+</button></div></div>
    <button type="button" class="savebtn" data-save="1">${opt.save || '✓ Save'}</button>
    <div class="mut slm">${note}</div></div>`;
}
function prevLogBlock(st) {
  if (!st) return '';
  if (P.logPrev) return setLogHTML(st, { id: 'setlogPrev', head: 'Log previous', save: '✓ Save previous', prev: true })
    + `<button type="button" class="logprev sub" id="bLogPrevBack">Back to this exercise</button>`;
  const v = P.sets[setKey(st)], saved = v && !v.auto;
  return `<button type="button" class="logprev" id="bLogPrev"><b>${saved ? 'Edit previous' : 'Log previous'}</b><small>${esc(st.ex.name)}${saved ? ' · ' + esc(setText(st.ex, v)) : ''} · ${saved ? 'tap to change' : 'missed it on the switch · this round keeps going'}</small></button>`;
}
function slmText(pw) {
  const st = P.steps[P.i] || {}, saved = P.sets[setKey(pw)] && !P.sets[setKey(pw)].auto;
  if (P.done && P.done.i === P.i - 1 && !saved) return 'Set done early ✓ · enter weight/reps, then Save' + (st.sw ? ' (± pauses the timer)' : '');
  if (st.sw) return P.paused ? (saved ? '✓ Saved · ' : '') + 'Timer paused while you log · Save resumes it' : 'Tap ± to log (timer pauses) · or log it on the next rest';
  return saved ? '✓ Saved · rest keeps running' : 'Rest keeps running · Save keeps it running · ⏭ skips';
}
function wireSetLog(pw, opt = {}) {
  const box = document.getElementById(opt.id || 'setlog'); if (!box) return;
  box.querySelectorAll('button[data-d]').forEach(b => b.onclick = () => {
    const cur = P.sets[setKey(pw)] || setPrefill(pw); let w = cur.w, r = cur.r; const d = b.dataset.d;
    if (d[0] === 'w') w = stepWeight(pw.ex, w, +d.slice(1)); else r = Math.max(0, (Number(r) || 0) + +d.slice(1)) || null;
    recordSet(pw, w, r, false);
    const st = P.steps[P.i]; if (!opt.prev && st && st.sw && !P.paused) { P.paused = true; P.logHold = true; render(); return; } // 10 s switch: don't rush the logging
    box.outerHTML = setLogHTML(pw, opt); wireSetLog(pw, opt);
  });
  const sv = box.querySelector('[data-save]'); if (sv) sv.onclick = () => opt.prev ? savePrevious(pw) : saveAndNext(pw);
}
// v18 Save: store the set and collapse the log form. The rest/switch timer keeps running to its end (only ⏭ Skip cuts it
// short). If the timer was held for logging during a 10 s switch, it resumes from where it was.
function saveAndNext(pw) {
  const cur = P.sets[setKey(pw)] || setPrefill(pw); recordSet(pw, cur.w, cur.r, false); P.saved = (P.saved || 0) + 1;
  unlockAudio(); P.logClosed = P.i;
  if (P.paused && P.logHold) { P.paused = false; P.end = Date.now() + P.left * 1000; if (P.pauseT) { P.pausedMs = (P.pausedMs || 0) + Date.now() - P.pauseT; P.pauseT = 0; } }
  P.logHold = false;
  render();
}
// Save the first exercise of this round without leaving the current step or moving the timer.
function savePrevious(pw) {
  const cur = P.sets[setKey(pw)] || setPrefill(pw); recordSet(pw, cur.w, cur.r, false); P.saved = (P.saved || 0) + 1;
  unlockAudio(); P.logPrev = false;
  render();
}
function savedLineHTML(pw) {
  const v = P.sets[setKey(pw)]; if (!v) return '';
  return `<div class="savedline" id="savedLine">✓ Saved ${esc(pw.ex.name)}: ${esc(setText(pw.ex, v))} <button type="button" class="lnk" id="bEditSet">edit</button></div>`;
}
/* Actual time per step (wall clock incl. pauses/logging) vs planned, recorded from v16 on (calibrates OVH). */
function stampStep() {
  const now = Date.now();
  if (P.prevI != null && P.stepT0 && P.steps[P.prevI]) { const s = P.steps[P.prevI];
    P.tl.push({ i: P.prevI, t: s.type === 'work' ? (isLiftStep(s) ? 'set' : 'move') : s.type === 'prep' ? 'prep' : s.setup ? 'setup' : s.sw ? 'switch' : 'rest', id: s.ex ? s.ex.id : undefined, plan: s.dur, act: Math.round((now - P.stepT0) / 1000) }); }
  P.prevI = P.i; P.stepT0 = now; P.maxI = Math.max(P.maxI || 0, P.i);
}
// One record per session (finished or ended early): planned seconds of the part he got through vs real elapsed.
function recordTiming(ended) {
  if (P.timingSaved || !P.started || !P.steps.length) return null;
  const reach = ended === 'finish' ? P.steps.length : Math.min(P.i, P.steps.length), done = P.steps.slice(0, reach);
  const actualSec = Math.round(((ended === 'finish' ? Date.now() : P.stepT0 || Date.now()) - P.started) / 1000);
  const rec = { date: new Date().toISOString(), day: today.day, minutes: settings.minutes, ended, plannedSec: done.reduce((a, x) => a + x.dur, 0), actualSec,
    sets: done.filter(isLiftStep).length, pausedSec: Math.round((P.pausedMs || 0) / 1000), ovhUsed: P.ovh, estSec: today.totalSec,
    blocksDone: new Set(done.filter(isLiftStep).map(s => s.block)).size, blocksTotal: today.blocks.filter(b => b.kind === 'main' || b.kind === 'finisher').length, steps: (P.tl || []).slice(-250) };
  if (actualSec < 120) return null;
  const T = LS.get('gc_timing', []); T.push(rec); LS.set('gc_timing', T.slice(-20)); P.timingSaved = true; return rec;
}
function enterStep() {
  stampStep();
  const s = P.steps[P.i]; if (!s) return finish(); if ($('#pv')) closePreview(true);
  speechNewStep();
  P.end = Date.now() + s.dur * 1000; P.left = s.dur; P.lastBeep = -1; P.halfSaid = false; P.sideSaid = false; P.cueSaid = 0; P.tk = '';
  P.setupSaid = !(s.setup && s.restPart); // a combined rest+setup step announces "Set up" when the prep window starts
  P.logPrev = false;
  // Speak first, then beep. The beep waits in SPQ.heldBeep until the words finish,
  // and the name is not delayed onto a timer (that left the Start tap and iOS dropped it).
  if (s.type === 'work') { say(perSide(s.ex) ? s.ex.name + '. Both sides.' : s.ex.name); beep(1200, 350); }
  else if (s.type === 'rest') { const pw = logStepFor(P.i); if (pw && !P.sets[setKey(pw)] && P.skipped !== P.i - 1) { const v = setPrefill(pw); recordSet(pw, v.w, v.r, true); } say(s.transition ? (s.next ? 'Next, ' + s.next.ex.name : '') : s.sw ? 'Switch. ' + (s.next ? s.next.ex.name : '') : s.setup ? (s.restPart ? 'Rest.' + (s.next ? ' Next group, ' + s.next.ex.name : '') : 'Set up. ' + (s.next ? 'Next, ' + s.next.ex.name : '')) : 'Rest.' + (s.next ? ' Next, ' + s.next.ex.name : '')); beep(500, 250); }
  else if (s.type === 'prep') say('Get ready. First up, ' + s.ex.name);
  render();
}
function tick() {
  if (P.paused) return;
  const s = P.steps[P.i]; if (!s) return;
  const left = Math.max(0, (P.end - Date.now()) / 1000); P.left = left;
  const sec = Math.ceil(left);
  if (sec <= 3 && sec >= 1 && sec !== P.lastBeep) { P.lastBeep = sec; beep(880, 110, 0.25, false, true); }
  if (s.type === 'work' && switchesSides(s.ex) && !P.sideSaid && (s.dur - left) >= s.dur / 2) {
    P.sideSaid = true; say('Switch sides'); beep(1000, 160, 0.35); // beep waits until the words finish
  }
  if (s.setup && s.restPart && !P.setupSaid && left <= s.setupPart) { P.setupSaid = true; say(s.next ? 'Set up. Next, ' + s.next.ex.name : 'Set up.'); beep(700, 140); }
  if (s.type === 'work') { // speak a form cue a few seconds in, and a second one past the midpoint on longer sets
    const el = s.dur - left, cs = cuesFor(s.ex, s.round), sw = perSide(s.ex);
    if (P.cueSaid === 0 && cs[0] && el >= 4 && left > 4) { if (say(cs[0])) P.cueSaid = 1; }
    else if (P.cueSaid === 1 && cs[1] && s.dur >= 30 && el >= s.dur / 2 + (sw ? 3 : 0) && left > 5) { if (say(cs[1])) P.cueSaid = 2; }
  }
  if (s.type === 'rest' && !s.transition && s.dur >= 20 && !P.halfSaid && left <= 10 && left > 9) { P.halfSaid = true; say('10 seconds', { prio: 'low' }); beep(700, 120); }
  if (left <= 0) { P.i++; enterStep(); return; }
  renderTime();
}
function togglePause() {
  if (P.paused) { P.end = Date.now() + P.left * 1000; P.paused = false; if (P.pauseT) P.pausedMs = (P.pausedMs || 0) + Date.now() - P.pauseT; P.pauseT = 0; } else { P.paused = true; P.pauseT = Date.now(); }
  acquireWake(); // screen stays on while paused too; re-acquire if iOS dropped it
  render();
}
// Demo videos open in a new tab / the YouTube app; the workout timer is paused first so nothing runs on while watching.
function openDemo(url) {
  if (!P.paused) { P.paused = true; speechNewStep(); render(); }
  window.open(url, '_blank', 'noopener');
}
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const demoLink = (e, cls, label) => e.demoUrl ? `<a class="demo ${cls}" href="${e.demoUrl}" target="_blank" rel="noopener" data-demo="${e.id}" title="${esc((e.demoTitle || '') + (e.demoChannel ? ' · ' + e.demoChannel : ''))}">${label}</a>` : '';
// Player swap targets the exercise on screen: the current one during work, the upcoming one during get-ready/rest.
function playerSwap(avoid) {
  const s = P.steps[P.i]; const tgt = s && (s.type === 'work' ? s.ex : s.next && s.next.ex); const slot = tgt && findSlot(tgt); if (!slot) return;
  if (!avoid) { openSwap(...slot); return; }
  const ni = avoidAndSwap(...slot); if (!ni) return;
  if (s.type === 'work') { P.cueSaid = 0; say(ni.name); } else say('Next up, ' + ni.name);
  render();
}
function afterSwap(ni) {
  if (!ni) return;
  if (playerOpen()) {
    const s = P.steps[P.i];
    if (s && s.type === 'work' && s.ex && s.ex.id === ni.id) { P.cueSaid = 0; say(ni.name); }
    else if (s && s.type !== 'work') say('Next up, ' + ni.name);
    render();
  } else renderToday();
}
function openSwap(bi, ii) {
  closeSwap(true);
  const w = today, cur = w.blocks[bi] && w.blocks[bi].items[ii]; if (!cur) return;
  const orig = byId(cur.origId || cur.id);
  const ids = slotCandidates(w, bi, ii);
  const curated = new Set([orig.id, ...(orig.alternates || [])]);
  const ov = document.createElement('div'); ov.id = 'swapov';
  ov.innerHTML = `<div class="pvsheet" id="swapSheet" role="dialog" aria-modal="true" aria-labelledby="swapTitle">
    <div class="pvgrab" aria-hidden="true"></div>
    <div class="pvhead"><div><div class="pvblk">${esc(w.blocks[bi].name)}</div><h2 id="swapTitle">Swap exercise</h2><div class="mut">Same slot · no setup clash</div></div>
      <button type="button" class="pvx" id="swapClose" aria-label="Close swap">✕</button></div>
    <div class="swaplist">${ids.map(id => { const e = byId(id), on = id === cur.id, extra = !curated.has(id);
      return `<button type="button" class="swapopt${on ? ' on' : ''}" data-id="${id}"><img src="${(e.image || [])[0] || ''}" alt="">
        <span><b>${esc(e.name)}</b><small>${on ? 'Current' : extra ? 'Also fits this slot' : 'Backup'}${e.equipment ? ' · ' + esc(e.equipment.join(', ')) : ''}</small></span></button>`; }).join('')}</div>
  </div>`;
  document.body.appendChild(ov); requestAnimationFrame(() => ov.classList.add('on'));
  $('#swapClose').onclick = () => closeSwap();
  ov.addEventListener('click', ev => { if (ev.target === ov) closeSwap(); });
  ov.querySelectorAll('.swapopt').forEach(b => b.onclick = () => { const id = b.dataset.id; closeSwap(true); if (id === cur.id) return; afterSwap(doSwap(bi, ii, 'swap', id)); });
  document.addEventListener('keydown', swapKey);
}
function swapKey(ev) { if (ev.key === 'Escape') closeSwap(); }
function closeSwap(now) {
  const ov = $('#swapov'); document.removeEventListener('keydown', swapKey); if (!ov) return;
  if (now) { ov.remove(); return; }
  ov.classList.remove('on'); setTimeout(() => ov.remove(), 220);
}
// ⏭ Skip = move on WITHOUT logging (a skipped work set is not auto-recorded). Done ✓ = finished the set early -> log it now.
function skip(d = 1) { speechStop(); const s = P.steps[P.i]; P.skipped = d > 0 && s && s.type === 'work' ? P.i : null; P.done = null; P.i = Math.max(0, P.i + d); enterStep(); }
function doneEarly() {
  const s = P.steps[P.i]; if (!s || s.type !== 'work') return;
  unlockAudio(); P.done = { i: P.i, left: Math.round(P.left) }; P.skipped = null; P.paused = false; P.logHold = false; P.i++; enterStep();
}
// Sets he actually confirmed (the +/- log). Auto-filled rest defaults are kept only when nothing was confirmed.
function sessionSets(confirmed) {
  const all = Object.values(P.sets || {}).filter(x => x && (x.w || x.r)).sort((a, b) => a.t - b.t);
  if (!confirmed) return all;
  const exp = all.filter(x => !x.auto);
  return exp.length ? exp : all;
}
function partialExerciseIds() {
  const ids = [], seen = new Set();
  const add = id => { if (id && !seen.has(id)) { seen.add(id); ids.push(id); } };
  sessionSets(true).forEach(x => add(x.id));
  (P.steps || []).slice(0, P.i + 1).forEach(s => {
    if (s.type === 'work' && s.kind !== 'warmup' && s.kind !== 'cooldown') add(s.ex && s.ex.id);
  });
  return ids;
}
function dropSessionLogs() {
  const sid = P.started; if (!sid) return;
  Object.keys(setLog).forEach(id => {
    setLog[id] = (setLog[id] || []).filter(x => x.s !== sid);
    if (!setLog[id].length) delete setLog[id];
  });
  LS.set('gc_setlog', setLog);
}
// End workout in the middle: Save keeps the work and counts the day. Discard is a test run.
function quit() { openEndChoice(); }
function openEndChoice() {
  if (!playerOpen() || $('#endov')) return;
  P.endAsk = { wasPaused: !!P.paused };
  if (!P.paused) { P.paused = true; P.pauseT = Date.now(); }
  const n = Object.values(P.sets || {}).filter(x => x && !x.auto && (x.w || x.r)).length, day = today ? today.day : 'This day';
  const ov = document.createElement('div'); ov.id = 'endov';
  ov.innerHTML = `<div class="pvsheet" id="endSheet" role="dialog" aria-modal="true" aria-labelledby="endTitle">
    <div class="pvgrab" aria-hidden="true"></div>
    <div class="pvhead"><div><h2 id="endTitle">End workout?</h2><div class="mut">${esc(day)} · partway through</div></div>
      <button type="button" class="pvx" id="endClose" aria-label="Keep going">✕</button></div>
    <div class="endacts">
      <button type="button" class="pri" id="endSave">Save</button>
      <div class="mut">You worked out and ran out of time. Keeps ${n ? n + ' logged set' + (n === 1 ? '' : 's') : 'what you logged'} and marks ${esc(day)} done for this cycle.</div>
      <button type="button" id="endDiscard">Discard</button>
      <div class="mut">You were just testing. Throws this session away. ${esc(day)} stays up next, and these weights are not kept.</div>
      <button type="button" id="endBack">Keep going</button>
    </div></div>`;
  document.body.appendChild(ov); requestAnimationFrame(() => ov.classList.add('on'));
  $('#endSave').onclick = () => savePartial();
  $('#endDiscard').onclick = () => discardSession();
  $('#endBack').onclick = () => closeEndChoice();
  $('#endClose').onclick = () => closeEndChoice();
  ov.addEventListener('click', ev => { if (ev.target === ov) closeEndChoice(); });
  document.addEventListener('keydown', endKey);
}
function endKey(ev) { if (ev.key === 'Escape') closeEndChoice(); }
function closeEndChoice(now) {
  const ov = $('#endov'); document.removeEventListener('keydown', endKey);
  const ask = P.endAsk; P.endAsk = null;
  if (ask && !ask.wasPaused && playerOpen()) {
    P.paused = false; P.end = Date.now() + (P.left || 0) * 1000;
    if (P.pauseT) { P.pausedMs = (P.pausedMs || 0) + Date.now() - P.pauseT; P.pauseT = 0; }
  }
  if (!ov) { if (playerOpen()) render(); return; }
  if (now) { ov.remove(); if (playerOpen()) render(); return; }
  ov.classList.remove('on'); setTimeout(() => { ov.remove(); if (playerOpen()) render(); }, 220);
}
function savePartial() {
  const ov = $('#endov'); if (ov) { document.removeEventListener('keydown', endKey); ov.remove(); }
  P.endAsk = null;
  if (!P.started || history.some(h => h.s === P.started)) { stopPlayer(); today = generate(); renderToday(); return; }
  stampStep();
  const timing = recordTiming('quit'); P.timingRec = timing;
  const mins = Math.max(1, Math.round((Date.now() - P.started) / 60000));
  const sets = sessionSets(true).map(x => ({ id: x.id, block: x.block, round: x.round, weight: x.w, reps: x.r }));
  const last = {}; sets.forEach(x => { last[x.id] = x; });
  const log = Object.values(last).map(x => ({ id: x.id, weight: x.weight || '', reps: x.reps || '', feel: 'good' }));
  history.push({ date: new Date().toISOString(), day: today.day, dayIndex: today.dayIndex, split: settings.daysPerWeek, minutes: mins, s: P.started, finished: false, partial: true,
    timing: timing ? { plannedSec: timing.plannedSec, actualSec: timing.actualSec, sets: timing.sets, estSec: timing.estSec } : undefined,
    exerciseIds: partialExerciseIds(), swaps: netSwaps(), swapTaps: (today.swaps || []).length, log, sets });
  LS.set('gc_history', history); localStorage.removeItem('gc_swaps'); localStorage.removeItem('gc_daypick'); dayPick = null; shuffleN = 0;
  const dayName = today.day;
  stopPlayer(); today = generate(); renderToday();
  toast(dayName + ' saved. It counts for this cycle.');
}
function discardSession() {
  const ov = $('#endov'); if (ov) { document.removeEventListener('keydown', endKey); ov.remove(); }
  P.endAsk = null;
  dropSessionLogs();
  P.sets = {};
  stopPlayer(); today = generate(); renderToday();
  toast('Discarded. This day is still up next.');
}
function stopPlayer() {
  clearInterval(P.timer); $('#player').classList.add('hidden');
  releaseWake(); speechStop(); stopKeepAlive();
}
const fmt = s => { s = Math.ceil(s); return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : String(s); };
const repsLabel = e => !e || !e.targetReps ? '' : (perSide(e) ? e.targetReps + ' / side' : e.targetReps + ' reps');
// Combined between-group step is rest first, then a distinct setupPart-second prep window.
const setupNow = s => !!(s && s.setup && (!s.restPart || P.left <= (s.setupPart || 0) + 0.05));
function render() {
  const s = P.steps[P.i]; const el = $('#player'); if (!s) return;
  el.className = (s.type === 'work' ? 'work' : s.type === 'rest' ? 'rest' : '') + (s.setup ? ' setup' : '');
  const nowSetup = setupNow(s);
  const title = s.type === 'work' ? s.ex.name : s.type !== 'rest' ? 'Get ready' : nowSetup ? 'Set up · next group' : (s.setup && s.restPart ? 'Rest · next group' : s.label);
  const phaseName = (s.type === 'work' ? 'Work' : s.type !== 'rest' ? 'Prepare' : nowSetup ? 'Set up' : s.sw ? 'Switch' : 'Rest') + (P.paused ? ' · Paused' : '');
  const phaseSub = s.type === 'work' ? (s.ex.cue || s.ex.muscles.join(', ')) : nowSetup ? `Set up ${s.setupPart} s · get the next group ready` : (s.setup && s.restPart ? `Rest ${s.restPart} s, then ${s.setupPart} s to set up` : (s.type === 'rest' && !s.transition && !(logStepFor(P.i) && P.logClosed !== P.i) ? `Done: ${esc(s.after)} · breathe, shake it out` : ''));
  const meta = s.type === 'work' ? `${s.block} · Round ${s.round}/${s.rounds}` : s.type === 'rest' && s.next ? `Up next: ${s.next.block} · Round ${s.next.round}/${s.next.rounds}` : s.block || '';
  const sg = s.type === 'work' && suggest(s.ex.id);
  const pwAny = s.type === 'rest' ? logStepFor(P.i) : null, pw = pwAny && P.logClosed !== P.i ? pwAny : null;
  const hist = s.type === 'work' ? recentHistory(s.ex, 3, P.started) : [];
  const nowW = s.type === 'work' ? Object.values(P.sets).filter(x => x.id === s.ex.id).sort((a, b) => a.t - b.t).map(x => setText(s.ex, x)) : [];
  const doneSteps = P.steps.slice(0, P.i).reduce((a, x) => a + x.dur, 0), total = P.steps.reduce((a, x) => a + x.dur, 0);
  el.innerHTML = `
    <div class="row" style="flex:0"><div class="mut">${meta}</div><div class="mut" style="text-align:right">${P.i + 1}/${P.steps.length} · <span id="remT">${minText(remainSec())}</span> left<br><small>of ~${minText(P.est || estSec(today))}</small></div></div>
    <div class="bar"><i style="width:${(100 * doneSteps / total).toFixed(1)}%"></i></div>
    <div class="phase" id="phase">${phaseName}</div>
    <div class="exname"><span id="exTitleText">${title}</span>${s.setup ? `<span class="sutime" id="num2">${fmt(P.left)}</span>` : ''}</div>
    <div class="mut" id="phaseSub">${phaseSub}</div>
    ${prevLogBlock(prevWork())}
    ${pw ? setLogHTML(pw) : pwAny ? savedLineHTML(pwAny) : ''}
    ${s.setup ? setupHTML(s) : ''}
    ${histHTML(hist)}
    ${s.type === 'work' && (nowW.length || (sg && sgText(s.ex, sg))) ? `<div class="lastline">${nowW.length ? `<span>Today: ${nowW.join(', ')}</span>` : ''}${sg && sgText(s.ex, sg) ? `<span>Try ${sgText(s.ex, sg)}</span>` : ''}</div>` : ''}
    ${s.type === 'work' && s.ex.targetReps ? `<div class="target" id="target">${repsLabel(s.ex)}</div>` : ''}
    ${s.type === 'work' ? `<button type="button" class="donebtn" id="bDone">Done ✓<small>${P.steps[P.i + 1] && logStepFor(P.i + 1) ? 'finished early · log this set now' : 'finished early · move on'}</small></button>` : ''}
    ${(() => { if (s.setup) return ''; const ie = s.type === 'work' ? s.ex : (s.ex || (s.next && s.next.ex)); return ie && ie.image ? `<div class="pimg${s.type === 'work' ? '' : ' dim'}${pw ? ' small' : ''}"><img id="pimg" src="${ie.image[0]}" data-f="${ie.image.join('|')}" alt="${ie.name}">${(() => { const sl = findSlot(ie); return sl ? `<div class="swapbar"><button class="swap" id="bSwap" title="Tap: next backup · Hold: avoid permanently">⇄ Swap</button>${ie.origId && ie.origId !== ie.id ? `<button class="avoid" id="bAvoid" title="Never program ${esc(byId(ie.origId).name)} again">🚫 Avoid ${esc(byId(ie.origId).name)}</button>` : ''}</div>` : ''; })()}${ie.demoUrl ? `<a class="demo" id="bDemo" href="${ie.demoUrl}" target="_blank" rel="noopener" title="${esc(ie.demoTitle || '')}">▶ Watch demo</a>` : ''}</div>` : ''; })()}
    ${(() => { if (s.setup) return ''; const cs = s.type === 'work' ? cuesFor(s.ex, s.round) : (s.next && !pw ? cuesFor(s.next.ex, s.next.round).slice(0, 1) : []); return cs.length ? `<div class="cues${s.type === 'work' ? '' : ' dim'}">${s.type === 'work' ? '' : '<b>Next focus:</b> '}${cs.map(c => `<div>• ${c}</div>`).join('')}</div>` : ''; })()}
    <div class="ring"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" stroke="#d9e7f2" stroke-width="7" fill="none"/>
      <circle id="arc" cx="50" cy="50" r="45" stroke="${s.type === 'rest' ? '#1d4ed8' : '#0ea5e9'}" stroke-width="7" fill="none" stroke-linecap="round" stroke-dasharray="282.7" stroke-dashoffset="0"/></svg>
      <div class="n" id="num">${fmt(P.left)}</div></div>
    ${s.setup ? '' : `<div class="next">${s.next ? `${s.next.ex.image ? `<img class="thumb" src="${s.next.ex.image[1]}" alt="">` : ''}<div><div class="mut">Next</div><div style="font-weight:600;font-size:18px">${s.next.ex.name}</div><div class="mut">${repsLabel(s.next.ex) ? repsLabel(s.next.ex) + ' · ' : ''}${s.next.dur}s · ${s.next.ex.equipment.join(', ')}</div></div>` : '<div style="font-weight:600">Last one. Finish strong!</div>'}</div>`}
    <div class="ctrl"><button id="bPrev">⏮</button><button id="bPause" class="pri" style="flex:2">${P.paused ? '▶ Resume' : '⏸ Pause'}</button><button id="bSkip" title="Skip (no log)" aria-label="Skip without logging">⏭</button></div>
    <button id="bQuit" style="margin-top:4px;padding:8px;background:none;color:var(--mut);flex-shrink:0">End workout</button>`;
  $('#bPause').onclick = togglePause; if (pw) wireSetLog(pw);
  const prev = prevWork(), bp = $('#bLogPrev'); if (bp) bp.onclick = () => { unlockAudio(); P.logPrev = true; render(); };
  const bb = $('#bLogPrevBack'); if (bb) bb.onclick = () => { P.logPrev = false; render(); };
  if (P.logPrev && prev) wireSetLog(prev, { id: 'setlogPrev', head: 'Log previous', save: '✓ Save previous', prev: true });
  const be = $('#bEditSet'); if (be) be.onclick = () => { P.logClosed = null; render(); };
  if (pw && s.setup) { const lb = el.querySelector('.setlog, #setLog, form'); if (lb && lb.scrollIntoView && P.logShownI !== P.i) { P.logShownI = P.i; lb.scrollIntoView({ block: 'nearest' }); } }
  const bd = $('#bDemo'); if (bd) bd.onclick = ev => { ev.preventDefault(); openDemo(bd.href); }; $('#bSkip').onclick = () => skip(1); const bdn = $('#bDone'); if (bdn) bdn.onclick = doneEarly;
  el.querySelectorAll('.bpx').forEach(c => { const o = () => { if (+c.dataset.bi >= 0) openPreview(+c.dataset.bi, +c.dataset.ii); }; c.onclick = ev => { if (ev.target.closest('.bpswap')) return; o(); }; c.onkeydown = ev => { if (ev.target.closest('.bpswap')) return; if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); o(); } }; });
  el.querySelectorAll('.bpswap').forEach(b => longPress(b, () => { const ni = avoidAndSwap(+b.dataset.bi, +b.dataset.ii); if (ni) { closeSwap(true); render(); } }, () => openSwap(+b.dataset.bi, +b.dataset.ii)));
  const bs = $('#bSwap'); if (bs) longPress(bs, () => playerSwap(true), () => playerSwap(false));
  const ba = $('#bAvoid'); if (ba) ba.onclick = () => { const s = P.steps[P.i], tgt = s.type === 'work' ? s.ex : s.next && s.next.ex, sl = findSlot(tgt); if (sl) { avoidOriginal(...sl); render(); } }; $('#bPrev').onclick = () => skip(-1); $('#bQuit').onclick = quit;
  renderTime();
}
/* Block preview on the 'Set up · next group' screen: both exercises, big start/end frames, equipment,
   target sets x reps, last session's sets (excluding this session) and today's suggestion. Tap a card -> big preview sheet. */
function setupHTML(s) {
  const bi = today.blocks.findIndex(x => x.name === s.nextBlock), b = today.blocks[bi], items = (b && b.items) || s.nextItems || [];
  const rounds = (b && b.rounds) || s.nextRounds, warm = b && (b.kind === 'warmup' || b.kind === 'cooldown');
  const eq = [...new Set(items.flatMap(e => e.equipment || []))];
  const card = (e, ii) => { const im = e.image || [], last = recentHistory(e, 1, P.started)[0], sg = !warm && suggest(e.id), sgt = sg && sgText(e, sg);
    const tgt = `${rounds} × ${e.targetReps ? repsLabel(e) : fmt(e.work) + (e.work < 60 ? ' s' : '')}`;
    return `<div class="bpx" data-bi="${bi}" data-ii="${ii}" role="button" tabindex="0" aria-label="Preview ${esc(e.name)}">
      <div class="bpn"><span class="bpk">${String.fromCharCode(65 + ii)}</span>${esc(e.name)}<i aria-hidden="true">ⓘ</i></div>
      ${im.length ? `<div class="bpimgs">${[im[0], im[im.length - 1]].filter((x, k, a) => k === 0 || x !== a[0]).map((p, k) => `<figure><img src="${p}" alt="${esc(e.name)} ${k ? 'end' : 'start'}"><figcaption>${k ? 'End' : 'Start'}</figcaption></figure>`).join('')}</div>` : ''}
      <div class="bprow"><small>Target</small><b class="bptgt">${tgt}</b></div>
      <div class="bprow"><small>Last time</small>${last ? `<b class="bplast">${last.txt}</b><span class="bpd">${last.date}</span>` : '<b class="bplast none">No history yet</b>'}</div>
      ${sgt ? `<div class="bprow"><small>Today</small><b class="bptry">try ${sgt}</b></div>` : ''}
      <div class="bpeq">${esc((e.equipment || []).join(', ') || 'no equipment')}</div>
      ${bi >= 0 && !warm ? `<button type="button" class="bpswap" data-bi="${bi}" data-ii="${ii}">⇄ Swap</button>` : ''}</div>`; };
  return `<div class="setupcard bp" id="setupCard"><div class="hh">Next: ${esc(s.nextBlock)} · ${rounds} rounds${items.length > 1 ? ' · superset' : ''}</div>
    <div class="bpl">${items.map(card).join('')}</div>${eq.length ? `<div class="sueq">Set up: ${esc(eq.join(', '))}</div>` : ''}</div>`;
}
function remainSec() { const rest = P.steps.slice(P.i + 1), cur = P.steps[P.i]; return P.left + rest.reduce((a, x) => a + x.dur, 0) + (P.ovh ?? ovhPerSet()) * (rest.filter(isLiftStep).length + (cur && isLiftStep(cur) ? 1 : 0)); }
function renderTime() {
  const s = P.steps[P.i]; if (!s) return;
  const n = $('#num'), a = $('#arc'), n2 = $('#num2'), rt = $('#remT'); if (rt) rt.textContent = minText(remainSec()); if (n) n.textContent = fmt(P.left); if (n2) n2.textContent = fmt(P.left);
  if (s.setup) {
    const now = setupNow(s), ph = $('#phase'), tt = $('#exTitleText'), sub = $('#phaseSub');
    if (ph) ph.textContent = (now ? 'Set up' : 'Rest') + (P.paused ? ' · Paused' : '');
    if (tt) tt.textContent = now ? 'Set up · next group' : (s.restPart ? 'Rest · next group' : 'Set up · next group');
    if (sub) sub.textContent = now ? `Set up ${s.setupPart} s · get the next group ready` : (s.restPart ? `Rest ${s.restPart} s, then ${s.setupPart} s to set up` : `Set up ${s.setupPart} s · get the next group ready`);
  }
  if (a) a.setAttribute('stroke-dashoffset', (282.7 * (1 - P.left / s.dur)).toFixed(1));
  const im = $('#pimg'); // alternate start/end frames every ~1.2s while working
  if (im && !P.paused) { const f = im.dataset.f.split('|'), k = s.type === 'work' ? Math.floor((s.dur - P.left) / 1.2) % f.length : 0; if (!im.src.endsWith(f[k])) im.src = f[k]; }
}
// The day counts as soon as the player finishes — not only after "Save session".
// Otherwise closing the app on the done screen leaves dayPick on Legs and the home
// card still offers Legs. Save later fills in weights on this same row.
function recordCompletion(mins) {
  if (!P.started || history.some(h => h.s === P.started && !h.skipped)) return;
  const sets = Object.values(P.sets || {}).sort((a, b) => a.t - b.t).map(x => ({ id: x.id, block: x.block, round: x.round, weight: x.w, reps: x.r }));
  history.push({ date: new Date().toISOString(), day: today.day, dayIndex: today.dayIndex, split: settings.daysPerWeek, minutes: mins, s: P.started, finished: true,
    timing: P.timingRec ? { plannedSec: P.timingRec.plannedSec, actualSec: P.timingRec.actualSec, sets: P.timingRec.sets, estSec: P.timingRec.estSec } : undefined,
    exerciseIds: today.blocks.flatMap(b => b.items.map(e => e.id)), swaps: netSwaps(), swapTaps: (today.swaps || []).length, log: [], sets });
  LS.set('gc_history', history); localStorage.removeItem('gc_swaps'); localStorage.removeItem('gc_daypick'); dayPick = null; shuffleN = 0;
  P.doneDay = today.day; P.doneIndex = today.dayIndex;
  P.doneSnap = { day: today.day, dayIndex: today.dayIndex, exerciseIds: today.blocks.flatMap(b => b.items.map(e => e.id)), swaps: netSwaps(), swapTaps: (today.swaps || []).length };
  today = generate();
}
function finish() {
  const timing = recordTiming('finish'); P.timingRec = timing;
  const mins = Math.round((Date.now() - P.started) / 60000);
  const dayName = today.day;
  const lifts = today.blocks.filter(b => b.kind === 'main').flatMap(b => b.items);
  recordCompletion(mins);
  stopPlayer(); beep(1320, 500); say('Workout complete. Great job!');
  const tab = $('#tab-today');
  tab.onclick = null; tab.onkeydown = null; closePreview(true);
  tab.innerHTML = `<div class="hero"><div class="t">Done! 🎉</div><div class="s">${dayName} · ${mins} min</div></div>
   <div class="card"><h2 style="margin-top:0">Log your weights</h2><div class="mut">Used for next time's suggestions.</div>
   ${lifts.map(e => { const sg = suggest(e.id), ss = Object.values(P.sets).filter(x => x.id === e.id).sort((a, b) => a.t - b.t), ls = ss[ss.length - 1]; return `<div class="logrow" data-id="${e.id}"><div>${e.name}${e.reps ? `<br><small class="mut">${e.reps[0]}–${e.reps[1]} reps</small>` : ''}${ss.length ? `<br><small class="mut">Sets: ${ss.map(x => setText(e, x)).join(', ')}</small>` : ''}</div>
     <input type="number" class="w" inputmode="decimal" placeholder="${e.kb && e.kb.mode === 'double' ? 'lb/bell' : isBW(e) ? 'BW' : 'lb'}" value="${ls ? (ls.w || '') : sg && sg.weight ? sg.weight : ''}">${e.reps ? `<input type="number" class="r" inputmode="numeric" placeholder="reps" value="${(ls && ls.r) || e.targetReps || (sg && sg.reps) || ''}">` : ''}<select><option value="good">OK</option><option value="easy">Easy</option><option value="hard">Hard</option></select></div>`; }).join('')}
   <button class="pri" id="bSave" style="margin-top:12px">Save session</button></div>`;
  $('#bSave').onclick = () => {
    const log = [...document.querySelectorAll('.logrow')].map(r => ({ id: r.dataset.id, weight: r.querySelector('input.w').value, reps: (r.querySelector('input.r') || {}).value || '', feel: r.querySelector('select').value }));
    saveSession(mins, log); show('history');
  };
}
function saveSession(mins, log) {
  const sets = Object.values(P.sets || {}).sort((a, b) => a.t - b.t).map(x => ({ id: x.id, block: x.block, round: x.round, weight: x.w, reps: x.r }));
  const timing = P.timingRec ? { plannedSec: P.timingRec.plannedSec, actualSec: P.timingRec.actualSec, sets: P.timingRec.sets, estSec: P.timingRec.estSec } : undefined;
  const ex = history.find(h => h.s === P.started && !h.skipped);
  if (ex) { ex.minutes = mins; ex.log = log; ex.sets = sets; if (timing) ex.timing = timing; }
  else { const snap = P.doneSnap || { day: today.day, dayIndex: today.dayIndex, exerciseIds: today.blocks.flatMap(b => b.items.map(e => e.id)), swaps: netSwaps(), swapTaps: (today.swaps || []).length }; history.push({ date: new Date().toISOString(), day: snap.day, dayIndex: snap.dayIndex, split: settings.daysPerWeek, minutes: mins, s: P.started, finished: true, timing, exerciseIds: snap.exerciseIds, swaps: snap.swaps, swapTaps: snap.swapTaps, log, sets }); }
  LS.set('gc_history', history); localStorage.removeItem('gc_swaps'); localStorage.removeItem('gc_daypick'); dayPick = null; shuffleN = 0; today = generate();
}

/* ---------- exercise preview (pre-workout overview): big start/end images + details, never starts the workout ---------- */
function previewHTML(bi, ii) {
  const w = today, b = w.blocks[bi], e = b.items[ii], warm = b.kind === 'warmup' || b.kind === 'cooldown';
  const sg = suggest(e.id), hist = recentHistory(e, 3);
  const bk = nextAlternate(w, bi, ii), bkName = bk ? byId(bk).name : '';
  const vol = `${b.rounds} × ${e.targetReps ? repsLabel(e) : fmt(e.work) + (e.work < 60 ? ' s' : '')}`;
  const volSub = e.targetReps ? (e.reps ? `range ${e.reps[0]}–${e.reps[1]}` : '') : 'timed';
  const rest = warm ? '10 s' : e.rest + ' s', restSub = warm ? 'transition' : b.items.length > 1 ? (ii < b.items.length - 1 ? `after the round · ${clampSwitch()} s switch to next` : 'after the round (both done)') : 'after each round';
  const imgs = e.image || [];
  const st = (k, v, sub) => `<div class="pvst"><small>${k}</small><b>${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  return `<div class="pvsheet" id="pvSheet" role="dialog" aria-modal="true" aria-labelledby="pvTitle">
    <div class="pvgrab" aria-hidden="true"></div>
    <div class="pvhead"><div><div class="pvblk">${esc(b.name)} · workout ~${minText(estSec(w))}${e.origId && e.origId !== e.id ? ` · swapped for ${esc(byId(e.origId).name)}` : ''}</div><h2 id="pvTitle">${esc(e.name)}</h2><div class="mut">${esc(e.muscles.join(', '))}</div></div>
      <button type="button" class="pvx" id="pvClose" aria-label="Close preview">✕</button></div>
    ${imgs.length ? `<div class="pvimgs" id="pvImgs">${imgs.map((p, k) => `<figure><img src="${p}" alt="${esc(e.name)} – ${k ? 'end' : 'start'} position"><figcaption>${k === 0 ? 'Start' : k === imgs.length - 1 ? 'End' : 'Step ' + (k + 1)} position</figcaption></figure>`).join('')}</div>
      ${imgs.length > 1 ? `<div class="pvdots" id="pvDots">${imgs.map((_, k) => `<i class="${k ? '' : 'on'}"></i>`).join('')}<span class="mut">swipe</span></div>` : ''}` : ''}
    <div class="pvstats">
      ${st('Sets × reps', vol, volSub)}
      ${st('Set time', fmt(e.work) + (e.work < 60 ? ' s' : ''), e.targetReps ? 'per set · own pace' : 'per round')}
      ${st('Rest', rest, restSub)}
      ${st('Equipment', esc(e.equipment.join(', ')), e.kb ? `KB ${e.kb.mode === 'double' ? 'pair' : 'single'}` : '')}
    </div>
    <div class="pvlast">${hist.length ? histHTML(hist, 'pvh') : '<div class="mut">Nothing logged yet for this exercise.</div>'}${sg && sgText(e, sg) && !warm ? `<div>Today: try <b>${sgText(e, sg)}</b></div>` : ''}</div>
    ${e.cue ? `<div class="pvcue">${esc(e.cue)}</div>` : ''}
    ${(e.formCues || []).length ? `<h3>Form cues</h3><ul class="pvcues">${e.formCues.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    <div class="pvbk"><span>⇄ Backup swap</span><b>${bkName ? esc(bkName) : 'No backup available'}</b></div>
    ${e.demoUrl ? `<a class="demo pvdemo" href="${e.demoUrl}" target="_blank" rel="noopener">▶ Watch demo video</a>` : ''}
  </div>`;
}
function openPreview(bi, ii) {
  closePreview(true);
  const ov = document.createElement('div'); ov.id = 'pv'; ov.innerHTML = previewHTML(bi, ii); document.body.appendChild(ov);
  document.documentElement.classList.add('pvopen'); requestAnimationFrame(() => ov.classList.add('on'));
  const sh = $('#pvSheet'); $('#pvClose').onclick = () => closePreview();
  ov.addEventListener('click', ev => { if (ev.target === ov) closePreview(); }); // tap outside the sheet
  const im = $('#pvImgs'), dots = $('#pvDots');
  if (im && dots) im.addEventListener('scroll', () => { const k = Math.round(im.scrollLeft / Math.max(1, im.clientWidth)); dots.querySelectorAll('i').forEach((d, j) => d.classList.toggle('on', j === k)); }, { passive: true });
  // swipe down to close (only when the sheet is scrolled to the top and the gesture is mostly vertical)
  let y0 = null, x0 = 0, dy = 0, drag = false;
  sh.addEventListener('touchstart', ev => { if (sh.scrollTop > 0) { y0 = null; return; } y0 = ev.touches[0].clientY; x0 = ev.touches[0].clientX; dy = 0; drag = false; }, { passive: true });
  sh.addEventListener('touchmove', ev => { if (y0 === null) return; const t = ev.touches[0]; dy = t.clientY - y0; const dx = t.clientX - x0;
    if (!drag && dy > 10 && dy > Math.abs(dx) * 1.2) drag = true;
    if (drag) { ev.preventDefault(); sh.style.transition = 'none'; sh.style.transform = `translateY(${Math.max(0, dy)}px)`; } }, { passive: false });
  sh.addEventListener('touchend', () => { if (!drag) { y0 = null; return; } sh.style.transition = ''; if (dy > 110) closePreview(); else sh.style.transform = ''; y0 = null; drag = false; });
  document.addEventListener('keydown', pvKey); $('#pvClose').focus({ preventScroll: true });
}
function pvKey(ev) { if (ev.key === 'Escape') closePreview(); }
function closePreview(now) {
  const ov = $('#pv'); document.removeEventListener('keydown', pvKey); document.documentElement.classList.remove('pvopen'); if (!ov) return;
  if (now) { ov.remove(); return; }
  ov.classList.remove('on'); const sh = $('#pvSheet'); if (sh) { sh.style.transition = ''; sh.style.transform = 'translateY(100%)'; }
  setTimeout(() => ov.remove(), 220);
}

/* ---------- views ---------- */
function renderToday() {
  const w = today; const split = SPLITS[settings.daysPerWeek] || SPLITS[4], cy = cycleState();
  const doneToday = history.some(h => dateKey(new Date(h.date)) === dateKey(new Date()));
  $('#title').textContent = 'Today'; $('#sub').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  $('#tab-today').innerHTML = `
   <div class="hero"><div class="s">Cycle: ${cy.done.length} of ${split.length} done${doneToday ? ' · ✅ trained today' : ''}</div>
     <div class="rot" id="cycleRot">${split.map((d, k) => `<span class="${k === w.dayIndex ? 'on' : ''}${cy.done.includes(k) ? ' dn' : ''}">${cy.done.includes(k) ? '✓ ' : ''}${d.short || d.name}</span>`).join('<i>·</i>')}</div>
     <div class="dpl">Choose today's workout</div>
     <div class="dp" id="dayPick">${cy.remaining.map(k => `<button type="button" data-di="${k}" class="${k === w.dayIndex ? 'on' : ''}" aria-pressed="${k === w.dayIndex}">${esc(split[k].name)}${k === cy.next ? '<small>next in order</small>' : '<small>&nbsp;</small>'}</button>`).join('')}</div>
     <div class="dpo"><button type="button" id="bOtherDay" class="lnk">Other day…</button><span id="otherDays" class="hidden">${split.map((d, k) => `<button type="button" data-di="${k}" class="sm${k === w.dayIndex ? ' on' : ''}">${cy.done.includes(k) ? '✓ ' : ''}${esc(d.name)}</button>`).join('')}</span></div>
     <div class="t">${w.day}</div><div class="s">${w.focus}</div><div class="s nextday">Next workout: <b>${w.nextDay}</b></div>
     <span class="pill" id="estPill">⏱ ~${minText(estSec(w))}</span><span class="pill">${w.blocks.length} blocks</span><span class="pill">${settings.level}</span></div>
   <button class="pri" id="bStart">▶ Start workout</button>
   <div class="mut pvhint">Tap any exercise for a big preview</div>
   ${w.blocks.map(b => `<div class="card block"><div class="bt">${b.name} <span class="mut">· ${b.rounds} round${b.rounds > 1 ? 's' : ''}</span></div>
     ${b.items.map((e, ii) => { const sg = suggest(e.id); const bi = w.blocks.indexOf(b); const sw = e.origId && e.origId !== e.id; return `<div class="ex pv" data-bi="${bi}" data-ii="${ii}" role="button" tabindex="0" aria-label="Preview ${esc(e.name)}">${e.image ? `<img class="thumb" loading="lazy" src="${e.image[0]}" alt="">` : ''}<div style="flex:1">${e.name}<br><small>${repsLabel(e) ? repsLabel(e) + ' · ' : ''}${e.equipment.join(', ')}${sg && sgText(e, sg) ? ' · try ' + sgText(e, sg) : ''}</small>${demoLink(e, 'sm', '▶ Demo')}${e.autoFor ? `<div class="swapnote">🚫 replaces ${esc(byId(e.autoFor).name)} (avoided)</div>` : ''}${sw ? `<div class="swapnote">⇄ for ${esc(byId(e.origId).name)} · <button class="avoid sm" data-bi="${bi}" data-ii="${ii}">🚫 Avoid it</button></div>` : ''}</div><div class="mut" style="text-align:right">${fmt(e.work)}${e.work < 60 ? 's' : ''} / ${e.rest}s<br><button class="swap sm" data-bi="${bi}" data-ii="${ii}" title="Tap: next backup · Hold: avoid permanently">⇄ Swap</button></div></div>`; }).join('')}</div>`).join('')}
   <div class="row" style="margin:10px 0 20px"><button id="bShuffle">🔀 Shuffle exercises</button><button id="bSkipDay">Skip to next day</button></div>`;
  $('#bStart').onclick = startWorkout;
  $('#tab-today').querySelectorAll('#dayPick button, #otherDays button').forEach(b => b.onclick = () => { pickDay(+b.dataset.di); renderToday(); });
  $('#bOtherDay').onclick = () => { $('#otherDays').classList.toggle('hidden'); };
  const tt = $('#tab-today'); // tap a row (not its Swap/Avoid/Demo controls) -> large preview
  tt.onclick = ev => { if (ev.target.closest('button,a,input,select')) return; const r = ev.target.closest('.ex.pv'); if (r) openPreview(+r.dataset.bi, +r.dataset.ii); };
  tt.onkeydown = ev => { const r = ev.target.closest && ev.target.closest('.ex.pv'); if (r && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openPreview(+r.dataset.bi, +r.dataset.ii); } };
  $('#tab-today').querySelectorAll('button.swap').forEach(b => longPress(b, () => { avoidAndSwap(+b.dataset.bi, +b.dataset.ii); renderToday(); }, () => openSwap(+b.dataset.bi, +b.dataset.ii)));
  $('#tab-today').querySelectorAll('button.avoid').forEach(b => b.onclick = () => { avoidOriginal(+b.dataset.bi, +b.dataset.ii); renderToday(); });
  $('#bShuffle').onclick = () => { shuffleN++; today = generate(); renderToday(); };
  $('#bSkipDay').onclick = () => { history.push({ date: new Date().toISOString(), day: today.day + ' (skipped)', dayIndex: today.dayIndex, split: settings.daysPerWeek, minutes: 0, skipped: true, exerciseIds: [], log: [] }); LS.set('gc_history', history); dayPick = null; localStorage.removeItem('gc_daypick'); today = generate(); renderToday(); };
}
function renderHistory() {
  $('#title').textContent = 'History';
  const real = history.filter(h => !h.skipped);
  const wk = real.filter(h => Date.now() - new Date(h.date) < 7 * 864e5).length;
  $('#sub').textContent = `${real.length} workouts · ${wk} this week · ${real.reduce((a, h) => a + h.minutes, 0)} min total`;
  $('#tab-history').innerHTML = real.length ? real.slice().reverse().map(h => `<div class="card"><div style="font-weight:600">${h.day}${h.partial ? ' · partial' : ''}</div>
    <div class="mut">${new Date(h.date).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${h.minutes} min</div>
    ${(h.swaps || []).length ? `<div class="mut" style="font-size:13px;margin:4px 0">${h.swaps.map(x => `${x.reason === 'avoid' ? '🚫' : '⇄'} ${(byId(x.from) || {}).name || x.from} → ${(byId(x.to) || {}).name || x.to}`).join('<br>')}</div>` : ''}
    ${(h.log || []).filter(l => l.weight || l.reps).map(l => { const e = byId(l.id) || { id: l.id, equipment: [] }; const ss = (h.sets || []).filter(x => x.id === l.id); return `<div class="ex"><div>${e.name || l.id}${ss.length ? `<br><small class="mut">${ss.map(x => setText(e, { w: x.weight, r: x.reps })).join(' · ')}</small>` : ''}</div><div class="mut">${lastText(e, l)} · ${l.feel}</div></div>`; }).join('')}</div>`).join('')
    : '<div class="card mut">No workouts yet. Finish one and it shows up here.</div>';
}
function renderLibrary() {
  $('#title').textContent = 'Exercise Library'; $('#sub').textContent = `${available().length} of ${LIB.length} available with your equipment`;
  const cats = ['Chest', 'Shoulders', 'Traps', 'Triceps', 'Back', 'Rear delts', 'Biceps', 'Legs', 'Core', 'Conditioning', 'Mobility'];
  const tl = $('#tab-library'); tl.onclick = ev => { const r = ev.target.closest('.ex.lib'); if (r) $('#det-' + r.dataset.id).classList.toggle('hidden'); };
  tl.onchange = ev => { const sel = ev.target.closest('select.rov'); if (!sel) return; const v = +sel.value; if (v) settings.restOverrides[sel.dataset.id] = v; else delete settings.restOverrides[sel.dataset.id];
    LS.set('gc_settings', settings); today = generate(); const row = tl.querySelector('.ex.lib[data-id="' + sel.dataset.id + '"] .mut'); if (row) row.textContent = byId(sel.dataset.id).work + 's / ' + restFor(byId(sel.dataset.id)) + 's rest ›'; };
  tl.innerHTML = cats.map(c => `<h2>${c}</h2><div class="card">${available().filter(e => (e.group || e.category) === c).map(e => `<div class="ex lib" data-id="${e.id}">${e.image ? `<img class="thumb" loading="lazy" src="${e.image[0]}" alt="">` : ''}<div style="flex:1">${e.name}${settings.avoided.includes(e.id) ? ' <span class="tag">avoided</span>' : ''}<br><small>${e.muscles.join(', ')}${e.reps ? ' · ' + e.reps[0] + '–' + e.reps[1] + ' reps' : ' · timed'}</small></div><div class="mut">${e.work}s / ${restFor(e)}s rest ›</div></div>
      <div class="libdet hidden" id="det-${e.id}">${(e.image || []).map(p => `<img loading="lazy" src="${p}" alt="">`).join('')}
        <div class="mut" style="margin:6px 0 2px">${e.equipment.join(', ')}${e.cue ? ' · ' + e.cue : ''}</div><div class="mut" style="font-size:13px">${e.reps ? `Reps ${e.reps[0]}–${e.reps[1]}${e.startReps ? ` (start at ${e.startReps})` : ''}` : 'Timed'}${e.kb ? ` · KB: ${e.kb.mode === 'double' ? '2×' : ''}${snapKB(e, e.kb.start)} lb to start` : ''}</div>${e.demoUrl ? `<div style="margin:6px 0">${demoLink(e, '', '▶ Watch demo')}<div class="mut" style="font-size:12px;margin-top:4px">${esc(e.demoTitle)} · ${esc(e.demoChannel)}</div></div>` : ''}${e.category !== 'mobility' ? `<div class="restov"><span class="mut" style="font-size:13px">Rest after each set</span><select class="rov" data-id="${e.id}"><option value="">Default (${restFor({ ...e, id: '' })} s)</option>${[20, 30, 45, 60, 75, 90, 120, 150].map(v => `<option value="${v}" ${settings.restOverrides[e.id] === v ? 'selected' : ''}>${v} s</option>`).join('')}</select></div>` : ''}<b>Form cues</b><ul>${(e.formCues || []).map(c => `<li>${c}</li>`).join('')}</ul><div class="mut" style="font-size:13px;margin-bottom:8px"><b>Swap backups:</b> ${(e.alternates || []).map(a => (byId(a) || {}).name || a).join(' → ')}</div></div>`).join('')}</div>`).join('');
}
function renderSettings() {
  $('#title').textContent = 'Settings'; $('#sub').textContent = 'Tune the plan to you';
  const eq = [...new Set(LIB.flatMap(e => e.equipment))].filter(x => x !== 'TRX' && x !== 'rower').sort();
  const kbTxt = (() => { const c = {}; settings.kettlebells.forEach(w => { c[w] = (c[w] || 0) + 1; }); return Object.keys(c).map(Number).sort((a, b) => a - b).map(w => `${c[w]} × ${w} lb`).join(', '); })();
  const nTrx = LIB.filter(e => e.equipment.includes('TRX')).length, nRow = LIB.filter(e => e.equipment.includes('rower')).length;
  $('#tab-settings').innerHTML = `<div class="card">
    <label>Days per week</label><select id="sDays">${[3, 4, 5].map(d => `<option ${d == settings.daysPerWeek ? 'selected' : ''}>${d}</option>`).join('')}</select>
    <label>Session length (minutes)</label><select id="sMin">${[30, 45, 60].map(d => `<option ${d == settings.minutes ? 'selected' : ''}>${d}</option>`).join('')}</select>
    <label>Switch time within pair (A → B)</label><select id="sSwitch">${[5, 10, 15, 20, 30].map(d => `<option value="${d}" ${d == clampSwitch() ? 'selected' : ''}>${d} s</option>`).join('')}</select>
    <label>Rest between rounds (after both exercises of a pair; then the setup time below)</label><select id="sRest">${[60, 75, 90, 120].map(d => `<option value="${d}" ${d == settings.restSec ? 'selected' : ''}>${d} s</option>`).join('')}</select>
    <label>Setup time between groups (added to the rest)</label><select id="sSetup">${[15, 30, 45, 60, 75, 90].map(d => `<option value="${d}" ${d == clampSetup() ? 'selected' : ''}>+${d} s</option>`).join('')}</select>
    <label>Level</label><select id="sLvl">${Object.keys(LEVEL).map(l => `<option ${l === settings.level ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div class="chk"><input type="checkbox" id="sBeep" ${settings.beeps ? 'checked' : ''}><span>Beeps (3-2-1 countdown)</span></div>
    <div class="chk"><input type="checkbox" id="sVoice" ${settings.voice ? 'checked' : ''}><span>Voice cues (exercise names + form cues)</span></div>
    <div class="chk"><input type="checkbox" id="sAwake" ${settings.keepAwake !== false ? 'checked' : ''}><span>Keep screen awake <small class="mut">· during a workout</small></span></div>
    <button id="bTestSound" type="button" style="width:100%;margin:8px 0 4px">🔊 Test sound</button>
    <div class="mut" id="soundNote" style="font-size:13px">No sound on iPhone? Turn off silent mode (ring switch / Action button), turn the volume up, then tap Test sound once.</div>
    <div class="chk"><input type="checkbox" id="sWu" ${settings.warmup ? 'checked' : ''}><span>Include warm-up</span></div>
    <div class="chk"><input type="checkbox" id="sCd" ${settings.cooldown ? 'checked' : ''}><span>Include cool-down</span></div>
</div>
    <h2>Equipment switches</h2><div class="card" id="eqToggles">
    <div class="chk"><input type="checkbox" id="sTrx" ${settings.trx ? 'checked' : ''}><span><b>TRX</b> <small class="mut">· ${nTrx} exercises · off = never programmed or offered as a swap</small></span></div>
    <div class="chk"><input type="checkbox" id="sRower" ${settings.rower ? 'checked' : ''}><span><b>Rower</b> <small class="mut">· ${nRow} exercises · off while it's malfunctioning; warm-up is bodyweight/band prep</small></span></div>
    <label>Kettlebells (lb, one number per bell)</label><input id="sKb" value="${settings.kettlebells.join(', ')}"><div class="mut" style="font-size:13px" id="kbTxt">You have ${kbTxt}. Suggestions start from these. The set log still goes up past them (a 50 lb bell, and heavier).</div></div>
    <h2>Equipment available</h2><div class="card">${eq.map(x => `<div class="chk"><input type="checkbox" class="eq" value="${x}" ${settings.excluded.includes(x) ? '' : 'checked'}><span>${x}</span></div>`).join('')}</div>
    <h2>Avoided exercises</h2><div class="card" id="avoidList">${settings.avoided.length ? settings.avoided.map(id => `<div class="ex"><div style="flex:1">${(byId(id) || {}).name || id}<br><small>auto-replaced by ${((byId(id) || {}).alternates || []).filter(a => !settings.avoided.includes(a)).map(a => (byId(a) || {}).name).filter(Boolean).slice(0, 1).join('') || 'its backups'}</small></div><button class="unavoid" data-id="${id}">Un-avoid</button></div>`).join('') : '<div class="mut">None. Hold ⇄ Swap on an exercise to avoid it permanently.</div>'}</div>
    <button id="bReset" style="width:100%;margin:10px 0 20px">Clear history</button>`;
  const save = () => {
    settings.daysPerWeek = +$('#sDays').value; settings.minutes = +$('#sMin').value; settings.level = $('#sLvl').value; settings.restSec = +$('#sRest').value; settings.switchSec = +$('#sSwitch').value; settings.setupSec = +$('#sSetup').value;
    settings.beeps = $('#sBeep').checked; settings.voice = $('#sVoice').checked; settings.warmup = $('#sWu').checked; settings.cooldown = $('#sCd').checked;
    settings.keepAwake = $('#sAwake').checked; if (settings.keepAwake) acquireWake(); else releaseWake();
    settings.trx = $('#sTrx').checked; settings.rower = $('#sRower').checked;
    const kb = $('#sKb').value.split(/[^0-9.]+/).map(Number).filter(x => x > 0); if (kb.length) settings.kettlebells = kb;
    settings.excluded = [...document.querySelectorAll('.eq')].filter(c => !c.checked).map(c => c.value);
    LS.set('gc_settings', settings); today = generate();
  };
  $('#tab-settings').querySelectorAll('select,input').forEach(i => i.onchange = save);
  $('#bTestSound').onclick = () => { unlockAudio(); beep(880, 150, 0.3, true); setTimeout(() => beep(1320, 300, 0.3, true), 350); say('Sound check. Rest. Next, push-ups.', true);
    setTimeout(() => { const n = $('#soundNote'); if (n) n.textContent = `Played a beep (${lastBeepPath === 'webaudio' ? 'Web Audio' : 'audio file'}) and a spoken phrase. Heard nothing? Turn off silent mode, raise the volume, and try again.`; }, 700); };
  $('#tab-settings').querySelectorAll('.unavoid').forEach(b => b.onclick = () => { settings.avoided = settings.avoided.filter(x => x !== b.dataset.id); LS.set('gc_settings', settings); today = generate(); renderSettings(); });
  $('#bReset').onclick = () => { if (confirm('Delete all workout history?')) { history = []; LS.set('gc_history', history); today = generate(); } };
}
function show(tab) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('main section').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + tab));
  ({ today: renderToday, history: renderHistory, library: renderLibrary, settings: renderSettings })[tab]();
  window.scrollTo(0, 0);
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab));

/* ---------- boot ---------- */
async function boot() {
  LIB = await (await fetch('exercises.json')).json();
  today = generate(); show('today');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__gc = {doneEarly, WAKE, acquireWake, releaseWake, get wakeVid() { return wakeVid; }, get setLog() { return setLog; }, set setLog(v) { setLog = v; }, lastSet, logStepFor, render, recentHistory, saveAndNext, estSec, ovhPerSet, cycleState, pickDay, renderToday, recordTiming, stampStep, get dayPick() { return dayPick; }, SPQ, say, speechNewStep, speechStop, speechCap, enterStep, tick, quit, savePartial, discardSession, openEndChoice, finish, WARM, SPEECH_LEAD, totalSec, remainSec, isBW, perSide, sideCount, switchesSides, highEnergy, pairConflict, dayIndexFromHistory, recordCompletion, smithConflict, stationConflict, stepWeight, kbOptions, prevWork, openSwap, repsLabel, setupNow, withReps, restFor, get actx() { return actx; }, get lastBeepPath() { return lastBeepPath; }, unlockAudio, beep, openPreview, closePreview, get history() { return history; }, set history(v) { history = v; }, assignCueOffsets, cuesFor, kbOptions, available, generate, buildSteps, get today() { return today; }, set today(v) { today = v; }, P, SPLITS, settings, saveSession, doSwap, avoidAndSwap, slotCandidates, suggest, get LIB() { return LIB; } };
}
boot().catch(e => { document.body.insertAdjacentHTML('afterbegin', `<pre style="color:#f66">${e}</pre>`); console.error(e); });
