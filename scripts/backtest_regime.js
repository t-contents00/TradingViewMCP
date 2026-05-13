#!/usr/bin/env node
/**
 * Regime-aware backtest:
 *   - Compute Daily Supertrend → daily regime (up-trend / down-trend)
 *   - Compute Weekly Supertrend → macro regime (bull / bear)
 *   - Classify each 1H / 5m trade by what regime it occurred in
 *   - Report performance per regime to find: does the strategy work better in trends?
 */

import { readFileSync } from 'fs';

const SPREAD = 0.3;

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
    st.push({ line: dir === 1 ? fL : fU, direction: dir, atr: atrs[i], time: bars[i].time });
    prevDir = dir; prevUpper = fU; prevLower = fL;
  }
  return st;
}

// Get regime direction at a given unix timestamp from a higher-TF Supertrend series.
// Returns 1 (up), -1 (down), 0 (no signal).
function regimeAt(stSeries, unix) {
  // Find the latest ST bar whose time <= unix
  let result = 0;
  for (let i = stSeries.length - 1; i >= 0; i--) {
    if (stSeries[i].time <= unix) {
      result = stSeries[i].direction;
      break;
    }
  }
  return result;
}

function classifySession(unix) {
  const h = new Date(unix * 1000).getUTCHours();
  if (h >= 13 && h < 16) return 'london_ny_overlap';
  if (h >= 8 && h < 13) return 'london';
  if (h >= 16 && h < 21) return 'ny';
  if (h >= 0 && h < 8) return 'tokyo';
  return 'off_hours';
}

function runSupertrend(bars, dailyST, weeklyST, label) {
  const st = supertrend(bars, 10, 3);
  const trades = [];
  let dirPrev = st[10]?.direction || 0;

  for (let i = 11; i < bars.length - 1; i++) {
    const dirNow = st[i].direction;
    if (dirNow !== dirPrev && dirNow !== 0) {
      const entryBar = bars[i + 1];
      const entry = entryBar.open;
      const direction = dirNow;
      const sl = st[i].line;
      const dailyRegime = regimeAt(dailyST, entryBar.time);
      const weeklyRegime = regimeAt(weeklyST, entryBar.time);
      const aligned_daily = direction === dailyRegime;
      const aligned_weekly = direction === weeklyRegime;
      const session = classifySession(entryBar.time);

      let exit = null, exitReason = '';
      for (let j = i + 1; j < bars.length; j++) {
        if (direction === 1 && bars[j].low <= sl) { exit = sl; exitReason = 'SL'; break; }
        if (direction === -1 && bars[j].high >= sl) { exit = sl; exitReason = 'SL'; break; }
        if (st[j].direction === -direction) { exit = bars[j].close; exitReason = 'flip'; break; }
      }
      if (exit === null) { exit = bars[bars.length - 1].close; exitReason = 'eod'; }
      const pnl = (direction === 1 ? exit - entry : entry - exit) - SPREAD;
      trades.push({
        entry, exit, direction, pnl, exitReason, session,
        dailyRegime, weeklyRegime, aligned_daily, aligned_weekly,
        pnl_atr: pnl / st[i].atr
      });
      dirPrev = dirNow;
    }
  }
  return trades;
}

function stats(trades, name) {
  if (!trades.length) return { name, trades: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return {
    name,
    n: trades.length,
    win_rate: +(wins.length / trades.length * 100).toFixed(1),
    expectancy: +((totalWin - totalLoss) / trades.length).toFixed(2),
    total_pnl: +(totalWin - totalLoss).toFixed(2),
    pf: totalLoss === 0 ? Infinity : +(totalWin / totalLoss).toFixed(2),
  };
}

// === Load data ===
const dailyData = JSON.parse(readFileSync('xauusd_daily.json', 'utf-8'));
const weeklyData = JSON.parse(readFileSync('xauusd_weekly.json', 'utf-8'));
const oneHData = JSON.parse(readFileSync('xauusd_1h_30d.json', 'utf-8'));
const fiveMData = JSON.parse(readFileSync('xauusd_5m_full.json', 'utf-8'));

console.error(`Daily: ${dailyData.bar_count} bars (${((dailyData.bars[dailyData.bars.length - 1].time - dailyData.bars[0].time) / 86400 / 365.25).toFixed(2)} years)`);
console.error(`Weekly: ${weeklyData.bar_count} bars`);

const dailyST = supertrend(dailyData.bars, 10, 3);
const weeklyST = supertrend(weeklyData.bars, 10, 3);

const currentDailyRegime = dailyST[dailyST.length - 1].direction;
const currentWeeklyRegime = weeklyST[weeklyST.length - 1].direction;
console.error(`\nCurrent Daily regime: ${currentDailyRegime === 1 ? 'UP' : 'DOWN'}`);
console.error(`Current Weekly regime: ${currentWeeklyRegime === 1 ? 'BULL' : 'BEAR'}`);

// === Backtest 1H trades classified by regime ===
const tradesH = runSupertrend(oneHData.bars, dailyST, weeklyST, '1H');
const tradesM = runSupertrend(fiveMData.bars, dailyST, weeklyST, '5m');

const output = {
  current_regime: {
    daily: currentDailyRegime === 1 ? 'UP' : 'DOWN',
    weekly: currentWeeklyRegime === 1 ? 'BULL' : 'BEAR',
  },
  '1h_overall': stats(tradesH, '1H all'),
  '1h_daily_aligned': stats(tradesH.filter(t => t.aligned_daily), '1H trade aligns with Daily ST'),
  '1h_daily_against': stats(tradesH.filter(t => !t.aligned_daily), '1H trade against Daily ST'),
  '1h_weekly_aligned': stats(tradesH.filter(t => t.aligned_weekly), '1H trade aligns with Weekly ST'),
  '1h_weekly_against': stats(tradesH.filter(t => !t.aligned_weekly), '1H trade against Weekly ST'),
  '1h_both_aligned': stats(tradesH.filter(t => t.aligned_daily && t.aligned_weekly), '1H aligned with Daily AND Weekly'),
  '1h_both_against': stats(tradesH.filter(t => !t.aligned_daily && !t.aligned_weekly), '1H against both'),
  '5m_overall': stats(tradesM, '5m all'),
  '5m_daily_aligned': stats(tradesM.filter(t => t.aligned_daily), '5m trade aligns with Daily ST'),
  '5m_daily_against': stats(tradesM.filter(t => !t.aligned_daily), '5m trade against Daily ST'),
  '5m_weekly_aligned': stats(tradesM.filter(t => t.aligned_weekly), '5m aligns with Weekly ST'),
  '5m_both_aligned': stats(tradesM.filter(t => t.aligned_daily && t.aligned_weekly), '5m aligned with Daily AND Weekly'),
};

// Daily Supertrend on its own — what would happen if we just traded Daily ST?
const tradesD = runSupertrend(dailyData.bars, dailyST, weeklyST, 'Daily');
output['daily_st_alone'] = stats(tradesD, 'Daily ST (n=' + tradesD.length + ')');

console.log(JSON.stringify(output, null, 2));
