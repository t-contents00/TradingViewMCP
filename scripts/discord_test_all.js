#!/usr/bin/env node
/**
 * Send all notification types as samples (with [サンプル] prefix).
 * Run: node --env-file=.env scripts/discord_test_all.js
 */

const URL = process.env.DISCORD_WEBHOOK_URL;
const SYMBOL = process.env.SYMBOL || 'OANDA:XAUUSD';
const RR_TARGET = +(process.env.RR_TARGET || 2.0);
if (!URL) { console.error('DISCORD_WEBHOOK_URL not set'); process.exit(1); }

const tag = t => `[サンプル] ${t}`;

async function post(payload) {
  const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) { console.error(`✗ ${res.status}: ${await res.text()}`); return false; }
  return true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAUSE = 1500;

function sessionLabel(s) {
  return ({ tokyo: '東京', london: 'ロンドン', london_ny_overlap: 'ロンドン/NY重複', ny: 'NY', off_hours: '時間外' })[s] || s;
}

// === Reused builders (mirror discord_signals.js) ===
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
      title: tag(`${arrow} ${action}シグナル発生 — ${SYMBOL}`),
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
      title: tag(`${r.emoji} 決済通知 — ${trade.direction === 1 ? '買い' : '売り'}ポジション (${r.label})`),
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
    best: Math.max(...trades.map(t => t.pnl)),
    maxDd,
  };
}

function summaryEmbed(trades, periodLabel, allClosed, cumulativeStartDate) {
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
      value: `**${cumSign}$${cum.totalPnl.toFixed(2)}** (1oz) / **${cumSign}$${(cum.totalPnl*100).toFixed(2)}** (100oz)\n総トレード ${cum.n}回 · 勝率 ${cum.winRate.toFixed(1)}% · 利益損失比 ${cumPfStr}\n最大ドローダウン $${cum.maxDd.toFixed(2)}`,
      inline: false,
    });
  }
  return {
    embeds: [{
      title: tag(`📊 ${periodLabel} 集計 — ${s.n}トレード ${verdict}`),
      description: `**${sign}$${s.totalPnl.toFixed(2)}** (1oz換算) / **${sign}$${(s.totalPnl * 100).toFixed(2)}** (100oz=1ロット換算)`,
      color: s.totalPnl >= 0 ? 0x22c55e : 0xef4444,
      fields,
      footer: { text: `バックテスト期待値 +$14.53/trade · 利益損失比 3.52倍` },
      timestamp: new Date().toISOString(),
    }],
  };
}

function heartbeatEmbed() {
  return {
    embeds: [{
      title: tag('💚 フォワーダー稼働中'),
      description: '6時間毎の生存確認です。VPSが正常に動いてます。',
      color: 0x60a5fa,
      fields: [
        { name: '💰 現在価格', value: `$4,705.30 (${SYMBOL})`, inline: true },
        { name: '📊 Supertrend', value: '下降 ↓ @ $4,710.15', inline: true },
        { name: '⏰ セッション', value: '東京', inline: true },
        { name: '🎯 保有ポジション', value: 'なし', inline: true },
        { name: '📅 今日の損益', value: '0トレード +$0.00', inline: true },
        { name: '📈 累計', value: '0トレード', inline: true },
      ],
      footer: { text: 'シグナル無し時は静かです。これは正常です。' },
      timestamp: new Date().toISOString(),
    }],
  };
}

// === Run ===
const mockLong = { id: 'SAMPLE-LONG-4708', entry_time: Math.floor(Date.now() / 1000) - 1800, entry_price: 4708.50, direction: 1, sl: 4690.67, tp: 4744.16, session: 'ny', weekly_dir: 1, bos_price: 4710.85 };
const mockShort = { id: 'SAMPLE-SHORT-4725', entry_time: Math.floor(Date.now() / 1000) - 600, entry_price: 4725.30, direction: -1, sl: 4742.10, tp: 4691.70, session: 'london_ny_overlap', weekly_dir: 1, bos_price: 4722.85 };
const dailyTrades = [
  { pnl: 35.36, exit_time: 1778600000 }, { pnl: -17.10, exit_time: 1778620000 }, { pnl: 14.00, exit_time: 1778640000 },
];
const cumulativePool = [
  ...dailyTrades,
  ...Array.from({ length: 24 }, (_, i) => ({ pnl: [28.5, -15.2, 21.7, 18.4, -12.8, 33.1, -16.5, 24.9, 19.3, -11.7, 27.6, -14.4, 22.1, 16.8, -13.5, 29.7, -10.9, 25.4, 20.6, -18.2, 31.8, -15.7, 23.5, 17.9][i], exit_time: 1778100000 + i * 20000 })),
];
const startDate = '2026-04-13';

console.log('全9種類のサンプル送信中...\n');

console.log('1/9 買いシグナル...'); await post(entryEmbed(mockLong)); await sleep(PAUSE);
console.log('2/9 売りシグナル...'); await post(entryEmbed(mockShort)); await sleep(PAUSE);
console.log('3/9 利確 (TP) 決済...'); await post(exitEmbed({ ...mockLong, exit_time: mockLong.entry_time + 1500, exit_price: 4744.16, exit_reason: 'TP', pnl: 35.36 })); await sleep(PAUSE);
console.log('4/9 損切 (SL) 決済...'); await post(exitEmbed({ ...mockShort, exit_time: mockShort.entry_time + 720, exit_price: 4742.10, exit_reason: 'SL', pnl: -17.10 })); await sleep(PAUSE);
console.log('5/9 反転 (flip) 決済...'); await post(exitEmbed({ ...mockLong, id: 'SAMPLE-LONG-4711-FLIP', entry_price: 4711.20, exit_time: mockLong.entry_time + 2700, exit_price: 4725.50, exit_reason: 'flip', pnl: 14.00 })); await sleep(PAUSE);
console.log('6/9 日次集計...'); await post(summaryEmbed(dailyTrades, '日次 (本日分)', cumulativePool, startDate)); await sleep(PAUSE);
console.log('7/9 週次集計...'); await post(summaryEmbed(cumulativePool.slice(0, 8), '週次 (2026-W20)', cumulativePool, startDate)); await sleep(PAUSE);
console.log('8/9 月次集計...'); await post(summaryEmbed(cumulativePool.slice(0, 22), '月次 (2026-04)', cumulativePool, startDate)); await sleep(PAUSE);
console.log('9/9 生存確認 (heartbeat)...'); await post(heartbeatEmbed());

console.log('\n✓ 9種類のサンプル送信完了。Discordチャンネル確認してください。');
