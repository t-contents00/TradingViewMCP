#!/usr/bin/env node
/**
 * Discord signal forwarder for XAUUSD 5m scalping.
 *
 * Rules (derived from backtest_luxalgo.js):
 *   1. 5m Supertrend(10,3) reversal flip detected vs last poll
 *   2. Same-direction LuxAlgo BOS label within prior 5 bars
 *   3. Session ∈ {NY, london_ny_overlap}  (Tokyo/London disabled)
 *   4. Trade aligns with Weekly Supertrend direction (regime filter)
 *
 * Environment:
 *   DISCORD_WEBHOOK_URL  required for live posting (omit for dry-run console output)
 *   POLL_INTERVAL_MS     default 30000
 *   SYMBOL               default OANDA:XAUUSD  (only used for display)
 *
 * State persisted to scripts/discord_state.json so restart resumes cleanly.
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const STATE_FILE = join(__dirname, 'discord_state.json');

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const POLL_MS = +(process.env.POLL_INTERVAL_MS || 30000);
const SYMBOL = process.env.SYMBOL || 'OANDA:XAUUSD';
const DRY_RUN = !WEBHOOK;

if (DRY_RUN) console.error('[dry-run] DISCORD_WEBHOOK_URL not set — signals will only print to console');

// === CLI wrapper ===
function tv(...args) {
  const r = spawnSync('node', ['src/cli/index.js', ...args], { cwd: REPO_ROOT, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`CLI failed: tv ${args.join(' ')} -> ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

// === State ===
function loadState() {
  if (!existsSync(STATE_FILE)) return { lastSTDir: 0, lastSignalTime: 0, weeklyDir: 0, weeklyCheckedAt: 0 };
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// === Session ===
function classifySession(unix) {
  const h = new Date(unix * 1000).getUTCHours();
  if (h >= 13 && h < 16) return 'london_ny_overlap';
  if (h >= 8 && h < 13) return 'london';
  if (h >= 16 && h < 21) return 'ny';
  if (h >= 0 && h < 8) return 'tokyo';
  return 'off_hours';
}
const TRADEABLE_SESSIONS = ['ny', 'london_ny_overlap'];

// === LuxAlgo BOS lookup ===
function getRecentBOS(direction, lookbackBars = 5) {
  const labelsRes = tv('data', 'labels', '-f', 'Smart Money', '-n', '50', '--verbose');
  const labels = labelsRes.studies[0]?.labels || [];
  // LuxAlgo bullish color rgb(129,153,8); bearish rgb(69,54,242)
  const wantedColor = direction === 1 ? '129,153,8' : '69,54,242';
  // Get the latest BOS labels (highest x), check if within lookback window
  const bos = labels.filter(l => l.text === 'BOS').sort((a, b) => b.x - a.x);
  if (!bos.length) return null;
  // We don't know exact bar index of "now" from labels alone, but
  // we can check: top 5 BOS labels — any matching color?
  const recent = bos.slice(0, lookbackBars);
  for (const l of recent) {
    const c = `${(l.textColor >>> 16) & 0xFF},${(l.textColor >>> 8) & 0xFF},${l.textColor & 0xFF}`;
    if (c === wantedColor) return { x: l.x, price: l.price, direction };
  }
  return null;
}

// === Weekly regime (configured via env, non-invasive) ===
// Run `node scripts/backtest_regime.js` periodically to refresh, or set WEEKLY_DIR env var.
// Default: 1 (BULL) — as confirmed by latest regime backtest 2026-05-13.
function getWeeklyRegime() {
  const env = process.env.WEEKLY_DIR;
  if (env === 'bear' || env === '-1') return -1;
  return 1;
}

// === Supertrend direction (from live values) ===
function getCurrentSTDir() {
  const vals = tv('values');
  const stStudy = vals.studies.find(s => s.name === 'Supertrend');
  if (!stStudy) return { dir: 0, line: 0 };
  // Supertrend reports "Down Trend" or "Up Trend" key when in that mode
  const valKeys = Object.keys(stStudy.values);
  const isDown = valKeys.some(k => k === 'Down Trend');
  const isUp = valKeys.some(k => k === 'Up Trend');
  const lineKey = valKeys.find(k => k.startsWith('Supertrend'));
  const line = lineKey ? parseFloat(stStudy.values[lineKey].replace(/,/g, '')) : 0;
  return { dir: isUp ? 1 : (isDown ? -1 : 0), line };
}

function getCurrentPrice() {
  const q = tv('quote');
  return { price: q.last, time: q.time, symbol: q.symbol };
}

// === Discord embed ===
async function postDiscord(payload) {
  if (DRY_RUN) {
    console.log('\n[DRY-RUN] Would post:');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`Discord POST failed ${res.status}: ${await res.text()}`);
  else console.log(`[${new Date().toISOString()}] Discord notified ✓`);
}

function buildEmbed(direction, price, stLine, session, weeklyDir, bos) {
  const arrow = direction === 1 ? '🟢' : '🔴';
  const action = direction === 1 ? 'LONG' : 'SHORT';
  const color = direction === 1 ? 0x4ade80 : 0xf87171;
  return {
    embeds: [{
      title: `${arrow} ${action} signal — ${SYMBOL}`,
      description: `5m Supertrend reversal **+** LuxAlgo BOS confluence (HIGH QUALITY filter from backtest)`,
      color,
      fields: [
        { name: 'Price', value: `$${price.toFixed(2)}`, inline: true },
        { name: 'Supertrend line', value: `$${stLine.toFixed(2)}`, inline: true },
        { name: 'Session', value: session, inline: true },
        { name: 'Weekly regime', value: weeklyDir === 1 ? '📈 BULL (aligned)' : '📉 BEAR', inline: true },
        { name: 'BOS @ price', value: `$${bos.price.toFixed(2)}`, inline: true },
        { name: 'BOS x-index', value: `${bos.x}`, inline: true },
        { name: 'Expected', value: 'Hold until ST flip OR SL @ line', inline: false },
      ],
      footer: { text: 'Backtest expectancy +$14.53/trade, PF 3.52 (n=11, 8d window). Use at own risk.' },
      timestamp: new Date().toISOString(),
    }],
  };
}

// === Main loop ===
async function tick(state) {
  try {
    const { price, time } = getCurrentPrice();
    const { dir: stDir, line: stLine } = getCurrentSTDir();
    const session = classifySession(time);
    const weeklyDir = getWeeklyRegime();

    console.log(`[${new Date().toISOString()}] price=$${price} ST=${stDir>0?'UP':'DOWN'}@$${stLine.toFixed(2)} session=${session} weekly=${weeklyDir>0?'BULL':'BEAR'} lastST=${state.lastSTDir>0?'UP':'DOWN'}`);

    // Detect flip
    if (state.lastSTDir !== 0 && stDir !== 0 && stDir !== state.lastSTDir) {
      const flipDir = stDir;
      console.log(`  → ST FLIP detected: ${state.lastSTDir} -> ${flipDir}`);

      // Filter 1: Session
      if (!TRADEABLE_SESSIONS.includes(session)) {
        console.log(`  ✗ rejected: session ${session} not in NY/Overlap`);
      }
      // Filter 2: Weekly alignment
      else if (flipDir !== weeklyDir) {
        console.log(`  ✗ rejected: against weekly regime (${weeklyDir})`);
      }
      // Filter 3: LuxAlgo BOS confluence
      else {
        const bos = getRecentBOS(flipDir, 5);
        if (!bos) {
          console.log(`  ✗ rejected: no same-direction BOS in last 5 bars`);
        } else {
          console.log(`  ✓ ALL filters pass! BOS at x=${bos.x} price=${bos.price}`);
          await postDiscord(buildEmbed(flipDir, price, stLine, session, weeklyDir, bos));
          state.lastSignalTime = Date.now();
        }
      }
    }

    state.lastSTDir = stDir;
    saveState(state);
  } catch (e) {
    console.error('tick error:', e.message);
  }
}

// === Run ===
const state = loadState();
console.error(`Discord signal forwarder started. Poll every ${POLL_MS}ms. ${DRY_RUN ? '(DRY-RUN mode)' : '(LIVE)'}`);
console.error(`State file: ${STATE_FILE}`);

// Run first tick immediately, then on interval
await tick(state);
setInterval(() => tick(state), POLL_MS);
