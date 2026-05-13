#!/usr/bin/env node
// Sends a single test embed to verify the webhook is wired up.
// Run with: node --env-file=.env scripts/discord_test.js

const URL = process.env.DISCORD_WEBHOOK_URL;
if (!URL) { console.error('DISCORD_WEBHOOK_URL not set'); process.exit(1); }

const payload = {
  embeds: [{
    title: '🔧 Test — TradingView signal forwarder online',
    description: 'Webhook wired up. The forwarder will post 5m XAUUSD scalp signals here when the strategy filters fire.',
    color: 0x60a5fa,
    fields: [
      { name: 'Strategy', value: '5m Supertrend reversal + LuxAlgo BOS confluence', inline: false },
      { name: 'Sessions', value: 'NY · London/NY overlap', inline: true },
      { name: 'Regime gate', value: 'Weekly Supertrend alignment (currently BULL)', inline: true },
      { name: 'Backtest', value: 'PF 3.52 · expectancy +$14.53/trade · n=11 (8 days)', inline: false },
    ],
    footer: { text: 'If you see this, the forwarder is ready to run.' },
    timestamp: new Date().toISOString(),
  }],
};

const res = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

if (res.ok) console.log('✓ Discord test sent (HTTP ' + res.status + ')');
else { console.error('✗ Failed: HTTP ' + res.status + ' — ' + await res.text()); process.exit(1); }
