# Deriv Differs Bot — Railway Deployment

A headless 24/7 Node.js trading bot for Deriv's **Digit Differs** market with **11× Martingale** recovery, ready to deploy on [Railway](https://railway.app).

---

## 🚀 Deploy to Railway in 5 Steps

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/deriv-differs-bot.git
git push -u origin main
```

### 2. Create a Railway project
1. Go to [railway.app](https://railway.app) and log in
2. Click **New Project → Deploy from GitHub repo**
3. Select your repository

### 3. Set Environment Variables
In your Railway project, go to **Variables** tab and add:

| Variable | Value | Required |
|---|---|---|
| `DERIV_API_TOKEN` | Your token from app.deriv.com/account/api-token | ✅ Yes |
| `DIFFERS_STAKE` | e.g. `1.00` | Optional |
| `DIFFERS_TARGET_PROFIT` | e.g. `10.00` | Optional |
| `DIFFERS_STOP_LOSS` | e.g. `5.00` | Optional |
| `MARTINGALE_ENABLED` | `true` (default) / `false` to disable | Optional |

> See `.env.example` for the full list of variables.

### 4. Deploy
Railway auto-deploys on every push. You can also trigger a manual deploy from the Railway dashboard.

### 5. Monitor Logs
In Railway → your service → **Logs** tab. You'll see real-time output like:
```
[12:00:01] ·  Authorized: CR123456 | Currency: USD | Balance: USD 100.00
[12:00:02] 🔍  ADS scan started — trading paused during scan
[12:00:15] ✅  ADS: applied → Digit 3 on Volatility 50 (1s) (7.80%) — trading resumed
[12:00:16] 💰  Placing Differs: digit 3 | $1.00 | 1 tick(s)
[12:00:17] ❌  LOSS — $-1.00 | Contract 12345678
[12:00:17] ⚠️  Martingale armed — next trade will use $11.00 (11× stake)
[12:00:18] 💰  Martingale active: stake elevated to $11.00 (11×)
[12:00:19] ✅  WIN — +$10.45 | Contract 12345679
```

---

## ⚙️ Configuration Reference

All settings are controlled via **environment variables** — no code edits needed.

| Variable | Default | Description |
|---|---|---|
| `DERIV_API_TOKEN` | — | **Required.** Your Deriv API token |
| `MARKET` | `1HZ50V` | Starting market symbol |
| `DIFFERS_ENABLED` | `true` | Enable/disable Differs bot |
| `DIFFERS_STAKE` | `1.00` | USD base stake per trade |
| `DIFFERS_MODE` | `auto` | `auto` or `manual` |
| `DIFFERS_MANUAL_DIGIT` | `null` | Target digit if mode=manual |
| `DIFFERS_TARGET_PROFIT` | `10.00` | Stop bot at this profit (USD) |
| `DIFFERS_STOP_LOSS` | `5.00` | Stop bot at this loss (USD) |
| `MARTINGALE_ENABLED` | `true` | Enable 11× stake recovery after a loss |
| `ADS_ENABLED` | `true` | Auto-scan for coldest digit |
| `ADS_THRESHOLD` | `8.5` | Cold-digit threshold (%) |
| `ADS_SCAN_INTERVAL` | `300` | Seconds between re-scans |
| `ADS_TICK_SAMPLE` | `1000` | Ticks analysed per scan |
| `ADS_MARKETS` | all 1HZ | Comma-separated market list |

---

## 🔁 Martingale Logic

When **Martingale** is enabled (default):
- After every **loss**, the next trade uses `DIFFERS_STAKE × 11`
- After that one recovery trade (win **or** loss), stake resets to `DIFFERS_STAKE`
- This is a single-step martingale — it fires **once per loss**, never compounds

To disable: set `MARTINGALE_ENABLED=false` in Railway Variables.

---

## 🔁 Auto-Restart

Railway automatically restarts the bot if it crashes (configured in `railway.toml`). The bot also has built-in WebSocket reconnect with exponential back-off (up to 60s).

---

## ⚠️ Risk Warning

Automated trading carries significant financial risk. Always test with a **Demo account** first. Set conservative `DIFFERS_STOP_LOSS` and `DIFFERS_TARGET_PROFIT` values. The 11× Martingale recovery trade multiplies both potential gain and potential loss.
