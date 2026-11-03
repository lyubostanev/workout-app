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
  if (e.kb) { const o = kbOptions(e); if (!o.length) return w; if (!w) return o[0]; const i = o.indexOf(snapKB(e, w)); return o[Math.max(0, Math.min(o.length - 1, i + d))]; }
  const step = isBW(e) ? 5 : (w + (d > 0 ? 0 : -0.01)) < 25 ? 2.5 : 5;
  return Math.max(0, Math.round((w + d * step) * 10) / 10) || null;
}
/* Kettlebells: only the bells you own. single = any bell; double = a weight you have two of (2 x 25). */
function kbOptions(e) {
  const c = {}; (settings.kettlebells || []).forEach(w => { c[w] = (c[w] || 0) + 1; });
  return Object.keys(c).map(Number).filter(w => e.kb.mode !== 'double' || c[w] >= 2).sort((a, b) => a - b);
}
function snapKB(e, w) { const o = kbOptions(e); return o.length ? o.reduce((a, b) => Math.abs(b - w) < Math.abs(a - w) ? b : a) : w; }
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
/* Reps set the work interval: target reps x ~4 s per rep (x2 for "switch sides halfway"), 20-90 s. */
function withReps(x) {
  if (!x.reps) return x; const sg = suggest(x.id); x.targetReps = (sg && sg.reps) || x.startReps || x.reps[0];
  const sides = x.unilateral && /switch/i.test(x.cue) ? 2 : 1; x.work = Math.min(90, Math.max(20, Math.round(x.targetReps * 4 * sides / 5) * 5));
  return x;
}
/* Rest after EVERY work set (also between the two exercises of a pair and between rounds).
   Priority: per-exercise override (Library) > exercise data restSec > rule:
   lifts (push/pull/legs) = max('Rest between rounds', the exercise's own minimum) ; core/conditioning = max(30, half of it).
   Scaled by level (beginner longer, advanced shorter). Warm-up/cool-down moves only get a 10 s transition. */
function restFor(e) {
  const ov = (settings.restOverrides || {})[e.id]; if (ov) return ov;
  if (e.restSec) return e.restSec;
  if (e.category === 'mobility') return 10;
  const lv = LEVEL[settings.level] || LEVEL.intermediate, base = settings.restSec || 60, r5 = x => Math.round(x / 5) * 5;
  if (['push', 'pull', 'legs'].includes(e.category)) return Math.max(30, r5(Math.max(base, e.rest) * lv.r));
  return Math.max(20, r5(Math.max(30, base / 2, e.rest) * lv.r));
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
  const scale = e => withReps({ ...e, work: Math.round(e.work * lv.w / 5) * 5, rest: restFor(e) });
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
    // Take the block at full rounds if it fits; otherwise shorter (min 2 rounds); always keep at least 2 main blocks (they may also drop to 2 rounds).
    while (rounds >= (bi < 2 ? 3 : 2) && total([...out.blocks, blk(rounds), finBlock, cdBlock]) > budget * 1.04) rounds--;
    if (rounds < 2 && bi >= 2) { items.forEach(e => used.delete(e.id)); break; }
    out.blocks.push(blk(Math.max(rounds, 2))); bi++;
  }
  if (finBlock) out.blocks.push(finBlock);
  if (cdBlock) out.blocks.push(cdBlock);
  out.estMin = Math.round(buildSteps(out).reduce((a, x) => a + x.dur, 0) / 60);
  out.key = [dateKey(new Date()), di, shuffleN, settings.daysPerWeek, settings.minutes, settings.level, settings.restSec, settings.switchSec, settings.setupSec].join('|');
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
const clampSwitch = () => Math.min(30, Math.max(5, +settings.switchSec || 10));
const clampSetup = () => Math.min(90, Math.max(15, +settings.setupSec || 30));
/* Flatten blocks into timed steps */
function buildSteps(w) {
  const steps = [{ type: 'prep', dur: 10, ex: w.blocks[0].items[0], label: 'Get ready' }];
  w.blocks.forEach((b, bi) => {
    for (let r = 1; r <= b.rounds; r++) {
      b.items.forEach((e, i) => {
        steps.push({ type: 'work', dur: e.work, ex: e, block: b.name, round: r, rounds: b.rounds });
        const lastInRound = i === b.items.length - 1;
        const lastOfBlock = lastInRound && r === b.rounds;
        // Superset structure: A -> short switch -> B; full rest only after the round; between groups rest + setup time.
        const warm = b.kind === 'warmup' || b.kind === 'cooldown';
        const nb = w.blocks[bi + 1];
        if (lastOfBlock && !nb) return; // end of workout
        if (lastOfBlock) { // into the next group (also warm-up -> first group): set-up time, not the 10 s hop
          const su = clampSetup(), rp = warm ? 0 : e.rest;
          steps.push({ type: 'rest', dur: rp + su, restPart: rp, setupPart: su, setup: true, block: b.name, after: e.name,
            nextBlock: nb.name, nextRounds: nb.rounds, nextItems: nb.items, label: 'Set up · next group' });
        } else if (warm) steps.push({ type: 'rest', dur: 10, block: b.name, transition: true, after: e.name, label: 'Transition' });
        else if (!lastInRound) steps.push({ type: 'rest', dur: clampSwitch(), block: b.name, sw: true, after: e.name, label: 'Switch · next exercise' });
        else steps.push({ type: 'rest', dur: e.rest, block: b.name, after: e.name, label: 'Rest · next round' });
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
let actx = null, silentEl = null, speechPrimed = false;
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
    const pr = silentEl.play(); if (pr && pr.catch) pr.catch(() => {});
  } catch (e) {}
  BEEP_FILES.forEach(f => { // prime the fallback beep elements inside the gesture
    try {
      if (beepEls[f]) return; const el = new Audio('audio/beep' + f + '.wav'); el.setAttribute('playsinline', ''); el.preload = 'auto'; beepEls[f] = el;
      el.muted = true; const pr = el.play(); if (pr && pr.then) pr.then(() => { el.pause(); el.currentTime = 0; el.muted = false; }).catch(() => { el.muted = false; }); else el.muted = false;
    } catch (e) {}
  });
  if (!speechPrimed && 'speechSynthesis' in window) {
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); speechPrimed = true; } catch (e) {}
  }
}
function stopKeepAlive() { try { silentEl && silentEl.pause(); } catch (e) {} }
const playerOpen = () => { const el = document.getElementById('player'); return !!el && !el.classList.contains('hidden'); };
['touchend', 'click', 'keydown'].forEach(t => document.addEventListener(t, () => { resumeAudio(); if (silentEl && silentEl.paused && playerOpen()) silentEl.play().catch(() => {}); }, { capture: true, passive: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) { resumeAudio(); if (playerOpen() && silentEl) silentEl.play().catch(() => {}); } });
// ---- Keep the screen awake during a workout ----
// Screen Wake Lock API first; if it's missing or refused (older iOS, some home-screen PWAs), fall back to a tiny
// muted, looping, inline video (the NoSleep.js trick). The lock is dropped by the OS when the page is hidden, so it is
// re-acquired on visibilitychange and on resume; released when the workout finishes or is closed.
const NOSLEEP_MP4 = 'data:video/mp4;base64,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GCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcAAAAHQZqgF85wjAEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcAAAAHQZrAF85wjAEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAAdBmuAXznCMARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAAdBmwAXznCMARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHAAAAB0GbIBfOcIwBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAH';
const WAKE = { mode: 'off', err: null };
let wakeVid = null;
const wakeWanted = () => settings.keepAwake !== false && playerOpen();
function videoWake() {
  if (!wakeVid) {
    wakeVid = document.createElement('video');
    wakeVid.setAttribute('playsinline', ''); wakeVid.setAttribute('webkit-playsinline', ''); wakeVid.setAttribute('muted', '');
    wakeVid.muted = true; wakeVid.loop = true; wakeVid.setAttribute('aria-hidden', 'true'); wakeVid.id = 'wakeVid';
    wakeVid.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
    wakeVid.src = NOSLEEP_MP4; document.body.appendChild(wakeVid);
  }
  WAKE.mode = 'video';
  const pr = wakeVid.play(); if (pr && pr.catch) pr.catch(e => { WAKE.err = 'video:' + (e && e.name); });
}
function acquireWake() {
  if (!wakeWanted()) return;
  if (P.wake && !P.wake.released) return;            // already held
  if (!('wakeLock' in navigator) || !navigator.wakeLock) { videoWake(); return; } // synchronous: stays inside the tap on iOS
  navigator.wakeLock.request('screen').then(l => {
    if (!wakeWanted()) { l.release().catch(() => {}); return; }
    P.wake = l; WAKE.mode = 'wakelock'; WAKE.err = null; if (wakeVid) wakeVid.pause();
    l.addEventListener('release', () => { if (P.wake === l) { P.wake = null; if (WAKE.mode === 'wakelock') WAKE.mode = 'released'; } });
  }).catch(e => { WAKE.err = e && e.name; videoWake(); });
}
function releaseWake() {
  const l = P.wake; P.wake = null; try { l && l.release().catch(() => {}); } catch (e) {}
  if (wakeVid) { try { wakeVid.pause(); } catch (e) {} }
  WAKE.mode = 'off';
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && playerOpen()) acquireWake(); });
['touchend', 'click'].forEach(t => document.addEventListener(t, () => { if (playerOpen() && WAKE.mode === 'video' && wakeVid && wakeVid.paused && wakeWanted()) wakeVid.play().catch(() => {}); }, { capture: true, passive: true }));
function beepFile(freq) {
  const f = BEEP_FILES.reduce((a, b) => Math.abs(b - freq) < Math.abs(a - freq) ? b : a);
  try { let el = beepEls[f]; if (!el) { el = beepEls[f] = new Audio('audio/beep' + f + '.wav'); el.setAttribute('playsinline', ''); } el.muted = false; el.currentTime = 0; const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
}
let lastBeepPath = '';
function beep(freq = 880, ms = 120, vol = 0.25, force = false) {
  if (!settings.beeps && !force) return;
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
  resumeAudio(); beepFile(freq); lastBeepPath = 'html';
}
function say(text, force = false) {
  if ((!settings.voice && !force) || !('speechSynthesis' in window) || !text) return;
  try {
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; u.volume = 1; u.lang = 'en-US';
    if (speechSynthesis.paused) speechSynthesis.resume();
    speechSynthesis.speak(u);
  } catch (e) {}
}

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
  unlockAudio(); // must run synchronously in the tap, before any await (iOS)
  P.steps = buildSteps(today); P.i = 0; P.started = Date.now(); P.sets = {}; P.paused = false; P.cueOff = assignCueOffsets(P.steps);
  $('#player').classList.remove('hidden');
  acquireWake(); // keep the screen on (Wake Lock API, or a muted looping video fallback)
  enterStep();
  clearInterval(P.timer); P.timer = setInterval(tick, 200);
}
function logStepFor(i) { const s = P.steps[i], pw = P.steps[i - 1]; if (!s || s.type !== 'rest' || !pw || pw.type !== 'work') return null; const b = today.blocks.find(b => b.name === pw.block); return b && loggable(pw.ex, b.kind) ? pw : null; }
function setLogHTML(pw) {
  const v = P.sets[setKey(pw)] || setPrefill(pw), e = pw.ex, bw = isBW(e);
  return `<div class="setlog" id="setlog"><div class="slh"><b>Log set ${pw.round}/${pw.rounds}</b> · ${esc(e.name)}</div>
    <div class="stps"><div class="stp"><button type="button" data-d="w-1" aria-label="less weight">−</button><div class="v"><b id="lw">${v.w ? (e.kb && e.kb.mode === 'double' ? '2×' : '') + v.w : bw ? 'BW' : '—'}</b><small>${bw ? (v.w ? '+lb' : 'bodyweight') : 'lb'}</small></div><button type="button" data-d="w1" aria-label="more weight">+</button></div>
    <div class="stp"><button type="button" data-d="r-1" aria-label="fewer reps">−</button><div class="v"><b id="lr">${v.r || '—'}</b><small>reps</small></div><button type="button" data-d="r1" aria-label="more reps">+</button></div></div>
    <button type="button" class="savebtn" id="bSaveSet">✓ Save &amp; next exercise</button>
    <div class="mut slm" id="slm">${slmText(pw)}</div></div>`;
}
function slmText(pw) {
  const st = P.steps[P.i] || {}, saved = P.sets[setKey(pw)] && !P.sets[setKey(pw)].auto;
  if (P.done && P.done.i === P.i - 1 && !saved) return 'Set done early ✓ · enter weight/reps, then Save & next' + (st.sw ? ' (± pauses the timer)' : '');
  if (st.sw) return P.paused ? (saved ? '✓ Saved · ' : '') + 'Timer paused while you log · Save goes on' : 'Tap ± to log (timer pauses) · or log it on the next rest';
  return saved ? '✓ Saved · rest keeps running' : 'Rest keeps running · Save skips the rest';
}
function wireSetLog(pw) {
  const box = $('#setlog'); if (!box) return;
  box.querySelectorAll('button[data-d]').forEach(b => b.onclick = () => {
    const cur = P.sets[setKey(pw)] || setPrefill(pw); let w = cur.w, r = cur.r; const d = b.dataset.d;
    if (d[0] === 'w') w = stepWeight(pw.ex, w, +d.slice(1)); else r = Math.max(0, (Number(r) || 0) + +d.slice(1)) || null;
    recordSet(pw, w, r, false);
    const st = P.steps[P.i]; if (st && st.sw && !P.paused) { P.paused = true; P.logHold = true; render(); return; } // 10 s switch: don't rush the logging
    box.outerHTML = setLogHTML(pw); wireSetLog(pw);
  });
  const sv = $('#bSaveSet'); if (sv) sv.onclick = () => saveAndNext(pw);
}
// Save: store the set as shown and jump straight to the next exercise (skip the rest of this rest/transition).
function saveAndNext(pw) {
  const cur = P.sets[setKey(pw)] || setPrefill(pw); recordSet(pw, cur.w, cur.r, false); P.saved = (P.saved || 0) + 1;
  unlockAudio(); P.paused = false; P.logHold = false; P.i++;
  while (P.steps[P.i] && P.steps[P.i].type === 'rest') P.i++;
  enterStep();
}
function enterStep() {
  const s = P.steps[P.i]; if (!s) return finish();
  P.end = Date.now() + s.dur * 1000; P.left = s.dur; P.lastBeep = -1; P.halfSaid = false; P.cueSaid = 0; P.tk = '';
  if (s.type === 'work') { beep(1200, 350); say(s.ex.name); }
  else if (s.type === 'rest') { const pw = logStepFor(P.i); if (pw && !P.sets[setKey(pw)] && P.skipped !== P.i - 1) { const v = setPrefill(pw); recordSet(pw, v.w, v.r, true); } beep(500, 250); say(s.transition ? (s.next ? 'Next up, ' + s.next.ex.name : '') : s.sw ? 'Switch. ' + (s.next ? s.next.ex.name : '') : s.setup ? 'Set up for ' + s.nextBlock + '. ' + s.dur + ' seconds.' + (s.next ? ' First up, ' + s.next.ex.name : '') : 'Rest, ' + s.dur + ' seconds.' + (s.next ? ' Next up, ' + s.next.ex.name : '')); }
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
  if (s.type === 'rest' && !s.transition && s.dur >= 20 && !P.halfSaid && left <= 10 && left > 9) { P.halfSaid = true; beep(700, 120); say('10 seconds' + (s.next ? '. Get ready for ' + s.next.ex.name : '')); }
  if (left <= 0) { P.i++; enterStep(); return; }
  renderTime();
}
function togglePause() {
  if (P.paused) { P.end = Date.now() + P.left * 1000; P.paused = false; } else { P.paused = true; }
  acquireWake(); // screen stays on while paused too; re-acquire if iOS dropped it
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
// ⏭ Skip = move on WITHOUT logging (a skipped work set is not auto-recorded). Done ✓ = finished the set early -> log it now.
function skip(d = 1) { const s = P.steps[P.i]; P.skipped = d > 0 && s && s.type === 'work' ? P.i : null; P.done = null; P.i = Math.max(0, P.i + d); enterStep(); }
function doneEarly() {
  const s = P.steps[P.i]; if (!s || s.type !== 'work') return;
  unlockAudio(); P.done = { i: P.i, left: Math.round(P.left) }; P.skipped = null; P.paused = false; P.logHold = false; P.i++; enterStep();
}
function quit() { if (!confirm('End workout? Progress so far will not be saved.')) return; stopPlayer(); }
function stopPlayer() {
  clearInterval(P.timer); $('#player').classList.add('hidden');
  releaseWake(); if ('speechSynthesis' in window) speechSynthesis.cancel(); stopKeepAlive();
}
const fmt = s => { s = Math.ceil(s); return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : String(s); };
function render() {
  const s = P.steps[P.i]; const el = $('#player'); if (!s) return;
  el.className = s.type === 'work' ? 'work' : s.type === 'rest' ? 'rest' : '';
  const title = s.type === 'work' ? s.ex.name : s.type === 'rest' ? s.label : 'Get ready';
  const meta = s.type === 'work' ? `${s.block} · Round ${s.round}/${s.rounds}` : s.type === 'rest' && s.next ? `Up next: ${s.next.block} · Round ${s.next.round}/${s.next.rounds}` : s.block || '';
  const sg = s.type === 'work' && suggest(s.ex.id);
  const pw = s.type === 'rest' ? logStepFor(P.i) : null;
  const hist = s.type === 'work' ? recentHistory(s.ex, 3, P.started) : [];
  const nowW = s.type === 'work' ? Object.values(P.sets).filter(x => x.id === s.ex.id).sort((a, b) => a.t - b.t).map(x => setText(s.ex, x)) : [];
  const doneSteps = P.steps.slice(0, P.i).reduce((a, x) => a + x.dur, 0), total = P.steps.reduce((a, x) => a + x.dur, 0);
  el.innerHTML = `
    <div class="row" style="flex:0"><div class="mut">${meta}</div><div class="mut" style="text-align:right">${P.i + 1}/${P.steps.length}</div></div>
    <div class="bar"><i style="width:${(100 * doneSteps / total).toFixed(1)}%"></i></div>
    <div class="phase">${s.type === 'work' ? 'Work' : s.type === 'rest' ? (s.setup ? 'Set up' : s.sw ? 'Switch' : 'Rest') : 'Prepare'}${P.paused ? ' · Paused' : ''}</div>
    <div class="exname">${title}</div>
    <div class="mut">${s.type === 'work' ? (s.ex.cue || s.ex.muscles.join(', ')) : s.setup ? (s.restPart ? `Rest ${s.restPart} s + set up ${s.setupPart} s` : `Set up ${s.setupPart} s`) : s.type === 'rest' && !s.transition && !pw ? `Done: ${esc(s.after)} · breathe, shake it out` : ''}</div>
    ${s.setup ? setupHTML(s) : ''}
    ${histHTML(hist)}
    ${s.type === 'work' && (nowW.length || (sg && sgText(s.ex, sg))) ? `<div class="lastline">${nowW.length ? `<span>Today: ${nowW.join(', ')}</span>` : ''}${sg && sgText(s.ex, sg) ? `<span>Try ${sgText(s.ex, sg)}</span>` : ''}</div>` : ''}
    ${pw ? setLogHTML(pw) : ''}
    ${s.type === 'work' && s.ex.targetReps ? `<div class="target" id="target">${s.ex.targetReps} reps</div>` : ''}
    ${s.type === 'work' ? `<button type="button" class="donebtn" id="bDone">Done ✓<small>${P.steps[P.i + 1] && logStepFor(P.i + 1) ? 'finished early · log this set now' : 'finished early · move on'}</small></button>` : ''}
    ${(() => { const ie = s.type === 'work' ? s.ex : (s.ex || (s.next && s.next.ex)); return ie && ie.image ? `<div class="pimg${s.type === 'work' ? '' : ' dim'}${pw ? ' small' : ''}"><img id="pimg" src="${ie.image[0]}" data-f="${ie.image.join('|')}" alt="${ie.name}">${(() => { const sl = findSlot(ie); return sl ? `<div class="swapbar"><button class="swap" id="bSwap" title="Tap: next backup · Hold: avoid permanently">⇄ Swap</button>${ie.origId && ie.origId !== ie.id ? `<button class="avoid" id="bAvoid" title="Never program ${esc(byId(ie.origId).name)} again">🚫 Avoid ${esc(byId(ie.origId).name)}</button>` : ''}</div>` : ''; })()}${ie.demoUrl ? `<a class="demo" id="bDemo" href="${ie.demoUrl}" target="_blank" rel="noopener" title="${esc(ie.demoTitle || '')}">▶ Watch demo</a>` : ''}</div>` : ''; })()}
    ${(() => { const cs = s.type === 'work' ? cuesFor(s.ex, s.round) : (s.next && !pw ? cuesFor(s.next.ex, s.next.round).slice(0, 1) : []); return cs.length ? `<div class="cues${s.type === 'work' ? '' : ' dim'}">${s.type === 'work' ? '' : '<b>Next focus:</b> '}${cs.map(c => `<div>• ${c}</div>`).join('')}</div>` : ''; })()}
    <div class="ring"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" stroke="#d9e7f2" stroke-width="7" fill="none"/>
      <circle id="arc" cx="50" cy="50" r="45" stroke="${s.type === 'rest' ? '#1d4ed8' : '#0ea5e9'}" stroke-width="7" fill="none" stroke-linecap="round" stroke-dasharray="282.7" stroke-dashoffset="0"/></svg>
      <div class="n" id="num">${fmt(P.left)}</div></div>
    <div class="next">${s.next ? `${s.next.ex.image ? `<img class="thumb" src="${s.next.ex.image[1]}" alt="">` : ''}<div><div class="mut">Next</div><div style="font-weight:600;font-size:18px">${s.next.ex.name}</div><div class="mut">${s.next.ex.targetReps ? s.next.ex.targetReps + ' reps · ' : ''}${s.next.dur}s · ${s.next.ex.equipment.join(', ')}</div></div>` : '<div style="font-weight:600">Last one. Finish strong!</div>'}</div>
    <div class="ctrl"><button id="bPrev">⏮</button><button id="bPause" class="pri" style="flex:2">${P.paused ? '▶ Resume' : '⏸ Pause'}</button><button id="bSkip" title="Skip (no log)" aria-label="Skip without logging">⏭</button></div>
    <button id="bQuit" style="margin-top:4px;padding:8px;background:none;color:var(--mut);flex-shrink:0">End workout</button>`;
  $('#bPause').onclick = togglePause; if (pw) wireSetLog(pw);
  const bd = $('#bDemo'); if (bd) bd.onclick = ev => { ev.preventDefault(); openDemo(bd.href); }; $('#bSkip').onclick = () => skip(1); const bdn = $('#bDone'); if (bdn) bdn.onclick = doneEarly;
  const bs = $('#bSwap'); if (bs) longPress(bs, () => playerSwap(true), () => playerSwap(false));
  const ba = $('#bAvoid'); if (ba) ba.onclick = () => { const s = P.steps[P.i], tgt = s.type === 'work' ? s.ex : s.next && s.next.ex, sl = findSlot(tgt); if (sl) { avoidOriginal(...sl); render(); } }; $('#bPrev').onclick = () => skip(-1); $('#bQuit').onclick = quit;
  renderTime();
}
function setupHTML(s) {
  const b = today.blocks.find(x => x.name === s.nextBlock), items = (b && b.items) || s.nextItems || [];
  const eq = [...new Set(items.flatMap(e => e.equipment || []))];
  return `<div class="hist setupcard" id="setupCard"><div class="hh">Next group · ${esc(s.nextBlock)} · ${(b && b.rounds) || s.nextRounds} rounds</div>${items.map(e => `<div class="hr"><span>${esc(e.name)}</span><b>${e.targetReps ? e.targetReps + ' reps' : fmt(e.work) + (e.work < 60 ? ' s' : '')}</b></div>`).join('')}${eq.length ? `<div class="sueq">Equipment: ${esc(eq.join(', '))}</div>` : ''}</div>`;
}
function renderTime() {
  const s = P.steps[P.i]; if (!s) return;
  const n = $('#num'), a = $('#arc'); if (n) n.textContent = fmt(P.left);
  if (a) a.setAttribute('stroke-dashoffset', (282.7 * (1 - P.left / s.dur)).toFixed(1));
  const im = $('#pimg'); // alternate start/end frames every ~1.2s while working
  if (im && !P.paused) { const f = im.dataset.f.split('|'), k = s.type === 'work' ? Math.floor((s.dur - P.left) / 1.2) % f.length : 0; if (!im.src.endsWith(f[k])) im.src = f[k]; }
}
function finish() {
  stopPlayer(); beep(1320, 500); say('Workout complete. Great job!');
  const mins = Math.round((Date.now() - P.started) / 60000);
  const lifts = today.blocks.filter(b => b.kind === 'main').flatMap(b => b.items);
  const tab = $('#tab-today');
  tab.onclick = null; tab.onkeydown = null; closePreview(true);
  tab.innerHTML = `<div class="hero"><div class="t">Done! 🎉</div><div class="s">${today.day} · ${mins} min</div></div>
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
  history.push({ date: new Date().toISOString(), day: today.day, split: settings.daysPerWeek, minutes: mins, exerciseIds: today.blocks.flatMap(b => b.items.map(e => e.id)), swaps: netSwaps(), swapTaps: (today.swaps || []).length, log,
    sets: Object.values(P.sets || {}).sort((a, b) => a.t - b.t).map(x => ({ id: x.id, block: x.block, round: x.round, weight: x.w, reps: x.r })) });
  LS.set('gc_history', history); localStorage.removeItem('gc_swaps'); shuffleN = 0; today = generate();
}

/* ---------- exercise preview (pre-workout overview): big start/end images + details, never starts the workout ---------- */
function previewHTML(bi, ii) {
  const w = today, b = w.blocks[bi], e = b.items[ii], warm = b.kind === 'warmup' || b.kind === 'cooldown';
  const sg = suggest(e.id), hist = recentHistory(e, 3);
  const bk = nextAlternate(w, bi, ii), bkName = bk ? byId(bk).name : '';
  const vol = `${b.rounds} × ${e.targetReps ? e.targetReps + ' reps' : fmt(e.work) + (e.work < 60 ? ' s' : '')}`;
  const volSub = e.targetReps ? (e.reps ? `range ${e.reps[0]}–${e.reps[1]}` : '') : 'timed';
  const rest = warm ? '10 s' : e.rest + ' s', restSub = warm ? 'transition' : b.items.length > 1 ? (ii < b.items.length - 1 ? `after the round · ${clampSwitch()} s switch to next` : 'after the round (both done)') : 'after each round';
  const imgs = e.image || [];
  const st = (k, v, sub) => `<div class="pvst"><small>${k}</small><b>${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  return `<div class="pvsheet" id="pvSheet" role="dialog" aria-modal="true" aria-labelledby="pvTitle">
    <div class="pvgrab" aria-hidden="true"></div>
    <div class="pvhead"><div><div class="pvblk">${esc(b.name)}${e.origId && e.origId !== e.id ? ` · swapped for ${esc(byId(e.origId).name)}` : ''}</div><h2 id="pvTitle">${esc(e.name)}</h2><div class="mut">${esc(e.muscles.join(', '))}</div></div>
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
  const w = today; const split = SPLITS[settings.daysPerWeek] || SPLITS[4];
  const doneToday = history.some(h => dateKey(new Date(h.date)) === dateKey(new Date()));
  $('#title').textContent = 'Today'; $('#sub').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  $('#tab-today').innerHTML = `
   <div class="hero"><div class="s">Day ${w.dayIndex + 1} of ${split.length}${doneToday ? ' · ✅ trained today, this is up next' : ''}</div>
     <div class="rot">${split.map((d, k) => `<span class="${k === w.dayIndex ? 'on' : ''}">${d.short || d.name}</span>`).join('<i>→</i>')}</div>
     <div class="t">${w.day}</div><div class="s">${w.focus}</div><div class="s nextday">Next workout: <b>${w.nextDay}</b></div>
     <span class="pill">⏱ ~${w.estMin} min</span><span class="pill">${w.blocks.length} blocks</span><span class="pill">${settings.level}</span></div>
   <button class="pri" id="bStart">▶ Start workout</button>
   <div class="mut pvhint">Tap any exercise for a big preview</div>
   ${w.blocks.map(b => `<div class="card block"><div class="bt">${b.name} <span class="mut">· ${b.rounds} round${b.rounds > 1 ? 's' : ''}</span></div>
     ${b.items.map((e, ii) => { const sg = suggest(e.id); const bi = w.blocks.indexOf(b); const sw = e.origId && e.origId !== e.id; return `<div class="ex pv" data-bi="${bi}" data-ii="${ii}" role="button" tabindex="0" aria-label="Preview ${esc(e.name)}">${e.image ? `<img class="thumb" loading="lazy" src="${e.image[0]}" alt="">` : ''}<div style="flex:1">${e.name}<br><small>${e.targetReps ? e.targetReps + ' reps · ' : ''}${e.equipment.join(', ')}${sg && sgText(e, sg) ? ' · try ' + sgText(e, sg) : ''}</small>${demoLink(e, 'sm', '▶ Demo')}${e.autoFor ? `<div class="swapnote">🚫 replaces ${esc(byId(e.autoFor).name)} (avoided)</div>` : ''}${sw ? `<div class="swapnote">⇄ for ${esc(byId(e.origId).name)} · <button class="avoid sm" data-bi="${bi}" data-ii="${ii}">🚫 Avoid it</button></div>` : ''}</div><div class="mut" style="text-align:right">${fmt(e.work)}${e.work < 60 ? 's' : ''} / ${e.rest}s<br><button class="swap sm" data-bi="${bi}" data-ii="${ii}" title="Tap: next backup · Hold: avoid permanently">⇄ Swap</button></div></div>`; }).join('')}</div>`).join('')}
   <div class="row" style="margin:10px 0 20px"><button id="bShuffle">🔀 Shuffle exercises</button><button id="bSkipDay">Skip to next day</button></div>`;
  $('#bStart').onclick = startWorkout;
  const tt = $('#tab-today'); // tap a row (not its Swap/Avoid/Demo controls) -> large preview
  tt.onclick = ev => { if (ev.target.closest('button,a,input,select')) return; const r = ev.target.closest('.ex.pv'); if (r) openPreview(+r.dataset.bi, +r.dataset.ii); };
  tt.onkeydown = ev => { const r = ev.target.closest && ev.target.closest('.ex.pv'); if (r && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openPreview(+r.dataset.bi, +r.dataset.ii); } };
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
    <label>Rest between rounds (after both exercises; lifts; core/conditioning get half, min 30 s)</label><select id="sRest">${[30, 45, 60, 75, 90, 120].map(d => `<option value="${d}" ${d == settings.restSec ? 'selected' : ''}>${d} s</option>`).join('')}</select>
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
    <div class="chk"><input type="checkbox" id="sRower" ${settings.rower ? 'checked' : ''}><span><b>Rower</b> <small class="mut">· ${nRow} exercises · off while it's malfunctioning; warm-up uses step runs instead</small></span></div>
    <label>Kettlebells (lb, one number per bell)</label><input id="sKb" value="${settings.kettlebells.join(', ')}"><div class="mut" style="font-size:13px" id="kbTxt">You have ${kbTxt}. Single-bell moves use one bell; double moves need a pair (2 × 25).</div></div>
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
  $('#bTestSound').onclick = () => { unlockAudio(); beep(880, 150, 0.3, true); setTimeout(() => beep(1320, 300, 0.3, true), 350); say('Sound check. Rest, 60 seconds. Next up, push-ups.', true);
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
  window.__gc = {doneEarly, WAKE, acquireWake, releaseWake, get wakeVid() { return wakeVid; }, get setLog() { return setLog; }, set setLog(v) { setLog = v; }, lastSet, logStepFor, render, recentHistory, saveAndNext, isBW, get actx() { return actx; }, get lastBeepPath() { return lastBeepPath; }, unlockAudio, beep, openPreview, closePreview, get history() { return history; }, set history(v) { history = v; }, assignCueOffsets, cuesFor, kbOptions, available, generate, buildSteps, get today() { return today; }, set today(v) { today = v; }, P, SPLITS, settings, saveSession, doSwap, avoidAndSwap, slotCandidates, suggest, get LIB() { return LIB; } };
}
boot().catch(e => { document.body.insertAdjacentHTML('afterbegin', `<pre style="color:#f66">${e}</pre>`); console.error(e); });
