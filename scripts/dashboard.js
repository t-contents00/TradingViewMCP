#!/usr/bin/env node
/**
 * Local status dashboard for the Discord signal forwarder.
 * Listens on http://localhost:8080 (or DASHBOARD_PORT env).
 *
 * Shows live forwarder status, current price/ST/session, open position,
 * today's trades, and recent log tail. Auto-refreshes every 10s.
 *
 * Run: node scripts/dashboard.js
 */

import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'discord_state.json');
const TRADES_FILE = join(__dirname, 'trades.json');
const PID_FILE = join(__dirname, 'forwarder.pid');
const LOG_FILE = join(__dirname, 'forwarder.log');
const PORT = +(process.env.DASHBOARD_PORT || 8080);

function safeJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fallback; }
}

function tailLog(n = 30) {
  if (!existsSync(LOG_FILE)) return [];
  const data = readFileSync(LOG_FILE, 'utf-8');
  return data.split('\n').filter(l => l.trim()).slice(-n);
}

function readPidFile(p) {
  // Handle PowerShell Out-File default (UTF-16 LE with BOM) which trips parseInt
  const buf = readFileSync(p);
  let text;
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    text = buf.slice(2).toString('utf16le');
  } else if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    text = buf.slice(3).toString('utf-8');
  } else {
    text = buf.toString('utf-8');
  }
  return parseInt(text.trim(), 10);
}

function pidAlive() {
  if (!existsSync(PID_FILE)) return { running: false, pid: null };
  const pid = readPidFile(PID_FILE);
  if (!pid) return { running: false, pid: null };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid };
  }
}

function parseRecentLog() {
  const lines = tailLog(5);
  for (const line of lines.reverse()) {
    const m = line.match(/\[(.+?)\].*price=\$([0-9.]+).*?ST=(UP|DOWN)@\$([0-9.]+).*?session=(\w+)/);
    if (m) return { time: m[1], price: parseFloat(m[2]), st_dir: m[3], st_line: parseFloat(m[4]), session: m[5] };
  }
  return null;
}

const HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>TradingView Forwarder Dashboard</title>
<meta http-equiv="refresh" content="10">
<style>
  body { font-family: -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", sans-serif; background: #0a0e1a; color: #e2e8f0; margin: 0; padding: 20px; }
  h1 { font-size: 22px; margin: 0 0 16px; color: #60a5fa; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .card { background: #1e293b; border-radius: 8px; padding: 16px; border-left: 4px solid #3b82f6; }
  .card.ok { border-color: #22c55e; }
  .card.warn { border-color: #f59e0b; }
  .card.err { border-color: #ef4444; }
  .card h2 { margin: 0 0 10px; font-size: 14px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
  .big { font-size: 28px; font-weight: 700; }
  .green { color: #22c55e; }
  .red { color: #ef4444; }
  .gray { color: #94a3b8; }
  .sub { font-size: 13px; color: #94a3b8; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #334155; }
  th { color: #94a3b8; font-weight: 500; }
  .log { background: #020617; padding: 12px; border-radius: 4px; font-family: monospace; font-size: 11px; max-height: 240px; overflow-y: auto; }
  .log div { padding: 1px 0; color: #cbd5e1; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge.ok { background: #14532d; color: #86efac; }
  .badge.err { background: #7f1d1d; color: #fca5a5; }
  .badge.warn { background: #78350f; color: #fcd34d; }
  .refreshed { position: fixed; top: 8px; right: 12px; font-size: 11px; color: #64748b; }
</style>
</head>
<body>
<div class="refreshed">10秒毎に自動更新 · {{REFRESH_TIME}}</div>
<h1>📡 TradingView Forwarder Dashboard</h1>
<div class="grid">
  <div class="card {{STATUS_CLASS}}">
    <h2>🚦 フォワーダー稼働状況</h2>
    <div class="big">{{STATUS_TEXT}}</div>
    <div class="sub">PID: {{PID}} · 最終ポーリング: {{LAST_POLL}}</div>
  </div>

  <div class="card">
    <h2>💰 現在価格 (OANDA:XAUUSD 5m)</h2>
    <div class="big">\${{PRICE}}</div>
    <div class="sub">Supertrend: <span class="{{ST_CLASS}}">{{ST_DIR}}</span> @ \${{ST_LINE}}</div>
  </div>

  <div class="card">
    <h2>⏰ セッション</h2>
    <div class="big">{{SESSION_JP}}</div>
    <div class="sub">{{SESSION_NOTE}}</div>
  </div>

  <div class="card {{POSITION_CLASS}}">
    <h2>📊 保有ポジション</h2>
    {{POSITION_HTML}}
  </div>

  <div class="card">
    <h2>📈 累計戦績</h2>
    {{CUM_HTML}}
  </div>

  <div class="card">
    <h2>📅 今日のトレード</h2>
    {{TODAY_HTML}}
  </div>
</div>

<div class="card" style="margin-top: 16px;">
  <h2>📜 最新ログ (30行)</h2>
  <div class="log">{{LOG_HTML}}</div>
</div>

</body>
</html>`;

function sessionJP(s) {
  return ({ tokyo: '東京 (09:00-18:00 JST)', london: 'ロンドン (17:00-22:00 JST)', london_ny_overlap: 'ロンドン/NY重複 (22:30-01:00 JST) 🔥', ny: 'NY (22:00-07:00 JST)', off_hours: '時間外' })[s] || s;
}
function sessionNote(s) {
  if (s === 'ny' || s === 'london_ny_overlap') return '✅ 取引対象セッション';
  return '⏸ シグナル待機中 (戦略フィルタで除外)';
}

function render() {
  const status = pidAlive();
  const state = safeJson(STATE_FILE, {});
  const trades = safeJson(TRADES_FILE, []);
  const recent = parseRecentLog();
  const now = new Date();

  const statusClass = status.running ? 'ok' : 'err';
  const statusText = status.running ? '🟢 稼働中' : '🔴 停止中';
  const lastPoll = recent ? new Date(recent.time).toLocaleString('ja-JP') : '-';

  const price = recent ? recent.price.toFixed(2) : '-';
  const stDir = recent ? (recent.st_dir === 'UP' ? '上昇 ↑' : '下降 ↓') : '-';
  const stClass = recent && recent.st_dir === 'UP' ? 'green' : 'red';
  const stLine = recent ? recent.st_line.toFixed(2) : '-';
  const session = recent ? recent.session : '-';

  // Open position
  let positionHtml, positionClass = '';
  const openPosition = trades.find(t => t.status === 'open');
  if (openPosition) {
    const livePnl = recent ? (openPosition.direction === 1 ? recent.price - openPosition.entry_price : openPosition.entry_price - recent.price) - 0.3 : 0;
    const livePnlClass = livePnl > 0 ? 'green' : 'red';
    positionClass = livePnl > 0 ? 'ok' : 'warn';
    positionHtml = `
      <div class="big ${livePnlClass}">${livePnl >= 0 ? '+' : ''}$${livePnl.toFixed(2)}</div>
      <div class="sub">${openPosition.direction === 1 ? '🟢 買い' : '🔴 売り'} @ $${openPosition.entry_price.toFixed(2)}</div>
      <div class="sub">損切 $${openPosition.sl.toFixed(2)} ${openPosition.tp ? `· 利確 $${openPosition.tp.toFixed(2)}` : ''}</div>`;
  } else {
    positionHtml = '<div class="big gray">なし</div><div class="sub">シグナル待機中</div>';
  }

  // Cumulative stats
  const closed = trades.filter(t => t.status === 'closed');
  let cumHtml;
  if (closed.length) {
    const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
    const wins = closed.filter(t => t.pnl > 0).length;
    const winRate = (wins / closed.length * 100).toFixed(1);
    const cls = totalPnl >= 0 ? 'green' : 'red';
    cumHtml = `
      <div class="big ${cls}">${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</div>
      <div class="sub">${closed.length} トレード · 勝率 ${winRate}%</div>
      <div class="sub">100oz=1ロット換算: ${totalPnl >= 0 ? '+' : ''}$${(totalPnl * 100).toFixed(2)}</div>`;
  } else {
    cumHtml = '<div class="big gray">$0.00</div><div class="sub">取引履歴なし</div>';
  }

  // Today's trades
  const todayStart = Math.floor(now.getTime() / 1000) - 24 * 3600;
  const todayTrades = closed.filter(t => t.exit_time >= todayStart);
  let todayHtml;
  if (todayTrades.length) {
    const todayPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);
    todayHtml = `<table><tr><th>時刻</th><th>方向</th><th>P/L</th></tr>${todayTrades.map(t => `<tr><td>${new Date(t.exit_time * 1000).toLocaleTimeString('ja-JP')}</td><td>${t.direction === 1 ? '🟢買' : '🔴売'}</td><td class="${t.pnl > 0 ? 'green' : 'red'}">${t.pnl > 0 ? '+' : ''}$${t.pnl.toFixed(2)}</td></tr>`).join('')}<tr><td colspan="2"><b>計</b></td><td class="${todayPnl > 0 ? 'green' : 'red'}"><b>${todayPnl > 0 ? '+' : ''}$${todayPnl.toFixed(2)}</b></td></tr></table>`;
  } else {
    todayHtml = '<div class="big gray">0</div><div class="sub">今日のトレードなし</div>';
  }

  // Log tail
  const logLines = tailLog(30);
  const logHtml = logLines.length
    ? logLines.map(l => `<div>${l.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</div>`).join('')
    : '<div class="gray">ログなし</div>';

  return HTML
    .replace('{{REFRESH_TIME}}', now.toLocaleString('ja-JP'))
    .replace('{{STATUS_CLASS}}', statusClass)
    .replace('{{STATUS_TEXT}}', statusText)
    .replace('{{PID}}', status.pid || '-')
    .replace('{{LAST_POLL}}', lastPoll)
    .replace('{{PRICE}}', price)
    .replace('{{ST_CLASS}}', stClass)
    .replace('{{ST_DIR}}', stDir)
    .replace('{{ST_LINE}}', stLine)
    .replace('{{SESSION_JP}}', sessionJP(session))
    .replace('{{SESSION_NOTE}}', sessionNote(session))
    .replace('{{POSITION_CLASS}}', positionClass)
    .replace('{{POSITION_HTML}}', positionHtml)
    .replace('{{CUM_HTML}}', cumHtml)
    .replace('{{TODAY_HTML}}', todayHtml)
    .replace('{{LOG_HTML}}', logHtml);
}

createServer((req, res) => {
  if (req.url === '/api/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      pid: pidAlive(), state: safeJson(STATE_FILE, {}),
      trades: safeJson(TRADES_FILE, []), recent: parseRecentLog(),
    }, null, 2));
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(render());
}).listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
});
