#!/usr/bin/env node
/**
 * Send all 6 notification types (entry long, entry short, TP, SL, ST-flip, daily summary)
 * as samples to Discord for visual verification.
 *
 * Run: node --env-file=.env scripts/discord_test_all.js
 */

const URL = process.env.DISCORD_WEBHOOK_URL;
const SYMBOL = process.env.SYMBOL || 'OANDA:XAUUSD';
const RR_TARGET = +(process.env.RR_TARGET || 2.0);
if (!URL) { console.error('DISCORD_WEBHOOK_URL not set'); process.exit(1); }

function tag(t) { return `[SAMPLE] ${t}`; }

async function post(payload) {
  const res = await fetch(URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) { console.error(`✗ ${res.status}: ${await res.text()}`); return false; }
  return true;
}

const mockLong = {
  id: 'SAMPLE-LONG-4708',
  entry_time: Math.floor(Date.now() / 1000) - 1800,
  entry_price: 4708.50, direction: 1,
  sl: 4690.67, tp: 4744.16,
  session: 'ny', weekly_dir: 1,
  bos_price: 4710.85,
};
const mockShort = {
  id: 'SAMPLE-SHORT-4725',
  entry_time: Math.floor(Date.now() / 1000) - 600,
  entry_price: 4725.30, direction: -1,
  sl: 4742.10, tp: 4691.70,
  session: 'london_ny_overlap', weekly_dir: 1,
  bos_price: 4722.85,
};

function entryEmbed(trade) {
  const arrow = trade.direction === 1 ? '🟢' : '🔴';
  const action = trade.direction === 1 ? 'LONG' : 'SHORT';
  const color = trade.direction === 1 ? 0x4ade80 : 0xf87171;
  const fields = [
    { name: 'Entry', value: `$${trade.entry_price.toFixed(2)}`, inline: true },
    { name: 'SL', value: `$${trade.sl.toFixed(2)} (${(trade.sl - trade.entry_price).toFixed(2)})`, inline: true },
    { name: 'Session', value: trade.session, inline: true },
    { name: 'TP', value: `$${trade.tp.toFixed(2)} (RR ${RR_TARGET})`, inline: true },
    { name: 'BOS confluence', value: `$${trade.bos_price.toFixed(2)}`, inline: true },
    { name: 'Weekly regime', value: trade.weekly_dir === 1 ? '📈 BULL (aligned)' : '📉 BEAR', inline: true },
  ];
  return {
    embeds: [{
      title: tag(`${arrow} ${action} ENTRY — ${SYMBOL}`),
      description: `5m Supertrend reversal + LuxAlgo BOS confluence`,
      color, fields,
      footer: { text: `Trade ID: ${trade.id}` },
      timestamp: new Date(trade.entry_time * 1000).toISOString(),
    }],
  };
}

function exitEmbed(trade) {
  const reasonEmoji = trade.exit_reason === 'TP' ? '🎯' : trade.exit_reason === 'SL' ? '⛔' : '🔄';
  const pnlEmoji = trade.pnl > 0 ? '💰' : '📉';
  const color = trade.pnl > 0 ? 0x22c55e : 0xef4444;
  const duration = ((trade.exit_time - trade.entry_time) / 60).toFixed(0);
  return {
    embeds: [{
      title: tag(`${reasonEmoji} EXIT (${trade.exit_reason}) — ${trade.direction === 1 ? 'LONG' : 'SHORT'} ${SYMBOL}`),
      description: `${pnlEmoji} **${trade.pnl > 0 ? '+' : ''}$${trade.pnl.toFixed(2)}/oz** = ${trade.pnl > 0 ? '+' : ''}$${(trade.pnl * 100).toFixed(2)} per 100oz lot`,
      color,
      fields: [
        { name: 'Entry', value: `$${trade.entry_price.toFixed(2)}`, inline: true },
        { name: 'Exit', value: `$${trade.exit_price.toFixed(2)}`, inline: true },
        { name: 'Duration', value: `${duration} min`, inline: true },
        { name: 'Pips move', value: `${(trade.direction === 1 ? trade.exit_price - trade.entry_price : trade.entry_price - trade.exit_price).toFixed(2)}`, inline: true },
        { name: 'Reason', value: trade.exit_reason, inline: true },
        { name: 'Session', value: trade.session, inline: true },
      ],
      footer: { text: `Trade ID: ${trade.id}` },
      timestamp: new Date(trade.exit_time * 1000).toISOString(),
    }],
  };
}

function computeStats(trades) {
  if (!trades.length) return null;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let peak = 0, cum = 0, maxDd = 0;
  for (const t of trades.slice().sort((a, b) => (a.exit_time || 0) - (b.exit_time || 0))) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }
  return {
    n: trades.length, wins: wins.length, losses: losses.length,
    winRate: wins.length / trades.length * 100,
    totalPnl, avgWin, avgLoss,
    pf: totalLoss === 0 ? Infinity : totalWin / totalLoss,
    avgRR: avgLoss < 0 ? avgWin / Math.abs(avgLoss) : null,
    best: Math.max(...trades.map(t => t.pnl)),
    maxDd,
  };
}

function summaryEmbed(trades, periodLabel, allClosed, cumulativeStartDate) {
  const s = computeStats(trades);
  const cum = computeStats(allClosed);
  const pfStr = !isFinite(s.pf) ? '∞' : s.pf.toFixed(2);
  const fields = [
    { name: 'Trades', value: `${s.n}`, inline: true },
    { name: 'Win rate', value: `${s.winRate.toFixed(1)}%`, inline: true },
    { name: 'Profit factor', value: pfStr, inline: true },
    { name: 'Wins', value: `${s.wins}`, inline: true },
    { name: 'Losses', value: `${s.losses}`, inline: true },
    { name: 'Avg RR', value: s.avgRR ? s.avgRR.toFixed(2) : '—', inline: true },
    { name: 'Avg win', value: `$${s.avgWin.toFixed(2)}`, inline: true },
    { name: 'Avg loss', value: `$${s.avgLoss.toFixed(2)}`, inline: true },
    { name: 'Best trade', value: `$${s.best.toFixed(2)}`, inline: true },
  ];
  if (cum && cum.n > s.n) {
    const cumPfStr = !isFinite(cum.pf) ? '∞' : cum.pf.toFixed(2);
    fields.push({
      name: `📈 Cumulative (since ${cumulativeStartDate || 'start'})`,
      value: `**${cum.totalPnl >= 0 ? '+' : ''}$${cum.totalPnl.toFixed(2)}/oz** · ${cum.n} trades · ${cum.winRate.toFixed(1)}% win · PF ${cumPfStr} · Max DD $${cum.maxDd.toFixed(2)}`,
      inline: false,
    });
  }
  return {
    embeds: [{
      title: tag(`📊 ${periodLabel} summary — ${s.n} trades`),
      description: `**${s.totalPnl >= 0 ? '+' : ''}$${s.totalPnl.toFixed(2)}/oz** = ${s.totalPnl >= 0 ? '+' : ''}$${(s.totalPnl * 100).toFixed(2)} per 100oz lot`,
      color: s.totalPnl >= 0 ? 0x22c55e : 0xef4444,
      fields,
      footer: { text: `Backtest expectancy +$14.53/trade · PF 3.52` },
      timestamp: new Date().toISOString(),
    }],
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAUSE = 1500;

console.log('Sending 8 sample notifications (incl. weekly/monthly with cumulative)...\n');

// 1. LONG entry
console.log('1/6 LONG entry...'); await post(entryEmbed(mockLong)); await sleep(PAUSE);

// 2. SHORT entry
console.log('2/6 SHORT entry...'); await post(entryEmbed(mockShort)); await sleep(PAUSE);

// 3. TP hit (LONG closes at TP)
const tpExit = { ...mockLong, exit_time: mockLong.entry_time + 1500, exit_price: 4744.16, exit_reason: 'TP', pnl: 35.36 };
console.log('3/6 TP exit...'); await post(exitEmbed(tpExit)); await sleep(PAUSE);

// 4. SL hit (SHORT closes at SL)
const slExit = { ...mockShort, exit_time: mockShort.entry_time + 720, exit_price: 4742.10, exit_reason: 'SL', pnl: -17.10 };
console.log('4/6 SL exit...'); await post(exitEmbed(slExit)); await sleep(PAUSE);

// 5. ST flip exit (winning long that exits on indicator reversal)
const flipExit = { ...mockLong, id: 'SAMPLE-LONG-4711-FLIP', entry_price: 4711.20, exit_time: mockLong.entry_time + 2700, exit_price: 4725.50, exit_reason: 'flip', pnl: 14.00 };
console.log('5/6 ST-flip exit...'); await post(exitEmbed(flipExit)); await sleep(PAUSE);

// 6. Daily summary (3 trades: 2 wins, 1 loss)
const dailyTrades = [
  { pnl: 35.36, exit_time: 1778600000 },
  { pnl: -17.10, exit_time: 1778620000 },
  { pnl: 14.00, exit_time: 1778640000 },
];
// Cumulative pool: simulate ~30 trades for a realistic cumulative line
const cumulativePool = [
  ...dailyTrades,
  { pnl: 28.5, exit_time: 1778100000 }, { pnl: -15.2, exit_time: 1778120000 },
  { pnl: 21.7, exit_time: 1778140000 }, { pnl: 18.4, exit_time: 1778160000 },
  { pnl: -12.8, exit_time: 1778180000 }, { pnl: 33.1, exit_time: 1778200000 },
  { pnl: -16.5, exit_time: 1778220000 }, { pnl: 24.9, exit_time: 1778240000 },
  { pnl: 19.3, exit_time: 1778260000 }, { pnl: -11.7, exit_time: 1778280000 },
  { pnl: 27.6, exit_time: 1778300000 }, { pnl: -14.4, exit_time: 1778320000 },
  { pnl: 22.1, exit_time: 1778340000 }, { pnl: 16.8, exit_time: 1778360000 },
  { pnl: -13.5, exit_time: 1778380000 }, { pnl: 29.7, exit_time: 1778400000 },
  { pnl: -10.9, exit_time: 1778420000 }, { pnl: 25.4, exit_time: 1778440000 },
  { pnl: 20.6, exit_time: 1778460000 }, { pnl: -18.2, exit_time: 1778480000 },
  { pnl: 31.8, exit_time: 1778500000 }, { pnl: -15.7, exit_time: 1778520000 },
  { pnl: 23.5, exit_time: 1778540000 }, { pnl: 17.9, exit_time: 1778560000 },
];

const startDate = '2026-04-13';
console.log('6/8 Daily summary...'); await post(summaryEmbed(dailyTrades, 'Daily (sample)', cumulativePool, startDate)); await sleep(PAUSE);

// 7. Weekly summary
const weeklyTrades = cumulativePool.slice(0, 8);
console.log('7/8 Weekly summary...'); await post(summaryEmbed(weeklyTrades, 'Weekly (2026-W20)', cumulativePool, startDate)); await sleep(PAUSE);

// 8. Monthly summary
const monthlyTrades = cumulativePool.slice(0, 22);
console.log('8/8 Monthly summary...'); await post(summaryEmbed(monthlyTrades, 'Monthly (2026-04)', cumulativePool, startDate));

console.log('\n✓ All 8 samples sent. Check your Discord channel.');
