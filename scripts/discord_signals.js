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
  if (!existsSync(STATE_FILE)) return { lastSTDir: 0, openTradeId: null, lastSummaryDay: '', lastSummaryWeek: '', lastSummaryMonth: '', cumulativeStartDate: '', lastHeartbeat: 0 };
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

function sessionLabel(s) {
  return { tokyo: '東京', london: 'ロンドン', london_ny_overlap: 'ロンドン/NY重複', ny: 'NY', off_hours: '時間外' }[s] || s;
}

function entryEmbed(trade) {
  const arrow = trade.direction === 1 ? '🟢' : '🔴';
  const action = trade.direction === 1 ? '買い' : '売り';
  const color = trade.direction === 1 ? 0x4ade80 : 0xf87171;
  const slDist = Math.abs(trade.sl - trade.entry_price).toFixed(2);
  const fields = [
    { name: '📍 エントリー価格', value: `**$${trade.entry_price.toFixed(2)}**`, inline: true },
    { name: '🛑 損切り', value: `$${trade.sl.toFixed(2)}\n(値幅 $${slDist})`, inline: true },
    { name: '⏰ セッション', value: sessionLabel(trade.session), inline: true },
  ];
  if (trade.tp) {
    const tpDist = Math.abs(trade.tp - trade.entry_price).toFixed(2);
    fields.push({ name: '🎯 利確目標', value: `$${trade.tp.toFixed(2)}\n(値幅 $${tpDist})`, inline: true });
  }
  fields.push({ name: '✅ 上昇構造ブレイク', value: `$${trade.bos_price.toFixed(2)}\nLuxAlgo が確認済み`, inline: true });
  fields.push({ name: '📊 大局トレンド', value: trade.weekly_dir === 1 ? '週足: 上昇 ✅\n方向一致' : '週足: 下降 ✅\n方向一致', inline: true });
  fields.push({
    name: '🎯 次にやること',
    value: `1. TradingView で **${SYMBOL}** チャートを確認\n2. **$${trade.entry_price.toFixed(2)}** 付近で${action}注文\n3. 損切り **$${trade.sl.toFixed(2)}** をセット${trade.tp ? `\n4. 利確 **$${trade.tp.toFixed(2)}** をセット` : '\n4. トレンド反転まで保有 (反対方向の通知が来るまで)'}`,
    inline: false
  });
  return {
    embeds: [{
      title: `${arrow} ${action}シグナル発生 — ${SYMBOL}`,
      description: `**5分足でトレンドが反転し、上昇継続サインも確認できました。**\n過去成績: 勝率45.5% / 利益額/損失額=3.52倍 (過去8日, n=11)`,
      color, fields,
      footer: { text: `Trade ID: ${trade.id}` },
      timestamp: new Date(trade.entry_time * 1000).toISOString(),
    }],
  };
}

function exitEmbed(trade) {
  const reasonMap = {
    TP: { emoji: '🎯', label: '利確到達', detail: '目標価格に到達したので利益確定' },
    SL: { emoji: '⛔', label: '損切り', detail: '損切りラインに当たったので撤退' },
    flip: { emoji: '🔄', label: 'トレンド反転', detail: 'Supertrend が反対方向に変わったので決済' },
  };
  const r = reasonMap[trade.exit_reason] || { emoji: '🚪', label: trade.exit_reason, detail: '' };
  const pnlEmoji = trade.pnl > 0 ? '💰' : '📉';
  const color = trade.pnl > 0 ? 0x22c55e : 0xef4444;
  const duration = ((trade.exit_time - trade.entry_time) / 60).toFixed(0);
  const moveValue = trade.direction === 1 ? trade.exit_price - trade.entry_price : trade.entry_price - trade.exit_price;
  const sign = trade.pnl > 0 ? '+' : '';
  return {
    embeds: [{
      title: `${r.emoji} 決済通知 — ${trade.direction === 1 ? '買い' : '売り'}ポジション (${r.label})`,
      description: `${pnlEmoji} **${sign}$${trade.pnl.toFixed(2)}** (1oz換算) = **${sign}$${(trade.pnl * 100).toFixed(2)}** (100oz=1ロット換算)\n${r.detail}`,
      color,
      fields: [
        { name: '📍 エントリー価格', value: `$${trade.entry_price.toFixed(2)}`, inline: true },
        { name: '🚪 決済価格', value: `$${trade.exit_price.toFixed(2)}`, inline: true },
        { name: '⏱ 保有時間', value: `${duration} 分`, inline: true },
        { name: '📏 値幅', value: `${moveValue.toFixed(2)}`, inline: true },
        { name: '🏁 決済理由', value: r.label, inline: true },
        { name: '⏰ セッション', value: sessionLabel(trade.session), inline: true },
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
  const pf = totalLoss === 0 ? Infinity : totalWin / totalLoss;
  // Max drawdown (running cumulative)
  let peak = 0, cum = 0, maxDd = 0;
  for (const t of trades.slice().sort((a, b) => a.exit_time - b.exit_time)) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }
  return {
    n: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / trades.length * 100,
    totalPnl,
    avgWin, avgLoss,
    pf,
    avgRR: avgLoss < 0 ? avgWin / Math.abs(avgLoss) : null,
    best: Math.max(...trades.map(t => t.pnl)),
    worst: Math.min(...trades.map(t => t.pnl)),
    maxDd,
  };
}

function summaryEmbed(trades, periodLabel, allClosed, cumulativeStartDate) {
  if (!trades.length) {
    return {
      embeds: [{
        title: `📊 ${periodLabel} — トレード無し`,
        description: '対象期間中にシグナル発火なし。市場待ちの状態でした。',
        color: 0x6b7280,
        timestamp: new Date().toISOString(),
      }],
    };
  }
  const s = computeStats(trades);
  const cum = computeStats(allClosed);
  const pfStr = !isFinite(s.pf) ? '∞' : s.pf.toFixed(2);
  const sign = s.totalPnl >= 0 ? '+' : '';
  const verdict = s.totalPnl >= 0 ? '🟢 利益' : '🔴 損失';
  const fields = [
    { name: '🎯 トレード数', value: `${s.n} 回`, inline: true },
    { name: '🏆 勝率', value: `${s.winRate.toFixed(1)}% (${s.wins}勝 ${s.losses}敗)`, inline: true },
    { name: '⚖️ 利益÷損失', value: `${pfStr} 倍`, inline: true },
    { name: '📈 平均勝ち', value: `$${s.avgWin.toFixed(2)}`, inline: true },
    { name: '📉 平均負け', value: `$${s.avgLoss.toFixed(2)}`, inline: true },
    { name: '⭐ 最大勝ち', value: `$${s.best.toFixed(2)}`, inline: true },
  ];
  if (cum && cum.n > s.n) {
    const cumPfStr = !isFinite(cum.pf) ? '∞' : cum.pf.toFixed(2);
    const cumSign = cum.totalPnl >= 0 ? '+' : '';
    fields.push({
      name: `📊 累計 (${cumulativeStartDate || '開始日'}〜)`,
      value: `**${cumSign}$${cum.totalPnl.toFixed(2)}** (1oz) / **${cumSign}$${(cum.totalPnl*100).toFixed(2)}** (100oz)\n総トレード ${cum.n}回 · 勝率 ${cum.winRate.toFixed(1)}% · 利益損失比 ${cumPfStr}\n最大ドローダウン $${cum.maxDd.toFixed(2)} (最大の損失累積)`,
      inline: false,
    });
  }
  return {
    embeds: [{
      title: `📊 ${periodLabel} 集計 — ${s.n}トレード ${verdict}`,
      description: `**${sign}$${s.totalPnl.toFixed(2)}** (1oz換算) / **${sign}$${(s.totalPnl * 100).toFixed(2)}** (100oz=1ロット換算)`,
      color: s.totalPnl >= 0 ? 0x22c55e : 0xef4444,
      fields,
      footer: { text: `バックテスト期待値 +$14.53/trade · 利益損失比 3.52倍` },
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

// === Time helpers ===
function isoYearWeek(date) {
  // ISO week: Mon=1..Sun=7, week 1 = first week with Thursday
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// === Summaries ===
async function maybePostSummaries(state) {
  const nowUtc = new Date();
  if (nowUtc.getUTCHours() !== SUMMARY_HOUR_UTC) return;

  const trades = loadTrades();
  const allClosed = trades.filter(t => t.status === 'closed');
  if (!state.cumulativeStartDate && allClosed.length) {
    state.cumulativeStartDate = new Date(allClosed[0].entry_time * 1000).toISOString().slice(0, 10);
  }

  // Daily
  const todayKey = nowUtc.toISOString().slice(0, 10);
  if (state.lastSummaryDay !== todayKey) {
    const cutoff = Date.now() / 1000 - 24 * 3600;
    const recent = allClosed.filter(t => t.exit_time >= cutoff);
    await postDiscord(summaryEmbed(recent, 'Daily (last 24h)', allClosed, state.cumulativeStartDate));
    state.lastSummaryDay = todayKey;
    saveState(state);
  }

  // Weekly — fire on Saturday (after Fri NY close)
  if (nowUtc.getUTCDay() === 6) {
    const weekKey = isoYearWeek(nowUtc);
    if (state.lastSummaryWeek !== weekKey) {
      const cutoff = Date.now() / 1000 - 7 * 24 * 3600;
      const recent = allClosed.filter(t => t.exit_time >= cutoff);
      await postDiscord(summaryEmbed(recent, `Weekly (${weekKey})`, allClosed, state.cumulativeStartDate));
      state.lastSummaryWeek = weekKey;
      saveState(state);
    }
  }

  // Monthly — fire on day 1 of month
  if (nowUtc.getUTCDate() === 1) {
    const monthKey = nowUtc.toISOString().slice(0, 7); // YYYY-MM
    if (state.lastSummaryMonth !== monthKey) {
      // Previous month: anything closed between current month start - 31d and current month start
      const monthStart = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), 1) / 1000;
      const prevMonthStart = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() - 1, 1) / 1000;
      const recent = allClosed.filter(t => t.exit_time >= prevMonthStart && t.exit_time < monthStart);
      const prevMonthLabel = new Date(prevMonthStart * 1000).toISOString().slice(0, 7);
      await postDiscord(summaryEmbed(recent, `Monthly (${prevMonthLabel})`, allClosed, state.cumulativeStartDate));
      state.lastSummaryMonth = monthKey;
      saveState(state);
    }
  }
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

    await maybePostSummaries(state);
    await maybePostHeartbeat(state, { price, stDir, stLine, session });
  } catch (e) {
    console.error('tick error:', e.message);
  }
}

// === Heartbeat (every HEARTBEAT_HOURS, default 6h) ===
const HEARTBEAT_HOURS = +(process.env.HEARTBEAT_HOURS || 6);
async function maybePostHeartbeat(state, ctx) {
  const now = Date.now();
  if (state.lastHeartbeat && (now - state.lastHeartbeat) < HEARTBEAT_HOURS * 3600 * 1000) return;
  const trades = loadTrades();
  const open = trades.find(t => t.status === 'open');
  const closed = trades.filter(t => t.status === 'closed');
  const todayStart = Math.floor(now / 1000) - 24 * 3600;
  const today = closed.filter(t => t.exit_time >= todayStart);
  const todayPnl = today.reduce((s, t) => s + t.pnl, 0);
  await postDiscord({
    embeds: [{
      title: '💚 フォワーダー稼働中',
      description: `${HEARTBEAT_HOURS}時間毎の生存確認です。VPSが正常に動いてます。`,
      color: 0x60a5fa,
      fields: [
        { name: '💰 現在価格', value: `$${ctx.price.toFixed(2)} (${SYMBOL})`, inline: true },
        { name: '📊 Supertrend', value: `${ctx.stDir > 0 ? '上昇 ↑' : '下降 ↓'} @ $${ctx.stLine.toFixed(2)}`, inline: true },
        { name: '⏰ セッション', value: sessionLabel(ctx.session), inline: true },
        { name: '🎯 保有ポジション', value: open ? `${open.direction === 1 ? '🟢 買い' : '🔴 売り'} @ $${open.entry_price.toFixed(2)}` : 'なし', inline: true },
        { name: '📅 今日の損益', value: `${today.length}トレード ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)}`, inline: true },
        { name: '📈 累計', value: `${closed.length}トレード`, inline: true },
      ],
      footer: { text: 'シグナル無し時は静かです。これは正常です。' },
      timestamp: new Date().toISOString(),
    }],
  });
  state.lastHeartbeat = now;
  saveState(state);
}

const state = loadState();
console.error(`Discord signal forwarder v2 (lifecycle). Poll ${POLL_MS}ms. TP=${ENABLE_TP ? 'RR ' + RR_TARGET : 'OFF (ST-flip exit only)'}. ${DRY_RUN ? '[DRY-RUN]' : '[LIVE]'}`);
await tick(state);
setInterval(() => tick(state), POLL_MS);
