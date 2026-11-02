'use strict';
/* Home Gym Coach – PWA prototype. All data in localStorage. */
const $ = s => document.querySelector(s);
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
// Default plan: 3-day rotating split Push -> Pull -> Legs & Core (whole body covered across the 3 days). TRX and rower are OFF by default (rower malfunctioning).
// Kettlebells on hand: 2 x 25 lb + 1 x 35 lb (suggestions snap to these). Tempo counting on by default.
const DEFAULTS = { daysPerWeek: 3, minutes: 45, level: 'intermediate', voice: true, beeps: true,
  excluded: [], avoided: [], warmup: true, cooldown: true, trx: false, rower: false, tempo: true, kettlebells: [25, 25, 35] };
let settings = Object.assign({}, DEFAULTS, LS.get('gc_settings', {}));
if (!Array.isArray(settings.avoided)) settings.avoided = [];
if (!Array.isArray(settings.kettlebells) || !settings.kettlebells.length) settings.kettlebells = DEFAULTS.kettlebells.slice();
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
      finisher: ['conditioning','conditioning'], cooldown: ['ball-chest-stretch','foam-roll-tspine'] },
    { name: 'Pull', short: 'Pull', focus: 'Back & lats · Rear delts · Traps · Biceps',
      blocks: [['pull:lats','pull:rear delts'],['pull:mid back','pull:biceps'],['pull:lats','pull:traps'],['pull:upper back/rear delts','pull:biceps']],
      finisher: ['conditioning','conditioning'], cooldown: ['foam-roll-tspine','cat-cow'] },
    { name: 'Legs & Core', focus: 'Quads · Hams · Glutes · Calves · Glute med · Abs/obliques',
      blocks: [['legs:quads','core:abs'],['legs:hamstrings','legs:calves'],['legs:glutes','core:obliques'],['legs:glute med','core:lower abs/core/abs']],
      finisher: ['conditioning','conditioning'], cooldown: ['foam-roll-legs','cat-cow'] },
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
function nextDayIndex() {
  const split = SPLITS[settings.daysPerWeek] || SPLITS[4];
  return history.filter(h => h.split === settings.daysPerWeek).length % split.length;
}
function lastPerf(id) {
  for (let i = history.length - 1; i >= 0; i--) { const l = (history[i].log || []).find(x => x.id === id && (x.weight || x.reps)); if (l) return l; }
  return null;
}
/* Kettlebells: only the bells you own. single = any bell; double = a weight you have two of (2 x 25). */
function kbOptions(e) {
  const c = {}; (settings.kettlebells || []).forEach(w => { c[w] = (c[w] || 0) + 1; });
  return Object.keys(c).map(Number).filter(w => e.kb.mode !== 'double' || c[w] >= 2).sort((a, b) => a - b);
}
function snapKB(e, w) { const o = kbOptions(e); return o.length ? o.reduce((a, b) => Math.abs(b - w) < Math.abs(a - w) ? b : a) : w; }
const tempoParts = t => String(t || '').split('-').map(Number);
const tempoSum = t => tempoParts(t).reduce((a, b) => a + (b || 0), 0);
/* Double progression with lighter loads: add reps inside the exercise's range first; at the top of the range
   (and logged Easy) the load goes up one small step (KB: next bell you own) and reps reset to the bottom.
   Hard = drop reps (or load at the bottom of the range). Returns {weight, reps, last} or null. */
function suggest(id) {
  const e = byId(id); if (!e) return null; const l = lastPerf(id);
  const [lo, hi] = e.reps || [0, 0]; const rstep = hi - lo > 4 ? 2 : 1; const start = e.startReps || lo;
  if (!l) { if (!e.kb && !e.reps) return null; return { last: null, weight: e.kb ? snapKB(e, e.kb.start) : null, reps: e.reps ? start : null }; }
  let w = Number(l.weight) || 0, r = Number(l.reps) || (e.reps ? start : 0);
  const up = () => { if (e.kb) { const o = kbOptions(e), nx = o.find(x => x > w); if (nx) { w = nx; return true; } return false; } if (!w) return false; w += w >= 25 ? 5 : 2.5; return true; };
  const down = () => { if (e.kb) { const o = kbOptions(e), pv = [...o].reverse().find(x => x < w); if (pv) w = pv; return; } if (w) w = Math.max(0, w - (w > 25 ? 5 : 2.5)); };
  if (l.feel === 'easy') { if (e.reps && r + rstep <= hi) r += rstep; else if (up()) r = e.reps ? lo : r; else if (e.reps) r = Math.min(hi, r + rstep); }
  else if (l.feel === 'hard') { if (e.reps && r - rstep >= Math.min(lo, start)) r -= rstep; else down(); }
  if (e.kb && w) w = snapKB(e, w);
  return { last: l, weight: w || null, reps: e.reps ? r : null };
}
const wText = (e, w) => w ? (e.kb && e.kb.mode === 'double' ? `2×${w} lb` : `${w} lb`) : '';
function sgText(e, sg) { if (!sg) return ''; return [wText(e, sg.weight), sg.reps ? sg.reps + ' reps' : ''].filter(Boolean).join(' × '); }
function lastText(e, l) { return l ? [wText(e, Number(l.weight)), l.reps ? l.reps + ' reps' : ''].filter(Boolean).join(' × ') : ''; }
/* Reps + tempo set the work interval: target reps x tempo seconds (x2 for "switch sides halfway"), 20-120 s.
   With tempo counting off, the exercise keeps its normal timed interval and just shows the rep target. */
function withReps(x) {
  if (!x.reps) return x; const sg = suggest(x.id); x.targetReps = (sg && sg.reps) || x.startReps || x.reps[0];
  if (settings.tempo && x.tempo) { const sides = x.unilateral && /switch/i.test(x.cue) ? 2 : 1; x.work = Math.min(120, Math.max(20, Math.round(x.targetReps * tempoSum(x.tempo) * sides / 5) * 5)); }
  return x;
}
function generate() {
  const split = SPLITS[settings.daysPerWeek] || SPLITS[4];
  const di = nextDayIndex(); const day = split[di];
  const R = rng(dateKey(new Date()) + '|' + di + '|' + shuffleN + '|' + settings.daysPerWeek);
  const lv = LEVEL[settings.level] || LEVEL.intermediate;
  const pool = available(), okPool = genPool(); const used = new Set();
  // An avoided exercise is never programmed: its slot automatically gets its first usable backup instead
  // (keeps the rest of the plan stable). If no backup is usable, the next-best pick is taken.
  const sub = e => { if (!settings.avoided.includes(e.id)) return e; const a = (e.alternates || []).map(x => okPool.find(p => p.id === x && !used.has(x))).find(Boolean); return a ? { ...a, autoFor: e.id } : null; };
  // Fixed warm-up/cool-down picks fall back to their first usable alternate if avoided or missing equipment.
  const fixed = id => { const ok = x => okPool.find(e => e.id === x && !used.has(x)); const e = ok(id) || (byId(id)?.alternates || []).map(ok).find(Boolean); if (e) used.add(e.id); return e; };
  const recent = new Set((history.slice(-2).flatMap(h => h.exerciseIds || [])));
  const pick = (slot, preferHeavy) => {
    const [cat, mus] = slot.split(':'); const want = mus ? mus.split('/') : [];
    let c = pool.filter(e => e.category === cat && !used.has(e.id) && e.id !== 'row-steady');
    if (!c.length) return null;
    const fit = e => !want.length ? 0 : want.includes((e.muscles || [])[0]) ? 3 : (e.muscles || []).some(m => want.includes(m)) ? 1.5 : 0;
    const score = e => fit(e) + R() + (recent.has(e.id) ? -0.5 : 0) + (preferHeavy && e.rest >= 60 ? 0.6 : 0);
    c = c.map(e => [score(e), e]).sort((a, b) => b[0] - a[0]);
    for (const [, e0] of c) { const e = sub(e0); if (!e) continue; used.add(e0.id); used.add(e.id); return e; }
    return null;
  };
  const scale = e => withReps({ ...e, work: Math.round(e.work * lv.w / 5) * 5, rest: Math.round(e.rest * lv.r / 5) * 5 });
  const budget = settings.minutes * 60;
  const out = { day: day.name, focus: day.focus, dayIndex: di, splitLen: split.length, nextDay: split[(di + 1) % split.length].name, blocks: [] };
  let t = 0;
  if (settings.warmup) {
    const wu = [fixed('row-steady'), fixed('worlds-greatest')].filter(Boolean).map((e, k) => ({ ...e, work: k === 0 && e.work > 60 ? 180 : 60, rest: 10 }));
    if (wu.length) { out.blocks.push({ name: 'Warm-up', rounds: 1, items: wu, kind: 'warmup' }); t += wu.reduce((s, e) => s + e.work + e.rest, 0); }
  }
  const cdItems = settings.cooldown ? (day.cooldown || ['foam-roll-legs', 'ball-chest-stretch']).map(fixed).filter(Boolean).map(e => ({ ...e, work: 60, rest: 5 })) : [];
  const cdTime = cdItems.reduce((s, e) => s + e.work + e.rest, 0);
  const blockTime = (items, rounds) => rounds * (items.reduce((s, e) => s + e.work, 0) + (items.length - 1) * 15 + Math.max(...items.map(e => e.rest)));
  // Short conditioning finisher (2 rounds) reserved up front so main work fills the rest of the budget.
  const finItems = day.finisher ? day.finisher.map(c => pick(c, false)).filter(Boolean).map(scale) : [];
  const finRounds = 2, finT = finItems.length ? blockTime(finItems, finRounds) + 30 : 0;
  // Fill main blocks using the real step timeline (warm-up + blocks + finisher + cool-down) so the session lands near the target.
  const finBlock = finItems.length ? { name: 'Finisher', rounds: finRounds, items: finItems, kind: 'finisher' } : null;
  const cdBlock = cdItems.length ? { name: 'Cool-down', rounds: 1, items: cdItems, kind: 'cooldown' } : null;
  const total = blocks => buildSteps({ blocks: blocks.filter(Boolean) }).reduce((a, x) => a + x.dur, 0);
  let bi = 0;
  while (bi < 10) {
    const pat = day.blocks[bi % day.blocks.length];
    const items = pat.map((c, k) => pick(c, bi < 2 && k === 0)).filter(Boolean).map(scale);
    if (!items.length) break;
    const isFinisher = !day.finisher && pat.every(c => /^(conditioning|core)/.test(c));
    let rounds = isFinisher ? Math.max(2, lv.rounds) : lv.rounds;
    const blk = r => ({ name: isFinisher ? 'Finisher' : 'Block ' + String.fromCharCode(65 + bi), rounds: r, items, kind: isFinisher ? 'finisher' : 'main' });
    // Take the block at full rounds if it fits; otherwise shorter (min 2 rounds); always keep at least 2 main blocks.
    while (bi >= 2 && rounds >= 2 && total([...out.blocks, blk(rounds), finBlock, cdBlock]) > budget * 1.04) rounds--;
    if (rounds < 2 && bi >= 2) { items.forEach(e => used.delete(e.id)); break; }
    out.blocks.push(blk(Math.max(rounds, 2))); bi++;
  }
  if (finBlock) out.blocks.push(finBlock);
  if (cdBlock) out.blocks.push(cdBlock);
  out.estMin = Math.round(buildSteps(out).reduce((a, x) => a + x.dur, 0) / 60);
  out.key = [dateKey(new Date()), di, shuffleN, settings.daysPerWeek, settings.minutes, settings.level].join('|');
  applySwaps(out);
  return out;
}

/* ---------- swaps (injury backups) ----------
   One tap = replace with the next curated alternate (no chooser). Tapping again cycles through the backups
   (and back to the original). The slot keeps its work/rest timing and round structure; the new exercise
   brings its own images, form cues and demo link. Swaps persist for this session (gc_swaps, keyed to the
   generated workout) and are logged in history. Long-press = avoid this exercise permanently. */
function slotCandidates(w, bi, ii) {
  const cur = w.blocks[bi].items[ii], orig = byId(cur.origId || cur.id);
  const used = new Set(w.blocks.flatMap((b, x) => b.items.filter((e, y) => !(x === bi && y === ii)).map(e => e.id)));
  const avail = new Set(available().map(e => e.id));
  return [orig.id, ...(orig.alternates || [])].filter(id => avail.has(id) && !settings.avoided.includes(id) && !used.has(id));
}
function nextAlternate(w, bi, ii) {
  const cur = w.blocks[bi].items[ii], c = slotCandidates(w, bi, ii);
  const nx = c[(c.indexOf(cur.id) + 1) % c.length];
  return nx && nx !== cur.id ? nx : null;
}
// A swap keeps the slot's rest and round structure; with tempo on, the work interval follows the new exercise's reps x tempo.
const makeItem = (slot, id) => withReps({ ...byId(id), work: slot.work, rest: slot.rest, origId: slot.origId || slot.id });
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
function doSwap(bi, ii, reason = 'swap') {
  const w = today, cur = w.blocks[bi].items[ii], id = nextAlternate(w, bi, ii);
  if (!id) { toast('No other backup available for ' + cur.name); return null; }
  const ni = makeItem(cur, id); w.blocks[bi].items[ii] = ni;
  w.swaps.push({ block: w.blocks[bi].name, from: cur.id, to: id, original: ni.origId, reason, at: new Date().toISOString() });
  persistSwaps(w);
  if (P.steps.length) { // live session: point every step for this slot at the new exercise
    let hit = false; P.steps.forEach((s, k) => { if (s.ex === cur) { s.ex = ni; hit = true; if (k !== P.i && s.type === 'work') s.dur = ni.work; } });
    if (hit && !(id in P.cueOff)) Object.assign(P.cueOff, assignCueOffsets(P.steps.filter(s => s.ex === ni)));
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
/* Flatten blocks into timed steps */
function buildSteps(w) {
  const steps = [{ type: 'prep', dur: 10, ex: w.blocks[0].items[0], label: 'Get ready' }];
  w.blocks.forEach((b, bi) => {
    for (let r = 1; r <= b.rounds; r++) {
      b.items.forEach((e, i) => {
        steps.push({ type: 'work', dur: e.work, ex: e, block: b.name, round: r, rounds: b.rounds });
        const lastInRound = i === b.items.length - 1;
        const lastOfBlock = lastInRound && r === b.rounds;
        let rest = lastInRound ? Math.max(...b.items.map(x => x.rest)) : 15;
        if (b.kind === 'warmup' || b.kind === 'cooldown') rest = 10;
        if (lastOfBlock && bi < w.blocks.length - 1) rest = Math.max(rest, 30);
        if (bi === w.blocks.length - 1 && lastOfBlock) rest = 0;
        if (rest > 0) steps.push({ type: 'rest', dur: rest, block: b.name, label: lastOfBlock ? 'Next block' : 'Rest' });
      });
    }
  });
  // attach "next exercise" to each step
  for (let i = 0; i < steps.length; i++) steps[i].next = steps.slice(i + 1).find(s => s.type === 'work') || null;
  return steps;
}

/* ---------- audio ---------- */
let actx = null;
function beep(freq = 880, ms = 120, vol = 0.25) {
  if (!settings.beeps) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; o.type = 'sine'; g.gain.value = vol;
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + ms / 1000);
  } catch (e) { /* audio unavailable */ }
}
function say(text) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; speechSynthesis.speak(u); } catch (e) {}
}

/* ---------- player ---------- */
const P = { steps: [], i: 0, end: 0, left: 0, paused: false, timer: null, started: 0, lastBeep: -1, wake: null, halfSaid: false, cueOff: {}, cueSaid: 0, tk: '' };
/* Tempo counter: e.g. 3-1-2-0 = 3 s slow lowering, 1 s hold, 2 s drive, 0 s pause. Shown big on screen and
   counted audibly (a distinct tone starts each phase, soft ticks count the seconds inside it). */
const TEMPO_PH = [['Slow', '⬇', 520], ['Hold', '⏸', 700], ['Drive', '⬆', 980], ['Pause', '⏸', 700]];
function tempoState(s, left) {
  if (!settings.tempo || s.type !== 'work' || !s.ex.tempo) return null;
  const parts = tempoParts(s.ex.tempo), cyc = tempoSum(s.ex.tempo); if (!cyc) return null;
  const el = Math.max(0, s.dur - left), rep = Math.floor(el / cyc) + 1; let t = el % cyc;
  for (let k = 0; k < 4; k++) { const d = parts[k] || 0; if (!d) continue; if (t < d) return { rep, phase: k, sec: Math.floor(t) + 1, of: d, name: TEMPO_PH[k][0], icon: TEMPO_PH[k][1] }; t -= d; }
  return null;
}
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
  P.steps = buildSteps(today); P.i = 0; P.started = Date.now(); P.paused = false; P.cueOff = assignCueOffsets(P.steps);
  $('#player').classList.remove('hidden');
  try { if ('wakeLock' in navigator) P.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  beep(660, 60, 0.01); // unlock audio on user gesture
  enterStep();
  clearInterval(P.timer); P.timer = setInterval(tick, 200);
}
function enterStep() {
  const s = P.steps[P.i]; if (!s) return finish();
  P.end = Date.now() + s.dur * 1000; P.left = s.dur; P.lastBeep = -1; P.halfSaid = false; P.cueSaid = 0; P.tk = '';
  if (s.type === 'work') { beep(1200, 350); say(s.ex.name); }
  else if (s.type === 'rest') { beep(500, 250); say(s.next ? 'Rest. Next up, ' + s.next.ex.name : 'Rest'); }
  else if (s.type === 'prep') say('Get ready. First up, ' + s.ex.name);
  render();
}
function tick() {
  if (P.paused) return;
  const s = P.steps[P.i]; if (!s) return;
  const left = Math.max(0, (P.end - Date.now()) / 1000); P.left = left;
  const sec = Math.ceil(left);
  if (sec <= 3 && sec >= 1 && sec !== P.lastBeep) { P.lastBeep = sec; beep(880, 110); }
  if (s.type === 'work' && s.ex.unilateral && !P.halfSaid && left <= s.dur / 2 && /switch/i.test(s.ex.cue)) { P.halfSaid = true; beep(1000, 150); say('Switch sides'); }
  if (s.type === 'work') { // speak a form cue a few seconds in, and a second one past the midpoint on longer sets
    const el = s.dur - left, cs = cuesFor(s.ex, s.round), sw = s.ex.unilateral && /switch/i.test(s.ex.cue);
    if (P.cueSaid === 0 && cs[0] && el >= 4 && left > 4) { P.cueSaid = 1; say(cs[0]); }
    else if (P.cueSaid === 1 && cs[1] && s.dur >= 30 && el >= s.dur / 2 + (sw ? 3 : 0) && left > 5) { P.cueSaid = 2; say(cs[1]); }
  }
  const ts = tempoState(s, left); // audible tempo count (stays quiet under the final 3-2-1 beeps)
  if (ts && left > 3.5) { const k = ts.rep + ':' + ts.phase + ':' + ts.sec; if (k !== P.tk) { P.tk = k; P.tempoBeeps = (P.tempoBeeps || 0) + 1; if (ts.sec === 1) beep(TEMPO_PH[ts.phase][2], 140, 0.22); else beep(420, 45, 0.1); } }
  if (left <= 0) { P.i++; enterStep(); return; }
  renderTime();
}
function togglePause() {
  if (P.paused) { P.end = Date.now() + P.left * 1000; P.paused = false; } else { P.paused = true; }
  render();
}
// Demo videos open in a new tab / the YouTube app; the workout timer is paused first so nothing runs on while watching.
function openDemo(url) {
  if (!P.paused) { P.paused = true; if ('speechSynthesis' in window) speechSynthesis.cancel(); render(); }
  window.open(url, '_blank', 'noopener');
}
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const demoLink = (e, cls, label) => e.demoUrl ? `<a class="demo ${cls}" href="${e.demoUrl}" target="_blank" rel="noopener" data-demo="${e.id}" title="${esc((e.demoTitle || '') + (e.demoChannel ? ' · ' + e.demoChannel : ''))}">${label}</a>` : '';
// Player swap targets the exercise on screen: the current one during work, the upcoming one during get-ready/rest.
function playerSwap(avoid) {
  const s = P.steps[P.i]; const tgt = s && (s.type === 'work' ? s.ex : s.next && s.next.ex); const slot = tgt && findSlot(tgt); if (!slot) return;
  const ni = avoid ? avoidAndSwap(...slot) : doSwap(...slot); if (!ni) return;
  if (s.type === 'work') { P.cueSaid = 0; say(ni.name); } else say('Next up, ' + ni.name);
  render();
}
function skip(d = 1) { P.i = Math.max(0, P.i + d); enterStep(); }
function quit() { if (!confirm('End workout? Progress so far will not be saved.')) return; stopPlayer(); }
function stopPlayer() {
  clearInterval(P.timer); $('#player').classList.add('hidden');
  try { P.wake && P.wake.release(); } catch (e) {} if ('speechSynthesis' in window) speechSynthesis.cancel();
}
const fmt = s => { s = Math.ceil(s); return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : String(s); };
function render() {
  const s = P.steps[P.i]; const el = $('#player'); if (!s) return;
  el.className = s.type === 'work' ? 'work' : s.type === 'rest' ? 'rest' : '';
  const title = s.type === 'work' ? s.ex.name : s.type === 'rest' ? s.label : 'Get ready';
  const meta = s.type === 'work' ? `${s.block} · Round ${s.round}/${s.rounds}` : s.block || '';
  const sg = s.type === 'work' && suggest(s.ex.id);
  const doneSteps = P.steps.slice(0, P.i).reduce((a, x) => a + x.dur, 0), total = P.steps.reduce((a, x) => a + x.dur, 0);
  el.innerHTML = `
    <div class="row" style="flex:0"><div class="mut">${meta}</div><div class="mut" style="text-align:right">${P.i + 1}/${P.steps.length}</div></div>
    <div class="bar"><i style="width:${(100 * doneSteps / total).toFixed(1)}%"></i></div>
    <div class="phase">${s.type === 'work' ? 'Work' : s.type === 'rest' ? 'Rest' : 'Prepare'}${P.paused ? ' · Paused' : ''}</div>
    <div class="exname">${title}</div>
    <div class="mut">${s.type === 'work' ? (s.ex.cue || s.ex.muscles.join(', ')) + (sg && sgText(s.ex, sg) ? ` · Try ${sgText(s.ex, sg)}` : '') : ''}</div>
    ${s.type === 'work' && s.ex.targetReps ? `<div class="tempo${settings.tempo && s.ex.tempo ? '' : ' plain'}" id="tempo"><span class="tph" id="tph"></span><span class="trep" id="trep">${s.ex.targetReps} reps${s.ex.tempo ? ' · tempo ' + s.ex.tempo : ''}</span></div>` : ''}
    ${(() => { const ie = s.type === 'work' ? s.ex : (s.ex || (s.next && s.next.ex)); return ie && ie.image ? `<div class="pimg${s.type === 'work' ? '' : ' dim'}"><img id="pimg" src="${ie.image[0]}" data-f="${ie.image.join('|')}" alt="${ie.name}">${(() => { const sl = findSlot(ie); return sl ? `<div class="swapbar"><button class="swap" id="bSwap" title="Tap: next backup · Hold: avoid permanently">⇄ Swap</button>${ie.origId && ie.origId !== ie.id ? `<button class="avoid" id="bAvoid" title="Never program ${esc(byId(ie.origId).name)} again">🚫 Avoid ${esc(byId(ie.origId).name)}</button>` : ''}</div>` : ''; })()}${ie.demoUrl ? `<a class="demo" id="bDemo" href="${ie.demoUrl}" target="_blank" rel="noopener" title="${esc(ie.demoTitle || '')}">▶ Watch demo</a>` : ''}</div>` : ''; })()}
    ${(() => { const cs = s.type === 'work' ? cuesFor(s.ex, s.round) : (s.next ? cuesFor(s.next.ex, s.next.round).slice(0, 1) : []); return cs.length ? `<div class="cues${s.type === 'work' ? '' : ' dim'}">${s.type === 'work' ? '' : '<b>Next focus:</b> '}${cs.map(c => `<div>• ${c}</div>`).join('')}</div>` : ''; })()}
    <div class="ring"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" stroke="#dfe6e2" stroke-width="7" fill="none"/>
      <circle id="arc" cx="50" cy="50" r="45" stroke="${s.type === 'rest' ? '#1f63c6' : '#17894b'}" stroke-width="7" fill="none" stroke-linecap="round" stroke-dasharray="282.7" stroke-dashoffset="0"/></svg>
      <div class="n" id="num">${fmt(P.left)}</div></div>
    <div class="next">${s.next ? `${s.next.ex.image ? `<img class="thumb" src="${s.next.ex.image[1]}" alt="">` : ''}<div><div class="mut">Next</div><div style="font-weight:600;font-size:18px">${s.next.ex.name}</div><div class="mut">${s.next.dur}s · ${s.next.ex.equipment.join(', ')}</div></div>` : '<div style="font-weight:600">Last one. Finish strong!</div>'}</div>
    <div class="ctrl"><button id="bPrev">⏮</button><button id="bPause" class="pri" style="flex:2">${P.paused ? '▶ Resume' : '⏸ Pause'}</button><button id="bSkip">⏭</button></div>
    <button id="bQuit" style="margin-top:4px;padding:8px;background:none;color:var(--mut);flex-shrink:0">End workout</button>`;
  $('#bPause').onclick = togglePause;
  const bd = $('#bDemo'); if (bd) bd.onclick = ev => { ev.preventDefault(); openDemo(bd.href); }; $('#bSkip').onclick = () => skip(1);
  const bs = $('#bSwap'); if (bs) longPress(bs, () => playerSwap(true), () => playerSwap(false));
  const ba = $('#bAvoid'); if (ba) ba.onclick = () => { const s = P.steps[P.i], tgt = s.type === 'work' ? s.ex : s.next && s.next.ex, sl = findSlot(tgt); if (sl) { avoidOriginal(...sl); render(); } }; $('#bPrev').onclick = () => skip(-1); $('#bQuit').onclick = quit;
  renderTime();
}
function renderTime() {
  const s = P.steps[P.i]; if (!s) return;
  const n = $('#num'), a = $('#arc'); if (n) n.textContent = fmt(P.left);
  const tb = $('#tempo'), ts = tempoState(s, P.left);
  if (tb && ts) { tb.dataset.phase = ts.name.toLowerCase(); $('#tph').textContent = `${ts.icon} ${ts.name} ${ts.sec}${ts.of > 1 ? '/' + ts.of : ''}`; $('#trep').textContent = `Rep ${Math.min(ts.rep, s.ex.targetReps)}/${s.ex.targetReps} · ${s.ex.tempo}`; }
  if (a) a.setAttribute('stroke-dashoffset', (282.7 * (1 - P.left / s.dur)).toFixed(1));
  const im = $('#pimg'); // alternate start/end frames every ~1.2s while working
  if (im && !P.paused) { const f = im.dataset.f.split('|'), k = s.type === 'work' ? Math.floor((s.dur - P.left) / 1.2) % f.length : 0; if (!im.src.endsWith(f[k])) im.src = f[k]; }
}
function finish() {
  stopPlayer(); beep(1320, 500); say('Workout complete. Great job!');
  const mins = Math.round((Date.now() - P.started) / 60000);
  const lifts = today.blocks.filter(b => b.kind === 'main').flatMap(b => b.items);
  const tab = $('#tab-today');
  tab.innerHTML = `<div class="hero"><div class="t">Done! 🎉</div><div class="s">${today.day} · ${mins} min</div></div>
   <div class="card"><h2 style="margin-top:0">Log your weights</h2><div class="mut">Used for next time's suggestions.</div>
   ${lifts.map(e => { const sg = suggest(e.id); return `<div class="logrow" data-id="${e.id}"><div>${e.name}${e.reps ? `<br><small class="mut">${e.reps[0]}–${e.reps[1]} reps</small>` : ''}</div>
     <input type="number" class="w" inputmode="decimal" placeholder="${e.kb && e.kb.mode === 'double' ? 'lb/bell' : 'lb'}" value="${sg && sg.weight ? sg.weight : ''}">${e.reps ? `<input type="number" class="r" inputmode="numeric" placeholder="reps" value="${e.targetReps || (sg && sg.reps) || ''}">` : ''}<select><option value="good">OK</option><option value="easy">Easy</option><option value="hard">Hard</option></select></div>`; }).join('')}
   <button class="pri" id="bSave" style="margin-top:12px">Save session</button></div>`;
  $('#bSave').onclick = () => {
    const log = [...document.querySelectorAll('.logrow')].map(r => ({ id: r.dataset.id, weight: r.querySelector('input.w').value, reps: (r.querySelector('input.r') || {}).value || '', feel: r.querySelector('select').value }));
    saveSession(mins, log); show('history');
  };
}
function saveSession(mins, log) {
  history.push({ date: new Date().toISOString(), day: today.day, split: settings.daysPerWeek, minutes: mins, exerciseIds: today.blocks.flatMap(b => b.items.map(e => e.id)), swaps: netSwaps(), swapTaps: (today.swaps || []).length, log });
  LS.set('gc_history', history); localStorage.removeItem('gc_swaps'); shuffleN = 0; today = generate();
}

/* ---------- views ---------- */
function renderToday() {
  const w = today; const split = SPLITS[settings.daysPerWeek] || SPLITS[4];
  const doneToday = history.some(h => dateKey(new Date(h.date)) === dateKey(new Date()));
  $('#title').textContent = 'Today'; $('#sub').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  $('#tab-today').innerHTML = `
   <div class="hero"><div class="s">Day ${w.dayIndex + 1} of ${split.length}${doneToday ? ' · ✅ trained today, this is up next' : ''}</div>
     <div class="rot">${split.map((d, k) => `<span class="${k === w.dayIndex ? 'on' : ''}">${d.short || d.name}</span>`).join('<i>→</i>')}</div>
     <div class="t">${w.day}</div><div class="s">${w.focus}</div><div class="s nextday">Next workout: <b>${w.nextDay}</b></div>
     <span class="pill">⏱ ~${w.estMin} min</span><span class="pill">${w.blocks.length} blocks</span><span class="pill">${settings.level}</span></div>
   <button class="pri" id="bStart">▶ Start workout</button>
   ${w.blocks.map(b => `<div class="card block"><div class="bt">${b.name} <span class="mut">· ${b.rounds} round${b.rounds > 1 ? 's' : ''}</span></div>
     ${b.items.map((e, ii) => { const sg = suggest(e.id); const bi = w.blocks.indexOf(b); const sw = e.origId && e.origId !== e.id; return `<div class="ex" data-bi="${bi}" data-ii="${ii}">${e.image ? `<img class="thumb" loading="lazy" src="${e.image[0]}" alt="">` : ''}<div style="flex:1">${e.name}<br><small>${e.targetReps ? e.targetReps + ' reps' + (settings.tempo && e.tempo ? ' · ' + e.tempo : '') + ' · ' : ''}${e.equipment.join(', ')}${sg && sgText(e, sg) ? ' · try ' + sgText(e, sg) : ''}</small>${demoLink(e, 'sm', '▶ Demo')}${e.autoFor ? `<div class="swapnote">🚫 replaces ${esc(byId(e.autoFor).name)} (avoided)</div>` : ''}${sw ? `<div class="swapnote">⇄ for ${esc(byId(e.origId).name)} · <button class="avoid sm" data-bi="${bi}" data-ii="${ii}">🚫 Avoid it</button></div>` : ''}</div><div class="mut" style="text-align:right">${fmt(e.work)}${e.work < 60 ? 's' : ''} / ${e.rest}s<br><button class="swap sm" data-bi="${bi}" data-ii="${ii}" title="Tap: next backup · Hold: avoid permanently">⇄ Swap</button></div></div>`; }).join('')}</div>`).join('')}
   <div class="row" style="margin:10px 0 20px"><button id="bShuffle">🔀 Shuffle exercises</button><button id="bSkipDay">Skip to next day</button></div>`;
  $('#bStart').onclick = startWorkout;
  $('#tab-today').querySelectorAll('button.swap').forEach(b => longPress(b, () => { avoidAndSwap(+b.dataset.bi, +b.dataset.ii); renderToday(); }, () => { doSwap(+b.dataset.bi, +b.dataset.ii); renderToday(); }));
  $('#tab-today').querySelectorAll('button.avoid').forEach(b => b.onclick = () => { avoidOriginal(+b.dataset.bi, +b.dataset.ii); renderToday(); });
  $('#bShuffle').onclick = () => { shuffleN++; today = generate(); renderToday(); };
  $('#bSkipDay').onclick = () => { history.push({ date: new Date().toISOString(), day: today.day + ' (skipped)', split: settings.daysPerWeek, minutes: 0, skipped: true, exerciseIds: [], log: [] }); LS.set('gc_history', history); today = generate(); renderToday(); };
}
function renderHistory() {
  $('#title').textContent = 'History';
  const real = history.filter(h => !h.skipped);
  const wk = real.filter(h => Date.now() - new Date(h.date) < 7 * 864e5).length;
  $('#sub').textContent = `${real.length} workouts · ${wk} this week · ${real.reduce((a, h) => a + h.minutes, 0)} min total`;
  $('#tab-history').innerHTML = real.length ? real.slice().reverse().map(h => `<div class="card"><div style="font-weight:600">${h.day}</div>
    <div class="mut">${new Date(h.date).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${h.minutes} min</div>
    ${(h.swaps || []).length ? `<div class="mut" style="font-size:13px;margin:4px 0">${h.swaps.map(x => `${x.reason === 'avoid' ? '🚫' : '⇄'} ${(byId(x.from) || {}).name || x.from} → ${(byId(x.to) || {}).name || x.to}`).join('<br>')}</div>` : ''}
    ${(h.log || []).filter(l => l.weight || l.reps).map(l => { const e = byId(l.id) || { id: l.id }; return `<div class="ex"><div>${e.name || l.id}</div><div class="mut">${lastText(e, l)} · ${l.feel}</div></div>`; }).join('')}</div>`).join('')
    : '<div class="card mut">No workouts yet. Finish one and it shows up here.</div>';
}
function renderLibrary() {
  $('#title').textContent = 'Exercise Library'; $('#sub').textContent = `${available().length} of ${LIB.length} available with your equipment`;
  const cats = ['Chest', 'Shoulders', 'Traps', 'Triceps', 'Back', 'Rear delts', 'Biceps', 'Legs', 'Core', 'Conditioning', 'Mobility'];
  const tl = $('#tab-library'); tl.onclick = ev => { const r = ev.target.closest('.ex.lib'); if (r) $('#det-' + r.dataset.id).classList.toggle('hidden'); };
  tl.innerHTML = cats.map(c => `<h2>${c}</h2><div class="card">${available().filter(e => (e.group || e.category) === c).map(e => `<div class="ex lib" data-id="${e.id}">${e.image ? `<img class="thumb" loading="lazy" src="${e.image[0]}" alt="">` : ''}<div style="flex:1">${e.name}${settings.avoided.includes(e.id) ? ' <span class="tag">avoided</span>' : ''}<br><small>${e.muscles.join(', ')}${e.reps ? ' · ' + e.reps[0] + '–' + e.reps[1] + ' reps' : ' · timed'}${e.tempo ? ' · ' + e.tempo : ''}</small></div><div class="mut">${e.work}/${e.rest}s ›</div></div>
      <div class="libdet hidden" id="det-${e.id}">${(e.image || []).map(p => `<img loading="lazy" src="${p}" alt="">`).join('')}
        <div class="mut" style="margin:6px 0 2px">${e.equipment.join(', ')}${e.cue ? ' · ' + e.cue : ''}</div><div class="mut" style="font-size:13px">${e.reps ? `Reps ${e.reps[0]}–${e.reps[1]}${e.startReps ? ` (start at ${e.startReps})` : ''}` : 'Timed'}${e.tempo ? ` · Tempo ${e.tempo} (lower-hold-lift-pause)` : ''}${e.kb ? ` · KB: ${e.kb.mode === 'double' ? '2×' : ''}${snapKB(e, e.kb.start)} lb to start` : ''}</div>${e.demoUrl ? `<div style="margin:6px 0">${demoLink(e, '', '▶ Watch demo')}<div class="mut" style="font-size:12px;margin-top:4px">${esc(e.demoTitle)} · ${esc(e.demoChannel)}</div></div>` : ''}<b>Form cues</b><ul>${(e.formCues || []).map(c => `<li>${c}</li>`).join('')}</ul><div class="mut" style="font-size:13px;margin-bottom:8px"><b>Swap backups:</b> ${(e.alternates || []).map(a => (byId(a) || {}).name || a).join(' → ')}</div></div>`).join('')}</div>`).join('');
}
function renderSettings() {
  $('#title').textContent = 'Settings'; $('#sub').textContent = 'Tune the plan to you';
  const eq = [...new Set(LIB.flatMap(e => e.equipment))].filter(x => x !== 'TRX' && x !== 'rower').sort();
  const kbTxt = (() => { const c = {}; settings.kettlebells.forEach(w => { c[w] = (c[w] || 0) + 1; }); return Object.keys(c).map(Number).sort((a, b) => a - b).map(w => `${c[w]} × ${w} lb`).join(', '); })();
  const nTrx = LIB.filter(e => e.equipment.includes('TRX')).length, nRow = LIB.filter(e => e.equipment.includes('rower')).length;
  $('#tab-settings').innerHTML = `<div class="card">
    <label>Days per week</label><select id="sDays">${[3, 4, 5].map(d => `<option ${d == settings.daysPerWeek ? 'selected' : ''}>${d}</option>`).join('')}</select>
    <label>Session length (minutes)</label><select id="sMin">${[30, 45, 60].map(d => `<option ${d == settings.minutes ? 'selected' : ''}>${d}</option>`).join('')}</select>
    <label>Level</label><select id="sLvl">${Object.keys(LEVEL).map(l => `<option ${l === settings.level ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div class="chk"><input type="checkbox" id="sBeep" ${settings.beeps ? 'checked' : ''}><span>Beeps (3-2-1 countdown)</span></div>
    <div class="chk"><input type="checkbox" id="sVoice" ${settings.voice ? 'checked' : ''}><span>Voice cues (exercise names + form cues)</span></div>
    <div class="chk"><input type="checkbox" id="sWu" ${settings.warmup ? 'checked' : ''}><span>Include warm-up</span></div>
    <div class="chk"><input type="checkbox" id="sCd" ${settings.cooldown ? 'checked' : ''}><span>Include cool-down</span></div>
    <div class="chk"><input type="checkbox" id="sTempo" ${settings.tempo ? 'checked' : ''}><span>Tempo counting (slow reps, e.g. 3-1-2-0: count shown + beeps during sets)</span></div></div>
    <h2>Equipment switches</h2><div class="card" id="eqToggles">
    <div class="chk"><input type="checkbox" id="sTrx" ${settings.trx ? 'checked' : ''}><span><b>TRX</b> <small class="mut">· ${nTrx} exercises · off = never programmed or offered as a swap</small></span></div>
    <div class="chk"><input type="checkbox" id="sRower" ${settings.rower ? 'checked' : ''}><span><b>Rower</b> <small class="mut">· ${nRow} exercises · off while it's malfunctioning; warm-up uses step runs instead</small></span></div>
    <label>Kettlebells (lb, one number per bell)</label><input id="sKb" value="${settings.kettlebells.join(', ')}"><div class="mut" style="font-size:13px" id="kbTxt">You have ${kbTxt}. Single-bell moves use one bell; double moves need a pair (2 × 25).</div></div>
    <h2>Equipment available</h2><div class="card">${eq.map(x => `<div class="chk"><input type="checkbox" class="eq" value="${x}" ${settings.excluded.includes(x) ? '' : 'checked'}><span>${x}</span></div>`).join('')}</div>
    <h2>Avoided exercises</h2><div class="card" id="avoidList">${settings.avoided.length ? settings.avoided.map(id => `<div class="ex"><div style="flex:1">${(byId(id) || {}).name || id}<br><small>auto-replaced by ${((byId(id) || {}).alternates || []).filter(a => !settings.avoided.includes(a)).map(a => (byId(a) || {}).name).filter(Boolean).slice(0, 1).join('') || 'its backups'}</small></div><button class="unavoid" data-id="${id}">Un-avoid</button></div>`).join('') : '<div class="mut">None. Hold ⇄ Swap on an exercise to avoid it permanently.</div>'}</div>
    <button id="bReset" style="width:100%;margin:10px 0 20px">Clear history</button>`;
  const save = () => {
    settings.daysPerWeek = +$('#sDays').value; settings.minutes = +$('#sMin').value; settings.level = $('#sLvl').value;
    settings.beeps = $('#sBeep').checked; settings.voice = $('#sVoice').checked; settings.warmup = $('#sWu').checked; settings.cooldown = $('#sCd').checked;
    settings.tempo = $('#sTempo').checked; settings.trx = $('#sTrx').checked; settings.rower = $('#sRower').checked;
    const kb = $('#sKb').value.split(/[^0-9.]+/).map(Number).filter(x => x > 0); if (kb.length) settings.kettlebells = kb;
    settings.excluded = [...document.querySelectorAll('.eq')].filter(c => !c.checked).map(c => c.value);
    LS.set('gc_settings', settings); today = generate();
  };
  $('#tab-settings').querySelectorAll('select,input').forEach(i => i.onchange = save);
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
  window.__gc = {get history() { return history; }, set history(v) { history = v; }, assignCueOffsets, cuesFor, tempoState, kbOptions, available, generate, buildSteps, get today() { return today; }, set today(v) { today = v; }, P, SPLITS, settings, saveSession, doSwap, avoidAndSwap, slotCandidates, suggest, get LIB() { return LIB; } };
}
boot().catch(e => { document.body.insertAdjacentHTML('afterbegin', `<pre style="color:#f66">${e}</pre>`); console.error(e); });
