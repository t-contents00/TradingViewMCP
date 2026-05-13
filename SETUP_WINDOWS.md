# Windows Setup Notes

Personal fork of [tradesdontlie/tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) with local fixes and a LuxAlgo-style level extraction script.

## Prerequisites

- Node.js 18+
- Claude Code (CLI)
- TradingView Desktop (MSIX/Store install at `C:\Program Files\WindowsApps\TradingView.Desktop_*` or standalone at `%LOCALAPPDATA%\TradingView\`)

## Install

```powershell
git clone https://github.com/t-contents00/TradingViewMCP.git "$env:USERPROFILE\Desktop\ClaudeCode\tradingview-mcp"
cd "$env:USERPROFILE\Desktop\ClaudeCode\tradingview-mcp"
npm install
```

## MCP config

Create `%USERPROFILE%\.claude\.mcp.json` (global) or `<project>\.mcp.json` (project-scoped):

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["C:\\Users\\<USERNAME>\\Desktop\\ClaudeCode\\tradingview-mcp\\src\\server.js"]
    }
  }
}
```

Replace `<USERNAME>` with the actual Windows user.

## Launch TradingView with debug port

MSIX (Store) install path is the default on this machine. Adjust the path if standalone install:

```powershell
taskkill /F /IM TradingView.exe
& "C:\Program Files\WindowsApps\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\TradingView.exe" --remote-debugging-port=9222
```

Verify CDP:

```powershell
curl http://localhost:9222/json/version
```

Then restart Claude Code so the MCP server loads, and run `tv_health_check`.

## Local modifications vs upstream

- `src/core/drawing.js` — fixed `_resolve()` dependency injection in `listDrawings`, `getProperties`, `removeOne`, `clearAll` (upstream bug: unprefixed `getChartApi`/`evaluate` references caused `ReferenceError`).
- `scripts/luxalgo_levels.js` — extracts swing high/low clusters, volume-heavy zones, and FVGs from OHLCV JSON. Usage:
  ```bash
  node src/cli/index.js ohlcv -n 300 > xauusd_5m.json
  node scripts/luxalgo_levels.js xauusd_5m.json
  ```
