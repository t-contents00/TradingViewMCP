#!/usr/bin/env node
/**
 * Fetch extended historical OHLCV by walking backward in time via scroll.
 * Stitches multiple 500-bar windows into a single sorted, deduplicated dataset.
 *
 * Usage: node scripts/fetch_history.js <days> <output.json>
 *   - days: how many days back from now
 *   - assumes chart is already on the target symbol/resolution
 */

import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';

const daysBack = parseFloat(process.argv[2] || '30');
const outFile = process.argv[3] || 'history.json';
const CLI = 'src/cli/index.js';

function call(args) {
  const res = spawnSync('node', [CLI, ...args], { encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`CLI failed: ${args.join(' ')} -> ${res.stderr}`);
  // CLI outputs JSON; some commands print extra lines, but ohlcv returns pure JSON
  return JSON.parse(res.stdout);
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

console.error(`Fetching ${daysBack} days of history...`);

const allBars = new Map(); // time -> bar
const now = Math.floor(Date.now() / 1000);
const targetStart = now - daysBack * 86400;

// Step 1: get current data
console.error('Chunk 1: latest 500 bars');
const initial = call(['ohlcv', '-n', '500']);
for (const b of initial.bars) allBars.set(b.time, b);
let oldestSoFar = initial.bars[0].time;
console.error(`  loaded ${initial.bars.length} bars, oldest = ${new Date(oldestSoFar * 1000).toISOString()}`);

let chunkNum = 2;
let consecutiveNoNew = 0;

while (oldestSoFar > targetStart && consecutiveNoNew < 3) {
  // Scroll to a date that's a bit before our current oldest
  const scrollTarget = oldestSoFar - 30 * 60; // 30 min before oldest
  const dateStr = new Date(scrollTarget * 1000).toISOString().split('T')[0];
  console.error(`Chunk ${chunkNum}: scrolling to ${dateStr} (target oldest=${new Date(targetStart * 1000).toISOString()})`);

  try {
    call(['scroll', '--date', String(scrollTarget)]);
    sleep(2500); // Wait for chart to load
    const chunk = call(['ohlcv', '-n', '500']);

    let newCount = 0;
    for (const b of chunk.bars) {
      if (!allBars.has(b.time)) { allBars.set(b.time, b); newCount++; }
    }

    const chunkOldest = chunk.bars[0].time;
    console.error(`  +${newCount} new bars, chunk_oldest=${new Date(chunkOldest * 1000).toISOString()}, total=${allBars.size}`);

    if (newCount === 0) {
      consecutiveNoNew++;
      console.error(`  no new bars (${consecutiveNoNew}/3)`);
    } else {
      consecutiveNoNew = 0;
    }

    if (chunkOldest < oldestSoFar) oldestSoFar = chunkOldest;
    else { // didn't go back further
      consecutiveNoNew++;
    }
  } catch (e) {
    console.error(`  chunk ${chunkNum} failed: ${e.message}`);
    consecutiveNoNew++;
  }
  chunkNum++;
  if (chunkNum > 80) { console.error('safety break: 80 chunks max'); break; }
}

// Sort, dedup, write
const sortedBars = [...allBars.values()].sort((a, b) => a.time - b.time);
const output = {
  symbol: initial.symbol || 'unknown',
  resolution: '5',
  bar_count: sortedBars.length,
  period: { from: sortedBars[0].time, to: sortedBars[sortedBars.length - 1].time },
  days_covered: ((sortedBars[sortedBars.length - 1].time - sortedBars[0].time) / 86400).toFixed(2),
  bars: sortedBars,
};
writeFileSync(outFile, JSON.stringify(output, null, 2));
console.error(`\nSaved ${sortedBars.length} bars covering ${output.days_covered} days -> ${outFile}`);
console.error(`Period: ${new Date(output.period.from * 1000).toISOString()} -> ${new Date(output.period.to * 1000).toISOString()}`);
