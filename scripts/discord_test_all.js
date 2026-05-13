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

function summaryEmbed(trades, periodLabel) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = totalLoss === 0 ? '∞' : (totalWin / totalLoss).toFixed(2);
  return {
    embeds: [{
      title: tag(`📊 ${periodLabel} summary — ${trades.length} trades`),
      description: `**${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}/oz** = ${totalPnl >= 0 ? '+' : ''}$${(totalPnl * 100).toFixed(2)} per 100oz lot`,
      color: totalPnl >= 0 ? 0x22c55e : 0xef4444,
      fields: [
        { name: 'Trades', value: `${trades.length}`, inline: true },
        { name: 'Win rate', value: `${(wins.length / trades.length * 100).toFixed(1)}%`, inline: true },
        { name: 'Profit factor', value: `${pf}`, inline: true },
        { name: 'Wins', value: `${wins.length}`, inline: true },
        { name: 'Losses', value: `${losses.length}`, inline: true },
        { name: 'Avg RR', value: avgLoss < 0 ? `${(avgWin / Math.abs(avgLoss)).toFixed(2)}` : '—', inline: true },
        { name: 'Avg win', value: `$${avgWin.toFixed(2)}`, inline: true },
        { name: 'Avg loss', value: `$${avgLoss.toFixed(2)}`, inline: true },
        { name: 'Best trade', value: `$${Math.max(...trades.map(t => t.pnl)).toFixed(2)}`, inline: true },
      ],
      footer: { text: `Backtest expectancy +$14.53/trade · PF 3.52` },
      timestamp: new Date().toISOString(),
    }],
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAUSE = 1500;

console.log('Sending 6 sample notifications...\n');

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
  { pnl: 35.36 }, // mock TP win
  { pnl: -17.10 }, // mock SL loss
  { pnl: 14.00 }, // mock flip win
];
console.log('6/6 Daily summary...'); await post(summaryEmbed(dailyTrades, 'Daily (sample)'));

console.log('\n✓ All 6 samples sent. Check your Discord channel.');
