# Operations Runbook — TradingView Discord Forwarder

実運用で必要になった手順とハマりどころのまとめ。

## 概要

XAUUSD 5m スキャ用 Discord シグナルフォワーダー。Windows VPS で TradingView Desktop を起動し、Chrome DevTools Protocol (CDP) 経由で読み取った Supertrend + LuxAlgo BOS の合流を Discord に通知する。

```
[Windows VPS]
  ├── TradingView Desktop (--remote-debugging-port=9222)
  ├── scripts/discord_signals.js  (常駐)
  └── scripts/dashboard.js        (常駐、localhost:8080)
       ↓
[Discord webhook]
```

## ⚠️ TradingView セッション制約 (重要)

**TradingView は 1 アカウント = 1 アクティブセッション**。VPS で TradingView を起動中にスマホ・他PCで同じアカウントを使うと、片方が必ず切断される。

切断されると：
- VPS チャートのリアルタイム更新停止
- CDP 接続は生きてても古い価格が読まれ続ける
- **誤シグナル発生のリスク**

### 対処オプション

| 案 | コスト | 利便性 | 推奨度 |
|----|--------|--------|--------|
| 専用 TradingView アカウントを別途契約 | +月$15-60 | 自由に他端末で使える | ⭐⭐ |
| NY時間 (22-07 JST) だけ VPS 稼働 | 無料 | 日中は他端末で TV 使用可、夜は VPS | ⭐⭐⭐ |
| スマホで TradingView を開かない | 無料 | Discord + ダッシュボードで監視 | ⭐⭐ |
| Tailscale でダッシュボードをスマホから見る | 無料 | TV アプリ不要、Discord と併用 | ⭐⭐⭐ |

NY時間運用 + Discord 通知 + Tailscale ダッシュボードが現実的な落としどころ。

## セットアップ手順 (Windows VPS)

### 1. 前提ソフト

```powershell
# 管理者 PowerShell で実行
winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements
```

**PowerShell を再起動して PATH を反映**。

### 2. TradingView Desktop

Microsoft Store または https://tradingview.com/desktop からインストール。ログイン後、**`XAUUSD_Scalp_3pane` レイアウト** を作成 (Pane 0 = OANDA:XAUUSD 5m + Supertrend + LuxAlgo SMC + その他)。レイアウトはクラウド同期される。

### 3. リポジトリ取得

```powershell
cd C:\
git clone https://github.com/t-contents00/TradingViewMCP.git
cd C:\TradingViewMCP
npm install
```

### 4. `.env` (BOMなしで書くこと)

PowerShell 5.1 の `Out-File` はデフォルト UTF-16 LE BOM を吐くため Node の `--env-file` が読めない。`[System.IO.File]::WriteAllText` を使う。

```powershell
$webhook = "https://discord.com/api/webhooks/<id>/<token>"
$lines = @("DISCORD_WEBHOOK_URL=$webhook", "WEEKLY_DIR=bull", "POLL_INTERVAL_MS=30000", "SYMBOL=OANDA:XAUUSD", "TARGET_PANE=0")
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("C:\TradingViewMCP\.env", ($lines -join "`n") + "`n", $utf8NoBom)
```

検証 (`Discord test sent (HTTP 204)` が出るか):
```powershell
node --env-file=.env scripts/discord_test.js
```

### 5. TradingView をデバッグポート付きで起動

```powershell
Get-Process TradingView -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 5
$tv = Get-ChildItem "C:\Program Files\WindowsApps\TradingView*\TradingView.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
Start-Process $tv.FullName -ArgumentList "--remote-debugging-port=9222"
Start-Sleep 30
curl http://localhost:9222/json/version  # JSON返れば OK
```

TradingView ウィンドウで `XAUUSD_Scalp_3pane` レイアウトを選択。

### 6. フォワーダー + ダッシュボード起動

```powershell
cd C:\TradingViewMCP

# Forwarder
$proc = Start-Process node -ArgumentList "--env-file=.env scripts/discord_signals.js" -WorkingDirectory $PWD -RedirectStandardOutput "scripts\forwarder.log" -RedirectStandardError "scripts\forwarder.err" -WindowStyle Hidden -PassThru
$proc.Id | Set-Content scripts\forwarder.pid -Encoding ascii -NoNewline

# Dashboard
$dash = Start-Process node -ArgumentList "scripts/dashboard.js" -WorkingDirectory $PWD -RedirectStandardOutput "scripts\dashboard.log" -RedirectStandardError "scripts\dashboard.err" -WindowStyle Hidden -PassThru
$dash.Id | Set-Content scripts\dashboard.pid -Encoding ascii -NoNewline

Write-Host "Forwarder PID: $($proc.Id) / Dashboard PID: $($dash.Id)"
```

**重要**: PID ファイルは `Set-Content -Encoding ascii -NoNewline` で書く。`Out-File` は UTF-16 LE BOM を吐くのでダッシュボードの PID 生存確認が壊れる。

ブラウザで `http://localhost:8080` を開いて稼働確認。

## 起動・停止コマンド

### 停止 (フォワーダー + ダッシュボード)

```powershell
cd C:\TradingViewMCP
Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*discord_signals.js*" -or $_.CommandLine -like "*dashboard.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### TradingView も停止

```powershell
Get-Process TradingView -ErrorAction SilentlyContinue | Stop-Process -Force
```

### 全体起動 (再起動後など)

上記「セットアップ手順」の 5 と 6 を順に実行。

## 更新手順

```powershell
cd C:\TradingViewMCP

# 1. 停止
Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*discord_signals.js*" -or $_.CommandLine -like "*dashboard.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2. pull
git pull

# 3. 必要なら依存更新
npm install

# 4. 起動 (セットアップ手順 6 と同じ)
```

## 監視

### ダッシュボード (推奨)

`http://localhost:8080` をブラウザで開く。10秒毎自動更新。フォワーダー稼働状況、現在価格、保有ポジション、戦績、ログを表示。

### Discord で通知される内容

| 種類 | タイミング |
|------|-----------|
| 🟢/🔴 エントリー | シグナル発火時 |
| 🎯/⛔/🔄 決済 | ポジションクローズ時 |
| 📊 日次集計 | 毎日 07:00 JST (NY 後) |
| 📊 週次集計 | 土曜 07:00 JST |
| 📊 月次集計 | 月初 07:00 JST |
| 💚 生存確認 | 6 時間毎 |

### コマンドライン

```powershell
# プロセス確認
Get-Process -Id (Get-Content scripts\forwarder.pid),(Get-Content scripts\dashboard.pid)

# ログ末尾
Get-Content scripts\forwarder.log -Tail 20

# エラーログ
Get-Content scripts\forwarder.err -Tail 20

# 接続状態
node src/cli/index.js status
```

## ハマりどころ

### 「停止中」と表示されるがプロセスは動いている

PID ファイルが UTF-16 LE BOM 付きで書かれた可能性。`Set-Content -Encoding ascii` で書き直す:

```powershell
"<実PID>" | Set-Content scripts\forwarder.pid -Encoding ascii -NoNewline
```

### 「ログなし」と表示される

1. TradingView がデバッグポート付きで起動していない → 上記「セットアップ手順 5」を再実行
2. `forwarder.err` を確認:
   ```powershell
   Get-Content scripts\forwarder.err -Tail 20
   ```
   `CDP connection failed` ならポート問題。

### Discord に通知が来ない

1. `.env` の BOM 問題 → 上記「セットアップ手順 4」で再書込
2. Webhook URL を Discord 側で再生成しているとログ反映必要
3. テスト送信:
   ```powershell
   node --env-file=.env scripts/discord_test.js
   ```
   `HTTP 204` 返れば OK。

### TradingView セッション切断

他端末で同じアカウントが使われた。**接続** ボタンを押すと他端末が切断される (循環)。`OPERATIONS.md` 上部の対処オプション参照。

### `git pull` 後にスクリプトが壊れる

依存追加されている可能性: `npm install` を再実行。

## バックテスト要約

### 戦略パラメータ

| 項目 | 値 |
|------|-----|
| エントリー条件 1 | 5m Supertrend(10,3) 反転 |
| エントリー条件 2 | 同方向 LuxAlgo BOS が過去 5 本以内 |
| エントリー条件 3 | セッション ∈ {NY, London/NY 重複} |
| エントリー条件 4 | Weekly Supertrend 順張り |
| 決済 1 | SL (Supertrend 線到達) |
| 決済 2 (オプション) | TP at RR 2.0 (ENABLE_TP=1 で有効) |
| 決済 3 | Supertrend 反転 |

### 期待値 (バックテスト n=11、8 日窓)

- 勝率: 45.5%
- 期待値/trade: +$14.53 (1oz)
- Profit Factor: 3.52
- 1 日あたりシグナル数: 約 0.13 本 (週 1 本ペース)

サンプル小、レジーム依存 (Daily DOWN + Weekly BULL 環境)。継続して計測すべし。

## 将来の改善候補

- [ ] Task Scheduler 自動起動スクリプト
- [ ] NY時間自動 ON/OFF スケジューリング
- [ ] Tailscale 経由のダッシュボードリモート閲覧設定
- [ ] アップストリームへの bug fix PR (drawing.js, chart.js _resolve 抜け)
- [ ] LuxAlgo Buy/Sell シグナル (もし指標で出ているなら) 統合
- [ ] レジーム変化時のアラート (Daily/Weekly Supertrend flip)
