# Discord Signal Forwarder

Live forwarder for high-quality XAUUSD 5m scalp signals to a Discord channel via webhook.

> For day-to-day VPS operations, troubleshooting, and the TradingView 1-session-per-account caveat, see **[OPERATIONS.md](OPERATIONS.md)**.

## Strategy (backtested, do not modify lightly)

### Entry (ALL must be true)
1. **5m Supertrend(10, 3) direction flip** detected vs previous poll
2. **Same-direction LuxAlgo BOS label within prior 5 bars** (continuation confluence)
3. **Session ∈ { NY, London/NY overlap }** — Tokyo and London-only excluded
4. **Trade aligns with Weekly Supertrend regime** (set via `WEEKLY_DIR` env var)

### Exit (any triggers close)
- **SL hit**: price crosses the entry-time Supertrend line
- **TP hit** (optional): price reaches `RR_TARGET` × stop distance from entry. Disabled by default — set `ENABLE_TP=1` to use. Backtest used Supertrend-flip exit (no TP) and achieved realized RR ~3.2.
- **Supertrend flips**: trend indicator reverses against position

### Notifications
- **🟢/🔴 Entry** embed at signal firing — price, SL, TP (if enabled), session, BOS context, weekly regime
- **🎯/⛔/🔄 Exit** embed at close — entry/exit, duration, pips, reason, P/L per oz and per 100oz lot
- **📊 Daily summary** at `SUMMARY_HOUR_UTC` every day (default 22 UTC = 07:00 JST, right after NY close)
- **📊 Weekly summary** on Saturdays at `SUMMARY_HOUR_UTC` (covers Mon-Fri)
- **📊 Monthly summary** on day 1 of each month at `SUMMARY_HOUR_UTC` (covers previous calendar month)

All summary embeds include a **📈 Cumulative** field with all-time stats since the first recorded trade: total P/L, trade count, win rate, PF, and max drawdown.

Backtest (8 days, n=11): expectancy +$14.53/trade, PF 3.52, win rate 45.5%. CHoCH labels excluded — they degrade performance.

## Setup

### 1. Create Discord webhook

In your Discord server: Settings → Integrations → Webhooks → New Webhook → pick a channel → Copy URL.

### 2. Configure environment

Create `.env` in this repo root (already in `.gitignore`):

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
WEEKLY_DIR=bull          # or bear — re-run scripts/backtest_regime.js to verify
POLL_INTERVAL_MS=30000   # default 30s
SYMBOL=OANDA:XAUUSD      # display + pane symbol check
TARGET_PANE=0            # pane index to lock to (default 0)
ENABLE_TP=0              # 1 to enable fixed-RR TP exit; default off (ST-flip exit only)
RR_TARGET=2.0            # TP at this multiple of stop distance (only used if ENABLE_TP=1)
SUMMARY_HOUR_UTC=22      # hour to post daily summary (22 UTC = 07:00 JST after NY close)
```

### 3. Prerequisites

- TradingView Desktop running with `--remote-debugging-port=9222`
- Pane focused on `OANDA:XAUUSD` 5m with **Supertrend** and **LuxAlgo SMC** indicators loaded
- (Required indicators are user's standard scalp stack)

### 4. Run

```bash
# Dry-run (no webhook needed, prints to console)
node scripts/discord_signals.js

# Live, with .env loaded
node --env-file=.env scripts/discord_signals.js

# Background (Windows PowerShell)
Start-Process -WindowStyle Hidden node "scripts/discord_signals.js"
```

## State

Persisted to `scripts/discord_state.json` (gitignored). Restart-resumable.

## Logs

Every poll logs price, ST direction, session, and rejection reasons. Sample:

```
[2026-05-13T02:58:25.240Z] price=$4692.72 ST=DOWN@$4690.67 session=tokyo weekly=BULL lastST=DOWN
[2026-05-13T03:15:10.123Z] price=$4708.50 ST=UP@$4710.10 session=ny weekly=BULL lastST=DOWN
  → ST FLIP detected: -1 -> 1
  ✓ ALL filters pass! BOS at x=1356 price=4710.85
[2026-05-13T03:15:11.450Z] Discord notified ✓
```

## Refreshing the Weekly regime

The Daily/Weekly regime determines `WEEKLY_DIR`. Re-run:

```bash
# Fetch fresh weekly history
node src/cli/index.js timeframe W
# ... scroll back, then save ohlcv to xauusd_weekly.json ...
node scripts/backtest_regime.js
# Read the "current_regime" output, update .env
```

A simpler weekly-only refresher script could be built but is left as an exercise.

## Limitations

- Signals fire when ST flip detected between two polls — if a flip-and-flip-back happens within `POLL_INTERVAL_MS`, it may be missed
- LuxAlgo BOS label detection uses the chart's current visible labels — make sure the indicator is loaded and visible
- Session detection uses UTC; verify your TradingView pane shows the correct symbol
- Backtest sample is small (n=11); live performance may differ
