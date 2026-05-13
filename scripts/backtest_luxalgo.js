#!/usr/bin/env node
/**
 * Backtest 5m Supertrend with LuxAlgo SMC confluence filter.
 *
 * Reads:
 *   - chart_full_bars.json: 1638 5m bars (8 days from chart memory)
 *   - luxalgo_labels.json: 502 BOS/CHoCH/EQH/EQL labels
 *
 * Filter: only take Supertrend flip if a same-direction LuxAlgo BOS or CHoCH
 * label appears within +/- LOOKBACK bars of the entry.
 *
 * Bullish color = rgb(129,153,8) lime; Bearish = rgb(69,54,242) blue/purple.
 */

import { readFileSync } from 'fs';

const SPREAD = 0.3;
const LOOKBACK = 5; // bars before entry to look for confluence

// === Indicators ===
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

// === Color decode ===
function argbColor(n) {
  const r = (n >>> 16) & 0xFF, g = (n >>> 8) & 0xFF, b = n & 0xFF;
  return `${r},${g},${b}`;
}
const BULL_COLOR = '129,153,8'; // lime
const BEAR_COLOR = '69,54,242'; // blue

function labelDirection(lbl) {
  const c = argbColor(lbl.textColor);
  if (c === BULL_COLOR) return 1;
  if (c === BEAR_COLOR) return -1;
  return 0;
}

// === Load data ===
const chartData = JSON.parse(readFileSync('chart_full_bars.json', 'utf-8')).result;
const bars = chartData.bars;
const labels = JSON.parse(readFileSync('luxalgo_labels.json', 'utf-8')).studies[0].labels;

console.error(`Bars: ${bars.length}, Labels: ${labels.length}`);
console.error(`Period: ${new Date(bars[0].t*1000).toISOString()} -> ${new Date(bars[bars.length-1].t*1000).toISOString()}`);

// Annotate labels with direction
for (const lbl of labels) lbl.dir = labelDirection(lbl);

// Build index: bar array index -> labels at that index
const labelsByIdx = new Map();
for (const lbl of labels) {
  if (!labelsByIdx.has(lbl.x)) labelsByIdx.set(lbl.x, []);
  labelsByIdx.get(lbl.x).push(lbl);
}

// === Session classification ===
function session(unix) {
  const h = new Date(unix * 1000).getUTCHours();
  if (h >= 13 && h < 16) return 'london_ny_overlap';
  if (h >= 8 && h < 13) return 'london';
  if (h >= 16 && h < 21) return 'ny';
  if (h >= 0 && h < 8) return 'tokyo';
  return 'off_hours';
}

// === Check LuxAlgo confluence near a bar index ===
function nearbyLuxConfluence(barIdx, direction, types) {
  // Check LOOKBACK bars BEFORE the entry for matching-direction same-type signal
  for (let i = barIdx - LOOKBACK; i <= barIdx; i++) {
    if (!labelsByIdx.has(i)) continue;
    for (const lbl of labelsByIdx.get(i)) {
      if (lbl.dir === direction && types.includes(lbl.text)) {
        return { matched: true, type: lbl.text, dist: barIdx - i, lblPrice: lbl.price };
      }
    }
  }
  return { matched: false };
}

// === Backtest ===
function runBacktest(bars, opts = {}) {
  const { requireConfluence = false, confluenceTypes = ['BOS', 'CHoCH'] } = opts;
  const st = supertrend(bars, 10, 3);
  const trades = [];
  let dirPrev = st[10]?.direction || 0;

  for (let i = 11; i < bars.length - 1; i++) {
    const dirNow = st[i].direction;
    if (dirNow !== dirPrev && dirNow !== 0) {
      const entryBar = bars[i + 1];
      const entry = entryBar.o;
      const direction = dirNow;
      const sl = st[i].line;

      let confluence = { matched: !requireConfluence };
      if (requireConfluence) {
        confluence = nearbyLuxConfluence(i, direction, confluenceTypes);
      }

      if (requireConfluence && !confluence.matched) {
        dirPrev = dirNow;
        continue;
      }

      let exit = null, exitReason = '';
      for (let j = i + 1; j < bars.length; j++) {
        if (direction === 1 && bars[j].l <= sl) { exit = sl; exitReason = 'SL'; break; }
        if (direction === -1 && bars[j].h >= sl) { exit = sl; exitReason = 'SL'; break; }
        if (st[j].direction === -direction) { exit = bars[j].c; exitReason = 'flip'; break; }
      }
      if (exit === null) { exit = bars[bars.length - 1].c; exitReason = 'eod'; }
      const pnl = (direction === 1 ? exit - entry : entry - exit) - SPREAD;
      trades.push({
        time: entryBar.t,
        entry, exit, direction, pnl, exitReason,
        session: session(entryBar.t),
        pnl_atr: pnl / st[i].atr,
        confluence: confluence.matched ? confluence.type : null,
        confluence_dist: confluence.dist,
      });
      dirPrev = dirNow;
    }
  }
  return trades;
}

function stats(trades, name) {
  if (!trades.length) return { name, n: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return {
    name,
    n: trades.length,
    win_rate: +(wins.length / trades.length * 100).toFixed(1),
    avg_win: wins.length ? +(totalWin/wins.length).toFixed(2) : 0,
    avg_loss: losses.length ? +(losses.reduce((s,t)=>s+t.pnl,0)/losses.length).toFixed(2) : 0,
    expectancy: +((totalWin - totalLoss) / trades.length).toFixed(2),
    total_pnl: +(totalWin - totalLoss).toFixed(2),
    pf: totalLoss === 0 ? Infinity : +(totalWin / totalLoss).toFixed(2),
    avg_pnl_atr: +(trades.reduce((s,t)=>s+(t.pnl_atr||0),0)/trades.length).toFixed(3),
  };
}

// === Run scenarios ===
const t_all = runBacktest(bars);
const t_bos_chich = runBacktest(bars, { requireConfluence: true, confluenceTypes: ['BOS', 'CHoCH'] });
const t_chich_only = runBacktest(bars, { requireConfluence: true, confluenceTypes: ['CHoCH'] });
const t_bos_only = runBacktest(bars, { requireConfluence: true, confluenceTypes: ['BOS'] });

const output = {
  data: {
    bars: bars.length,
    labels: labels.length,
    period: `${new Date(bars[0].t*1000).toISOString().slice(0,10)} -> ${new Date(bars[bars.length-1].t*1000).toISOString().slice(0,10)}`,
    span_days: ((bars[bars.length-1].t - bars[0].t)/86400).toFixed(2),
  },
  scenarios: [
    stats(t_all, 'ALL: 5m ST flip (no filter)'),
    stats(t_bos_chich, '5m ST + LuxAlgo BOS/CHoCH within ' + LOOKBACK + ' bars'),
    stats(t_chich_only, '5m ST + LuxAlgo CHoCH only (reversal signal)'),
    stats(t_bos_only, '5m ST + LuxAlgo BOS only (continuation signal)'),
  ],
  by_session_all: ['tokyo','london','london_ny_overlap','ny','off_hours'].map(s =>
    stats(t_all.filter(t=>t.session===s), 'ALL | '+s)).filter(r=>r.n>0),
  by_session_chich: ['tokyo','london','london_ny_overlap','ny','off_hours'].map(s =>
    stats(t_chich_only.filter(t=>t.session===s), 'CHoCH | '+s)).filter(r=>r.n>0),
};
console.log(JSON.stringify(output, null, 2));
