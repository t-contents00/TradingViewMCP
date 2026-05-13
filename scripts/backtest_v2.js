#!/usr/bin/env node
/**
 * Enhanced backtest:
 *   - Supertrend(10,3) on each TF with opposite-flip exit
 *   - Daily-pivot confluence filter (long only when above prior-day P, short only when below)
 *   - Session classification: Tokyo / London / NY-overlap / Off-hours
 *   - ATR-normalized P/L for cross-TF comparison
 */

import { readFileSync } from 'fs';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node backtest_v2.js <ohlcv.json>...'); process.exit(1); }

const SPREAD = 0.3;

// === Indicators ===
function supertrend(bars, period = 10, mult = 3) {
  const atrs = [];
  let prevAtr = 0;
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[0].high - bars[0].low :
      Math.max(bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close));
    if (i < period) { prevAtr += tr / period; atrs.push(i === period - 1 ? prevAtr : NaN); }
    else { prevAtr = (prevAtr * (period - 1) + tr) / period; atrs.push(prevAtr); }
  }
  const st = [];
  let prevDir = 1, prevUpper = Infinity, prevLower = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    if (isNaN(atrs[i])) { st.push({ line: NaN, direction: 0 }); continue; }
    const hl2 = (bars[i].high + bars[i].low) / 2;
    const bU = hl2 + mult * atrs[i], bL = hl2 - mult * atrs[i];
    const fU = (bU < prevUpper || bars[i - 1].close > prevUpper) ? bU : prevUpper;
    const fL = (bL > prevLower || bars[i - 1].close < prevLower) ? bL : prevLower;
    let dir;
    if (prevDir === 1 && bars[i].close < fL) dir = -1;
    else if (prevDir === -1 && bars[i].close > fU) dir = 1;
    else dir = prevDir;
    st.push({ line: dir === 1 ? fL : fU, direction: dir, atr: atrs[i] });
    prevDir = dir; prevUpper = fU; prevLower = fL;
  }
  return st;
}

// === Daily pivot walk-forward ===
// For each bar at time t, compute the pivot using the prior UTC day's H/L/C.
// This avoids look-ahead.
function dailyPivots(bars) {
  // Group bars by UTC day
  const dayMap = new Map();
  for (const b of bars) {
    const day = Math.floor(b.time / 86400);
    if (!dayMap.has(day)) dayMap.set(day, { high: b.high, low: b.low, close: b.close, open: b.open, lastTime: b.time });
    else {
      const d = dayMap.get(day);
      d.high = Math.max(d.high, b.high);
      d.low = Math.min(d.low, b.low);
      if (b.time >= d.lastTime) { d.close = b.close; d.lastTime = b.time; }
    }
  }
  // Build pivot table: for each day, pivot computed from the PRIOR day's H/L/C
  const pivotByDay = new Map();
  const days = [...dayMap.keys()].sort((a, b) => a - b);
  for (let i = 1; i < days.length; i++) {
    const prev = dayMap.get(days[i - 1]);
    const P = (prev.high + prev.low + prev.close) / 3;
    const R1 = 2 * P - prev.low;
    const S1 = 2 * P - prev.high;
    pivotByDay.set(days[i], { P, R1, S1, prevH: prev.high, prevL: prev.low });
  }
  return pivotByDay;
}

// === Session classification (UTC) ===
function classifySession(unix) {
  const h = new Date(unix * 1000).getUTCHours();
  if (h >= 13 && h < 16) return 'london_ny_overlap'; // 22:00-01:00 JST
  if (h >= 8 && h < 13) return 'london';            // 17:00-22:00 JST
  if (h >= 16 && h < 21) return 'ny';               // 01:00-06:00 JST
  if (h >= 0 && h < 8) return 'tokyo';              // 09:00-17:00 JST
  return 'off_hours';
}

// === Backtest engine ===
function runSupertrend(bars, label, opts = {}) {
  const { useConfluenceFilter = false } = opts;
  const st = supertrend(bars, 10, 3);
  const pivots = dailyPivots(bars);
  const trades = [];
  let dirPrev = st[10]?.direction || 0;

  for (let i = 11; i < bars.length - 1; i++) {
    const dirNow = st[i].direction;
    if (dirNow !== dirPrev && dirNow !== 0) {
      const entryBar = bars[i + 1];
      const entry = entryBar.open;
      const direction = dirNow;
      const sl = st[i].line;
      const session = classifySession(entryBar.time);
      const day = Math.floor(entryBar.time / 86400);
      const piv = pivots.get(day);

      // Confluence filter: long only when above prior P; short only when below
      let skipped = false;
      if (useConfluenceFilter && piv) {
        if (direction === 1 && entry < piv.P) skipped = true;
        if (direction === -1 && entry > piv.P) skipped = true;
      }
      if (skipped) { dirPrev = dirNow; continue; }

      let exit = null, exitReason = '';
      for (let j = i + 1; j < bars.length; j++) {
        if (direction === 1 && bars[j].low <= sl) { exit = sl; exitReason = 'SL'; break; }
        if (direction === -1 && bars[j].high >= sl) { exit = sl; exitReason = 'SL'; break; }
        if (st[j].direction === -direction) { exit = bars[j].close; exitReason = 'flip'; break; }
      }
      if (exit === null) { exit = bars[bars.length - 1].close; exitReason = 'eod'; }
      const pnl = (direction === 1 ? exit - entry : entry - exit) - SPREAD;
      const atrEntry = st[i].atr;
      trades.push({ entry, exit, direction, pnl, exitReason, session, pnl_atr: pnl / atrEntry, atr: atrEntry });
      dirPrev = dirNow;
    }
  }
  return { label, trades };
}

// === Summary helpers ===
function summary(trades, name) {
  if (!trades.length) return { name, trades: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return {
    name,
    trades: trades.length,
    win_rate: +(wins.length / trades.length * 100).toFixed(1),
    avg_win: +avgWin.toFixed(2),
    avg_loss: +avgLoss.toFixed(2),
    rr_realized: +(Math.abs(avgWin / (avgLoss || -1))).toFixed(2),
    expectancy_per_trade: +((wins.length / trades.length) * avgWin + (1 - wins.length / trades.length) * avgLoss).toFixed(2),
    total_pnl: +totalPnl.toFixed(2),
    profit_factor: totalLoss === 0 ? Infinity : +(totalWin / totalLoss).toFixed(2),
    atr_normalized_expectancy: +(trades.reduce((s, t) => s + (t.pnl_atr || 0), 0) / trades.length).toFixed(3),
  };
}

function summaryBySession(trades, name) {
  const sessions = ['tokyo', 'london', 'london_ny_overlap', 'ny', 'off_hours'];
  return sessions.map(s => summary(trades.filter(t => t.session === s), `${name} | ${s}`)).filter(r => r.trades > 0);
}

// === Run ===
const allOutput = {};
for (const file of files) {
  const data = JSON.parse(readFileSync(file, 'utf-8'));
  const bars = data.bars;
  const days = ((bars[bars.length - 1].time - bars[0].time) / 86400).toFixed(2);
  const tfMatch = file.match(/(\d+m|\d+h|1h|5m)/i);
  const tf = tfMatch ? tfMatch[1] : file.replace(/\W/g, '_');

  console.error(`\n=== ${file}: ${bars.length} bars, ${days} days ===`);

  const r1 = runSupertrend(bars, `${tf}_st_unfiltered`).trades;
  const r2 = runSupertrend(bars, `${tf}_st_pivot_confluence`, { useConfluenceFilter: true }).trades;

  allOutput[`${tf}_overall`] = {
    unfiltered: summary(r1, `${tf} ST (no filter)`),
    pivot_confluence: summary(r2, `${tf} ST + Daily Pivot agree`),
    by_session_unfiltered: summaryBySession(r1, `${tf} ST`),
    by_session_confluence: summaryBySession(r2, `${tf} ST+Pivot`),
  };
}

console.log(JSON.stringify(allOutput, null, 2));
