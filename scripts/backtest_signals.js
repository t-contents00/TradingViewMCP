#!/usr/bin/env node
/**
 * Walk-forward backtest for scalp signals.
 *
 * Tests two signal types per timeframe:
 *   1. Supertrend(10, 3) reversal — enter on flip, exit on opposite flip
 *      (matches user's primary indicator)
 *   2. RSI(14) extreme mean-reversion — long <30, short >70, exit @ 50 or N bars
 *
 * Outputs: trade count, win rate, avg pips, RR, expectancy per signal × TF.
 */

import { readFileSync } from 'fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node backtest_signals.js <ohlcv.json>...');
  process.exit(1);
}

// === Indicators ===

function supertrend(bars, period = 10, mult = 3) {
  // Wilder ATR
  const atrs = [];
  let prevAtr = 0;
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[0].high - bars[0].low :
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      );
    if (i < period) {
      prevAtr += tr / period;
      atrs.push(i === period - 1 ? prevAtr : NaN);
    } else {
      prevAtr = (prevAtr * (period - 1) + tr) / period;
      atrs.push(prevAtr);
    }
  }

  // Supertrend computation
  const st = []; // { line, direction }
  let prevDir = 1, prevLine = 0, prevUpper = Infinity, prevLower = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    if (isNaN(atrs[i])) { st.push({ line: NaN, direction: 0 }); continue; }
    const hl2 = (bars[i].high + bars[i].low) / 2;
    let basicUpper = hl2 + mult * atrs[i];
    let basicLower = hl2 - mult * atrs[i];
    let finalUpper = (basicUpper < prevUpper || bars[i - 1].close > prevUpper) ? basicUpper : prevUpper;
    let finalLower = (basicLower > prevLower || bars[i - 1].close < prevLower) ? basicLower : prevLower;

    let dir;
    if (prevDir === 1 && bars[i].close < finalLower) dir = -1;
    else if (prevDir === -1 && bars[i].close > finalUpper) dir = 1;
    else dir = prevDir;

    const line = dir === 1 ? finalLower : finalUpper;
    st.push({ line, direction: dir });

    prevDir = dir;
    prevLine = line;
    prevUpper = finalUpper;
    prevLower = finalLower;
  }
  return st;
}

function rsi(bars, period = 14) {
  const closes = bars.map(b => b.close);
  const out = [];
  let gainAvg = 0, lossAvg = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { out.push(NaN); continue; }
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i < period) {
      gainAvg += gain / period;
      lossAvg += loss / period;
      out.push(i === period ? 100 - 100 / (1 + gainAvg / lossAvg) : NaN);
    } else {
      gainAvg = (gainAvg * (period - 1) + gain) / period;
      lossAvg = (lossAvg * (period - 1) + loss) / period;
      const rs = lossAvg === 0 ? 100 : gainAvg / lossAvg;
      out.push(100 - 100 / (1 + rs));
    }
  }
  return out;
}

function atr(bars, period = 14) {
  const out = [];
  let prev = 0;
  for (let i = 0; i < bars.length; i++) {
    const tr = i === 0 ? bars[0].high - bars[0].low :
      Math.max(
        bars[i].high - bars[i - 1].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      );
    if (i < period) { prev += tr / period; out.push(NaN); }
    else if (i === period) { out.push(prev); }
    else { prev = (prev * (period - 1) + tr) / period; out.push(prev); }
  }
  return out;
}

// === Backtest engines ===

const SPREAD = 0.3; // XAUUSD typical scalp spread $0.3

function backtestSupertrend(bars, label) {
  const st = supertrend(bars, 10, 3);
  const trades = [];
  let dirPrev = st[10]?.direction || 0;

  for (let i = 11; i < bars.length - 1; i++) {
    const dirNow = st[i].direction;
    if (dirNow !== dirPrev && dirNow !== 0) {
      // Signal: enter at next bar open in new direction
      const entryBar = bars[i + 1];
      const entry = entryBar.open;
      const sl = st[i].line; // initial SL = supertrend line
      const direction = dirNow;
      // Walk forward until opposite flip
      let exit = null, exitReason = '';
      for (let j = i + 1; j < bars.length; j++) {
        // SL hit intrabar
        if (direction === 1 && bars[j].low <= sl) { exit = sl; exitReason = 'SL'; break; }
        if (direction === -1 && bars[j].high >= sl) { exit = sl; exitReason = 'SL'; break; }
        // Opposite flip
        if (st[j].direction === -direction) {
          exit = bars[j].close;
          exitReason = 'flip';
          break;
        }
      }
      if (exit === null) { exit = bars[bars.length - 1].close; exitReason = 'eod'; }
      const pnl = (direction === 1 ? exit - entry : entry - exit) - SPREAD;
      trades.push({ entry, exit, direction, pnl, exitReason, bars: 1 });
      dirPrev = dirNow;
    }
  }
  return summarize(trades, label + ' Supertrend(10,3) flip');
}

function backtestRSI(bars, label) {
  const rs = rsi(bars, 14);
  const at = atr(bars, 14);
  const trades = [];
  let inLong = false, inShort = false;
  let entry = 0, slLevel = 0, tpLevel = 0, entryBar = 0;

  for (let i = 15; i < bars.length - 1; i++) {
    if (!inLong && !inShort) {
      if (rs[i] < 30 && rs[i - 1] >= 30) {
        inLong = true;
        entry = bars[i + 1].open;
        slLevel = entry - 1.5 * at[i];
        tpLevel = entry + 2 * at[i];
        entryBar = i + 1;
      } else if (rs[i] > 70 && rs[i - 1] <= 70) {
        inShort = true;
        entry = bars[i + 1].open;
        slLevel = entry + 1.5 * at[i];
        tpLevel = entry - 2 * at[i];
        entryBar = i + 1;
      }
    } else if (inLong) {
      if (bars[i].low <= slLevel) {
        trades.push({ entry, exit: slLevel, direction: 1, pnl: slLevel - entry - SPREAD, exitReason: 'SL', bars: i - entryBar });
        inLong = false;
      } else if (bars[i].high >= tpLevel) {
        trades.push({ entry, exit: tpLevel, direction: 1, pnl: tpLevel - entry - SPREAD, exitReason: 'TP', bars: i - entryBar });
        inLong = false;
      } else if (rs[i] >= 50) {
        trades.push({ entry, exit: bars[i].close, direction: 1, pnl: bars[i].close - entry - SPREAD, exitReason: 'RSI50', bars: i - entryBar });
        inLong = false;
      } else if (i - entryBar > 30) {
        trades.push({ entry, exit: bars[i].close, direction: 1, pnl: bars[i].close - entry - SPREAD, exitReason: 'time', bars: i - entryBar });
        inLong = false;
      }
    } else if (inShort) {
      if (bars[i].high >= slLevel) {
        trades.push({ entry, exit: slLevel, direction: -1, pnl: entry - slLevel - SPREAD, exitReason: 'SL', bars: i - entryBar });
        inShort = false;
      } else if (bars[i].low <= tpLevel) {
        trades.push({ entry, exit: tpLevel, direction: -1, pnl: entry - tpLevel - SPREAD, exitReason: 'TP', bars: i - entryBar });
        inShort = false;
      } else if (rs[i] <= 50) {
        trades.push({ entry, exit: bars[i].close, direction: -1, pnl: entry - bars[i].close - SPREAD, exitReason: 'RSI50', bars: i - entryBar });
        inShort = false;
      } else if (i - entryBar > 30) {
        trades.push({ entry, exit: bars[i].close, direction: -1, pnl: entry - bars[i].close - SPREAD, exitReason: 'time', bars: i - entryBar });
        inShort = false;
      }
    }
  }
  return summarize(trades, label + ' RSI<30/>70 reversion');
}

function summarize(trades, name) {
  if (trades.length === 0) return { name, trades: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const winRate = wins.length / trades.length;
  const rr = Math.abs(avgWin / (avgLoss || -1));
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  const profitFactor = avgLoss === 0 ? Infinity :
    (wins.reduce((s, t) => s + t.pnl, 0)) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0) || 1);
  return {
    name,
    trades: trades.length,
    win_rate: +(winRate * 100).toFixed(1),
    avg_win: +avgWin.toFixed(2),
    avg_loss: +avgLoss.toFixed(2),
    rr_realized: +rr.toFixed(2),
    expectancy_per_trade: +expectancy.toFixed(2),
    total_pnl: +totalPnl.toFixed(2),
    profit_factor: +profitFactor.toFixed(2),
    exit_breakdown: trades.reduce((acc, t) => { acc[t.exitReason] = (acc[t.exitReason] || 0) + 1; return acc; }, {})
  };
}

// === Run on each file ===

const results = [];
for (const file of files) {
  const data = JSON.parse(readFileSync(file, 'utf-8'));
  const bars = data.bars;
  const tf = file.match(/_(\d+m|\d+h|1h)_/i)?.[1] || file;
  console.error(`Backtesting ${file}: ${bars.length} bars, period ${new Date(bars[0].time * 1000).toISOString()} -> ${new Date(bars[bars.length - 1].time * 1000).toISOString()}`);
  results.push(backtestSupertrend(bars, tf));
  results.push(backtestRSI(bars, tf));
}

console.log(JSON.stringify(results, null, 2));
