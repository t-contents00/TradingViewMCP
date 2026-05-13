#!/usr/bin/env node
import { readFileSync } from 'fs';

const dataPath = process.argv[2] || './xauusd_5m.json';
const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
const bars = data.bars;
const last = bars[bars.length - 1];
const currentPrice = last.close;

// === 1. Swing highs/lows (pivot strength = 5 bars each side) ===
const STRENGTH = 5;
const swingHighs = [];
const swingLows = [];

for (let i = STRENGTH; i < bars.length - STRENGTH; i++) {
  const h = bars[i].high;
  const l = bars[i].low;
  let isHigh = true, isLow = true;
  for (let j = i - STRENGTH; j <= i + STRENGTH; j++) {
    if (j === i) continue;
    if (bars[j].high >= h) isHigh = false;
    if (bars[j].low <= l) isLow = false;
  }
  if (isHigh) swingHighs.push({ time: bars[i].time, price: h, idx: i });
  if (isLow) swingLows.push({ time: bars[i].time, price: l, idx: i });
}

// Cluster swings within $1 of each other (equal highs/lows = liquidity)
function clusterLevels(swings, tol = 1.0) {
  const sorted = [...swings].sort((a, b) => b.price - a.price);
  const clusters = [];
  for (const s of sorted) {
    const existing = clusters.find(c => Math.abs(c.price - s.price) <= tol);
    if (existing) {
      existing.count++;
      existing.touches.push(s);
      existing.price = (existing.price * (existing.count - 1) + s.price) / existing.count;
    } else {
      clusters.push({ price: s.price, count: 1, touches: [s] });
    }
  }
  return clusters.sort((a, b) => b.count - a.count);
}

const highClusters = clusterLevels(swingHighs);
const lowClusters = clusterLevels(swingLows);

// === 2. Volume-heavy zones (price bins) ===
const minP = Math.min(...bars.map(b => b.low));
const maxP = Math.max(...bars.map(b => b.high));
const BIN = 2.0; // $2 bins for gold
const bins = {};
for (const b of bars) {
  const midPrice = (b.high + b.low + b.close) / 3;
  const binKey = Math.round(midPrice / BIN) * BIN;
  bins[binKey] = (bins[binKey] || 0) + b.volume;
}
const volBins = Object.entries(bins)
  .map(([p, v]) => ({ price: parseFloat(p), volume: v }))
  .sort((a, b) => b.volume - a.volume);

// === 3. FVG detection (3-bar gaps) ===
const fvgs = [];
for (let i = 2; i < bars.length; i++) {
  const a = bars[i - 2], c = bars[i];
  // Bullish FVG: candle 1 high < candle 3 low
  if (a.high < c.low) {
    fvgs.push({ type: 'bullish', top: c.low, bottom: a.high, time: bars[i - 1].time, age: bars.length - i });
  }
  // Bearish FVG: candle 1 low > candle 3 high
  if (a.low > c.high) {
    fvgs.push({ type: 'bearish', top: a.low, bottom: c.high, time: bars[i - 1].time, age: bars.length - i });
  }
}
// Filter to unfilled FVGs (current price hasn't traversed them)
const liveFvgs = fvgs.filter(f => {
  if (f.type === 'bullish') return currentPrice > f.top;
  return currentPrice < f.bottom;
}).slice(-10); // most recent 10

// === Output ===
console.log(JSON.stringify({
  current_price: currentPrice,
  bars_analyzed: bars.length,
  period_hours: (bars[bars.length - 1].time - bars[0].time) / 3600,
  swing_highs_clusters: highClusters.slice(0, 8).map(c => ({
    price: +c.price.toFixed(2), touches: c.count,
    dist: +(c.price - currentPrice).toFixed(2)
  })),
  swing_lows_clusters: lowClusters.slice(0, 8).map(c => ({
    price: +c.price.toFixed(2), touches: c.count,
    dist: +(c.price - currentPrice).toFixed(2)
  })),
  top_volume_zones: volBins.slice(0, 6).map(v => ({
    price: v.price, volume: v.volume,
    dist: +(v.price - currentPrice).toFixed(2)
  })),
  fvgs_unfilled: liveFvgs.map(f => ({
    type: f.type,
    top: +f.top.toFixed(2),
    bottom: +f.bottom.toFixed(2),
    age_bars: f.age,
    size: +(f.top - f.bottom).toFixed(2)
  }))
}, null, 2));
