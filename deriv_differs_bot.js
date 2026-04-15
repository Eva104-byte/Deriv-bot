/**
 * ============================================================
 *  Deriv Differs Bot — Node.js Edition (converted from v10)
 *  Runs 24/7 headlessly on any server or free cloud host.
 * ============================================================
 *
 *  FEATURES:
 *    • Digit Differs Bot  — trades when target digit is absent from last 10 ticks
 *    • Even / Odd Bot     — MKOREAN WWN strategy (runs independently)
 *    • Auto Digit Selector — scans all markets, picks the coldest digit
 *    • Auto-Scan Mode      — re-scans on a timer, applies best digit automatically
 *    • Market Halt System  — 5-min cooldown per market after a loss; auto-fallback
 *    • Risk Controls       — Target Profit & Stop Loss for both bots
 *    • Auto-reconnect      — reconnects on disconnect with exponential back-off
 *
 *  SETUP:
 *    1.  npm install ws
 *    2.  Edit CONFIG below (API token, stake, limits, etc.)
 *    3.  node deriv_differs_bot.js
 *
 *  KEEP ALIVE (free hosts):
 *    npm install -g pm2
 *    pm2 start deriv_differs_bot.js --name deriv-bot
 *    pm2 save && pm2 startup
 * ============================================================
 */

'use strict';

const WebSocket = require('ws');

// ─────────────────────────────────────────────────────────────
//  CONFIG — driven by environment variables for Railway deployment.
//
//  Required env var:
//    DERIV_API_TOKEN          Your Deriv API token
//
//  Optional env vars (all have sensible defaults):
//    MARKET                   Starting symbol            (default: 1HZ50V)
//    DIFFERS_ENABLED          true | false               (default: true)
//    DIFFERS_STAKE            USD per trade              (default: 1.00)
//    DIFFERS_DURATION         ticks                      (default: 1)
//    DIFFERS_MODE             auto | manual              (default: auto)
//    DIFFERS_MANUAL_DIGIT     0-9, only if mode=manual   (default: null)
//    DIFFERS_TARGET_PROFIT    USD                        (default: 10.00)
//    DIFFERS_STOP_LOSS        USD                        (default: 5.00)
//    EO_ENABLED               true | false               (default: false)
//    EO_STAKE                 USD per trade              (default: 1.00)
//    EO_DURATION              ticks                      (default: 1)
//    EO_TARGET_PROFIT         USD                        (default: 10.00)
//    EO_STOP_LOSS             USD                        (default: 5.00)
//    ADS_ENABLED              true | false               (default: true)
//    ADS_TICK_SAMPLE          ticks to analyse           (default: 1000)
//    ADS_THRESHOLD            cold-digit %               (default: 8.5)
//    ADS_SCAN_INTERVAL        seconds between scans      (default: 300)
//    ADS_MARKETS              comma-separated symbols    (default: all 1HZ)
//    DERIV_APP_ID             Deriv app ID               (default: 1089)
//    DIFFERS_MARTINGALE       true | false               (default: false)
//    DIFFERS_MARTINGALE_MULT  multiplier on loss         (default: 2.0)
//    DIFFERS_MARTINGALE_MAX   max stake cap (0 = no cap) (default: 0)
//    EO_MARTINGALE            true | false               (default: false)
//    EO_MARTINGALE_MULT       multiplier on loss         (default: 2.0)
//    EO_MARTINGALE_MAX        max stake cap (0 = no cap) (default: 0)
// ─────────────────────────────────────────────────────────────

function envBool(key, def) {
  const v = process.env[key];
  if (v === undefined) return def;
  return v.toLowerCase() === 'true';
}
function envFloat(key, def) {
  const v = parseFloat(process.env[key]);
  return isNaN(v) ? def : v;
}
function envInt(key, def) {
  const v = parseInt(process.env[key]);
  return isNaN(v) ? def : v;
}

const DEFAULT_ADS_MARKETS = [
  '1HZ10V','1HZ15V','1HZ25V','1HZ30V','1HZ50V','1HZ75V','1HZ100V',
];

const CONFIG = {
  API_TOKEN: process.env.DERIV_API_TOKEN || 'YOUR_API_TOKEN_HERE',

  MARKET: process.env.MARKET || '1HZ50V',

  // ── Digit Differs Bot ─────────────────────────────────────
  DIFFERS: {
    ENABLED:        envBool ('DIFFERS_ENABLED',       true),
    STAKE:          envFloat('DIFFERS_STAKE',         1.00),
    DURATION:       envInt  ('DIFFERS_DURATION',      1),
    MODE:           process.env.DIFFERS_MODE          || 'auto',
    MANUAL_DIGIT:   process.env.DIFFERS_MANUAL_DIGIT  != null
                      ? parseInt(process.env.DIFFERS_MANUAL_DIGIT) : null,
    TARGET_PROFIT:  envFloat('DIFFERS_TARGET_PROFIT', 10.00),
    STOP_LOSS:      envFloat('DIFFERS_STOP_LOSS',     5.00),
    MARTINGALE:     envBool ('DIFFERS_MARTINGALE',    false),
    MARTINGALE_MULT:envFloat('DIFFERS_MARTINGALE_MULT', 11.0),
    MARTINGALE_MAX: envFloat('DIFFERS_MARTINGALE_MAX',  1),
  },

  // ── Even / Odd Bot (MKOREAN WWN) ─────────────────────────
  EO: {
    ENABLED:        envBool ('EO_ENABLED',            false),
    STAKE:          envFloat('EO_STAKE',              1.00),
    DURATION:       envInt  ('EO_DURATION',           1),
    TARGET_PROFIT:  envFloat('EO_TARGET_PROFIT',      10.00),
    STOP_LOSS:      envFloat('EO_STOP_LOSS',          5.00),
    MARTINGALE:     envBool ('EO_MARTINGALE',         false),
    MARTINGALE_MULT:envFloat('EO_MARTINGALE_MULT',    2.0),
    MARTINGALE_MAX: envFloat('EO_MARTINGALE_MAX',     0),
  },

  // ── Auto Digit Selector ───────────────────────────────────
  ADS: {
    ENABLED:        envBool ('ADS_ENABLED',           true),
    TICK_SAMPLE:    envInt  ('ADS_TICK_SAMPLE',       1000),
    THRESHOLD:      envFloat('ADS_THRESHOLD',         8.5),
    SCAN_INTERVAL:  envInt  ('ADS_SCAN_INTERVAL',     300),
    MARKETS: process.env.ADS_MARKETS
      ? process.env.ADS_MARKETS.split(',').map(s => s.trim())
      : DEFAULT_ADS_MARKETS,
  },

  // ── Internal constants ────────────────────────────────────
  APP_ID:           envInt('DERIV_APP_ID', 1089),
  HALT_DURATION_MS: 5 * 60 * 1000,  // 5 minutes
};

// ─────────────────────────────────────────────────────────────
//  MARKET NAMES  (for readable logging)
// ─────────────────────────────────────────────────────────────
const MARKET_NAMES = {
  R_10:     'Volatility 10',
  R_25:     'Volatility 25',
  R_50:     'Volatility 50',
  R_75:     'Volatility 75',
  R_100:    'Volatility 100',
  '1HZ10V': 'Volatility 10 (1s)',
  '1HZ15V': 'Volatility 15 (1s)',
  '1HZ25V': 'Volatility 25 (1s)',
  '1HZ30V': 'Volatility 30 (1s)',
  '1HZ50V': 'Volatility 50 (1s)',
  '1HZ75V': 'Volatility 75 (1s)',
  '1HZ100V':'Volatility 100 (1s)',
};

const ALL_BOT_MARKETS = [
  'R_10','R_25','R_50','R_75','R_100',
  '1HZ10V','1HZ15V','1HZ25V','1HZ30V','1HZ50V','1HZ75V','1HZ100V',
];

// ─────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────

// Connection
let ws            = null;
let connected     = false;
let reconnectDelay = 2000;

// Tick data
let digits        = [];      // last-digit history (max 20)
let priceHistory  = [];      // raw price history (max 10)
let seenSet       = new Set();

// Differs Bot
let botRunning        = false;
let tradeInProgress   = false;
let selectedDigit     = null;
let wins = 0, losses = 0, pnl = 0;
let differsActive     = true;   // set false when TP/SL hit
let differsCurrentStake = CONFIG.DIFFERS.STAKE;  // martingale: tracks current stake

// Even/Odd Bot
let eoBotRunning      = false;
let eoTradeInProgress = false;
let eoHistory         = [];     // raw digit history (max 40)
let eoPrediction      = null;   // 'DIGITEVEN' | 'DIGITODD' | null
let eoWins = 0, eoLosses = 0, eoPnl = 0;
let eoActive          = true;
let eoCurrentStake    = CONFIG.EO.STAKE;         // martingale: tracks current stake

// Market halt system
const marketHalts     = {};     // symbol → { until, timerId }
let currentMarket     = CONFIG.MARKET;
let preHaltMarket     = null;

// Request-ID tracking
let nextReqId         = 1000;
const reqIdBotMap     = new Map();   // reqId → 'differs' | 'evenodd'
const contractBotMap  = new Map();   // contractId → 'differs' | 'evenodd'

// Auto-scan
let adsScanTimer      = null;
let scanLock          = false;
let qualifiedMarketReady = !CONFIG.ADS.ENABLED; // hold until first ADS scan passes

// ─────────────────────────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en', { hour12: false });
}

function log(msg, type = '') {
  const icons = { win: '✅', loss: '❌', trade: '💰', warn: '⚠️', info: 'ℹ️', scan: '🔍' };
  const icon  = icons[type] || '·';
  console.log(`[${ts()}] ${icon}  ${msg}`);
}

// ─────────────────────────────────────────────────────────────
//  HELPERS — digit / pattern analysis
// ─────────────────────────────────────────────────────────────
function getLastDigit(price) {
  const s = price.toFixed(2);
  return parseInt(s.slice(-1));
}

/** Last 3–4 prices must be strictly rising or strictly falling */
function hasConfirmedPattern() {
  if (priceHistory.length < 3) return false;
  const slice = priceHistory.slice(-4);
  let rising = true, falling = true;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i] <= slice[i - 1]) rising  = false;
    if (slice[i] >= slice[i - 1]) falling = false;
  }
  return rising || falling;
}

/** Pick an unseen digit (not in last 10) at random for auto mode */
function pickAutoDigit() {
  const last10 = digits.slice(-10);
  const seen   = new Set(last10);
  const unseen = [0,1,2,3,4,5,6,7,8,9].filter(d => !seen.has(d));
  if (unseen.length === 0) return null;
  return unseen[Math.floor(Math.random() * unseen.length)];
}

// ─────────────────────────────────────────────────────────────
//  EVEN/ODD STRATEGY — MKOREAN WWN
// ─────────────────────────────────────────────────────────────
const EVEN_DIGITS = [0,2,4,6,8];
const ODD_DIGITS  = [1,3,5,7,9];

function eoDigitFreq(hist) {
  const freq = {};
  for (let d = 0; d <= 9; d++) freq[d] = 0;
  for (const d of hist) freq[d]++;
  const total = hist.length;
  const pct   = {};
  for (let d = 0; d <= 9; d++) pct[d] = total > 0 ? (freq[d] / total) * 100 : 0;
  return { pct, total };
}

function eoCheckSide(sideDigits, pctMap, lastFive) {
  let greenDigit = null;
  for (const d of sideDigits) {
    if (pctMap[d] >= 12.5) { greenDigit = d; break; }
  }
  const greenOk   = greenDigit !== null;
  const above105  = sideDigits.filter(d => pctMap[d] > 10.5);
  const top3Ok    = above105.length >= 3;
  let redDigit    = null;
  for (const d of sideDigits) {
    if (pctMap[d] < 9.5) { redDigit = d; break; }
  }
  const redOk     = redDigit !== null;
  const recentHits = lastFive.filter(d => sideDigits.includes(d)).length;
  const cursorOk  = recentHits >= 3;
  return { greenOk, top3Ok, redOk, cursorOk, greenDigit, redDigit };
}

function computeEoPrediction() {
  if (eoHistory.length < 20) { eoPrediction = null; return; }
  const window20 = eoHistory.slice(-20);
  const last5    = eoHistory.slice(-5);
  const { pct }  = eoDigitFreq(window20);

  const evenRes = eoCheckSide(EVEN_DIGITS, pct, last5);
  const oddRes  = eoCheckSide(ODD_DIGITS,  pct, last5);

  const evenAllOk = evenRes.greenOk && evenRes.top3Ok && evenRes.redOk && evenRes.cursorOk;
  const oddAllOk  = oddRes.greenOk  && oddRes.top3Ok  && oddRes.redOk  && oddRes.cursorOk;

  if (evenAllOk && !oddAllOk) {
    eoPrediction = 'DIGITEVEN';
  } else if (oddAllOk && !evenAllOk) {
    eoPrediction = 'DIGITODD';
  } else if (evenAllOk && oddAllOk) {
    const evenCount = window20.filter(d => d % 2 === 0).length;
    const oddCount  = window20.length - evenCount;
    eoPrediction    = evenCount >= oddCount ? 'DIGITEVEN' : 'DIGITODD';
  } else {
    eoPrediction    = null;
  }
}

// ─────────────────────────────────────────────────────────────
//  MARKET HALT SYSTEM
// ─────────────────────────────────────────────────────────────
function isMarketHalted(symbol) {
  const h = marketHalts[symbol];
  return h && Date.now() < h.until;
}

function haltMarket(symbol) {
  if (marketHalts[symbol]) clearTimeout(marketHalts[symbol].timerId);
  const timerId = setTimeout(() => {
    delete marketHalts[symbol];
    log(`Market ${MARKET_NAMES[symbol] || symbol} halt lifted — cooldown complete`, 'win');
    maybeRestoreOriginalMarket(symbol);
  }, CONFIG.HALT_DURATION_MS);
  marketHalts[symbol] = { until: Date.now() + CONFIG.HALT_DURATION_MS, timerId };
  log(`⏸ Market ${MARKET_NAMES[symbol] || symbol} HALTED for 5 min after loss`, 'loss');
  if (symbol === currentMarket) switchToFallbackMarket(symbol);
}

function getNonHaltedMarkets(excludeSymbol) {
  return ALL_BOT_MARKETS.filter(s => s !== excludeSymbol && !isMarketHalted(s));
}

function switchToFallbackMarket(haltedSymbol) {
  const candidates = CONFIG.ADS.MARKETS.filter(s => s !== haltedSymbol && !isMarketHalted(s));
  const fallback = candidates.length > 0 ? candidates[0] : getNonHaltedMarkets(haltedSymbol)[0];
  if (!fallback) {
    log('⚠ All markets are halted — bot paused until a market becomes available', 'warn');
    return;
  }
  if (!preHaltMarket) preHaltMarket = haltedSymbol;
  switchMarket(fallback);
  log(`🔀 Switched to fallback: ${MARKET_NAMES[fallback] || fallback} during ${MARKET_NAMES[haltedSymbol] || haltedSymbol} halt`, 'trade');
}

function maybeRestoreOriginalMarket() {
  if (!preHaltMarket) return;
  if (isMarketHalted(preHaltMarket)) return;
  const original = preHaltMarket;
  preHaltMarket  = null;
  if (currentMarket !== original) {
    switchMarket(original);
    log(`↩ Restored original market: ${MARKET_NAMES[original] || original}`, 'win');
  }
}

function switchMarket(symbol) {
  currentMarket = symbol;
  digits        = [];
  priceHistory  = [];
  seenSet       = new Set();
  selectedDigit = null;
  if (ws && connected) {
    ws.send(JSON.stringify({ forget_all: 'ticks' }));
    subscribeToTicks(symbol);
  }
}

// ─────────────────────────────────────────────────────────────
//  RISK CONTROLS
// ─────────────────────────────────────────────────────────────
function checkRiskLimits() {
  if (pnl >= CONFIG.DIFFERS.TARGET_PROFIT) {
    differsActive = false;
    botRunning    = false;
    log(`🎯 Target profit $${CONFIG.DIFFERS.TARGET_PROFIT.toFixed(2)} reached — Differs bot stopped. P&L: +$${pnl.toFixed(2)}`, 'win');
  }
  if (pnl <= -Math.abs(CONFIG.DIFFERS.STOP_LOSS)) {
    differsActive = false;
    botRunning    = false;
    log(`🛑 Stop loss $${CONFIG.DIFFERS.STOP_LOSS.toFixed(2)} hit — Differs bot stopped. P&L: $${pnl.toFixed(2)}`, 'loss');
  }
}

function checkEoRiskLimits() {
  if (eoPnl >= CONFIG.EO.TARGET_PROFIT) {
    eoActive     = false;
    eoBotRunning = false;
    log(`[E/O] 🎯 Target profit $${CONFIG.EO.TARGET_PROFIT.toFixed(2)} reached — E/O bot stopped. P&L: +$${eoPnl.toFixed(2)}`, 'win');
  }
  if (eoPnl <= -Math.abs(CONFIG.EO.STOP_LOSS)) {
    eoActive     = false;
    eoBotRunning = false;
    log(`[E/O] 🛑 Stop loss $${CONFIG.EO.STOP_LOSS.toFixed(2)} hit — E/O bot stopped. P&L: $${eoPnl.toFixed(2)}`, 'loss');
  }
}

// ─────────────────────────────────────────────────────────────
//  MARTINGALE HELPERS
// ─────────────────────────────────────────────────────────────
function martingaleOnWin(currentStake, baseStake) {
  return baseStake;
}

function martingaleOnLoss(currentStake, multiplier, maxStake) {
  const next = currentStake * multiplier;
  return (maxStake > 0 && next > maxStake) ? maxStake : next;
}

// ─────────────────────────────────────────────────────────────
//  TRADE PLACEMENT
// ─────────────────────────────────────────────────────────────
function placeDiffersTrade() {
  if (!ws || !connected) return;
  tradeInProgress = true;
  const reqId = nextReqId++;
  reqIdBotMap.set(reqId, 'differs');
  log(`Placing Differs: digit ${selectedDigit} | $${differsCurrentStake.toFixed(2)} | ${CONFIG.DIFFERS.DURATION} tick(s)`, 'trade');
  ws.send(JSON.stringify({
    req_id: reqId,
    buy: 1,
    price: differsCurrentStake,
    parameters: {
      amount:        differsCurrentStake,
      basis:         'stake',
      contract_type: 'DIGITDIFF',
      currency:      'USD',
      duration:      CONFIG.DIFFERS.DURATION,
      duration_unit: 't',
      symbol:        currentMarket,
      barrier:       String(selectedDigit),
    },
  }));
}

function placeEoTrade() {
  if (!ws || !connected) return;
  eoTradeInProgress = true;
  const reqId = nextReqId++;
  reqIdBotMap.set(reqId, 'evenodd');
  const label = eoPrediction === 'DIGITEVEN' ? 'Even' : 'Odd';
  log(`[E/O] Placing ${label}: $${eoCurrentStake.toFixed(2)} | ${CONFIG.EO.DURATION} tick(s)`, 'trade');
  ws.send(JSON.stringify({
    req_id: reqId,
    buy: 1,
    price: eoCurrentStake,
    parameters: {
      amount:        eoCurrentStake,
      basis:         'stake',
      contract_type: eoPrediction,
      currency:      'USD',
      duration:      CONFIG.EO.DURATION,
      duration_unit: 't',
      symbol:        currentMarket,
    },
  }));
}

// ─────────────────────────────────────────────────────────────
//  TICK PROCESSING  (runs every tick)
// ─────────────────────────────────────────────────────────────
function processTick(quote) {
  priceHistory.push(quote);
  if (priceHistory.length > 10) priceHistory.shift();

  const lastD = getLastDigit(quote);
  digits.push(lastD);
  if (digits.length > 20) digits.shift();

  eoHistory.push(lastD);
  if (eoHistory.length > 40) eoHistory.shift();

  seenSet = new Set(digits.slice(-10));

  // Update auto-selected digit on every tick
  if (CONFIG.DIFFERS.MODE === 'auto') {
    selectedDigit = pickAutoDigit();
  } else {
    selectedDigit = CONFIG.DIFFERS.MANUAL_DIGIT;
  }

  // Compute E/O prediction
  computeEoPrediction();

  // ── Even/Odd Bot ───────────────────────────────────────────
  if (
    CONFIG.EO.ENABLED && eoActive && eoBotRunning &&
    !eoTradeInProgress && eoHistory.length >= 20 && eoPrediction &&
    !isMarketHalted(currentMarket) && !scanLock && qualifiedMarketReady &&
    hasConfirmedPattern()
  ) {
    placeEoTrade();
  }

  // ── Digit Differs Bot ──────────────────────────────────────
  if (
    CONFIG.DIFFERS.ENABLED && differsActive && botRunning &&
    !tradeInProgress && digits.length >= 10 && selectedDigit !== null &&
    !seenSet.has(selectedDigit) && !isMarketHalted(currentMarket) &&
    !scanLock && qualifiedMarketReady && hasConfirmedPattern()
  ) {
    placeDiffersTrade();
  }
}

// ─────────────────────────────────────────────────────────────
//  AUTO DIGIT SELECTOR  (ADS)
// ─────────────────────────────────────────────────────────────
function fetchTickFrequency(symbol, count) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.APP_ID}`);
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error(`Timeout: ${symbol}`)); }, 30000);

    socket.on('open', () => {
      socket.send(JSON.stringify({ ticks_history: symbol, count, end: 'latest', style: 'ticks' }));
    });

    socket.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.error) { clearTimeout(timeout); socket.terminate(); reject(new Error(msg.error.message)); return; }
      if (msg.msg_type === 'history') {
        clearTimeout(timeout);
        socket.terminate();
        const prices = msg.history.prices || [];
        const freq = { 0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0 };
        for (const p of prices) freq[getLastDigit(p)]++;
        const total  = prices.length;
        const pctMap = {};
        for (let d = 0; d <= 9; d++) pctMap[d] = total > 0 ? (freq[d] / total) * 100 : 10;
        resolve({ symbol, pctMap, total });
      }
    });

    socket.on('error', () => { clearTimeout(timeout); reject(new Error(`WS error: ${symbol}`)); });
  });
}

async function runAdsScan() {
  scanLock = true;
  log('🔍 ADS scan started — trading paused during scan', 'scan');

  const markets   = CONFIG.ADS.MARKETS;
  const tickCount = CONFIG.ADS.TICK_SAMPLE;
  const threshold = CONFIG.ADS.THRESHOLD;
  const results   = [];

  for (const sym of markets) {
    log(`  Scanning ${MARKET_NAMES[sym] || sym}…`, 'scan');
    try {
      const data     = await fetchTickFrequency(sym, tickCount);
      const coldCount = Object.values(data.pctMap).filter(p => p < threshold).length;
      log(`  ${MARKET_NAMES[sym]}: ${data.total} ticks | ${coldCount} cold digit(s)`, 'scan');
      results.push(data);
    } catch (err) {
      log(`  ${MARKET_NAMES[sym] || sym}: error — ${err.message}`, 'loss');
    }
  }

  scanLock = false;

  if (results.length === 0) {
    log('ADS scan: all fetches failed — trading held until next scan', 'loss');
    qualifiedMarketReady = false;
    return;
  }

  // Priority: prefer current market; if no cold digit, pick globally coldest
  let bestChoice = null;

  const currentResult = results.find(r => r.symbol === currentMarket);
  if (currentResult) {
    const cold = Object.entries(currentResult.pctMap)
      .filter(([, p]) => p < threshold)
      .sort((a, b) => a[1] - b[1]);
    if (cold.length > 0) bestChoice = { market: currentMarket, digit: parseInt(cold[0][0]), pct: cold[0][1] };
  }

  if (!bestChoice) {
    let globalBest = null;
    for (const r of results) {
      const cold = Object.entries(r.pctMap)
        .filter(([, p]) => p < threshold)
        .sort((a, b) => a[1] - b[1]);
      if (cold.length > 0) {
        const candidate = { market: r.symbol, digit: parseInt(cold[0][0]), pct: cold[0][1] };
        if (!globalBest || candidate.pct < globalBest.pct) globalBest = candidate;
      }
    }
    if (globalBest) bestChoice = globalBest;
  }

  if (bestChoice) {
    // Apply: update market and manual digit target
    if (bestChoice.market !== currentMarket) {
      switchMarket(bestChoice.market);
      log(`ADS: switched to ${MARKET_NAMES[bestChoice.market] || bestChoice.market}`, 'scan');
    }
    CONFIG.DIFFERS.MODE          = 'manual';
    CONFIG.DIFFERS.MANUAL_DIGIT  = bestChoice.digit;
    selectedDigit                = bestChoice.digit;
    qualifiedMarketReady         = true;
    log(`ADS: applied → Digit ${bestChoice.digit} on ${MARKET_NAMES[bestChoice.market] || bestChoice.market} (${bestChoice.pct.toFixed(2)}%) — trading resumed`, 'win');
  } else {
    qualifiedMarketReady = false;
    log(`ADS: no cold digit found (all above ${threshold}%) — trading held until next scan`, 'warn');
  }
}

function startAutoScan() {
  if (!CONFIG.ADS.ENABLED || CONFIG.ADS.SCAN_INTERVAL <= 0) return;

  // Run immediately, then on interval
  runAdsScan();

  if (CONFIG.ADS.SCAN_INTERVAL > 0) {
    adsScanTimer = setInterval(() => {
      runAdsScan();
    }, CONFIG.ADS.SCAN_INTERVAL * 1000);
    log(`ADS auto-scan enabled — re-scanning every ${CONFIG.ADS.SCAN_INTERVAL}s`, 'scan');
  }
}

// ─────────────────────────────────────────────────────────────
//  WEBSOCKET — MAIN CONNECTION
// ─────────────────────────────────────────────────────────────
function subscribeToTicks(market) {
  if (!ws || !connected) return;
  ws.send(JSON.stringify({ ticks: market, subscribe: 1 }));
  log(`Subscribed to ${MARKET_NAMES[market] || market} tick stream`);
}

function connectWS() {
  log('Connecting to Deriv WebSocket API…');
  ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.APP_ID}`);

  ws.on('open', () => {
    connected      = true;
    reconnectDelay = 2000;
    log('WebSocket connected');
    ws.send(JSON.stringify({ authorize: CONFIG.API_TOKEN }));
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Authorization ──────────────────────────────────────
    if (msg.msg_type === 'authorize') {
      if (msg.error) { log('Auth error: ' + msg.error.message, 'loss'); return; }
      const acc = msg.authorize;
      log(`Authorized: ${acc.loginid} | Currency: ${acc.currency} | Balance: ${acc.currency} ${parseFloat(acc.balance).toFixed(2)}`);
      ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      subscribeToTicks(currentMarket);

      // Start bots
      botRunning    = CONFIG.DIFFERS.ENABLED && differsActive;
      eoBotRunning  = CONFIG.EO.ENABLED && eoActive;
      if (botRunning)   log('Differs Bot started — scanning last 10 digits each tick');
      if (eoBotRunning) log('E/O Bot started — MKOREAN WWN engine active');

      // Start ADS
      if (CONFIG.ADS.ENABLED) startAutoScan();
    }

    // ── Balance updates ────────────────────────────────────
    if (msg.msg_type === 'balance' && msg.balance) {
      log(`Balance: ${msg.balance.currency} ${parseFloat(msg.balance.balance).toFixed(2)}`);
    }

    // ── Live tick ─────────────────────────────────────────
    if (msg.msg_type === 'tick') {
      processTick(msg.tick.quote);
    }

    // ── Buy response ──────────────────────────────────────
    if (msg.msg_type === 'buy') {
      const reqId    = msg.req_id;
      const botOwner = reqIdBotMap.get(reqId) || 'differs';
      reqIdBotMap.delete(reqId);

      if (msg.error) {
        log(`Buy error: ${msg.error.message}`, 'loss');
        if (botOwner === 'evenodd') eoTradeInProgress = false;
        else tradeInProgress = false;
        return;
      }

      const contractId = msg.buy.contract_id;
      contractBotMap.set(contractId, botOwner);
      log(`Contract placed | ID: ${contractId}`, 'trade');
      ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }));
    }

    // ── Contract result ───────────────────────────────────
    if (msg.msg_type === 'proposal_open_contract') {
      const poc = msg.proposal_open_contract;
      if (!poc || !(poc.is_sold || poc.status === 'sold')) return;

      const botOwner = contractBotMap.get(poc.contract_id) || 'differs';
      contractBotMap.delete(poc.contract_id);
      const profit   = parseFloat(poc.profit || 0);

      if (botOwner === 'evenodd') {
        eoTradeInProgress = false;
        eoPnl += profit;
        if (profit >= 0) {
          eoWins++;
          log(`[E/O] WIN — +$${profit.toFixed(2)} | ID ${poc.contract_id}`, 'win');
          if (CONFIG.EO.MARTINGALE) {
            eoCurrentStake = martingaleOnWin(eoCurrentStake, CONFIG.EO.STAKE);
            log(`[E/O] Martingale: stake reset to $${eoCurrentStake.toFixed(2)}`);
          }
        } else {
          eoLosses++;
          log(`[E/O] LOSS — $${profit.toFixed(2)} | ID ${poc.contract_id}`, 'loss');
          if (CONFIG.EO.MARTINGALE) {
            eoCurrentStake = martingaleOnLoss(eoCurrentStake, CONFIG.EO.MARTINGALE_MULT, CONFIG.EO.MARTINGALE_MAX);
            log(`[E/O] Martingale: stake increased to $${eoCurrentStake.toFixed(2)}`);
          }
          haltMarket(currentMarket);
        }
        log(`[E/O] Stats — Wins: ${eoWins} | Losses: ${eoLosses} | P&L: $${eoPnl.toFixed(2)}`);
        checkEoRiskLimits();
      } else {
        tradeInProgress = false;
        pnl += profit;
        if (profit >= 0) {
          wins++;
          log(`WIN — +$${profit.toFixed(2)} | Contract ${poc.contract_id}`, 'win');
          if (CONFIG.DIFFERS.MARTINGALE) {
            differsCurrentStake = martingaleOnWin(differsCurrentStake, CONFIG.DIFFERS.STAKE);
            log(`Martingale: stake reset to $${differsCurrentStake.toFixed(2)}`);
          }
        } else {
          losses++;
          log(`LOSS — $${profit.toFixed(2)} | Contract ${poc.contract_id}`, 'loss');
          if (CONFIG.DIFFERS.MARTINGALE) {
            differsCurrentStake = martingaleOnLoss(differsCurrentStake, CONFIG.DIFFERS.MARTINGALE_MULT, CONFIG.DIFFERS.MARTINGALE_MAX);
            log(`Martingale: stake increased to $${differsCurrentStake.toFixed(2)}`);
          }
          haltMarket(currentMarket);
        }
        log(`Differs Stats — Wins: ${wins} | Losses: ${losses} | P&L: $${pnl.toFixed(2)}`);
        checkRiskLimits();
      }
    }
  });

  ws.on('error', err => {
    log(`WebSocket error: ${err.message}`, 'loss');
  });

  ws.on('close', () => {
    connected = false;
    botRunning = false;
    eoBotRunning = false;
    log(`WebSocket disconnected — reconnecting in ${reconnectDelay / 1000}s…`, 'warn');
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 60000); // max 60s
      connectWS();
    }, reconnectDelay);
  });
}

// ─────────────────────────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────────────────────────
if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
  console.error('\n❌  Please set your Deriv API token in CONFIG.API_TOKEN before running.\n');
  process.exit(1);
}

log('='.repeat(55));
log('  Deriv Differs Bot — Node.js Edition');
log('='.repeat(55));
log(`Market:        ${MARKET_NAMES[CONFIG.MARKET] || CONFIG.MARKET}`);
log(`Differs Bot:   ${CONFIG.DIFFERS.ENABLED ? `Enabled | Stake $${CONFIG.DIFFERS.STAKE} | Mode: ${CONFIG.DIFFERS.MODE}` : 'Disabled'}`);
log(`  Martingale:  ${CONFIG.DIFFERS.MARTINGALE ? `Enabled | x${CONFIG.DIFFERS.MARTINGALE_MULT} on loss | Max: ${CONFIG.DIFFERS.MARTINGALE_MAX > 0 ? '$'+CONFIG.DIFFERS.MARTINGALE_MAX : 'none'}` : 'Disabled'}`);
log(`E/O Bot:       ${CONFIG.EO.ENABLED      ? `Enabled | Stake $${CONFIG.EO.STAKE}`                                      : 'Disabled'}`);
log(`  Martingale:  ${CONFIG.EO.MARTINGALE   ? `Enabled | x${CONFIG.EO.MARTINGALE_MULT} on loss | Max: ${CONFIG.EO.MARTINGALE_MAX > 0 ? '$'+CONFIG.EO.MARTINGALE_MAX : 'none'}` : 'Disabled'}`);
log(`Auto Digit:    ${CONFIG.ADS.ENABLED     ? `Enabled | Threshold ${CONFIG.ADS.THRESHOLD}% | Scan every ${CONFIG.ADS.SCAN_INTERVAL}s` : 'Disabled'}`);
log('='.repeat(55));

connectWS();

// Graceful shutdown
process.on('SIGINT', () => {
  log('\nShutting down…');
  if (adsScanTimer) clearInterval(adsScanTimer);
  if (ws) ws.terminate();
  process.exit(0);
});
