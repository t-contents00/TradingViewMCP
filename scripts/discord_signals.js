#!/usr/bin/env node
/**
 * Discord signal forwarder — full lifecycle tracker.
 *
 * Entry rule (must all hold):
 *   1. 5m Supertrend(10,3) reversal flip vs last poll
 *   2. Same-direction LuxAlgo BOS label within prior 5 bars
 *   3. Session ∈ {ny, london_ny_overlap}
 *   4. Direction aligns with WEEKLY_DIR (set via env, default bull)
 *
 * Exit rules (any triggers close):
 *   - SL hit: current price crosses Supertrend line at entry
 *   - TP hit (optional): RR_TARGET × stop distance — set ENABLE_TP=1 to use
 *   - Supertrend flips against position
 *
 * Notifications:
 *   - Entry  (🟢/🔴 embed)
 *   - Exit   (✅ TP / ⛔ SL / 🔄 ST flip)
 *   - Daily summary at SUMMARY_HOUR_UTC (default 22 UTC = 07:00 JST, after NY close)
 *
 * Env:
 *   DISCORD_WEBHOOK_URL    required for live (omit for dry-run)
 *   POLL_INTERVAL_MS       default 30000
 *   WEEKLY_DIR             "bull" | "bear" | 1 | -1   default bull
 *   ENABLE_TP              "1" to enable hard TP at RR 1:2; default off (ST-flip exit only)
 *   RR_TARGET              numeric, default 2.0
 *   SYMBOL                 display label, default OANDA:XAUUSD
 *   SUMMARY_HOUR_UTC       0-23, default 22 (07:00 JST)
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const STATE_FILE = join(__dirname, 'discord_state.json');
const TRADES_FILE = join(__dirname, 'trades.json');

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const POLL_MS = +(process.env.POLL_INTERVAL_MS || 30000);
const SYMBOL = process.env.SYMBOL || 'OANDA:XAUUSD';
const TARGET_PANE = +(process.env.TARGET_PANE || 0);
const ENABLE_TP = process.env.ENABLE_TP === '1';
const RR_TARGET = +(process.env.RR_TARGET || 2.0);
const SUMMARY_HOUR_UTC = +(process.env.SUMMARY_HOUR_UTC || 22);
const DRY_RUN = !WEBHOOK;

if (DRY_RUN) console.error('[dry-run] DISCORD_WEBHOOK_URL not set — embeds will print to console only');

// === CLI wrapper ===
function tv(...args) {
  const r = spawnSync('node', ['src/cli/index.js', ...args], { cwd: REPO_ROOT, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`CLI failed: tv ${args.join(' ')} -> ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

// === State + trades persistence ===
function loadState() {
  if (!existsSync(STATE_FILE)) return { lastSTDir: 0, openTradeId: null, lastSummaryDay: '' };
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function loadTrades() {
  if (!existsSync(TRADES_FILE)) return [];
  return JSON.parse(readFileSync(TRADES_FILE, 'utf-8'));
}
function saveTrades(t) { writeFileSync(TRADES_FILE, JSON.stringify(t, null, 2)); }

// === Strategy filters ===
function classifySession(unix) {
  const h = new Date(unix * 1000).getUTCHours();
  if (h >= 13 && h < 16) return 'london_ny_overlap';
  if (h >= 8 && h < 13) return 'london';
  if (h >= 16 && h < 21) return 'ny';
  if (h >= 0 && h < 8) return 'tokyo';
  return 'off_hours';
}
const TRADEABLE_SESSIONS = ['ny', 'london_ny_overlap'];

function getWeeklyRegime() {
  const env = process.env.WEEKLY_DIR;
  if (env === 'bear' || env === '-1') return -1;
  return 1;
}

function getRecentBOS(direction, lookbackBars = 5) {
  const labelsRes = tv('data', 'labels', '-f', 'Smart Money', '-n', '50', '--verbose');
  const labels = labelsRes.studies[0]?.labels || [];
  const wantedColor = direction === 1 ? '129,153,8' : '69,54,242';
  const bos = labels.filter(l => l.text === 'BOS').sort((a, b) => b.x - a.x).slice(0, lookbackBars);
  for (const l of bos) {
    const c = `${(l.textColor >>> 16) & 0xFF},${(l.textColor >>> 8) & 0xFF},${l.textColor & 0xFF}`;
    if (c === wantedColor) return { x: l.x, price: l.price, direction };
  }
  return null;
}

function getCurrentSTDir() {
  const vals = tv('values');
  const stStudy = vals.studies.find(s => s.name === 'Supertrend');
  if (!stStudy) return { dir: 0, line: 0 };
  const valKeys = Object.keys(stStudy.values);
  const isDown = valKeys.some(k => k === 'Down Trend');
  const isUp = valKeys.some(k => k === 'Up Trend');
  const lineKey = valKeys.find(k => k.startsWith('Supertrend'));
  const line = lineKey ? parseFloat(stStudy.values[lineKey].replace(/,/g, '')) : 0;
  return { dir: isUp ? 1 : (isDown ? -1 : 0), line };
}

function getCurrentPrice() {
  const q = tv('quote');
  return { price: q.last, time: q.time };
}

// === Discord ===
async function postDiscord(payload) {
  if (DRY_RUN) {
    console.log('\n[DRY-RUN]', JSON.stringify(payload.embeds[0].title));
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`Discord POST failed ${res.status}: ${await res.text()}`);
  else console.log(`[${new Date().toISOString()}] Discord notified ✓`);
}

function entryEmbed(trade) {
  const arrow = trade.direction === 1 ? '🟢' : '🔴';
  const action = trade.direction === 1 ? 'LONG' : 'SHORT';
  const color = trade.direction === 1 ? 0x4ade80 : 0xf87171;
  const fields = [
    { name: 'Entry', value: `$${trade.entry_price.toFixed(2)}`, inline: true },
    { name: 'SL', value: `$${trade.sl.toFixed(2)} (${(trade.sl - trade.entry_price).toFixed(2)})`, inline: true },
    { name: 'Session', value: trade.session, inline: true },
  ];
  if (trade.tp) fields.push({ name: 'TP', value: `$${trade.tp.toFixed(2)} (RR ${RR_TARGET})`, inline: true });
  fields.push({ name: 'BOS confluence', value: `$${trade.bos_price.toFixed(2)}`, inline: true });
  fields.push({ name: 'Weekly regime', value: trade.weekly_dir === 1 ? '📈 BULL (aligned)' : '📉 BEAR', inline: true });
  return {
    embeds: [{
      title: `${arrow} ${action} ENTRY — ${SYMBOL}`,
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
      title: `${reasonEmoji} EXIT (${trade.exit_reason}) — ${trade.direction === 1 ? 'LONG' : 'SHORT'} ${SYMBOL}`,
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
  if (!trades.length) {
    return {
      embeds: [{
        title: `📊 ${periodLabel} summary — no trades`,
        description: 'No signals fired in this period.',
        color: 0x6b7280,
        timestamp: new Date().toISOString(),
      }],
    };
  }
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = totalLoss === 0 ? '∞' : (totalWin / totalLoss).toFixed(2);
  const winRate = (wins.length / trades.length * 100).toFixed(1);
  return {
    embeds: [{
      title: `📊 ${periodLabel} summary — ${trades.length} trades`,
      description: `**${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}/oz** = ${totalPnl >= 0 ? '+' : ''}$${(totalPnl * 100).toFixed(2)} per 100oz lot`,
      color: totalPnl >= 0 ? 0x22c55e : 0xef4444,
      fields: [
        { name: 'Trades', value: `${trades.length}`, inline: true },
        { name: 'Win rate', value: `${winRate}%`, inline: true },
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

// === Lifecycle ===
function makeTradeId(time, direction, entry) {
  const dt = new Date(time * 1000).toISOString().slice(0, 16).replace(/[:T-]/g, '');
  return `${dt}-${direction === 1 ? 'L' : 'S'}-${entry.toFixed(2)}`;
}

async function openPosition({ price, stLine, stDir, time, session, weeklyDir, bos }) {
  const trades = loadTrades();
  const direction = stDir;
  const stopDist = Math.abs(price - stLine);
  const tp = ENABLE_TP ? (direction === 1 ? price + stopDist * RR_TARGET : price - stopDist * RR_TARGET) : null;
  const trade = {
    id: makeTradeId(time, direction, price),
    entry_time: time,
    entry_price: price,
    direction, sl: stLine, tp,
    session, weekly_dir: weeklyDir,
    bos_price: bos.price,
    status: 'open',
    exit_time: null, exit_price: null, exit_reason: null, pnl: null,
  };
  trades.push(trade);
  saveTrades(trades);
  console.log(`  ✓ Opened position ${trade.id}`);
  await postDiscord(entryEmbed(trade));
  return trade;
}

async function closePosition(trade, { price, time, reason }) {
  trade.status = 'closed';
  trade.exit_time = time;
  trade.exit_price = price;
  trade.exit_reason = reason;
  trade.pnl = (trade.direction === 1 ? price - trade.entry_price : trade.entry_price - price) - 0.3; // spread
  const trades = loadTrades();
  const idx = trades.findIndex(t => t.id === trade.id);
  if (idx >= 0) trades[idx] = trade;
  saveTrades(trades);
  console.log(`  ✓ Closed ${trade.id} via ${reason}, PnL=$${trade.pnl.toFixed(2)}`);
  await postDiscord(exitEmbed(trade));
}

function checkExitConditions(trade, { price, stDir }) {
  // SL: price crossed entry-time ST line
  if (trade.direction === 1 && price <= trade.sl) return 'SL';
  if (trade.direction === -1 && price >= trade.sl) return 'SL';
  // TP (optional): price reached fixed RR target
  if (trade.tp !== null) {
    if (trade.direction === 1 && price >= trade.tp) return 'TP';
    if (trade.direction === -1 && price <= trade.tp) return 'TP';
  }
  // ST flip: indicator reversed
  if (stDir !== 0 && stDir !== trade.direction) return 'flip';
  return null;
}

// === Daily summary ===
async function maybePostDailySummary(state) {
  const nowUtc = new Date();
  const todayKey = nowUtc.toISOString().slice(0, 10);
  if (state.lastSummaryDay === todayKey) return;
  if (nowUtc.getUTCHours() !== SUMMARY_HOUR_UTC) return;
  // Aggregate trades closed in the last 24h
  const trades = loadTrades();
  const cutoff = Date.now() / 1000 - 24 * 3600;
  const recent = trades.filter(t => t.status === 'closed' && t.exit_time >= cutoff);
  await postDiscord(summaryEmbed(recent, 'Daily (last 24h)'));
  state.lastSummaryDay = todayKey;
  saveState(state);
}

function ensureTargetPane() {
  const list = tv('pane', 'list');
  if (list.active_index !== TARGET_PANE) tv('pane', 'focus', String(TARGET_PANE));
  const pane = list.panes?.[TARGET_PANE];
  if (!pane) throw new Error(`Pane ${TARGET_PANE} not found`);
  if (pane.symbol !== SYMBOL) {
    console.error(`WARNING: pane ${TARGET_PANE} has symbol ${pane.symbol}, expected ${SYMBOL}`);
  }
  if (pane.resolution !== '5') {
    console.error(`WARNING: pane ${TARGET_PANE} resolution=${pane.resolution}, expected 5`);
  }
}

// === Main loop ===
async function tick(state) {
  try {
    ensureTargetPane();
    const { price, time } = getCurrentPrice();
    const { dir: stDir, line: stLine } = getCurrentSTDir();
    const session = classifySession(time);
    const weeklyDir = getWeeklyRegime();

    // If a position is open, check exit conditions every poll
    if (state.openTradeId) {
      const trades = loadTrades();
      const trade = trades.find(t => t.id === state.openTradeId);
      if (trade && trade.status === 'open') {
        const reason = checkExitConditions(trade, { price, stDir });
        console.log(`[${new Date().toISOString()}] OPEN ${trade.id} price=$${price} stDir=${stDir} ${reason ? '-> EXIT '+reason : '(holding)'}`);
        if (reason) {
          await closePosition(trade, { price, time, reason });
          state.openTradeId = null;
          saveState(state);
        }
      } else {
        // stale state
        state.openTradeId = null;
        saveState(state);
      }
    } else {
      // Flat — check for entry signal on ST flip
      console.log(`[${new Date().toISOString()}] FLAT price=$${price} ST=${stDir>0?'UP':'DOWN'}@$${stLine.toFixed(2)} session=${session} lastST=${state.lastSTDir}`);
      if (state.lastSTDir !== 0 && stDir !== 0 && stDir !== state.lastSTDir) {
        const flipDir = stDir;
        console.log(`  → ST FLIP ${state.lastSTDir} -> ${flipDir}`);
        if (!TRADEABLE_SESSIONS.includes(session)) console.log(`  ✗ session ${session} excluded`);
        else if (flipDir !== weeklyDir) console.log(`  ✗ against weekly (${weeklyDir})`);
        else {
          const bos = getRecentBOS(flipDir, 5);
          if (!bos) console.log('  ✗ no BOS confluence');
          else {
            const trade = await openPosition({ price, stLine, stDir: flipDir, time, session, weeklyDir, bos });
            state.openTradeId = trade.id;
            saveState(state);
          }
        }
      }
    }

    state.lastSTDir = stDir;
    saveState(state);

    await maybePostDailySummary(state);
  } catch (e) {
    console.error('tick error:', e.message);
  }
}

const state = loadState();
console.error(`Discord signal forwarder v2 (lifecycle). Poll ${POLL_MS}ms. TP=${ENABLE_TP ? 'RR ' + RR_TARGET : 'OFF (ST-flip exit only)'}. ${DRY_RUN ? '[DRY-RUN]' : '[LIVE]'}`);
await tick(state);
setInterval(() => tick(state), POLL_MS);
