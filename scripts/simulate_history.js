#!/usr/bin/env node
/**
 * "Would-have-fired" simulation.
 *
 * Replays the same filter logic as discord_signals.js against the historical
 * chart_full_bars.json + luxalgo_labels.json snapshot, and prints every
 * signal that WOULD have been sent to Discord — same fields as the live embed.
 */

import { readFileSync } from 'fs';

const SPREAD = 0.3;
const LOOKBACK = 5;
const WEEKLY_DIR = process.env.WEEKLY_DIR === 'bear' || process.env.WEEKLY_DIR === '-1' ? -1 : 1;
const TRADEABLE = ['ny', 'london_ny_overlap'];

// === ST ===
function supertrend(bars, period = 10, mult = 3) {
  const atrs = [];
  let prevAtr = 0;
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[0].h - bars[0].l :
      Math.max(bars[i].h - bars[i].l,
        Math.abs(bars[i].h - bars[i - 1].c),
        Math.abs(bars[i].l - bars[i - 1].c));
    if (i < period) { prevAtr += tr / period; atrs.push(i === period - 1 ? prevAtr : NaN); }
    else { prevAtr = (prevAtr * (period - 1) + tr) / period; atrs.push(prevAtr); }
  }
  const st = [];
  let prevDir = 1, prevUpper = Infinity, prevLower = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    if (isNaN(atrs[i])) { st.push({ line: NaN, direction: 0 }); continue; }
    const hl2 = (bars[i].h + bars[i].l) / 2;
    const bU = hl2 + mult * atrs[i], bL = hl2 - mult * atrs[i];
    const fU = (bU < prevUpper || bars[i - 1].c > prevUpper) ? bU : prevUpper;
    const fL = (bL > prevLower || bars[i - 1].c < prevLower) ? bL : prevLower;
    let dir;
    if (prevDir === 1 && bars[i].c < fL) dir = -1;
    else if (prevDir === -1 && bars[i].c > fU) dir = 1;
    else dir = prevDir;
    st.push({ line: dir === 1 ? fL : fU, direction: dir, atr: atrs[i] });
    prevDir = dir; prevUpper = fU; prevLower = fL;
  }
  return st;
}

function session(unix) {
  const h = new Date(unix * 1000).getUTCHours();
  if (h >= 13 && h < 16) return 'london_ny_overlap';
  if (h >= 8 && h < 13) return 'london';
  if (h >= 16 && h < 21) return 'ny';
  if (h >= 0 && h < 8) return 'tokyo';
  return 'off_hours';
}

const chart = JSON.parse(readFileSync('chart_full_bars.json', 'utf-8')).result;
const bars = chart.bars;
const labels = JSON.parse(readFileSync('luxalgo_labels.json', 'utf-8')).studies[0].labels;

const labelsByIdx = new Map();
for (const l of labels) {
  const r = (l.textColor >>> 16) & 0xFF, g = (l.textColor >>> 8) & 0xFF, b = l.textColor & 0xFF;
  l.dir = `${r},${g},${b}` === '129,153,8' ? 1 : `${r},${g},${b}` === '69,54,242' ? -1 : 0;
  if (!labelsByIdx.has(l.x)) labelsByIdx.set(l.x, []);
  labelsByIdx.get(l.x).push(l);
}

function findBOS(barIdx, direction) {
  for (let i = barIdx - LOOKBACK; i <= barIdx; i++) {
    if (!labelsByIdx.has(i)) continue;
    for (const l of labelsByIdx.get(i)) {
      if (l.dir === direction && l.text === 'BOS') return l;
    }
  }
  return null;
}

const st = supertrend(bars, 10, 3);
const signals = [];
let dirPrev = st[10].direction;

for (let i = 11; i < bars.length - 1; i++) {
  const dirNow = st[i].direction;
  if (dirNow === dirPrev || dirNow === 0) continue;
  const entryBar = bars[i + 1];
  const sess = session(entryBar.t);
  const bos = findBOS(i, dirNow);

  const reasons = [];
  if (!TRADEABLE.includes(sess)) reasons.push(`session=${sess}`);
  if (dirNow !== WEEKLY_DIR) reasons.push(`against weekly`);
  if (!bos) reasons.push('no BOS');

  const fired = reasons.length === 0;
  if (fired) {
    // Compute hypothetical outcome
    const entry = entryBar.o;
    const sl = st[i].line;
    let exit = null, reason = '';
    for (let j = i + 1; j < bars.length; j++) {
      if (dirNow === 1 && bars[j].l <= sl) { exit = sl; reason = 'SL'; break; }
      if (dirNow === -1 && bars[j].h >= sl) { exit = sl; reason = 'SL'; break; }
      if (st[j].direction === -dirNow) { exit = bars[j].c; reason = 'flip'; break; }
    }
    if (exit === null) { exit = bars[bars.length - 1].c; reason = 'open'; }
    const pnl = (dirNow === 1 ? exit - entry : entry - exit) - SPREAD;
    signals.push({
      time_utc: new Date(entryBar.t * 1000).toISOString(),
      direction: dirNow === 1 ? 'LONG' : 'SHORT',
      entry: +entry.toFixed(2),
      st_line: +sl.toFixed(2),
      session: sess,
      bos_price: +bos.price.toFixed(2),
      exit: +exit.toFixed(2),
      exit_reason: reason,
      pnl: +pnl.toFixed(2),
    });
  }
  dirPrev = dirNow;
}

console.log('=== Would-have-fired signals (last 8 days) ===');
console.log(`Total: ${signals.length}`);
console.log(`Days: ${((bars[bars.length-1].t - bars[0].t)/86400).toFixed(2)}`);
console.log(`Rate: ${(signals.length / ((bars[bars.length-1].t - bars[0].t)/86400)).toFixed(2)} signals/day\n`);

console.table(signals);

const wins = signals.filter(s => s.pnl > 0);
const totalPnl = signals.reduce((s, x) => s + x.pnl, 0);
console.log(`\nSummary: ${signals.length} trades, ${wins.length} wins (${(wins.length/signals.length*100).toFixed(1)}%), total P&L = $${totalPnl.toFixed(2)} per 1oz`);
console.log(`Per 100oz lot equivalent: $${(totalPnl * 100).toFixed(2)}`);
